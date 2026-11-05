import test from "node:test";
import assert from "node:assert/strict";
import { KeyPair, type JsonRpcProvider } from "near-api-js";
import { createRuntime, scopedWorker, waitTransactionResult } from "./near.ts";
import type { Config } from "./config.ts";

test("worker signer refuses full-access, other targets, unrestricted methods and deposits", async () => {
  const config: Config = {
    actor: "honest",
    escrow: "escrow-v2.proven.testnet",
    rpc: "",
    socket: "",
    custodyApi: "",
    account: "honest.testnet",
    key: KeyPair.fromRandom("ed25519").toString(),
  };
  for (const permission of [
    "FullAccess",
    {
      FunctionCall: {
        receiver_id: "attacker.testnet",
        method_names: ["deliver"],
      },
    },
    { FunctionCall: { receiver_id: config.escrow, method_names: [] } },
    {
      FunctionCall: {
        receiver_id: config.escrow,
        method_names: ["deliver", "set_verifier"],
      },
    },
  ]) {
    const provider = {
      viewAccessKey: async () => ({ nonce: 0, permission }),
    } as unknown as JsonRpcProvider;
    await assert.rejects(scopedWorker(config, provider, "deliver", "0"));
  }
  const provider = {
    viewAccessKey: async () => ({
      nonce: 0,
      permission: {
        FunctionCall: { receiver_id: config.escrow, method_names: ["deliver"] },
      },
    }),
  } as unknown as JsonRpcProvider;
  await assert.rejects(scopedWorker(config, provider, "deliver", "1"));
  await assert.doesNotReject(scopedWorker(config, provider, "deliver", "0"));
});

test("known custody transaction is followed with reads until its actual outcome", async () => {
  let reads = 0;
  const provider = {
    viewTransactionStatus: async (input: {
      txHash: string;
      accountId: string;
      waitUntil: string;
    }) => {
      assert.deepEqual(
        [input.txHash, input.accountId],
        ["known-hash", "buyer.testnet"],
      );
      reads++;
      assert.equal(input.waitUntil, "NONE");
      return reads === 1
        ? {
            final_execution_status: "EXECUTED_OPTIMISTIC",
            status: { SuccessValue: Buffer.from("999").toString("base64") },
          }
        : {
            final_execution_status: "EXECUTED",
            status: { SuccessValue: Buffer.from("42").toString("base64") },
          };
    },
  } as unknown as JsonRpcProvider;
  const result = await waitTransactionResult(
    provider,
    "known-hash",
    "buyer.testnet",
    async () => {},
  );
  assert.equal(result.result, 42);
  assert.equal(reads, 2);
});

test("failed and unresolved transaction reads never cause a write retry", async () => {
  const failed = {
    viewTransactionStatus: async () => ({
      final_execution_status: "FINAL",
      status: { Failure: { error: "onchain" } },
    }),
  } as unknown as JsonRpcProvider;
  assert.equal(
    (
      await waitTransactionResult(
        failed,
        "known",
        "buyer.testnet",
        async () => {},
      )
    ).failed,
    true,
  );
  let reads = 0;
  const pending = {
    viewTransactionStatus: async () => {
      reads++;
      throw new Error("not ready");
    },
  } as unknown as JsonRpcProvider;
  const result = await waitTransactionResult(
    pending,
    "known",
    "buyer.testnet",
    async () => {},
  );
  assert.equal(reads, 45);
  assert.equal(result.pending, true);
  assert.equal(result.transaction_hash, "known");
});

test("worker runtime waits for final execution after an optimistic delivery without resending", async () => {
  let sends = 0,
    reads = 0;
  const config: Config = {
    actor: "honest",
    account: "honest.testnet",
    key: KeyPair.fromRandom("ed25519").toString(),
    escrow: "escrow-v2.proven.testnet",
    rpc: "",
    socket: "",
    custodyApi: "",
  };
  const provider = {
    viewAccessKey: async () => ({
      nonce: 1n,
      permission: {
        FunctionCall: {
          receiver_id: config.escrow,
          method_names: ["deliver"],
          allowance: "100000000000000000000000",
        },
      },
    }),
    viewBlock: async () => ({ header: { hash: "1".repeat(32) } }),
    sendTransactionUntil: async () => {
      sends++;
      return {
        transaction: { hash: "known-delivery" },
        final_execution_status: "EXECUTED_OPTIMISTIC",
        status: { SuccessValue: "bnVsbA==" },
      };
    },
    viewTransactionStatus: async (input: {
      txHash: string;
      waitUntil: string;
    }) => {
      reads++;
      assert.equal(input.txHash, "known-delivery");
      assert.equal(input.waitUntil, "NONE");
      return {
        final_execution_status:
          reads === 1 ? "EXECUTED_OPTIMISTIC" : "EXECUTED",
        status: { SuccessValue: "bnVsbA==" },
      };
    },
  } as unknown as JsonRpcProvider;
  const result = await createRuntime(config, provider).submit({
    receiver_id: config.escrow,
    method_name: "deliver",
    args: { job_id: 1, deliverable_hash: "a".repeat(64) },
    deposit: "0",
    gas: "50000000000000",
  });
  assert.equal(result.pending, undefined);
  assert.equal(result.failed, undefined);
  assert.equal(result.result, null);
  assert.equal(reads, 2);
  assert.equal(sends, 1);
});
