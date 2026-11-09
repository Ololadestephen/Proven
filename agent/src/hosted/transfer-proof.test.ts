import assert from "node:assert/strict";
import test from "node:test";
import { confirmedTransfer } from "./transfer-proof.ts";
import { sendFromWallet } from "./wallets.ts";
import type { Config } from "../config.ts";
const hash = "A".repeat(44),
  from = "worker.testnet",
  to = "treasury.testnet";
const expected = { hash, from, to, amount: "1000" };
const outcome = () => ({
  transaction: {
    hash,
    signer_id: from,
    receiver_id: to,
    actions: [{ Transfer: { deposit: "1000" } }],
  },
  status: { SuccessValue: "" },
});
test("native payment proof binds final success, hash, source, recipient and exact amount", () => {
  assert.equal(confirmedTransfer(outcome(), expected), true);
  for (const value of [
    null,
    {},
    { ...outcome(), status: { Failure: {} } },
    { ...outcome(), status: { SuccessReceiptId: "pending" } },
    {
      ...outcome(),
      transaction: { ...outcome().transaction, signer_id: "other.testnet" },
    },
    {
      ...outcome(),
      transaction: { ...outcome().transaction, receiver_id: "other.testnet" },
    },
    {
      ...outcome(),
      transaction: { ...outcome().transaction, hash: "B".repeat(44) },
    },
    {
      ...outcome(),
      transaction: {
        ...outcome().transaction,
        actions: [{ Transfer: { deposit: "999" } }],
      },
    },
    {
      ...outcome(),
      transaction: {
        ...outcome().transaction,
        actions: [{ Transfer: { deposit: "1001" } }],
      },
    },
    {
      ...outcome(),
      transaction: {
        ...outcome().transaction,
        actions: [
          { Transfer: { deposit: "500" } },
          { Transfer: { deposit: "500" } },
        ],
      },
    },
  ])
    assert.equal(confirmedTransfer(value, expected), false);
});
test("a failed or pending transfer hash never advances a withdrawal to the next chunk", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const value of [
    { ...outcome(), status: { Failure: {} } },
    { ...outcome(), status: { SuccessReceiptId: "pending" } },
    null,
  ]) {
    let sends = 0;
    globalThis.fetch = async () => {
      sends++;
      return Response.json({ status: "failed", tx_hash: hash });
    };
    await assert.rejects(
      sendFromWallet(
        { custodyApi: "https://example.invalid" } as Config,
        "fixture",
        to,
        10n ** 23n + 1n,
        from,
        async () => value,
      ),
      /not confirmed/,
    );
    assert.equal(sends, 1);
  }
});
