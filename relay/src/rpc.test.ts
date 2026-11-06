import test from "node:test";
import assert from "node:assert/strict";
import { DemoRpcProvider, isRateLimit } from "./rpc.ts";

const reader = "https://test.rpc.fastnear.com",
  writer = "https://testnet-rpc.intea.rs";
test("split RPC sends immutable broadcasts only to the configured writer and reads only to the reader", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: Array<{ url: string; method: string; params: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body));
    calls.push({
      url: String(url),
      method: request.method,
      params: request.params,
    });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "status" ? { chain_id: "testnet" } : "known-hash",
      }),
    );
  };
  const provider = new DemoRpcProvider(reader, writer);
  await provider.sendJsonRpc("status", []);
  await provider.sendJsonRpc("broadcast_tx_async", ["immutable-signed-bytes"]);
  assert.deepEqual(calls, [
    { url: reader, method: "status", params: [] },
    {
      url: writer,
      method: "broadcast_tx_async",
      params: ["immutable-signed-bytes"],
    },
  ]);
});

test("write failure does not fall back to another endpoint or hide HTTP retries", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(
    new DemoRpcProvider(reader, writer).sendJsonRpc("broadcast_tx_async", [
      "same-bytes",
    ]),
  );
  assert.deepEqual(calls, [writer]);
});

test("either non-testnet or unapproved endpoint is refused before any request", () => {
  for (const url of ["https://free.rpc.fastnear.com", "https://example.com"])
    for (const endpoints of [
      [reader, url],
      [url, writer],
    ])
      assert.throws(
        () => new DemoRpcProvider(...(endpoints as [string, string])),
        /approved testnet/,
      );
});

test("only a rate limit counts as one", () => {
  assert.equal(
    isRateLimit(
      new Error('{"code": -429, "message": "Rate limits exceeded."}'),
    ),
    true,
  );
  assert.equal(isRateLimit(new Error("Smart contract panicked")), false);
  assert.equal(isRateLimit(new Error("timeout")), false);
});
