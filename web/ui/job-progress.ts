import type { MarketBid } from "./market-steps.ts";

export interface ProgressStage {
  id: string;
  label: string;
  status: "done" | "current" | "todo" | "failed";
}

/** States the escrow reaches only after recording a verdict. A refund alone says nothing about one. */
const VERDICT_STATES = ["Passed", "Failed", "Releasing", "Released"];

/** Where a bid's job stands, read only from the chain. It decides nothing. A refund is never shown as
 * a success, and a refund with no verdict (no delivery, or no verdict in time) is never shown as verified. */
export function jobProgress(bid: MarketBid): ProgressStage[] {
  const job = bid.job ?? bid.last_job;
  const history = job?.history ?? [];
  const last = history.at(-1);
  const state = job?.state ?? "";
  const stages = [
    { id: "posted", label: "Posted", done: true, failed: false },
    {
      id: "reviewed",
      label: "Reviewed",
      done:
        bid.review !== null || !["Pending", "Unreviewed"].includes(bid.state),
      failed: bid.state === "Blocked",
    },
    {
      id: "tested",
      label: "Check tested",
      done: !!job && !["Draft", "Challenging", "CheckRejected"].includes(state),
      failed: state === "CheckRejected",
    },
    {
      id: "claimed",
      label: "Claimed",
      done: !!job?.worker || history.length > 0,
      failed: false,
    },
    {
      id: "delivered",
      label: "Delivered",
      done:
        !!job?.delivered_at || history.some((a) => a.outcome !== "NoDelivery"),
      failed: false,
    },
    {
      id: "verified",
      label: "Verified",
      done:
        (job?.verdict_request_id ?? null) !== null ||
        VERDICT_STATES.includes(state) ||
        history.some((a) => a.outcome === "Paid" || a.outcome === "Failed"),
      failed: state === "Failed" || last?.outcome === "Failed",
    },
    {
      id: "paid",
      label: state === "Refunded" ? "Refunded" : "Paid",
      done: state === "Released",
      failed: state === "Refunded",
    },
  ];
  const current = stages.findIndex((stage) => !stage.done && !stage.failed);
  return stages.map((stage, index) => ({
    id: stage.id,
    label: stage.label,
    status: stage.failed
      ? "failed"
      : stage.done
        ? "done"
        : index === current
          ? "current"
          : "todo",
  }));
}

/** The worker's shorter path: from applying to being paid. */
export function workerProgress(bid: MarketBid): ProgressStage[] {
  const full = jobProgress(bid);
  const renamed: Record<string, string> = {
    claimed: "Applied",
    delivered: "Delivered",
    verified: "Verdict",
  };
  return full
    .filter((stage) =>
      ["claimed", "delivered", "verified", "paid"].includes(stage.id),
    )
    .map((stage) => ({ ...stage, label: renamed[stage.id] ?? stage.label }));
}
