// What a maintainer reviews before signing a bounty: the repository and issue GitHub reported, the
// suggested branch, the deadlines, the fees and the total that will be locked. Everything here is
// derived from the issue link, the reward and the optional Advanced overrides. Nothing is
// guessed: an override that cannot be used is reported against its own field.
import { NEAR } from "./market-types.ts";
import { parseNearAmount } from "./near-amount.ts";
import type { IssueMetadata } from "./github-issue.ts";

const MILLI = NEAR / 1000n;

/** The amounts a bounty locks besides its reward. */
export interface FeeSchedule {
  /** Kept on-chain as the bounty's record; not returned. */
  storage_deposit: bigint;
  /** Locked with the reward and returned with the payout or the refund. 0 when there is none. */
  check_reserve: bigint;
  /** What a contributor attaches when submitting a pull request; the unused part comes back. */
  submit_fee: bigint;
  /** `preview` numbers are samples, not the contract's. They are replaced once fees are approved. */
  source: "preview" | "contract";
  approved: boolean;
}

/** Sandbox sample values for the preview only. The 0.029 NEAR storage deposit is what the
 * reviewed pilot contract measured; the new contract's figure is measured after design review. */
export const PREVIEW_FEES: FeeSchedule = {
  storage_deposit: 29n * MILLI,
  check_reserve: 0n,
  submit_fee: 10n * MILLI,
  source: "preview",
  approved: false,
};

export interface Advanced {
  /** Empty means the suggested (default) branch. */
  branch: string;
  claim_hours: string;
  open_days: string;
  merge_days: string;
  grace_hours: string;
}

export const ADVANCED_DEFAULTS: Advanced = {
  branch: "",
  claim_hours: "48",
  open_days: "7",
  merge_days: "14",
  grace_hours: "24",
};

export type Field = keyof Advanced | "reward" | "repository";
export interface Problem {
  field: Field;
  message: string;
}

export interface Limits {
  /** The contract's cap per reward, in yoctoNEAR. */
  max_reward: bigint;
  /** What the contract can still lock, in yoctoNEAR. */
  room: bigint;
}

/** The only repository this pilot pays for. */
export interface Pilot {
  repo: string;
  repo_id: number;
}

export interface Deadlines {
  /** Seconds since the epoch. */
  claim_by: number;
  merge_deadline: number;
  checks_until: number;
  claim_secs: number;
  grace_secs: number;
}

export interface Review {
  repo: string;
  repo_id: number;
  issue: number;
  title: string;
  issue_url: string;
  branch: string;
  branch_suggested: string;
  branch_overridden: boolean;
  reward: bigint;
  deadlines: Deadlines;
  fees: FeeSchedule;
  /** Reward plus anything locked with it. */
  locked: bigint;
  /** What comes back to the maintainer if nothing is merged. */
  returned_on_refund: bigint;
  /** What is kept either way. */
  kept: bigint;
}

export type Outcome =
  { ok: true; review: Review } | { ok: false; problems: Problem[] };

const MIN_GRACE_SECS = 10 * 60;
const MAX_GRACE_SECS = 24 * 60 * 60;
const MAX_DURATION_SECS = 30 * 24 * 60 * 60;
const MIN_CLAIM_SECS = 60 * 60;
const MAX_REF_BYTES = 255;

/** A branch name git accepts, in the subset the contract also takes. */
export function branchProblem(name: string): string | null {
  if (name === "") return "Enter a branch name.";
  if (new TextEncoder().encode(name).length > MAX_REF_BYTES)
    return "A branch name can be at most 255 bytes.";
  if ([...name].some((c) => c <= " " || c === "\u007f"))
    return "A branch name cannot contain spaces or control characters.";
  if (/[~^:?*[\\]/.test(name))
    return "A branch name cannot contain ~ ^ : ? * [ or a backslash.";
  if (
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name === "@" ||
    name.split("/").some((part) => part.startsWith("."))
  )
    return "That is not a valid git branch name.";
  return null;
}

function seconds(
  text: string,
  unit: number,
  field: Field,
  label: string,
  problems: Problem[],
): number | null {
  if (!/^\d+(?:\.\d{1,4})?$/.test(text.trim())) {
    problems.push({ field, message: `${label} must be a number.` });
    return null;
  }
  return Math.round(Number(text) * unit);
}

export function reviewPosting(input: {
  meta: IssueMetadata;
  rewardText: string;
  advanced: Advanced;
  limits: Limits;
  pilot: Pilot;
  fees: FeeSchedule;
  /** Seconds since the epoch. */
  now: number;
}): Outcome {
  const { meta, advanced, limits, pilot, fees, now } = input;
  const problems: Problem[] = [];
  if (
    meta.repo_id !== pilot.repo_id ||
    meta.repo.toLowerCase() !== pilot.repo.toLowerCase()
  )
    problems.push({
      field: "repository",
      message: `This pilot only pays for issues in ${pilot.repo}. The link is for ${meta.repo}.`,
    });
  let reward = 0n;
  try {
    reward = parseNearAmount(input.rewardText.trim(), limits.max_reward);
  } catch (error) {
    problems.push({
      field: "reward",
      message: error instanceof Error ? error.message : "Enter a reward.",
    });
  }
  const locked = reward + fees.check_reserve + fees.storage_deposit;
  if (reward > 0n && reward + fees.check_reserve > limits.room)
    problems.push({
      field: "reward",
      message:
        "The contract cannot lock that much right now. Try a smaller reward.",
    });
  const override = advanced.branch.trim();
  const branch = override === "" ? meta.default_branch : override;
  if (override !== "") {
    const bad = branchProblem(override);
    if (bad) problems.push({ field: "branch", message: bad });
  }
  const claim = seconds(
    advanced.claim_hours,
    3600,
    "claim_hours",
    "The claim time",
    problems,
  );
  const open = seconds(
    advanced.open_days,
    86400,
    "open_days",
    "The time the bounty stays open",
    problems,
  );
  const merge = seconds(
    advanced.merge_days,
    86400,
    "merge_days",
    "The merge deadline",
    problems,
  );
  const grace = seconds(
    advanced.grace_hours,
    3600,
    "grace_hours",
    "The checking grace",
    problems,
  );
  if (claim !== null && claim < MIN_CLAIM_SECS)
    problems.push({
      field: "claim_hours",
      message: "A claim must last at least 1 hour.",
    });
  if (merge !== null && (merge <= 0 || merge > MAX_DURATION_SECS))
    problems.push({
      field: "merge_days",
      message: "The merge deadline must be within 30 days.",
    });
  if (open !== null && merge !== null && (open <= 0 || open > merge))
    problems.push({
      field: "open_days",
      message:
        "The bounty must stay open for claims for a positive time that ends by the merge deadline.",
    });
  if (claim !== null && merge !== null && claim > merge)
    problems.push({
      field: "claim_hours",
      message: "A claim cannot last longer than the merge deadline.",
    });
  if (grace !== null && (grace < MIN_GRACE_SECS || grace > MAX_GRACE_SECS))
    problems.push({
      field: "grace_hours",
      message: "The checking grace must be between 10 minutes and 24 hours.",
    });
  if (
    problems.length > 0 ||
    claim === null ||
    open === null ||
    merge === null ||
    grace === null
  )
    return { ok: false, problems };
  return {
    ok: true,
    review: {
      repo: meta.repo,
      repo_id: meta.repo_id,
      issue: meta.issue,
      title: meta.title,
      issue_url: meta.html_url,
      branch,
      branch_suggested: meta.default_branch,
      branch_overridden: override !== "" && override !== meta.default_branch,
      reward,
      deadlines: {
        claim_by: now + open,
        merge_deadline: now + merge,
        checks_until: now + merge + grace,
        claim_secs: claim,
        grace_secs: grace,
      },
      fees,
      locked,
      returned_on_refund: reward + fees.check_reserve,
      kept: fees.storage_deposit,
    },
  };
}

/** Why the Post button does nothing yet. Empty when signing is allowed. */
export function signingBlock(input: {
  fees: FeeSchedule;
  connected: boolean;
  poster: boolean;
}): string {
  if (!input.fees.approved)
    return "Preview only: the fees shown are samples and are not approved, and the new contract is not deployed, so nothing can be signed yet.";
  if (!input.connected) return "Connect a wallet to post.";
  if (!input.poster)
    return "This account is not on the pilot's list of approved posters.";
  return "";
}

/** "48 hours", "7 days", "1 hour 30 minutes": exact, never rounded. */
export function duration(secs: number): string {
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const parts = [
    [days, "day"],
    [hours, "hour"],
    [minutes, "minute"],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`)
    .join(" ");
  return text || `${secs} seconds`;
}
