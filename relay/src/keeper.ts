// What the relay presses to move a job on once the chain allows it. Every step here is one anyone may
// take, and the escrow or board refuses it if it is not due. Nothing here decides an outcome: a payout
// only follows a verdict the escrow recorded in its own callback.

export interface KeptJob {
  state: string;
  worker?: string | null;
  compute_budget?: string;
  deadline?: string;
  delivered_at?: string | null;
  verdict_window_secs?: number;
  history?: Array<{ worker: string; outcome: string }>;
}

export interface KeptBid {
  state: string;
  claim: { agent: string } | null;
  fees?: string[];
}

export type Nudge =
  | {
      contract: "escrow";
      method: "release" | "refund" | "expire" | "return_budget";
    }
  | { run: "Challenge" | "Verify" }
  | null;

/** The one step that is due on this job now, if any. `held` says which private texts the relay has. */
export function nextNudge(
  job: KeptJob,
  nowNanos: bigint,
  held: { check: boolean; deliverable: boolean },
): Nudge {
  switch (job.state) {
    case "Passed":
      return { contract: "escrow", method: "release" };
    case "Failed":
    case "RefundDue":
      return { contract: "escrow", method: "refund" };
    case "Funded":
      return job.deadline && nowNanos > BigInt(job.deadline)
        ? { contract: "escrow", method: "expire" }
        : null;
    case "Delivered": {
      const end =
        BigInt(job.delivered_at ?? "0") +
        BigInt(job.verdict_window_secs ?? 0) * 1_000_000_000n;
      if (nowNanos > end) return { contract: "escrow", method: "expire" };
      // A verification the relay could not start straight after the hand-over.
      return held.deliverable ? { run: "Verify" } : null;
    }
    case "Draft":
      // A challenge the relay could not start straight after the check arrived.
      return held.check ? { run: "Challenge" } : null;
    case "Released":
      return BigInt(job.compute_budget ?? "0") > 0n
        ? { contract: "escrow", method: "return_budget" }
        : null;
    default:
      return null;
  }
}

/** Whether the board is behind its job: a finished attempt, an ended job, or a fee waiting. */
export function boardBehind(bid: KeptBid, job: KeptJob): boolean {
  const live = ["Unreviewed", "Blocked", "Open", "Claimed"].includes(bid.state);
  if (!live)
    return (bid.fees ?? []).some((fee) => fee === "Held") && ended(job);
  if (ended(job) || job.state === "CheckRejected") return true;
  if (bid.state === "Claimed" && bid.claim && job.worker !== bid.claim.agent)
    return true;
  const settled = (bid.fees ?? []).filter((fee) => fee !== "Held").length;
  return (job.history?.length ?? 0) > settled;
}

function ended(job: KeptJob): boolean {
  return job.state === "Released" || job.state === "Refunded";
}
