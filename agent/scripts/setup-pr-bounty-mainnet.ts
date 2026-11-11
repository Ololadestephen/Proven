// PR bounty setup on mainnet, for an unaudited, owner-funded mainnet deployment. It uses only the
// new Proven accounts the owner created and funded, with keys the owner placed in .env:
// proven-ops.near (owner, publisher), proven-bounties.near (the contract) and proven-sponsor.near.
//
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/setup-pr-bounty-mainnet.ts <step> [--dry-run]
//
// Steps, in order: check, publish-verifier, publish-vault, deploy, fund-sponsor, read-back.
// `check` and every --dry-run read the chain and print what would be sent, and send nothing.
// Each write is journalled before it is sent; a step whose outcome is unknown stops the script
// rather than being repeated. The deploy key stays a single full-access key held by the owner.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import { ROOT } from "../src/config.ts";
import { PublicError, publicMessage } from "../src/errors.ts";
import { networkSettings } from "../src/network.ts";

const YOCTO = 10n ** 24n;
const MILLI = 10n ** 21n;
const TGAS = 10n ** 12n;
const YOCTO_PER_BYTE = 10n ** 19n;
const GLOBAL_MULTIPLIER = 10n;
/** Gas is held at this price when a transaction is signed (mainnet `min_gas_purchase_price`). */
const PURCHASE_PRICE = 10n ** 9n;
const MAX_GAS_PRICE = 10n ** 8n;

// The tested builds (commit b559380). Nothing else is ever sent.
const ARTIFACTS = {
  contract: [
    "contracts/pr-bounty/target/near/proven_pr_bounty.wasm",
    "305003584c1d87e9c01104fcd641e8186f8808b09cfddb90e63a0c5fdea79cbe",
  ],
  vault: [
    "contracts/vault/out/proven_vault.wasm",
    "f329be66e708007396f94691f871cb6b4fdd5ba9d29014ff53bde1a7b58c268d",
  ],
  verifier: [
    "pr-bounty-verifier/target/wasm32-wasip2/release/proven-pr-bounty-verifier.wasm",
    "7848be7da1912588fc708fca488f032422e5b4088a3ffea018becd9a3a5664f4",
  ],
} as const;

const OUTLAYER = "outlayer.near";
// The owner's launch settings (November 11), inside the RULES caps of 5 per job and 10 held.
const LAUNCH = {
  min_reward: 10n * MILLI,
  max_reward: 3n * YOCTO,
  max_held: 5n * YOCTO,
  max_open_per_buyer: 3,
  max_sponsor_float: 100n * MILLI,
  max_sponsor_spent: 500n * MILLI,
};
const FLOAT = 50n * MILLI;
/** Deploy and init are one transaction, so nobody can initialise the contract in between. */
const INIT_GAS = 30n * TGAS;
const STATE_ROOM = 2_000n; // bytes for the initial state and the access key, generous

const net = networkSettings(
  process.env.NEAR_NETWORK,
  process.env.PROVEN_STAGE2_APPROVED,
);
if (net.network !== "mainnet")
  throw new PublicError("This script is for mainnet only.");
const envPath = process.env.PROVEN_ENV_FILE ?? `${ROOT}.env`;
const env: Record<string, string | undefined> = {
  ...parseEnv(readFileSync(envPath, "utf8")),
  ...process.env,
};
const dry = process.argv.includes("--dry-run");
const provider = new JsonRpcProvider({ url: net.rpcs[0] });
const evidencePath =
  process.env.PROVEN_EVIDENCE_FILE ??
  `${ROOT}runs/pr-bounty-mainnet-setup.json`;
const evidence: Record<string, unknown> = existsSync(evidencePath)
  ? (JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>)
  : {};
const record = () =>
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });

const near = (y: bigint) => `${(Number(y) / 1e24).toFixed(6)} NEAR`;

function artifact(name: keyof typeof ARTIFACTS): Buffer {
  const [path, sha] = ARTIFACTS[name];
  const bytes = readFileSync(`${ROOT}${path}`);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha)
    throw new PublicError(`${name} build is ${got}, not the tested ${sha}.`);
  return bytes;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function id(prefix: string): string {
  const value = env[`${prefix}_ACCOUNT_ID`];
  if (!value?.endsWith(".near"))
    throw new PublicError(`${prefix}_ACCOUNT_ID is not set in .env.`);
  return value;
}
const OPS = id("MAINNET_OPS");
const CONTRACT = id("MAINNET_PR_BOUNTY");
const SPONSOR = id("MAINNET_PR_BOUNTY_SPONSOR");

/** The account with its .env key, after checking that key is a full-access key on chain. */
async function signer(prefix: string): Promise<Account> {
  const accountId = id(prefix);
  const secret = env[`${prefix}_PRIVATE_KEY`];
  if (!secret?.startsWith("ed25519:"))
    throw new PublicError(`${prefix}_PRIVATE_KEY is not set in .env.`);
  const pair = KeyPair.fromString(secret as `ed25519:${string}`);
  const keys = (await provider.query({
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  })) as unknown as {
    keys: { public_key: string; access_key: { permission: unknown } }[];
  };
  const match = keys.keys.find(
    (k) => k.public_key === pair.getPublicKey().toString(),
  );
  if (!match || match.access_key.permission !== "FullAccess")
    throw new PublicError(
      `The .env key for ${accountId} is not a full-access key on chain.`,
    );
  return new Account(accountId, provider, new KeyPairSigner(pair));
}

async function balance(accountId: string) {
  const view = await provider.viewAccount({ accountId }).catch(() => null);
  if (!view) return null;
  const amount = BigInt(view.amount);
  const storage = BigInt(view.storage_usage) * YOCTO_PER_BYTE;
  return {
    amount,
    storage,
    free: amount - storage,
    code: view.code_hash,
  };
}

async function rpc(params: Record<string, unknown>) {
  const reply = await fetch(net.rpcs[0], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "proven",
      method: "query",
      params,
    }),
  });
  return (await reply.json()) as { result?: unknown; error?: unknown };
}

async function vaultPublished(hashB58: string): Promise<boolean> {
  const reply = await rpc({
    request_type: "view_global_contract_code",
    finality: "final",
    code_hash: hashB58,
  });
  return Boolean(reply.result);
}

const verifierUrl = () =>
  `https://main.fastfs.io/${OPS}/${OUTLAYER}/${ARTIFACTS.verifier[1]}.wasm`;

async function verifierServed(): Promise<boolean> {
  const reply = await fetch(verifierUrl()).catch(() => null);
  if (!reply?.ok) return false;
  const bytes = Buffer.from(await reply.arrayBuffer());
  return (
    createHash("sha256").update(bytes).digest("hex") === ARTIFACTS.verifier[1]
  );
}

async function gasPrice(): Promise<bigint> {
  const reply = await fetch(net.rpcs[0], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "proven",
      method: "gas_price",
      params: [null],
    }),
  });
  const body = (await reply.json()) as { result: { gas_price: string } };
  return BigInt(body.result.gas_price);
}

function initArgs(vaultHash: string) {
  return {
    owner: OPS,
    outlayer: OUTLAYER,
    network: "mainnet",
    verifier_url: verifierUrl(),
    verifier_hash: ARTIFACTS.verifier[1],
    vault_code_hash: vaultHash,
    sponsor: SPONSOR,
    min_reward: LAUNCH.min_reward.toString(),
    max_reward: LAUNCH.max_reward.toString(),
    max_held: LAUNCH.max_held.toString(),
    max_open_per_buyer: LAUNCH.max_open_per_buyer,
    max_sponsor_float: LAUNCH.max_sponsor_float.toString(),
    max_sponsor_spent: LAUNCH.max_sponsor_spent.toString(),
  };
}

async function once(name: string, plan: unknown, step: () => Promise<string>) {
  console.log(JSON.stringify({ step: name, plan }, null, 2));
  if (evidence[name] === "started")
    throw new PublicError(`${name} has an unknown outcome. Inspect it first.`);
  if (evidence[name]) {
    console.log(`${name}: already done (${String(evidence[name])})`);
    return;
  }
  if (dry) {
    console.log(`dry run: ${name} not sent`);
    return;
  }
  if ((await gasPrice()) > MAX_GAS_PRICE)
    throw new PublicError("The gas price is above the planned price.");
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

/** Requires `free` to cover `need`, or stops. */
function covers(who: string, free: bigint, need: bigint) {
  console.log(
    `${who}: free ${near(free)}, this step needs at most ${near(need)}`,
  );
  if (free < need) throw new PublicError(`${who} cannot cover this step.`);
}

// ---- Steps ----

async function check() {
  const vaultHash = base58(
    createHash("sha256").update(artifact("vault")).digest(),
  );
  artifact("contract");
  artifact("verifier");
  const rows: Record<string, unknown> = {};
  for (const who of [OPS, CONTRACT, SPONSOR]) {
    const b = await balance(who);
    rows[who] = b
      ? { amount: near(b.amount), free: near(b.free), code: b.code }
      : "missing";
  }
  console.log(
    JSON.stringify(
      {
        network: net.network,
        gas_price: (await gasPrice()).toString(),
        accounts: rows,
        verifier_served: await verifierServed(),
        verifier_url: verifierUrl(),
        vault_code_hash: vaultHash,
        vault_published: await vaultPublished(vaultHash),
        init: initArgs(vaultHash),
        float: near(FLOAT),
        journal: evidence,
      },
      null,
      2,
    ),
  );
  for (const prefix of [
    "MAINNET_OPS",
    "MAINNET_PR_BOUNTY",
    "MAINNET_PR_BOUNTY_SPONSOR",
  ])
    await signer(prefix);
  console.log("keys: each .env key is a full-access key of its account");
}

/** One FastFS write (the format `outlayer upload` uses), one chunk: the file is under 1 MiB. */
function fastfsPayload(path: string, file: Buffer, nonce: number): Buffer {
  const str = (t: string) => {
    const b = Buffer.from(t, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  return Buffer.concat([
    Buffer.from([1]),
    str(path),
    u32(0),
    u32(file.length),
    str("application/wasm"),
    u32(file.length),
    file,
    u32(nonce),
  ]);
}

async function publishVerifier() {
  const file = artifact("verifier");
  if (file.length >= 1 << 20)
    throw new PublicError("The verifier needs chunks.");
  if (await verifierServed()) {
    console.log(`already served at ${verifierUrl()}`);
    return;
  }
  const ops = dry ? null : await signer("MAINNET_OPS");
  const gas = 1n * TGAS;
  const b = await balance(OPS);
  // One function call: the bytes are its arguments, priced at about 2.2 Tgas per 100 KB at most.
  covers(OPS, b!.free, 50n * MILLI);
  await once(
    "publish_verifier",
    { signer: OPS, receiver: OUTLAYER, bytes: file.length, gas_tgas: 1 },
    async () => {
      const nonce = Math.floor(Date.now() / 1000) - 1_769_376_240;
      const result = await ops!.signAndSendTransaction({
        receiverId: OUTLAYER,
        actions: [
          actions.functionCall(
            "__fastdata_fastfs",
            new Uint8Array(
              fastfsPayload(`${ARTIFACTS.verifier[1]}.wasm`, file, nonce),
            ),
            gas,
            0n,
          ),
        ],
        throwOnFailure: false,
      });
      // The call fails on purpose after it is recorded; FastFS's indexer reads its arguments.
      return result.transaction.hash;
    },
  );
}

async function publishVault() {
  const code = artifact("vault");
  const hash = base58(createHash("sha256").update(code).digest());
  if (await vaultPublished(hash)) {
    console.log(`vault code ${hash} is already published`);
    return;
  }
  const storage = BigInt(code.length) * YOCTO_PER_BYTE * GLOBAL_MULTIPLIER;
  const b = await balance(OPS);
  covers(OPS, b!.free, storage + 50n * MILLI);
  const ops = dry ? null : await signer("MAINNET_OPS");
  await once(
    "publish_vault",
    {
      signer: OPS,
      code_hash: hash,
      bytes: code.length,
      burnt_for_storage: near(storage),
    },
    async () =>
      settled(
        await ops!.signAndSendTransaction({
          receiverId: OPS,
          actions: [actions.deployGlobalContract(code, "codeHash")],
        }),
      ),
  );
}

async function deploy() {
  const code = artifact("contract");
  const vaultHash = base58(
    createHash("sha256").update(artifact("vault")).digest(),
  );
  const missing = [
    ...((await verifierServed())
      ? []
      : ["the verifier is not served with its hash yet"]),
    ...((await vaultPublished(vaultHash))
      ? []
      : ["the vault code is not published yet"]),
  ];
  if (missing.length && !dry)
    throw new PublicError(`Not ready: ${missing.join("; ")}.`);
  if (missing.length) console.log(`not ready yet: ${missing.join("; ")}`);
  const b = await balance(CONTRACT);
  if (!b) throw new PublicError(`${CONTRACT} does not exist.`);
  if (b.code !== "11111111111111111111111111111111")
    throw new PublicError(`${CONTRACT} already has code.`);
  const storage = (BigInt(code.length) + STATE_ROOM) * YOCTO_PER_BYTE;
  // Held at signing: the deploy action and the init call's gas at the purchase price.
  const held = (INIT_GAS + 10n * TGAS) * PURCHASE_PRICE;
  covers(CONTRACT, b.amount, storage + held);
  const contract = dry ? null : await signer("MAINNET_PR_BOUNTY");
  const args = initArgs(vaultHash);
  await once(
    "deploy",
    { account: CONTRACT, code_bytes: code.length, init: args },
    async () =>
      settled(
        await contract!.signAndSendTransaction({
          receiverId: CONTRACT,
          actions: [
            actions.deployContract(code),
            actions.functionCall("new", args, INIT_GAS, 0n),
          ],
        }),
      ),
  );
}

async function fundSponsor() {
  const b = await balance(SPONSOR);
  covers(SPONSOR, b!.free, FLOAT + 30n * TGAS * PURCHASE_PRICE);
  const sponsor = dry ? null : await signer("MAINNET_PR_BOUNTY_SPONSOR");
  await once(
    "fund_sponsor",
    { signer: SPONSOR, receiver: CONTRACT, deposit: near(FLOAT) },
    async () =>
      settled(
        await sponsor!.signAndSendTransaction({
          receiverId: CONTRACT,
          actions: [
            actions.functionCall("fund_sponsor", {}, 30n * TGAS, FLOAT),
          ],
        }),
      ),
  );
}

async function readBack() {
  const config = await provider.callFunction({
    contractId: CONTRACT,
    method: "get_config",
    args: {},
  });
  const vaultHash = base58(
    createHash("sha256").update(artifact("vault")).digest(),
  );
  const want = initArgs(vaultHash);
  const got = config as Record<string, unknown>;
  const expected: Record<string, unknown> = {
    ...want,
    open_posting: true,
    paused: false,
    pending_owner: null,
    claim_fee: (100n * 10n ** 18n).toString(),
    held: "0",
  };
  const problems = Object.entries(expected)
    .filter(([k, v]) => String(got[k]) !== String(v))
    .map(([k, v]) => `${k}: ${String(got[k])} (want ${String(v)})`);
  const b = await balance(CONTRACT);
  const codeSha = createHash("sha256").update(artifact("contract")).digest();
  console.log(
    JSON.stringify(
      {
        config,
        code_hash: b?.code,
        code_matches: b?.code === base58(codeSha),
        open_posting: got.open_posting,
        problems,
      },
      null,
      2,
    ),
  );
  if (problems.length || b?.code !== base58(codeSha))
    throw new PublicError("The deployed contract does not match the plan.");
}

const steps: Record<string, () => Promise<void>> = {
  check,
  "publish-verifier": publishVerifier,
  "publish-vault": publishVault,
  deploy,
  "fund-sponsor": fundSponsor,
  "read-back": readBack,
};

const name = process.argv.slice(2).find((a) => !a.startsWith("--"));
const run = name ? steps[name] : undefined;
if (!run) {
  console.error(
    `usage: setup-pr-bounty-mainnet.ts <${Object.keys(steps).join("|")}> [--dry-run]`,
  );
  process.exit(2);
}
run().catch((error: unknown) => {
  console.error(`setup: ${publicMessage(error)}`);
  process.exit(1);
});
