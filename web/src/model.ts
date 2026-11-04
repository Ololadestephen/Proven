export const ESCROW = "escrow-v2.proven.testnet";
export const RUN_TIMEOUT_NS = 900_000_000_000n;
const NS_PER_SEC = 1_000_000_000n;
const HASH = /^[0-9a-f]{64}$/;
const STATES = [
  "Draft",
  "Challenging",
  "CheckRejected",
  "Challenged",
  "Funded",
  "Delivered",
  "Verifying",
  "Passed",
  "Failed",
  "Releasing",
  "Refunding",
  "Expiring",
  "Released",
  "Refunded",
  "Expired",
];

export class ReadError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReadError("The upstream response is not a valid object.");
  return value as Record<string, unknown>;
}
export function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value))
    throw new ReadError("The upstream response has an invalid integer.");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new ReadError("The upstream response has an invalid hash.");
  return value;
}
function account(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 64 ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)
  )
    throw new ReadError("The upstream response has an invalid account.");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ReadError("The upstream response has an invalid count.");
  return value;
}
function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

/** Validate public contract state before deriving money or verdict labels. */
export function parseJob(value: unknown) {
  if (value === null)
    throw new ReadError("This job does not exist or was cancelled.", 404);
  const j = object(value);
  if (typeof j.state !== "string" || !STATES.includes(j.state))
    throw new ReadError(
      "Unknown contract state; payment status cannot be inferred.",
    );
  if (
    j.failed_rule !== null &&
    (typeof j.failed_rule !== "string" ||
      !/^[a-zA-Z0-9_.:-]{1,32}$/.test(j.failed_rule))
  )
    throw new ReadError("Invalid failed-rule identifier.");
  return {
    buyer: account(j.buyer),
    worker: account(j.worker),
    token: nullable(j.token, account),
    amount: decimal(j.amount),
    state: j.state,
    deadline: decimal(j.deadline),
    verdict_window_secs: count(j.verdict_window_secs),
    attempt: count(j.attempt),
    run_started_at: nullable(j.run_started_at, decimal),
    delivered_at: nullable(j.delivered_at, decimal),
    spec_hash: hash(j.spec_hash),
    fakes_hash: hash(j.fakes_hash),
    verifier_hash: hash(j.verifier_hash),
    secrets_owner: account(j.secrets_owner),
    deliverable_hash: nullable(j.deliverable_hash, hash),
    fakes_total: count(j.fakes_total),
    fakes_caught: count(j.fakes_caught),
    challenge_request_id: nullable(j.challenge_request_id, decimal),
    challenge_report_hash: nullable(j.challenge_report_hash, hash),
    verdict_request_id: nullable(j.verdict_request_id, decimal),
    report_hash: nullable(j.report_hash, hash),
    failed_rule: j.failed_rule as string | null,
  };
}
export type Job = ReturnType<typeof parseJob>;

export function jobNumber(value: string): number {
  if (
    !/^(0|[1-9][0-9]{0,15})$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new ReadError("Use a nonnegative, safe integer job id.", 400);
  return Number(value);
}

/** Mirrors the contract's strict time boundaries; this is a read, never an action. */
export function progress(job: Job, now: bigint) {
  const active = ["Challenging", "Verifying"].includes(job.state);
  const stale =
    active &&
    job.run_started_at !== null &&
    now > BigInt(job.run_started_at) + RUN_TIMEOUT_NS;
  const end =
    job.delivered_at === null
      ? null
      : BigInt(job.delivered_at) + BigInt(job.verdict_window_secs) * NS_PER_SEC;
  const expired = canExpire(job, now, stale, end);
  const canRetry = canRun(job, now, active, stale, end);
  return {
    funds: funds(job.state),
    verdict: verdict(job),
    run: active
      ? stale
        ? "Callback overdue: this attempt is stale; a late callback cannot decide payment."
        : "OutLayer attempt pending. No new verdict yet."
      : "No attempt is currently in flight.",
    retry: canRetry
      ? "A new run may be triggered with the caller's own compute deposit; no action is sent by this page."
      : "A new run is unavailable in this snapshot.",
    expiry: expired
      ? "Expiry is available on chain; it requires a separate transaction. No refund has been sent by this page."
      : end !== null
        ? `Verification window ends at ${end} ns (chain time).`
        : `Delivery deadline: ${job.deadline} ns (chain time).`,
  };
}
function canExpire(job: Job, now: bigint, stale: boolean, end: bigint | null) {
  if (job.state === "Funded") return now > BigInt(job.deadline);
  if (end === null || now <= end) return false;
  return job.state === "Delivered" || (job.state === "Verifying" && stale);
}
function canRun(
  job: Job,
  now: bigint,
  active: boolean,
  stale: boolean,
  end: bigint | null,
) {
  if (active && !stale) return false;
  if (["Draft", "Challenging"].includes(job.state))
    return now < BigInt(job.deadline);
  return (
    ["Delivered", "Verifying"].includes(job.state) && end !== null && now <= end
  );
}
function funds(state: string): string {
  if (["Released"].includes(state))
    return "Paid to the worker by the confirmed payout callback.";
  if (["Refunded", "Expired"].includes(state))
    return "Returned to the buyer by the confirmed payout callback.";
  if (["Releasing", "Refunding", "Expiring"].includes(state))
    return "Payout pending; transfer success is not confirmed yet.";
  if (["Draft", "Challenging", "CheckRejected", "Challenged"].includes(state))
    return "Job payment has not been funded. Storage and compute deposits are separate.";
  return "Job payment is locked in escrow. Compute deposits are separate.";
}
function verdict(job: Job): string {
  if (job.verdict_request_id === null || job.report_hash === null)
    return "No recorded delivery verdict. Compute failure is neither pass nor fail.";
  if (["Passed", "Releasing", "Released"].includes(job.state))
    return "Pass recorded by the escrow's private callback.";
  if (["Failed", "Refunding", "Refunded"].includes(job.state))
    return "Fail recorded by the escrow's private callback.";
  return "A result reference exists, but its outcome is not inferred from this state.";
}
