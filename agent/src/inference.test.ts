import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Ledger,
  ModelClient,
  ModelRefused,
  type ModelPrice,
} from "./inference.ts";

const MODEL = "test/model";
const prices = new Map<string, ModelPrice>([
  [MODEL, { inputNanoUsd: 100, outputNanoUsd: 1000, verifiable: true }],
  ["test/open", { inputNanoUsd: 1, outputNanoUsd: 1, verifiable: false }],
]);
const ledger = () =>
  new Ledger(join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl"));
const base = {
  spender: "agent-a",
  stage: "work",
  run: "r1",
  key: "SECRET-KEY",
  messages: [{ role: "user" as const, content: "hi" }],
  maxOutputTokens: 10,
  model: MODEL,
};
const answering = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test("a call records tokens and cost per stage and run, and never the prompt or key", async () => {
  const l = ledger();
  const client = new ModelClient(
    l,
    prices,
    answering(200, {
      id: "chat-1",
      choices: [{ message: { content: "out" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    }),
  );
  const result = await client.call(base);
  assert.equal(result.text, "out");
  assert.equal(result.costNanoUsd, 20 * 100 + 5 * 1000);
  const [row] = l.rows();
  assert.deepEqual(
    [
      row.stage,
      row.run,
      row.spender,
      row.input_tokens,
      row.output_tokens,
      row.chat_id,
    ],
    ["work", "r1", "agent-a", 20, 5, "chat-1"],
  );
  assert.equal(l.spentNanoUsd("agent-a"), 7000);
  assert.ok(
    !JSON.stringify(row).includes("SECRET-KEY") &&
      !JSON.stringify(row).includes("hi"),
  );
});

test("a refused call is recorded with no cost and reports only a short code", async () => {
  const l = ledger();
  const client = new ModelClient(
    l,
    prices,
    answering(402, {
      error: { code: "limit_exceeded", message: "key SECRET-KEY is over" },
    }),
  );
  await assert.rejects(
    client.call(base),
    (e: ModelRefused) =>
      e.status === 402 &&
      e.code === "limit_exceeded" &&
      !e.message.includes("SECRET"),
  );
  assert.deepEqual([l.rows()[0].status, l.rows()[0].cost_nano_usd], [402, 0]);
});

test("the local limit refuses a call before any spending", async () => {
  const l = ledger();
  let called = false;
  const client = new ModelClient(l, prices, (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch);
  await assert.rejects(
    client.call({ ...base, limitNanoUsd: 10 }),
    /reached its inference limit/,
  );
  assert.equal(called, false);
  assert.equal(l.rows().length, 0);
});

test("unlisted and non-verifiable models are refused", async () => {
  const client = new ModelClient(ledger(), prices, answering(200, {}));
  await assert.rejects(
    client.call({ ...base, model: "other/model" }),
    /no listed price/,
  );
  await assert.rejects(
    client.call({ ...base, model: "test/open" }),
    /not verifiable/,
  );
});

test("a call that never finishes counts its worst-case cost against the limit", async () => {
  const l = ledger();
  const client = new ModelClient(l, prices, (async () => {
    throw new Error("timeout");
  }) as typeof fetch);
  await assert.rejects(client.call(base), /did not complete/);
  assert.equal(l.rows()[0].status, 0);
  assert.ok(l.spentNanoUsd("agent-a") >= 10 * 1000);
});
