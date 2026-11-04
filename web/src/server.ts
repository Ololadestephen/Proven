import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadJob } from "./evidence.ts";
import { ReadError } from "./model.ts";

const PUBLIC = new URL("../public/", import.meta.url);
const FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/lookup.css": ["lookup.css", "text/css; charset=utf-8"],
  "/evidence.css": ["evidence.css", "text/css; charset=utf-8"],
  "/responsive.css": ["responsive.css", "text/css; charset=utf-8"],
};
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
function sameHost(req: IncomingMessage) {
  const port = req.socket.localPort;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.host ?? "")) return false;
  return (
    req.headers.origin === undefined ||
    req.headers.origin === `http://${req.headers.host}`
  );
}

/** Loopback only. No .env, private files, wallet endpoints, write RPC or demo signer. */
export function createApp(getJob: typeof loadJob = loadJob) {
  let active = 0;
  return createServer(async (req, res) => {
    headers(res);
    if (!sameHost(req)) {
      json(res, 403, { error: "Only same-origin local access is allowed." });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      json(res, 405, { error: "This page supports reads only." });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.search)
        throw new ReadError("Query parameters are not supported.", 400);
      const file = FILES[url.pathname];
      if (file) {
        const bytes = await readFile(new URL(file[0], PUBLIC));
        res.writeHead(200, { "Content-Type": file[1] });
        res.end(bytes);
        return;
      }
      const job = /^\/api\/jobs\/([0-9]+)$/.exec(url.pathname);
      if (!job) throw new ReadError("Route not found.", 404);
      if (active >= 4)
        throw new ReadError(
          "Too many active reads. Try again after the current lookup.",
          429,
        );
      active++;
      try {
        json(res, 200, await getJob(job[1]!));
      } finally {
        active--;
      }
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
  const server = createApp();
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
      "Proven job evidence: http://127.0.0.1:4173 (read-only, testnet)",
    ),
  );
}
