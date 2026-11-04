// Audits an OutLayer attestation record against a job on the escrow. Anyone can run this: it
// needs no key, only the chain and OutLayer's public attestation API.
//
// What is checked here: the record names the job's verifier build, the exact input the contract
// builds from the job's hashes, the output hash the contract recorded and the job's secret; the task
// hash recomputed from those values equals the commitment inside the TDX quote (report_data); and
// RTMR3 in the quote equals the recorded worker measurement.
// What is NOT checked here: Intel's signature chain over the quote and the on-chain approval of the
// worker's measurements. `outlayer-verify` or OutLayer's dashboard check those.

import { sha256Hex } from "./hash.ts";

export interface AttestationRecord {
  task_id: number;
  request_id: number;
  task_type: string;
  tdx_quote: string;
  worker_measurement: string;
  caller_account_id: string;
  transaction_hash: string;
  block_height: number;
  build_target: string;
  wasm_hash: string;
  executed_wasm_sha256?: string;
  input_hash: string;
  output_hash: string;
  repo_url?: string | null;
  commit_hash?: string | null;
  project_id?: string | null;
  secrets_ref?: string | null;
  timestamp: number;
  attached_usd: string;
}

export interface Expected {
  wasmHash: string;
  inputText: string;
  outputHash: string;
  /** `owner/profile`, when the run used a secret. */
  secretsRef?: string;
  /** Checked only when the caller knows them. */
  caller?: string;
  transactionHash?: string;
}

/** report_data starts at byte 568 of a TDX v4 quote; RTMR3 is the 48 bytes before it. */
const RTMR3_OFFSET = 520;
const REPORT_DATA_OFFSET = 568;

function i64le(value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(value));
  return b;
}

function u64le(value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

/** OutLayer's task hash (V1): the 32 bytes Intel's quote signs in report_data. */
export function taskHash(r: AttestationRecord): string {
  const text = (s: string | null | undefined) => (s == null ? [] : [Buffer.from(s, "utf8")]);
  const parts: Buffer[] = [
    ...text(r.task_type),
    i64le(r.task_id),
    ...text(r.repo_url),
    ...text(r.commit_hash),
    ...text(r.build_target),
    ...text(r.wasm_hash),
    ...text(r.input_hash),
    ...text(r.output_hash),
    u64le(r.block_height),
    ...text(r.caller_account_id),
    ...text(r.project_id),
    ...text(r.secrets_ref),
    i64le(r.timestamp),
    ...text(r.attached_usd),
  ];
  return sha256Hex(Buffer.concat(parts));
}

/** Returns the task hash if every check passes; throws naming the first check that failed. */
export function checkAttestation(r: AttestationRecord, expected: Expected): string {
  const fail = (what: string) => {
    throw new Error(`attestation check failed: ${what}`);
  };
  if (r.task_type !== "execute") fail("task type is not execute");
  if (r.wasm_hash !== expected.wasmHash) fail("wasm_hash is not the job's verifier build");
  if (r.executed_wasm_sha256 !== undefined && r.executed_wasm_sha256 !== expected.wasmHash) fail("executed WASM is not the job's verifier build");
  if (r.input_hash !== sha256Hex(expected.inputText)) fail("input_hash is not the hash of the job's input");
  if (r.output_hash !== expected.outputHash) fail("output_hash is not the recorded report hash");
  if (expected.secretsRef !== undefined && r.secrets_ref !== expected.secretsRef) fail("secrets_ref is not the job's secret");
  if (expected.caller !== undefined && r.caller_account_id !== expected.caller) fail("caller is not the expected account");
  if (expected.transactionHash !== undefined && r.transaction_hash !== expected.transactionHash) fail("transaction hash is not the expected one");

  const quote = Buffer.from(r.tdx_quote, "base64");
  if (quote.length < REPORT_DATA_OFFSET + 32) fail("quote is too short");
  if (quote.readUInt16LE(0) !== 4) fail("quote is not TDX version 4");
  const committed = quote.subarray(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 32).toString("hex");
  const computed = taskHash(r);
  if (committed !== computed) fail("the quote does not commit to this execution (task hash mismatch)");
  if (quote.subarray(RTMR3_OFFSET, REPORT_DATA_OFFSET).toString("hex") !== r.worker_measurement) fail("RTMR3 in the quote is not the recorded worker measurement");
  return computed;
}

export async function fetchAttestation(api: string, requestId: number): Promise<AttestationRecord> {
  // The record appears shortly after the execution resolves on chain.
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(`${api}/attestations/by-request/${requestId}`);
    if (response.ok) return (await response.json()) as AttestationRecord;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`no attestation for request ${requestId} after 30 s`);
}
