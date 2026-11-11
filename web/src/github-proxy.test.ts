// The GitHub device-flow proxy: exactly what it sends upstream, what it refuses, and that it logs
// and keeps nothing. A fake `fetch` stands in for GitHub; no real endpoint is called.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createApp } from "./server.ts";
import {
  DEVICE_CODE_URL,
  DEVICE_GRANT,
  DEVICE_TOKEN_URL,
  MAX_REQUEST_BYTES,
  NOT_CONFIGURED,
  WindowLimit,
} from "./github-proxy.ts";

const CLIENT_ID = "Iv23liTestClientId01";
const DEVICE = "3584d83530557fdd1f46af8289938c8ef79f9dc5";
const TOKEN = "ghu_0123456789abcdefghijklmnopqrstuvwxyzAB";

interface Upstream {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}
/** A fake GitHub: records each request and answers with `answer(url)`. */
function fakeGithub(
  answer: (url: string) => Response | Promise<Response> = () =>
    Response.json({}),
) {
  const seen: Upstream[] = [];
  const transport = (async (url: string, init: RequestInit) => {
    seen.push({ url, init, body: JSON.parse(String(init.body)) });
    return answer(url);
  }) as unknown as typeof fetch;
  return { seen, transport };
}

/** Starts the real server with the proxy wired to `transport`, and returns a raw POST helper. */
async function start(
  t: test.TestContext,
  options: {
    transport?: typeof fetch;
    clientId?: string | undefined;
    limit?: number;
  } = {},
) {
  const app = createApp(undefined, undefined, undefined, undefined, {
    fetch: options.transport,
    clientId: "clientId" in options ? options.clientId : CLIENT_ID,
    limit: new WindowLimit(options.limit ?? 1000),
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const port = (app.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const send = (
    path: string,
    body: string | Buffer,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    new Promise<{ status: number; json: Record<string, unknown>; raw: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method,
            headers: {
              host: `127.0.0.1:${port}`,
              origin,
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
              ...headers,
            },
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                raw,
                json: raw ? JSON.parse(raw) : {},
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      },
    );
  return { origin, send };
}

/** Fails the test if anything is logged while it runs. */
function watchConsole(t: test.TestContext) {
  const calls: unknown[][] = [];
  for (const name of [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
  ] as const)
    t.mock.method(console, name, (...args: unknown[]) => void calls.push(args));
  return calls;
}

test("the code route forwards only the client id to GitHub's device-code URL", async (t) => {
  const logged = watchConsole(t);
  const gh = fakeGithub(() =>
    Response.json({
      device_code: DEVICE,
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 899,
      interval: 5,
    }),
  );
  const { send } = await start(t, { transport: gh.transport });
  const res = await send(
    "/api/github/device/code",
    JSON.stringify({
      scope: "gist repo",
      client_id: "attacker",
      client_secret: "s3cret",
      extra: [1],
    }),
    {
      cookie: "session=abc",
      authorization: "Bearer browser-token",
      "x-forwarded-for": "1.2.3.4",
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    device_code: DEVICE,
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    expires_in: 899,
    interval: 5,
  });
  assert.equal(gh.seen.length, 1);
  const up = gh.seen[0] as Upstream;
  assert.equal(up.url, DEVICE_CODE_URL);
  assert.equal(up.url, "https://github.com/login/device/code");
  assert.equal(up.init.method, "POST");
  assert.deepEqual(up.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "proven-github-link",
  });
  assert.deepEqual(up.body, { client_id: CLIENT_ID });
  assert.equal(up.init.redirect, "error");
  assert.deepEqual(logged, []);
});

test("the token route forwards the client id, the device code and the fixed grant type only", async (t) => {
  const logged = watchConsole(t);
  const gh = fakeGithub(() =>
    Response.json({
      access_token: TOKEN,
      token_type: "bearer",
      scope: "",
      expires_in: 28800,
      refresh_token: "ghr_secret",
      refresh_token_expires_in: 15811200,
      unknown: "dropped",
    }),
  );
  const { send } = await start(t, { transport: gh.transport });
  const res = await send(
    "/api/github/device/token",
    JSON.stringify({
      device_code: DEVICE,
      client_id: "attacker",
      client_secret: "s3cret",
      grant_type: "password",
      scope: "repo",
      redirect_uri: "https://evil.example",
    }),
    { cookie: "a=b", authorization: "Bearer x" },
  );
  assert.equal(res.status, 200);
  // The access token passes through; the refresh token and unknown fields do not.
  assert.deepEqual(res.json, {
    access_token: TOKEN,
    token_type: "bearer",
    expires_in: 28800,
  });
  const up = gh.seen[0] as Upstream;
  assert.equal(up.url, DEVICE_TOKEN_URL);
  assert.equal(up.url, "https://github.com/login/oauth/access_token");
  assert.equal(up.init.method, "POST");
  assert.deepEqual(up.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "proven-github-link",
  });
  assert.deepEqual(up.body, {
    client_id: CLIENT_ID,
    device_code: DEVICE,
    grant_type: DEVICE_GRANT,
  });
  assert.equal(DEVICE_GRANT, "urn:ietf:params:oauth:grant-type:device_code");
  assert.ok(!JSON.stringify(up).includes("s3cret"));
  assert.deepEqual(logged, []);
});

test("GitHub's polling answers pass through as ordinary JSON", async (t) => {
  for (const error of [
    "authorization_pending",
    "slow_down",
    "expired_token",
    "access_denied",
  ]) {
    const gh = fakeGithub(() =>
      Response.json({ error, error_description: "text", interval: 10 }),
    );
    const { send } = await start(t, { transport: gh.transport });
    const res = await send(
      "/api/github/device/token",
      JSON.stringify({ device_code: DEVICE }),
    );
    assert.equal(res.status, 200, error);
    assert.deepEqual(
      res.json,
      { error, error_description: "text", interval: 10 },
      error,
    );
  }
});

test("a foreign or missing origin, or a cross-site fetch, is refused before GitHub is called", async (t) => {
  const gh = fakeGithub();
  const { send, origin } = await start(t, { transport: gh.transport });
  const body = JSON.stringify({ device_code: DEVICE });
  for (const [label, headers] of [
    ["foreign origin", { origin: "https://evil.example" }],
    ["same host, another port", { origin: "http://127.0.0.1:1" }],
    ["localhost spelling of another origin", { origin: "http://localhost:1" }],
    ["null origin", { origin: "null" }],
    ["cross-site fetch", { "sec-fetch-site": "cross-site" }],
    ["same-site fetch", { "sec-fetch-site": "same-site" }],
  ] as [string, Record<string, string>][]) {
    const res = await send("/api/github/device/token", body, headers);
    assert.ok(res.status === 403, `${label}: ${res.status}`);
  }
  // No Origin header at all: send it raw, without the helper's default.
  const port = Number(new URL(origin).port);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/github/device/token",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(status, 403);
  assert.deepEqual(gh.seen, []);
  // Another Host header is refused by the server before the proxy sees it.
  const other = await send("/api/github/device/token", body, {
    host: "evil.example",
  });
  assert.equal(other.status, 403);
  assert.deepEqual(gh.seen, []);
});

test("only POST reaches the proxy, and no other path is forwarded", async (t) => {
  const gh = fakeGithub();
  const { send } = await start(t, { transport: gh.transport });
  const get = await send("/api/github/device/code", "", {}, "GET");
  assert.equal(get.status, 405);
  const put = await send("/api/github/device/code", "{}", {}, "PUT");
  assert.equal(put.status, 405);
  for (const path of [
    "/api/github/device",
    "/api/github/device/code/x",
    "/api/github/user",
    "/api/github/../market",
  ]) {
    const res = await send(path, "{}");
    assert.ok(res.status >= 400, path);
  }
  assert.deepEqual(gh.seen, []);
});

test("with no client id configured the routes answer 503 and call nobody", async (t) => {
  const saved = process.env.PROVEN_GITHUB_CLIENT_ID;
  delete process.env.PROVEN_GITHUB_CLIENT_ID;
  t.after(() => {
    if (saved !== undefined) process.env.PROVEN_GITHUB_CLIENT_ID = saved;
  });
  const gh = fakeGithub();
  const { send } = await start(t, {
    transport: gh.transport,
    clientId: undefined,
  });
  for (const path of ["/api/github/device/code", "/api/github/device/token"]) {
    const res = await send(path, JSON.stringify({ device_code: DEVICE }));
    assert.equal(res.status, 503, path);
    assert.deepEqual(res.json, { error: NOT_CONFIGURED });
  }
  assert.equal(NOT_CONFIGURED, "GitHub linking is not configured");
  // An id with odd characters is not used either.
  const odd = await start(t, { transport: gh.transport, clientId: "a b&c=d" });
  assert.equal((await odd.send("/api/github/device/code", "{}")).status, 503);
  assert.deepEqual(gh.seen, []);
});

test("the environment variable supplies the client id when none is injected", async (t) => {
  const saved = process.env.PROVEN_GITHUB_CLIENT_ID;
  process.env.PROVEN_GITHUB_CLIENT_ID = "Iv23liFromTheEnvironment";
  t.after(() => {
    if (saved === undefined) delete process.env.PROVEN_GITHUB_CLIENT_ID;
    else process.env.PROVEN_GITHUB_CLIENT_ID = saved;
  });
  const gh = fakeGithub();
  const app = createApp(undefined, undefined, undefined, undefined, {
    fetch: gh.transport,
    limit: new WindowLimit(10),
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const port = (app.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/github/device/code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://127.0.0.1:${port}`,
    },
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.deepEqual((gh.seen[0] as Upstream).body, {
    client_id: "Iv23liFromTheEnvironment",
  });
});

test("request bodies are small, JSON and complete", async (t) => {
  const gh = fakeGithub();
  const { send } = await start(t, { transport: gh.transport });
  const path = "/api/github/device/token";
  const big = JSON.stringify({
    device_code: DEVICE,
    pad: "x".repeat(MAX_REQUEST_BYTES),
  });
  assert.equal((await send(path, big)).status, 413);
  // The limit counts bytes, not characters.
  const wide = JSON.stringify({ device_code: DEVICE, pad: "é".repeat(1100) });
  assert.ok(
    wide.length < MAX_REQUEST_BYTES &&
      Buffer.byteLength(wide) > MAX_REQUEST_BYTES,
  );
  assert.equal((await send(path, wide)).status, 413);
  assert.equal(
    (await send(path, "{}", { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal((await send(path, "not json")).status, 400);
  assert.equal((await send(path, "[]")).status, 400);
  assert.equal((await send(path, "{}")).status, 400, "no device code");
  for (const device_code of [
    1,
    null,
    "",
    "short",
    "has space in it!!",
    "x".repeat(200),
  ])
    assert.equal(
      (await send(path, JSON.stringify({ device_code }))).status,
      400,
      String(device_code),
    );
  assert.deepEqual(gh.seen, []);
});

test("a per-process rate limit answers 429 without calling GitHub", async (t) => {
  const gh = fakeGithub();
  const { send } = await start(t, { transport: gh.transport, limit: 3 });
  const body = JSON.stringify({ device_code: DEVICE });
  for (let i = 0; i < 3; i++)
    assert.equal((await send("/api/github/device/token", body)).status, 200);
  assert.equal((await send("/api/github/device/token", body)).status, 429);
  assert.equal((await send("/api/github/device/code", "{}")).status, 429);
  assert.equal(gh.seen.length, 3);
});

test("the sliding window forgets old requests", () => {
  const limit = new WindowLimit(2, 1000);
  assert.ok(limit.allow(0));
  assert.ok(limit.allow(10));
  assert.ok(!limit.allow(999));
  assert.ok(limit.allow(1000));
  assert.ok(!limit.allow(1005));
  assert.ok(limit.allow(2010));
});

test("GitHub failures become short JSON errors that name nothing from the request", async (t) => {
  const logged = watchConsole(t);
  const cases: [string, () => Response | Promise<Response>, number][] = [
    [
      "network failure",
      () => Promise.reject(new TypeError(`fetch failed ${TOKEN}`)),
      502,
    ],
    ["not JSON", () => new Response("<html>nope</html>"), 502],
    ["a JSON array", () => Response.json([1]), 502],
    [
      "HTTP 404 without an error code",
      () => new Response("{}", { status: 404 }),
      502,
    ],
    [
      "an oversized reply",
      () => new Response(`{"error":"${"x".repeat(20_000)}"}`),
      502,
    ],
  ];
  for (const [label, answer, status] of cases) {
    const gh = fakeGithub(answer);
    const { send } = await start(t, { transport: gh.transport });
    const res = await send(
      "/api/github/device/token",
      JSON.stringify({ device_code: DEVICE }),
    );
    assert.equal(res.status, status, label);
    assert.equal(typeof res.json.error, "string", label);
    assert.ok(!res.raw.includes(TOKEN) && !res.raw.includes(DEVICE), label);
    assert.ok(!res.raw.includes(CLIENT_ID), label);
  }
  // A 4xx that carries GitHub's own error code keeps it.
  const gh = fakeGithub(() =>
    Response.json({ error: "device_flow_disabled" }, { status: 400 }),
  );
  const { send } = await start(t, { transport: gh.transport });
  const res = await send("/api/github/device/code", "{}");
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, { error: "device_flow_disabled" });
  assert.deepEqual(logged, []);
});

test("an access token is returned once and is not in any later answer or log", async (t) => {
  const logged = watchConsole(t);
  let calls = 0;
  const gh = fakeGithub(() =>
    ++calls === 1
      ? Response.json({ access_token: TOKEN, token_type: "bearer" })
      : Response.json({ error: "expired_token" }),
  );
  const { send } = await start(t, { transport: gh.transport });
  const body = JSON.stringify({ device_code: DEVICE });
  const first = await send("/api/github/device/token", body);
  assert.equal(first.json.access_token, TOKEN);
  const second = await send("/api/github/device/token", body);
  assert.ok(!second.raw.includes(TOKEN));
  assert.deepEqual(logged, []);
});

test("the proxy's source has no logging, storage or secrets", () => {
  const source = readFileSync(
    new URL("./github-proxy.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "console.",
    "process.stdout",
    "process.stderr",
    "writeFile",
    "appendFile",
    "client_secret",
    "scope",
    "Cookie",
    "cookie",
  ])
    assert.ok(
      !source.replace(/\/\/.*$/gm, "").includes(forbidden),
      `${forbidden} appears in github-proxy.ts`,
    );
});
