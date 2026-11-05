import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseEncode, type Account } from "near-api-js";
import type { Config } from "./config.ts";
import { submitDemoRun } from "./near.ts";

for (const mode of [
  "ack",
  "unconfirmed",
  "confirmed",
  "optimistic",
  "mismatched",
]) {
  const uncertain = mode !== "ack";
  test(`operator journals once and reconciles nonce inclusion: ${mode}`, async () => {
    const bytes = Buffer.from("fixed unsigned transaction bytes");
    const expected = baseEncode(createHash("sha256").update(bytes).digest());
    let persisted = "",
      calls = 0,
      suspended = false,
      reads = 0;
    const signed = {
      encode: () => Buffer.from("immutable signed bytes"),
      transaction: {
        encode: () => bytes,
        signerId: "operator.testnet",
        receiverId: "escrow.testnet",
        nonce: 7n,
        blockHash: new Uint8Array(32),
      },
    };
    const account = {
      accountId: "operator.testnet",
      createSignedTransaction: async (input: Record<string, unknown>) => {
        assert.equal(input.receiverId, "escrow.testnet");
        const actions = input.actions as Array<{
          functionCall: { methodName: string; gas: bigint; deposit: bigint };
        }>;
        assert.equal(actions.length, 1);
        assert.equal(
          actions[0]!.functionCall.methodName,
          "request_verification",
        );
        assert.equal(actions[0]!.functionCall.gas, 150000000000000n);
        assert.equal(
          actions[0]!.functionCall.deposit,
          100000000000000000000000n,
        );
        return signed;
      },
      provider: {
        viewTransactionStatus: async (input: Record<string, unknown>) => {
          reads++;
          assert.equal(input.waitUntil, "NONE");
          assert.equal(input.txHash, expected);
          if (mode === "unconfirmed") throw Error("Unknown");
          return {
            final_execution_status:
              mode === "optimistic" || reads === 1
                ? "EXECUTED_OPTIMISTIC"
                : "FINAL",
            transaction: {
              hash: mode === "mismatched" ? "wrong" : expected,
              signer_id: "operator.testnet",
              receiver_id: "escrow.testnet",
            },
            status: { SuccessValue: "dHJ1ZQ==" },
          };
        },
        sendJsonRpc: async (method: string, params: string[]) => {
          calls++;
          assert.equal(method, "broadcast_tx_async");
          assert.equal(
            params[0],
            Buffer.from("immutable signed bytes").toString("base64"),
          );
          assert.equal(persisted, expected);
          if (uncertain) throw Error("Unknown transport outcome");
          return { status: "Started" };
        },
      },
    } as unknown as Account;
    assert.equal(
      await submitDemoRun(
        account,
        { escrowContract: "escrow.testnet" } as Config,
        15,
        "Verify",
        async (hash, metadata) => {
          persisted = hash;
          assert.equal(metadata.signer, "operator.testnet");
          assert.equal(metadata.nonce, "7");
          assert.equal(metadata.block_hash, "1".repeat(32));
        },
        () => {
          suspended = true;
        },
        undefined,
        async () => {},
      ),
      expected,
    );
    assert.equal(calls, ["unconfirmed", "mismatched"].includes(mode) ? 3 : 1);
    assert.equal(suspended, !["ack", "confirmed"].includes(mode));
    assert.equal(reads, ["ack", "confirmed"].includes(mode) ? 2 : 20);
    await assert.rejects(
      submitDemoRun(
        account,
        { escrowContract: "escrow.testnet" } as Config,
        15,
        "Verify",
        async () => {
          throw Error("Disk failure");
        },
        () => {
          suspended = true;
        },
      ),
      /Disk failure/,
    );
    assert.equal(calls, ["unconfirmed", "mismatched"].includes(mode) ? 3 : 1);
  });
}
