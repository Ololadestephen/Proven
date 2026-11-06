import type { IncomingMessage } from "node:http";
import type { BrowserDemo } from "./demo.ts";
import { ReadError } from "./model.ts";

async function fixedStartBody(req: IncomingMessage, origin: string) {
  if (
    req.headers.origin !== origin ||
    (req.headers["sec-fetch-site"] &&
      req.headers["sec-fetch-site"] !== "same-origin")
  )
    throw new ReadError("A same-origin browser request is required.", 403);
  if (
    req.headers["content-type"] !== "application/json" ||
    req.headers["content-length"] !== "2" ||
    req.headers["transfer-encoding"]
  )
    throw new ReadError("Only the fixed empty demo request is accepted.", 400);
  const timer = setTimeout(() => req.destroy(), 3000);
  let body = "";
  try {
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 2)
        throw new ReadError("Demo parameters are not accepted.", 400);
    }
    if (body !== "{}")
      throw new ReadError("Demo parameters are not accepted.", 400);
  } finally {
    clearTimeout(timer);
  }
}
export async function demoRoute(
  req: IncomingMessage,
  path: string,
  demo?: BrowserDemo,
  origin = `http://${req.headers.host}`,
) {
  if (path === "/api/demo" && req.method === "GET")
    return {
      code: 200,
      body: demo?.status() ?? {
        state: "disabled",
        message: "Live demo is disabled.",
        elapsed_ms: 0,
        jobs: [],
      },
    };
  if (path === "/api/demo/start" && req.method === "POST") {
    await fixedStartBody(req, origin);
    if (!demo) throw new ReadError("Live demo is disabled.", 409);
    const body = await demo.start();
    return {
      code: body.state === "running" || body.state === "completed" ? 202 : 409,
      body,
    };
  }
  throw new ReadError("Unsupported demo method or route.", 405);
}
