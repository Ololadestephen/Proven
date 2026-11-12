import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CallResult } from "../inference.ts";
import {
  callFunctionSkill,
  caseList,
  compileDelivery,
  functionSkillPath,
  functionSkillsInstalled,
  functionTarget,
  runFunction,
  watCompile,
} from "./function-skill.ts";
import { SKILL_PRICES } from "./limits.ts";
import { doHostedWork, watAnswer } from "./work.ts";

const example = (name: string) =>
  readFileSync(
    new URL(`../../../examples/function-job/${name}`, import.meta.url),
    "utf8",
  );
const VAT = JSON.stringify({
  arity: 2,
  export: "vat",
  fuel: 1_000_000,
  kind: "function",
});
const DATA = JSON.stringify({ kind: "data", rows: { id: "string" } });
const installed = functionSkillsInstalled();
const needsModule = installed
  ? {}
  : { skip: "run `npm run build:skills` in agent/ first" };
const IDENTITY =
  '(module (func (export "vat") (param i64 i64) (result i64) (local.get 0)))';

test("cases keep i64 values exact and refuse anything else", () => {
  assert.equal(
    caseList(
      [
        [1, "9223372036854775807"],
        ["-9223372036854775808", 0],
      ],
      2,
    ),
    "[[1,9223372036854775807],[-9223372036854775808,0]]",
  );
  for (const bad of [
    [[1]],
    [[1, 2.5]],
    [[1, "9223372036854775808"]],
    [[1, 2 ** 60]],
    [[1, "1e3"]],
    [],
    Array.from({ length: 65 }, () => [1, 2]),
    "[[1,2]]",
  ])
    assert.equal(caseList(bad, 2), null, JSON.stringify(bad).slice(0, 40));
});

test("only a function format names a function to try", () => {
  assert.deepEqual(functionTarget(VAT), {
    export: "vat",
    arity: 2,
    fuel: 1_000_000,
  });
  assert.equal(functionTarget(DATA), null);
  assert.equal(functionTarget("{"), null);
  assert.equal(watAnswer('{"wat":"(module)"}', VAT), "(module)");
  assert.equal(watAnswer('{"wat":"(module)"}', DATA), null);
  assert.equal(watAnswer('{"wat":"(module)","x":1}', VAT), null);
});

test("a missing module refuses every use, and nothing is charged", async () => {
  const missing = "/nonexistent/function-skill.wasm";
  const compiled = await watCompile(IDENTITY, VAT, missing);
  assert.equal(compiled.ran, false);
  assert.match(compiled.output, /not installed/);
  const run = await runFunction(
    JSON.stringify({ wat: IDENTITY, cases: [[1, 2]] }),
    VAT,
    missing,
  );
  assert.equal(run.ran, false);
  const delivery = await compileDelivery(IDENTITY, VAT, missing);
  assert.ok("error" in delivery && delivery.ran === false);
});

test(
  "compiling a delivery gives exactly the committed example deliverable",
  needsModule,
  async () => {
    const delivery = await compileDelivery(example("honest.wat"), VAT);
    assert.ok("deliverable" in delivery);
    assert.deepEqual(
      JSON.parse(delivery.deliverable),
      JSON.parse(example("honest.json")),
    );
  },
);

test(
  "wat_compile says whether the module loads as the bid's function, and returns no bytes",
  needsModule,
  async () => {
    const good = await watCompile(example("honest.wat"), VAT);
    assert.equal(good.ran, true);
    assert.match(good.output, /"loads_as_the_bids_function":true/);
    assert.match(good.output, /answer with only \{"wat"/);
    assert.doesNotMatch(good.output, /wasm_base64|AGFzbQ/);
    const wrongShape = await watCompile(
      '(module (func (export "vat") (param i64) (result i64) (local.get 0)))',
      VAT,
    );
    assert.match(wrongShape.output, /"loads_as_the_bids_function":false/);
    assert.match(wrongShape.output, /fail the format step/);
    const broken = await watCompile("(module (func", VAT);
    assert.equal(broken.ran, true);
    assert.match(broken.output, /^Error: invalid WebAssembly text/);
    const onData = await watCompile(example("honest.wat"), DATA);
    assert.match(onData.output, /"loads_as_the_bids_function":null/);
  },
);

test(
  "run_function gives the check's answers for honest work, and exact large values",
  needsModule,
  async () => {
    const honest = await runFunction(
      JSON.stringify({
        wat: example("honest.wat"),
        cases: [
          [10000, 2000],
          [99, 2000],
          [100, 2000],
          [125, 200],
        ],
      }),
      VAT,
    );
    assert.equal(honest.ran, true);
    const results = (
      JSON.parse(honest.output) as { results: Array<{ result: number }> }
    ).results.map((row) => row.result);
    assert.deepEqual(results, [2000, 0, 20, 3]);
    const large = await runFunction(
      JSON.stringify({ wat: IDENTITY, cases: [["9223372036854775807", 0]] }),
      VAT,
    );
    assert.match(large.output, /"result":9223372036854775807\}/);
  },
);

test(
  "run_function stops a loop with fuel and refuses non-function bids",
  needsModule,
  async () => {
    const loop =
      '(module (func (export "vat") (param i64 i64) (result i64) (loop $l (br $l)) (i64.const 0)))';
    const stuck = await runFunction(
      JSON.stringify({ wat: loop, cases: [[1, 2]] }),
      VAT,
    );
    assert.match(stuck.output, /out of fuel/);
    const onData = await runFunction(
      JSON.stringify({ wat: IDENTITY, cases: [[1, 2]] }),
      DATA,
    );
    assert.equal(onData.ran, false);
    const malformed = await runFunction("not json", VAT);
    assert.equal(malformed.ran, false);
  },
);

test("a request over its time limit is stopped", needsModule, async () => {
  await assert.rejects(
    callFunctionSkill(
      JSON.stringify({ op: "compile", wat: IDENTITY }),
      functionSkillPath(),
      1,
    ),
    /took too long/,
  );
});

const call = (text: string): CallResult =>
  ({
    text,
    costNanoUsd: 1000,
    model: "m",
    chatId: "c",
    requestHash: "r",
    responseHash: "h",
    inputTokens: 1,
    outputTokens: 1,
    finishReason: "stop",
  }) as CallResult;

test(
  'an agent with wat_compile can deliver {"wat"} on a function bid, compiled and charged once',
  needsModule,
  async () => {
    const seen: string[] = [];
    const charged: number[] = [];
    const answers = [
      JSON.stringify({
        wat: '(module (func (export "vat") (param i64) (result i64) (local.get 0)))',
      }),
      JSON.stringify({ wat: example("honest.wat") }),
    ];
    const work = await doHostedWork(
      {
        call: async (request) => {
          seen.push(
            request.messages
              .map((message) => String(message.content))
              .join("\n"),
          );
          return call(answers.shift()!);
        },
      },
      {
        id: "hosted:x",
        prompt: "p",
        knowledge: "",
        skills: ["wat_compile", "run_function"],
      },
      { description: "d", format: VAT },
      "run",
      () => 1e12,
      (_run, nano) => {
        charged.push(nano);
      },
    );
    assert.deepEqual(
      JSON.parse(work.deliverable!),
      JSON.parse(example("honest.json")),
    );
    // The first answer compiled but would not load, so the agent heard why and answered again.
    assert.match(seen[1]!, /would fail the format step/);
    assert.match(seen[0]!, /- run_function: input is \{"wat"/);
    assert.deepEqual(charged, [
      SKILL_PRICES.wat_compile,
      SKILL_PRICES.wat_compile,
    ]);
    assert.equal(work.skills.length, 2);
  },
);

test('an agent without wat_compile gets no compiling, so {"wat"} fails the format check', async () => {
  let rounds = 0;
  const work = await doHostedWork(
    {
      call: async () => {
        rounds += 1;
        return call(JSON.stringify({ wat: IDENTITY }));
      },
    },
    { id: "hosted:y", prompt: "p", knowledge: "", skills: [] },
    { description: "d", format: VAT },
    "run",
    () => 1e12,
    () => assert.fail("no charge"),
  );
  assert.equal(work.deliverable, null);
  assert.equal(work.refusal, "public_format");
  assert.ok(rounds > 1);
});
