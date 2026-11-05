// NEAR calls the relay makes. It has no special power on the escrow: `request_challenge` and
// `request_verification` are open to anyone, and only the contract's own callback records a result.

import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  parseNearAmount,
  actions,
  baseEncode,
} from "near-api-js";
import { createHash } from "node:crypto";
import type { Config } from "./config.ts";

const TGAS = 1_000_000_000_000n;

export type RunKind = "Challenge" | "Verify";
export interface SubmissionMetadata {
  signer: string;
  nonce: string;
  block_hash: string;
}

export interface Job {
  buyer: string;
  worker: string;
  state: string;
  spec_hash: string;
  fakes_hash: string;
  verifier_url: string;
  verifier_hash: string;
  secrets_owner: string;
  deliverable_hash: string | null;
  fakes_total: number;
  fakes_caught: number;
  challenge_report_hash: string | null;
  challenge_request_id: string | null;
  report_hash: string | null;
  verdict_request_id: string | null;
  failed_rule: string | null;
}

export function relayAccount(config: Config): Account {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const signer = new KeyPairSigner(KeyPair.fromString(config.relayPrivateKey));
  return new Account(config.relayAccountId, provider, signer);
}

export async function getJob(
  account: Account,
  config: Config,
  jobId: number,
): Promise<Job> {
  const job = await account.provider.callFunction({
    contractId: config.escrowContract,
    method: "get_job",
    args: { job_id: jobId },
  });
  if (!job)
    throw new Error(`job ${jobId} not found on ${config.escrowContract}`);
  return job as unknown as Job;
}

export function secretsProfile(job: Job, jobId: number, kind: RunKind): string {
  return kind === "Challenge"
    ? `c${jobId}-${job.fakes_hash.slice(0, 12)}`
    : `v${jobId}-${(job.deliverable_hash ?? "").slice(0, 12)}`;
}

/** Asks the escrow to run the verifier. Returns the transaction hash once it has settled. */
export async function triggerRun(
  account: Account,
  config: Config,
  jobId: number,
  kind: RunKind,
): Promise<string> {
  const response = await account.callFunctionRaw({
    contractId: config.escrowContract,
    methodName:
      kind === "Challenge" ? "request_challenge" : "request_verification",
    args: { job_id: jobId },
    deposit: parseNearAmount("0.1") ?? "0",
    gas: 150n * TGAS,
  });
  const status = response.status as {
    SuccessValue?: string;
    Failure?: unknown;
  };
  if (status.SuccessValue === undefined)
    throw new Error(
      `the run was refused or failed: ${JSON.stringify(status.Failure ?? status)}`,
    );
  return response.transaction.hash;
}

/** Submit once, release the signer queue at nonce finality, then let the client read settlement. */
export async function submitDemoRun(
  account: Account,
  config: Config,
  jobId: number,
  kind: RunKind,
  beforeBroadcast: (
    hash: string,
    metadata: SubmissionMetadata,
  ) => Promise<void>,
  onUncertain: () => void,
): Promise<string> {
  const signed = await account.createSignedTransaction({
    receiverId: config.escrowContract,
    actions: [
      actions.functionCall(
        kind === "Challenge" ? "request_challenge" : "request_verification",
        { job_id: jobId },
        150n * TGAS,
        100000000000000000000000n,
      ),
    ],
  });
  const hash = baseEncode(
    createHash("sha256").update(signed.transaction.encode()).digest(),
  );
  await beforeBroadcast(hash, {
    signer: signed.transaction.signerId,
    nonce: signed.transaction.nonce.toString(),
    block_hash: baseEncode(signed.transaction.blockHash),
  });
  try {
    await account.provider.sendTransactionUntil(signed, "INCLUDED_FINAL");
  } catch {
    // The signed hash is durable. Only read its outcome; never sign or submit another call here.
    onUncertain();
  }
  return hash;
}
