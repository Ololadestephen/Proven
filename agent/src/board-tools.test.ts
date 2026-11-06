import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { boardTools, executeBoardTool, isBoardTool } from "./board-tools.ts";
import type { Config } from "./config.ts";
import { BOARD } from "./custody.ts";

const config = {
  actor: "buyer",
  escrow: "escrow.testnet",
  rpc: "https://test.rpc.fastnear.com",
  custodyApi: "https://testnet-api.outlayer.ai",
} as Config;
const never = () => Promise.reject(new Error("must not fund"));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("board tools have schemas and are recognised", () => {
  assert.ok(boardTools.length >= 11);
  assert.ok(boardTools.every((tool) => isBoardTool(tool.name)));
  assert.equal(isBoardTool("post_job"), false);
});

test("a dry post_bid fixes the hashes and the verifier named in the check", async () => {
  const check = JSON.stringify({ verifier: "a".repeat(64) });
  const result = (await executeBoardTool(
    "post_bid",
    { description: "Do it", check, reference: "r", amount_near: "0.01" },
    config,
    never,
    true,
  )) as { call: { receiver_id: string; args: Record<string, unknown> } };
  assert.equal(result.call.receiver_id, BOARD);
  assert.equal(result.call.args.check_hash, sha(check));
  assert.equal(result.call.args.reference_hash, sha("r"));
  assert.equal(result.call.args.verifier_hash, "a".repeat(64));
  assert.equal(result.call.args.claim_window_secs, 1800);
});

test("a description over the board's limit, unknown fields and a keyless write are refused", async () => {
  const check = JSON.stringify({ verifier: "a".repeat(64) });
  await assert.rejects(
    executeBoardTool(
      "post_bid",
      {
        description: "x".repeat(2049),
        check,
        reference: "r",
        amount_near: "0.01",
      },
      config,
      never,
      true,
    ),
  );
  await assert.rejects(
    executeBoardTool(
      "claim_bid",
      { bid_id: 0, payee: "x.testnet" },
      config,
      never,
      true,
    ),
    /Unknown field/,
  );
  await assert.rejects(
    executeBoardTool("claim_bid", { bid_id: 0 }, config, never),
    /custody wallet/,
  );
});
