import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createApp } from "./server.ts";
import { ReadError } from "./model.ts";

test("local HTTP only exposes allowed read routes, never private files or transaction endpoints", async (t) => {
  const jobs: string[] = [];
  const app = createApp(async (id) => {
    jobs.push(id);
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
    "/guide",
    "/guide/",
    "/theme.css",
    "/landing.css",
    "/product-sections.css",
    "/product-details.css",
    "/product-responsive.css",
    "/landing-sections.css",
    "/guide.css",
    "/landing-responsive.css",
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
  assert.deepEqual(jobs, ["404", "11"]);
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
