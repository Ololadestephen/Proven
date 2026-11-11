// What state a bounty is in, what the next steps are and when a refund opens, as pure functions
// over the contract's `Bounty` view and the page's clock. The rules mirror the contract's:
// `settle`'s due test, `live_run`'s fifteen-minute limit and `end_claim`'s refusal while a
// submission check is live. The contract decides; these functions only tell the person what it
// will accept, so a button is offered only when the call can succeed.
import type { Bounty, Config } from "./bounty-types.ts";

/** A check older than this no longer blocks anything (the contract's `RUN_TIMEOUT_NANOS`). */
export const LIVE_RUN_TIMEOUT_SECS = 15 * 60;
const NANOS = 1_000_000_000n;
const secsOf = (nanos: string) => Number(BigInt(nanos) / NANOS);

export const utc = (secs: string | number) =>
  new Date(Number(secs) * 1000)
    .toISOString()
    .replace(".000Z", " UTC")
    .replace("T", " ");

/** The check that is running now: requested less than fifteen minutes ago, else none. */
export function liveCheck(bounty: Bounty, now: number): Bounty["live"] {
  const run = bounty.live;
  if (!run) return null;
  return now - secsOf(run.requested_at) <= LIVE_RUN_TIMEOUT_SECS ? run : null;
}

export type StatusName =
  | "Open"
  | "Claimed"
  | "PR submitted"
  | "Verifying merge"
  | "Paid"
  | "Refunded"
  | "Cancelled"
  | "Ineligible";

export interface StatusLine {
  name: StatusName;
  /** The line as shown: the name, and for a claim the time it ends. */
  line: string;
  /** One more sentence about what is going on, or empty. */
  detail: string;
}

/** The one status line of a bounty. The settlement is shown separately, never folded in here. */
export function bountyStatus(bounty: Bounty, now: number): StatusLine {
  const live = liveCheck(bounty, now);
  switch (bounty.status) {
    case "Open":
      return {
        name: "Open",
        line: "Open",
        detail:
          now < Number(bounty.claim_by)
            ? `Open for claims until ${utc(bounty.claim_by)}.`
            : "No longer open for claims.",
      };
    case "Claimed": {
      const ends = bounty.claim ? utc(bounty.claim.ends_at) : "";
      return {
        name: "Claimed",
        line: ends ? `Claimed, ends ${ends}` : "Claimed",
        detail:
          live?.kind === "Submit"
            ? `A check of pull request #${live.pr_number} is running. The claim cannot end while it runs.`
            : "",
      };
    }
    case "Bound":
      return live?.kind === "Merge"
        ? {
            name: "Verifying merge",
            line: "Verifying merge",
            detail: `A check of pull request #${live.pr_number} is running.`,
          }
        : {
            name: "PR submitted",
            line: "PR submitted",
            detail: bounty.binding
              ? `Pull request #${bounty.binding.pr_number} is waiting for its merge.`
              : "",
          };
    case "Paid":
      return { name: "Paid", line: "Paid", detail: "" };
    case "Refunded":
      return { name: "Refunded", line: "Refunded", detail: "" };
    case "Cancelled":
      return { name: "Cancelled", line: "Cancelled", detail: "" };
    case "Ineligible":
      return {
        name: "Ineligible",
        line: "Ineligible",
        detail:
          "The pull request was merged after the merge deadline, so it is not paid.",
      };
  }
}

/** The end of the grace: from here a check that found the pull request not merged lets anyone refund. */
export const graceEnds = (b: Bounty) =>
  Number(b.merge_deadline) + Number(b.grace_secs);

/**
 * The hard cutoff (the contract's `hard_refund_nanos`): merge checks are accepted until here, and
 * from here a refund opens even if no check read GitHub.
 */
export const hardRefundAt = (
  b: Bounty,
  refundCapSecs: Config["refund_cap_secs"],
) => graceEnds(b) + refundCapSecs;

/** When merge checks stop being accepted: the hard cutoff. */
export const checksUntil = hardRefundAt;

/**
 * Whether a check requested at or after the merge deadline found the pull request not merged.
 * Only such a definitive negative is recorded; a timeout or no result never is.
 */
const definiteLookAfterDeadline = (b: Bounty) =>
  !!b.definite_look &&
  BigInt(b.definite_look.requested_at) >= BigInt(b.merge_deadline) * NANOS;

/** Whether `settle` would accept now. Mirrors the contract's `settle`. */
export function refundDue(
  bounty: Bounty,
  now: number,
  refundCapSecs: number,
): boolean {
  const idle = liveCheck(bounty, now) === null;
  switch (bounty.status) {
    case "Open":
      return now >= Number(bounty.claim_by);
    case "Claimed": {
      const ends = bounty.claim ? Number(bounty.claim.ends_at) : 0;
      return idle && now >= ends && now >= Number(bounty.claim_by);
    }
    case "Bound":
      return (
        idle &&
        ((definiteLookAfterDeadline(bounty) && now >= graceEnds(bounty)) ||
          now >= hardRefundAt(bounty, refundCapSecs))
      );
    case "Ineligible":
      return true;
    default:
      return false;
  }
}

/** Whether `expire_claim` would accept now: the claim's time has passed and no submission check runs. */
export function claimExpirable(bounty: Bounty, now: number): boolean {
  return (
    bounty.status === "Claimed" &&
    !!bounty.claim &&
    now >= Number(bounty.claim.ends_at) &&
    liveCheck(bounty, now)?.kind !== "Submit"
  );
}
/** Whether the claimant or the maintainer may end the claim now: no submission check is running. */
export function claimEndable(bounty: Bounty, now: number): boolean {
  return (
    bounty.status === "Claimed" &&
    !!bounty.claim &&
    liveCheck(bounty, now)?.kind !== "Submit"
  );
}
/** Whether `check_merge` would accept now: until the hard cutoff, with no check running. */
export function mergeCheckable(
  bounty: Bounty,
  now: number,
  refundCapSecs: number,
): boolean {
  return (
    bounty.status === "Bound" &&
    now < checksUntil(bounty, refundCapSecs) &&
    liveCheck(bounty, now) === null
  );
}

/** What the last merge look says when it could not read GitHub, or null. */
export function failedLookWarning(
  bounty: Bounty,
  refundCapSecs: number,
): string | null {
  const last = bounty.last_check;
  if (bounty.status !== "Bound" || !last || last.kind !== "merge") return null;
  if (!last.outcome.startsWith("no_result")) return null;
  return `The last check of the merge could not read GitHub (${last.outcome}). A failed check changes nothing, and anyone can try again until ${utc(checksUntil(bounty, refundCapSecs))}.`;
}
