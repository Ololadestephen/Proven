// NEAR calls the relay makes: running the verifier on OutLayer, reading jobs, recording results.

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, parseNearAmount } from "near-api-js";
import type { Config } from "./config.ts";

const TGAS = 1_000_000_000_000n;

export interface Job {
  buyer: string;
  worker: string;
  state: string;
  spec_hash: string;
  fakes_hash: string;
  deliverable_hash: string | null;
}

export interface OutlayerRun {
  transactionHash: string;
  requestId: number;
  output: unknown;
}

export function relayAccount(config: Config): Account {
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const signer = new KeyPairSigner(KeyPair.fromString(config.relayPrivateKey));
  return new Account(config.relayAccountId, provider, signer);
}

export async function getJob(account: Account, config: Config, jobId: number): Promise<Job> {
  const job = await account.provider.callFunction({ contractId: config.escrowContract, method: "get_job", args: { job_id: jobId } });
  if (!job) throw new Error(`job ${jobId} not found on ${config.escrowContract}`);
  return job as unknown as Job;
}

/** Runs the verifier on OutLayer from the relay account and returns its output. */
export async function runOnOutlayer(account: Account, config: Config, input: string, secretsRef?: { profile: string; account_id: string }): Promise<OutlayerRun> {
  const response = await account.callFunctionRaw({
    contractId: config.outlayerContract,
    methodName: "request_execution",
    args: {
      source: { WasmUrl: { url: config.verifierWasmUrl, hash: config.verifierWasmHash, build_target: "wasm32-wasip1" } },
      input_data: input,
      resource_limits: { max_instructions: 50_000_000_000, max_memory_mb: 128, max_execution_seconds: 60 },
      response_format: "Json",
      ...(secretsRef ? { secrets_ref: secretsRef } : {}),
    },
    deposit: parseNearAmount("0.1") ?? "0",
    gas: 300n * TGAS,
  });
  const status = response.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) throw new Error(`OutLayer run failed: ${JSON.stringify(status.Failure ?? status)}`);
  const output = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8"));
  return { transactionHash: response.transaction.hash, requestId: requestIdFrom(response.receipts_outcome), output };
}

function requestIdFrom(receipts: Array<{ outcome: { logs: string[] } }>): number {
  for (const log of receipts.flatMap((r) => r.outcome.logs)) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    const event = JSON.parse(log.slice("EVENT_JSON:".length));
    if (event.standard === "near-outlayer" && event.event === "execution_requested") {
      return JSON.parse(event.data[0].request_data).request_id;
    }
  }
  throw new Error("OutLayer did not log execution_requested");
}

/** Records a result on the escrow. Throws if the contract refuses it. */
export async function recordOnEscrow(account: Account, config: Config, method: "record_challenge" | "record_verdict", args: Record<string, unknown>): Promise<string> {
  const response = await account.callFunctionRaw({ contractId: config.escrowContract, methodName: method, args, gas: 30n * TGAS });
  const status = response.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) throw new Error(`${method} was refused: ${JSON.stringify(status.Failure ?? status)}`);
  return response.transaction.hash;
}
