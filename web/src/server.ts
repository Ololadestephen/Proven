import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserDemo } from "./demo.ts";
import { launchFixedDemo } from "./demo-process.ts";
import { demoRoute } from "./demo-routes.ts";
import { loadJob } from "./evidence.ts";
import {
  createDevWallet,
  readMarket,
  relayRoute,
  reviewRoute,
  sample,
} from "./market.ts";
import { ReadError } from "./model.ts";

const PUBLIC = new URL("../public/", import.meta.url);
const FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app": ["app.html", "text/html; charset=utf-8"],
  "/app/": ["app.html", "text/html; charset=utf-8"],
  "/market": ["market.html", "text/html; charset=utf-8"],
  "/market/": ["market.html", "text/html; charset=utf-8"],
  "/market.css": ["market.css", "text/css; charset=utf-8"],
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

/** The market page talks to the wallets' own endpoints and to testnet RPC. No other page does. */
const MARKET_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

async function marketRoute(
  req: IncomingMessage,
  path: string,
  devWallet?: ReturnType<typeof createDevWallet>,
): Promise<unknown> {
  if (req.method === "GET") {
    if (path === "/api/market") return readMarket();
    if (path === "/api/market/sample") return sample();
    if (path === "/api/market/dev") return devWallet ? devWallet.list() : {};
    throw new ReadError("Route not found.", 404);
  }
  if (req.method !== "POST") throw new ReadError("Use GET or POST.", 405);
  // A write must come from this page in a browser, or from no browser at all.
  if (
    req.headers["sec-fetch-site"] &&
    req.headers["sec-fetch-site"] !== "same-origin"
  )
    throw new ReadError("A same-origin request is required.", 403);
  const body = await readBody(req);
  if (path === "/api/market/relay") return relayRoute(body);
  const review = /^\/api\/market\/review\/([0-9]+)$/.exec(path);
  if (review) return reviewRoute(Number(review[1]));
  if (devWallet && path === "/api/market/dev/call")
    return devWallet.call(body as never);
  if (devWallet && path === "/api/market/dev/sign")
    return devWallet.sign(body as never);
  throw new ReadError("Route not found.", 404);
}

async function serveRead(
  path: string,
  res: ServerResponse,
  getJob: typeof loadJob,
  reads: { active: number },
) {
  const file = FILES[path];
  if (file) {
    const bytes = await readFile(new URL(file[0], PUBLIC));
    res.writeHead(200, { "Content-Type": file[1] });
    res.end(bytes);
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

/** Loopback only. Optional fixed demo launcher; no wallet or arbitrary command routes. */
export function createApp(
  getJob: typeof loadJob = loadJob,
  demo?: BrowserDemo,
  origin?: string,
  devWallet?: ReturnType<typeof createDevWallet>,
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
      if (url.pathname === "/market" || url.pathname === "/market/")
        res.setHeader("Content-Security-Policy", MARKET_CSP);
      if (url.pathname.startsWith("/api/market")) {
        json(res, 200, await marketRoute(req, url.pathname, devWallet));
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
      await serveRead(url.pathname, res, getJob, reads);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, error instanceof ReadError ? error.status : 502, {
        error:
          error instanceof ReadError
            ? error.message
            : "The public snapshot could not be read. No transaction was sent.",
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
        !arg.startsWith("--origin="),
    ) ||
    new Set(args).size !== args.length ||
    args.filter((arg) => arg.startsWith("--origin=")).length > 1
  )
    throw new Error(
      "Use npm start -- [--demo] [--origin=https://approved-host]",
    );
  const originArg = args.find((arg) => arg.startsWith("--origin="));
  const origin = originArg
    ? approvedOrigin(originArg.slice("--origin=".length))
    : undefined;
  const demo = process.argv.includes("--demo")
    ? await BrowserDemo.create(
        fileURLToPath(new URL("../../runs/private/", import.meta.url)),
        launchFixedDemo,
      )
    : undefined;
  let devWallet: ReturnType<typeof createDevWallet> | undefined;
  if (args.includes("--dev-wallet")) {
    if (origin) throw new Error("The dev signer is for this machine only.");
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
  server.on("error", () => {
    process.exitCode = 1;
    console.error(
      "Local server could not start. Check whether port 4173 is already in use.",
    );
    return;
  });
  server.listen(4173, "127.0.0.1", () =>
    console.log(
      "Proven job evidence: http://127.0.0.1:4173 (testnet; live demo requires a separate operator allowance)",
    ),
  );
}
