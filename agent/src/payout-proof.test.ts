import test from "node:test";
import assert from "node:assert/strict";
import type { JsonRpcProvider } from "near-api-js";
import { nativePayoutProof } from "./payout-proof.ts";

function fixture() {
  const call = {
    method_name: "refund",
    args: Buffer.from(JSON.stringify({ job_id: 14 })).toString("base64"),
    deposit: "0",
  };
  const outcome = {
    status: { SuccessValue: "dHJ1ZQ==" },
    transaction: {
      hash: "known",
      signer_id: "fake.testnet",
      receiver_id: "escrow.testnet",
      actions: [{ FunctionCall: call }],
    },
    receipts_outcome: [
      {
        id: "receipt",
        outcome: { executor_id: "buyer.testnet", status: { SuccessValue: "" } },
      },
    ],
  };
  const receipt = {
    receipt_id: "receipt",
    predecessor_id: "escrow.testnet",
    receiver_id: "buyer.testnet",
    receipt: { Action: { actions: [{ Transfer: { deposit: "10000" } }] } },
  };
  const provider = {
    viewTransactionStatus: async () => outcome,
    viewTransactionReceipt: async () => receipt,
  } as unknown as JsonRpcProvider;
  return {
    outcome,
    receipt,
    call,
    prove: () =>
      nativePayoutProof(
        provider,
        14,
        "known",
        "fake.testnet",
        "escrow.testnet",
        "buyer.testnet",
        "10000",
      ),
  };
}
test("payout proof binds successful transfer receipt to the exact job call, escrow, receiver and amount", async () => {
  assert.deepEqual(await fixture().prove(), {
    job_id: 14,
    transaction_hash: "known",
    receipt_id: "receipt",
    receiver: "buyer.testnet",
    amount: "10000",
  });
});
test("wrong calls, unrelated transfers, failed or missing receipts remain unproven", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.call.args = Buffer.from('{"job_id":99}').toString("base64");
    },
    (f: ReturnType<typeof fixture>) => {
      f.call.method_name = "deliver";
    },
    (f: ReturnType<typeof fixture>) => {
      f.outcome.transaction.signer_id = "stranger.testnet";
    },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.predecessor_id = "other.testnet";
    },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.receiver_id = "other.testnet";
    },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.receipt.Action.actions[0]!.Transfer.deposit = "9999";
    },
    (f: ReturnType<typeof fixture>) => {
      f.outcome.receipts_outcome = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.receipt.receipt_id = "wrong";
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(f.prove(), /not yet proven/);
  }
});
