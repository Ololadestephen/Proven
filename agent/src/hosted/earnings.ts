// Allocation of payments already transferred by escrow. This never changes a verdict or adds funds.
import type { Job } from "../types.ts";
import { PublicError } from "../errors.ts";
import { budgetNanoUsd, nearToNanoUsd } from "./limits.ts";
import type { HostedAgent, HostedStore } from "./store.ts";

export interface EarningsRecord {
  escrow: string;
  job_id: number;
  verdict_request_id: string;
  amount_yocto: string;
  inference_yocto: string;
  retained_yocto: string;
  at: string;
}

export function retainedEarnings(agent: HostedAgent): bigint {
  return (agent.earnings ?? []).reduce(
    (sum, entry) => sum + BigInt(entry.retained_yocto),
    0n,
  );
}

export function inferenceBudget(
  agent: HostedAgent,
  balance: bigint,
  unsettled: number,
  spent: number,
): number {
  const retained = retainedEarnings(agent);
  return budgetNanoUsd(
    balance > retained ? balance - retained : 0n,
    unsettled,
    spent,
  );
}

/** Final Released means the native transfer callback succeeded. A claimed or Passed job is not paid. */
export function recordEarnings(
  store: HostedStore,
  wallet: string,
  escrow: string,
  jobId: number,
  job: Job,
  capYocto: string,
  at = new Date().toISOString(),
): EarningsRecord | null {
  const agent = store.get(wallet);
  if (!agent) throw new PublicError("The hosted worker record is unavailable.");
  if (job.state !== "Released" || job.worker !== wallet || job.token !== null)
    return null;
  if (
    !Number.isSafeInteger(jobId) ||
    jobId < 0 ||
    !/^\d+$/.test(job.amount) ||
    BigInt(job.amount) <= 0n ||
    !job.verdict_request_id ||
    !/^\d+$/.test(job.verdict_request_id) ||
    !/^[a-f0-9]{64}$/.test(job.deliverable_hash ?? "") ||
    !/^[a-f0-9]{64}$/.test(job.report_hash ?? "") ||
    !/^\d+$/.test(capYocto) ||
    BigInt(capYocto) <= 0n
  ) {
    throw new PublicError(
      "The paid job is incomplete. No inference credit was recorded.",
    );
  }
  const previous = (agent.earnings ?? []).find(
    (row) => row.escrow === escrow && row.job_id === jobId,
  );
  if (previous) {
    if (
      previous.verdict_request_id !== job.verdict_request_id ||
      previous.amount_yocto !== job.amount
    )
      throw new PublicError(
        "The paid-job record conflicts with its previous credit. Reconcile before spending.",
      );
    return null;
  }
  const keep = agent.keep_bps ?? 0;
  if (!Number.isInteger(keep) || keep < 0 || keep > 10000)
    throw new PublicError("The retained share is invalid.");
  const amount = BigInt(job.amount);
  const requested = (amount * BigInt(10000 - keep)) / 10000n;
  const cap = BigInt(capYocto);
  const allocated = requested < cap ? requested : cap;
  const entry: EarningsRecord = {
    escrow,
    job_id: jobId,
    verdict_request_id: job.verdict_request_id,
    amount_yocto: amount.toString(),
    inference_yocto: allocated.toString(),
    retained_yocto: (amount - allocated).toString(),
    at,
  };
  // One atomic document replacement commits the allocation and its deduplication key together.
  agent.earnings = [...(agent.earnings ?? []), entry];
  store.save(agent);
  return entry;
}

export function earnedInferenceUsd(agent: HostedAgent): number {
  return (
    nearToNanoUsd(
      (agent.earnings ?? []).reduce(
        (sum, row) => sum + BigInt(row.inference_yocto),
        0n,
      ),
    ) / 1e9
  );
}
