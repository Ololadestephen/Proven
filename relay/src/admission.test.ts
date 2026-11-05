import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseEncode, type Account, type SignedTransaction } from "near-api-js";
import { confirmTransaction } from "./admission.ts";

const unsigned = Buffer.from("unsigned transaction"),
  hash = baseEncode(createHash("sha256").update(unsigned).digest());
function signed(signerId = "operator.testnet", receiverId = "escrow.testnet") {
  return {
    transaction: { signerId, receiverId, encode: () => unsigned },
    encode: () => Buffer.from("original signed bytes"),
  } as unknown as SignedTransaction;
}

test("retransmission freezes the original wire bytes even if the signed object later changes", async () => {
  const tx = signed(),
    sent: string[] = [];
  const account = {
    accountId: "operator.testnet",
    provider: {
      sendJsonRpc: async (_method: string, params: string[]) => {
        sent.push(params[0]);
        tx.encode = () =>
          Buffer.from("changed object must never be transmitted");
        if (sent.length === 2) throw Error("InvalidNonce duplicate response");
        return "acknowledgement";
      },
      viewTransactionStatus: async () => {
        throw Error("Unknown transaction");
      },
    },
  } as unknown as Account;
  assert.equal(
    await confirmTransaction(
      account,
      tx,
      hash,
      "escrow.testnet",
      "inclusion",
      async () => {},
    ),
    null,
  );
  assert.deepEqual(
    sent,
    Array(3).fill(Buffer.from("original signed bytes").toString("base64")),
  );
});

test("a mismatched journal hash, signer or receiver prevents every network request", async () => {
  let requests = 0;
  const account = {
    accountId: "operator.testnet",
    provider: {
      sendJsonRpc: async () => {
        requests++;
      },
      viewTransactionStatus: async () => {
        requests++;
      },
    },
  } as unknown as Account;
  for (const [tx, expectedHash] of [
    [signed(), "wrong-hash"],
    [signed("other.testnet"), hash],
    [signed("operator.testnet", "other.testnet"), hash],
  ] as const)
    await assert.rejects(
      confirmTransaction(
        account,
        tx,
        expectedHash,
        "escrow.testnet",
        "inclusion",
        async () => {},
      ),
      /does not match its journal/,
    );
  assert.equal(requests, 0);
});
