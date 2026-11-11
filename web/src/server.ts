import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserDemo } from "./demo.ts";
import { launchFixedDemo } from "./demo-process.ts";
import { demoRoute } from "./demo-routes.ts";
import { loadJob } from "./evidence.ts";
import {
  hostedRoute,
  NETWORK,
  marketSettings,
  postingOutcome,
  revealRoute,
  createDevWallet,
  RateLimiter,
  readMarketCached,
  relayRoute,
  reviewRoute,
  sample,
} from "./market.ts";
import { ReadError } from "./model.ts";
import { bountiesRoute } from "./bounties.ts";
import {
  GITHUB_PATHS,
  githubProxy,
  type GithubProxyOptions,
} from "./github-proxy.ts";
import { startupMessage } from "../ui/network-status.ts";

const PUBLIC = new URL("../public/", import.meta.url);
const FILES: Record<string, [string, string]> = {
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app": ["market.html", "text/html; charset=utf-8"],
  "/app/": ["market.html", "text/html; charset=utf-8"],
  "/evidence": ["app.html", "text/html; charset=utf-8"],
  "/evidence/": ["app.html", "text/html; charset=utf-8"],
  "/examples": ["examples.html", "text/html; charset=utf-8"],
  "/examples/": ["examples.html", "text/html; charset=utf-8"],
  "/trust": ["trust.html", "text/html; charset=utf-8"],
  "/trust/": ["trust.html", "text/html; charset=utf-8"],
  "/about": ["about.html", "text/html; charset=utf-8"],
  "/about/": ["about.html", "text/html; charset=utf-8"],
  "/workspace-layout.css": ["workspace-layout.css", "text/css; charset=utf-8"],
  "/workspace-surfaces.css": [
    "workspace-surfaces.css",
    "text/css; charset=utf-8",
  ],
  "/workspace-forms.css": ["workspace-forms.css", "text/css; charset=utf-8"],
  "/workspace-responsive.css": [
    "workspace-responsive.css",
    "text/css; charset=utf-8",
  ],
  "/workspace.css": ["workspace.css", "text/css; charset=utf-8"],
  "/market.css": ["market.css", "text/css; charset=utf-8"],
  "/build/market.css": ["../dist/market.css", "text/css; charset=utf-8"],
  "/build/market.js": ["../dist/market.js", "text/javascript; charset=utf-8"],
  "/guide": ["guide.html", "text/html; charset=utf-8"],
  "/guide/": ["guide.html", "text/html; charset=utf-8"],
  "/theme.css": ["theme.css", "text/css; charset=utf-8"],
  "/landing.css": ["landing.css", "text/css; charset=utf-8"],
  "/product-sections.css": ["product-sections.css", "text/css; charset=utf-8"],
  "/product-details.css": ["product-details.css", "text/css; charset=utf-8"],
  "/product-responsive.css": [
    "product-responsive.css",
    "text/css; charset=utf-8",
  ],
  "/landing-sections.css": ["landing-sections.css", "text/css; charset=utf-8"],
  "/guide.css": ["guide.css", "text/css; charset=utf-8"],
  "/landing-responsive.css": [
    "landing-responsive.css",
    "text/css; charset=utf-8",
  ],
  "/build/market-status.js": [
    "../dist/market-status.js",
    "text/javascript; charset=utf-8",
  ],
  "/build/ui.js": ["../dist/ui.js", "text/javascript; charset=utf-8"],
  "/build/ui.css": ["../dist/ui.css", "text/css; charset=utf-8"],
  "/third-party-notices.txt": [
    "../dist/third-party-notices.txt",
    "text/plain; charset=utf-8",
  ],
  "/demo.js": ["demo.js", "text/javascript; charset=utf-8"],
  "/demo.css": ["demo.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/lookup.css": ["lookup.css", "text/css; charset=utf-8"],
  "/evidence.css": ["evidence.css", "text/css; charset=utf-8"],
  "/responsive.css": ["responsive.css", "text/css; charset=utf-8"],
};
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The market page talks to the wallets' own endpoints and the configured network RPC. */
const MARKET_CSP =
  "default-src 'none'; script-src 'self' 'nonce-__WALLET_NONCE__'; frame-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function headers(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
export function approvedOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error("Use one exact HTTPS origin without a path.");
  return value;
}
function sameHost(req: IncomingMessage, origin?: string) {
  const port = req.socket.localPort;
  const allowed = origin
    ? [new URL(origin).host]
    : [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.host ?? "")) return false;
  return (
    req.headers.origin === undefined ||
    req.headers.origin === (origin ?? `http://${req.headers.host}`)
  );
}

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (req.headers["content-type"] !== "application/json")
    throw new ReadError("Send JSON.", 415);
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 512 * 1024) throw new ReadError("Too large.", 413);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ReadError("Send JSON.", 400);
  }
}

const writes = new RateLimiter(30);
/** Holds even if per-client counting is fooled, such as by forged forwarding headers. */
const allWrites = new RateLimiter(240);
/** Behind a reverse proxy on a known origin, the proxy's last entry is the visitor. */
function clientOf(req: IncomingMessage, origin?: string): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (origin && typeof forwarded === "string")
    return clientKey(forwarded.split(",").at(-1)?.trim() ?? "unknown");
  return clientKey(req.socket.remoteAddress ?? "unknown");
}
/** One IPv6 visitor holds a whole /64, so that is what counts as one client. */
export function clientKey(address: string): string {
  if (!address.includes(":") || address.startsWith("::ffff:")) return address;
  const [head = "", tail] = address.split("::");
  const parts = head.split(":").filter(Boolean);
  if (tail !== undefined) while (parts.length < 4) parts.push("0");
  return `${parts.slice(0, 4).join(":")}::/64`;
}

async function marketRoute(
  req: IncomingMessage,
  path: string,
  devWallet?: ReturnType<typeof createDevWallet>,
  origin?: string,
): Promise<unknown> {
  if (req.method === "GET") {
    if (path === "/api/market")
      return readMarketCached().catch(() => {
        throw new ReadError(
          "We can’t reach the job board right now. Try again shortly.",
          503,
        );
      });
    if (path === "/api/market/sample") return sample();
    if (path === "/api/market/config")
      return marketSettings().catch(() => {
        throw new ReadError(
          "We can’t reach the job board right now. Try again shortly.",
          503,
        );
      });
    const reveal = /^\/api\/market\/reveal\/([0-9]+)$/.exec(path);
    if (reveal) return revealRoute(Number(reveal[1]));
    if (path.startsWith("/api/market/hosted/"))
      return hostedRoute("GET", path.slice("/api/market/hosted".length));
    if (path === "/api/market/dev") return devWallet ? devWallet.list() : {};
    if (
      path === "/api/market/bounties" ||
      path.startsWith("/api/market/bounties/")
    )
      return bountiesRoute(path);
    throw new ReadError("Route not found.", 404);
  }
  if (req.method !== "POST") throw new ReadError("Use GET or POST.", 405);
  // A write must come from this page in a browser, or from no browser at all.
  if (
    req.headers["sec-fetch-site"] &&
    req.headers["sec-fetch-site"] !== "same-origin"
  )
    throw new ReadError("A same-origin request is required.", 403);
  // Per client first, so one client's refused requests never use up everyone's budget.
  if (!writes.allow(clientOf(req, origin)) || !allWrites.allow("all"))
    throw new ReadError("Too many requests. Wait a minute and try again.", 429);
  const body = await readBody(req);
  if (path === "/api/market/posting") return postingOutcome(body);
  if (path === "/api/market/relay") return relayRoute(body);
  if (path.startsWith("/api/market/hosted/"))
    return hostedRoute("POST", path.slice("/api/market/hosted".length), body);
  const review = /^\/api\/market\/review\/([0-9]+)$/.exec(path);
  if (review) return reviewRoute(Number(review[1]), body.auth as never);
  if (devWallet && path === "/api/market/dev/call")
    return devWallet.call(body as never);
  if (devWallet && path === "/api/market/dev/transfer")
    return devWallet.transfer(body as never);
  if (devWallet && path === "/api/market/dev/sign")
    return devWallet.sign(body as never);
  throw new ReadError("Route not found.", 404);
}

async function serveRead(
  path: string,
  res: ServerResponse,
  getJob: typeof loadJob,
  reads: { active: number },
  walletNonce?: string,
) {
  const file = isAppPath(path) ? FILES["/app"] : FILES[path];
  if (file) {
    const bytes = await readFile(new URL(file[0], PUBLIC));
    res.writeHead(200, { "Content-Type": file[1] });
    res.end(
      walletNonce
        ? bytes.toString("utf8").replace("__WALLET_NONCE__", walletNonce)
        : bytes,
    );
    return;
  }
  const job = /^\/api\/jobs\/([0-9]+)$/.exec(path);
  if (!job) throw new ReadError("Route not found.", 404);
  if (reads.active >= 4)
    throw new ReadError(
      "Too many active reads. Try again after the current lookup.",
      429,
    );
  reads.active++;
  try {
    json(res, 200, await getJob(job[1]!));
  } finally {
    reads.active--;
  }
}

export function isAppPath(path: string) {
  return /^\/app(?:\/|\/(?:market|jobs|post|agents|bounties)|\/bids\/[0-9]{1,10})?$/.test(
    path,
  );
}

/** Loopback only. Optional fixed demo launcher; no wallet or arbitrary command routes. */
export function createApp(
  getJob: typeof loadJob = loadJob,
  demo?: BrowserDemo,
  origin?: string,
  devWallet?: ReturnType<typeof createDevWallet>,
  github: Omit<GithubProxyOptions, "origin"> = {},
) {
  if (origin) approvedOrigin(origin);
  const reads = { active: 0 };
  return createServer(async (req, res) => {
    headers(res);
    if (!sameHost(req, origin)) {
      json(res, 403, {
        error: "Only the configured same-origin access is allowed.",
      });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.search)
        throw new ReadError("Query parameters are not supported.", 400);
      // The market moved to /app. The old address keeps working.
      if (url.pathname === "/market" || url.pathname === "/market/") {
        res.writeHead(308, { Location: "/app/market" });
        res.end();
        return;
      }
      const walletNonce = isAppPath(url.pathname)
        ? randomBytes(24).toString("base64")
        : undefined;
      if (walletNonce)
        res.setHeader(
          "Content-Security-Policy",
          MARKET_CSP.replace("__WALLET_NONCE__", walletNonce),
        );
      const githubRoute = GITHUB_PATHS[url.pathname];
      if (githubRoute) {
        const answer = await githubProxy(req, githubRoute, {
          ...github,
          origin: origin ?? `http://${req.headers.host}`,
        });
        json(res, answer.status, answer.body);
        return;
      }
      if (url.pathname.startsWith("/api/market")) {
        json(res, 200, await marketRoute(req, url.pathname, devWallet, origin));
        return;
      }
      if (url.pathname === "/api/demo" || url.pathname === "/api/demo/start") {
        const reply = await demoRoute(req, url.pathname, demo, origin);
        json(res, reply.code, reply.body);
        return;
      }
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        throw new ReadError("This route supports reads only.", 405);
      }
      await serveRead(url.pathname, res, getJob, reads, walletNonce);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error instanceof ReadError ? error.status : 502, {
        error:
          error instanceof ReadError
            ? error.message
            : req.method === "GET"
              ? "The public snapshot could not be read."
              : "The request could not finish. A transaction may have been sent. Reconcile wallet history and the chain before retrying.",
      });
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) =>
        arg !== "--demo" &&
        arg !== "--dev-wallet" &&
        arg !== "--public" &&
        !arg.startsWith("--origin="),
    ) ||
    new Set(args).size !== args.length ||
    args.filter((arg) => arg.startsWith("--origin=")).length > 1
  )
    throw new Error(
      "Use npm start -- [--demo] [--origin=https://approved-host] [--public]",
    );
  const originArg = args.find((arg) => arg.startsWith("--origin="));
  const origin = originArg
    ? approvedOrigin(originArg.slice("--origin=".length))
    : undefined;
  // Without this flag the server answers on this machine only, whatever else is set.
  const open = args.includes("--public");
  if (open && !origin) throw new Error("--public needs --origin.");
  const demo = process.argv.includes("--demo")
    ? await BrowserDemo.create(
        fileURLToPath(new URL("../../runs/private/", import.meta.url)),
        launchFixedDemo,
      )
    : undefined;
  let devWallet: ReturnType<typeof createDevWallet> | undefined;
  if (args.includes("--dev-wallet")) {
    if (origin) throw new Error("The dev signer is for this machine only.");
    if (NETWORK !== "testnet")
      throw new Error(
        "The dev signer runs only on the testnet preparation server.",
      );
    const root = fileURLToPath(new URL("../../", import.meta.url));
    (globalThis as { __provenEnv?: string }).__provenEnv = await readFile(
      `${root}.env`,
      "utf8",
    );
    (globalThis as { __provenOutsider?: unknown }).__provenOutsider =
      JSON.parse(
        await readFile(`${root}runs/private/outsider/key.json`, "utf8"),
      );
    devWallet = createDevWallet();
    console.log("Dev signer on: testnet keys only, this machine only.");
  }
  const server = createApp(loadJob, demo, origin, devWallet);
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 256;
  server.on("error", () => {
    process.exitCode = 1;
    console.error(
      "Local server could not start. Check whether its port is already in use.",
    );
    return;
  });
  const port = Number(process.env.PROVEN_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("PROVEN_PORT is not a usable port.");
  server.listen(port, open ? "0.0.0.0" : "127.0.0.1", () =>
    console.log(startupMessage(port, NETWORK)),
  );
}
