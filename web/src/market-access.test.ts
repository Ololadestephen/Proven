import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { boardAccess, BOARD, hostedRoute, readMarket } from "./market.ts";

/** A JSON-RPC reply carrying a view's value. */
const viewReply = (id: unknown, value: unknown) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        result: [...Buffer.from(JSON.stringify(value))],
        logs: [],
        block_hash: "block",
        block_height: 1,
      },
    }),
  );

/** A JSON-RPC contract error: a missing method, or a panic. */
const contractError = (id: unknown, missing: boolean) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "Server error",
        name: "HANDLER_ERROR",
        cause: {
          name: "CONTRACT_EXECUTION_ERROR",
          info: {
            block_hash: "block",
            block_height: 1,
            error: missing
              ? { MethodResolveError: "MethodNotFound" }
              : {
                  ExecutionError: "Smart contract panicked: record unavailable",
                },
          },
        },
      },
    }),
  );

test("web reads fresh board access through the real provider and uses env only for an older board", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalAccess = process.env.PROVEN_MARKET_ACCESS;
  process.env.PROVEN_MARKET_ACCESS = "open";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalAccess === undefined) delete process.env.PROVEN_MARKET_ACCESS;
    else process.env.PROVEN_MARKET_ACCESS = originalAccess;
  });
  let buyers = ["first.near"];
  let mode = "ok";
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.params.account_id, BOARD);
    assert.equal(body.params.method_name, "get_access");
    if (mode === "missing" || mode === "panic")
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32000,
            message: "Server error",
            name: "HANDLER_ERROR",
            cause: {
              name: "CONTRACT_EXECUTION_ERROR",
              info: {
                block_hash: "block",
                block_height: 1,
                error:
                  mode === "missing"
                    ? { MethodResolveError: "MethodNotFound" }
                    : {
                        ExecutionError:
                          "Smart contract panicked: MethodResolveError(MethodNotFound)",
                      },
              },
            },
          },
        }),
      );
    if (mode === "error") throw new Error("board unavailable");
    const value =
      mode === "invalid"
        ? { open: "yes", buyers: [] }
        : { open: false, buyers };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          result: [...Buffer.from(JSON.stringify(value))],
          logs: [],
          block_hash: "block",
          block_height: 1,
        },
      }),
    );
  }) as typeof fetch;
  assert.deepEqual(await boardAccess(), {
    open: false,
    buyers: ["first.near"],
    source: "board",
  });
  buyers = ["second.near"];
  assert.deepEqual(await boardAccess(), {
    open: false,
    buyers: ["second.near"],
    source: "board",
  });
  mode = "error";
  await assert.rejects(boardAccess(), /buyer list could not be read/);
  mode = "invalid";
  await assert.rejects(boardAccess(), /invalid buyer list/);
  mode = "panic";
  await assert.rejects(boardAccess(), /buyer list could not be read/);
  mode = "missing";
  assert.deepEqual(await boardAccess(), {
    open: true,
    buyers: [],
    source: "legacy-env",
  });
  assert.equal(calls, 6);
});

test("an agent record is empty only on an older board; a failed read fails the market read", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let missing = true;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const method = body.params.method_name;
    if (method === "get_agent_record") return contractError(body.id, missing);
    return viewReply(
      body.id,
      method === "get_config"
        ? { verifier_hash: "hash", paused: false, run_deposit: "0" }
        : method === "get_agents"
          ? [{ wallet: "agent.testnet" }]
          : [],
    );
  }) as typeof fetch;
  const market = await readMarket();
  assert.deepEqual(market.agent_records, { "agent.testnet": null });
  missing = false;
  await assert.rejects(readMarket());
});

test("a hosted reply that is not JSON is a 502, and says to check before retrying a write", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let status = 200;
  globalThis.fetch = (async () =>
    new Response("<html>gateway</html>", { status })) as typeof fetch;
  await assert.rejects(
    hostedRoute("GET", "/health"),
    (error: Error & { status?: number }) => {
      assert.equal(
        error.message,
        "The hosted agents service sent an unreadable reply.",
      );
      assert.equal(error.status, 502);
      return true;
    },
  );
  await assert.rejects(
    hostedRoute("POST", "/withdraw", {}),
    /Check the agent or withdrawal before retrying/,
  );
  status = 404;
  await assert.rejects(hostedRoute("GET", "/health"), /refused this/);
});

test("mainnet has no default board, so a missing setting fails instead of reading testnet", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const m = await import("./src/market.ts"); await m.boardAccess().then(() => console.log("read"), (e) => console.log(e.message));',
    ],
    {
      cwd: new URL("../", import.meta.url).pathname,
      env: { ...process.env, NEAR_NETWORK: "mainnet", PROVEN_BOARD: "" },
      encoding: "utf8",
    },
  );
  assert.match(result.stdout, /board account is not configured/);
});
