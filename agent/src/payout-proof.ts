import type { JsonRpcProvider } from "near-api-js";
import { PublicError } from "./errors.ts";

export interface PayoutProof {
  job_id: number;
  transaction_hash: string;
  receipt_id: string;
  receiver: string;
  amount: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid receipt");
  return value as Record<string, unknown>;
}

/** Prove this job's native transfer, rather than infer it from a potentially lagging balance. */
export async function nativePayoutProof(
  provider: JsonRpcProvider,
  jobId: number,
  transaction: string,
  signer: string,
  escrow: string,
  receiver: string,
  amount: string,
): Promise<PayoutProof> {
  try {
    const outcome = await provider.viewTransactionStatus({
      txHash: transaction,
      accountId: signer,
      waitUntil: "EXECUTED",
    });
    const tx = outcome.transaction;
    if (
      tx.hash !== transaction ||
      tx.signer_id !== signer ||
      tx.receiver_id !== escrow ||
      tx.actions.length !== 1 ||
      !("SuccessValue" in object(outcome.status))
    )
      throw new Error("Invalid payout transaction");
    const call = object(object(tx.actions[0]).FunctionCall);
    const args = object(
      JSON.parse(Buffer.from(String(call.args), "base64").toString("utf8")),
    );
    if (
      !["release", "refund", "expire"].includes(String(call.method_name)) ||
      Object.keys(args).length !== 1 ||
      args.job_id !== jobId ||
      String(call.deposit) !== "0"
    )
      throw new Error("Wrong job or method");
    for (const candidate of outcome.receipts_outcome) {
      if (
        candidate.outcome.executor_id !== receiver ||
        !("SuccessValue" in object(candidate.outcome.status))
      )
        continue;
      const receipt = await provider.viewTransactionReceipt(candidate.id);
      const actions = object(object(receipt).receipt).Action;
      const list = object(actions).actions;
      if (
        receipt.predecessor_id !== escrow ||
        receipt.receiver_id !== receiver ||
        receipt.receipt_id !== candidate.id ||
        !Array.isArray(list) ||
        list.length !== 1
      )
        continue;
      if (object(object(list[0]).Transfer).deposit === amount)
        return {
          job_id: jobId,
          transaction_hash: transaction,
          receipt_id: candidate.id,
          receiver,
          amount,
        };
    }
  } catch {
    /* A missing or malformed receipt remains unproven; no balance inference. */
  }
  throw new PublicError(
    "The expected payout receipt is not yet proven. Inspect this known transaction; no payment was repeated.",
  );
}
