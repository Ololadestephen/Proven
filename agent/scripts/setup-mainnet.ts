// Stage 2 mainnet setup, for an unaudited, owner-funded mainnet deployment. Run only after the mainnet
// gate in PLAN.md section 14 has passed, with PROVEN_STAGE2_APPROVED=yes. It uses only the new Proven
// accounts the owner created and funded, and never spends past the budget below.
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-mainnet.ts accounts
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-mainnet.ts escrow <wasm>
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-mainnet.ts wallet
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-mainnet.ts workers
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-mainnet.ts verify-config
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-mainnet.ts upgrade <wasm>
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-mainnet.ts board <wasm>
// Add --dry-run to read the chain and print the writes without sending any.
// Each one-time step is recorded before it runs, and an unknown outcome stops rather than repeats.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import { ROOT } from "../src/config.ts";
import { assertPolicy, custodyRead } from "../src/custody.ts";
import { PublicError, publicMessage } from "../src/errors.ts";
import { networkSettings } from "../src/network.ts";

const MAX_JOB = 10n ** 23n; // 0.1 NEAR, enforced by the contract.
const MAX_HELD = 10n ** 24n; // 1 NEAR, enforced by the contract.
const MAX_HELD_PER_BUYER = 2n * 10n ** 23n; // 0.2 NEAR, enforced by the contract.
const BUDGET = 66n * 10n ** 23n; // The owner's limit: stop above 6.6 NEAR across the new accounts.
const YOCTO_PER_BYTE = 10n ** 19n;
const STATE_ROOM_BYTES = 10_000n; // Room for the contract's records on top of its code.
const MAX_POLICY_STORAGE = 5n * 10n ** 22n;
const WORKER_KEY_ALLOWANCE = 2n * 10n ** 22n;
/** Deploy and init stay in one transaction, so nobody can initialise the contract between them. NEAR
 * holds back attached gas at a pessimistic price, so 100 Tgas left the balance short of storage. */
const INIT_GAS = 12_000_000_000_000n;
const WORKER_METHODS = [
  "deliver",
  "release",
  "refund",
  "expire",
  "cancel_stale_outlayer_execution",
];

const net = networkSettings(
  process.env.NEAR_NETWORK,
  process.env.PROVEN_STAGE2_APPROVED,
);
if (net.network !== "mainnet")
  throw new PublicError("This script is for mainnet only.");
const envPath = `${ROOT}.env`;
const env: Record<string, string | undefined> = {
  ...parseEnv(readFileSync(envPath, "utf8")),
  ...process.env,
};
/** Reads the chain and prints every write it would make, and sends nothing. */
const dry = process.argv.includes("--dry-run");
const provider = new JsonRpcProvider({ url: net.rpcs[0] });
const evidencePath = `${ROOT}runs/stage2-setup.json`;
const evidence: Record<string, unknown> = existsSync(evidencePath)
  ? (JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>)
  : {};
const record = () =>
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });

function saveEnv(values: Record<string, string>) {
  let content = readFileSync(envPath, "utf8");
  for (const [name, value] of Object.entries(values)) {
    content = `${content.replace(new RegExp(`^${name}=.*$\\n?`, "m"), "").trimEnd()}\n${name}=${value}\n`;
    env[name] = value;
  }
  const temp = `${envPath}.proven-setup-${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  renameSync(temp, envPath);
}

function account(prefix: string): Account {
  const id = env[`${prefix}_ACCOUNT_ID`];
  const key = env[`${prefix}_PRIVATE_KEY`];
  if (!id?.endsWith(".near") || !key?.startsWith("ed25519:"))
    throw new PublicError(`${prefix} is not set up in .env.`);
  return new Account(
    id,
    provider,
    new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
  );
}

async function once(name: string, step: () => Promise<string>) {
  if (dry) {
    console.log(
      `would run: ${name}${evidence[name] ? " (already recorded)" : ""}`,
    );
    return;
  }
  if (evidence[name] === "started")
    throw new PublicError(`${name} has an unknown outcome. Inspect it first.`);
  if (evidence[name]) return;
  evidence[name] = "started";
  record();
  evidence[name] = await step();
  record();
  console.log(`${name}: ${String(evidence[name])}`);
}

const settled = (result: {
  status: unknown;
  transaction: { hash: string };
}) => {
  if (!(
    typeof result.status === "object" &&
    result.status &&
    "SuccessValue" in result.status
  ))
    throw new PublicError(`Transaction failed: ${result.transaction.hash}`);
  return result.transaction.hash;
};

async function balances() {
  let total = 0n;
  const rows: Record<string, string> = {};
  const ids = ["ESCROW", "OPS", "WORKER_A", "WORKER_B", "BUYER", "BOARD", "RELAY"]
    .map((prefix) => env[`MAINNET_${prefix}_ACCOUNT_ID`])
    .filter((id): id is string => Boolean(id));
  for (const id of ids) {
    const view = await provider
      .viewAccount({ accountId: id })
      .catch(() => null);
    const amount = view ? BigInt(view.amount) : 0n;
    total += amount;
    rows[id] = (Number(amount) / 1e24).toFixed(4);
  }
  console.log(
    JSON.stringify({ balances_near: rows, total_near: Number(total) / 1e24 }),
  );
  if (total > BUDGET)
    throw new PublicError("The accounts hold more than the approved budget.");
}

async function deployEscrow(wasmPath: string) {
  const ops = env.MAINNET_OPS_ACCOUNT_ID;
  const url = env.MAINNET_VERIFIER_URL;
  const hash = env.MAINNET_VERIFIER_HASH;
  if (dry) {
    const size = readFileSync(wasmPath).length;
    console.log(
      JSON.stringify({
        would_deploy: env.MAINNET_ESCROW_ACCOUNT_ID,
        code_bytes: size,
        storage_near: size / 100_000,
        owner: ops,
        secrets_owner: ops,
        outlayer: "outlayer.near",
        verifier_url: url,
        verifier_hash: hash,
        max_job_near: 0.1,
        max_held_near: 1,
      }),
    );
    return;
  }
  if (!ops || !url || !hash)
    throw new PublicError(
      "Publish the verifier first and set its URL and hash.",
    );
  const escrow = account("MAINNET_ESCROW");
  await once("escrow_deploy", async () =>
    settled(
      await escrow.signAndSendTransaction({
        receiverId: escrow.accountId,
        actions: [
          actions.deployContract(readFileSync(wasmPath)),
          actions.functionCall(
            "new",
            {
              owner: ops,
              outlayer: "outlayer.near",
              verifier_url: url,
              verifier_hash: hash,
              secrets_owner: ops,
              max_job_amount: MAX_JOB.toString(),
              max_held: MAX_HELD.toString(),
            },
            INIT_GAS,
            0n,
          ),
        ],
      }),
    ),
  );
}

async function post(path: string, body: unknown, key?: string) {
  const response = await fetch(`${net.custodyApi}${path}`, {
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
      `Custody request ${path} failed: ${response.status}.`,
    );
  return (await response.json()) as Record<string, unknown>;
}

async function setupWallet() {
  const escrow = env.MAINNET_ESCROW_ACCOUNT_ID;
  if (!escrow) throw new PublicError("MAINNET_ESCROW_ACCOUNT_ID is not set.");
  if (dry) {
    console.log(
      JSON.stringify({
        would_register: "a free custody wallet",
        would_store_policy: {
          receivers: [escrow],
          per_call_near: 0.1,
          daily_near: 1,
          sign_message_only_for: "proven-relay",
        },
        controller: env.MAINNET_OPS_ACCOUNT_ID,
      }),
    );
    return;
  }
  if (!env.MAINNET_BUYER_CUSTODY_KEY) {
    await once("buyer_registered", async () => {
      const wallet = await post("/register", {});
      if (
        typeof wallet.api_key !== "string" ||
        typeof wallet.wallet_id !== "string" ||
        typeof wallet.near_account_id !== "string"
      )
        throw new PublicError("Unexpected registration fields; not printed.");
      saveEnv({
        MAINNET_BUYER_CUSTODY_KEY: wallet.api_key,
        MAINNET_BUYER_WALLET_ID: wallet.wallet_id,
        MAINNET_BUYER_ACCOUNT_ID: wallet.near_account_id,
      });
      return wallet.near_account_id;
    });
  }
  const key = env.MAINNET_BUYER_CUSTODY_KEY!;
  const stored = JSON.parse(
    readFileSync(`${ROOT}agent/custody-policy.json`, "utf8"),
  ) as {
    rules: { addresses: { list: string[] } };
    capabilities: Record<string, unknown>;
  };
  stored.rules.addresses.list = [escrow];
  stored.capabilities.sign_message = {
    allowed: true,
    allowed_recipients: ["proven-relay"],
  };
  await storeBuyerPolicy("buyer_policy", stored, key, escrow);
  console.log(
    `Fund this buyer wallet with 0.45 NEAR: ${env.MAINNET_BUYER_ACCOUNT_ID}`,
  );
}

async function storeBuyerPolicy(
  step: string,
  stored: Record<string, unknown>,
  key: string,
  escrow: string,
) {
  await once(step, async () => {
    const owner = account("MAINNET_OPS");
    const encrypted = await post(
      "/wallet/v1/encrypt-policy",
      { wallet_id: env.MAINNET_BUYER_WALLET_ID, ...stored },
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
      contractId: "outlayer.near",
      method: "estimate_wallet_policy_cost",
      args,
    });
    const cost =
      typeof quote === "string"
        ? quote
        : (quote as { required_deposit?: string }).required_deposit;
    if (!cost || BigInt(cost) > MAX_POLICY_STORAGE)
      throw new PublicError("The policy storage quote is unknown or too high.");
    const hash = settled(
      await owner.callFunctionRaw({
        contractId: "outlayer.near",
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
        gas: 100_000_000_000_000n,
      }),
    );
    await post("/wallet/v1/invalidate-cache", {
      wallet_id: env.MAINNET_BUYER_WALLET_ID,
    });
    assertPolicy(
      await custodyRead(net.custodyApi, key, "/wallet/v1/policy"),
      escrow,
    );
    return hash;
  });
}

/** Pause, new code and its migration, new verifier, then unpause, in that order. Stops at the first failure,
 * which leaves the escrow paused: refunds, deliveries and payouts keep working while paused. */
async function upgradeEscrow(wasmPath: string) {
  const id = env.MAINNET_ESCROW_ACCOUNT_ID;
  const hash = env.MAINNET_VERIFIER_HASH;
  const url = env.MAINNET_VERIFIER_URL;
  if (!id || !wasmPath) throw new PublicError("Name the escrow and its wasm.");
  if (!url || !hash)
    throw new PublicError("Publish the verifier first and set its URL and hash.");
  const code = readFileSync(wasmPath);
  const config = (await provider.callFunction({
    contractId: id,
    method: "get_config",
    args: {},
  })) as {
    owner: string;
    caps: Array<{ token: string | null; held: string }>;
    verifier_hash: string;
    paused: boolean;
  };
  if (config.owner !== env.MAINNET_OPS_ACCOUNT_ID)
    throw new PublicError("The escrow's owner is not the ops account.");
  if (config.caps.some((cap) => BigInt(cap.held) !== 0n))
    throw new PublicError("The escrow holds money. Upgrade only when it holds none.");
  const view = await provider.viewAccount({ accountId: id });
  const needed = (BigInt(code.length) + STATE_ROOM_BYTES) * YOCTO_PER_BYTE;
  const short = needed - BigInt(view.amount);
  if (dry)
    console.log(
      JSON.stringify({
        escrow: id,
        current_code_hash: view.code_hash,
        current_verifier: config.verifier_hash,
        new_code_bytes: code.length,
        balance_near: Number(view.amount) / 1e24,
        needs_near_for_storage: Number(needed) / 1e24,
        add_near_first: short > 0n ? Number(short) / 1e24 : 0,
        writes_in_order: [
          "set_paused true (ops)",
          `deploy and migrate in one transaction (escrow), max_held_per_buyer ${MAX_HELD_PER_BUYER}`,
          `set_verifier ${hash} (ops)`,
          "set_paused false (ops)",
        ],
      }),
    );
  else if (short > 0n)
    throw new PublicError("The escrow needs more NEAR for its new code.");
  const ops = dry ? null : account("MAINNET_OPS");
  const escrow = dry ? null : account("MAINNET_ESCROW");
  const owner = (method: string, args: Record<string, unknown>) =>
    ops!.callFunctionRaw({
      contractId: id,
      methodName: method,
      args,
      gas: 30_000_000_000_000n,
    });
  await once("upgrade_pause", async () =>
    settled(await owner("set_paused", { paused: true })),
  );
  await once("upgrade_code", async () =>
    settled(
      await escrow!.signAndSendTransaction({
        receiverId: id,
        actions: [
          actions.deployContract(code),
          actions.functionCall(
            "migrate",
            { max_held_per_buyer: MAX_HELD_PER_BUYER.toString() },
            // Attached gas is held at a high price, and 100 Tgas left the new code 0.0355 NEAR short.
            40_000_000_000_000n,
            0n,
          ),
        ],
      }),
    ),
  );
  await once("upgrade_verifier", async () =>
    settled(
      await owner("set_verifier", { verifier_url: url, verifier_hash: hash }),
    ),
  );
  await once("upgrade_unpause", async () =>
    settled(await owner("set_paused", { paused: false })),
  );
}

/** A new board, deployed and initialised in one transaction, then the buyer wallet may call it. */
async function deployBoard(wasmPath: string) {
  const id = env.MAINNET_BOARD_ACCOUNT_ID;
  const escrowId = env.MAINNET_ESCROW_ACCOUNT_ID;
  const reviewer = env.MAINNET_RELAY_ACCOUNT_ID;
  if (!wasmPath || !escrowId) throw new PublicError("Name the wasm and escrow.");
  const code = readFileSync(wasmPath);
  const needed = (BigInt(code.length) + STATE_ROOM_BYTES) * YOCTO_PER_BYTE;
  if (dry) {
    const view = id
      ? await provider.viewAccount({ accountId: id }).catch(() => null)
      : null;
    console.log(
      JSON.stringify({
        would_deploy: id ?? "the owner has not set MAINNET_BOARD_ACCOUNT_ID",
        account_exists: Boolean(view),
        balance_near: view ? Number(view.amount) / 1e24 : 0,
        code_bytes: code.length,
        needs_near_for_storage: Number(needed) / 1e24,
        escrow: escrowId,
        reviewer: reviewer ?? "the owner has not set MAINNET_RELAY_ACCOUNT_ID",
        then: "add the board to the buyer wallet's policy",
      }),
    );
    return;
  }
  if (!id || !reviewer)
    throw new PublicError("Set the board and relay accounts in .env first.");
  const board = account("MAINNET_BOARD");
  const view = await provider.viewAccount({ accountId: id });
  if (BigInt(view.amount) < needed)
    throw new PublicError("The board needs more NEAR for its code.");
  await once("board_deploy", async () =>
    settled(
      await board.signAndSendTransaction({
        receiverId: id,
        actions: [
          actions.deployContract(code),
          actions.functionCall(
            "new",
            { escrow: escrowId, reviewer },
            INIT_GAS,
            0n,
          ),
        ],
      }),
    ),
  );
  const stored = JSON.parse(
    readFileSync(`${ROOT}agent/custody-policy.json`, "utf8"),
  ) as {
    rules: { addresses: { list: string[] } };
    capabilities: Record<string, unknown>;
  };
  stored.rules.addresses.list = [escrowId, id];
  stored.capabilities.sign_message = {
    allowed: true,
    allowed_recipients: ["proven-relay"],
  };
  await storeBuyerPolicy(
    "buyer_policy_board",
    stored,
    env.MAINNET_BUYER_CUSTODY_KEY!,
    escrowId,
  );
}

/** Workers sign with keys that can only call the worker's methods on the escrow, never full-access. */
async function setupWorkers() {
  const escrow = env.MAINNET_ESCROW_ACCOUNT_ID;
  if (!escrow) throw new PublicError("MAINNET_ESCROW_ACCOUNT_ID is not set.");
  if (dry) {
    console.log(
      JSON.stringify({
        would_add_keys_on: [
          env.MAINNET_WORKER_A_ACCOUNT_ID,
          env.MAINNET_WORKER_B_ACCOUNT_ID,
        ],
        receiver: escrow,
        methods: WORKER_METHODS,
        allowance_near: 0.02,
      }),
    );
    return;
  }
  for (const letter of ["A", "B"]) {
    const worker = account(`MAINNET_WORKER_${letter}`);
    const name = `MAINNET_WORKER_${letter}_SCOPED_PRIVATE_KEY`;
    if (!env[name])
      saveEnv({ [name]: KeyPair.fromRandom("ed25519").toString() });
    saveEnv({
      [`MAINNET_WORKER_${letter}_SCOPED_ACCOUNT_ID`]: worker.accountId,
    });
    const key = KeyPair.fromString(env[name] as `ed25519:${string}`);
    await once(`worker_${letter}_key`, async () =>
      settled(
        await worker.signAndSendTransaction({
          receiverId: worker.accountId,
          actions: [
            actions.addFunctionCallAccessKey(
              key.getPublicKey(),
              escrow,
              WORKER_METHODS,
              WORKER_KEY_ALLOWANCE,
            ),
          ],
        }),
      ),
    );
  }
}

async function main() {
  const [command, argument] = process.argv
    .slice(2)
    .filter((arg) => arg !== "--dry-run");
  await balances();
  if (command === "accounts") return;
  if (command === "escrow") return deployEscrow(argument);
  if (command === "wallet") return setupWallet();
  if (command === "workers") return setupWorkers();
  if (command === "upgrade") return upgradeEscrow(argument);
  if (command === "board") return deployBoard(argument);
  if (command === "verify-config") {
    if (dry) {
      console.log("would read get_config from the escrow");
      return;
    }
    const config = await provider.callFunction({
      contractId: env.MAINNET_ESCROW_ACCOUNT_ID!,
      method: "get_config",
      args: {},
    });
    console.log(JSON.stringify(config));
    return;
  }
  throw new PublicError("Unknown command.");
}

main().catch((error) => {
  console.error(publicMessage(error));
  process.exitCode = 1;
});
