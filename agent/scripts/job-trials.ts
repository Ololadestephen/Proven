// Repeated real model runs on the swarm job, judged by the local verifier with the same check logic
// as the escrow. Not on chain; results must be labelled as local. Reports raw counts only.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ROOT } from "../src/config.ts";
import { fetchPrices, Ledger, ModelClient, usd } from "../src/inference.ts";
import { doWork, type AgentProfile } from "../src/llm-work.ts";
import { publicMessage } from "../src/errors.ts";

const [
  label,
  promptFile,
  countArg,
  keyName = "NEARAI_CLOUD_API_KEY",
  limitUsd = "0.30",
] = process.argv.slice(2);
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const task = readFileSync(`${ROOT}examples/swarm-job/task.txt`, "utf8");
const dir = `${ROOT}runs/swarm-trials/${label}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const ledger = new Ledger(`${ROOT}runs/inference-ledger.jsonl`);
const client = new ModelClient(ledger, await fetchPrices());
const agent: AgentProfile = {
  id: "job-trials",
  prompt: readFileSync(promptFile, "utf8"),
  knowledge: "",
  key: env[keyName] ?? "",
  limitNanoUsd: Number(limitUsd) * 1e9,
};
const verify = (file: string) =>
  JSON.parse(
    execFileSync(`${ROOT}verifier/target/release/proven`, [
      "run",
      "verify",
      `${ROOT}examples/swarm-job/check.json`,
      file,
    ]).toString(),
  );

const count = Number(countArg);
const tally: Record<string, number> = {};
let cost = 0;
for (let i = 1; i <= count; i++) {
  const run = `${label}-${i}`;
  let outcome: string;
  try {
    const work = await doWork(client, agent, task, "job-trial", run);
    cost += work.call.costNanoUsd;
    if (work.deliverable === null) {
      outcome = `unusable:${work.refusal}`;
    } else {
      const file = `${dir}/${i}.json`;
      writeFileSync(file, work.deliverable, { mode: 0o600 });
      const verdict = verify(file);
      outcome = verdict.pass ? "pass" : `fail:${verdict.failed_rule}`;
    }
    console.log(
      JSON.stringify({
        run,
        outcome,
        input: work.call.inputTokens,
        output: work.call.outputTokens,
        usd: usd(work.call.costNanoUsd),
        finish: work.call.finishReason,
      }),
    );
  } catch (error) {
    outcome = `no_result:${publicMessage(error)}`;
    console.log(JSON.stringify({ run, outcome }));
  }
  tally[outcome] = (tally[outcome] ?? 0) + 1;
}
console.log(JSON.stringify({ label, runs: count, tally, usd: usd(cost) }));
