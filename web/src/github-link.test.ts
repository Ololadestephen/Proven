// The browser's one-time GitHub connection, with a fake network and a fake clock. No real GitHub
// endpoint is called and no sleep is real except in the one test of the default sleep.
import assert from "node:assert/strict";
import test from "node:test";
import {
  GIST_DESCRIPTION,
  GIST_FILE,
  GithubLinkError,
  connect,
  createLinkGist,
  fetchGithubId,
  linkErrorMessage,
  pollForToken,
  startDeviceFlow,
  type ConnectOptions,
  type DeviceStart,
  type GithubLinkErrorCode,
  type TokenSession,
} from "../ui/github-link.ts";

const DEVICE = "3584d83530557fdd1f46af8289938c8ef79f9dc5";
const TOKEN = "ghu_0123456789abcdefghijklmnopqrstuvwxyzAB";
const CHALLENGE = `proven-link:${"ab".repeat(32)}`;
const GIST = "aa5a315d61ae9438b18d";
const GITHUB_ID = 583231;
const START = {
  device_code: DEVICE,
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 899,
  interval: 5,
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  init: RequestInit;
}
type Reply = Response | Error;
/** A fake network. `script` answers by URL; each answer may be a list consumed in order. */
function network(
  script: Record<string, Reply | Reply[] | ((seen: Seen) => Reply)>,
) {
  const seen: Seen[] = [];
  const left = new Map<string, Reply[]>();
  const transport = (async (url: string, init: RequestInit = {}) => {
    const entry: Seen = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body ? JSON.parse(String(init.body)) : null,
      init,
    };
    seen.push(entry);
    const key = `${entry.method} ${url}`;
    const scripted = script[key];
    if (scripted === undefined) throw new Error(`unexpected request: ${key}`);
    let answer: Reply | undefined;
    if (typeof scripted === "function") answer = scripted(entry);
    else if (Array.isArray(scripted)) {
      if (!left.has(key)) left.set(key, [...scripted]);
      const queue = left.get(key) as Reply[];
      answer = queue.length > 1 ? queue.shift() : queue[0];
    } else answer = scripted;
    if (answer instanceof Error) throw answer;
    return (answer as Response).clone();
  }) as typeof fetch;
  return { seen, transport };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const CODE = "POST /api/github/device/code";
const TOKEN_POLL = "POST /api/github/device/token";
const USER = "GET https://api.github.com/user";
const GISTS = "POST https://api.github.com/gists";
const pending = () => json({ error: "authorization_pending" });
const granted = () => json({ access_token: TOKEN, token_type: "bearer" });
const gistReply = (over: Record<string, unknown> = {}) =>
  json(
    {
      id: GIST,
      public: false,
      owner: { id: GITHUB_ID },
      files: {
        [GIST_FILE]: { content: CHALLENGE, truncated: false },
      },
      ...over,
    },
    201,
  );
const happy = () => ({
  [CODE]: json(START),
  [TOKEN_POLL]: granted(),
  [USER]: json({ id: GITHUB_ID, login: "someone" }),
  [GISTS]: gistReply(),
});

/** A clock that only moves when the fake sleep is called, and a sleep that honors the signal. */
function clock(startMs = 1_000_000) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    advance: (ms: number) => void (now += ms),
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted)
        throw new GithubLinkError("cancelled", "The connection was cancelled.");
      sleeps.push(ms);
      now += ms;
    },
  };
}
const start = (over: Partial<DeviceStart> = {}): DeviceStart => ({
  deviceCode: DEVICE,
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresIn: 899,
  interval: 5,
  ...over,
});
const codeOf = async (run: Promise<unknown>): Promise<GithubLinkErrorCode> => {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof GithubLinkError, String(error));
    return error.code;
  }
  throw new Error("expected a GithubLinkError");
};

/** Recording fakes for every place a token could be stored or leaked. */
function leaks(t: test.TestContext) {
  const writes: string[] = [];
  const store = (name: string) => ({
    getItem: () => null,
    setItem: (k: string, v: string) => void writes.push(`${name}:${k}=${v}`),
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  });
  const g = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(
    ["localStorage", "sessionStorage", "document"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  const define = (k: string, value: unknown) =>
    Object.defineProperty(globalThis, k, {
      value,
      configurable: true,
      writable: true,
    });
  define("localStorage", store("localStorage"));
  define("sessionStorage", store("sessionStorage"));
  define("document", {
    get cookie() {
      return "";
    },
    set cookie(v: string) {
      writes.push(`cookie:${v}`);
    },
  });
  t.after(() => {
    for (const [k, d] of Object.entries(saved))
      if (d) Object.defineProperty(globalThis, k, d);
      else delete g[k];
  });
  const logged: unknown[][] = [];
  for (const name of [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
  ] as const)
    t.mock.method(console, name, (...a: unknown[]) => void logged.push(a));
  return { writes, logged };
}

/** The token may appear in an Authorization header to api.github.com and nowhere else. */
function assertTokenOnlyAtGithubApi(seen: Seen[]) {
  for (const s of seen) {
    const authorization = s.headers.Authorization;
    const where = `${s.method} ${s.url}`;
    assert.ok(!s.url.includes(TOKEN), `${where}: token in the URL`);
    assert.ok(
      !JSON.stringify(s.body ?? {}).includes(TOKEN),
      `${where}: token in the body`,
    );
    const others = Object.entries(s.headers).filter(
      ([k]) => k !== "Authorization",
    );
    assert.ok(
      !JSON.stringify(others).includes(TOKEN),
      `${where}: token in a header`,
    );
    if (authorization !== undefined) {
      assert.equal(authorization, `Bearer ${TOKEN}`, where);
      assert.ok(
        s.url.startsWith("https://api.github.com/"),
        `${where}: wrong host`,
      );
      assert.equal(s.init.credentials, "omit", where);
      assert.equal(s.init.redirect, "error", where);
    }
  }
}

function options(
  net: ReturnType<typeof network>,
  c: ReturnType<typeof clock>,
  over: Partial<ConnectOptions> = {},
): ConnectOptions & {
  codes: DeviceStart[];
  steps: string[];
  session: TokenSession;
} {
  const codes: DeviceStart[] = [];
  const steps: string[] = [];
  const session: TokenSession = { token: null };
  return {
    fetch: net.transport,
    now: c.now,
    sleep: c.sleep,
    onDeviceCode: (s) => void codes.push(s),
    onStep: (s) => void steps.push(s),
    getChallenge: async () => CHALLENGE,
    session,
    codes,
    steps,
    ...over,
  };
}

test("the whole connection, step by step, returns the gist and the GitHub id", async (t) => {
  const { writes, logged } = leaks(t);
  const net = network({
    ...happy(),
    [TOKEN_POLL]: [pending(), pending(), granted()],
  });
  const c = clock();
  const o = options(net, c);
  let tokenWhileRunning: string | null = null;
  const result = await connect({
    ...o,
    getChallenge: async (id) => {
      tokenWhileRunning = o.session.token;
      assert.equal(
        id,
        GITHUB_ID,
        "the challenge is asked for after the account is known",
      );
      return CHALLENGE;
    },
  });
  assert.deepEqual(result, { gistId: GIST, githubId: GITHUB_ID });
  assert.deepEqual(o.steps, ["code", "approval", "account", "gist"]);
  assert.equal(o.codes[0]?.userCode, "WDJB-MJHT");
  assert.equal(o.codes[0]?.verificationUri, "https://github.com/login/device");
  // GitHub's interval is waited before every poll.
  assert.deepEqual(c.sleeps, [5000, 5000, 5000]);
  assert.deepEqual(
    net.seen.map((s) => `${s.method} ${s.url}`),
    [CODE, TOKEN_POLL, TOKEN_POLL, TOKEN_POLL, USER, GISTS],
  );
  // The proxy gets the device code and nothing else.
  assert.deepEqual(net.seen[0]?.body, {});
  assert.deepEqual(net.seen[1]?.body, { device_code: DEVICE });
  assert.equal(net.seen[1]?.init.credentials, "same-origin");
  // /user
  const user = net.seen[4] as Seen;
  assert.deepEqual(user.headers, {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
  // One secret gist with one file holding exactly the challenge.
  const gist = net.seen[5] as Seen;
  assert.deepEqual(gist.body, {
    description: "Proven wallet link",
    public: false,
    files: { "proven-wallet-link.txt": { content: CHALLENGE } },
  });
  assert.equal(GIST_DESCRIPTION, "Proven wallet link");
  assert.equal(GIST_FILE, "proven-wallet-link.txt");
  assertTokenOnlyAtGithubApi(net.seen);
  // The token was held only during the call.
  assert.equal(tokenWhileRunning, TOKEN);
  assert.equal(o.session.token, null);
  assert.deepEqual(writes, [], "nothing written to storage or cookies");
  assert.deepEqual(logged, [], "nothing logged");
});

test("the token is dropped and never stored or logged when any step fails", async (t) => {
  const { writes, logged } = leaks(t);
  const failures: [
    string,
    Record<string, Reply | Reply[]>,
    GithubLinkErrorCode,
  ][] = [
    [
      "start fails",
      { ...happy(), [CODE]: new TypeError("offline") },
      "unreachable",
    ],
    [
      "denied",
      { ...happy(), [TOKEN_POLL]: json({ error: "access_denied" }) },
      "denied",
    ],
    ["user 401", { ...happy(), [USER]: json({}, 401) }, "token_rejected"],
    [
      "user unreadable",
      { ...happy(), [USER]: json({ id: "x" }) },
      "bad_answer",
    ],
    ["gist refused", { ...happy(), [GISTS]: json({}, 403) }, "gist_refused"],
    [
      "gist network",
      { ...happy(), [GISTS]: new TypeError(`offline ${TOKEN}`) },
      "unreachable",
    ],
    [
      "wrong owner",
      { ...happy(), [GISTS]: gistReply({ owner: { id: 1 } }) },
      "owner_mismatch",
    ],
  ];
  for (const [label, script, code] of failures) {
    const net = network(script);
    const o = options(net, clock());
    const error = await connect(o).catch((e) => e);
    assert.ok(error instanceof GithubLinkError, label);
    assert.equal(error.code, code, label);
    assert.ok(
      !error.message.includes(TOKEN),
      `${label}: the message names the token`,
    );
    assert.equal(o.session.token, null, `${label}: the token is dropped`);
    assertTokenOnlyAtGithubApi(net.seen);
  }
  // A failure inside the page's own challenge step also drops the token and creates no gist.
  const net = network(happy());
  const o = options(net, clock(), {
    getChallenge: async () => {
      throw new Error("The wallet's link challenge could not be read.");
    },
  });
  await assert.rejects(connect(o), /link challenge/);
  assert.equal(o.session.token, null);
  assert.ok(!net.seen.some((s) => s.url.endsWith("/gists")));
  assert.deepEqual(writes, []);
  assert.deepEqual(logged, []);
});

test("polling honors the interval and slows down when GitHub says so", async () => {
  const net = network({
    [TOKEN_POLL]: [
      pending(),
      json({ error: "slow_down", interval: 10 }),
      pending(),
      json({ error: "slow_down" }),
      granted(),
    ],
  });
  const c = clock();
  const waits: unknown[] = [];
  const token = await pollForToken(start(), {
    fetch: net.transport,
    now: c.now,
    sleep: c.sleep,
    onWait: (w) => void waits.push(w),
  });
  assert.equal(token, TOKEN);
  // 5, 5, then 10 as GitHub said, 10 again, then +5 because no interval was given.
  assert.deepEqual(c.sleeps, [5000, 5000, 10000, 10000, 15000]);
  assert.deepEqual(waits[0], { attempt: 1, waitSecs: 5, slowedDown: false });
  assert.deepEqual(waits[4], { attempt: 5, waitSecs: 15, slowedDown: true });
});

test("a slow_down that names a shorter interval still adds five seconds", async () => {
  const net = network({
    [TOKEN_POLL]: [json({ error: "slow_down", interval: 2 }), granted()],
  });
  const c = clock();
  await pollForToken(start(), {
    fetch: net.transport,
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(c.sleeps, [5000, 10000]);
});

test("the proxy's own 429 slows the poll instead of ending it", async () => {
  const net = network({
    [TOKEN_POLL]: [json({ error: "Too many requests." }, 429), granted()],
  });
  const c = clock();
  await pollForToken(start(), {
    fetch: net.transport,
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(c.sleeps, [5000, 10000]);
});

test("expired and denied answers end the poll with their own errors", async () => {
  for (const [error, code] of [
    ["expired_token", "expired"],
    ["access_denied", "denied"],
    ["incorrect_device_code", "bad_answer"],
    ["device_flow_disabled", "bad_answer"],
  ] as const) {
    const net = network({ [TOKEN_POLL]: json({ error }) });
    const c = clock();
    assert.equal(
      await codeOf(
        pollForToken(start(), {
          fetch: net.transport,
          now: c.now,
          sleep: c.sleep,
        }),
      ),
      code,
      error,
    );
    assert.equal(net.seen.length, 1, `${error}: no further polls`);
  }
});

test("the code's own lifetime ends the poll even if GitHub keeps saying pending", async () => {
  const net = network({ [TOKEN_POLL]: pending() });
  const c = clock();
  const code = await codeOf(
    pollForToken(start({ expiresIn: 20 }), {
      fetch: net.transport,
      now: c.now,
      sleep: c.sleep,
    }),
  );
  assert.equal(code, "expired");
  // Polls at 5, 10 and 15 seconds; the one due at 20 is not made.
  assert.equal(net.seen.length, 3);
});

test("a dropped connection is retried a few times, then reported", async () => {
  const offline = new TypeError("offline");
  const ok = network({ [TOKEN_POLL]: [offline, offline, granted()] });
  const c = clock();
  assert.equal(
    await pollForToken(start(), {
      fetch: ok.transport,
      now: c.now,
      sleep: c.sleep,
    }),
    TOKEN,
  );
  // Failures that are not consecutive do not add up.
  const mixed = network({
    [TOKEN_POLL]: [offline, offline, pending(), offline, offline, granted()],
  });
  assert.equal(
    await pollForToken(start(), {
      fetch: mixed.transport,
      now: clock().now,
      sleep: clock().sleep,
    }),
    TOKEN,
  );
  const dead = network({ [TOKEN_POLL]: offline });
  const c2 = clock();
  assert.equal(
    await codeOf(
      pollForToken(start(), {
        fetch: dead.transport,
        now: c2.now,
        sleep: c2.sleep,
      }),
    ),
    "unreachable",
  );
  assert.equal(dead.seen.length, 3);
});

test("a poll can be cancelled while waiting, before a request, and with a real timer", async () => {
  const net = network({ [TOKEN_POLL]: pending() });
  const c = clock();
  const controller = new AbortController();
  const run = pollForToken(start(), {
    fetch: net.transport,
    now: c.now,
    sleep: c.sleep,
    signal: controller.signal,
    onWait: (w) => {
      if (w.attempt === 3) controller.abort();
    },
  });
  assert.equal(await codeOf(run), "cancelled");
  assert.equal(net.seen.length, 2, "no request after the cancel");
  // Already cancelled: nothing is sent at all.
  const before = new AbortController();
  before.abort();
  const none = network({});
  assert.equal(
    await codeOf(
      connect({
        ...options(none, clock()),
        signal: before.signal,
      }),
    ),
    "cancelled",
  );
  assert.deepEqual(none.seen, []);
  // The default sleep is cancellable and does not wait out its time.
  const live = new AbortController();
  const quick = pollForToken(start({ interval: 60 }), {
    fetch: net.transport,
    signal: live.signal,
  });
  setTimeout(() => live.abort(), 10);
  assert.equal(await codeOf(quick), "cancelled");
});

test("cancelling during connect drops the token", async () => {
  const controller = new AbortController();
  const net = network({
    ...happy(),
    [USER]: () => {
      controller.abort();
      return json({ id: GITHUB_ID });
    },
  });
  const o = options(net, clock(), { signal: controller.signal });
  assert.equal(await codeOf(connect(o)), "cancelled");
  assert.equal(o.session.token, null);
  assert.ok(!net.seen.some((s) => s.url.endsWith("/gists")));
});

test("starting the flow checks the answer and says why it failed", async () => {
  const bad = async (script: Reply) =>
    codeOf(startDeviceFlow({ fetch: network({ [CODE]: script }).transport }));
  assert.equal(await bad(json({}, 503)), "not_configured");
  assert.equal(await bad(json({ error: "x" }, 429)), "rate_limited");
  assert.equal(await bad(new TypeError("offline")), "unreachable");
  assert.equal(
    await bad(new Response("<html>", { status: 502 })),
    "bad_answer",
  );
  assert.equal(
    await bad(json({ error: "device_flow_disabled" }, 502)),
    "bad_answer",
  );
  assert.equal(await bad(json({ ...START, device_code: "no" })), "bad_answer");
  assert.equal(
    await bad(json({ ...START, user_code: undefined })),
    "bad_answer",
  );
  assert.equal(await bad(json({ ...START, expires_in: 0 })), "bad_answer");
  assert.equal(await bad(json({ ...START, expires_in: 99999 })), "bad_answer");
  // The page shows this link, so it must lead to GitHub over HTTPS.
  for (const uri of [
    "https://github.com.evil.example/login/device",
    "http://github.com/login/device",
    "javascript:alert(1)",
    "not a url",
  ])
    assert.equal(
      await bad(json({ ...START, verification_uri: uri })),
      "bad_answer",
      uri,
    );
  const ok = await startDeviceFlow({
    fetch: network({ [CODE]: json(START) }).transport,
  });
  assert.deepEqual(ok, {
    deviceCode: DEVICE,
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresIn: 899,
    interval: 5,
  });
  // An odd interval falls back to five seconds.
  const odd = await startDeviceFlow({
    fetch: network({ [CODE]: json({ ...START, interval: -3 }) }).transport,
  });
  assert.equal(odd.interval, 5);
});

test("the GitHub id must be a positive integer", async () => {
  const ask = (reply: Reply) =>
    fetchGithubId(TOKEN, { fetch: network({ [USER]: reply }).transport });
  assert.equal(await ask(json({ id: 42 })), 42);
  for (const bad of [
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: "42" },
    { id: null },
    {},
    [],
  ])
    assert.equal(
      await codeOf(ask(json(bad))),
      "bad_answer",
      JSON.stringify(bad),
    );
  assert.equal(await codeOf(ask(json({}, 401))), "token_rejected");
  assert.equal(await codeOf(ask(json({ id: 1 }, 500))), "bad_answer");
  assert.equal(await codeOf(ask(new TypeError("offline"))), "unreachable");
  assert.equal(await codeOf(ask(new Response("nope"))), "bad_answer");
});

test("a refused gist points the owner to the app's Gists permission", async () => {
  for (const status of [403, 404]) {
    const net = network({
      [GISTS]: json({ message: "Resource not accessible" }, status),
    });
    const error = await createLinkGist(TOKEN, CHALLENGE, GITHUB_ID, {
      fetch: net.transport,
    }).catch((e) => e);
    assert.ok(error instanceof GithubLinkError);
    assert.equal(error.code, "gist_refused");
    assert.match(error.message, /Gists/);
    assert.match(error.message, /Read and write/);
  }
  const other = await createLinkGist(TOKEN, CHALLENGE, GITHUB_ID, {
    fetch: network({ [GISTS]: json({}, 422) }).transport,
  }).catch((e) => e);
  assert.equal(other.code, "gist_refused");
  assert.match(other.message, /422/);
});

test("the gist GitHub returns must match what was asked for", async () => {
  const make = (reply: Reply) =>
    createLinkGist(TOKEN, CHALLENGE, GITHUB_ID, {
      fetch: network({ [GISTS]: reply }).transport,
    });
  assert.deepEqual(await make(gistReply()), {
    gistId: GIST,
    githubId: GITHUB_ID,
  });
  const file = (over: Record<string, unknown>) => ({
    [GIST_FILE]: { content: CHALLENGE, ...over },
  });
  const mismatches: [string, Record<string, unknown>][] = [
    ["another owner", { owner: { id: GITHUB_ID + 1 } }],
    ["no owner", { owner: null }],
    ["owner id as text", { owner: { id: String(GITHUB_ID) } }],
    ["two files", { files: { ...file({}), "other.txt": { content: "x" } } }],
    ["no files", { files: {} }],
    ["another file name", { files: { "other.txt": { content: CHALLENGE } } }],
    ["another content", { files: file({ content: `${CHALLENGE}\n` }) }],
    ["truncated content", { files: file({ truncated: true }) }],
    ["a public gist", { public: true }],
  ];
  for (const [label, over] of mismatches)
    assert.equal(await codeOf(make(gistReply(over))), "owner_mismatch", label);
  for (const id of ["ABCDEF0123456789", "xyz", "", 12345678, "a".repeat(65)])
    assert.equal(
      await codeOf(make(gistReply({ id }))),
      "bad_answer",
      String(id),
    );
  assert.equal(await codeOf(make(json({ id: GIST }, 200))), "bad_answer");
  assert.equal(await codeOf(make(json({}, 500))), "bad_answer");
  assert.equal(await codeOf(make(json({}, 401))), "token_rejected");
});

test("every error code has a plain message, and the messages never carry request data", () => {
  const codes: GithubLinkErrorCode[] = [
    "not_configured",
    "rate_limited",
    "denied",
    "expired",
    "unreachable",
    "bad_answer",
    "token_rejected",
    "gist_refused",
    "owner_mismatch",
    "cancelled",
  ];
  for (const code of codes) {
    const message = linkErrorMessage(code);
    assert.ok(message.length > 20, code);
    assert.ok(!message.includes(TOKEN) && !message.includes(DEVICE), code);
  }
  assert.match(linkErrorMessage("denied"), /did not approve/);
  assert.match(linkErrorMessage("expired"), /expired/);
  assert.match(linkErrorMessage("unreachable"), /could not be reached/);
  assert.match(linkErrorMessage("gist_refused"), /Gists/);
  assert.match(linkErrorMessage("owner_mismatch"), /does not belong/);
});
