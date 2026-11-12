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
import { timed, type TimingSink } from "./timing.ts";
import { confirmTransaction } from "./admission.ts";
import { DemoRpcProvider, FallbackRpcProvider, keyOnAccount } from "./rpc.ts";
import { MAINNET_RPC_URLS, TESTNET_RPC_URLS, type Config } from "./config.ts";

const TGAS = 1_000_000_000_000n;

export type RunKind = "Challenge" | "Verify";
export interface SubmissionMetadata {
  signer: string;
  nonce: string;
  block_hash: string;
}

export interface Job {
  buyer: string;
  /** Null while the job waits for a worker. */
  worker: string | null;
  state: string;
  spec_hash: string;
  fakes_hash: string;
  /** Absent on jobs made before the public format was added. */
  format_hash?: string;
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
  /** What is left to pay for runs. */
  compute_budget?: string;
  deadline?: string;
  delivered_at?: string | null;
  verdict_window_secs?: number;
  run_started_at?: string | null;
  history?: Array<{ worker: string; outcome: string }>;
}

function withFallback(config: Config) {
  const others =
    config.outlayerContract === "outlayer.near"
      ? MAINNET_RPC_URLS
      : TESTNET_RPC_URLS.slice(0, 3);
  return new FallbackRpcProvider([
    config.rpcUrl,
    ...others.filter((url) => url !== config.rpcUrl),
  ]);
}

export function relayAccount(config: Config, singleAttempt = false): Account {
  const provider = singleAttempt
    ? new DemoRpcProvider(config.rpcUrl, config.broadcastRpcUrl)
    : withFallback(config);
  const signer = new KeyPairSigner(KeyPair.fromString(config.relayPrivateKey));
  return new Account(config.relayAccountId, provider, signer);
}

/** Null means the chain says the job does not exist, as after a cancel. A failed read throws. */
export async function readJob(
  account: Account,
  config: Config,
  jobId: number,
  timing?: TimingSink,
): Promise<Job | null> {
  const job = await timed(
    "job_read",
    () =>
      account.provider.callFunction({
        contractId: config.escrowContract,
        method: "get_job",
        args: { job_id: jobId },
      }),
    timing,
  );
  return (job ?? null) as unknown as Job | null;
}

export async function getJob(
  account: Account,
  config: Config,
  jobId: number,
  timing?: TimingSink,
): Promise<Job> {
  const job = await readJob(account, config, jobId, timing);
  if (!job)
    throw new Error(`job ${jobId} not found on ${config.escrowContract}`);
  return job;
}

/** Whether this key is on the account. A failed read throws, so the request is refused either way. */
export const isAccessKey = (
  account: Account,
  accountId: string,
  publicKey: string,
): Promise<boolean> =>
  keyOnAccount(account.provider as JsonRpcProvider, accountId, publicKey);

export function secretsProfile(job: Job, jobId: number, kind: RunKind): string {
  return kind === "Challenge"
    ? `c${jobId}-${job.fakes_hash.slice(0, 12)}`
    : `v${jobId}-${(job.deliverable_hash ?? "").slice(0, 12)}`;
}

/** Asks the escrow to run the verifier, which pays for the run from the job's budget. Returns the
 * transaction hash once it has settled. */
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
    gas: 200n * TGAS,
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

/** Sign and journal once; release the signer queue only after final inclusion of that hash. */
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
  timing?: TimingSink,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
): Promise<string> {
  const signed = await timed(
    "compute_sign",
    () =>
      account.createSignedTransaction({
        receiverId: config.escrowContract,
        actions: [
          actions.functionCall(
            kind === "Challenge" ? "request_challenge" : "request_verification",
            { job_id: jobId },
            150n * TGAS,
            100000000000000000000000n,
          ),
        ],
      }),
    timing,
  );
  const hash = baseEncode(
    createHash("sha256").update(signed.transaction.encode()).digest(),
  );
  await beforeBroadcast(hash, {
    signer: signed.transaction.signerId,
    nonce: signed.transaction.nonce.toString(),
    block_hash: baseEncode(signed.transaction.blockHash),
  });
  const outcome = await confirmTransaction(
    account,
    signed,
    hash,
    config.escrowContract,
    "inclusion",
    wait,
    timing,
  );
  if (!outcome) onUncertain();
  return hash;
}

/** A call anyone may make once the chain allows it: a payout, an expiry, a budget return, a board sync.
 * Nothing it does decides an outcome. */
export async function nudge(
  account: Account,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await account.callFunctionRaw({
    contractId,
    methodName: method,
    args,
    gas: 150n * TGAS,
  });
  const status = response.status as {
    SuccessValue?: string;
    Failure?: unknown;
  };
  if (status.SuccessValue === undefined)
    throw new Error(
      `${method} was refused: ${JSON.stringify(status.Failure ?? status)}`,
    );
  return response.transaction.hash;
}
