import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_LIMITS,
  chainEndpoints,
  chainReader,
  readRequest,
  select,
} from "./chain-read.ts";
import { runSkill } from "./skills.ts";

const ENDPOINTS = {
  rpcs: ["https://rpc-a.test", "https://rpc-b.test"],
  neardata: "https://data.test",
  archival: null,
};
const TX = "9hEnUAfwe245Q7szmxX4Mowby1WEUr4tkT4yDSipp6VL";

interface Seen {
  url: string;
  body: Record<string, unknown> | null;
  redirect: RequestRedirect | undefined;
}

/** A fake network. `answer` gets each request and returns [status, JSON body] or throws. */
function network(
  answer: (
    url: string,
    body: Record<string, unknown> | null,
  ) => [number, unknown],
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    seen.push({ url, body, redirect: init?.redirect });
    const [status, value] = answer(url, body);
    return new Response(JSON.stringify(value), { status });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const ok = (result: unknown): [number, unknown] => [
  200,
  { jsonrpc: "2.0", id: "proven", result },
];
const rpcError = (name: string): [number, unknown] => [
  200,
  { jsonrpc: "2.0", id: "proven", error: { cause: { name }, message: name } },
];

test("only the listed read methods exist, and state reads need a block height", () => {
  for (const bad of [
    { method: "send_tx", signed_tx_base64: "x" },
    { method: "broadcast_tx_commit" },
    { method: "view_account", account_id: "a.near" },
    { method: "view_account", account_id: "a.near", block: "final" },
    { method: "call_function", account_id: "a.near", function: "f" },
    {
      method: "call_function",
      account_id: "a.near",
      function: "f;x",
      block: 1,
    },
    {
      method: "call_function",
      account_id: "a.near",
      function: "f",
      block: 1,
      args: [1],
    },
    {
      method: "call_function",
      account_id: "a.near",
      function: "f",
      block: 1,
      args: { x: "y".repeat(3000) },
    },
    { method: "events", account_id: "A.NEAR", block: 1 },
    { method: "tx", hash: "short", sender_id: "a.near" },
    { method: "block", block: -1 },
    { method: "query", request_type: "view_access_key_list" },
  ])
    assert.equal(
      typeof readRequest(JSON.stringify(bad)),
      "string",
      JSON.stringify(bad).slice(0, 60),
    );
  assert.deepEqual(readRequest('{"method":"block","block":"final"}'), {
    method: "block",
    block: "final",
  });
  assert.deepEqual(
    readRequest(
      '{"method":"call_function","account_id":"proven-board.near","function":"get_bid","args":{"bid_id":0},"block":5}',
    ),
    {
      method: "call_function",
      account: "proven-board.near",
      fn: "get_bid",
      args: '{"bid_id":0}',
      block: 5,
    },
  );
});

test("the request body is built here: a call_function becomes one view query at the named block, with no redirects", async () => {
  const { seen, fetchImpl } = network(() =>
    ok({
      result: [...Buffer.from('{"state":"Done","amount":"5"}')],
      logs: [],
      block_height: 7,
    }),
  );
  const reader = chainReader(ENDPOINTS, fetchImpl);
  const done = await reader.read(
    JSON.stringify({
      method: "call_function",
      account_id: "proven-board.near",
      function: "get_bid",
      args: { bid_id: 0 },
      block: 7,
      select: ["value.state"],
    }),
    "a:bid-1",
  );
  assert.equal(done.ran, true);
  assert.deepEqual(JSON.parse(done.output), {
    method: "call_function",
    result: { "value.state": "Done" },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://rpc-a.test");
  assert.equal(seen[0]!.redirect, "error");
  assert.deepEqual(seen[0]!.body, {
    jsonrpc: "2.0",
    id: "proven",
    method: "query",
    params: {
      request_type: "call_function",
      account_id: "proven-board.near",
      method_name: "get_bid",
      args_base64: Buffer.from('{"bid_id":0}').toString("base64"),
      block_id: 7,
    },
  });
});

test("an unreachable RPC falls through to the next one, and a repeated read is served from cache", async () => {
  const { seen, fetchImpl } = network((url) => {
    if (url.includes("rpc-a")) throw new Error("connection refused");
    return ok({ amount: "1", block_height: 9 });
  });
  const reader = chainReader(ENDPOINTS, fetchImpl);
  const input = JSON.stringify({
    method: "view_account",
    account_id: "a.near",
    block: 9,
  });
  const first = await reader.read(input, "a:bid-1");
  const second = await reader.read(input, "a:bid-1");
  assert.equal(first.ran, true);
  assert.equal(second.output, first.output);
  assert.deepEqual(
    seen.map((s) => s.url),
    ["https://rpc-a.test", "https://rpc-b.test"],
  );
});

test("a garbage-collected block says why, and is not charged; archival is used only when on, and capped", async () => {
  const gone = network(() => rpcError("GARBAGE_COLLECTED_BLOCK"));
  const reader = chainReader(ENDPOINTS, gone.fetchImpl);
  const input = JSON.stringify({
    method: "view_account",
    account_id: "a.near",
    block: 1,
  });
  const refused = await reader.read(input, "a:bid-1");
  assert.equal(refused.ran, false);
  assert.match(refused.output, /no longer keep/);
  // The second RPC keeps the same history, so it is not asked.
  assert.equal(gone.seen.length, 1);

  const archival = network((url) =>
    url.includes("archive") ? ok({ amount: "3" }) : rpcError("UNKNOWN_BLOCK"),
  );
  const withArchive = chainReader(
    { ...ENDPOINTS, archival: "https://archive.test" },
    archival.fetchImpl,
  );
  const reads = [1, 2, 3].map((block) =>
    JSON.stringify({ method: "view_account", account_id: "a.near", block }),
  );
  assert.equal((await withArchive.read(reads[0]!, "a:bid-1")).ran, true);
  assert.equal((await withArchive.read(reads[1]!, "a:bid-1")).ran, true);
  const third = await withArchive.read(reads[2]!, "a:bid-1");
  assert.equal(third.ran, false);
  assert.match(third.output, /archival reads/);
});

test("an answer about the request, such as an unknown account, is a result", async () => {
  const { fetchImpl } = network(() => rpcError("UNKNOWN_ACCOUNT"));
  const done = await chainReader(ENDPOINTS, fetchImpl).read(
    JSON.stringify({
      method: "view_account",
      account_id: "nobody.near",
      block: 5,
    }),
    "a:bid-1",
  );
  assert.equal(done.ran, true);
  assert.match(done.output, /UNKNOWN_ACCOUNT/);
});

test("events come from neardata: only that contract's EVENT_JSON logs, with their transaction", async () => {
  const block = {
    block: { header: { height: 10 } },
    shards: [
      {
        receipt_execution_outcomes: [
          {
            tx_hash: TX,
            execution_outcome: {
              id: "r1",
              outcome: {
                executor_id: "proven-board.near",
                status: { SuccessValue: "" },
                logs: [
                  "plain log",
                  'EVENT_JSON:{"standard":"proven-board","version":"1.0.0","event":"bid_posted","data":{"bid_id":3}}',
                ],
              },
            },
          },
          {
            tx_hash: TX,
            execution_outcome: {
              id: "r2",
              outcome: {
                executor_id: "other.near",
                status: { SuccessValue: "" },
                logs: ['EVENT_JSON:{"event":"not_ours"}'],
              },
            },
          },
        ],
      },
    ],
  };
  const { seen, fetchImpl } = network(() => [200, block]);
  const done = await chainReader(ENDPOINTS, fetchImpl).read(
    JSON.stringify({
      method: "events",
      account_id: "proven-board.near",
      block: 10,
    }),
    "a:bid-1",
  );
  assert.equal(seen[0]!.url, "https://data.test/v0/block/10");
  assert.equal(seen[0]!.body, null);
  assert.deepEqual(JSON.parse(done.output), {
    method: "events",
    result: {
      block: 10,
      events: [
        {
          tx_hash: TX,
          receipt_id: "r1",
          succeeded: true,
          event: {
            standard: "proven-board",
            version: "1.0.0",
            event: "bid_posted",
            data: { bid_id: 3 },
          },
        },
      ],
    },
  });
  const skipped = network(() => [200, null]);
  const empty = await chainReader(ENDPOINTS, skipped.fetchImpl).read(
    JSON.stringify({
      method: "events",
      account_id: "proven-board.near",
      block: 11,
    }),
    "a:bid-1",
  );
  assert.match(empty.output, /"skipped":true/);
});

test("each agent's attempt has its own read limit, and refused reads still count", async () => {
  const { fetchImpl } = network(() => ok({ amount: "1" }));
  const reader = chainReader(ENDPOINTS, fetchImpl);
  for (let block = 1; block <= CHAIN_LIMITS.readsPerRun; block++)
    await reader.read(
      JSON.stringify({ method: "view_account", account_id: "a.near", block }),
      "a:bid-1",
    );
  const over = await reader.read(
    JSON.stringify({
      method: "view_account",
      account_id: "a.near",
      block: 999,
    }),
    "a:bid-1",
  );
  assert.equal(over.ran, false);
  assert.match(over.output, /used its 30 chain reads/);
  const other = await reader.read(
    JSON.stringify({
      method: "view_account",
      account_id: "a.near",
      block: 999,
    }),
    "b:bid-1",
  );
  assert.equal(other.ran, true);
});

test("neardata redirects are followed only to its own archive hosts, for the same block", async () => {
  const hops = (location: string) => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${init?.redirect}`);
      if (url.startsWith("https://data.test/"))
        return new Response(null, { status: 302, headers: { location } });
      return new Response(JSON.stringify({ shards: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  };
  const request = JSON.stringify({
    method: "events",
    account_id: "a.near",
    block: 5,
  });
  const archive = hops("https://a2.data.test/v0/block/5");
  const followed = await chainReader(ENDPOINTS, archive.fetchImpl).read(
    request,
    "a:bid-1",
  );
  assert.equal(followed.ran, true);
  assert.deepEqual(archive.seen, [
    "https://data.test/v0/block/5 manual",
    "https://a2.data.test/v0/block/5 manual",
  ]);
  for (const elsewhere of [
    "https://evil.test/v0/block/5",
    "http://a2.data.test/v0/block/5",
    "https://a2.data.test:8443/v0/block/5",
    "https://a2.data.test/v0/block/6",
    "https://data.test.evil.test/v0/block/5",
  ]) {
    const refused = await chainReader(
      ENDPOINTS,
      hops(elsewhere).fetchImpl,
    ).read(request, "a:bid-1");
    assert.equal(refused.ran, false, elsewhere);
    assert.match(refused.output, /redirected/, elsewhere);
  }
});

test("a response over 1 MB is refused, and a long result is cut with a hint to select fields", async () => {
  const huge = network(() => [
    200,
    { blob: "x".repeat(CHAIN_LIMITS.maxResponseBytes + 10) },
  ]);
  const tooBig = await chainReader(ENDPOINTS, huge.fetchImpl).read(
    JSON.stringify({ method: "events", account_id: "a.near", block: 1 }),
    "a:bid-1",
  );
  assert.equal(tooBig.ran, false);
  assert.match(tooBig.output, /over 1 MB/);
  const long = network(() =>
    ok({ amount: "1", code_hash: "y".repeat(10_000) }),
  );
  const cut = await chainReader(ENDPOINTS, long.fetchImpl).read(
    JSON.stringify({ method: "view_account", account_id: "a.near", block: 1 }),
    "a:bid-1",
  );
  assert.ok(cut.output.length < CHAIN_LIMITS.maxResultChars + 200);
  assert.match(cut.output, /use "select"/);
});

test("select keeps named paths from an object or a list, and refuses odd paths", () => {
  assert.deepEqual(select({ a: { b: 1 }, c: 2 }, ["a.b"]), { "a.b": 1 });
  assert.deepEqual(select([{ a: 1 }, { a: 2 }], ["a", "z"]), [
    { a: 1, z: null },
    { a: 2, z: null },
  ]);
  assert.throws(() => select({}, ["a..b"]));
  assert.throws(() => select({}, "a"));
});

test("mainnet reads start away from the runner's provider, and archival is off unless asked", () => {
  const mainnet = chainEndpoints("mainnet", false);
  assert.deepEqual(mainnet.rpcs, [
    "https://rpc.intea.rs",
    "https://free.rpc.fastnear.com",
  ]);
  assert.equal(mainnet.archival, null);
  assert.equal(
    chainEndpoints("mainnet", true).archival,
    "https://archival-rpc.mainnet.near.org",
  );
  assert.equal(
    chainEndpoints("testnet", false).neardata,
    "https://testnet.neardata.xyz",
  );
});

test("without a chain reader, chain_read is refused and not charged", async () => {
  const done = await runSkill(
    "chain_read",
    '{"method":"block","block":"final"}',
    { knowledge: "", format: "{}" },
  );
  assert.equal(done.ran, false);
  assert.match(done.output, /not available/);
});
