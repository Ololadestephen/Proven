import assert from "node:assert/strict";
import test from "node:test";
import { calculator, jsonValidator, knowledgeSearch } from "./skills.ts";
import {
  AGENT_LIMIT_NANO_USD,
  MAX_ROUNDS,
  NANO_USD,
  OPERATING_RESERVE,
  SKILL_USE_NANO_USD,
  budgetNanoUsd,
  nanoUsdToNear,
  nearToNanoUsd,
  withdrawable,
  WITHDRAW_LEFT_BEHIND,
} from "./limits.ts";
import { doHostedWork, parseSkillRequest } from "./work.ts";
import { claimRefusal } from "./runner.ts";
import { stuckReason, telegramNotifier } from "./health.ts";
import type { CallResult } from "../inference.ts";
import type { Bid } from "../board.ts";
import type { HostedAgent } from "./store.ts";

const NEAR = 10n ** 24n;

test("the calculator is arithmetic only, never code", () => {
  assert.equal(calculator("2 + 3 * (4 - 1)"), "11");
  assert.equal(calculator("-7 % 3"), "-1");
  for (const attack of [
    "process.exit(1)",
    "require('fs')",
    "1;2",
    "2**99999",
    "constructor",
    "1/0",
    `${"(".repeat(90)}1${")".repeat(90)}`,
    "1".repeat(201),
    "globalThis",
    "`x`",
  ])
    assert.match(calculator(attack), /^Error/, attack);
});

test("knowledge search returns only text from the agent's own knowledge, with bounded size", () => {
  const knowledge = `alpha beta\n\ngamma delta\n\n${"zeta ".repeat(5000)}`;
  assert.equal(knowledgeSearch(knowledge, "gamma"), "gamma delta");
  assert.match(knowledgeSearch(knowledge, "nothing-here"), /Nothing/);
  assert.ok(knowledgeSearch(knowledge, "zeta").length <= 4096);
  assert.match(knowledgeSearch(knowledge, "!!!"), /No search terms/);
});

test("the JSON validator holds a result to the public format and promises nothing else", () => {
  const format = JSON.stringify({
    kind: "data",
    rows: { id: "string", lines: "array" },
    items: { lines: { cents: "integer" } },
  });
  assert.match(
    jsonValidator('{"rows":[{"id":"a","lines":[{"cents":1}]}]}', format),
    /Fits.*says nothing/,
  );
  assert.match(
    jsonValidator('{"rows":[{"id":1,"lines":[]}]}', format),
    /must be string/,
  );
  assert.match(
    jsonValidator('{"rows":[{"id":"a","lines":[],"x":1}]}', format),
    /not in the format/,
  );
  assert.match(jsonValidator("{", format), /Not valid/);
  assert.match(jsonValidator('{"data":[]}', format), /exactly/);
});

test("a budget comes from the wallet above the reserve, less spending, under a hard ceiling", () => {
  assert.equal(budgetNanoUsd(OPERATING_RESERVE, 0, 0), 0);
  assert.equal(budgetNanoUsd(0n, 0, 0), 0);
  const tenth = NEAR / 10n;
  assert.ok(
    Math.abs(budgetNanoUsd(OPERATING_RESERVE + tenth, 0, 0) - 0.2 * NANO_USD) <
      1,
  );
  assert.ok(
    Math.abs(
      budgetNanoUsd(OPERATING_RESERVE + tenth, 0.05 * NANO_USD, 0) -
        0.15 * NANO_USD,
    ) < 1,
  );
  // Earnings raise the balance, so they raise the budget at the same published rate.
  assert.ok(
    budgetNanoUsd(OPERATING_RESERVE + 2n * tenth, 0, 0) >
      budgetNanoUsd(OPERATING_RESERVE + tenth, 0, 0),
  );
  // However much NEAR an agent holds, the ceiling holds.
  assert.equal(budgetNanoUsd(1000n * NEAR, 0, 0), AGENT_LIMIT_NANO_USD);
  assert.equal(budgetNanoUsd(1000n * NEAR, 0, AGENT_LIMIT_NANO_USD), 0);
});

test("spending is never undercharged, and a withdrawal leaves what is owed", () => {
  const owed = nanoUsdToNear(1234);
  assert.ok(nearToNanoUsd(owed) >= 1234);
  assert.equal(nanoUsdToNear(0), 0n);
  assert.equal(withdrawable(NEAR, 0), NEAR - WITHDRAW_LEFT_BEHIND);
  assert.equal(
    withdrawable(NEAR, NANO_USD),
    NEAR - nanoUsdToNear(NANO_USD) - WITHDRAW_LEFT_BEHIND,
  );
  assert.equal(withdrawable(WITHDRAW_LEFT_BEHIND, 0), 0n);
  assert.equal(withdrawable(0n, 5 * NANO_USD), 0n);
});

const call = (text: string, costNanoUsd = 1000): CallResult =>
  ({
    text,
    costNanoUsd,
    model: "m",
    chatId: "c",
    requestHash: "r",
    responseHash: "h",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
  }) as CallResult;
const profile = {
  id: "hosted:x",
  prompt: "p",
  knowledge: "alpha beta",
  skills: ["calculator" as const],
  key: "k",
};
const task = { description: "d", format: "{}" };

test("a prompt cannot make an attempt loop past its round limit", async () => {
  let calls = 0;
  const charged: number[] = [];
  const work = await doHostedWork(
    {
      call: async () => {
        calls += 1;
        return call('{"skill":"calculator","input":"1+1"}');
      },
    },
    profile,
    task,
    "run",
    () => 1e12,
    (_run, nano) => charged.push(nano),
  );
  assert.equal(calls, MAX_ROUNDS);
  assert.equal(work.deliverable, null);
  assert.equal(work.refusal, "too_many_rounds");
  assert.equal(work.skills.length, MAX_ROUNDS);
  assert.equal(charged.length, MAX_ROUNDS);
  assert.equal(work.costNanoUsd, MAX_ROUNDS * (1000 + SKILL_USE_NANO_USD));
});

test("a skill the agent does not have does nothing, and is logged and not charged", async () => {
  const seen: string[] = [];
  let round = 0;
  const work = await doHostedWork(
    {
      call: async (request) => {
        seen.push(String(request.messages.at(-1)?.content));
        round += 1;
        return round === 1
          ? call('{"skill":"run_code","input":"rm -rf /"}')
          : call('{"rows":[]}');
      },
    },
    profile,
    task,
    "run",
    () => 1e12,
    () => assert.fail("no charge"),
  );
  assert.equal(work.deliverable, '{"rows":[]}');
  assert.deepEqual(work.skills, [
    {
      skill: "run_code",
      allowed: false,
      ran: false,
      input_bytes: 8,
      result_bytes: 42,
    },
  ]);
  assert.match(seen[1]!, /not available/);
});

test("the limit is read again before every call, so a spent budget stops the attempt", async () => {
  const limits: number[] = [];
  let spent = 0;
  await assert.rejects(
    doHostedWork(
      {
        call: async (request) => {
          limits.push(request.limitNanoUsd!);
          if (spent + 1000 > request.limitNanoUsd!)
            throw new Error("over limit");
          spent += 1000;
          return call('{"skill":"calculator","input":"1"}');
        },
      },
      profile,
      task,
      "run",
      () => 2500,
      () => undefined,
    ),
    /over limit/,
  );
  assert.equal(spent, 2000);
  assert.equal(limits.length, 3);
});

test("a skill request is exactly the two fields, so an answer is never mistaken for one", () => {
  assert.deepEqual(parseSkillRequest('{"skill":"a","input":"b"}'), {
    skill: "a",
    input: "b",
  });
  assert.equal(parseSkillRequest('{"skill":"a","input":"b","x":1}'), null);
  assert.equal(parseSkillRequest('{"rows":[]}'), null);
  assert.equal(parseSkillRequest("text"), null);
});

const bid = (over: Partial<Bid> = {}) =>
  ({
    state: "Open",
    buyer: "b.testnet",
    funded_attempts: 0,
    expires_at: "100",
    allowed_workers: null,
    ...over,
  }) as Bid;
const agent = (over: Partial<HostedAgent> = {}) =>
  ({
    wallet: "w.testnet",
    owner: "o.testnet",
    paused: false,
    ...over,
  }) as HostedAgent;

test("agents take only bids they can do, and never their owner's", () => {
  const enough = NEAR;
  assert.equal(claimRefusal(bid(), agent(), 1n, enough), null);
  assert.equal(
    claimRefusal(bid({ state: "Claimed" }), agent(), 1n, enough),
    "not open",
  );
  assert.equal(claimRefusal(bid(), agent(), 100n, enough), "expired");
  assert.equal(
    claimRefusal(bid({ funded_attempts: 3 }), agent(), 1n, enough),
    "no attempts left",
  );
  assert.equal(
    claimRefusal(bid({ buyer: "o.testnet" }), agent(), 1n, enough),
    "own bid",
  );
  assert.equal(
    claimRefusal(bid(), agent({ paused: true }), 1n, enough),
    "paused",
  );
  assert.equal(claimRefusal(bid(), agent(), 1n, NEAR / 10n), "not enough NEAR");
  assert.equal(
    claimRefusal(bid({ allowed_workers: ["x"] }), agent(), 1n, enough),
    "not on this bid's list",
  );
});

test("a job is called stuck only once anyone could really expire it", () => {
  const job = (over: Record<string, unknown>) =>
    ({
      state: "Funded",
      deadline: "100",
      delivered_at: "50",
      verdict_window_secs: 1,
      run_started_at: "60",
      ...over,
    }) as never;
  assert.equal(stuckReason(job({}), 50n), null);
  assert.match(stuckReason(job({}), 101n) ?? "", /deadline/);
  assert.equal(stuckReason(job({ state: "Delivered" }), 60n), null);
  assert.match(
    stuckReason(job({ state: "Delivered" }), 2_000_000_000n) ?? "",
    /verdict/,
  );
  assert.equal(stuckReason(job({ state: "Verifying" }), 2_000_000_000n), null);
  assert.match(
    stuckReason(job({ state: "Verifying" }), 1_000_000_000_000n) ?? "",
    /never finished/,
  );
  assert.equal(
    stuckReason(job({ state: "Released" }), 1_000_000_000_000n),
    null,
  );
});

test("each alert goes out once a day, and nothing is sent without a bot set up", async () => {
  const sent: string[] = [];
  const fake = (async (_url: string, init: { body: string }) => {
    sent.push(init.body);
    return new Response("{}");
  }) as unknown as typeof fetch;
  const alert = { kind: "low_balance" as const, detail: "x" };
  assert.equal(await telegramNotifier(undefined, undefined, fake)([alert]), 0);
  const notify = telegramNotifier("t", "c", fake);
  assert.equal(await notify([alert], 1000), 1);
  assert.equal(await notify([alert], 2000), 0);
  assert.equal(await notify([alert], 90_000_000), 1);
  assert.equal(sent.length, 2);
});
