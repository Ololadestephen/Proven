// Owner-only setup for the swarm work on testnet. Never imported by the agent or the MCP server.
// It registers agent custody wallets, stores the board-and-escrow policy on them and on the
// buyer's wallet, funds the agents, and installs a key that can only record reviews on the board.
// Each step is recorded before it runs, and an unknown outcome stops the script rather than repeating.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import {
  BOARD,
  RELAY_RECIPIENT,
  assertPolicy,
  custodyRead,
} from "../src/custody.ts";
import { ROOT } from "../src/config.ts";
import { PublicError, publicMessage } from "../src/errors.ts";

const API = "https://testnet-api.outlayer.ai";
const ESCROW = "escrow-v3.proven.testnet";
const FUNDING = 400000000000000000000000n; // 0.4 NEAR for each agent wallet.
const MAX_POLICY_STORAGE = 50000000000000000000000n; // 0.05 NEAR.
const REVIEW_KEY_ALLOWANCE = 250000000000000000000000n; // 0.25 NEAR of gas.

const envPath = `${ROOT}.env`;
const evidencePath = `${ROOT}runs/swarm-setup.json`;
const env = parseEnv(readFileSync(envPath, "utf8"));
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const evidence: Record<string, unknown> = existsSync(evidencePath)
  ? JSON.parse(readFileSync(evidencePath, "utf8"))
  : {};
const record = () =>
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });

function save(values: Record<string, string>) {
  let content = readFileSync(envPath, "utf8");
  for (const [name, value] of Object.entries(values)) {
    content = `${content.replace(new RegExp(`^${name}=.*$\\n?`, "m"), "").trimEnd()}\n${name}=${value}\n`;
    env[name] = value;
  }
  const temp = `${envPath}.proven-setup-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  renameSync(temp, envPath);
}

function controller(): Account {
  const id = env.NEAR_ACCOUNT_ID;
  const key = env.NEAR_PRIVATE_KEY;
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
      `Custody setup request ${path} failed with ${response.status}.`,
    );
  return (await response.json()) as Record<string, unknown>;
}

/** Runs a one-time step once. A step that started and never recorded a finish needs a person. */
async function once(name: string, step: () => Promise<string>): Promise<void> {
  if (evidence[name] === "started")
    throw new PublicError(
      `${name} has an unknown outcome. Inspect it before retrying.`,
    );
  if (evidence[name]) return;
  evidence[name] = "started";
  record();
  evidence[name] = await step();
  record();
  console.log(`${name}: ${String(evidence[name])}`);
}

async function storePolicy(
  walletId: string,
  key: string,
  account: string,
  capabilities: Record<string, unknown> = {},
  dailyNative?: string,
): Promise<string> {
  const stored = JSON.parse(
    readFileSync(`${ROOT}agent/custody-policy.json`, "utf8"),
  ) as {
    capabilities: Record<string, unknown>;
    rules: { limits: { daily: { native: string } } };
  };
  if (dailyNative) stored.rules.limits.daily.native = dailyNative;
  const policy = {
    ...stored,
    capabilities: { ...stored.capabilities, ...capabilities },
  };
  const owner = controller();
  const encrypted = await post(
    "/wallet/v1/encrypt-policy",
    { wallet_id: walletId, ...policy },
    key,
  );
  const signed = await post(
    "/wallet/v1/sign-policy",
    { encrypted_data: encrypted.encrypted_base64, caller: owner.accountId },
    key,
  );
  const args = {
    wallet_pubkey: `ed25519:${String(signed.public_key_hex)}`,
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
  if (!cost || !/^\d+$/.test(cost) || BigInt(cost) > MAX_POLICY_STORAGE)
    throw new PublicError("The policy storage quote is unknown or too high.");
  const result = await owner.callFunctionRaw({
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
    throw new PublicError("Storing the policy failed.");
  await post("/wallet/v1/invalidate-cache", { wallet_id: walletId });
  assertPolicy(await custodyRead(API, key, "/wallet/v1/policy"), ESCROW);
  const onchain = (await provider.callFunction({
    contractId: "outlayer.testnet",
    method: "get_wallet_policy",
    args: { wallet_pubkey: `ed25519:${account}` },
  })) as { owner?: string; frozen?: boolean } | null;
  if (onchain?.owner !== owner.accountId || onchain.frozen !== false)
    throw new PublicError("The on-chain policy controller is not the owner.");
  return result.transaction.hash;
}

async function agent(letter: "A" | "B" | "C") {
  const prefix = `PROVEN_AGENT_${letter}`;
  if (!env[`${prefix}_CUSTODY_KEY`]) {
    await once(`agent_${letter}_registered`, async () => {
      const wallet = await post("/register", {});
      if (
        typeof wallet.api_key !== "string" ||
        typeof wallet.wallet_id !== "string" ||
        typeof wallet.near_account_id !== "string" ||
        !/^[a-f0-9]{64}$/.test(wallet.near_account_id)
      )
        throw new PublicError(
          "Unexpected registration fields; the response was not printed.",
        );
      save({
        [`${prefix}_CUSTODY_KEY`]: wallet.api_key,
        [`${prefix}_WALLET_ID`]: wallet.wallet_id,
        [`${prefix}_ACCOUNT_ID`]: wallet.near_account_id,
      });
      return wallet.near_account_id;
    });
  }
  const key = env[`${prefix}_CUSTODY_KEY`]!;
  const account = env[`${prefix}_ACCOUNT_ID`]!;
  await once(`agent_${letter}_policy`, () =>
    storePolicy(env[`${prefix}_WALLET_ID`]!, key, account),
  );
  await once(`agent_${letter}_funding`, async () => {
    const result = await controller().signAndSendTransaction({
      receiverId: account,
      actions: [actions.transfer(FUNDING)],
    });
    if (!(typeof result.status === "object" && "SuccessValue" in result.status))
      throw new PublicError("Funding did not settle.");
    return result.transaction.hash;
  });
}

async function reviewerKey() {
  if (!env.PROVEN_REVIEWER_PRIVATE_KEY)
    save({
      PROVEN_REVIEWER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
    });
  const key = KeyPair.fromString(
    env.PROVEN_REVIEWER_PRIVATE_KEY as `ed25519:${string}`,
  );
  await once("reviewer_key", async () => {
    const result = await controller().signAndSendTransaction({
      receiverId: controller().accountId,
      actions: [
        actions.addFunctionCallAccessKey(
          key.getPublicKey(),
          BOARD,
          ["record_review"],
          REVIEW_KEY_ALLOWANCE,
        ),
      ],
    });
    if (!(typeof result.status === "object" && "SuccessValue" in result.status))
      throw new PublicError("Installing the reviewer key failed.");
    return result.transaction.hash;
  });
}

/** Testnet agent wallets may sign for the relay and nothing else, so they can reach a hosted relay. */
async function agentsSignForRelay() {
  for (const letter of ["A", "B", "C"]) {
    const prefix = `PROVEN_AGENT_${letter}`;
    await once(`agent_${letter}_relay_signing`, () =>
      storePolicy(
        env[`${prefix}_WALLET_ID`]!,
        env[`${prefix}_CUSTODY_KEY`]!,
        env[`${prefix}_ACCOUNT_ID`]!,
        {
          sign_message: {
            allowed: true,
            allowed_recipients: [RELAY_RECIPIENT],
          },
        },
      ),
    );
  }
}

/** The owner's decision for the gate runs: testnet buyer only, with the per-call limit unchanged. */
async function raiseTestnetBuyerDaily() {
  await once("testnet_buyer_daily_3_near", () =>
    storePolicy(
      env.PROVEN_BUYER_WALLET_ID!,
      env.PROVEN_BUYER_CUSTODY_KEY!,
      env.PROVEN_BUYER_ACCOUNT_ID!,
      {
        sign_message: { allowed: true, allowed_recipients: [RELAY_RECIPIENT] },
      },
      (3n * 10n ** 24n).toString(),
    ),
  );
}

/** Moves existing wallets and the review key to the new escrow and board. Run after those deploy. */
async function moveToNewContracts() {
  await once("v3_buyer_policy", () =>
    storePolicy(
      env.PROVEN_BUYER_WALLET_ID!,
      env.PROVEN_BUYER_CUSTODY_KEY!,
      env.PROVEN_BUYER_ACCOUNT_ID!,
    ),
  );
  for (const letter of ["A", "B", "C"]) {
    const prefix = `PROVEN_AGENT_${letter}`;
    await once(`v3_agent_${letter}_policy`, () =>
      storePolicy(
        env[`${prefix}_WALLET_ID`]!,
        env[`${prefix}_CUSTODY_KEY`]!,
        env[`${prefix}_ACCOUNT_ID`]!,
      ),
    );
  }
  await once("v3_buyer_collect_policy", () =>
    storePolicy(
      env.PROVEN_BUYER_WALLET_ID!,
      env.PROVEN_BUYER_CUSTODY_KEY!,
      env.PROVEN_BUYER_ACCOUNT_ID!,
      {
        sign_message: { allowed: true, allowed_recipients: [RELAY_RECIPIENT] },
      },
    ),
  );
  await once("v3_reviewer_key", async () => {
    if (!env.PROVEN_REVIEWER_V2_PRIVATE_KEY)
      save({
        PROVEN_REVIEWER_V2_PRIVATE_KEY:
          KeyPair.fromRandom("ed25519").toString(),
      });
    const key = KeyPair.fromString(
      env.PROVEN_REVIEWER_V2_PRIVATE_KEY as `ed25519:${string}`,
    );
    const owner = controller();
    const result = await owner.signAndSendTransaction({
      receiverId: owner.accountId,
      actions: [
        actions.addFunctionCallAccessKey(
          key.getPublicKey(),
          BOARD,
          ["record_review"],
          REVIEW_KEY_ALLOWANCE,
        ),
      ],
    });
    if (!(typeof result.status === "object" && "SuccessValue" in result.status))
      throw new PublicError("Installing the reviewer key failed.");
    return result.transaction.hash;
  });
}

async function main() {
  if (
    env.NEAR_NETWORK !== "testnet" ||
    process.argv[2] !== "--approved-testnet-setup"
  )
    throw new PublicError("The owner-approved testnet setup flag is required.");
  if (process.argv[3] === "--move-to-new-contracts")
    return moveToNewContracts();
  if (process.argv[3] === "--agents-sign-for-relay")
    return agentsSignForRelay();
  if (process.argv[3] === "--raise-testnet-buyer-daily")
    return raiseTestnetBuyerDaily();
  await once("buyer_policy", () =>
    storePolicy(
      env.PROVEN_BUYER_WALLET_ID!,
      env.PROVEN_BUYER_CUSTODY_KEY!,
      env.PROVEN_BUYER_ACCOUNT_ID!,
    ),
  );
  await agent("A");
  await agent("B");
  // C runs a deliberately poor prompt, labelled as such, to see a real failed attempt reopen a bid.
  await agent("C");
  await reviewerKey();
}

main().catch((error) => {
  console.error(
    publicMessage(error),
    String(error)
      .replace(/(ed25519:|wk_|sk-)[A-Za-z0-9_-]+/g, "<redacted>")
      .slice(0, 300),
  );
  process.exitCode = 1;
});
