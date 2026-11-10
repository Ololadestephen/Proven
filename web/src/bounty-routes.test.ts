// The PR bounty network gate for every route, the new read routes' validation, the two-key
// confirmation rules, and the page text the owner required. No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bountiesRoute, bountyContract } from "./bounties.ts";
import {
  claimMessage,
  keyProofHash,
  keyText,
  base64,
} from "../ui/bounty-keys.ts";
import {
  KEY_STATEMENTS,
  LEDGER_NOTE,
  SEPARATE_CONFIRMATION,
  TESTED_WALLETS,
  initialKeyState,
  keyReducer,
  submitCheck,
  type KeyAction,
  type KeyConfirmState,
} from "../ui/key-confirm-state.ts";

const CONTRACT = "pr-bounty.proven-funding.testnet";
const VAULT = `0s${"ab".repeat(20)}`;
const KEY = `ed25519:${"1".repeat(32)}`;

const ROUTES = [
  "/api/market/bounties",
  "/api/market/bounties/poster/maint.testnet",
  `/api/market/bounties/challenge/3/contrib.testnet/1794300000/${KEY}/${KEY}`,
  `/api/market/bounties/nonce/maint.testnet/${"0".repeat(64)}`,
  `/api/market/bounties/vault/${VAULT}`,
  `/api/market/bounties/slot/${VAULT}/3/Payout`,
  "/api/market/bounties/account/payee.testnet",
  "/api/market/bounties/block",
  `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet/${VAULT}/payee.testnet/1/0`,
];

test("off testnet, every bounty route answers not configured and reads nothing", async () => {
  let calls = 0;
  const transport = (async () => {
    calls++;
    throw new Error("no read expected");
  }) as unknown as typeof fetch;
  for (const network of ["mainnet", "", "betanet", "TESTNET"])
    for (const path of ROUTES)
      assert.deepEqual(
        await bountiesRoute(path, transport, bountyContract(CONTRACT, network)),
        { configured: false },
        `${String(network)} ${path}`,
      );
  assert.equal(calls, 0);
});

/** A fake RPC: `answer(body)` returns the whole JSON-RPC reply. */
function chain(
  answer: (body: {
    method: string;
    params: Record<string, unknown>;
  }) => unknown,
) {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const transport = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    asked.push(body);
    return new Response(JSON.stringify(answer(body)));
  }) as typeof fetch;
  return { asked, transport };
}
const bytes = (b: Uint8Array) => ({
  jsonrpc: "2.0",
  id: "x",
  result: { result: [...b] },
});
const missing = {
  jsonrpc: "2.0",
  id: "x",
  error: { cause: { name: "UNKNOWN_ACCOUNT" } },
};

test("a vault that does not exist yet reads as not existing, never as zero", async () => {
  const { asked, transport } = chain(() => missing);
  assert.deepEqual(
    await bountiesRoute(
      `/api/market/bounties/vault/${VAULT}`,
      transport,
      CONTRACT,
    ),
    { vault: VAULT, exists: false, info: null },
  );
  assert.equal(asked[0]?.params.account_id, VAULT);
  assert.equal(asked[0]?.params.method_name, "info");
  // Any other failure is an error, not an empty vault.
  const broken = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    error: { cause: { name: "TIMEOUT" } },
  }));
  await assert.rejects(
    bountiesRoute(
      `/api/market/bounties/vault/${VAULT}`,
      broken.transport,
      CONTRACT,
    ),
  );
});

test("the vault route decodes the vault's own info view", async () => {
  const info = new Uint8Array(106);
  info[66] = 2; // n = 2
  info[74] = 5; // fund = 5
  info[90] = 9; // available = 9
  const { transport } = chain(() => bytes(info));
  const reply = (await bountiesRoute(
    `/api/market/bounties/vault/${VAULT}`,
    transport,
    CONTRACT,
  )) as {
    info: Record<string, string>;
  };
  assert.deepEqual(
    { n: reply.info.n, fund: reply.info.fund, available: reply.info.available },
    { n: "2", fund: "5", available: "9" },
  );
  assert.equal(reply.info.primary, `ed25519:${"1".repeat(32)}`);
});

test("the slot route asks the vault for this contract's record", async () => {
  const record = new Uint8Array(25);
  record[0] = 1;
  record[1] = 2;
  record[5] = 7;
  const { asked, transport } = chain(() => bytes(record));
  assert.deepEqual(
    await bountiesRoute(
      `/api/market/bounties/slot/${VAULT}/3/Refund`,
      transport,
      CONTRACT,
    ),
    {
      vault: VAULT,
      exists: true,
      record: { deposited: true, attempt: 2, amount: "7", sealed_through: 0 },
    },
  );
  const args = Buffer.from(String(asked[0]?.params.args_base64), "base64");
  assert.equal(args.subarray(4, 4 + CONTRACT.length).toString(), CONTRACT);
  assert.equal(args.at(-1), 2, "kind Refund");
});

test("account, block and nonce routes", async () => {
  const exists = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    result: { amount: "1" },
  }));
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/account/payee.testnet",
      exists.transport,
      CONTRACT,
    ),
    { account: "payee.testnet", exists: true },
  );
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/account/ghost.testnet",
      chain(() => missing).transport,
      CONTRACT,
    ),
    { account: "ghost.testnet", exists: false },
  );
  const block = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    result: { header: { timestamp_nanosec: "1794300000123456789" } },
  }));
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/block",
      block.transport,
      CONTRACT,
    ),
    {
      block_secs: 1794300000,
    },
  );
  const nonce = chain(() => bytes(new TextEncoder().encode("true")));
  assert.deepEqual(
    await bountiesRoute(
      `/api/market/bounties/nonce/maint.testnet/${"a".repeat(64)}`,
      nonce.transport,
      CONTRACT,
    ),
    { used: true },
  );
});

test("malformed route parts are refused before any read", async () => {
  const { asked, transport } = chain(() => missing);
  for (const bad of [
    "/api/market/bounties/vault/0sXYZ",
    "/api/market/bounties/vault/maint.testnet",
    `/api/market/bounties/slot/${VAULT}/x/Payout`,
    `/api/market/bounties/slot/${VAULT}/3/Other`,
    "/api/market/bounties/account/Bad..Account",
    "/api/market/bounties/withdrawal/short/relayer.testnet",
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet`,
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet/${VAULT}/payee.testnet/x/0`,
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet/maint.testnet/payee.testnet/1/0`,
    `/api/market/bounties/nonce/maint.testnet/${"A".repeat(64)}`,
    `/api/market/bounties/challenge/3/contrib.testnet/1794300000/secp256k1:abc/${KEY}`,
    "/api/market/bounties/challenge/3/contrib.testnet/1794300000",
    "/api/market/bounties/block/extra",
  ])
    await assert.rejects(bountiesRoute(bad, transport, CONTRACT), bad);
  assert.equal(asked.length, 0);
});

test("a withdrawal route answer is classified against the signed fields", async () => {
  const { readFileSync } = await import("node:fs");
  const r = JSON.parse(
    readFileSync(
      new URL(
        "../test-fixtures/sandbox/withdrawal-returned.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const { transport } = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    result: r.status,
  }));
  const route = (fields: { to: string; amount: string; n: string }) =>
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.test.near/${r.vault}/${fields.to}/${fields.amount}/${fields.n}`;
  const reply = (await bountiesRoute(route(r), transport, CONTRACT)) as {
    outcome: Record<string, string>;
  };
  assert.deepEqual(reply.outcome, {
    kind: "returned",
    amount: r.amount,
    n: "0",
    next: "1",
  });
  // The same transaction checked against another amount is not this withdrawal.
  const other = (await bountiesRoute(
    route({ ...r, amount: "1" }),
    transport,
    CONTRACT,
  )) as { outcome: Record<string, string> };
  assert.equal(other.outcome.kind, "pending");
  const none = chain(() => missing);
  assert.equal(
    (
      (await bountiesRoute(route(r), none.transport, CONTRACT)) as {
        outcome: { kind: string };
      }
    ).outcome.kind,
    "pending",
  );
});
// ---- The two-key confirmation ----

const secret = (n: number) => new Uint8Array(32).fill(n);
const pub = (n: number) => keyText(ed25519.getPublicKey(secret(n)));
const message = (state: KeyConfirmState, signing: "primary" | "backup") =>
  claimMessage(
    "testnet",
    CONTRACT,
    state.actor as string,
    3,
    "900000001",
    { primary: state.primary as string, backup: state.backup as string },
    state.expiresAt as number,
    signing,
  );
const sign = (
  state: KeyConfirmState,
  signing: "primary" | "backup",
  key: number,
): KeyAction => {
  const text = message(state, signing);
  return {
    type: "signed",
    signing,
    publicKey: pub(key),
    signature: base64(ed25519.sign(keyProofHash(text, CONTRACT), secret(key))),
    message: text,
    contract: CONTRACT,
  };
};
const run = (actions: ((s: KeyConfirmState) => KeyAction)[]) =>
  actions.reduce((s, a) => keyReducer(s, a(s)), initialKeyState);

test("both proofs must verify, by the named keys, before submission is allowed", () => {
  const start = (s: KeyConfirmState): KeyAction => ({
    type: "start",
    actor: "contrib.testnet",
    expiresAt: 2_000,
  });
  const ready = run([
    () => ({ type: "primary", key: pub(1) }),
    () => ({ type: "backup", key: pub(2) }),
    start,
    (s) => sign(s, "backup", 2),
    (s) => sign(s, "primary", 1),
  ]);
  assert.equal(ready.error, null);
  assert.deepEqual(submitCheck(ready, "contrib.testnet", 1_000), {
    ok: false,
    reason: "separate",
  });
  const confirmed = keyReducer(ready, { type: "separate", value: true });
  assert.deepEqual(submitCheck(confirmed, "contrib.testnet", 1_000), {
    ok: true,
  });
  // Another connected account: both proofs are dropped.
  const other = submitCheck(confirmed, "someone.testnet", 1_000);
  assert.deepEqual(other, { ok: false, reason: "actor" });
  assert.deepEqual(
    keyReducer(confirmed, { type: "refused", check: other }).proofs,
    {},
  );
  // Expired at the moment of submission.
  const late = submitCheck(confirmed, "contrib.testnet", 2_000);
  assert.deepEqual(late, { ok: false, reason: "expired" });
  assert.deepEqual(
    keyReducer(confirmed, { type: "refused", check: late }).proofs,
    {},
  );
});

test("a wrong key, a wrong signature or equal keys never become a proof", () => {
  const prepared = run([
    () => ({ type: "primary", key: pub(1) }),
    () => ({ type: "backup", key: pub(2) }),
    () => ({ type: "start", actor: "contrib.testnet", expiresAt: 2_000 }),
    (s) => sign(s, "backup", 2),
  ]);
  assert.ok(prepared.proofs.backup);
  // The primary proof signed by another key: refused, the backup proof kept.
  const wrongKey = keyReducer(prepared, sign(prepared, "primary", 3));
  assert.equal(wrongKey.proofs.primary, undefined);
  assert.ok(wrongKey.proofs.backup);
  assert.match(wrongKey.error ?? "", /primary key/);
  // A signature over another message, presented with the right key.
  const bad = sign(prepared, "primary", 1) as Extract<
    KeyAction,
    { type: "signed" }
  >;
  const swapped = keyReducer(prepared, {
    ...bad,
    message: message(prepared, "backup"),
  });
  assert.equal(swapped.proofs.primary, undefined);
  // A key that is not ed25519.
  const notEd = keyReducer(prepared, { ...bad, publicKey: "secp256k1:abc" });
  assert.equal(notEd.proofs.primary, undefined);
  // The wallet closed its prompt: nothing is lost.
  const rejected = keyReducer(prepared, {
    type: "rejected",
    signing: "primary",
  });
  assert.ok(rejected.proofs.backup);
  assert.deepEqual(submitCheck(rejected, "contrib.testnet", 1_000), {
    ok: false,
    reason: "missing",
  });
  // Equal keys.
  const same = keyReducer(
    keyReducer(initialKeyState, { type: "primary", key: pub(1) }),
    {
      type: "backup",
      key: pub(1),
    },
  );
  assert.equal(same.backup, null);
  assert.match(same.error ?? "", /must differ/);
});

// ---- Page text ----

/** Bundles a component with its own React, and renders it with that same React. */
const bundle = async (entry: string) => {
  const path = new URL(entry, import.meta.url).pathname;
  const built = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(path)};
export { createElement } from "react";
export { renderToStaticMarkup } from "react-dom/server";`,
      resolveDir: new URL("..", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    // React's server renderer is CommonJS and requires Node built-ins.
    banner: {
      js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(path)});`,
    },
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
  );
  return {
    ...module,
    render: (component: unknown, props: unknown) =>
      module.renderToStaticMarkup(
        module.createElement(component, props),
      ) as string,
  };
};

test("the confirmation panel states every required fact, and a wallet that cannot sign keeps it disabled", async () => {
  const ui = await bundle("../ui/KeyConfirm.tsx");
  const render = (wallet: Record<string, unknown>) =>
    ui.render(ui.KeyConfirm, {
      wallet,
      contract: CONTRACT,
      vaultCodeHash: "11111111111111111111111111111111",
      message: () => "",
      state: initialKeyState,
      dispatch: () => {},
      busy: false,
      role: "contributor",
    });
  const able = render({
    accountId: "contrib.testnet",
    label: "Test wallet",
    signNep413: async () => ({}),
  });
  const html = able.replaceAll("&#x27;", "'");
  for (const statement of KEY_STATEMENTS)
    assert.ok(html.includes(statement), statement);
  assert.ok(html.includes(SEPARATE_CONFIRMATION));
  assert.ok(html.includes(`signing test: ${TESTED_WALLETS}`));
  assert.ok(html.includes(LEDGER_NOTE));
  const unable = render({
    accountId: "contrib.testnet",
    label: "Old wallet",
  }).replaceAll("&#x27;", "'");
  assert.ok(unable.includes("Old wallet cannot sign key proofs"));
  const buttons = unable.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0);
  for (const b of buttons) assert.match(b, /disabled=""/);
  assert.match(unable, /<input type="checkbox"[^>]*disabled=""/);
  // The backup key's account gets its own signing card; a wallet that cannot sign gets none.
  const signer = (wallet: Record<string, unknown>) =>
    ui.render(ui.BackupSigner, { wallet, contract: CONTRACT, busy: false });
  assert.match(
    signer({
      accountId: "backup.testnet",
      label: "Test wallet",
      signNep413: async () => ({}),
    }).replaceAll("&#x27;", "'"),
    /Offer Test wallet's key as a backup key/,
  );
  assert.equal(
    signer({ accountId: "backup.testnet", label: "Old wallet" }),
    "",
  );
});

test("the vault panel says browser withdrawal is pending and the sponsor note is shown", async () => {
  const panel = await bundle("../ui/VaultPanel.tsx");
  const BROWSER_WITHDRAWAL_SUPPORT = panel.BROWSER_WITHDRAWAL_SUPPORT as string;
  assert.match(BROWSER_WITHDRAWAL_SUPPORT, /pending/);
  const html = panel.render(panel.VaultPanel, {
    vault: VAULT,
    network: "testnet",
    wallet: null,
    run: async () => {},
    busy: false,
    near: (y: string) => `${y}`,
    shared: 2,
  });
  assert.ok(html.includes(BROWSER_WITHDRAWAL_SUPPORT));
  assert.equal(
    (html.match(/unavailable/g) ?? []).length,
    3,
    "no read yet: unavailable, never zero",
  );
  assert.match(html, /shown for the vault as a whole/);
  const page = await bundle("../ui/PrBounties.tsx");
  const note = page
    .render(page.SponsorNote, {
      config: { sponsor: "sponsor.testnet", budget: "30000000000000000000000" },
    })
    .replaceAll("&#x27;", "'");
  assert.match(note, /paid by the owner's sponsor float/);
  assert.match(note, /unused\s+compute returns to the owner's sponsor account/);
  assert.match(note, /sponsor\.testnet/);
  assert.match(note, /returns in full to the maintainer's vault/);
});
