// Scripted agents using exactly the public CLI. Private inputs travel through stdin, never argv.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { JsonRpcProvider } from "near-api-js";
import { ROOT, loadConfig } from "./config.ts";
import { PublicError, publicMessage } from "./errors.ts";
import type { Actor, Job } from "./types.ts";

interface Outcome {
  transaction_hash?: string;
  result?: unknown;
  failed?: boolean;
  pending?: boolean;
  private_handoff?: unknown;
  job?: Job;
}
async function tool(
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
  dry = false,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const cli = spawn(
      process.execPath,
      [
        `${ROOT}agent/src/cli.ts`,
        name,
        "--actor",
        actor,
        ...(dry ? ["--dry-run"] : []),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    const timer = setTimeout(() => {
      cli.kill();
      reject(
        new PublicError(
          "Demo command timed out. Inspect job status and evidence before retrying.",
        ),
      );
    }, 240000);
    cli.stdout.on("data", (data) => {
      output += data.toString();
      if (Buffer.byteLength(output) > 1048576) cli.kill();
    });
    cli.stderr.resume();
    cli.on("error", () => {
      clearTimeout(timer);
      reject(new PublicError("Could not start the agent CLI."));
    });
    cli.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new PublicError(
            `Demo ${name} stopped. Inspect the last recorded job before retrying.`,
          ),
        );
      try {
        resolve(JSON.parse(output) as Outcome);
      } catch {
        reject(new PublicError("Demo CLI returned invalid JSON."));
      }
    });
    cli.stdin.on("error", () => undefined);
    cli.stdin.end(JSON.stringify(args));
  });
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const dry = cliArgs.includes("--dry-run");
  const resume = cliArgs[0] === "--resume" ? cliArgs[1] : undefined;
  if (!(
    cliArgs.length === 0 ||
    (cliArgs.length === 1 && dry) ||
    (cliArgs.length === 2 &&
      resume?.startsWith(`${ROOT}runs/p4-demo-`) &&
      resume.endsWith(".json"))
  ))
    throw new PublicError(
      "Usage: npm run demo -- [--dry-run | --resume <evidence-file>]",
    );
  const base = `${ROOT}examples/data-job/`;
  const check = readFileSync(`${base}check-strong.json`, "utf8");
  const reference = readFileSync(`${base}reference.json`, "utf8");
  const config = loadConfig("buyer");
  const provider = new JsonRpcProvider({ url: config.rpc });
  const evidence: {
    scripted: boolean;
    dry_run: boolean;
    cases: Array<Record<string, unknown>>;
    completed?: string;
  } = resume
    ? JSON.parse(readFileSync(resume, "utf8"))
    : { scripted: true, dry_run: dry, cases: [] };
  if (resume && evidence.dry_run)
    throw new PublicError("Cannot resume dry-run evidence as a live run.");
  mkdirSync(`${ROOT}runs`, { recursive: true });
  const file = resume ?? `${ROOT}runs/p4-demo-${randomUUID()}.json`;
  const save = () =>
    writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
  const near = async (accountId: string) =>
    (
      await provider.viewAccount({
        accountId,
        blockQuery: { finality: "final" },
      })
    ).amount;
  for (const worker of ["honest", "fake"] as const) {
    const identity = loadConfig(worker).account;
    if (!identity)
      throw new PublicError(
        "Run the owner-approved testnet setup before the scripted demo.",
      );
    let entry = evidence.cases.find((c) => c.worker === worker);
    if (!entry) {
      entry = { worker, worker_account: identity };
      evidence.cases.push(entry);
    }
    save();
    if (!entry.post) {
      if (entry.post_started)
        throw new PublicError(
          "Job creation has an unknown prior outcome. Reconcile custody history and record its id before resuming.",
        );
      entry.post_started = true;
      save();
      entry.post = await tool(
        "buyer",
        "post_job",
        {
          worker: identity,
          check,
          reference,
          amount_near: "0.01",
          deadline_seconds: 3600,
          verdict_window_secs: 1800,
        },
        dry,
      );
    }
    save();
    if (dry) continue;
    const created = entry.post as Outcome;
    if (
      created.failed ||
      created.pending ||
      !Number.isSafeInteger(created.result)
    )
      throw new PublicError(
        "Job creation has no confirmed id. Inspect custody history before retrying.",
      );
    const jobId = created.result as number;
    entry.job_id = jobId;
    save();
    console.error(`Scripted ${worker} case: job ${jobId}`);
    let observed = (await tool("buyer", "job_status", {
      job_id: jobId,
    })) as unknown as Job;
    if (observed.state === "Draft") {
      entry.challenge = await tool("buyer", "challenge_check", {
        job_id: jobId,
        check,
        reference,
      });
      save();
    }
    observed = (await tool("buyer", "job_status", {
      job_id: jobId,
    })) as unknown as Job;
    if (observed.state === "Challenged") {
      entry.fund = await tool("buyer", "fund_job", { job_id: jobId });
      save();
    }
    const funded = await tool("buyer", "job_status", { job_id: jobId });
    if (
      (funded as unknown as Job).state === "Funded" ||
      ((funded as unknown as Job).state === "Delivered" && !entry.delivery)
    ) {
      entry.delivery = await tool(worker, "deliver", {
        job_id: jobId,
        deliverable: readFileSync(`${base}deliverable-${worker}.json`, "utf8"),
      });
      save();
    }
    if ((entry.delivery as Outcome | undefined)?.private_handoff === false)
      throw new PublicError(
        "Delivery was committed but private handoff needs retry with identical bytes.",
      );
    observed = (await tool("buyer", "job_status", {
      job_id: jobId,
    })) as unknown as Job;
    if (observed.state === "Delivered") {
      entry.verification = await tool("buyer", "request_verification", {
        job_id: jobId,
      });
      save();
    }
    observed = (await tool("buyer", "job_status", {
      job_id: jobId,
    })) as unknown as Job;
    if (["Released", "Refunded"].includes(observed.state)) {
      if (
        observed.state !== (worker === "honest" ? "Released" : "Refunded") ||
        !(entry.payout as Outcome | undefined)?.transaction_hash ||
        typeof entry.balance_change !== "string" ||
        BigInt(entry.balance_change) < 10000000000000000000000n
      )
        throw new PublicError(
          "Terminal job needs the expected outcome and recorded payout evidence before completion. Reconcile receipts before resuming.",
        );
      entry.final = observed;
      save();
      continue;
    }
    const expected = worker === "honest" ? "Passed" : "Failed";
    if (observed.state !== expected)
      throw new PublicError(
        "Verification did not reach the expected real verdict.",
      );
    const receiver = worker === "honest" ? identity : config.account!;
    const before = await near(receiver);
    entry.payout = await tool("fake", "release_or_refund", { job_id: jobId });
    save();
    const after = await near(receiver);
    entry.receiver = receiver;
    entry.balance_before = before.toString();
    entry.balance_after = after.toString();
    entry.balance_change = (after - before).toString();
    entry.final = await tool("buyer", "job_status", { job_id: jobId });
    save();
    if (
      (entry.final as unknown as Job).state !==
      (worker === "honest" ? "Released" : "Refunded")
    )
      throw new PublicError("Payout did not settle.");
    if (after - before < 10000000000000000000000n)
      throw new PublicError(
        "Receiver balance did not include the job payment. Inspect receipts.",
      );
    console.error(`Job ${jobId}: ${(entry.final as unknown as Job).state}`);
  }
  evidence.completed = new Date().toISOString();
  save();
  console.log(JSON.stringify({ ...evidence, evidence_file: file }, null, 2));
}
if (import.meta.main)
  main().catch((error) => {
    console.error(publicMessage(error));
    process.exitCode = 1;
  });
