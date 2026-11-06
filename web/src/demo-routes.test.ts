import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { realpath, mkdtemp, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserDemo, armDemo } from "./demo.ts";
import { createApp } from "./server.ts";

test("demo HTTP enforces origin, fixed body, route and durable single start across concurrent clients", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "proven-http-")));
  await chmod(dir, 0o700);
  await armDemo(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  let launches = 0;
  const demo = await BrowserDemo.create(dir, () => {
    launches++;
  });
  const server = createApp(async () => {
    throw Error("unused");
  }, demo);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (
    body = "{}",
    origin: string | undefined = base,
    type = "application/json",
  ) =>
    fetch(base + "/api/demo/start", {
      method: "POST",
      headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": type },
      body,
    });
  assert.equal((await fetch(base + "/api/demo")).status, 200);
  assert.equal((await post("{}", "https://attacker.example")).status, 403);
  assert.equal((await post("{}", undefined)).status, 202); // Default parameter supplies same origin.
  assert.equal(launches, 1);
  assert.equal((await post('{"amount":1}')).status, 400);
  assert.equal((await post("{}", base, "text/plain")).status, 400);
  const missing = await fetch(base + "/api/demo/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 403);
  assert.equal(
    (
      await fetch(base + "/api/demo/start?amount=1", {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
  );
  await Promise.all(Array.from({ length: 5 }, () => post()));
  assert.equal(launches, 1);
  assert.equal((await fetch(base + "/api/demo/start")).status, 405);
  assert.equal((await fetch(base + "/demo.js")).status, 200);
  assert.equal((await fetch(base + "/demo.css")).status, 200);
  assert.equal(
    (await fetch(base + "/api/demo", { method: "DELETE" })).status,
    405,
  );
});

test("approved HTTPS proxy preserves exact Host/Origin; forwarded headers cannot bypass checks", async (t) => {
  const { approvedOrigin } = await import("./server.ts");
  for (const value of [
    "http://demo.example",
    "https://demo.example/",
    "https://user@demo.example",
    "https://demo.example/path",
  ])
    assert.throws(() => approvedOrigin(value));
  const origin = approvedOrigin("https://demo.example");
  const dir = await mkdtemp(join(tmpdir(), "proven-proxy-"));
  const { realpath } = await import("node:fs/promises");
  const path = await realpath(dir);
  await chmod(path, 0o700);
  await armDemo(path);
  t.after(() => rm(path, { recursive: true, force: true }));
  let launches = 0;
  const demo = await BrowserDemo.create(path, () => launches++);
  const server = createApp(undefined, demo, origin);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal(
    (
      await fetch(base + "/api/demo", {
        headers: {
          "X-Forwarded-Host": "demo.example",
          "X-Forwarded-Proto": "https",
        },
      })
    ).status,
    403,
  );
  const proxyPost = (requestOrigin: string) =>
    new Promise<number>((resolve, reject) => {
      const request = http.request(
        base + "/api/demo/start",
        {
          method: "POST",
          headers: {
            Host: "demo.example",
            Origin: requestOrigin,
            "Content-Type": "application/json",
            "Content-Length": "2",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on("error", reject);
      request.end("{}");
    });
  assert.equal(await proxyPost("https://evil.example"), 403);
  assert.equal(await proxyPost(origin), 202);
  assert.equal(launches, 1);
});
