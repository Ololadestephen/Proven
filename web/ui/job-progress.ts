import type { MarketBid } from "./market-steps.ts";

export interface ProgressStage {
  label: string;
  status: "done" | "current" | "todo" | "failed";
}

const REACHED: Record<string, number> = {
  Draft: 3,
  Challenging: 3,
  CheckRejected: 3,
  Challenged: 4,
  Funded: 5,
  Delivered: 6,
  Verifying: 6,
  Passed: 7,
  Failed: 7,
  Releasing: 7,
  Refunding: 7,
  Released: 8,
  Refunded: 8,
  Expired: 8,
};
const LAST_LABEL: Record<string, string> = {
  Released: "Paid",
  Refunded: "Refunded",
  Expired: "Expired",
};

/** Where a bid's latest attempt stands, read only from the chain. It decides nothing. */
export function jobProgress(bid: MarketBid): ProgressStage[] {
  const job = bid.job ?? bid.last_job;
  const labels = [
    "Posted",
    "Reviewed",
    "Claimed",
    "Check tested",
    "Funded",
    "Delivered",
    "Verified",
    (job && LAST_LABEL[job.state]) ?? "Settled",
  ];
  let reached = bid.state === "Unreviewed" || bid.state === "Blocked" ? 1 : 2;
  if (bid.claim || job) reached = 3;
  if (job) reached = Math.max(reached, REACHED[job.state] ?? 3);
  const failedAt =
    bid.state === "Blocked"
      ? 1
      : job?.state === "CheckRejected"
        ? 3
        : job?.state === "Failed" || job?.state === "Refunded"
          ? 6
          : -1;
  return labels.map((label, index) => ({
    label,
    status:
      index === failedAt
        ? "failed"
        : index < reached
          ? "done"
          : index === reached
            ? "current"
            : "todo",
  }));
}
