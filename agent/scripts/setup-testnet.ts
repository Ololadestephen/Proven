// Owner-only setup. This file is never imported by the agent/MCP server.
// Registration/funding require the explicit owner approval recorded in TASKS.md.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import { assertPolicy, custodyRead } from "../src/custody.ts";
import { PublicError, publicMessage } from "../src/errors.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const envPath = `${root}.env`;
const env = parseEnv(readFileSync(envPath, "utf8"));
const API = "https://testnet-api.outlayer.ai";
const ESCROW = "escrow-v2.proven.testnet";
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const evidencePath = `${root}runs/p4-custody-setup.json`;
const evidence: Record<string, unknown> = {};
function record() {
  mkdirSync(`${root}runs`, { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", {
    mode: 0o600,
  });
}
function save(values: Record<string, string>) {
  let content = readFileSync(envPath, "utf8");
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z_]+$/.test(name) || /[\r\n]/.test(value))
      throw new PublicError("Invalid setup credential format.");
    content = content.replace(new RegExp(`^${name}=.*$`, "m"), "").trimEnd();
    content += `\n${name}=${value}\n`;
    env[name] = value;
  }
  const temp = `${envPath}.proven-setup-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  renameSync(temp, envPath);
}
function owner(prefix: string): Account {
  const id = env[`${prefix}_ACCOUNT_ID`],
    key = env[`${prefix}_PRIVATE_KEY`];
  if (!id?.endsWith(".testnet") || !key?.startsWith("ed25519:"))
    throw new PublicError("Owner testnet credentials are missing.");
  return new Account(
    id,
    provider,
    new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
  );
}
async function post(
  path: string,
  body: unknown,
  key?: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new PublicError(
      "Testnet custody setup request failed. Credentials and upstream response were not logged.",
    );
  return (await response.json()) as Record<string, unknown>;
}
async function workers() {
  const methods = [
    "deliver",
    "release",
    "refund",
    "expire",
    "cancel_stale_outlayer_execution",
  ];
  for (const role of ["HONEST", "FAKE"]) {
    const source = `WORKER_${role}`,
      target = `PROVEN_${role}`;
    const account = owner(source);
    if (!env[`${target}_PRIVATE_KEY`])
      save({
        [`${target}_ACCOUNT_ID`]: account.accountId,
        [`${target}_PRIVATE_KEY`]: KeyPair.fromRandom("ed25519").toString(),
      });
    const key = KeyPair.fromString(
      env[`${target}_PRIVATE_KEY`] as `ed25519:${string}`,
    );
    const existing = (await account.getAccessKeyList()).keys.find(
      (k) => k.public_key === key.getPublicKey().toString(),
    );
    if (existing) {
      const p = existing.access_key.permission;
      if (
        p === "FullAccess" ||
        p.FunctionCall.receiver_id !== ESCROW ||
        p.FunctionCall.method_names.length !== methods.length ||
        p.FunctionCall.method_names.some((m) => !methods.includes(m))
      )
        throw new PublicError(
          "Existing agent worker key is not properly scoped.",
        );
      if (
        p.FunctionCall.allowance &&
        BigInt(p.FunctionCall.allowance) >= 150000000000000000000000n
      )
        continue;
    }
    const result = await account.signAndSendTransaction({
      receiverId: account.accountId,
      actions: [
        ...(existing ? [actions.deleteKey(key.getPublicKey())] : []),
        actions.addFunctionCallAccessKey(
          key.getPublicKey(),
          ESCROW,
          methods,
          200000000000000000000000n,
        ),
      ],
    });
    if (!(typeof result.status === "object" && "SuccessValue" in result.status))
      throw new PublicError(
        "Scoped worker key installation failed. Setup is incomplete.",
      );
    const installed = await account.getAccessKey(key.getPublicKey());
    if (
      installed.permission === "FullAccess" ||
      installed.permission.FunctionCall.receiver_id !== ESCROW ||
      installed.permission.FunctionCall.method_names.length !==
        methods.length ||
      installed.permission.FunctionCall.method_names.some(
        (m) => !methods.includes(m),
      )
    )
      throw new PublicError(
        "Installed worker key scope does not match the expected permissions.",
      );
    evidence[`${role.toLowerCase()}_scoped_key_transaction`] =
      result.transaction.hash;
    record();
  }
}
async function main() {
  if (
    env.NEAR_NETWORK !== "testnet" ||
    process.argv[2] !== "--approved-testnet-setup"
  )
    throw new PublicError("Owner-approved testnet setup flag is required.");
  if (existsSync(evidencePath)) {
    try {
      const saved: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved))
        throw new Error("invalid checkpoint");
      Object.assign(evidence, saved);
    } catch {
      throw new PublicError(
        "Setup checkpoint is unreadable. Reconcile existing registration and funding before retrying.",
      );
    }
  }
  if (!env.PROVEN_BUYER_CUSTODY_KEY) {
    if (evidence.registration_started)
      throw new PublicError(
        "A prior registration has unknown outcome. Inspect it before creating another wallet.",
      );
    evidence.registration_started = new Date().toISOString();
    record();
    const wallet = await post("/register", {});
    if (
      typeof wallet.api_key !== "string" ||
      !/^wk_[A-Za-z0-9_-]+$/.test(wallet.api_key) ||
      typeof wallet.wallet_id !== "string" ||
      typeof wallet.near_account_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(wallet.near_account_id)
    )
      throw new PublicError(
        "Unexpected registration fields; response was not printed.",
      );
    save({
      PROVEN_BUYER_CUSTODY_KEY: wallet.api_key,
      PROVEN_BUYER_WALLET_ID: wallet.wallet_id,
      PROVEN_BUYER_ACCOUNT_ID: wallet.near_account_id,
    });
    evidence.wallet_id = wallet.wallet_id;
    evidence.account_id = wallet.near_account_id;
    record();
  }
  const key = env.PROVEN_BUYER_CUSTODY_KEY!;
  const address = (await custodyRead(
    API,
    key,
    "/wallet/v1/address?chain=near",
  )) as { address: string; asset_account_id?: string | null };
  if (
    address.address !== env.PROVEN_BUYER_ACCOUNT_ID ||
    address.asset_account_id
  )
    throw new PublicError("Unexpected custody account identity.");
  const policy = JSON.parse(
    readFileSync(`${root}agent/custody-policy.json`, "utf8"),
  );
  let current = (await custodyRead(API, key, "/wallet/v1/policy")) as {
    policy?: string;
    controller?: string;
  };
  if (current.policy !== "stored") {
    const controller = owner("NEAR");
    const encrypted = await post(
      "/wallet/v1/encrypt-policy",
      { wallet_id: env.PROVEN_BUYER_WALLET_ID, ...policy },
      key,
    );
    const signed = await post(
      "/wallet/v1/sign-policy",
      {
        encrypted_data: encrypted.encrypted_base64,
        caller: controller.accountId,
      },
      key,
    );
    if (
      typeof signed.public_key_hex !== "string" ||
      !/^[a-f0-9]{64}$/.test(signed.public_key_hex) ||
      typeof signed.signature_hex !== "string" ||
      typeof encrypted.encrypted_base64 !== "string"
    )
      throw new PublicError("Unexpected policy signature fields.");
    const args = {
      wallet_pubkey: `ed25519:${signed.public_key_hex}`,
      encrypted_data: encrypted.encrypted_base64,
      storage_refund_to: null,
    };
    const quote = await provider.callFunction({
      contractId: "outlayer.testnet",
      method: "estimate_wallet_policy_cost",
      args,
    });
    const cost =
      typeof quote === "string"
        ? quote
        : (quote as { required_deposit?: string }).required_deposit;
    if (!cost || !/^\d+$/.test(cost) || BigInt(cost) > 50000000000000000000000n)
      throw new PublicError(
        "Policy storage quote is unknown or above the approved 0.05 NEAR cap.",
      );
    const result = await controller.callFunctionRaw({
      contractId: "outlayer.testnet",
      methodName: "store_wallet_policy",
      args: {
        ...args,
        wallet_signature: signed.signature_hex,
        // Newer OutLayer contracts need these, exactly as the keystore signed them.
        ...(signed.version === undefined
          ? {}
          : {
              version: signed.version,
              locked: signed.locked,
              valid_until: signed.valid_until,
            }),
      },
      deposit: cost,
      gas: 100000000000000n,
    });
    if (!(typeof result.status === "object" && "SuccessValue" in result.status))
      throw new PublicError(
        "Policy storage did not succeed. Wallet was not funded.",
      );
    evidence.policy_transaction = result.transaction.hash;
    evidence.policy_storage_deposit = cost;
    record();
    await post("/wallet/v1/invalidate-cache", {
      wallet_id: env.PROVEN_BUYER_WALLET_ID,
    });
    current = (await custodyRead(
      API,
      key,
      "/wallet/v1/policy",
    )) as typeof current;
  }
  assertPolicy(current, ESCROW);
  // The live API reports the wallet public key in `controller`, despite its account-id schema.
  // Use the authoritative contract record to verify who can update/freeze/delete the policy.
  const onchain = (await provider.callFunction({
    contractId: "outlayer.testnet",
    method: "get_wallet_policy",
    args: { wallet_pubkey: `ed25519:${address.address}` },
  })) as { owner?: string; frozen?: boolean } | null;
  if (
    !onchain ||
    !env.NEAR_ACCOUNT_ID ||
    onchain.owner !== env.NEAR_ACCOUNT_ID ||
    onchain.frozen !== false
  )
    throw new PublicError(
      "On-chain policy controller must remain the owner's separate account.",
    );
  evidence.policy_controller = onchain.owner;
  evidence.policy_verified = true;
  record();
  if (!evidence.funding_transaction) {
    if (evidence.funding_started)
      throw new PublicError(
        "Prior funding has unknown outcome. Inspect it before retrying.",
      );
    evidence.funding_started = true;
    record();
    const result = await owner("BUYER").signAndSendTransaction({
      receiverId: address.address,
      actions: [actions.transfer(300000000000000000000000n)],
    });
    if (!(typeof result.status === "object" && "SuccessValue" in result.status))
      throw new PublicError("Custody funding did not settle successfully.");
    evidence.funding_transaction = result.transaction.hash;
    evidence.funding_amount = "300000000000000000000000";
    record();
  }
  await workers();
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch((error) => {
  console.error(publicMessage(error));
  process.exitCode = 1;
});
