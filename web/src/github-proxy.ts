// Two fixed routes that forward GitHub's device-flow requests, because github.com sends no CORS
// headers and the browser cannot call them itself:
//   POST /api/github/device/code   ->  https://github.com/login/device/code
//   POST /api/github/device/token  ->  https://github.com/login/oauth/access_token
// What it forwards is only the app's public client id, the device code and the fixed grant type.
// It sends no scope (a GitHub App ignores it) and holds no client secret; it forwards nothing the
// browser sent except the device code, and nothing GitHub sent except a short allowlist of fields.
// It never logs and never stores a body, and the access token in a reply goes to the browser once
// and is not kept. Same-origin requests only, small bodies, and a per-process rate limit.
import type { IncomingMessage } from "node:http";

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const NOT_CONFIGURED = "GitHub linking is not configured";
export const MAX_REQUEST_BYTES = 2048;
export const MAX_REPLY_BYTES = 8192;
const UPSTREAM_TIMEOUT_MS = 15_000;
const CLIENT_ID = /^[A-Za-z0-9._-]{8,64}$/;
const DEVICE_CODE = /^[A-Za-z0-9_-]{8,128}$/;

export type GithubRoute = "code" | "token";
export const GITHUB_PATHS: Record<string, GithubRoute> = {
  "/api/github/device/code": "code",
  "/api/github/device/token": "token",
};

/** A sliding window over all callers of this process. */
export class WindowLimit {
  private readonly times: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(now = Date.now()): boolean {
    while (
      this.times.length &&
      now - (this.times[0] as number) >= this.windowMs
    )
      this.times.shift();
    if (this.times.length >= this.limit) return false;
    this.times.push(now);
    return true;
  }
}

export interface GithubProxyOptions {
  /** The transport to GitHub; tests pass a fake. */
  fetch?: typeof fetch;
  /** The app's public client id. Defaults to PROVEN_GITHUB_CLIENT_ID. */
  clientId?: string | undefined;
  /** This server's own origin, such as `http://127.0.0.1:4173`. */
  origin: string;
  limit?: WindowLimit;
}
export interface ProxyReply {
  status: number;
  body: Record<string, unknown>;
}
const reply = (status: number, error: string): ProxyReply => ({
  status,
  body: { error },
});

/** Reads at most MAX_REQUEST_BYTES of a JSON object, or returns the reply that refuses it. */
async function readSmallBody(
  req: IncomingMessage,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reply: ProxyReply }
> {
  const no = (status: number, error: string) => ({
    ok: false as const,
    reply: reply(status, error),
  });
  const type = req.headers["content-type"];
  if (type !== "application/json" && type !== "application/json; charset=utf-8")
    return no(415, "Send JSON.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += piece.length;
    if (size > MAX_REQUEST_BYTES) return no(413, "Too large.");
    chunks.push(piece);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return no(400, "Send a JSON object.");
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return no(400, "Send JSON.");
  }
}

const str = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max ? v : undefined;
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * Keeps only the fields the page uses, with the types it expects. The refresh token is dropped:
 * the page needs the access token once and nothing longer-lived.
 */
function allowed(route: GithubRoute, raw: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };
  set("error", str(raw.error, 64));
  set("error_description", str(raw.error_description, 400));
  set("interval", num(raw.interval));
  if (route === "code") {
    set("device_code", str(raw.device_code, 128));
    set("user_code", str(raw.user_code, 32));
    set("verification_uri", str(raw.verification_uri, 200));
    set("expires_in", num(raw.expires_in));
  } else {
    set("access_token", str(raw.access_token, 512));
    set("token_type", str(raw.token_type, 32));
    set("expires_in", num(raw.expires_in));
  }
  return out;
}

async function readReply(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function githubProxy(
  req: IncomingMessage,
  route: GithubRoute,
  options: GithubProxyOptions,
): Promise<ProxyReply> {
  if (req.method !== "POST") return reply(405, "Use POST.");
  if (
    req.headers.origin !== options.origin ||
    (req.headers["sec-fetch-site"] !== undefined &&
      req.headers["sec-fetch-site"] !== "same-origin")
  )
    return reply(403, "A same-origin request is required.");
  const clientId = options.clientId ?? process.env.PROVEN_GITHUB_CLIENT_ID;
  if (!clientId || !CLIENT_ID.test(clientId)) return reply(503, NOT_CONFIGURED);
  if (!(options.limit ?? defaultLimit).allow())
    return reply(429, "Too many requests. Wait a minute and try again.");
  const read = await readSmallBody(req);
  if (!read.ok) return read.reply;
  const body = read.value;
  const upstream: Record<string, string> = { client_id: clientId };
  if (route === "token") {
    const code = body.device_code;
    if (typeof code !== "string" || !DEVICE_CODE.test(code))
      return reply(400, "Send the device code.");
    upstream.device_code = code;
    upstream.grant_type = DEVICE_GRANT;
  }
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(
      route === "code" ? DEVICE_CODE_URL : DEVICE_TOKEN_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "proven-github-link",
        },
        body: JSON.stringify(upstream),
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch {
    return reply(502, "GitHub could not be reached.");
  }
  const raw = await readReply(res).catch(() => null);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return reply(502, "GitHub returned an answer this page cannot read.");
  const answer = allowed(route, raw as Record<string, unknown>);
  // GitHub reports "still waiting" and "slow down" as ordinary answers with an error code.
  if (!res.ok && answer.error === undefined)
    return reply(502, `GitHub refused the request (HTTP ${res.status}).`);
  return { status: res.ok ? 200 : 502, body: answer };
}
const defaultLimit = new WindowLimit(60);
