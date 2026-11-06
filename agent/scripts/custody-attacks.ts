// Testnet P7 probe: what a holder of a custody Bearer key can really do, sent raw so that only
// OutLayer's own enforcement can stop it, not this project's client checks. Prints no key.
// Anything that gets through only reaches the owner's accounts, and a call to a missing method
// returns its deposit. It never calls /wallet/v1/delete.
//   node scripts/custody-attacks.ts
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { ROOT } from "../src/config.ts";

const API = "https://testnet-api.outlayer.ai";
const OUTSIDE = "proven.testnet"; // The owner's account, which no wallet's policy allows.
const ESCROW = "escrow-v3.proven.testnet";
const MILLI = 10n ** 21n;
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const agentKey = env.PROVEN_AGENT_C_CUSTODY_KEY!;
const agentAccount = env.PROVEN_AGENT_C_ACCOUNT_ID!;
const buyerKey = env.PROVEN_BUYER_CUSTODY_KEY!;

const clean = (text: string) =>
  text.replace(/(wk_|sk-|ed25519:)[A-Za-z0-9_-]+/g, "<redacted>").slice(0, 240);

async function balance(account: string): Promise<bigint> {
  return BigInt((await provider.viewAccount({ accountId: account })).amount);
}

async function raw(key: string, path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "X-Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return { status: response.status, body: clean(await response.text()) };
}

const rows: Array<Record<string, unknown>> = [];
async function attack(id: string, run: () => Promise<unknown>) {
  const before = await balance(agentAccount);
  let result: unknown;
  try {
    result = await run();
  } catch (error) {
    result = { error: clean(String(error)) };
  }
  const row = {
    id,
    result,
    agent_balance_change_yocto: (
      (await balance(agentAccount)) - before
    ).toString(),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

const call = (receiver_id: string, method_name: string, deposit: bigint) => ({
  receiver_id,
  method_name,
  args: {},
  deposit: deposit.toString(),
  gas: "30000000000000",
});

await attack("call-outside-receiver-with-deposit", () =>
  raw(agentKey, "/wallet/v1/call", call(OUTSIDE, "no_such_method", MILLI)),
);
await attack("call-outside-receiver-no-deposit", () =>
  raw(agentKey, "/wallet/v1/call", call(OUTSIDE, "no_such_method", 0n)),
);
await attack("buyer-call-outside-receiver-no-deposit", () =>
  raw(buyerKey, "/wallet/v1/call", call(OUTSIDE, "no_such_method", 0n)),
);
await attack("plain-transfer", () =>
  raw(agentKey, "/wallet/v1/transfer", {
    to: OUTSIDE,
    amount: MILLI.toString(),
  }),
);
await attack("deposit-over-the-per-call-cap", () =>
  raw(
    agentKey,
    "/wallet/v1/call",
    call(ESCROW, "no_such_method", 110n * MILLI),
  ),
);
await attack("sign-message", () =>
  raw(agentKey, "/wallet/v1/sign-message", {
    message: "probe",
    recipient: OUTSIDE,
    nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  }),
);
await attack("swap-quote", () =>
  raw(agentKey, "/wallet/v1/intents/swap/quote", {
    token_in: "near",
    token_out: "usdc",
    amount_in: "1",
  }),
);

// Can a Bearer-key holder replace the policy from an account that is not its controller? The policy
// offered is the same strict one, so success would change who controls it, not what it allows.
await attack("policy-store-from-non-controller", async () => {
  const policy = JSON.parse(
    readFileSync(`${ROOT}agent/custody-policy.json`, "utf8"),
  ) as Record<string, unknown>;
  const stranger = new Account(
    env.WORKER_FAKE_ACCOUNT_ID!,
    provider,
    new KeyPairSigner(
      KeyPair.fromString(env.WORKER_FAKE_PRIVATE_KEY as `ed25519:${string}`),
    ),
  );
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  };
  const encrypted = await post("/wallet/v1/encrypt-policy", {
    wallet_id: env.PROVEN_AGENT_C_WALLET_ID,
    ...policy,
  });
  const signed = await post("/wallet/v1/sign-policy", {
    encrypted_data: encrypted.json.encrypted_base64,
    caller: stranger.accountId,
  });
  if (typeof signed.json.signature_hex !== "string")
    return { sign_policy_status: signed.status, refused_at: "sign-policy" };
  const outcome = await stranger.callFunctionRaw({
    contractId: "outlayer.testnet",
    methodName: "store_wallet_policy",
    args: {
      wallet_pubkey: `ed25519:${String(signed.json.public_key_hex)}`,
      encrypted_data: encrypted.json.encrypted_base64,
      storage_refund_to: null,
      wallet_signature: signed.json.signature_hex,
    },
    deposit: 50n * MILLI,
    gas: 100000000000000n,
  });
  const onchain = (await provider.callFunction({
    contractId: "outlayer.testnet",
    method: "get_wallet_policy",
    args: { wallet_pubkey: `ed25519:${agentAccount}` },
  })) as { owner?: string } | null;
  const failed =
    typeof outcome.status === "object" && "Failure" in outcome.status;
  return {
    sign_policy_status: signed.status,
    transaction_hash: outcome.transaction.hash,
    failed_on_chain: failed,
    controller_after: onchain?.owner,
  };
});

writeFileSync(
  `${ROOT}runs/p7-custody-attacks.json`,
  `${JSON.stringify({ at: new Date().toISOString(), wallet: agentAccount, rows }, null, 2)}\n`,
);
