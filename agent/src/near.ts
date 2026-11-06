import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import type { Config } from "./config.ts";
import { PublicError } from "./errors.ts";
import { custodyCall, custodySignForRelay } from "./custody.ts";
import { handoff, handoffOverWeb } from "./handoff.ts";
import { relayMessage, signWithKey } from "./relay-auth.ts";
import type { CallPlan, CallResult, Runtime } from "./types.ts";

const WORKER_METHODS = new Set([
  "deliver",
  "release",
  "refund",
  "expire",
  "cancel_stale_outlayer_execution",
]);

export async function scopedWorker(
  config: Config,
  provider: JsonRpcProvider,
  method: string,
  deposit: string,
): Promise<Account> {
  if (!config.key || !config.account)
    throw new PublicError("Worker scoped credentials are missing.");
  if (deposit !== "0" || !WORKER_METHODS.has(method))
    throw new PublicError(
      "Worker function-call keys cannot attach deposits or perform this operation. Use buyer custody for payable calls.",
    );
  const key = KeyPair.fromString(config.key as `ed25519:${string}`);
  const account = new Account(config.account, provider, new KeyPairSigner(key));
  const access = await account.getAccessKey(key.getPublicKey());
  const permission = access.permission;
  if (
    permission === "FullAccess" ||
    !permission?.FunctionCall ||
    permission.FunctionCall.receiver_id !== config.escrow ||
    !permission.FunctionCall.method_names.length ||
    permission.FunctionCall.method_names.some((m) => !WORKER_METHODS.has(m)) ||
    !permission.FunctionCall.method_names.includes(method)
  ) {
    throw new PublicError(
      "Worker key must be a function-call key scoped to this escrow and permitted zero-deposit worker methods.",
    );
  }
  return account;
}

/** Reads settlement without rebroadcasting a write. Unknown status is returned as pending. */
export async function transactionResult(
  provider: JsonRpcProvider,
  tx: string,
  account: string,
): Promise<CallResult> {
  try {
    const response = await provider.viewTransactionStatus({
      txHash: tx,
      accountId: account,
      waitUntil: "NONE",
    });
    if (!["EXECUTED", "FINAL"].includes(response.final_execution_status))
      return { transaction_hash: tx, pending: true };
    const status = response.status;
    if (typeof status === "object" && "SuccessValue" in status) {
      const bytes = Buffer.from(status.SuccessValue, "base64").toString("utf8");
      let result: unknown = null;
      try {
        result = JSON.parse(bytes);
      } catch {
        /* Methods with no return value. */
      }
      return { transaction_hash: tx, result };
    }
    if (typeof status === "object" && "Failure" in status)
      return { transaction_hash: tx, failed: true };
  } catch {
    /* The transaction may still be running. Do not retry a write. */
  }
  return { transaction_hash: tx, pending: true };
}

/** Follow a known transaction only. A timeout remains pending and never rebroadcasts. */
export async function waitTransactionResult(
  provider: JsonRpcProvider,
  tx: string,
  account: string,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 1000)),
): Promise<CallResult> {
  for (let read = 0; read < 45; read++) {
    const result = await transactionResult(provider, tx, account);
    if (!result.pending) return result;
    if (read < 44) await wait();
  }
  return { transaction_hash: tx, pending: true };
}

export function createRuntime(
  config: Config,
  provider = new JsonRpcProvider({ url: config.rpc }),
): Runtime {
  return {
    actor: config.actor,
    identity: config.account ?? null,
    escrow: config.escrow,
    allowedWorkers: config.allowedWorkers,
    async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
      return (await provider.callFunction({
        contractId: config.escrow,
        method,
        args,
      })) as T;
    },
    async now() {
      const block = await provider.viewBlock({ finality: "final" });
      return BigInt(block.header.timestamp_nanosec);
    },
    async submit(plan: CallPlan) {
      if (plan.receiver_id !== config.escrow)
        throw new PublicError("Only this escrow may receive agent calls.");
      if (config.actor === "buyer" || config.actor === "agent") {
        if (!config.custodyKey || !config.account)
          throw new PublicError(
            "Custody credentials are missing. Full-access keys are never accepted by this interface.",
          );
        const tx = await custodyCall(
          config.custodyApi,
          config.custodyKey,
          config.account,
          config.escrow,
          plan,
          config.hosted,
        );
        return waitTransactionResult(provider, tx, config.account);
      }
      const worker = await scopedWorker(
        config,
        provider,
        plan.method_name,
        plan.deposit,
      );
      const response = await worker
        .callFunctionRaw({
          contractId: config.escrow,
          methodName: plan.method_name,
          args: plan.args,
          deposit: "0",
          gas: BigInt(plan.gas),
        })
        .catch(() => {
          throw new PublicError(
            "Worker submission outcome is unknown. Inspect job status and account history before retrying; no automatic retry was made.",
          );
        });
      return waitTransactionResult(
        provider,
        response.transaction.hash,
        worker.accountId,
      );
    },
    signForRelay: config.custodyKey
      ? (message) =>
          custodySignForRelay(config.custodyApi, config.custodyKey!, message)
      : undefined,
    async handoff(request) {
      const body: Record<string, unknown> = {
        ...request,
        ...(config.demoSession ? { session_id: config.demoSession } : {}),
      };
      // A reachable relay needs a signature for everything, so sign whenever this account can.
      const message = relayMessage(request);
      const signed = config.custodyKey
        ? await custodySignForRelay(
            config.custodyApi,
            config.custodyKey,
            message,
          )
        : config.key
          ? signWithKey(config.key, message)
          : null;
      if (signed) body.auth = { ...signed, message };
      else if (config.relayUrl || request.action === "collect")
        throw new PublicError("This account has no key to sign with.");
      return config.relayUrl
        ? handoffOverWeb(config.relayUrl, body)
        : handoff(config.socket, body);
    },
  };
}
