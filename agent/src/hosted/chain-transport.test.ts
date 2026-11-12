import assert from "node:assert/strict";
import test from "node:test";
import {
  blockEvents,
  CHAIN_LIMITS,
  createTransport,
  eventsInBlock,
  readCapped,
  ChainReadRefused,
  rpc,
} from "./chain-transport.ts";

const ENDPOINTS = {
  rpcs: ["https://one.test", "https://two.test"],
  neardata: "https://data.test",
  archival: null,
};

function transport(
  answer: (url: string) => Response | Promise<Response>,
  now = () => 0,
) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return answer(url);
  }) as unknown as typeof fetch;
  return { urls, t: createTransport(ENDPOINTS, fetchImpl, now) };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

test("a body is read up to the cap, and refused past it even without a length header", async () => {
  assert.equal(await readCapped(new Response("abc")), "abc");
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
    },
  });
  await assert.rejects(readCapped(new Response(stream)), ChainReadRefused);
  const declared = new Response("x", {
    headers: { "content-length": String(CHAIN_LIMITS.maxResponseBytes + 1) },
  });
  await assert.rejects(readCapped(declared), /over 1 MB/);
});

test("rpc moves to the next endpoint only when one cannot be reached, and reports when none answers", async () => {
  const flaky = transport((url) =>
    url.includes("one")
      ? new Response("busy", { status: 503 })
      : json({ result: { ok: true } }),
  );
  assert.deepEqual(await rpc(flaky.t, "block", {}, { archival: 0 }), {
    ok: true,
  });
  assert.deepEqual(flaky.urls, ["https://one.test", "https://two.test"]);
  const down = transport(() => new Response("busy", { status: 503 }));
  await assert.rejects(
    rpc(down.t, "block", {}, { archival: 0 }),
    /No free RPC answered: RPC HTTP 503/,
  );
  const notJson = transport(() => new Response("<html>"));
  await assert.rejects(
    rpc(notJson.t, "block", {}, { archival: 0 }),
    /No free RPC answered: The RPC answer was not JSON/,
  );
});

test("the service-wide rate limit refuses reads past it within one minute", async () => {
  let clock = 0;
  const limited = transport(
    () => json({ result: 1 }),
    () => clock,
  );
  for (let i = 0; i < CHAIN_LIMITS.rpcPerMinute; i++)
    await rpc(limited.t, "block", {}, { archival: 0 });
  await assert.rejects(
    rpc(limited.t, "block", {}, { archival: 0 }),
    /read limit is reached/,
  );
  clock = 60_001;
  assert.equal(await rpc(limited.t, "block", {}, { archival: 0 }), 1);
});

test("events keep one contract's EVENT_JSON logs, mark failed receipts and keep unreadable logs short", () => {
  const block = {
    shards: [
      {
        receipt_execution_outcomes: [
          {
            tx_hash: "t1",
            execution_outcome: {
              id: "r1",
              outcome: {
                executor_id: "c.near",
                status: { Failure: {} },
                logs: ["EVENT_JSON:{not json", 'EVENT_JSON:{"event":"x"}'],
              },
            },
          },
          { execution_outcome: { outcome: { executor_id: "other.near" } } },
        ],
      },
      {},
    ],
  };
  assert.deepEqual(eventsInBlock(block, "c.near"), [
    {
      tx_hash: "t1",
      receipt_id: "r1",
      succeeded: false,
      event: { unreadable: "EVENT_JSON:{not json" },
    },
    {
      tx_hash: "t1",
      receipt_id: "r1",
      succeeded: false,
      event: { event: "x" },
    },
  ]);
  assert.deepEqual(eventsInBlock({}, "c.near"), []);
});

test("neardata errors become reasons, and a height with no block is marked skipped", async () => {
  const missing = transport(() =>
    json({ error: "The block is too far in the future" }, 404),
  );
  await assert.rejects(
    blockEvents(missing.t, "c.near", 9),
    /neardata has no block 9: .*too far in the future/,
  );
  const broken = transport(() => new Response("oops", { status: 500 }));
  await assert.rejects(blockEvents(broken.t, "c.near", 9), /neardata HTTP 500/);
  const garbled = transport(() => new Response("<html>"));
  await assert.rejects(blockEvents(garbled.t, "c.near", 9), /not JSON/);
  const empty = transport(() => json(null));
  assert.deepEqual(await blockEvents(empty.t, "c.near", 9), {
    block: 9,
    skipped: true,
    events: [],
  });
  assert.deepEqual(empty.urls, ["https://data.test/v0/block/9"]);
});
