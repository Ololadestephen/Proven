import assert from "node:assert/strict";
import test from "node:test";
import {
  runCodeSkill,
  sandboxClient,
  type SandboxCall,
  type SandboxRun,
} from "./sandbox.ts";

const RUN: SandboxRun = {
  exit_code: 0,
  timed_out: false,
  truncated: false,
  ms: 12,
  output: "ok",
  repo_bytes: 0,
};
const counting = (reply: SandboxRun = RUN) => {
  const calls: unknown[] = [];
  const call: SandboxCall = async (request, agent) => {
    calls.push({ request, agent });
    return reply;
  };
  return { call, calls };
};
const input = (value: unknown) => JSON.stringify(value);

test("input the model writes is checked before the sandbox is called", async () => {
  const { call, calls } = counting();
  for (const [text, message] of [
    ["not json", /takes JSON/],
    ["[1]", /takes JSON/],
    [input({ language: "ruby", command: "x" }), /python or node/],
    [input({ language: "node", command: 5 }), /command as text/],
    [
      input({ language: "node", command: "x", files: { a: 1 } }),
      /files must map/,
    ],
    [input({ language: "node", command: "x", files: ["a"] }), /files must map/],
    [
      input({
        language: "node",
        command: "x",
        repo: { owner: "o", name: "n" },
      }),
      /repo needs owner, name and commit/,
    ],
  ] as const) {
    const result = await runCodeSkill(call, "run_code", text, "agent");
    assert.equal(result.ran, false, text);
    assert.match(result.output, message);
  }
  assert.equal(calls.length, 0);
});

test("a run passes exit code and timeout through and cuts output to 8192 characters", async () => {
  const { call, calls } = counting({
    ...RUN,
    exit_code: 3,
    timed_out: true,
    output: "x".repeat(10_000),
  });
  const result = await runCodeSkill(
    call,
    "run_tests",
    input({
      language: "python",
      command: "pytest",
      files: { "a.py": "print(1)" },
      repo: { owner: "o", name: "n", commit: "c" },
    }),
    "agent-1",
  );
  assert.equal(result.ran, true);
  const output = JSON.parse(result.output);
  assert.equal(output.exit_code, 3);
  assert.equal(output.timed_out, true);
  assert.equal(output.output.length, 8_192);
  assert.deepEqual(calls, [
    {
      request: {
        language: "python",
        command: "pytest",
        files: { "a.py": "print(1)" },
        repo: { owner: "o", name: "n", commit: "c" },
      },
      agent: "agent-1",
    },
  ]);
});

test("the client authenticates, names the agent and refuses redirects; bad replies do not run", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let reply = new Response(JSON.stringify(RUN));
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://sandbox.test/run");
    seen = init;
    return reply;
  }) as typeof fetch;
  const client = sandboxClient("https://sandbox.test", "token-1");
  assert.deepEqual(await client({ language: "node", command: "x" }, "a"), RUN);
  const headers = seen?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer token-1");
  assert.equal(headers["x-agent"], "a");
  assert.equal(seen?.redirect, "error");

  const ask = () =>
    runCodeSkill(
      client,
      "run_code",
      input({ language: "node", command: "x" }),
      "a",
    );
  for (const [response, message] of [
    [
      new Response(JSON.stringify({ error: "too big" }), { status: 413 }),
      /too big/,
    ],
    [new Response("<html>", { status: 200 }), /unreadable reply/],
    [new Response(JSON.stringify({ ...RUN, ms: "12" })), /malformed result/],
  ] as const) {
    reply = response;
    const result = await ask();
    assert.equal(result.ran, false);
    assert.match(result.output, message);
  }
});
