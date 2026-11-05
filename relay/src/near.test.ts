import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseEncode, type Account } from "near-api-js";
import type { Config } from "./config.ts";
import { submitDemoRun } from "./near.ts";

for (const uncertain of [false, true]) {
  test(`operator journals signed hash before one broadcast, uncertain=${uncertain}`, async () => {
    const bytes = Buffer.from("fixed unsigned transaction bytes");
    const expected = baseEncode(createHash("sha256").update(bytes).digest());
    let persisted = "",
      calls = 0,
      suspended = false;
    const signed = {
      transaction: {
        encode: () => bytes,
        signerId: "operator.testnet",
        nonce: 7n,
        blockHash: new Uint8Array(32),
      },
    };
    const account = {
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
        sendTransactionUntil: async (tx: unknown, wait: string) => {
          calls++;
          assert.equal(tx, signed);
          assert.equal(wait, "INCLUDED_FINAL");
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
      ),
      expected,
    );
    assert.equal(calls, 1);
    assert.equal(suspended, uncertain);
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
    assert.equal(calls, 1);
  });
}
