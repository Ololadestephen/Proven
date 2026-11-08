import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePostedBid,
  postingReceipt,
  startPostingFollowup,
} from "../ui/posting.ts";
import { adaptWallet } from "../ui/wallet-adapter.ts";
import { postingOutcome } from "./market.ts";
import { FallbackRpcProvider } from "../../relay/src/rpc.ts";
import type { MarketBid } from "../ui/market-steps.ts";
import type { NearWalletBase } from "@hot-labs/near-connect";
const board = "board-v4.proven.testnet",
  buyer = "buyer.testnet",
  hash = "A".repeat(44);
const expected = {
  buyer,
  check_hash: "a".repeat(64),
  reference_hash: "b".repeat(64),
  verifier_hash: "c".repeat(64),
};
const bid = (id = 0, over: Partial<MarketBid> = {}) =>
  ({ id, ...expected, job_id: 7, ...over }) as MarketBid;
function outcome(id = 0) {
  return {
    transaction: {
      hash,
      receiver_id: board,
      signer_id: buyer,
      actions: [{ FunctionCall: { method_name: "post_bid" } }],
    },
    status: { SuccessValue: btoa("true") },
    receipts_outcome: [
      {
        outcome: {
          executor_id: board,
          status: { SuccessReceiptId: "receipt" },
          logs: [
            "EVENT_JSON:" +
              JSON.stringify({
                standard: "proven-board",
                version: "1.0.0",
                event: "bid_posted",
                data: [{ buyer, bid_id: id }],
              }),
          ],
        },
      },
    ],
  };
}
test("wallet event ID takes priority without a chain lookup", async () => {
  let reads = 0;
  const created = bid();
  const found = await resolvePostedBid({
    bids: [created],
    receipt: postingReceipt(outcome(), board, buyer),
    expected,
    board,
    readOutcome: async () => {
      reads++;
      throw Error("must not read");
    },
  });
  assert.equal(found, created);
  assert.equal(reads, 0);
});
test("hash-only and receipt-less wallets recover from a final chain outcome", async () => {
  for (const raw of [
    hash,
    { transaction: { hash } },
    { transaction: { hash }, status: { SuccessValue: btoa("true") } },
  ]) {
    let reads = 0;
    const found = await resolvePostedBid({
      bids: [bid(150)],
      receipt: postingReceipt(raw, board, buyer),
      expected,
      board,
      readOutcome: async (tx, account) => {
        assert.equal(tx, hash);
        assert.equal(account, buyer);
        reads++;
        return outcome(150);
      },
    });
    assert.equal(found?.id, 150);
    assert.equal(reads, 1);
  }
});
test("no outcome or malformed outcomes fall back only to one signer-bound complete commitment", async () => {
  for (const raw of [
    undefined,
    null,
    {},
    17,
    { status: null },
    { transaction: { hash }, receipts_outcome: "bad" },
  ]) {
    const found = await resolvePostedBid({
      bids: [
        bid(4, { buyer: "stranger.testnet" }),
        bid(5, { reference_hash: "wrong" }),
        bid(6, { verifier_hash: "wrong" }),
        bid(7),
      ],
      receipt: postingReceipt(raw, board, buyer),
      expected,
      board,
      readOutcome: async () => {
        throw Error("RPC unavailable");
      },
    });
    assert.equal(found?.id, 7);
  }
});
test("a malformed or unrelated RPC outcome cannot substitute an unrelated bid", async () => {
  for (const raw of [
    null,
    {},
    outcome(3),
    {
      ...outcome(),
      transaction: { ...outcome().transaction, hash: "B".repeat(44) },
    },
  ]) {
    const found = await resolvePostedBid({
      bids: [
        bid(3, { buyer: "stranger.testnet" }),
        bid(4, { check_hash: "wrong" }),
      ],
      receipt: { transaction_hash: hash },
      expected,
      board,
      readOutcome: async () => raw,
    });
    assert.equal(found, null);
  }
  assert.equal(
    await resolvePostedBid({
      bids: [bid(0), bid(1)],
      receipt: undefined,
      expected,
      board,
      readOutcome: async () => null,
    }),
    null,
    "ambiguous board snapshots fail closed",
  );
});
test("all recovery paths start each automatic follow-up once despite overlapping reads", async () => {
  for (const receipt of [
    postingReceipt(outcome(), board, buyer),
    { transaction_hash: hash },
    undefined,
  ]) {
    const started = { current: false };
    let checks = 0,
      reviews = 0;
    const options = {
      bids: [bid()],
      receipt,
      expected,
      board,
      readOutcome: async () => outcome(),
    };
    const matches = await Promise.all([
      resolvePostedBid(options),
      resolvePostedBid(options),
    ]);
    const actions = matches.map((found) =>
      startPostingFollowup(
        started,
        found,
        async (id) => {
          assert.equal(id, 7);
          checks++;
        },
        async (id) => {
          assert.equal(id, 0);
          reviews++;
        },
      ),
    );
    await Promise.all(
      actions.flatMap((action) =>
        action ? [action.check, action.review] : [],
      ),
    );
    assert.equal(checks, 1);
    assert.equal(reviews, 1);
  }
});
test("follow-up waits for job creation and does not automatically repeat failed requests", async () => {
  const started = { current: false };
  let checks = 0,
    reviews = 0;
  const send = async () => {
    checks++;
    throw Error("handoff failed");
  };
  const review = async () => {
    reviews++;
  };
  assert.equal(
    startPostingFollowup(started, bid(0, { job_id: null }), send, review),
    null,
  );
  const action = startPostingFollowup(started, bid(), send, review)!;
  await assert.rejects(action.check, /handoff failed/);
  await action.review;
  assert.equal(startPostingFollowup(started, bid(), send, review), null);
  assert.equal(checks, 1);
  assert.equal(reviews, 1);
});
test("the real wallet adapter permits post recovery for partial results but preserves definitive failures", async () => {
  let result: unknown;
  const chosen = {
    manifest: {
      name: "Fixture",
      features: { testnet: true, signMessage: true },
    },
    getAccounts: async () => [{ accountId: buyer }],
    signAndSendTransaction: async () => result,
  } as unknown as NearWalletBase;
  const wallet = adaptWallet(chosen, buyer, async () => {});
  const call = {
    receiver: board,
    method: "post_bid",
    args: {},
    deposit: 1n,
    gas: 1n,
  };
  for (const raw of [
    undefined,
    hash,
    { transaction: { hash } },
    { status: null },
  ]) {
    result = raw;
    assert.deepEqual(
      await wallet.call(call),
      postingReceipt(raw, board, buyer),
    );
  }
  result = { status: { Failure: {} } };
  await assert.rejects(wallet.call(call), /reported failure/);
  result = undefined;
  await assert.rejects(
    wallet.call({ ...call, method: "claim" }),
    /did not confirm/,
  );
});
test("posting lookup is read-only FINAL RPC and validates before calling the provider", async (t) => {
  let reads = 0;
  t.mock.method(
    FallbackRpcProvider.prototype,
    "viewTransactionStatus",
    async (args: unknown) => {
      assert.deepEqual(args, {
        txHash: hash,
        accountId: buyer,
        waitUntil: "FINAL",
      });
      reads++;
      return outcome();
    },
  );
  assert.deepEqual(await postingOutcome({ hash, buyer }), outcome());
  assert.equal(reads, 1);
  for (const body of [
    { hash, buyer: "invalid account" },
    { hash: "bad", buyer },
    { buyer },
  ])
    await assert.rejects(
      postingOutcome(body),
      /valid buyer and transaction hash/,
    );
  assert.equal(reads, 1);
  t.mock.method(
    FallbackRpcProvider.prototype,
    "viewTransactionStatus",
    async () => {
      throw Error("private upstream");
    },
  );
  await assert.rejects(
    postingOutcome({ hash, buyer }),
    (error: unknown) =>
      error instanceof Error &&
      /not available/.test(error.message) &&
      !error.message.includes("private"),
  );
});

test("posting receipt metadata on the real component props does not become a fifth chain commitment", async () => {
  const receipt = { transaction_hash: hash, posted_bid_id: 0 };
  const posted = { ...expected, receipt };
  const found = await resolvePostedBid({
    bids: [bid()],
    receipt: posted.receipt,
    expected: posted,
    board,
    readOutcome: async () => {
      throw Error("must not read");
    },
  });
  assert.equal(found?.id, 0);
  const fallback = await resolvePostedBid({
    bids: [bid()],
    receipt: undefined,
    expected: posted,
    board,
    readOutcome: async () => null,
  });
  assert.equal(fallback?.id, 0);
});
