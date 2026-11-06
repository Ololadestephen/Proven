// What needs someone's attention, read from the chain and the service's own ledger. It changes nothing.
import type { Config } from "../config.ts";
import { BoardClient } from "../board.ts";
import type { Job } from "../types.ts";

export interface Alert {
  kind: "stuck_job" | "low_balance" | "budget_near_limit" | "unsettled_fee";
  detail: string;
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
  balances: Array<{ name: string; account: string; minimum: bigint }>;
  balance: (account: string) => Promise<bigint>;
  spentNanoUsd: number;
  limitNanoUsd: number;
}): Promise<{ at: string; alerts: Alert[]; expirable_jobs: number[] }> {
  const board = new BoardClient(deps.config.rpc);
  const alerts: Alert[] = [];
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
      if (
        ["Released", "Refunded", "Expired", "Passed", "Failed"].includes(
          job.state,
        )
      ) {
        const fee = await board.fee(id);
        if (fee?.state === "Held")
          alerts.push({
            kind: "unsettled_fee",
            detail: `Job ${id} has a fee to settle.`,
          });
      }
    }
  }
  for (const entry of deps.balances) {
    const balance = await deps.balance(entry.account);
    if (balance < entry.minimum)
      alerts.push({
        kind: "low_balance",
        detail: `${entry.name} holds ${Number(balance / 10n ** 21n) / 1000} NEAR.`,
      });
  }
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
