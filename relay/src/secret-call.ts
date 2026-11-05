import { createHash } from "node:crypto";
import { actions, baseEncode, type Account } from "near-api-js";
import type { SubmissionMetadata } from "./near.ts";
import { confirmTransaction } from "./admission.ts";

export type SecretJournal = (
  hash: string,
  metadata: SubmissionMetadata,
) => Promise<void>;

/** A single signed pin/delete; an RPC admission timeout only starts read-only reconciliation. */
export async function secretCall(
  account: Account,
  contract: string,
  method: "store_secrets" | "delete_secrets",
  args: Record<string, unknown>,
  deposit: string,
  journal: SecretJournal,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
) {
  const signed = await account.createSignedTransaction({
    receiverId: contract,
    actions: [
      actions.functionCall(method, args, 50_000_000_000_000n, BigInt(deposit)),
    ],
  });
  const hash = baseEncode(
    createHash("sha256").update(signed.transaction.encode()).digest(),
  );
  await journal(hash, {
    signer: signed.transaction.signerId,
    nonce: signed.transaction.nonce.toString(),
    block_hash: baseEncode(signed.transaction.blockHash),
  });
  const outcome = await confirmTransaction(
    account,
    signed,
    hash,
    contract,
    "execution",
    wait,
  );
  if (!outcome)
    throw new Error(`Secret transaction remains unconfirmed: ${hash}`);
  if (typeof outcome.status !== "object" || !("SuccessValue" in outcome.status))
    throw new Error(`Secret transaction failed: ${hash}`);
  return outcome;
}
