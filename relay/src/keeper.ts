// What the relay presses to move a job on once the chain allows it. Every step here is one anyone may
// take, and the escrow or board refuses it if it is not due. Nothing here decides an outcome: a payout
// only follows a verdict the escrow recorded in its own callback.

export interface KeptJob {
  buyer?: string;
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
  job_id?: number | null;
  storage_paid?: string;
  finished?: boolean;
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

/** Whether a bid has ended with every fee settled and still holds storage its buyer can have back.
 * Then the relay asks the escrow and the board to return it; both refuse if nothing is due. Earlier
 * bids recorded no storage payment and are left alone. */
export function storageDue(bid: KeptBid): boolean {
  return (
    ["Done", "Closed", "Cancelled"].includes(bid.state) &&
    !bid.finished &&
    BigInt(bid.storage_paid ?? "0") > 0n &&
    (bid.fees ?? []).every(
      (fee) => fee === "PaidToWorker" || fee === "ReturnedToBuyer",
    )
  );
}

interface StorageFinisherDependencies {
  readBids(from: number, limit: number): Promise<Array<[number, KeptBid]>>;
  finishJob(jobId: number): Promise<unknown>;
  finishBid(bidId: number): Promise<unknown>;
  suspended(): boolean;
  report(bidId: number, error: unknown): void;
}

/** Retry failures on the next sweep, and never hide job storage behind a finished board bid. */
export function createStorageFinisher(
  deps: StorageFinisherDependencies,
): () => Promise<void> {
  const finished = new Set<number>();
  let running = false;
  async function attempt(
    id: number,
    call: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await call();
      return true;
    } catch (error) {
      if (error instanceof Error && /no storage is left/.test(error.message))
        return true;
      deps.report(id, error);
      return false;
    }
  }
  return async () => {
    if (running || deps.suspended()) return;
    running = true;
    try {
      for (let from = 0; ; from += 50) {
        if (deps.suspended()) return;
        const page = await deps.readBids(from, 50);
        for (const [id, bid] of page) {
          if (deps.suspended()) return;
          if (finished.has(id) || !storageDue(bid)) continue;
          const jobDone =
            bid.job_id == null ||
            (await attempt(id, () => deps.finishJob(bid.job_id!)));
          if (!jobDone || deps.suspended()) continue;
          if (await attempt(id, () => deps.finishBid(id))) finished.add(id);
        }
        if (page.length < 50) return;
      }
    } finally {
      running = false;
    }
  };
}
