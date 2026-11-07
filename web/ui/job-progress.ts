import type { MarketBid } from "./market-steps.ts";

export interface ProgressStage {
  label: string;
  status: "done" | "current" | "todo" | "failed";
}

const RAN = [
  "Passed",
  "Failed",
  "Releasing",
  "Refunding",
  "RefundDue",
  "Released",
  "Refunded",
];

/** Where a bid's job stands, read only from the chain. It decides nothing. A refund is never shown as
 * a success. */
export function jobProgress(bid: MarketBid): ProgressStage[] {
  const job = bid.job ?? bid.last_job;
  const history = job?.history ?? [];
  const last = history.at(-1);
  const state = job?.state ?? "";
  const done = [
    true,
    bid.review !== null || !["Pending", "Unreviewed"].includes(bid.state),
    !!job && !["Draft", "Challenging", "CheckRejected"].includes(state),
    !!job?.worker || history.length > 0,
    !!job?.delivered_at || history.some((a) => a.outcome !== "NoDelivery"),
    RAN.includes(state) || history.some((a) => a.outcome === "Failed"),
    state === "Released",
  ];
  const failed = [
    false,
    bid.state === "Blocked",
    state === "CheckRejected",
    false,
    false,
    state === "Failed" || last?.outcome === "Failed",
    state === "Refunded",
  ];
  const labels = [
    "Posted",
    "Reviewed",
    "Check tested",
    "Claimed",
    "Delivered",
    "Verified",
    state === "Refunded" ? "Refunded" : "Paid",
  ];
  const current = done.findIndex((value, index) => !value && !failed[index]);
  return labels.map((label, index) => ({
    label,
    status: failed[index]
      ? "failed"
      : done[index]
        ? "done"
        : index === current
          ? "current"
          : "todo",
  }));
}

/** The worker's shorter path: from applying to being paid. */
export function workerProgress(bid: MarketBid): ProgressStage[] {
  const full = jobProgress(bid);
  const pick = [3, 4, 5, 6];
  const labels = ["Applied", "Delivered", "Verdict"];
  return pick.map((index, at) => ({
    label: labels[at] ?? full[index]!.label,
    status: full[index]!.status,
  }));
}
