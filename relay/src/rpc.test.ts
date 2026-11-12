import test from "node:test";
import assert from "node:assert/strict";
import { DemoRpcProvider, FallbackRpcProvider, isRateLimit } from "./rpc.ts";

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

test("opt-in fallback uses the next endpoint on transient queries only", async (t) => {
  const primary = "https://primary.invalid";
  const backup = "https://backup.invalid";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(String(url));
    if (url === primary) throw new TypeError("fetch failed");
    return Response.json({ jsonrpc: "2.0", id: "1", result: { ok: true } });
  });
  const provider = new FallbackRpcProvider([primary, backup], true);
  const send = (method: string) =>
    provider.sendJsonRpc(method as never, {} as never);
  assert.deepEqual(await send("query"), { ok: true });
  assert.deepEqual(calls, [primary, backup]);
  calls.length = 0;
  await assert.rejects(send("broadcast_tx_async"), /fetch failed/);
  assert.deepEqual(calls, [primary]);
});

test("a missing key or account is a no; an outage is thrown, never read as a missing key", async () => {
  const { keyOnAccount } = await import("./rpc.ts");
  const { AccessKeyDoesNotExistError, AccountDoesNotExistError } =
    await import("near-api-js/rpc-errors");
  const provider = (error: unknown) => ({
    viewAccessKey: async () => {
      if (error) throw error;
      return {} as never;
    },
  });
  assert.equal(await keyOnAccount(provider(null), "a.near", "ed25519:k"), true);
  assert.equal(
    await keyOnAccount(
      provider(Object.create(AccessKeyDoesNotExistError.prototype)),
      "a.near",
      "ed25519:k",
    ),
    false,
  );
  assert.equal(
    await keyOnAccount(
      provider(Object.create(AccountDoesNotExistError.prototype)),
      "a.near",
      "ed25519:k",
    ),
    false,
  );
  await assert.rejects(
    keyOnAccount(provider(new Error("rpc down")), "a.near", "ed25519:k"),
    /rpc down/,
  );
});
