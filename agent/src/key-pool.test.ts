import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModelRefused,
  type CallRequest,
  type CallResult,
} from "./inference.ts";
import { BudgetStop, KeyPool, keysFrom } from "./key-pool.ts";

const LIMIT_TEXT =
  "API key spend limit exceeded. Spent: $0.0105462, Limit: $0.01";
const limits = { agentNanoUsd: 1000, projectNanoUsd: 5000, jobNanoUsd: 500 };
const keys = [
  { name: "KEY_ONE", key: "secret-one" },
  { name: "KEY_TWO", key: "secret-two" },
];
const request = {
  spender: "agent-a",
  stage: "work",
  run: "job-1",
  key: "ignored",
  messages: [],
  maxOutputTokens: 10,
} as CallRequest;

function setup(script: Array<Error | string>, rows: unknown[] = []) {
  const used: Array<string | undefined> = [];
  const client = {
    call: async (r: CallRequest): Promise<CallResult> => {
      used.push(r.key);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return { text: next } as CallResult;
    },
  };
  const log = join(mkdtempSync(join(tmpdir(), "pool-")), "log.jsonl");
  const pool = new KeyPool(
    client,
    { rows: () => rows } as never,
    keys,
    limits,
    log,
  );
  const logged = () => {
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  };
  return { pool, used, logged };
}
const atLimit = () => new ModelRefused(402, "api_key_limit", LIMIT_TEXT);

test("a key that reached its limit moves to the next, logged by name only", async () => {
  const { pool, used, logged } = setup([atLimit(), "done"]);
  assert.equal((await pool.call(request)).text, "done");
  assert.deepEqual(used, ["secret-one", "secret-two"]);
  assert.match(
    logged(),
    /"from":"KEY_ONE","to":"KEY_TWO","agent":"agent-a","job":"job-1"/,
  );
  assert.doesNotMatch(logged(), /secret-/);
});

test("the next call stays on the spare", async () => {
  const { pool, used } = setup([atLimit(), "one", "two"]);
  await pool.call(request);
  await pool.call(request);
  assert.deepEqual(used, ["secret-one", "secret-two", "secret-two"]);
});

test("no other error switches keys", async () => {
  for (const error of [
    new ModelRefused(
      402,
      "no_limit_configured",
      "No spending limit configured.",
    ),
    new ModelRefused(401, "invalid_api_key", "Invalid or expired API key"),
    new ModelRefused(429, "rate_limited", "Slow down, limit reached"),
    new Error("The model call did not complete."),
  ]) {
    const { pool, used, logged } = setup([error, "must not run"]);
    await assert.rejects(pool.call(request));
    assert.deepEqual(used, ["secret-one"]);
    assert.equal(logged(), "");
  }
});

test("when every key is at its limit it stops and alerts", async () => {
  const { pool, logged } = setup([atLimit(), atLimit()]);
  await assert.rejects(pool.call(request), BudgetStop);
  assert.match(logged(), /every key in the pool/);
});

const row = (spender: string, run: string, cost_nano_usd: number) => ({
  spender,
  run,
  cost_nano_usd,
});

test("budgets count every key, so a switch cannot get around them", async () => {
  for (const [rows, reason] of [
    [[row("agent-b", "x", 5000)], /project's inference budget/],
    [[row("agent-a", "old-job", 1000)], /agent's inference budget/],
    [[row("agent-a", "job-1", 500)], /abnormal for its job/],
  ] as const) {
    const { pool, used, logged } = setup(["must not run"], [...rows]);
    await assert.rejects(pool.call(request), BudgetStop);
    assert.deepEqual(used, []);
    assert.match(logged(), reason);
  }
});

test("budgets are checked again before moving to a spare", async () => {
  const rows: unknown[] = [];
  const client = {
    call: async (): Promise<CallResult> => {
      rows.push(row("agent-a", "job-1", 500));
      throw atLimit();
    },
  };
  const log = join(mkdtempSync(join(tmpdir(), "pool-")), "log.jsonl");
  const pool = new KeyPool(
    client,
    { rows: () => rows } as never,
    keys,
    limits,
    log,
  );
  await assert.rejects(pool.call(request), /abnormal/);
});

test("spare keys are found by name, in order, and missing ones skipped", () => {
  assert.deepEqual(
    keysFrom({ A: "1", A_3: "3", B_2: "x" }, ["A"]).map((k) => k.name),
    ["A", "A_3"],
  );
});
