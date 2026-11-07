// What a person can do next on a bid, worked out only from what the chain says. Wallet redirects reload
// the page, so nothing here depends on memory. A step never decides a verdict.
//
// The buyer pays once, when posting. After that the relay sends the check to be tested, starts runs
// and pays out when the chain allows; these steps are there for when it has not yet, and anyone may
// take them.
export interface MarketJob {
  id?: number | null;
  attempt?: number;
  buyer: string;
  /** Null while the job waits for a worker. */
  worker: string | null;
  amount: string;
  state: string;
  deadline: string;
  delivered_at?: string | null;
  verdict_window_secs?: number;
  run_started_at?: string | null;
  deliverable_hash: string | null;
  fakes_caught: number;
  fakes_total: number;
  failed_rule: string | null;
  challenge_request_id: string | null;
  verdict_request_id: string | null;
  compute_budget?: string;
  max_attempts?: number;
  history?: Array<{
    worker: string;
    outcome: string;
    failed_rule: string | null;
    verdict_request_id: string | null;
  }>;
}
export interface MarketBid {
  id: number;
  buyer: string;
  description: string;
  amount: string;
  check_hash: string;
  reference_hash: string;
  verifier_hash: string;
  format: string;
  format_hash: string;
  expires_at: string;
  state: string;
  deliver_secs?: number;
  max_attempts?: number;
  job_id?: number | null;
  allowed_workers: string[] | null;
  review: { allow: boolean } | null;
  claim: { number: number; agent: string } | null;
  claims_made: number;
  funded_attempts: number;
  fees?: string[];
  job: MarketJob | null;
  last_job: MarketJob | null;
}
export type Step =
  | { id: "review"; label: string }
  | { id: "send_check"; label: string; jobId: number }
  | { id: "close"; label: string }
  | { id: "register"; label: string }
  | { id: "claim"; label: string }
  | { id: "deliver"; label: string; jobId: number }
  | { id: "verify"; label: string; jobId: number }
  | { id: "settle"; label: string; jobId: number; method: "release" | "refund" }
  | { id: "expire"; label: string; jobId: number }
  | { id: "sync"; label: string }
  | { id: "collect"; label: string; jobId: number }
  | { id: "wait"; label: string };

const near = (yocto: string) =>
  `${Number(BigInt(yocto) / 10n ** 18n) / 1e6} NEAR`;
export const showNear = near;
const wait = (label: string): Step => ({ id: "wait", label });

export function nextStep(
  bid: MarketBid,
  viewer: string | null,
  registered: boolean,
  nowMs: number,
): Step | null {
  const now = BigInt(nowMs) * 1_000_000n;
  const job = bid.job;
  const jobId = bid.job_id ?? job?.id ?? null;
  const isBuyer = viewer === bid.buyer;
  const isWorker = viewer !== null && viewer === job?.worker;
  const ended = now >= BigInt(bid.expires_at);

  if (bid.state === "Pending")
    return wait("Creating the job and holding the payment");
  if (bid.state === "Done")
    return isBuyer && job?.state === "Released" && jobId !== null
      ? { id: "collect", label: "Collect the work", jobId }
      : null;
  if (["Closed", "Cancelled"].includes(bid.state)) {
    // Fees not yet returned are moved on by anyone.
    return viewer && bid.fees?.includes("Held") && job
      ? { id: "sync", label: "Return the unused attempt fees" }
      : null;
  }
  // A bid that has ended with no worker on it is refunded by whoever closes it.
  if (
    ended &&
    ["Unreviewed", "Blocked", "Open"].includes(bid.state) &&
    (!job || ["Draft", "Open", "CheckRejected"].includes(job.state))
  )
    return viewer
      ? { id: "close", label: "This bid has ended: refund the buyer" }
      : wait("This bid has ended");
  if (bid.state === "Unreviewed")
    return viewer
      ? { id: "review", label: "Run the bid review" }
      : wait("Waiting for the bid review");
  if (bid.state === "Blocked")
    return isBuyer
      ? {
          id: "close",
          label: "The review blocked this bid: get your money back",
        }
      : null;
  if (!job || jobId === null) return wait("Reading the job");

  switch (job.state) {
    case "Draft":
      return isBuyer
        ? {
            id: "send_check",
            label: "Send your check to start its test",
            jobId,
          }
        : wait("The buyer’s check is about to be tested");
    case "Challenging":
      return wait("Testing the check against planted fakes");
    case "CheckRejected":
      return viewer
        ? { id: "sync", label: "The check failed its test: refund the buyer" }
        : wait("The check failed its test");
    case "Open":
      if (bid.state === "Claimed")
        return { id: "sync", label: "Update the bid" };
      if (bid.state === "Assigning")
        return wait("Giving the job to the worker");
      if (!viewer) return wait("Connect a wallet to apply");
      if (isBuyer)
        return wait(
          "Waiting for someone to apply. Your payment is held, and the worker can start as soon as they apply.",
        );
      if (bid.funded_attempts >= (bid.max_attempts ?? 3))
        return wait("This bid has used all its attempts");
      if (bid.allowed_workers && !bid.allowed_workers.includes(viewer))
        return wait("This bid is limited to listed workers");
      if (!registered) return { id: "register", label: "Register to apply" };
      return { id: "claim", label: "Apply for this job" };
    case "Funded":
      if (now > BigInt(job.deadline))
        return {
          id: "expire",
          label: "The deadline passed: end this attempt",
          jobId,
        };
      return isWorker
        ? { id: "deliver", label: "Deliver the work", jobId }
        : wait("The worker has the job. Waiting for the delivery");
    case "Delivered": {
      const window = BigInt(job.verdict_window_secs ?? 0) * 1_000_000_000n;
      if (job.delivered_at && now > BigInt(job.delivered_at) + window)
        return {
          id: "expire",
          label: "No verdict in time: end this attempt",
          jobId,
        };
      return { id: "verify", label: "Run verification", jobId };
    }
    case "Verifying": {
      const window = BigInt(job.verdict_window_secs ?? 0) * 1_000_000_000n;
      if (
        job.delivered_at &&
        job.run_started_at &&
        now > BigInt(job.delivered_at) + window &&
        now > BigInt(job.run_started_at) + 900_000_000_000n
      )
        return {
          id: "expire",
          label: "The run never finished: end this attempt",
          jobId,
        };
      return wait("Checking the work");
    }
    case "Passed":
      return {
        id: "settle",
        label: "Pay the worker",
        jobId,
        method: "release",
      };
    case "Failed":
    case "RefundDue":
      return {
        id: "settle",
        label: "Close this failed attempt",
        jobId,
        method: "refund",
      };
    case "Released":
    case "Refunded":
      return { id: "sync", label: "Update the bid" };
    default:
      return wait("A payout is in progress");
  }
}
