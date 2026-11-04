// Proven relay.
//
//   npm run relay -- challenge <job_id> <check.json> <reference.json> [--public] [--no-post]
//   npm run relay -- verify    <job_id> <check.json> <deliverable.json> [--public] [--no-post]
//
// By default the files stay private: the relay stores them as its own OutLayer secret (see
// secret.ts), sends only their hashes in the public input, and deletes the secret afterwards.
// With --public they are sent in the clear and become public on chain.
//
// For a job on the escrow, the relay checks that the files are the ones the job is fixed to (by
// hash), runs the verifier on OutLayer, checks the attestation against what it sent and received,
// and records the result on the escrow. Only the verifier's output decides; nothing in the files is
// read as a result. In a challenge the verifier generates the planted fakes itself from the
// reference. `--no-post` does everything except the final escrow call.
// Every run writes an evidence file to runs/relay/ before anything is posted, and updates it after.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { checkAttestation, fetchAttestation } from "./attestation.ts";
import { loadConfig } from "./config.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";
import { getJob, recordOnEscrow, relayAccount, runOnOutlayer } from "./near.ts";
import { deleteSecret, storeSecret } from "./secret.ts";
import { challengeCall, verdictCall } from "./verdict.ts";

type Mode = "challenge" | "verify";
const USAGE = `usage:
  relay challenge <job_id> <check.json> <reference.json> [--public] [--no-post]
  relay verify    <job_id> <check.json> <deliverable.json> [--public] [--no-post]
  Files stay private (relay-owned OutLayer secret, hashes only on chain) unless --public is given.`;

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): { mode: Mode; jobId: number; files: [string, string]; isPublic: boolean; noPost: boolean } {
  const flags = ["--no-post", "--public"];
  const rest = argv.filter((a) => !flags.includes(a));
  if (rest.some((a) => a.startsWith("--"))) usage();
  const [mode, jobArg, check, other, ...extra] = rest;
  const jobId = Number(jobArg);
  if ((mode !== "challenge" && mode !== "verify") || !Number.isSafeInteger(jobId) || jobId < 0 || !check || !other || extra.length) usage();
  return { mode, jobId, files: [check, other], isPublic: argv.includes("--public"), noPost: argv.includes("--no-post") };
}

async function main(): Promise<void> {
  const { mode, jobId, files, isPublic, noPost } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const account = relayAccount(config);
  const job = await getJob(account, config, jobId);

  // 1. The job must be in the right state, and the files exactly the ones it is fixed to.
  const expectState = mode === "challenge" ? "Draft" : "Delivered";
  if (job.state !== expectState) throw new Error(`job ${jobId} is ${job.state}, expected ${expectState}`);
  const [checkText, otherText] = files.map((f) => readFileSync(f, "utf8"));
  if (sha256Hex(checkText) !== job.spec_hash) throw new Error("the check file does not match the job's spec_hash");
  const otherHash = sha256Hex(otherText);
  if (mode === "challenge" && otherHash !== job.fakes_hash) throw new Error("the reference does not match the job's fakes_hash");
  if (mode === "verify" && otherHash !== job.deliverable_hash) throw new Error("the deliverable does not match the delivered hash");
  const checkVerifier = JSON.parse(checkText).verifier;
  if (checkVerifier !== config.verifierWasmHash) throw new Error(`the check is written for verifier ${checkVerifier}, but the relay runs ${config.verifierWasmHash}`);

  const otherField = mode === "challenge" ? "reference" : "deliverable";
  let input: string;
  let secret: { profile: string; account_id: string } | undefined;
  if (isPublic) {
    input = JSON.stringify({ mode, check: checkText, [otherField]: otherText });
  } else {
    // Private: the texts go into a relay-owned secret; the public input carries only hashes, and
    // the verifier refuses the secret unless it matches them.
    const profile = `${mode === "challenge" ? "c" : "v"}${jobId}-${otherHash.slice(0, 12)}`;
    const variables = { PROVEN_CHECK: checkText, [mode === "challenge" ? "PROVEN_REFERENCE" : "PROVEN_DELIVERABLE"]: otherText };
    const stored = await storeSecret(account, config, profile, variables);
    console.error(`job ${jobId}: stored relay-owned secret ${profile} (${stored.ciphertextBytes} bytes of ciphertext, tx ${stored.transactionHash})`);
    secret = { profile, account_id: account.accountId };
    input = JSON.stringify({ mode, check_hash: job.spec_hash, [`${otherField}_hash`]: otherHash });
  }

  // 2. Run the verifier on OutLayer.
  console.error(`job ${jobId}: running ${mode} on OutLayer (${input.length} bytes of public input${secret ? `, secret ${secret.profile}@${secret.account_id}` : ""})...`);
  const run = await runOnOutlayer(account, config, input, secret);
  const outputText = canonicalJson(run.output);
  const outputHash = sha256Hex(outputText);
  const verdict = run.output as Record<string, unknown>;

  // 3. Check the attestation against what we sent and received.
  const record = await fetchAttestation(config.outlayerApi, run.requestId);
  const attestationHash = checkAttestation(record, {
    wasmHash: config.verifierWasmHash,
    inputText: input,
    outputHash,
    caller: config.relayAccountId,
    transactionHash: run.transactionHash,
  });

  // 4. The verifier's output must name this job's exact files.
  if (verdict.error !== null) throw new Error(`the verifier reported an error: ${verdict.error}`);
  if (verdict.mode !== mode || verdict.spec_hash !== job.spec_hash) throw new Error("the verifier output is for a different check");
  if (mode === "challenge" && verdict.fakes_hash !== job.fakes_hash) throw new Error("the verifier output is for a different reference");
  if (mode === "verify" && verdict.deliverable_hash !== job.deliverable_hash) throw new Error("the verifier output is for a different deliverable");

  // 5. Build the escrow call from the verifier's output only, after checking its types.
  const common = { job_id: jobId, spec_hash: job.spec_hash, report_hash: outputHash, attestation_hash: attestationHash };
  const [method, escrowArgs] = mode === "challenge" ? challengeCall(verdict, job, common) : verdictCall(verdict, job, common);

  // 6. Keep the evidence before posting, so a refused or failed post still leaves a record.
  const evidence: Record<string, unknown> = {
    job_id: jobId,
    mode,
    escrow: config.escrowContract,
    outlayer: { transaction_hash: run.transactionHash, request_id: run.requestId, task_id: record.task_id },
    verifier: { wasm_hash: config.verifierWasmHash, url: config.verifierWasmUrl },
    privacy: secret ? { relay_owned_secret: secret, public_input_has: "hashes only" } : "public: texts sent in transaction input",
    verdict,
    output_hash: outputHash,
    attestation: {
      task_hash: attestationHash,
      worker_measurement: record.worker_measurement,
      checked_by_relay: ["wasm hash", "input hash", "output hash", "caller", "transaction", "quote report_data = task hash", "quote RTMR3 = worker measurement"],
      not_checked_by_relay: ["Intel signature chain", "on-chain approval of the worker measurements"],
    },
    escrow_call: noPost ? "skipped (--no-post)" : { method, args: escrowArgs, status: "pending" },
  };
  mkdirSync("../runs/relay", { recursive: true });
  const file = `../runs/relay/job-${jobId}-${mode}-${Date.now()}.json`;
  const save = () => writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  save();

  // 7. Record it on the escrow.
  if (!noPost) {
    try {
      evidence.escrow_call = { method, args: escrowArgs, transaction_hash: await recordOnEscrow(account, config, method, escrowArgs) };
    } catch (error) {
      evidence.escrow_call = { method, args: escrowArgs, error: (error as Error).message };
      save();
      throw error;
    }
    save();
  }
  if (secret) {
    // The run is over and its result recorded: return the storage deposit.
    evidence.secret_deleted = await deleteSecret(account, config, secret.profile).catch((error: Error) => `failed: ${error.message}`);
    save();
  }
  console.log(JSON.stringify({ job_id: jobId, mode, verdict, escrow_call: evidence.escrow_call, evidence: file }, null, 2));
}

main().catch((error: Error) => {
  console.error(`relay: ${error.message}`);
  process.exit(1);
});
