// What needs someone's attention, read from the chain and the service's own ledger. It changes nothing.
import type { Config } from "../config.ts";
import { BoardClient } from "../board.ts";
import type { Job } from "../types.ts";
import { RATE_REVIEW_BELOW_USD, USD_PER_NEAR } from "./limits.ts";

export const MAINNET_RELAY_ACCOUNT = "proven-relay.near";
export const MAINNET_RELAY_MINIMUM = 250_000_000_000_000_000_000_000n;

export interface BalanceWatch {
  name: string;
  account: string;
  minimum: bigint;
}

/** Mainnet always watches the run payer with enough headroom for its gas reservation.
 * Testnet never queries the mainnet relay, even if a stale caller setting names it. */
export function healthBalances(
  escrow: string,
  balances: BalanceWatch[],
): BalanceWatch[] {
  const other = balances.filter(
    (entry) => entry.account !== MAINNET_RELAY_ACCOUNT,
  );
  if (!escrow.endsWith(".near")) return other;
  const supplied = balances.filter(
    (entry) => entry.account === MAINNET_RELAY_ACCOUNT,
  );
  const minimum = supplied.reduce(
    (highest, entry) => (entry.minimum > highest ? entry.minimum : highest),
    MAINNET_RELAY_MINIMUM,
  );
  return [
    ...other,
    {
      name: supplied[0]?.name ?? "The relay",
      account: MAINNET_RELAY_ACCOUNT,
      minimum,
    },
  ];
}

function nearAmount(amount: bigint): string {
  const near = 10n ** 24n;
  const fraction = (amount % near)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${amount / near}${fraction ? `.${fraction}` : ""}`;
}

/** The public price, with no account and nothing about us in the request. */
export async function nearPrice(): Promise<number | null> {
  const reply = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd",
    { signal: AbortSignal.timeout(10_000) },
  );
  const body = (await reply.json()) as { near?: { usd?: number } };
  return typeof body.near?.usd === "number" ? body.near.usd : null;
}

export interface Alert {
  kind:
    | "stuck_job"
    | "low_balance"
    | "budget_near_limit"
    | "unsettled_fee"
    | "rate_review"
    | "low_inference_credit"
    | "credit_snapshot_unavailable"
    | "credit_snapshot_stale";
  detail: string;
}

export interface CreditSnapshot {
  usd: number;
  asOf: string;
  spentSinceUsd: number;
}
/** Owner-entered credit, minus this service's ledger since that snapshot. Never a provider balance. */
export function inferenceCreditAlerts(
  snapshot: CreditSnapshot | null,
  now = Date.now(),
): Alert[] {
  const at = snapshot ? Date.parse(snapshot.asOf) : NaN;
  if (
    !snapshot ||
    !Number.isFinite(at) ||
    at > now ||
    !Number.isFinite(snapshot.usd) ||
    snapshot.usd < 0 ||
    !Number.isFinite(snapshot.spentSinceUsd) ||
    snapshot.spentSinceUsd < 0
  )
    return [
      {
        kind: "credit_snapshot_unavailable",
        detail:
          "NEAR AI credit estimate is unavailable. Check the provider dashboard and record a dated owner credit snapshot.",
      },
    ];
  const alerts: Alert[] = [];
  if (now - at > 86400000)
    alerts.push({
      kind: "credit_snapshot_stale",
      detail:
        "The owner-entered NEAR AI credit snapshot is over 24 hours old. Refresh it; this estimate is not the provider's live balance.",
    });
  const remaining = Math.max(0, snapshot.usd - snapshot.spentSinceUsd);
  if (remaining < 1)
    alerts.push({
      kind: "low_inference_credit",
      detail: `Estimated NEAR AI credit is $${remaining.toFixed(2)}, below $1, from an owner-entered snapshot minus local spending. Other services may also use credit; check the provider dashboard.`,
    });
  return alerts;
}

/** A funded job past its deadline, or a delivered one past its verdict window, can be expired by anyone. */
export function stuckReason(job: Job, nowNanos: bigint): string | null {
  const windowEnd =
    BigInt(job.delivered_at ?? 0) +
    BigInt(job.verdict_window_secs ?? 0) * 1_000_000_000n;
  if (job.state === "Funded" && nowNanos > BigInt(job.deadline))
    return "past its delivery deadline";
  if (job.state === "Delivered" && nowNanos > windowEnd)
    return "past its verdict window";
  if (
    job.state === "Verifying" &&
    nowNanos > windowEnd &&
    nowNanos > BigInt(job.run_started_at ?? 0) + 900_000_000_000n
  )
    return "its run never finished";
  return null;
}

export async function healthReport(deps: {
  config: Config;
  balances: BalanceWatch[];
  board?: Pick<BoardClient, "now" | "view" | "bids">;
  balance: (account: string) => Promise<bigint>;
  spentNanoUsd: number;
  limitNanoUsd: number;
  nearPriceUsd?: () => Promise<number | null>;
  monitorInferenceCredit?: boolean;
  creditSnapshot?: CreditSnapshot | null;
}): Promise<{ at: string; alerts: Alert[]; expirable_jobs: number[] }> {
  const board = deps.board ?? new BoardClient(deps.config.rpc);
  const alerts: Alert[] = deps.monitorInferenceCredit
    ? inferenceCreditAlerts(deps.creditSnapshot ?? null)
    : [];
  const now = await board.now();
  const expirable: number[] = [];
  const { next_job_id } = await board.view<{ next_job_id: number }>(
    "get_config",
    {},
    deps.config.escrow,
  );
  for (
    let from = Math.max(0, next_job_id - 200);
    from < next_job_id;
    from += 50
  ) {
    const page = await board.view<Array<[number, Job]>>(
      "get_jobs",
      { from_id: from, limit: 50 },
      deps.config.escrow,
    );
    for (const [id, job] of page) {
      const reason = stuckReason(job, now);
      if (reason) {
        expirable.push(id);
        alerts.push({ kind: "stuck_job", detail: `Job ${id}: ${reason}.` });
      }
    }
  }
  // Attempt fees the board still holds for a job that has ended.
  for (let from = 0; ; from += 50) {
    const page = await board.bids(from, 50);
    for (const [id, bid] of page)
      if (["Done", "Closed"].includes(bid.state) && bid.fees.includes("Held"))
        alerts.push({
          kind: "unsettled_fee",
          detail: `Bid ${id} has attempt fees to settle.`,
        });
    if (page.length < 50) break;
  }
  for (const entry of healthBalances(deps.config.escrow, deps.balances)) {
    const balance = await deps.balance(entry.account);
    if (balance < entry.minimum)
      alerts.push({
        kind: "low_balance",
        detail: `${entry.name} (${entry.account}) holds ${nearAmount(balance)} NEAR, below its ${nearAmount(entry.minimum)} NEAR minimum.${entry.account === MAINNET_RELAY_ACCOUNT ? " Starting a run reserves about 0.2 NEAR for gas." : ""}`,
      });
  }
  const price = await deps.nearPriceUsd?.().catch(() => null);
  if (typeof price === "number" && price < RATE_REVIEW_BELOW_USD)
    alerts.push({
      kind: "rate_review",
      detail: `NEAR is at $${price.toFixed(2)}, below $${RATE_REVIEW_BELOW_USD.toFixed(2)}. Review the $${USD_PER_NEAR} per NEAR inference rate.`,
    });
  if (deps.spentNanoUsd >= 0.8 * deps.limitNanoUsd)
    alerts.push({
      kind: "budget_near_limit",
      detail: `Hosted inference has used $${(deps.spentNanoUsd / 1e9).toFixed(2)} of $${(deps.limitNanoUsd / 1e9).toFixed(2)}.`,
    });
  return { at: new Date().toISOString(), alerts, expirable_jobs: expirable };
}

/** Sends new alerts to a Telegram chat, if one is set up. Each alert is sent once per day. */
export function telegramNotifier(
  token: string | undefined,
  chat: string | undefined,
  send: typeof fetch = fetch,
) {
  const sent = new Map<string, number>();
  return async (alerts: Alert[], now = Date.now()) => {
    if (!token || !chat) return 0;
    let count = 0;
    for (const alert of alerts) {
      const last = sent.get(alert.detail) ?? Number.NEGATIVE_INFINITY;
      if (now - last < 86_400_000) continue;
      sent.set(alert.detail, now);
      await send(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: `Proven: ${alert.detail}`,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      count += 1;
    }
    return count;
  };
}
