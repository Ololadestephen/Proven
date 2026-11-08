import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { createApp } from "./server.ts";
import {
  marketDescription,
  networkDescription,
  parseMarketSettings,
  startupMessage,
} from "../ui/network-status.ts";
import { showMarketStatus } from "../ui/market-status.ts";

const caps = {
  max_job: "5000000000000000000000000",
  max_held: "10000000000000000000000000",
  max_held_per_buyer: "5000000000000000000000000",
};
const closed = {
  network: "mainnet",
  open: false,
  buyers: ["listed.near"],
  caps,
};

test("mainnet descriptions name risk, board access, and the supplied chain limits", () => {
  const label = marketDescription(parseMarketSettings(closed));
  assert.match(label, /Mainnet · unaudited, owner-funded deployment/);
  assert.match(label, /closed to listed buyers/);
  assert.match(
    label,
    /5 NEAR per job, 5 NEAR per buyer and 10 NEAR held in total/,
  );
  const changed = marketDescription(
    parseMarketSettings({
      ...closed,
      caps: { ...caps, max_job: "7000000000000000000000000" },
    }),
  );
  assert.match(changed, /7 NEAR per job/);
  assert.ok(!changed.includes("5 NEAR per job"));
});

test("missing settings or malformed caps cannot invent access or fallback numeric limits", () => {
  for (const value of [
    null,
    {},
    { network: "mainnet", open: "open" },
    { ...closed, buyers: "all" },
    { ...closed, caps: { ...caps, max_job: "NaN" } },
  ])
    assert.equal(parseMarketSettings(value), null);
  assert.match(marketDescription(null), /Posting is disabled/);
  const unknown = marketDescription(
    parseMarketSettings({ ...closed, caps: null }),
  );
  assert.match(unknown, /limits unavailable/);
  assert.ok(!unknown.includes("5 NEAR"));
  assert.match(
    marketDescription(parseMarketSettings({ ...closed, open: true })),
    /open to buyers/,
  );
});

test("testnet is preparation only and startup logs always name the configured network", () => {
  assert.equal(networkDescription("testnet"), "Testnet preparation only");
  const mainnet = startupMessage(4176, "mainnet");
  assert.match(mainnet, /unaudited, owner-funded deployment/);
  assert.ok(!mainnet.toLowerCase().includes("testnet"));
  const preparation = startupMessage(4173, "testnet");
  assert.match(preparation, /Testnet preparation only/);
  assert.match(preparation, /\/api\/market\/config/);
});

test("static status uses same-origin config as plain text and refuses unavailable or invalid responses", async () => {
  const labels = [{ textContent: "loading" }, { textContent: "loading" }];
  const root = { querySelectorAll: () => labels } as unknown as Pick<
    Document,
    "querySelectorAll"
  >;
  let requested = "";
  const fetchConfig = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify(closed));
  }) as typeof fetch;
  await showMarketStatus(root, fetchConfig);
  assert.equal(requested, "/api/market/config");
  assert.equal(labels[0]!.textContent, labels[1]!.textContent);
  assert.match(labels[0]!.textContent, /closed to listed buyers/);
  await showMarketStatus(
    root,
    (async () => new Response("bad", { status: 503 })) as typeof fetch,
  );
  assert.match(labels[0]!.textContent, /unavailable/);
  await showMarketStatus(
    root,
    (async () => new Response("bad JSON")) as typeof fetch,
  );
  assert.match(labels[0]!.textContent, /Posting is disabled/);
});

test("static pages have no stale caps, testnet app link or retired live-start control", async () => {
  for (const name of [
    "index.html",
    "guide.html",
    "trust.html",
    "about.html",
    "examples.html",
    "app.html",
  ]) {
    const html = await readFile(
      new URL(`../public/${name}`, import.meta.url),
      "utf8",
    );
    assert.ok(
      !/0\.1 NEAR|0\.2 (?:NEAR )?per buyer|1 (?:NEAR )?held/.test(html),
      name,
    );
    assert.ok(!/href=["']https:\/\/testnet\.useproven\.xyz/.test(html), name);
    assert.match(html, /data-market-summary/);
    assert.match(html, /\/build\/market-status\.js/);
  }
  const examples = await readFile(
    new URL("../public/examples.html", import.meta.url),
    "utf8",
  );
  assert.match(examples, /legacy launcher is retired/);
  assert.ok(!examples.includes('id="demo-start"'));
  assert.ok(!examples.includes('src="/demo.js"'));
});

test("the status bundle is served locally under the static read-only CSP", async (t) => {
  const app = createApp(async () => ({}) as never);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const script = await fetch(base + "/build/market-status.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);
  const page = await fetch(base + "/");
  assert.match(await page.text(), /src="\/build\/market-status\.js"/);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self';/);
  assert.ok(!csp.includes("unsafe-eval"));
  assert.equal(
    (await fetch(base + "/build/market-status.js", { method: "POST" })).status,
    405,
  );
});

test("a mainnet dev-wallet startup refuses before any private file is loaded", () => {
  const result = spawnSync(
    process.execPath,
    ["src/server.ts", "--dev-wallet"],
    {
      cwd: new URL("../", import.meta.url),
      env: { NEAR_NETWORK: "mainnet" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /The dev signer runs only on the testnet preparation server/,
  );
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes("ENOENT"));
});
