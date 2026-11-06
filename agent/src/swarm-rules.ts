// The rule for starting work, shared by the runners.
import { type Bid } from "./board.ts";
import type { Job } from "./types.ts";

/** Longer than one model call can take, plus time to deliver. */
const MIN_WORK_NANOS = 420_000_000_000n;

/** The agent starts work only on a funded job naming it, for this bid's amount and active claim. */
export function workRefusal(
  bid: Bid,
  jobId: number,
  job: Job,
  wallet: string,
  now: bigint,
): string | null {
  if (job.state !== "Funded") return "the job is not funded";
  if (now + MIN_WORK_NANOS >= BigInt(job.deadline))
    return "too little time is left before the job's deadline";
  if (job.worker !== wallet) return "the job names a different worker";
  if (job.token !== null || job.amount !== bid.amount)
    return "the job pays something other than the bid";
  if (bid.claim?.agent !== wallet || bid.claim.job_id !== jobId)
    return "this job is not linked to this agent's claim";
  return null;
}
