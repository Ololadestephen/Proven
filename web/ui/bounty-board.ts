// The PR bounty list and page as pure functions over the contract's views: which tab a bounty
// belongs to, what the connected wallet still has to do, the progress path and the activity
// timeline. The contract decides; these only arrange what it already says.
import type { Bounty, Config } from "./bounty-types.ts";
import { liveCheck, refundDue } from "./bounty-status.ts";

export type Tab = "all" | "open" | "progress" | "paid" | "refunded" | "action";
export const TABS: [Tab, string][] = [
  ["all", "All"],
  ["open", "Open"],
  ["progress", "In progress"],
  ["paid", "Paid"],
  ["refunded", "Closed"],
  ["action", "Needs action"],
];

/** The one status tab a bounty belongs to ("all" and "action" are views across them). */
export function tabOf(b: Bounty): Exclude<Tab, "all" | "action"> {
  switch (b.status) {
    case "Open":
      return "open";
    case "Claimed":
    case "Bound":
    case "Ineligible":
      return "progress";
    case "Paid":
      return "paid";
    default:
      return "refunded";
  }
}

/** Whether the connected wallet has something to do on this bounty now. */
export function needsAction(
  b: Bounty,
  me: string | null,
  now: number,
  config: Pick<Config, "refund_cap_secs">,
): boolean {
  if (!me) return false;
  const settling = [b.payout, b.refund].some((s) => s && s.state !== "Done");
  const isBuyer = me === b.buyer;
  const isClaimant = me === b.claim?.wallet;
  if ((isBuyer || isClaimant) && settling) return true;
  if (isBuyer && refundDue(b, now, config.refund_cap_secs)) return true;
  // A claimant still has to submit a pull request while the claim runs.
  if (isClaimant && b.status === "Claimed" && !liveCheck(b, now)) return true;
  return false;
}

export function inTab(
  tab: Tab,
  b: Bounty,
  me: string | null,
  now: number,
  config: Pick<Config, "refund_cap_secs">,
): boolean {
  if (tab === "all") return true;
  if (tab === "action") return needsAction(b, me, now, config);
  return tabOf(b) === tab;
}

export function tabCounts(
  bounties: Bounty[],
  me: string | null,
  now: number,
  config: Pick<Config, "refund_cap_secs">,
): Record<Tab, number> {
  const counts = Object.fromEntries(TABS.map(([t]) => [t, 0])) as Record<
    Tab,
    number
  >;
  for (const b of bounties)
    for (const [t] of TABS) if (inTab(t, b, me, now, config)) counts[t] += 1;
  return counts;
}

export type StepState = "done" | "current" | "todo";
export interface Step {
  label: string;
  state: StepState;
}

/** The progress path: the usual steps, ending in Paid, Refunded or Cancelled as it happened. */
export function progressPath(b: Bounty): Step[] {
  const end =
    b.status === "Refunded"
      ? "Refunded"
      : b.status === "Cancelled"
        ? "Cancelled"
        : b.status === "Ineligible"
          ? "Refund due"
          : "Paid";
  if (b.status === "Cancelled")
    return [
      { label: "Posted", state: "done" },
      { label: "Cancelled", state: "done" },
    ];
  const labels = ["Posted", "Claimed", "PR submitted", "Merge checked", end];
  // How many steps are complete.
  const reached =
    b.status === "Open"
      ? 1
      : b.status === "Claimed"
        ? 2
        : b.status === "Bound"
          ? 3
          : 5;
  return labels.map((label, i) => ({
    label,
    state: i < reached ? "done" : i === reached ? "current" : "todo",
  }));
}

export interface Activity {
  /** Unix seconds. */
  at: number;
  text: string;
}

const secs = (nanos: string) => Number(BigInt(nanos) / 1_000_000_000n);

/** What happened, newest first, from the fields the contract keeps. */
export function activity(b: Bounty): Activity[] {
  const out: Activity[] = [{ at: secs(b.posted_at), text: "Bounty posted" }];
  if (b.claim)
    out.push({
      at: secs(b.claim.claimed_at),
      text: "Claimed by the contributor",
    });
  if (b.binding)
    out.push({
      at: secs(b.binding.bound_at),
      text: `Pull request #${b.binding.pr_number} submitted and verified`,
    });
  if (b.merge) {
    out.push({ at: Number(b.merge.merged_at), text: "Merged on GitHub" });
    out.push({
      at: secs(b.merge.checked_at),
      text: "Merge checked by the verifier",
    });
  }
  if (
    b.last_check &&
    !["bound", "paid"].includes(b.last_check.outcome) &&
    b.last_check.resolved_at
  )
    out.push({
      at: secs(b.last_check.resolved_at),
      text: `Check: ${b.last_check.outcome}`,
    });
  for (const s of [b.payout, b.refund])
    if (s && s.sent_at !== "0")
      out.push({
        at: secs(s.sent_at),
        text: `${s.kind === "Payout" ? "Payout" : "Refund"} sent to the vault${
          s.state === "Done" ? ", confirmed" : ""
        }`,
      });
  return out.sort((x, y) => y.at - x.at);
}

/** The step a link names: "#claim", "#check", "#withdraw" or "#submit-<pull request number>". */
export function stepFromHash(hash: string): { name: string; pr: string } {
  const m = /^#(?:(claim|check|withdraw)|submit-([0-9]{1,10}))$/.exec(hash);
  if (!m) return { name: "", pr: "" };
  return m[1] ? { name: m[1], pr: "" } : { name: "submit", pr: m[2]! };
}
