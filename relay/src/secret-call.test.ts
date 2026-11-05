import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseEncode, type Account } from "near-api-js";
import { secretCall } from "./secret-call.ts";

function fixture(outcomes: Array<unknown>) {
  const bytes = Buffer.from("fixed signed pin input"),
    hash = baseEncode(createHash("sha256").update(bytes).digest());
  let signs = 0,
    sends = 0,
    reads = 0,
    journaled = false;
  const account = {
    accountId: "operator.testnet",
    createSignedTransaction: async () => {
      signs++;
      return {
        encode: () => Buffer.from("immutable signed pin"),
        transaction: {
          encode: () => bytes,
          signerId: "operator.testnet",
          receiverId: "outlayer.testnet",
          nonce: 3n,
          blockHash: new Uint8Array(32),
        },
      };
    },
    provider: {
      sendJsonRpc: async (_method: string, params: string[]) => {
        assert.equal(params.length, 1);
        sends++;
        assert.equal(journaled, true);
        throw Error("RPC admission timeout");
      },
      viewTransactionStatus: async (request: Record<string, unknown>) => {
        assert.equal(request.txHash, hash);
        assert.equal(request.waitUntil, "NONE");
        const result = outcomes[Math.min(reads++, outcomes.length - 1)];
        if (result instanceof Error) throw result;
        return result;
      },
    },
  } as unknown as Account;
  const outcome = (status = "EXECUTED", failed = false) => ({
    final_execution_status: status,
    transaction: {
      hash,
      signer_id: "operator.testnet",
      receiver_id: "outlayer.testnet",
    },
    status: failed ? { Failure: {} } : { SuccessValue: "" },
  });
  return {
    account,
    hash,
    outcome,
    journal: async () => {
      journaled = true;
    },
    counts: () => ({ signs, sends, reads }),
  };
}

test("an admission timeout follows only the saved pin hash until execution is confirmed", async () => {
  const pending = fixture([]);
  const f = fixture([
    new Error("Not observed"),
    pending.outcome("EXECUTED_OPTIMISTIC"),
    pending.outcome(),
  ]);
  const result = await secretCall(
    f.account,
    "outlayer.testnet",
    "store_secrets",
    { encrypted_secrets_base64: "PRIVATE" },
    "100000000000000000000000",
    f.journal,
    async () => {},
  );
  assert.equal(result.transaction.hash, f.hash);
  assert.deepEqual(f.counts(), { signs: 1, sends: 1, reads: 3 });
});

test("failed or unresolved pins stay unconfirmed without signing or sending replacements", async () => {
  for (const failed of [false, true]) {
    const pending = fixture([]),
      f = fixture([
        failed ? pending.outcome("FINAL", true) : new Error("Unknown"),
      ]);
    await assert.rejects(
      secretCall(
        f.account,
        "outlayer.testnet",
        "delete_secrets",
        {},
        "0",
        f.journal,
        async () => {},
      ),
    );
    assert.deepEqual(f.counts(), {
      signs: 1,
      sends: failed ? 1 : 3,
      reads: failed ? 1 : 45,
    });
  }
});

test("journal failure prevents broadcasting a pin", async () => {
  const f = fixture([]);
  await assert.rejects(
    secretCall(
      f.account,
      "outlayer.testnet",
      "store_secrets",
      {},
      "0",
      async () => {
        throw Error("Disk failure");
      },
      async () => {},
    ),
    /Disk failure/,
  );
  assert.deepEqual(f.counts(), { signs: 1, sends: 0, reads: 0 });
});
