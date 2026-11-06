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
  return (await response.json()) as Record<string, unknown>;
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

/** The whole policy, from the same limits as every other wallet in this project. */
export function hostedPolicy(escrow: string, owner: string, treasury: string) {
  const base = JSON.parse(
    readFileSync(`${ROOT}agent/custody-policy.json`, "utf8"),
  ) as {
    rules: {
      transaction_types: string[];
      addresses: { list: string[] };
    };
    capabilities: Record<string, unknown>;
  };
  base.rules.transaction_types = ["call", "transfer"];
  base.rules.addresses.list = [...new Set([escrow, BOARD, owner, treasury])];
  base.capabilities.sign_message = {
    allowed: true,
    allowed_recipients: [RELAY_RECIPIENT],
  };
  return base;
}

export async function createHostedWallet(
  config: Config,
  owner: string,
  treasury: Account,
): Promise<{ wallet: string; wallet_id: string; custody_key: string }> {
  const outlayer = config.custodyApi.includes("testnet")
    ? "outlayer.testnet"
    : "outlayer.near";
  const made = await post(config.custodyApi, "/register", {});
  if (
    typeof made.api_key !== "string" ||
    typeof made.wallet_id !== "string" ||
    typeof made.near_account_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(made.near_account_id)
  )
    throw new PublicError("OutLayer gave an unexpected registration.");
  const key = made.api_key;
  const policy = hostedPolicy(config.escrow, owner, treasury.accountId);
  const encrypted = await post(
    config.custodyApi,
    "/wallet/v1/encrypt-policy",
    { wallet_id: made.wallet_id, ...policy },
    key,
  );
  const signed = await post(
    config.custodyApi,
    "/wallet/v1/sign-policy",
    { encrypted_data: encrypted.encrypted_base64, caller: treasury.accountId },
    key,
  );
  const args = {
    wallet_pubkey: `ed25519:${String(signed.public_key_hex)}`,
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
    const sent = await post(
      config.custodyApi,
      "/wallet/v1/transfer",
      { to, amount: step.toString(), chain: "near" },
      custodyKey,
    );
    hashes.push(
      String(sent.tx_hash ?? sent.transaction_hash ?? sent.request_id ?? ""),
    );
    left -= step;
  }
  return hashes;
}
