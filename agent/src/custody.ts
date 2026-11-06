import { randomBytes, randomUUID } from "node:crypto";
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
/** The bid board. It holds no job money, so a wallet may also call it. */
export const BOARD = process.env.PROVEN_BOARD ?? "board-v2.proven.testnet";

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
  const receivers = p?.rules?.addresses?.list;
  const onlyEscrowAndBoard =
    Array.isArray(receivers) &&
    receivers.includes(escrow) &&
    receivers.length === new Set(receivers).size &&
    receivers.every((receiver) => receiver === escrow || receiver === BOARD);
  const cap = p?.rules?.limits?.per_transaction?.native;
  const daily = p?.rules?.limits?.daily?.native;
  if (
    p?.policy !== "stored" ||
    p.frozen !== false ||
    !one(p.rules?.transaction_types, "call") ||
    !one(p.rules?.allowed_tokens, "native") ||
    p.rules?.addresses?.mode !== "whitelist" ||
    !onlyEscrowAndBoard ||
    !cap ||
    !/^\d+$/.test(cap) ||
    BigInt(cap) <= 0n ||
    BigInt(cap) > 10n ** 23n ||
    !daily ||
    !/^\d+$/.test(daily) ||
    BigInt(daily) <= 0n ||
    BigInt(daily) > 10n ** 24n ||
    CAPABILITIES.some(
      (name) =>
        p.capabilities?.[name]?.allowed !== false && !relaySigning(name, p),
    )
  ) {
    throw new PublicError(
      "Custody wallet must have the stored native-call policy limited to the escrow and the board, with signing capabilities disabled.",
    );
  }
}

/** The one thing signing may be open for: messages addressed to this project's relay. */
export const RELAY_RECIPIENT = "proven-relay";
function relaySigning(
  name: string,
  policy: {
    capabilities?: Record<
      string,
      { allowed?: boolean; allowed_recipients?: unknown }
    >;
  },
): boolean {
  const list = policy.capabilities?.[name]?.allowed_recipients;
  return (
    name === "sign_message" &&
    policy.capabilities?.[name]?.allowed === true &&
    Array.isArray(list) &&
    list.length === 1 &&
    list[0] === RELAY_RECIPIENT
  );
}

/** Signs one NEP-413 message for the relay. It can sign for nothing else. */
export async function custodySignForRelay(
  api: string,
  key: string,
  message: string,
): Promise<{
  public_key: string;
  signature_base64: string;
  nonce_base64: string;
}> {
  const nonce = randomBytes(32).toString("base64");
  const response = await fetch(`${api}/wallet/v1/sign-message`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message, recipient: RELAY_RECIPIENT, nonce }),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok)
    throw new PublicError("The wallet would not sign the collect request.");
  const body = (await response.json()) as {
    public_key?: string;
    signature_base64?: string;
    nonce?: string;
  };
  if (!body.public_key || !body.signature_base64)
    throw new PublicError("The wallet returned no signature.");
  return {
    public_key: body.public_key,
    signature_base64: body.signature_base64,
    nonce_base64: body.nonce ?? nonce,
  };
}

export async function custodyRead(
  api: string,
  key: string,
  path: string,
): Promise<unknown> {
  const response = await fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok)
    throw new PublicError(
      "Could not read the custody wallet. Check its credential and policy.",
    );
  return response.json();
}

interface CustodyResponse {
  request_id?: string;
  type?: string;
  status?: string;
  tx_hash?: string;
  result?: {
    tx_hash?: string;
    never_reached_chain?: boolean;
    never_submitted?: boolean;
    never_executed?: boolean;
  };
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 1000));

/** Read the one submitted request; never submit it again, even when polling fails. */
export async function custodyTransaction(
  api: string,
  key: string,
  initial: CustodyResponse,
  wait = pause,
): Promise<string> {
  let body = initial;
  const id = initial.request_id;
  for (let read = 0; read <= 30; read++) {
    if (
      body.result?.never_reached_chain ||
      body.result?.never_executed ||
      body.result?.never_submitted
    )
      throw new PublicError(
        "Custody reports that this request never reached chain. Inspect its history before submitting a new request.",
      );
    const tx = body.tx_hash ?? body.result?.tx_hash;
    if (typeof tx === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx))
      return tx;
    if (
      ["pending_approval", "rejected", "cancelled", "needs_review"].includes(
        body.status ?? "",
      )
    )
      throw new PublicError(
        "Custody requires owner review. No automatic retry was made.",
      );
    if (body.status === "failed" || body.status === "refunded")
      throw new PublicError(
        "Custody request ended without an admitted transaction hash. Reconcile its history; no automatic retry was made.",
      );
    if (!id || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
      break;
    if (read === 30) break;
    await wait();
    let response: CustodyResponse;
    try {
      response = (await custodyRead(
        api,
        key,
        `/wallet/v1/requests/${id}`,
      )) as CustodyResponse;
    } catch {
      // Only repeat a status read. A transient read failure says nothing about admission.
      continue;
    }
    if (response?.request_id !== id || response.type !== "call")
      throw new PublicError(
        "Custody status response does not match the submitted call. No automatic retry was made.",
      );
    body = response;
  }
  throw new PublicError(
    `Custody did not return a transaction hash${id && /^[a-f0-9-]{36}$/i.test(id) ? ` for request ${id}` : ""}. Check wallet history before retrying; no automatic retry was made.`,
  );
}

export async function custodyCall(
  api: string,
  key: string,
  expectedAccount: string,
  escrow: string,
  plan: CallPlan,
): Promise<string> {
  if (
    (plan.receiver_id !== escrow && plan.receiver_id !== BOARD) ||
    BigInt(plan.deposit) > 10n ** 23n
  )
    throw new PublicError("Call exceeds the signing boundary.");
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
    redirect: "error",
  }).catch(() => {
    throw new PublicError(
      "Custody submission outcome is unknown. Inspect wallet history before retrying; no automatic retry was made.",
    );
  });
  let body: CustodyResponse = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    /* Never print an upstream body. */
  }
  if (!response.ok)
    throw new PublicError(
      "Custody answered with an error, but the call may still have landed. Read the on-chain state before doing anything else; no automatic retry was made.",
    );
  return custodyTransaction(api, key, body);
}
