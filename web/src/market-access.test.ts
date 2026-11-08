import assert from "node:assert/strict";
import test from "node:test";
import { boardAccess, marketConfig, marketOpenTo, BOARD } from "./market.ts";

test("a closed mainnet market reviews only its listed buyers", () => {
  assert.equal(marketOpenTo("a.near", undefined, "mainnet"), false);
  assert.equal(marketOpenTo("a.near", "", "mainnet"), false);
  assert.equal(marketOpenTo("b.near", "a.near", "mainnet"), false);
  assert.equal(marketOpenTo("a.near", "z.near, a.near", "mainnet"), true);
  assert.equal(marketOpenTo("a.near", "open", "mainnet"), true);
  assert.equal(marketOpenTo("a.near", undefined, "testnet"), true);
});

test("a closed market names its buyers, and an open one does not", () => {
  assert.deepEqual(marketConfig("a.near, b.near").buyers, ["a.near", "b.near"]);
  assert.equal(marketConfig("a.near").open, false);
  assert.equal(marketConfig("open").open, true);
  assert.equal(marketConfig("open").buyers, undefined);
});

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
