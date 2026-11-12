import { showNear, type MarketBid, type Step } from "./market-steps.ts";

export type Role = "buyer" | "worker" | "visitor";
/** Long enough for the buyer to run it first. After this the worker may run it, so a buyer who never
 * verifies cannot leave honest work unpaid until the job expires. */
export const WORKER_VERIFY_AFTER_MS = 10 * 60_000;

export function roleOf(bid: MarketBid, viewer: string | null): Role {
  if (viewer && viewer === bid.buyer) return "buyer";
  const job = bid.job ?? bid.last_job;
  const pastWorkers = (job?.history ?? []).map((attempt) => attempt.worker);
  if (
    viewer &&
    (viewer === bid.claim?.agent ||
      viewer === job?.worker ||
      pastWorkers.includes(viewer))
  )
    return "worker";
  return "visitor";
}

const wait = (label: string): Step => ({ id: "wait", label });

/** The same chain-derived step, shown as each side needs it. Bookkeeping that serves only the buyer
 * is hidden from the worker, and nothing here can move money a different way. */
export function stepForViewer(
  step: Step | null,
  bid: MarketBid,
  role: Role,
  nowMs: number,
  viewer: string | null,
): Step | null {
  if (!step) return step;
  // Only the relay or the worker can start verification; the relay does it as soon as the work arrives.
  if (step.id === "verify" && role !== "worker")
    return wait("The work arrived and is being checked.");
  if (role === "buyer") return step;
  const job = bid.job ?? bid.last_job;
  if (role === "visitor") {
    if (["register", "claim", "wait", "close", "review"].includes(step.id))
      return step;
    return wait("Someone is working on this job.");
  }

  // The worker's view. Only the current worker acts; a past worker sees its own attempt's result.
  const current =
    viewer !== null && (viewer === job?.worker || viewer === bid.claim?.agent);
  if (!current && ["verify", "settle", "deliver"].includes(step.id))
    return outcomeFor(bid, viewer);
  switch (step.id) {
    case "verify": {
      const delivered = Number(BigInt(job?.delivered_at ?? "0") / 1_000_000n);
      if (nowMs < delivered + WORKER_VERIFY_AFTER_MS)
        return wait(
          "Delivered. The work is being checked. If nothing happens within 10 minutes, you can start the check yourself.",
        );
      return { ...step, label: "Start the check yourself" };
    }
    case "settle":
      return step.method === "release"
        ? {
            ...step,
            label: `Nothing happened: get paid ${showNear(bid.amount)} now`,
          }
        : wait(
            `Not paid: the work failed the rule “${job?.failed_rule ?? "unknown"}”.`,
          );
    case "deliver":
    case "claim":
    case "register":
      return step;
    default:
      return outcomeFor(bid, viewer);
  }
}

/** What a worker who has finished sees: its own result, read from the escrow's record of attempts. */
function outcomeFor(bid: MarketBid, viewer: string | null): Step | null {
  const job = bid.job ?? bid.last_job;
  const last = job?.history?.findLast((attempt) => attempt.worker === viewer);
  if (
    (job?.state === "Released" && viewer === job.worker) ||
    last?.outcome === "Paid"
  )
    return wait(`Paid. ${showNear(job?.amount ?? bid.amount)} was sent to the worker.`);
  if (last?.outcome === "Failed")
    return wait(
      `Not paid: the work failed the rule “${last.failed_rule ?? "unknown"}”.`,
    );
  if (last?.outcome === "NoDelivery")
    return wait("Not paid: no delivery arrived before the deadline.");
  if (last?.outcome === "NoVerdict")
    return wait("Not paid: no verdict was recorded in time.");
  if (job?.state === "CheckRejected")
    return wait(
      "The buyer’s check failed its own test, so this job cannot run. Nothing was paid.",
    );
  return wait("Waiting for the job to move on.");
}

/** A short note under the button, written for the person pressing it. */
export function noteFor(
  step: Step,
  role: Role,
  escrow: string,
  amount: string,
) {
  if (role === "worker") {
    if (step.id === "claim")
      return "Reserves the job for you. Costs 0.005 NEAR plus gas. Wait until the buyer funds it before you start.";
    if (step.id === "register") return "One time. Costs 0.02 NEAR plus gas.";
    if (step.id === "deliver")
      return "Your wallet asks twice: once to record your work, once to hand it over privately for checking.";
    if (step.id === "verify")
      return "Holds 0.1 NEAR for a few minutes while the check runs. Most of it comes back.";
    return "Check the details in your wallet before confirming.";
  }
  switch (step.id) {
    case "review":
      return "An automated review of the public brief. It can only keep a bid off the board and never decides payment. It costs you nothing, and it usually starts by itself.";
    case "send_check":
      return "Sends your check and reference to the relay, which tests the check against planted fakes. No signature and no cost: they match the hashes you posted.";
    case "verify":
      return "Paid from the job's compute budget. Usually this starts by itself as soon as the work arrives.";
    case "settle":
      return "Moves the held money as the recorded verdict says. Usually this happens by itself within a few minutes.";
    case "close":
      return "Returns your payment, what is left of the compute budget, and the unused attempt fees.";
    case "claim":
      return "Reserves the job for you. Costs 0.005 NEAR plus gas.";
    case "register":
      return "One time. Costs 0.02 NEAR plus gas.";
    default:
      return "Check the details in your wallet before confirming.";
  }
}
