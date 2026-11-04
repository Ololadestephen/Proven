// Proven relay: a convenience, not an authority. It holds a job's private texts, pins them as an
// OutLayer secret, triggers runs (anyone may) and audits attestations (anyone may). It cannot set a
// result: only the escrow's own callback can. If it withholds the texts, no verdict can be reached
// and the job expires to the buyer; if it changes them, the verifier refuses them.
//
//   npm run relay -- challenge <job_id> <check.json> <reference.json> [--pin-only]
//   npm run relay -- verify    <job_id> <check.json> <deliverable.json> [--pin-only]
//   npm run relay -- audit     <job_id> challenge|verify
//   npm run relay -- unpin     <job_id> challenge|verify
//
// `challenge` and `verify` check the files against the job's hashes, pin them, trigger the run,
// audit the attestation and delete the secret. With `--pin-only` they stop after pinning, so any
// account can trigger the run. Every run writes an evidence file to runs/relay/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { checkAttestation, fetchAttestation } from "./attestation.ts";
import { type Config, loadConfig } from "./config.ts";
import { sha256Hex } from "./hash.ts";
import { getJob, type Job, relayAccount, type RunKind, secretsProfile, triggerRun } from "./near.ts";
import { deleteSecret, storeSecret } from "./secret.ts";

const USAGE = `usage:
  relay challenge <job_id> <check.json> <reference.json> [--pin-only]
  relay verify    <job_id> <check.json> <deliverable.json> [--pin-only]
  relay audit     <job_id> challenge|verify
  relay unpin     <job_id> challenge|verify`;

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function jobNumber(text: string | undefined): number {
  const jobId = Number(text);
  if (!text || !Number.isSafeInteger(jobId) || jobId < 0) usage();
  return jobId;
}

function kindOf(word: string | undefined): RunKind {
  if (word === "challenge") return "Challenge";
  if (word === "verify") return "Verify";
  usage();
}

/** The exact public input the contract builds for a run: its keys in the contract's order. */
export function runInput(job: Job, jobId: number, kind: RunKind, escrow: string): string {
  return JSON.stringify(
    kind === "Challenge"
      ? { mode: "challenge", escrow, job: jobId, check_hash: job.spec_hash, reference_hash: job.fakes_hash }
      : { mode: "verify", escrow, job: jobId, check_hash: job.spec_hash, deliverable_hash: job.deliverable_hash },
  );
}

/** Checks a recorded result's attestation against the job. Returns the summary for the evidence. */
async function audit(config: Config, job: Job, jobId: number, kind: RunKind) {
  const requestId = kind === "Challenge" ? job.challenge_request_id : job.verdict_request_id;
  const reportHash = kind === "Challenge" ? job.challenge_report_hash : job.report_hash;
  if (!requestId || !reportHash) throw new Error(`job ${jobId} has no recorded ${kind} result (state ${job.state})`);
  const record = await fetchAttestation(config.outlayerApi, Number(requestId));
  const taskHash = checkAttestation(record, {
    wasmHash: job.verifier_hash,
    inputText: runInput(job, jobId, kind, config.escrowContract),
    outputHash: reportHash,
    secretsRef: `${job.secrets_owner}/${secretsProfile(job, jobId, kind)}`,
  });
  return {
    request_id: requestId,
    task_id: record.task_id,
    attestation: `${config.outlayerApi}/attestations/by-request/${requestId}`,
    transaction_hash: record.transaction_hash,
    caller: record.caller_account_id,
    wasm_hash: record.wasm_hash,
    task_hash: taskHash,
    worker_measurement: record.worker_measurement,
    checked: ["wasm hash = job's verifier", "input hash = job's hashes", "output hash = recorded report hash", "secret = job's secret", "quote report_data = task hash", "quote RTMR3 = worker measurement"],
    not_checked: ["Intel signature chain", "on-chain approval of the worker measurements"],
  };
}

async function pinAndRun(kind: RunKind, jobId: number, checkPath: string, otherPath: string, pinOnly: boolean): Promise<void> {
  const config = loadConfig();
  const account = relayAccount(config);
  const job = await getJob(account, config, jobId);

  // 1. The job must be in the right state, and the files exactly the ones it is fixed to.
  const expectState = kind === "Challenge" ? "Draft" : "Delivered";
  if (job.state !== expectState) throw new Error(`job ${jobId} is ${job.state}, expected ${expectState}`);
  if (job.secrets_owner !== account.accountId) throw new Error(`job ${jobId} reads secrets of ${job.secrets_owner}, not ${account.accountId}`);
  const checkText = readFileSync(checkPath, "utf8");
  const otherText = readFileSync(otherPath, "utf8");
  if (sha256Hex(checkText) !== job.spec_hash) throw new Error("the check file does not match the job's spec_hash");
  const expectedOther = kind === "Challenge" ? job.fakes_hash : job.deliverable_hash;
  if (sha256Hex(otherText) !== expectedOther) throw new Error(`the ${kind === "Challenge" ? "reference" : "deliverable"} does not match the job's hash`);
  const checkVerifier = JSON.parse(checkText).verifier;
  if (checkVerifier !== job.verifier_hash) throw new Error(`the check is written for verifier ${checkVerifier}, but the job pins ${job.verifier_hash}`);

  // 2. Pin the texts as a secret only this job's verifier build can read, through the escrow.
  const profile = secretsProfile(job, jobId, kind);
  const variables = { PROVEN_CHECK: checkText, [kind === "Challenge" ? "PROVEN_REFERENCE" : "PROVEN_DELIVERABLE"]: otherText };
  const stored = await storeSecret(account, config, job.verifier_hash, profile, variables);
  console.error(`job ${jobId}: pinned secret ${profile} (${stored.ciphertextBytes} bytes of ciphertext, tx ${stored.transactionHash})`);
  if (pinOnly) {
    console.log(JSON.stringify({ job_id: jobId, pinned: profile, transaction_hash: stored.transactionHash }, null, 2));
    return;
  }

  // 3. Trigger the run, like anyone can, and read what the contract recorded.
  console.error(`job ${jobId}: asking the escrow to run the ${kind}...`);
  const triggerTx = await triggerRun(account, config, jobId, kind);
  const after = await getJob(account, config, jobId);
  const recorded = kind === "Challenge" ? after.challenge_request_id : after.verdict_request_id;
  const evidence: Record<string, unknown> = {
    job_id: jobId,
    kind,
    escrow: config.escrowContract,
    trigger_transaction: triggerTx,
    secret: { profile, owner: account.accountId, stored_in: stored.transactionHash },
    state_after: after.state,
    fakes: kind === "Challenge" ? { total: after.fakes_total, caught: after.fakes_caught } : undefined,
    failed_rule: after.failed_rule,
  };

  // 4. Audit the attestation, if a result was recorded. A failed audit is reported, not hidden.
  if (recorded) {
    evidence.audit = await audit(config, after, jobId, kind).catch((error: Error) => ({ failed: error.message }));
  } else {
    evidence.no_result = "the contract recorded nothing; the job can be run again";
  }

  // 5. The run is over: return the storage deposit. A retry pins the texts again.
  evidence.secret_deleted = await deleteSecret(account, config, job.verifier_hash, profile).catch((error: Error) => `failed: ${error.message}`);
  mkdirSync("../runs/relay", { recursive: true });
  const file = `../runs/relay/job-${jobId}-${kind.toLowerCase()}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ ...evidence, evidence: file }, null, 2));
  if (!recorded) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pinOnly = args.includes("--pin-only");
  const [command, jobArg, first, second, ...extra] = args.filter((a) => a !== "--pin-only");
  if (extra.length || args.some((a) => a.startsWith("--") && a !== "--pin-only")) usage();
  const jobId = jobNumber(jobArg);
  if (command === "challenge" || command === "verify") {
    if (!first || !second) usage();
    return pinAndRun(command === "challenge" ? "Challenge" : "Verify", jobId, first, second, pinOnly);
  }
  if (second) usage();
  const kind = kindOf(first);
  const config = loadConfig();
  const account = relayAccount(config);
  const job = await getJob(account, config, jobId);
  if (command === "audit") {
    console.log(JSON.stringify(await audit(config, job, jobId, kind), null, 2));
  } else if (command === "unpin") {
    const profile = secretsProfile(job, jobId, kind);
    console.log(JSON.stringify({ deleted: profile, transaction_hash: await deleteSecret(account, config, job.verifier_hash, profile) }));
  } else {
    usage();
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(`relay: ${error.message}`);
    process.exit(1);
  });
}
