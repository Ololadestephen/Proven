// What a person can do next on a bid, worked out only from what the chain says. Wallet redirects reload
// the page, so nothing here depends on memory. A step never decides a verdict.
export interface MarketJob {
  id?: number;
  attempt?: number;
  buyer: string;
  worker: string;
  amount: string;
  state: string;
  deadline: string;
  deliverable_hash: string | null;
  fakes_caught: number;
  fakes_total: number;
  failed_rule: string | null;
  challenge_request_id: string | null;
  verdict_request_id: string | null;
}
export interface MarketBid {
  id: number;
  buyer: string;
  description: string;
  amount: string;
  check_hash: string;
  reference_hash: string;
  verifier_hash: string;
  state: string;
  claim_window_secs: number;
  allowed_workers: string[] | null;
  review: { allow: boolean } | null;
  claim: {
    number: number;
    agent: string;
    expires_at: string;
    job_id: number | null;
  } | null;
  claims_made: number;
  funded_attempts: number;
  job: MarketJob | null;
  last_job: MarketJob | null;
  candidate_job_id: number | null;
}
export type Step =
  | { id: "review"; label: string }
  | { id: "create_job"; label: string }
  | { id: "link_job"; label: string; jobId: number }
  | { id: "challenge"; label: string; jobId: number }
  | { id: "fund"; label: string; jobId: number }
  | { id: "verify"; label: string; jobId: number }
  | { id: "settle"; label: string; jobId: number; method: "release" | "refund" }
  | { id: "sync"; label: string }
  | { id: "collect"; label: string; jobId: number }
  | { id: "register"; label: string }
  | { id: "claim"; label: string }
  | { id: "deliver"; label: string; jobId: number }
  | { id: "wait"; label: string };

const FUND_MARGIN_NANOS = 60_000_000_000n;
const near = (yocto: string) =>
  `${Number(BigInt(yocto) / 10n ** 18n) / 1e6} NEAR`;
export const showNear = near;

export function nextStep(
  bid: MarketBid,
  viewer: string | null,
  registered: boolean,
  nowMs: number,
): Step | null {
  const now = BigInt(nowMs) * 1_000_000n;
  const job = bid.job;
  const jobId = bid.claim?.job_id ?? null;
  const isBuyer = viewer === bid.buyer;
  const isWorker = viewer !== null && viewer === bid.claim?.agent;

  if (bid.state === "Unreviewed")
    return isBuyer
      ? { id: "review", label: "Run the bid review" }
      : { id: "wait", label: "Waiting for the bid review" };
  if (["Blocked", "Cancelled", "Closed"].includes(bid.state)) return null;
  if (bid.state === "Done" || (bid.last_job && bid.state === "Open")) {
    const last = bid.last_job;
    if (isBuyer && last?.state === "Released" && last.id !== undefined)
      return { id: "collect", label: "Collect the work", jobId: last.id };
  }
  if (bid.state === "Done") return null;
  if (bid.state === "Open") {
    if (!viewer) return { id: "wait", label: "Connect a wallet to apply" };
    if (isBuyer) return { id: "wait", label: "Waiting for someone to apply" };
    if (bid.allowed_workers && !bid.allowed_workers.includes(viewer))
      return { id: "wait", label: "This bid is limited to listed workers" };
    if (!registered) return { id: "register", label: "Register to apply" };
    return { id: "claim", label: "Apply for this job" };
  }

  // Claimed from here.
  if (jobId === null || !job) {
    const lapsed = bid.claim && now > BigInt(bid.claim.expires_at);
    if (lapsed)
      return { id: "sync", label: "This claim lapsed: reopen the bid" };
    if (!isBuyer)
      return {
        id: "wait",
        label: isWorker
          ? "Claimed. Wait until the buyer funds it, and spend nothing yet"
          : "Someone is working on this",
      };
    if (bid.candidate_job_id !== null)
      return {
        id: "link_job",
        label: "Link the job to this claim",
        jobId: bid.candidate_job_id,
      };
    return { id: "create_job", label: "Create the job for this agent" };
  }

  switch (job.state) {
    case "Draft":
      return isBuyer
        ? {
            id: "challenge",
            label: "Run the fake challenge (0.1 NEAR, mostly refunded)",
            jobId,
          }
        : { id: "wait", label: "The buyer is testing the check" };
    case "Challenged":
      if (!isBuyer)
        return { id: "wait", label: "The buyer has not funded yet" };
      if (bid.claim && now + FUND_MARGIN_NANOS >= BigInt(bid.claim.expires_at))
        return {
          id: "wait",
          label: "The claim is about to end, so funding is closed",
        };
      return { id: "fund", label: `Fund ${near(job.amount)}`, jobId };
    case "CheckRejected":
      return {
        id: "sync",
        label: "The check failed its challenge: close the bid",
      };
    case "Funded":
      return isWorker
        ? { id: "deliver", label: "Deliver the work", jobId }
        : { id: "wait", label: "Funded. Waiting for the delivery" };
    case "Delivered":
      return {
        id: "verify",
        label: "Run verification (0.1 NEAR, mostly refunded)",
        jobId,
      };
    case "Passed":
      return {
        id: "settle",
        label: "Release the payment",
        jobId,
        method: "release",
      };
    case "Failed":
      return {
        id: "settle",
        label: "Refund the buyer",
        jobId,
        method: "refund",
      };
    case "Released":
    case "Refunded":
    case "Expired":
      return { id: "sync", label: "Update the bid" };
    default:
      return { id: "wait", label: "A run or payout is in progress" };
  }
}
