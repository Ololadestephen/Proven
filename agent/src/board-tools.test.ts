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

test("a dry post_bid fixes the hashes and the verifier named in the check", async () => {
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
