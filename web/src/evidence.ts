import {
  checkAttestation,
  type AttestationRecord,
} from "../../relay/src/attestation.ts";
import {
  ESCROW,
  ReadError,
  decimal,
  jobNumber,
  object,
  parseJob,
  progress,
  type Job,
} from "./model.ts";
import { readJson, rpc, TESTNET_RPC } from "./read.ts";

const API = "https://testnet-api.outlayer.ai";
const NOT_CHECKED = [
  "Intel signature chain: not checked by this page",
  "Approval of the worker measurements on chain",
  "Private plaintext independently",
  "Transaction signer identity against an expected signer",
];
const CHECKS = [
  "Request id = stored request id",
  "WASM hash = job's verifier hash",
  "Exact public input = job, escrow and committed hashes",
  "Output hash = stored report hash",
  "Secret reference = job's fixed profile",
  "Quote report_data = recomputed task hash",
  "Quote RTMR3 = reported worker measurement",
];

type Kind = "challenge" | "verify";
function expected(job: Job, id: number, kind: Kind, escrow: string) {
  const challenge = kind === "challenge";
  const other = challenge ? job.fakes_hash : job.deliverable_hash;
  if (!other)
    throw new ReadError(
      "A delivery hash is required for verification evidence.",
    );
  // Same key order as the relay's runInput, so the input hash matches the attested one.
  const format = job.format_hash ? { format_hash: job.format_hash } : {};
  return {
    wasmHash: job.verifier_hash,
    inputText: JSON.stringify(
      challenge
        ? {
            mode: "challenge",
            escrow,
            job: id,
            check_hash: job.spec_hash,
            reference_hash: other,
            ...format,
          }
        : {
            mode: "verify",
            escrow,
            job: id,
            ...format,
            check_hash: job.spec_hash,
            deliverable_hash: other,
          },
    ),
    outputHash: (challenge ? job.challenge_report_hash : job.report_hash)!,
    secretsRef: `${job.secrets_owner}/${challenge ? "c" : "v"}${id}-${other.slice(0, 12)}`,
  };
}

/** Hash binding checks reuse the relay's pure auditor; no Intel-signature claim. */
export async function audit(
  job: Job,
  id: number,
  kind: Kind,
  transport: typeof fetch,
  escrow: string = ESCROW,
) {
  const requestId =
    kind === "challenge" ? job.challenge_request_id : job.verdict_request_id;
  const outputHash =
    kind === "challenge" ? job.challenge_report_hash : job.report_hash;
  const base = {
    request_id: requestId,
    url:
      requestId === null ? null : `${API}/attestations/by-request/${requestId}`,
    checks: [] as string[],
    not_checked: NOT_CHECKED,
  };
  if (requestId === null || outputHash === null)
    return {
      ...base,
      status: "not_recorded",
      message: "No complete recorded result; nothing is claimed as verified.",
    };
  let raw: unknown;
  try {
    raw = await readJson(base.url!, transport);
  } catch {
    return {
      ...base,
      status: "unavailable",
      message:
        "Attestation API unavailable. The recorded job is shown; its attestation is not checked.",
    };
  }
  try {
    const r = object(raw);
    const reported =
      typeof r.request_id === "number" &&
      Number.isSafeInteger(r.request_id) &&
      r.request_id >= 0
        ? String(r.request_id)
        : decimal(r.request_id);
    if (reported !== requestId) throw new Error("Wrong request");
    checkAttestation(
      r as unknown as AttestationRecord,
      expected(job, id, kind, escrow),
    );
    return {
      ...base,
      status: "matched",
      checks: CHECKS,
      message:
        "Hash bindings match the returned quote fields. Intel signature and worker approval were not verified by this page.",
    };
  } catch {
    return {
      ...base,
      status: "mismatch",
      message:
        "The returned record is malformed or does not match this job. Do not treat it as verified.",
    };
  }
}

/** Reads a testnet job from `escrow`: the recorded jobs live on ESCROW, market jobs on the market's escrow. */
export async function loadJob(
  text: string,
  transport: typeof fetch = fetch,
  escrow: string = ESCROW,
) {
  const id = jobNumber(text);
  const block = object(
    (await rpc("block", { finality: "final" }, transport, TESTNET_RPC)).header,
  );
  if (
    typeof block.hash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(block.hash) ||
    typeof block.height !== "number" ||
    !Number.isSafeInteger(block.height)
  )
    throw new ReadError("Invalid final block reference.");
  const timestamp = decimal(block.timestamp_nanosec);
  const data = await rpc(
    "query",
    {
      request_type: "call_function",
      block_id: block.hash,
      account_id: escrow,
      method_name: "get_job",
      args_base64: Buffer.from(JSON.stringify({ job_id: id })).toString(
        "base64",
      ),
    },
    transport,
    TESTNET_RPC,
  );
  if (
    data.block_hash !== block.hash ||
    data.block_height !== block.height ||
    !Array.isArray(data.result) ||
    data.result.length > 128 * 1024 ||
    data.result.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new ReadError(
      "RPC job data does not match the requested final block.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(data.result),
      ),
    );
  } catch {
    throw new ReadError("The contract returned invalid JSON.");
  }
  const job = parseJob(parsed);
  const [challenge, verify] = await Promise.all([
    audit(job, id, "challenge", transport, escrow),
    audit(job, id, "verify", transport, escrow),
  ]);
  return {
    job_id: String(id),
    escrow,
    network: "testnet",
    block_height: block.height,
    observed_at: new Date().toISOString(),
    block_timestamp_ns: timestamp,
    job,
    progress: progress(job, BigInt(timestamp)),
    attestations: { challenge, verify },
  };
}
