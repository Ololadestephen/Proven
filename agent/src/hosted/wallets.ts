// Creates a hosted agent's custody wallet and stores its policy: calls to the escrow and the board, and
// NEAR only to its owner and the treasury. OutLayer enforces that policy inside its TEE, so even this
// server cannot send an agent's NEAR anywhere else.
import { chainProvider } from "../rpc.ts";
import { readFileSync } from "node:fs";
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { ROOT, type Config } from "../config.ts";
import {
  assertPolicy,
  BOARD,
  custodyRead,
  RELAY_RECIPIENT,
} from "../custody.ts";
import { PublicError } from "../errors.ts";
import { isObject, jsonObject } from "../json.ts";

const MAX_POLICY_STORAGE = 50_000_000_000_000_000_000_000n;
/** The policy allows no single transfer above this, so a withdrawal goes in steps. */
export const MAX_TRANSFER = 100_000_000_000_000_000_000_000n;

async function post(
  api: string,
  path: string,
  body: unknown,
  key?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
  }).catch(() => {
    throw new PublicError(`OutLayer did not answer ${path}.`);
  });
  if (!response.ok)
    throw new PublicError(`OutLayer refused ${path}: HTTP ${response.status}.`);
  return jsonObject(
    await response.text(),
    `OutLayer returned invalid JSON for ${path}.`,
  );
}

export function treasuryAccount(
  config: Config,
  accountId: string,
  privateKey: string,
): Account {
  return new Account(
    accountId,
    chainProvider(config.rpc),
    new KeyPairSigner(KeyPair.fromString(privateKey as `ed25519:${string}`)),
  );
}

/** Builds a restricted hosted policy only from a valid local policy document. */
export function parseHostedPolicy(
  text: string,
  escrow: string,
  owner: string,
  treasury: string,
) {
  const message =
    "The hosted custody policy is invalid. No wallet was registered or policy signed.";
  const value = jsonObject(text, message);
  const rules = value.rules;
  if (
    !isObject(rules) ||
    !Array.isArray(rules.transaction_types) ||
    !rules.transaction_types.every((type) => typeof type === "string") ||
    !isObject(rules.addresses) ||
    !Array.isArray(rules.addresses.list) ||
    !rules.addresses.list.every((address) => typeof address === "string") ||
    !isObject(value.capabilities)
  )
    throw new PublicError(message);
  rules.transaction_types = ["call", "transfer"];
  rules.addresses.list = [...new Set([escrow, BOARD, owner, treasury])];
  value.capabilities.sign_message = {
    allowed: true,
    allowed_recipients: [RELAY_RECIPIENT],
  };
  try {
    assertPolicy({ ...value, policy: "stored", frozen: false }, escrow, {
      owner,
      treasury,
    });
  } catch {
    throw new PublicError(message);
  }
  return value;
}

function readPolicyText(read: () => string): string {
  try {
    return read();
  } catch {
    throw new PublicError(
      "The hosted custody policy could not be read. No wallet was registered or policy signed.",
    );
  }
}

/** The whole policy, from the same limits as every other wallet in this project. */
export function hostedPolicy(escrow: string, owner: string, treasury: string) {
  return parseHostedPolicy(
    readPolicyText(() =>
      readFileSync(`${ROOT}agent/custody-policy.json`, "utf8"),
    ),
    escrow,
    owner,
    treasury,
  );
}

export async function createHostedWallet(
  config: Config,
  owner: string,
  treasury: Account,
  readPolicy = () => readFileSync(`${ROOT}agent/custody-policy.json`, "utf8"),
): Promise<{ wallet: string; wallet_id: string; custody_key: string }> {
  // Validate before registration, which creates external state even before policy storage.
  const policy = parseHostedPolicy(
    readPolicyText(readPolicy),
    config.escrow,
    owner,
    treasury.accountId,
  );
  const outlayer = config.custodyApi.includes("testnet")
    ? "outlayer.testnet"
    : "outlayer.near";
  const made = await post(config.custodyApi, "/register", {});
  if (
    typeof made.api_key !== "string" ||
    made.api_key.trim().length === 0 ||
    typeof made.wallet_id !== "string" ||
    made.wallet_id.trim().length === 0 ||
    typeof made.near_account_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(made.near_account_id)
  )
    throw new PublicError("OutLayer gave an unexpected registration.");
  const key = made.api_key;
  const encrypted = await post(
    config.custodyApi,
    "/wallet/v1/encrypt-policy",
    { wallet_id: made.wallet_id, ...policy },
    key,
  );
  if (
    typeof encrypted.encrypted_base64 !== "string" ||
    encrypted.encrypted_base64.length === 0 ||
    Buffer.from(encrypted.encrypted_base64, "base64").toString("base64") !==
      encrypted.encrypted_base64
  )
    throw new PublicError(
      "OutLayer returned an invalid encrypted policy. No policy storage was signed.",
    );
  const signed = await post(
    config.custodyApi,
    "/wallet/v1/sign-policy",
    { encrypted_data: encrypted.encrypted_base64, caller: treasury.accountId },
    key,
  );
  const uint64 = (value: unknown) =>
    ((typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === "string" && /^\d+$/.test(value))) &&
    BigInt(value as string | number) <= 18446744073709551615n;
  const metadataValid =
    signed.version === undefined
      ? signed.locked === undefined && signed.valid_until === undefined
      : uint64(signed.version) &&
        typeof signed.locked === "boolean" &&
        (signed.valid_until === null || uint64(signed.valid_until));
  if (
    typeof signed.public_key_hex !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(signed.public_key_hex) ||
    typeof signed.signature_hex !== "string" ||
    !/^[a-fA-F0-9]{128}$/.test(signed.signature_hex) ||
    !metadataValid
  )
    throw new PublicError(
      "OutLayer returned an invalid policy signature. No policy storage was signed.",
    );
  const args = {
    wallet_pubkey: `ed25519:${signed.public_key_hex}`,
    encrypted_data: encrypted.encrypted_base64,
    storage_refund_to: null,
  };
  const quote = await treasury.provider.callFunction({
    contractId: outlayer,
    method: "estimate_wallet_policy_cost",
    args,
  });
  const cost =
    typeof quote === "string"
      ? quote
      : (quote as { required_deposit?: string }).required_deposit;
  if (!cost || !/^\d+$/.test(cost) || BigInt(cost) > MAX_POLICY_STORAGE)
    throw new PublicError("The policy storage quote is unknown or too high.");
  const stored = await treasury.callFunctionRaw({
    contractId: outlayer,
    methodName: "store_wallet_policy",
    args: {
      ...args,
      wallet_signature: signed.signature_hex,
      ...(signed.version === undefined
        ? {}
        : {
            version: signed.version,
            locked: signed.locked,
            valid_until: signed.valid_until,
          }),
    },
    deposit: cost,
    gas: 100_000_000_000_000n,
  });
  if (!(typeof stored.status === "object" && "SuccessValue" in stored.status))
    throw new PublicError("Storing the agent's policy failed.");
  await post(config.custodyApi, "/wallet/v1/invalidate-cache", {
    wallet_id: made.wallet_id,
  }).catch(() => undefined);
  assertPolicy(
    await custodyRead(config.custodyApi, key, "/wallet/v1/policy"),
    config.escrow,
    { owner, treasury: treasury.accountId },
  );
  return {
    wallet: made.near_account_id,
    wallet_id: made.wallet_id,
    custody_key: key,
  };
}

/** Sends NEAR from a hosted wallet, in steps the policy allows. The policy refuses any other receiver. */
export async function sendFromWallet(
  config: Config,
  custodyKey: string,
  to: string,
  yocto: bigint,
): Promise<string[]> {
  const hashes: string[] = [];
  let left = yocto;
  while (left > 0n) {
    const step = left > MAX_TRANSFER ? MAX_TRANSFER : left;
    let sent: Record<string, unknown>;
    try {
      sent = await post(
        config.custodyApi,
        "/wallet/v1/transfer",
        { to, amount: step.toString(), chain: "near" },
        custodyKey,
      );
    } catch {
      throw new PublicError(
        "The custody transfer outcome is unknown. Reconcile wallet history before retrying; no further transfer was sent.",
      );
    }
    const hash =
      sent.tx_hash ??
      sent.transaction_hash ??
      (isObject(sent.result) ? sent.result.tx_hash : undefined);
    if (typeof hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash))
      throw new PublicError(
        "Custody did not confirm the transfer with a valid transaction hash. Reconcile wallet history before retrying; no further transfer was sent.",
      );
    hashes.push(hash);
    left -= step;
  }
  return hashes;
}
