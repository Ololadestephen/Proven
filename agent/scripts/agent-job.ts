// One real model-driven job through the existing escrow, before any board exists. The buyer posts,
// challenges and funds with its restricted custody wallet; the agent works only once the job is
// Funded; only the escrow's callback-recorded verdict moves money. Stops at the first error and
// repeats no signed action. Needs the relay handoff running: `cd relay && npm run handoff`.
//   node scripts/agent-job.ts <label> <prompt-file> <key-variable> <job-directory> [existing-job-id]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ROOT } from "../src/config.ts";
import { fetchPrices, Ledger, ModelClient, usd } from "../src/inference.ts";
import { doWork } from "../src/llm-work.ts";

const [label, promptFile, keyName, jobDir, resumeJob] = process.argv.slice(2);
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const work = `${ROOT}runs/private/agent-job-${label}`;
mkdirSync(work, { recursive: true, mode: 0o700 });
const evidencePath = `${ROOT}runs/agent-job-${label}.json`;
const evidence: Record<string, unknown> = { label, model_key: keyName, steps: [] };
const save = () => writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

function tool(name: string, args: Record<string, unknown>, actor: "buyer" | "honest"): Record<string, unknown> {
  const file = `${work}/${name}.json`;
  writeFileSync(file, JSON.stringify(args), { mode: 0o600 });
  const output = execFileSync("node", ["src/cli.ts", name, `@${file}`, "--actor", actor], { cwd: `${ROOT}agent`, encoding: "utf8" });
  const result = JSON.parse(output) as Record<string, unknown>;
  const safe = JSON.parse(JSON.stringify(result, (key, value) => (["check", "reference", "deliverable"].includes(key) ? "<private>" : value)));
  (evidence.steps as unknown[]).push({ tool: name, actor, result: safe });
  save();
  console.log(`${name}: ${JSON.stringify(safe).slice(0, 300)}`);
  return result;
}

const check = readFileSync(`${ROOT}${jobDir}/check.json`, "utf8");
const reference = readFileSync(`${ROOT}${jobDir}/reference.json`, "utf8");
const task = readFileSync(`${ROOT}${jobDir}/task.txt`, "utf8");

// A job already created is resumed, never created again.
const job_id = resumeJob !== undefined ? Number(resumeJob) : (tool("post_job", { worker: env.PROVEN_HONEST_ACCOUNT_ID, check, reference, amount_near: "0.01" }, "buyer").result as number);
if (!Number.isSafeInteger(job_id)) throw new Error("post_job returned no job id");
evidence.job_id = job_id;
tool("challenge_check", { job_id, check, reference }, "buyer");
tool("fund_job", { job_id }, "buyer");
const status = tool("job_status", { job_id }, "buyer");
if (!JSON.stringify(status).includes('"Funded"')) throw new Error("the job is not Funded, so the agent does not start");

const client = new ModelClient(new Ledger(`${ROOT}runs/inference-ledger.jsonl`), await fetchPrices());
const result = await doWork(client, { id: "agent-a", prompt: readFileSync(promptFile, "utf8"), knowledge: "", key: env[keyName] ?? "", limitNanoUsd: 1e9 }, task, "agent-work", label);
evidence.inference = { model: result.call.model, chat_id: result.call.chatId, input_tokens: result.call.inputTokens, output_tokens: result.call.outputTokens, usd: usd(result.call.costNanoUsd), request_hash: result.call.requestHash, response_hash: result.call.responseHash };
save();
console.log(`inference: ${JSON.stringify(evidence.inference)}`);
if (result.deliverable === null) {
  evidence.outcome = `no delivery: ${result.refusal}`;
  save();
  throw new Error(`the model output is not a deliverable: ${result.refusal}`);
}
writeFileSync(`${work}/deliverable.json`, result.deliverable, { mode: 0o600 });
tool("deliver", { job_id, deliverable: result.deliverable }, "honest");
tool("request_verification", { job_id }, "buyer");
tool("release_or_refund", { job_id }, "buyer");
const final = tool("job_status", { job_id }, "buyer");
evidence.final = final;
save();
