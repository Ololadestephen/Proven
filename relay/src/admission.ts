import { createHash } from "node:crypto";
import { baseEncode, type Account, type SignedTransaction } from "near-api-js";
import { timed, type TimingSink } from "./timing.ts";

/** Retransmit immutable signed bytes, never a replacement transaction or a new nonce. */
export async function confirmTransaction(
  account: Account,
  signed: SignedTransaction,
  hash: string,
  receiver: string,
  required: "inclusion" | "execution",
  wait: () => Promise<void>,
  timing?: TimingSink,
) {
  if (
    !("sendJsonRpc" in account.provider) ||
    typeof account.provider.sendJsonRpc !== "function"
  )
    throw new Error("Expected a JSON RPC provider");
  const send = account.provider.sendJsonRpc.bind(account.provider);
  if (
    signed.transaction.signerId !== account.accountId ||
    signed.transaction.receiverId !== receiver ||
    baseEncode(
      createHash("sha256").update(signed.transaction.encode()).digest(),
    ) !== hash
  )
    throw new Error("Signed transaction does not match its journal");
  const signed_tx_base64 = Buffer.from(signed.encode()).toString("base64");
  const accepted =
    required === "inclusion"
      ? ["INCLUDED_FINAL", "EXECUTED", "FINAL"]
      : ["EXECUTED", "FINAL"];
  const limit = required === "inclusion" ? 20 : 45;
  let observed = false;
  for (let read = 0; read < limit; read++) {
    if (!observed && [0, 4, 8].includes(read)) {
      try {
        await timed(
          required === "inclusion" ? "compute_broadcast" : "secret_broadcast",
          () => send("broadcast_tx_async", [signed_tx_base64]),
          timing,
        );
      } catch {
        /* Duplicate/error/timeout acknowledges nothing; inspect the original hash. */
      }
    }
    try {
      const outcome = await account.provider.viewTransactionStatus({
        txHash: hash,
        accountId: account.accountId,
        waitUntil: "NONE",
      });
      if (
        outcome.transaction?.hash === hash &&
        outcome.transaction.signer_id === account.accountId &&
        outcome.transaction.receiver_id === receiver
      ) {
        const status = outcome.final_execution_status;
        if (
          [
            "INCLUDED",
            "EXECUTED_OPTIMISTIC",
            "INCLUDED_FINAL",
            "EXECUTED",
            "FINAL",
          ].includes(status)
        )
          observed = true;
        if (accepted.includes(status)) return outcome;
      }
    } catch {
      /* Never infer inclusion from an unreadable or unknown transaction. */
    }
    if (read < limit - 1) await wait();
  }
  return null;
}
