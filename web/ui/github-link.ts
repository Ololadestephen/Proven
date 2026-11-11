// The browser side of the one-time GitHub connection. A contributor proves that a NEAR wallet and
// a GitHub account belong together by creating one secret gist that holds the contract's link
// challenge. The steps:
//   1. start GitHub's device flow through this server's proxy (github.com sends no CORS headers);
//   2. poll the proxy until the person approves the app, honoring GitHub's interval and slow_down;
//   3. read the account's numeric id from api.github.com;
//   4. create one secret gist whose only file is the challenge, and check what came back.
// The access token lives in one `connect` call. It goes only to api.github.com in an
// Authorization header, is never written to storage, a cookie, a URL or a log, and is set to
// null when the call ends, whether it succeeded or not. Every network call and the clock are
// injectable.

export const PROXY_CODE_PATH = "/api/github/device/code";
export const PROXY_TOKEN_PATH = "/api/github/device/token";
export const GITHUB_API = "https://api.github.com";
export const GIST_FILE = "proven-wallet-link.txt";
export const GIST_DESCRIPTION = "Proven wallet link";
const GIST_ID = /^[0-9a-f]{8,64}$/;

export type GithubLinkErrorCode =
  | "not_configured"
  | "rate_limited"
  | "denied"
  | "expired"
  | "unreachable"
  | "bad_answer"
  | "token_rejected"
  | "gist_refused"
  | "owner_mismatch"
  | "cancelled";

/** An error with a code the page can branch on and a message it can show as written. */
export class GithubLinkError extends Error {
  readonly code: GithubLinkErrorCode;
  constructor(code: GithubLinkErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: GithubLinkErrorCode, message: string) =>
  new GithubLinkError(code, message);

const MESSAGES = {
  not_configured:
    "GitHub linking is not set up on this server. The owner needs to add the GitHub App's client id.",
  rate_limited: "GitHub linking is busy. Wait a minute and try again.",
  denied:
    "You did not approve the connection on GitHub. Start again and choose Authorize.",
  expired:
    "The GitHub code expired before it was approved. Start again to get a new one.",
  unreachable:
    "GitHub could not be reached. Check your connection and try again. Nothing was created.",
  bad_answer: "GitHub sent an answer this page cannot use. Try again later.",
  token_rejected:
    "GitHub rejected the permission it just gave. Start again and approve the connection.",
  gist_refused:
    "GitHub refused to create the gist. Check that the GitHub App's account permission Gists is set to Read and write, then start again.",
  owner_mismatch:
    "The gist GitHub created does not belong to the account that approved the connection, or does not hold the expected text. Nothing was linked.",
  cancelled: "The connection was cancelled.",
} as const satisfies Record<GithubLinkErrorCode, string>;
export const linkErrorMessage = (code: GithubLinkErrorCode) => MESSAGES[code];
const failWith = (code: GithubLinkErrorCode, detail = "") =>
  fail(code, detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);

export interface LinkEnv {
  /** Used for the proxy and for api.github.com. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds, as `Date.now`. */
  now?: () => number;
  /** Resolves after `ms`; rejects when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}
const transport = (env: LinkEnv) => env.fetch ?? fetch;
const clock = (env: LinkEnv) => env.now ?? Date.now;
const pause = (env: LinkEnv) => env.sleep ?? defaultSleep;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail("cancelled", MESSAGES.cancelled));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(fail("cancelled", MESSAGES.cancelled));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
const cancelled = (env: LinkEnv) => {
  if (env.signal?.aborted) throw fail("cancelled", MESSAGES.cancelled);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const positiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** One JSON POST to this server's proxy. Returns the body and the HTTP status. */
async function proxy(
  path: string,
  body: Record<string, unknown>,
  env: LinkEnv,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await transport(env)(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: env.signal,
    });
  } catch {
    cancelled(env);
    throw failWith("unreachable");
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.status === 503) throw failWith("not_configured");
  if (res.status === 429 && !isObject(parsed)) throw failWith("rate_limited");
  if (!isObject(parsed)) throw failWith("bad_answer");
  return { status: res.status, body: parsed };
}

export interface DeviceStart {
  deviceCode: string;
  /** What the person types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Seconds the code stays valid. */
  expiresIn: number;
  /** Seconds to wait between polls. */
  interval: number;
}

/** Step 1: asks GitHub (through the proxy) for a device code and a user code. */
export async function startDeviceFlow(env: LinkEnv = {}): Promise<DeviceStart> {
  cancelled(env);
  const { status, body } = await proxy(PROXY_CODE_PATH, {}, env);
  if (status === 429) throw failWith("rate_limited");
  const { device_code, user_code, verification_uri, expires_in, interval } =
    body;
  if (
    status !== 200 ||
    typeof device_code !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(device_code) ||
    typeof user_code !== "string" ||
    !/^[A-Za-z0-9-]{4,32}$/.test(user_code) ||
    typeof verification_uri !== "string" ||
    !positiveInt(expires_in) ||
    expires_in > 3600
  )
    throw failWith(
      "bad_answer",
      typeof body.error === "string" ? body.error : undefined,
    );
  // The link is shown to the person: it must lead to GitHub.
  let host = "";
  try {
    const url = new URL(verification_uri);
    host = url.protocol === "https:" ? url.hostname : "";
  } catch {
    host = "";
  }
  if (host !== "github.com") throw failWith("bad_answer");
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    expiresIn: expires_in,
    interval: positiveInt(interval) && interval <= 60 ? interval : 5,
  };
}

/** What a poll is doing, for the page to show. */
export interface PollStatus {
  attempt: number;
  /** Seconds until the next poll. */
  waitSecs: number;
  slowedDown: boolean;
}
export interface PollOptions extends LinkEnv {
  onWait?: (status: PollStatus) => void;
}
const MAX_TRANSIENT = 3;

/**
 * Step 2: polls until the person approves. Waits `interval` seconds before each poll; on
 * `slow_down` waits longer from then on; stops on `expired_token`, `access_denied`, the code's
 * own lifetime, or the signal. Returns the access token.
 */
export async function pollForToken(
  start: DeviceStart,
  env: PollOptions = {},
): Promise<string> {
  const startedAt = clock(env)();
  const deadline = startedAt + start.expiresIn * 1000;
  let interval = start.interval;
  let slowedDown = false;
  let transient = 0;
  for (let attempt = 1; ; attempt++) {
    cancelled(env);
    env.onWait?.({ attempt, waitSecs: interval, slowedDown });
    await pause(env)(interval * 1000, env.signal);
    cancelled(env);
    if (clock(env)() >= deadline) throw failWith("expired");
    let answer: { status: number; body: Record<string, unknown> };
    try {
      answer = await proxy(
        PROXY_TOKEN_PATH,
        { device_code: start.deviceCode },
        env,
      );
    } catch (error) {
      // A dropped connection is worth a few more tries; anything else is final.
      if (
        error instanceof GithubLinkError &&
        error.code === "unreachable" &&
        ++transient < MAX_TRANSIENT
      )
        continue;
      throw error;
    }
    transient = 0;
    const { status, body } = answer;
    if (status === 429) {
      interval += 5;
      slowedDown = true;
      continue;
    }
    const token = body.access_token;
    if (typeof token === "string" && token) {
      if (!/^[\x21-\x7e]{8,512}$/.test(token)) throw failWith("bad_answer");
      return token;
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down": {
        const given = positiveInt(body.interval) ? body.interval : 0;
        interval = Math.min(Math.max(given, interval + 5), 120);
        slowedDown = true;
        continue;
      }
      case "expired_token":
        throw failWith("expired");
      case "access_denied":
        throw failWith("denied");
      default:
        throw failWith(
          "bad_answer",
          typeof body.error === "string" ? body.error : undefined,
        );
    }
  }
}

/** The one place the token meets a request: api.github.com, in an Authorization header. */
async function api(
  token: string,
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, unknown> },
  env: LinkEnv,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await transport(env)(`${GITHUB_API}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: env.signal,
    });
  } catch {
    cancelled(env);
    throw failWith("unreachable");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Step 3: the numeric id of the account that approved. Names change; ids do not. */
export async function fetchGithubId(
  token: string,
  env: LinkEnv = {},
): Promise<number> {
  const { status, body } = await api(token, "/user", { method: "GET" }, env);
  if (status === 401) throw failWith("token_rejected");
  if (status !== 200 || !isObject(body) || !positiveInt(body.id))
    throw failWith("bad_answer", `HTTP ${status}`);
  return body.id;
}

/**
 * Step 4: creates the one secret gist and checks the answer: a lowercase hex id, this account as
 * the owner, exactly one file with the expected name, and exactly the challenge as its text.
 */
export async function createLinkGist(
  token: string,
  challenge: string,
  githubId: number,
  env: LinkEnv = {},
): Promise<{ gistId: string; githubId: number }> {
  const { status, body } = await api(
    token,
    "/gists",
    {
      method: "POST",
      body: {
        description: GIST_DESCRIPTION,
        public: false,
        files: { [GIST_FILE]: { content: challenge } },
      },
    },
    env,
  );
  if (status === 401) throw failWith("token_rejected");
  if (status === 403 || status === 404) throw failWith("gist_refused");
  if (status !== 201 || !isObject(body)) {
    if (status >= 400 && status < 500)
      throw failWith("gist_refused", `HTTP ${status}`);
    throw failWith("bad_answer", `HTTP ${status}`);
  }
  const files = isObject(body.files) ? Object.entries(body.files) : [];
  const [name, file] =
    files.length === 1 ? (files[0] as [string, unknown]) : [];
  const owner = isObject(body.owner) ? body.owner.id : undefined;
  if (typeof body.id !== "string" || !GIST_ID.test(body.id))
    throw failWith("bad_answer", "gist id");
  if (
    owner !== githubId ||
    name !== GIST_FILE ||
    !isObject(file) ||
    file.content !== challenge ||
    file.truncated === true ||
    body.public !== false
  )
    throw failWith("owner_mismatch");
  return { gistId: body.id, githubId };
}

/** Where the token is, while `connect` runs. It is null before the approval and after the call. */
export interface TokenSession {
  token: string | null;
}
export interface ConnectOptions extends PollOptions {
  /** Called with the code the person types at github.com/login/device. */
  onDeviceCode: (start: DeviceStart) => void;
  /**
   * Called once the person approved and the account is known. Returns the contract's link
   * challenge for the wallet, with an expiry that covers the `link` call that follows.
   */
  getChallenge: (githubId: number) => Promise<string>;
  /** Lets the caller see that the token is dropped when `connect` ends. */
  session?: TokenSession;
  onStep?: (step: "code" | "approval" | "account" | "gist") => void;
}

/**
 * The whole connection. Returns the gist to pass to the contract's `link` and the GitHub id that
 * approved. The token is held in `session.token` only while the call runs.
 */
export async function connect(
  options: ConnectOptions,
): Promise<{ gistId: string; githubId: number }> {
  const session = options.session ?? { token: null };
  session.token = null;
  try {
    options.onStep?.("code");
    const start = await startDeviceFlow(options);
    options.onDeviceCode(start);
    options.onStep?.("approval");
    session.token = await pollForToken(start, options);
    options.onStep?.("account");
    const githubId = await fetchGithubId(session.token, options);
    cancelled(options);
    const challenge = await options.getChallenge(githubId);
    options.onStep?.("gist");
    return await createLinkGist(session.token, challenge, githubId, options);
  } finally {
    session.token = null;
  }
}
