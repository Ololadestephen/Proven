import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { hostedSettings, hostedWritePlan } from "./network.ts";
import { buildDeps, hostedBalance } from "./service.ts";
import { addAgent, canEnroll, type ApiDeps } from "./api.ts";

const mainnet = {
  NEAR_NETWORK: "mainnet",
  PROVEN_STAGE2_APPROVED: "yes",
  MAINNET_ESCROW_ACCOUNT_ID: "proven-escrow.near",
  PROVEN_BOARD: "proven-board.near",
  MAINNET_RPC_URL: "https://rpc.mainnet.fastnear.com",
  PROVEN_CUSTODY_API: "https://api.outlayer.ai",
  HOSTED_TREASURY_ACCOUNT_ID: "proven-treasury.near",
  HOSTED_EARNINGS_CAP_NEAR: "0.5",
  PROVEN_RELAY_SOCKET: "/tmp/proven-mainnet-relay.sock",
  PROVEN_HOSTED_DATA: "/tmp/proven-mainnet-hosted-test",
  PROVEN_HOSTED_PORT: "4177",
  PROVEN_HOSTED_ENROLLMENT_OWNERS: "pilot.near",
};

test("pilot enrollment rejects unlisted owners before signature, payment, or model work", async () => {
  const settings = hostedSettings(mainnet, mainnet.PROVEN_BOARD);
  const deps = {
    enrollmentOwners: settings.enrollmentOwners,
    get verifier() {
      return assert.fail("Enrollment must stop before accessing the verifier");
    },
  } as unknown as ApiDeps;
  assert.equal(canEnroll(deps, "pilot.near"), true);
  assert.equal(canEnroll(deps, "stranger.near"), false);
  await assert.rejects(
    addAgent(deps, {
      owner: "stranger.near",
      prompt: "Extract invoice totals",
      setup_transaction: "unverified",
    }),
    /limited to invited pilot accounts/,
  );
  assert.throws(
    () =>
      hostedSettings(
        { ...mainnet, PROVEN_HOSTED_ENROLLMENT_OWNERS: " " },
        mainnet.PROVEN_BOARD,
      ),
    /Invalid account id/,
  );
});

test("hosted mainnet refuses before accessing credentials or performing work", async () => {
  let keyReads = 0;
  const env = { ...mainnet, PROVEN_STAGE2_APPROVED: undefined };
  Object.defineProperty(env, "HOSTED_TREASURY_PRIVATE_KEY", {
    get() {
      keyReads++;
      throw new Error("must not read a credential");
    },
  });
  Object.defineProperty(env, "NEARAI_KEY_HOSTED", {
    get() {
      keyReads++;
      throw new Error("must not read a credential");
    },
  });
  await assert.rejects(buildDeps("/unused", env), /Stage 2 approval flag/);
  assert.equal(keyReads, 0);
  for (const approval of [undefined, "true", "YES", "no"])
    assert.throws(
      () =>
        hostedSettings(
          { ...mainnet, PROVEN_STAGE2_APPROVED: approval },
          mainnet.PROVEN_BOARD,
        ),
      /Stage 2 approval flag/,
    );
});

test("hosted mainnet requires explicit matching contracts, endpoints, treasury and budget cap", () => {
  const settings = hostedSettings(mainnet, mainnet.PROVEN_BOARD);
  assert.equal(settings.config.escrow, "proven-escrow.near");
  assert.equal(settings.port, 4177);
  assert.equal(settings.earningsCapYocto, "500000000000000000000000");
  for (const name of [
    "MAINNET_ESCROW_ACCOUNT_ID",
    "PROVEN_BOARD",
    "MAINNET_RPC_URL",
    "PROVEN_CUSTODY_API",
    "HOSTED_TREASURY_ACCOUNT_ID",
    "HOSTED_EARNINGS_CAP_NEAR",
    "PROVEN_HOSTED_DATA",
    "PROVEN_HOSTED_PORT",
    "PROVEN_HOSTED_ENROLLMENT_OWNERS",
  ])
    assert.throws(
      () =>
        hostedSettings({ ...mainnet, [name]: undefined }, mainnet.PROVEN_BOARD),
      /must be set explicitly/,
    );
  for (const over of [
    { MAINNET_ESCROW_ACCOUNT_ID: "escrow-v5.proven.testnet" },
    { PROVEN_BOARD: "board-v4.proven.testnet" },
    { HOSTED_TREASURY_ACCOUNT_ID: "proven-ops.near" },
    { MAINNET_RPC_URL: "https://test.rpc.fastnear.com" },
    { PROVEN_CUSTODY_API: "https://testnet-api.outlayer.ai" },
    { HOSTED_EARNINGS_CAP_NEAR: "0" },
    { PROVEN_HOSTED_DATA: "runs/private/hosted" },
    { HOSTED_EARNINGS_CAP_NEAR: "5.000000000000000000000001" },
    { SANDBOX_URL: "https://sandbox.invalid" },
    { SANDBOX_TOKEN: "fixture-not-a-secret" },
    { PROVEN_RELAY_URL: "http://relay.invalid" },
    { PROVEN_RELAY_URL: "https://user:pass@relay.invalid" },
  ])
    assert.throws(() =>
      hostedSettings({ ...mainnet, ...over }, mainnet.PROVEN_BOARD),
    );
  assert.throws(
    () => hostedSettings(mainnet, "board-v4.proven.testnet"),
    /selected network and board/,
  );
});

test("without a network setting hosted startup selects only testnet defaults", () => {
  const settings = hostedSettings(
    { HOSTED_TREASURY_ACCOUNT_ID: "treasury.proven.testnet" },
    "board-v4.proven.testnet",
  );
  assert.equal(settings.network, "testnet");
  assert.equal(settings.config.escrow, "escrow-v5.proven.testnet");
  assert.equal(settings.config.custodyApi, "https://testnet-api.outlayer.ai");
  assert.equal(settings.config.custodyKey, undefined);
  assert.equal(settings.config.key, undefined);
  assert.equal(settings.config.account, undefined);
});

test("dry-run startup needs no keys and creates no signer, HTTP listener or network request", () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-dry-run-"));
  const env = { ...mainnet, PROVEN_HOSTED_DATA: join(root, "not-created") };
  try {
    const result = spawnSync(
      process.execPath,
      [new URL("./service.ts", import.meta.url).pathname, "--dry-run"],
      {
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.starts_runner, false);
    assert.equal(plan.starts_http_server, false);
    assert.match(plan.disclosure, /single key/);
    assert.ok(
      plan.writes.some(
        (write: { action: string }) => write.action === "store_wallet_policy",
      ),
    );
    assert.ok(!result.stdout.includes("PRIVATE_KEY"));
    assert.deepEqual(
      plan,
      hostedWritePlan(hostedSettings(env, env.PROVEN_BOARD)),
    );
    assert.equal(existsSync(env.PROVEN_HOSTED_DATA), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unbound existing data directory refuses before credential properties are read", async () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-unbound-"));
  let keyReads = 0;
  try {
    mkdirSync(join(root, "agents"));
    const env = {
      NEAR_NETWORK: "testnet",
      HOSTED_TREASURY_ACCOUNT_ID: "treasury.proven.testnet",
      PROVEN_HOSTED_DATA: root,
    };
    Object.defineProperty(env, "HOSTED_TREASURY_PRIVATE_KEY", {
      get() {
        keyReads++;
        throw new Error("must not load key");
      },
    });
    await assert.rejects(buildDeps(root, env), /network manifest/);
    assert.equal(keyReads, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the SDK's confirmed absent-account error becomes an unfunded balance", async () => {
  assert.equal(await hostedBalance(async () => ({ amount: "123" })), 123n);
  assert.equal(
    await hostedBalance(async () => {
      throw new AccountDoesNotExistError("new.testnet", "A".repeat(44), 1);
    }),
    0n,
  );
  for (const error of [
    new Error("account does not exist"),
    new Error("RPC unavailable"),
    { name: "UNKNOWN_ACCOUNT" },
  ])
    await assert.rejects(
      hostedBalance(async () => {
        throw error;
      }),
      /balance is unavailable/,
    );
});

test("a relay provider's separate SDK instance also recognizes an unfunded wallet", async (t) => {
  const { FallbackRpcProvider } = await import("../../../relay/src/rpc.ts");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json({
      jsonrpc: "2.0",
      id: "account",
      error: {
        name: "HANDLER_ERROR",
        cause: {
          name: "UNKNOWN_ACCOUNT",
          info: {
            requested_account_id: "new.testnet",
            block_hash: "A".repeat(44),
            block_height: 1,
          },
        },
        code: -32000,
        message: "Server error",
      },
    });
  const provider = new FallbackRpcProvider(["https://example.invalid"]);
  assert.equal(
    await hostedBalance(() =>
      provider.viewAccount({
        accountId: "new.testnet",
        blockQuery: { finality: "final" },
      }),
    ),
    0n,
  );
});
