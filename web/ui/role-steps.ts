import { showNear, type MarketBid, type Step } from "./market-steps.ts";

export type Role = "buyer" | "worker" | "visitor";
/** Long enough for the buyer to run it first. After this the worker may run it, so a buyer who never
 * verifies cannot leave honest work unpaid until the job expires. */
export const WORKER_VERIFY_AFTER_MS = 10 * 60_000;

export function roleOf(bid: MarketBid, viewer: string | null): Role {
  if (viewer && viewer === bid.buyer) return "buyer";
  const job = bid.job ?? bid.last_job;
  if (viewer && (viewer === bid.claim?.agent || viewer === job?.worker))
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
): Step | null {
  if (!step || role === "buyer") return step;
  const job = bid.job ?? bid.last_job;
  if (role === "visitor") {
    if (["register", "claim", "wait", "close"].includes(step.id)) return step;
    return wait("Someone is working on this job.");
  }
  // The worker's view.
  switch (step.id) {
    case "verify": {
      const delivered = Number(BigInt(job?.delivered_at ?? "0") / 1_000_000n);
      if (nowMs < delivered + WORKER_VERIFY_AFTER_MS)
        return wait(
          "Delivered. Waiting for the verdict. If the buyer has not started it within 10 minutes, you can.",
        );
      return { ...step, label: "Run the verification yourself" };
    }
    case "settle":
      return step.method === "release"
        ? { ...step, label: `Get paid ${showNear(bid.amount)}` }
        : wait(
            `Not paid: the work failed the rule “${job?.failed_rule ?? "unknown"}”.`,
          );
    case "settle_fee":
      return job?.state === "Refunded" &&
        job.failed_rule &&
        job.failed_rule !== "format"
        ? { ...step, label: "Collect your 0.015 NEAR attempt fee" }
        : null;
    case "sync":
    case "expire":
    case "close":
    case "collect":
      return job?.state === "Released"
        ? wait(`Paid. ${showNear(job.amount)} was sent to you.`)
        : job?.state === "Refunded"
          ? wait(
              `Not paid: the work failed the rule “${job.failed_rule ?? "unknown"}”.`,
            )
          : job?.state === "Expired"
            ? wait("Expired. The money went back to the buyer.")
            : job?.state === "CheckRejected"
              ? wait(
                  "The buyer’s check failed its own test, so this job cannot run. Nothing was paid.",
                )
              : null;
    default:
      return step;
  }
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
      return "An automated review of the public brief. It can only keep a bid off the board and never decides payment. It costs you nothing.";
    case "fund":
      return `Sends ${showNear(amount)} to ${escrow}, held until the verdict. Only your check decides it.`;
    case "challenge":
    case "verify":
      return "Holds 0.1 NEAR plus gas for the run. Most of it comes back. The relay can read the private texts.";
    case "create_job":
      return "Creates the job for this worker. Costs 0.02 NEAR plus gas.";
    case "link_job":
      return "Links the job and pays the 0.015 NEAR attempt fee plus a 0.002 NEAR record.";
    case "claim":
      return "Reserves the job for you. Costs 0.005 NEAR plus gas.";
    case "register":
      return "One time. Costs 0.02 NEAR plus gas.";
    default:
      return "Check the details in your wallet before confirming.";
  }
}
