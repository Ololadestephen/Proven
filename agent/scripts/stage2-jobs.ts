// Stage 2: one honest and one fake job on the unaudited, owner-funded mainnet deployment. The honest
// delivery is a real model's work; the fake is a scripted wrong delivery, labelled as scripted. Each
// step follows what the chain says, so an interrupted run resumes without repeating a signed call.
// Needs the relay on mainnet. Prints no key.
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/stage2-jobs.ts <honest|fake>
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { loadConfig, ROOT } from "../src/config.ts";
import { PublicError, publicMessage } from "../src/errors.ts";
import { fetchPrices, Ledger, ModelClient, usd } from "../src/inference.ts";
import { keysFrom, KeyPool } from "../src/key-pool.ts";
import { doWork } from "../src/llm-work.ts";
import { executeTool } from "../src/service.ts";
import type { Job } from "../src/types.ts";

const kind = process.argv[2];
if (kind !== "honest" && kind !== "fake")
  throw new Error("Use honest or fake.");
const config = loadConfig("buyer");
if (!config.escrow.endsWith(".near"))
  throw new Error("This script is for the mainnet deployment only.");
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const provider = new JsonRpcProvider({ url: config.rpc });
const dir = `${ROOT}examples/swarm-job`;
const check = readFileSync(`${dir}/check.json`, "utf8");
const reference = readFileSync(`${dir}/reference.json`, "utf8");
const task = readFileSync(`${dir}/task.txt`, "utf8");
const worker =
  kind === "honest"
    ? env.MAINNET_WORKER_A_ACCOUNT_ID!
    : env.MAINNET_WORKER_B_ACCOUNT_ID!;
const privateDir = `${ROOT}runs/private/stage2-${kind}`;
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const evidencePath = `${ROOT}runs/stage2-${kind}.json`;
const evidence: Record<string, unknown> = existsSync(evidencePath)
  ? (JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>)
  : {
      label: "unaudited, owner-funded mainnet deployment",
      kind,
      escrow: config.escrow,
      worker,
      steps: [],
    };
const save = () =>
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
const log = (step: string, detail: unknown) => {
  (evidence.steps as unknown[]).push({
    at: new Date().toISOString(),
    step,
    detail,
  });
  save();
  console.log(JSON.stringify({ step, detail }).slice(0, 320));
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const view = <T>(method: string, args: Record<string, unknown>) =>
  provider.callFunction({
    contractId: config.escrow,
    method,
    args,
  }) as unknown as Promise<T>;
const pause = () => new Promise((resolve) => setTimeout(resolve, 15_000));
const buyer = (name: string, args: Record<string, unknown>) =>
  executeTool(name, args, { actor: "buyer" }) as Promise<{
    transaction_hash?: string;
    result?: unknown;
    failed?: boolean;
    job?: Job;
  }>;
const named = (name: string, args: Record<string, unknown>) =>
  executeTool(name, args, {
    actor: kind === "honest" ? "honest" : "fake",
  }) as Promise<{ transaction_hash?: string; private_handoff?: unknown }>;

/** A job of this kind already on chain, so that creating is never repeated. */
async function findJob(): Promise<number | null> {
  const { next_job_id } = await view<{ next_job_id: number }>("get_config", {});
  for (let from = 0; from < next_job_id; from += 50) {
    const page = await view<Array<[number, Job]>>("get_jobs", {
      from_id: from,
      limit: 50,
    });
    for (const [id, job] of page)
      if (job.worker === worker && job.spec_hash === sha(check)) return id;
  }
  return null;
}

async function delivery(): Promise<string> {
  const path = `${privateDir}/deliverable.json`;
  if (existsSync(path)) return readFileSync(path, "utf8");
  let text: string;
  if (kind === "fake") {
    // Scripted by the operator: a correct-looking table with one total changed.
    const honest = `${ROOT}runs/private/stage2-honest/deliverable.json`;
    const parsed = JSON.parse(readFileSync(honest, "utf8")) as {
      rows: Array<{ invoice_id: string; total_cents: number }>;
    };
    const row = parsed.rows.find((item) => item.invoice_id === "INV-3004");
    if (!row) throw new PublicError("The honest delivery has no INV-3004.");
    row.total_cents = 999;
    text = JSON.stringify(parsed);
    log("scripted_wrong_delivery", {
      note: "Scripted by the operator, not model work",
      hash: sha(text),
    });
  } else {
    const ledger = new Ledger(`${ROOT}runs/inference-ledger.jsonl`);
    const pool = new KeyPool(
      new ModelClient(ledger, await fetchPrices()),
      ledger,
      keysFrom(env, ["NEARAI_KEY_AGENT_A"]),
      {
        agentNanoUsd: 300_000_000,
        projectNanoUsd: 1_000_000_000,
        jobNanoUsd: 50_000_000,
      },
      `${ROOT}runs/key-events.jsonl`,
    );
    const work = await doWork(
      pool,
      {
        id: "agent-a",
        prompt: readFileSync(
          `${ROOT}agent/scripts/prompts/agent-a.txt`,
          "utf8",
        ),
        knowledge: readFileSync(
          `${ROOT}agent/scripts/prompts/agent-a-knowledge.txt`,
          "utf8",
        ),
        key: "",
        limitNanoUsd: 100_000_000,
      },
      task,
      "stage2-work",
      `stage2-${kind}`,
    );
    log("inference", {
      model: work.call.model,
      chat_id: work.call.chatId,
      input_tokens: work.call.inputTokens,
      output_tokens: work.call.outputTokens,
      usd: usd(work.call.costNanoUsd),
    });
    if (work.deliverable === null)
      throw new PublicError(
        `The model gave no usable delivery: ${work.refusal}`,
      );
    text = work.deliverable;
  }
  writeFileSync(path, text, { mode: 0o600 });
  return text;
}

async function main() {
  let id = await findJob();
  if (id === null) {
    if (evidence.creating)
      throw new PublicError(
        "An earlier create has an unknown outcome and no job shows yet. Check before retrying.",
      );
    evidence.creating = true;
    save();
    const posted = await buyer("post_job", {
      worker,
      check,
      reference,
      amount_near: "0.01",
    });
    if (posted.failed) throw new PublicError("Creating the job failed.");
    id = posted.result as number;
    log("post_job", { job_id: id, transaction_hash: posted.transaction_hash });
  }
  evidence.job_id = id;
  save();
  for (let step = 0; step < 40; step++) {
    const job = await view<Job>("get_job", { job_id: id });
    switch (job.state) {
      case "Draft": {
        const run = await buyer("challenge_check", {
          job_id: id,
          check,
          reference,
        });
        log("challenge", {
          transaction_hash: run.transaction_hash,
          state: run.job?.state,
          fakes: `${run.job?.fakes_caught} of ${run.job?.fakes_total}`,
          request: run.job?.challenge_request_id,
        });
        break;
      }
      case "Challenged": {
        const funded = await buyer("fund_job", { job_id: id });
        if (funded.failed) throw new PublicError("Funding failed on chain.");
        log("fund_job", funded.transaction_hash);
        break;
      }
      case "Funded": {
        const delivered = await named("deliver", {
          job_id: id,
          deliverable: await delivery(),
        });
        log("deliver", {
          transaction_hash: delivered.transaction_hash,
          private_handoff: Boolean(delivered.private_handoff),
        });
        if (!delivered.private_handoff)
          throw new PublicError("The private handoff failed. Is the relay up?");
        break;
      }
      case "Delivered": {
        const run = await buyer("request_verification", { job_id: id });
        log("request_verification", {
          transaction_hash: run.transaction_hash,
          state: run.job?.state,
          request: run.job?.verdict_request_id,
          failed_rule: run.job?.failed_rule,
        });
        break;
      }
      case "Passed":
      case "Failed": {
        // Anyone can settle, and the payee is fixed by the job. Payouts need 50 Tgas, more gas than a
        // worker's small balance can have held back, so the buyer's wallet sends it.
        const settled = await buyer("release_or_refund", { job_id: id });
        log(
          job.state === "Passed" ? "release" : "refund",
          settled.transaction_hash,
        );
        break;
      }
      case "Challenging":
      case "Verifying":
      case "Releasing":
      case "Refunding":
      case "Expiring":
        await pause();
        break;
      default:
        evidence.final = {
          state: job.state,
          failed_rule: job.failed_rule,
          fakes: `${job.fakes_caught} of ${job.fakes_total}`,
          challenge_request: job.challenge_request_id,
          verdict_request: job.verdict_request_id,
          deliverable_hash: job.deliverable_hash,
          report_hash: job.report_hash,
        };
        save();
        console.log(JSON.stringify(evidence.final));
        return;
    }
  }
  throw new PublicError(
    "The job did not settle in time. Run this again to resume.",
  );
}

main().catch((error) => {
  console.error(publicMessage(error));
  process.exitCode = 1;
});
