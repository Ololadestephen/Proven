import { randomUUID } from "node:crypto";
import { PublicError } from "./errors.ts";
import type { CallPlan } from "./types.ts";

const CAPABILITIES = [
  "raw_sign",
  "sign_message",
  "evm_sign",
  "solana_sign",
  "swap",
  "cross_chain_withdraw",
  "limit_order",
  "confidential",
  "payment_check",
];
/** A readable-policy check is defense in depth; the TEE must enforce its on-chain policy too. */
export function assertPolicy(value: unknown, escrow: string): void {
  const p = value as {
    policy?: string;
    frozen?: boolean;
    rules?: {
      transaction_types?: unknown;
      allowed_tokens?: unknown;
      addresses?: { mode?: string; list?: unknown };
      limits?: {
        per_transaction?: { native?: string };
        daily?: { native?: string };
      };
    };
    capabilities?: Record<string, { allowed?: boolean }>;
  };
  const one = (v: unknown, expected: string) =>
    Array.isArray(v) && v.length === 1 && v[0] === expected;
  const cap = p?.rules?.limits?.per_transaction?.native;
  const daily = p?.rules?.limits?.daily?.native;
  if (
    p?.policy !== "stored" ||
    p.frozen !== false ||
    !one(p.rules?.transaction_types, "call") ||
    !one(p.rules?.allowed_tokens, "native") ||
    p.rules?.addresses?.mode !== "whitelist" ||
    !one(p.rules.addresses.list, escrow) ||
    !cap ||
    !/^\d+$/.test(cap) ||
    BigInt(cap) <= 0n ||
    BigInt(cap) > 10n ** 23n ||
    !daily ||
    !/^\d+$/.test(daily) ||
    BigInt(daily) <= 0n ||
    BigInt(daily) > 10n ** 24n ||
    CAPABILITIES.some((name) => p.capabilities?.[name]?.allowed !== false)
  ) {
    throw new PublicError(
      "Custody wallet must have the stored escrow-only native-call policy and disabled signing capabilities.",
    );
  }
}

export async function custodyRead(
  api: string,
  key: string,
  path: string,
): Promise<unknown> {
  const response = await fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new PublicError(
      "Could not read the testnet custody wallet. Check its credential and policy.",
    );
  return response.json();
}

export async function custodyCall(
  api: string,
  key: string,
  expectedAccount: string,
  escrow: string,
  plan: CallPlan,
): Promise<string> {
  if (plan.receiver_id !== escrow || BigInt(plan.deposit) > 10n ** 23n)
    throw new PublicError("Call exceeds the escrow-only signing boundary.");
  const address = (await custodyRead(
    api,
    key,
    "/wallet/v1/address?chain=near",
  )) as {
    address?: string;
    asset_account_id?: string | null;
    executor_account_id?: string;
  };
  if (
    address.address !== expectedAccount ||
    (address.executor_account_id &&
      address.executor_account_id !== expectedAccount) ||
    address.asset_account_id
  )
    throw new PublicError(
      "Custody wallet identity differs from the configured unbound buyer account.",
    );
  assertPolicy(await custodyRead(api, key, "/wallet/v1/policy"), escrow);
  const response = await fetch(`${api}/wallet/v1/call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "X-Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(plan),
    signal: AbortSignal.timeout(180000),
  }).catch(() => {
    throw new PublicError(
      "Custody submission outcome is unknown. Inspect wallet history before retrying; no automatic retry was made.",
    );
  });
  let body: {
    tx_hash?: string;
    status?: string;
    result?: { tx_hash?: string; never_reached_chain?: boolean };
  } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    /* Never print an upstream body. */
  }
  const tx = body.tx_hash ?? body.result?.tx_hash;
  if (body.result?.never_reached_chain === true)
    throw new PublicError(
      "Custody reports that this request never reached chain. Inspect its history before submitting a new request.",
    );
  if (tx && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx)) return tx;
  if (body.status === "pending_approval")
    throw new PublicError(
      "Custody requires owner approval. No automatic retry was made.",
    );
  throw new PublicError(
    "Custody did not return a transaction hash. Check wallet history before retrying; no automatic retry was made.",
  );
}
