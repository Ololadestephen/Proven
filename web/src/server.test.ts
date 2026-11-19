import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { clientKey, createApp } from "./server.ts";
import { ReadError } from "./model.ts";
import { MARKET_ESCROW } from "./market.ts";

test("local HTTP only exposes allowed read routes, never private files or transaction endpoints", async (t) => {
  const jobs: string[] = [];
  const escrows: (string | undefined)[] = [];
  const app = createApp(async (id, _transport, escrow) => {
    jobs.push(id);
    escrows.push(escrow);
    if (id === "404") throw new ReadError("Job missing", 404);
    throw new Error("PRIVATE configuration");
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of [
    "/",
    "/app",
    "/app/",
    "/evidence",
    "/evidence/",
    "/guide",
    "/guide/",
    "/theme.css",
    "/favicon.svg",
    "/landing.css",
    "/product-sections.css",
    "/product-details.css",
    "/product-responsive.css",
    "/landing-sections.css",
    "/guide.css",
    "/landing-responsive.css",
    "/build/market.css",
    "/build/ui.js",
    "/build/ui.css",
    "/third-party-notices.txt",
    "/app.js",
    "/style.css",
    "/lookup.css",
    "/evidence.css",
    "/responsive.css",
  ])
    assert.equal((await fetch(base + path)).status, 200);
  for (const path of [
    "/.env",
    "/ui/ui.tsx",
    "/build/../ui/ui.tsx",
    "/dist/ui.js.map",
    "/licenses/react-bits-LICENSE.md",
    "/RULES.md",
    "/runs/private/relay.sock",
    "/src/server.ts",
    "/api/pay",
    "/api/jobs/../secret",
  ])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal(
    (await fetch(base + "/api/jobs/11", { method: "POST" })).status,
    405,
  );
  assert.equal(
    (await fetch(base + "/api/jobs/11?upstream=https://evil.example")).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/api/jobs/11", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const missing = await fetch(base + "/api/jobs/404");
  assert.equal(missing.status, 404);
  const error = await fetch(base + "/api/jobs/11");
  assert.equal(error.status, 502);
  assert.ok(!(await error.text()).includes("PRIVATE"));
  assert.ok(
    error.headers
      .get("content-security-policy")
      ?.includes("connect-src 'self'"),
  );
  assert.equal(error.headers.get("cache-control"), "no-store");
  const market = await fetch(base + "/api/jobs/market/21");
  assert.equal(market.status, 502);
  assert.equal((await fetch(base + "/api/jobs/other.testnet/21")).status, 404);
  assert.deepEqual(jobs, ["404", "11", "21"]);
  assert.deepEqual(escrows, [undefined, undefined, MARKET_ESCROW]);
  const badHost = await new Promise<number>((resolve) => {
    const request = http.get(
      base + "/",
      { headers: { Host: "attacker.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", () => resolve(0));
  });
  assert.equal(badHost, 403);
});

test("the market is the app, keeps its old address, and only it gets the wallet policy", async (t) => {
  const app = createApp(async () => ({}) as never);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const market = await fetch(`${base}/app`);
  assert.match(await market.text(), /build\/market\.js/);
  assert.match(
    market.headers.get("content-security-policy") ?? "",
    /connect-src 'self' https:/,
  );
  const evidence = await fetch(`${base}/evidence`);
  assert.match(await evidence.text(), /\/app\.js/);
  assert.match(
    evidence.headers.get("content-security-policy") ?? "",
    /connect-src 'self';/,
  );
  const moved = await fetch(`${base}/market`, { redirect: "manual" });
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.get("location"), "/app/market");
});

test("one IPv6 visitor counts as one client across its /64", () => {
  assert.equal(
    clientKey("2001:db8:1:2:aaaa::1"),
    clientKey("2001:db8:1:2:bbbb::9"),
  );
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
});

test("workspace routes carry fresh nonce CSP; support pages stay read-only and arbitrary app paths stay private", async (t) => {
  const app = createApp(async () => ({}) as never);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const addr = app.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  let previous = "";
  for (const path of [
    "/app",
    "/app/market",
    "/app/jobs",
    "/app/post",
    "/app/bids/12",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    const html = await response.text();
    const nonce = /name="wallet-csp-nonce" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(nonce);
    assert.notEqual(nonce, previous);
    previous = nonce;
    const csp = response.headers.get("content-security-policy")!;
    assert.ok(csp.includes(`'nonce-${nonce}'`));
    assert.ok(!csp.includes("unsafe-eval"));
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  }
  for (const path of ["/examples", "/trust"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(
      !response.headers.get("content-security-policy")!.includes("nonce-"),
    );
  }
  for (const path of [
    "/app/secrets",
    "/app/bids/NaN",
    "/app/bids/12/private",
    "/app/post/private",
  ]) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  const evidence = await (await fetch(base + "/evidence")).text();
  assert.ok(!evidence.includes('id="demo"'));
  assert.ok(!evidence.includes('id="trust"'));
});

test("static files are compressed, fingerprinted and answered 304 when unchanged; API reads are not cached", async (t) => {
  const app = createApp(async () => ({}) as never);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(base + path, { headers }, (response) => {
          response.resume();
          resolve(response);
        })
        .on("error", reject);
    });
  const first = await get("/market.css", { "accept-encoding": "gzip" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["content-encoding"], "gzip");
  assert.equal(first.headers["cache-control"], "no-cache");
  const etag = String(first.headers.etag);
  assert.match(etag, /^"[A-Za-z0-9_-]{27}"$/);
  const plain = await get("/market.css");
  assert.equal(plain.headers["content-encoding"], undefined);
  const again = await get("/market.css", { "if-none-match": etag });
  assert.equal(again.statusCode, 304);
  // An app page carries a fresh wallet nonce, so it is never reused.
  const page = await get("/app/market", { "accept-encoding": "gzip" });
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers.etag, undefined);
});

test("the former help pages open their section of the Docs page", async (t) => {
  const app = createApp(async () => ({}) as never);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  for (const [path, target] of [
    ["/guide", "/docs#jobs"],
    ["/examples", "/docs#examples"],
    ["/trust/", "/docs#trust"],
    ["/about", "/docs#data"],
  ]) {
    const reply = await fetch(base + path, { redirect: "manual" });
    assert.equal(reply.status, 308, path);
    assert.equal(reply.headers.get("location"), target, path);
  }
  const docs = await fetch(base + "/docs");
  assert.equal(docs.status, 200);
  const html = await docs.text();
  // The example cards are gone; the docs list the runs instead.
  assert.doesNotMatch(html, /record-card|workspace-cards/);
  for (const id of [
    "start",
    "jobs",
    "checks",
    "bounties",
    "agents",
    "costs",
    "verify",
    "examples",
    "trust",
    "data",
    "faq",
    "terms",
  ])
    assert.match(html, new RegExp(`id="${id}"`), id);
});
