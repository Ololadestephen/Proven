import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  boardTools,
  executeBoardTool,
  isBoardTool,
  nearText,
} from "./board-tools.ts";
import type { Config } from "./config.ts";
import { BOARD } from "./custody.ts";
import { BoardClient } from "./board.ts";

const config = {
  actor: "buyer",
  escrow: "escrow.testnet",
  rpc: "https://test.rpc.fastnear.com",
  custodyApi: "https://testnet-api.outlayer.ai",
} as Config;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("board tools have schemas and are recognised", () => {
  assert.ok(boardTools.length >= 10);
  assert.ok(boardTools.every((tool) => isBoardTool(tool.name)));
  assert.equal(isBoardTool("post_job"), false);
});

test("a dry post_bid fixes the hashes and the verifier named in the check", async (t) => {
  t.mock.method(BoardClient.prototype, "now", async () => 1_000_000_000_000n);
  const check = JSON.stringify({ verifier: "a".repeat(64), format: "{}" });
  const result = (await executeBoardTool(
    "post_bid",
    {
      description: "Do it",
      check,
      reference: "r",
      amount_near: "0.01",
      reveal_agreed: true,
    },
    config,
    true,
  )) as { call: { receiver_id: string; args: Record<string, unknown> } };
  assert.equal(result.call.receiver_id, BOARD);
  assert.equal(result.call.args.check_hash, sha(check));
  assert.equal(result.call.args.reference_hash, sha("r"));
  assert.equal(result.call.args.verifier_hash, "a".repeat(64));
  assert.equal(result.call.args.deliver_secs, 4 * 3_600);
  assert.equal(result.call.args.max_attempts, 3);
});

test("a description over the board's limit, unknown fields and a keyless write are refused", async () => {
  const check = JSON.stringify({ verifier: "a".repeat(64), format: "{}" });
  await assert.rejects(
    executeBoardTool(
      "post_bid",
      {
        description: "x".repeat(2049),
        check,
        reference: "r",
        amount_near: "0.01",
        reveal_agreed: true,
      },
      config,
      true,
    ),
  );
  await assert.rejects(
    executeBoardTool(
      "claim_bid",
      { bid_id: 0, payee: "x.testnet" },
      config,
      true,
    ),
    /Unknown field/,
  );
  await assert.rejects(
    executeBoardTool("claim_bid", { bid_id: 0 }, config),
    /custody wallet/,
  );
});

test("amounts convert exactly for the job tool", () => {
  assert.equal(nearText("10000000000000000000000"), "0.01");
  assert.equal(nearText("100000000000000000000000"), "0.1");
  assert.equal(nearText("1000000000000000000000000"), "1");
  assert.equal(
    nearText("1500000000000000000000001"),
    "1.500000000000000000000001",
  );
});

test("a mainnet dry post plans the exact 5 NEAR amount without a wallet or write", async (t) => {
  t.mock.method(BoardClient.prototype, "now", async () => 1_000_000_000_000n);
  t.mock.method(BoardClient.prototype, "postBid", async () => {
    throw new Error("Dry-run must not write");
  });
  const check = JSON.stringify({ verifier: "a".repeat(64), format: "{}" });
  const result = (await executeBoardTool(
    "post_bid",
    {
      description: "A mainnet dry plan",
      check,
      reference: "r",
      amount_near: "5",
      reveal_agreed: true,
    },
    {
      ...config,
      escrow: "proven-escrow.near",
      rpc: "https://rpc.mainnet.near.org",
      custodyApi: "https://api.outlayer.ai",
    },
    true,
  )) as {
    dry_run: boolean;
    call: { method_name: string; args: Record<string, unknown> };
  };
  assert.equal(result.dry_run, true);
  assert.equal(result.call.method_name, "post_bid");
  assert.equal(result.call.args.amount, "5000000000000000000000000");
  assert.equal(result.call.args.check_hash, sha(check));
  assert.equal(result.call.args.reference_hash, sha("r"));
});

test("live posting checks native chain caps before any custody write", async (t) => {
  t.mock.method(BoardClient.prototype, "now", async () => 1_000_000_000_000n);
  let writes = 0;
  const valid = {
    run_deposit: "100000000000000000000000",
    caps: [
      {
        token: null,
        max_job: "5000000000000000000000000",
        max_held: "10000000000000000000000000",
        max_held_per_buyer: "5000000000000000000000000",
      },
    ],
  };
  let chain: unknown = valid;
  t.mock.method(
    BoardClient.prototype,
    "view",
    async (
      method: string,
      _args: Record<string, unknown>,
      account?: string,
    ) => {
      assert.equal(method, "get_config");
      assert.equal(account, config.escrow);
      return chain;
    },
  );
  t.mock.method(BoardClient.prototype, "postBid", async () => {
    writes++;
    throw new Error("write boundary reached");
  });
  const args = {
    description: "Cap boundary",
    check: JSON.stringify({ verifier: "a".repeat(64), format: "{}" }),
    reference: "r",
    amount_near: "5",
    reveal_agreed: true,
  };
  const buyer = {
    ...config,
    account: "buyer.testnet",
    custodyKey: "test-only-placeholder",
  };
  await assert.rejects(
    executeBoardTool(
      "post_bid",
      { ...args, amount_near: "5.000000000000000000000001" },
      buyer,
    ),
    /exceeds.*limits/,
  );
  assert.equal(writes, 0);
  chain = { run_deposit: "1" };
  await assert.rejects(
    executeBoardTool("post_bid", args, buyer),
    /limits are unavailable/,
  );
  assert.equal(writes, 0);
  chain = valid;
  await assert.rejects(
    executeBoardTool("post_bid", args, buyer),
    /write boundary reached/,
  );
  assert.equal(writes, 1);
});

test("post_bid follows only its confirmed returned ID and preserves unknown creation identity", async (t) => {
  t.mock.method(BoardClient.prototype, "now", async () => 1n);
  t.mock.method(BoardClient.prototype, "view", async () => ({
    run_deposit: "1",
    caps: [
      {
        token: null,
        max_job: "5000000000000000000000000",
        max_held: "10000000000000000000000000",
        max_held_per_buyer: "5000000000000000000000000",
      },
    ],
  }));
  const check = JSON.stringify({ verifier: "a".repeat(64), format: "{}" });
  const args = {
    description: "Exact post",
    check,
    reference: "r",
    amount_near: "0.01",
    reveal_agreed: true,
  };
  let result: unknown = 150;
  t.mock.method(BoardClient.prototype, "postBid", async () => ({
    transaction_hash: "saved-tx",
    posted_bid_id: result as number,
  }));
  t.mock.method(BoardClient.prototype, "bids", async () => {
    throw new Error("must not search by hash");
  });
  const read: number[] = [];
  let wrongBuyer = false;
  t.mock.method(BoardClient.prototype, "bid", async (id: number) => {
    read.push(id);
    return {
      buyer: wrongBuyer ? "stranger.testnet" : "buyer.testnet",
      check_hash: sha(check),
      reference_hash: sha("r"),
      verifier_hash: "a".repeat(64),
      job_id: null,
    };
  });
  const buyer = {
    ...config,
    account: "buyer.testnet",
    custodyKey: "test-placeholder",
  };
  const posted = (await executeBoardTool("post_bid", args, buyer)) as {
    bid_id: number;
    transaction_hash: string;
    note: string;
  };
  assert.equal(posted.bid_id, 150);
  assert.deepEqual(read, [150]);
  assert.equal(posted.transaction_hash, "saved-tx");
  result = null;
  const unknown = (await executeBoardTool("post_bid", args, buyer)) as {
    note: string;
    transaction_hash: string;
  };
  assert.deepEqual(read, [150]);
  assert.match(unknown.note, /Reconcile/);
  assert.equal(unknown.transaction_hash, "saved-tx");
  result = 0;
  wrongBuyer = true;
  const mismatched = (await executeBoardTool("post_bid", args, buyer)) as {
    note: string;
  };
  assert.match(mismatched.note, /Reconcile/);
  assert.deepEqual(read, [150, 0]);
});
