import assert from "node:assert/strict";
import test from "node:test";
import { rpcAnswer } from "./read.ts";

const answer = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

/** A transport that answers each endpoint in turn and records which ones were asked. */
function transport(replies: Array<() => Response>) {
  const asked: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    asked.push(String(url));
    const reply = replies[asked.length - 1];
    if (!reply) throw new Error("no more endpoints expected");
    return reply();
  }) as typeof fetch;
  return { fetcher, asked };
}

test("a rate-limited or failed endpoint moves the read to the next one", async () => {
  const { fetcher, asked } = transport([
    () => answer({ error: "too many requests" }, 429),
    () => {
      throw new TypeError("fetch failed");
    },
    () => answer({ jsonrpc: "2.0", id: "proven-read", result: { ok: 1 } }),
  ]);
  const reply = await rpcAnswer("block", { finality: "final" }, fetcher);
  assert.deepEqual(reply.result, { ok: 1 });
  assert.equal(asked.length, 3);
  assert.equal(new Set(asked).size, 3, "each endpoint is asked once");
});

test("an answer from the chain, even an error answer, is returned without asking another endpoint", async () => {
  const unknown = {
    jsonrpc: "2.0",
    id: "proven-read",
    error: { cause: { name: "UNKNOWN_ACCOUNT" } },
  };
  const { fetcher, asked } = transport([() => answer(unknown)]);
  const reply = await rpcAnswer("query", {}, fetcher);
  assert.deepEqual(reply.error, unknown.error);
  assert.equal(asked.length, 1);
});

test("a fixed endpoint is asked alone, and a read every endpoint fails is refused", async () => {
  const fixed = transport([() => answer({}, 503)]);
  await assert.rejects(
    rpcAnswer("block", {}, fixed.fetcher, "https://fixed.example"),
    /unavailable or malformed/,
  );
  assert.deepEqual(fixed.asked, ["https://fixed.example"]);
  const down = transport([
    () => answer({}, 429),
    () => answer({}, 429),
    () => answer({}, 429),
  ]);
  await assert.rejects(
    rpcAnswer("block", {}, down.fetcher),
    /unavailable or malformed/,
  );
  assert.equal(down.asked.length, 3);
});
