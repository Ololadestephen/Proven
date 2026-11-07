import test from "node:test";
import assert from "node:assert/strict";
import { appRoute, ownBids, completed } from "../ui/app-route.ts";
import { parseNearAmount } from "../ui/near-amount.ts";
import {
  ActionGate,
  actionSnapshot,
  reconciled,
  journalCall,
  definitelyNotApplied,
  DefinitiveWalletFailure,
  type PendingAction,
} from "../ui/action-guard.ts";
import { adaptWallet, connectorOptions } from "../ui/wallet-adapter.ts";
import type { NearWalletBase } from "@hot-labs/near-connect";
import type { Market, Call } from "../ui/market-types.ts";
import type { MarketBid } from "../ui/market-steps.ts";
const bid = {
  id: 1,
  buyer: "buyer.testnet",
  state: "Claimed",
  check_hash: "check",
  reference_hash: "ref",
  description: "A real job",
  claim: null,
  job_id: 7,
  job: null,
  last_job: null,
} as unknown as MarketBid;
const market = {
  agents: [],
  bids: [bid],
  board: "board.testnet",
  escrow: "escrow.testnet",
  verifier_hash: "hash",
  paused: false,
} as Market;
const call: Call = {
  receiver: market.escrow,
  method: "claim",
  args: { worker: "worker.testnet" },
  deposit: 20000000000000000000000n,
  gas: 70000000000000n,
};
function pending(
  method = "claim",
  args: Record<string, unknown> = {},
): PendingAction {
  return journalCall(
    {
      account: bid.buyer,
      bidId: 1,
      before: actionSnapshot(market, bid.buyer, 1),
      label: "Create job",
      createdAt: 0,
    },
    { ...call, method, args },
  );
}
test("routes separate overview, browse, role views, post and bid IDs", () => {
  assert.equal(appRoute("/app").section, "workspace");
  assert.equal(appRoute("/app/market").section, "market");
  assert.equal(appRoute("/app/post").section, "post");
  assert.equal(appRoute("/app", "#post-job").section, "post");
  assert.equal(appRoute("/app/bids/12").bidId, 12);
  assert.equal(ownBids([bid], null, "buying").length, 0);
  assert.equal(ownBids([bid], bid.buyer, "buying").length, 1);
  assert.equal(ownBids([bid], "stranger.testnet", "buying").length, 0);
  const claimed = { ...bid, claim: { number: 1, agent: "worker.testnet" } };
  assert.equal(ownBids([claimed], "worker.testnet", "delivering").length, 1);
  assert.equal(completed({ ...bid, state: "Done" }), true);
});
test("NEAR amounts preserve yocto precision and reject rounded or malformed payments", () => {
  const max = 5n * 10n ** 24n; // The escrow's limit, read from the chain.
  assert.equal(parseNearAmount("0.000000000000000000000001", max), 1n);
  assert.equal(parseNearAmount("0.1", max), 10n ** 23n);
  assert.equal(parseNearAmount("5", max), max);
  assert.throws(
    () => parseNearAmount("5.000000000000000000000001", max),
    /at most 5 NEAR/,
  );
  for (const value of [
    "0",
    "-0.1",
    "1e-2",
    "NaN",
    "0.0000000000000000000000001",
    "0.01 ",
  ])
    assert.throws(() => parseNearAmount(value, max));
});
test("synchronous gate blocks double clicks, unknown outcomes remain pending, unrelated updates do not unlock Create", () => {
  const gate = new ActionGate();
  assert.equal(gate.enter(), true);
  assert.equal(gate.enter(), false);
  gate.leave();
  assert.equal(gate.enter(), true);
  assert.equal(reconciled(pending(), market), false);
  assert.equal(
    reconciled(pending(), { ...market, agents: [bid.buyer] }),
    false,
  );
  assert.equal(
    reconciled(pending(), { ...market, bids: [{ ...bid, claims_made: 4 }] }),
    false,
  );
  assert.equal(
    reconciled(pending(), {
      ...market,
      bids: [{ ...bid, claim: { number: 1, agent: bid.buyer } }],
    }),
    true,
  );
  assert.equal(definitelyNotApplied(new Error("network timeout")), false);
  assert.equal(definitelyNotApplied(new Error("User rejected")), false);
  assert.equal(
    definitelyNotApplied(new DefinitiveWalletFailure("failed")),
    true,
  );
});
test("post reconciliation needs a new matching bid from the buyer", () => {
  const before = actionSnapshot(market, bid.buyer);
  const marker = {
    ...pending("post_bid", {
      check_hash: bid.check_hash,
      reference_hash: bid.reference_hash,
      description: bid.description,
    }),
    bidId: undefined,
    before,
  };
  assert.equal(
    reconciled(marker, {
      ...market,
      bids: [bid, { ...bid, id: 2, buyer: "other.testnet" }],
    }),
    false,
  );
  assert.equal(
    reconciled(marker, { ...market, bids: [bid, { ...bid, id: 2 }] }),
    true,
  );
});
test("wallet adapter is testnet/account-bound, preserves call values and rejects foreign signatures and failed receipts", async () => {
  const requests: unknown[] = [];
  let status: unknown = { SuccessValue: "" };
  let signer = "buyer.testnet";
  let accounts = [{ accountId: signer }];
  const chosen = {
    manifest: {
      name: "Test wallet",
      features: { testnet: true, signMessage: true },
    },
    getAccounts: async () => accounts,
    signAndSendTransaction: async (request: unknown) => {
      requests.push(request);
      return { status };
    },
    signMessage: async (request: unknown) => {
      requests.push(request);
      return {
        accountId: signer,
        publicKey: "ed25519:key",
        signature: "signature",
      };
    },
  } as unknown as NearWalletBase;
  const options = connectorOptions("nonce");
  assert.equal(options.network, "testnet");
  assert.equal(options.autoConnect, false);
  assert.equal(options.signIn, undefined);
  assert.equal(options.features?.signMessage, true);
  const wallet = adaptWallet(chosen, "buyer.testnet", async () => {});
  await wallet.call(call);
  assert.deepEqual(requests[0], {
    network: "testnet",
    signerId: "buyer.testnet",
    receiverId: call.receiver,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: call.method,
          args: call.args,
          gas: call.gas.toString(),
          deposit: call.deposit.toString(),
        },
      },
    ],
  });
  await wallet.signForRelay("action");
  assert.equal(
    (requests[1] as { recipient: string }).recipient,
    "proven-relay",
  );
  signer = "stranger.testnet";
  await assert.rejects(wallet.signForRelay("action"), /different/);
  status = { Failure: { error: "contract" } };
  await assert.rejects(wallet.call(call), /reported failure/);
  status = undefined;
  await assert.rejects(wallet.call(call), /did not confirm/);
  accounts = [];
  const count = requests.length;
  await assert.rejects(wallet.call(call), /account changed/);
  assert.equal(requests.length, count);
});

test("a fast failed OutLayer callback back to the original state is retriable after its attempt advances", () => {
  for (const [method, state] of [["request_verification", "Delivered"]]) {
    const current = {
      ...market,
      bids: [
        {
          ...bid,
          job: { state, attempt: 1 } as MarketBid["job"],
        },
      ],
    };
    const marker = {
      ...pending(method),
      before: actionSnapshot(current, bid.buyer, 1),
    };
    assert.equal(reconciled(marker, current), false);
    assert.equal(
      reconciled(marker, {
        ...current,
        bids: [
          {
            ...current.bids[0]!,
            job: { state, attempt: 2 } as MarketBid["job"],
          },
        ],
      }),
      true,
    );
  }
});

test("malformed saved snapshots fail closed", () => {
  assert.equal(reconciled({ ...pending(), before: "invalid" }, market), false);
  assert.equal(reconciled({ ...pending(), before: "null" }, market), false);
});

test("a cancelled action clears only if the chain shows it did not happen", async () => {
  const { releaseUnapplied } = await import("../ui/pending-actions.ts");
  const market = {
    agents: [],
    bids: [{ id: 0, claim: null, job: null }],
  } as unknown as Parameters<typeof releaseUnapplied>[2];
  const saved = {
    account: "w.near",
    bidId: 0,
    before: JSON.stringify({
      registered: true,
      value: { id: 0, claim: null, job: null },
    }),
    label: "Apply",
    createdAt: 0,
    call: { receiver: "b.near", method: "claim", args: { bid_id: 0 } },
  };
  const store = new Map([
    ["proven-testnet-pending-action-v1", JSON.stringify(saved)],
  ]);
  const seen: unknown[] = [];
  const env = {
    locks: {
      request: async (_: string, __: unknown, run: (lock: object) => unknown) =>
        run({}),
    } as unknown as LockManager,
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    onPending: (value: unknown) => void seen.push(value),
  };
  // It landed: nothing is cleared by this route, so reconciliation records it instead.
  const landed = {
    ...market,
    bids: [{ id: 0, claim: { agent: "w.near", number: 1 }, job: null }],
  } as typeof market;
  assert.equal(await releaseUnapplied(env, saved, landed), false);
  assert.equal(store.size, 1);
  // Nothing happened: the page is free again.
  assert.equal(await releaseUnapplied(env, saved, market), true);
  assert.equal(store.size, 0);
  assert.deepEqual(seen, [null]);
});
