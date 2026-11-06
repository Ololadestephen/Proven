import type { Market, Call } from "./market-types.ts";
export interface PendingAction {
  account: string;
  bidId?: number;
  before: string;
  label: string;
  createdAt: number;
  call?: { receiver: string; method: string; args: Record<string, unknown> };
}
export const PENDING_KEY = "proven-testnet-pending-action-v1";
export function actionSnapshot(
  market: Market,
  account: string,
  bidId?: number,
): string {
  return JSON.stringify({
    registered: market.agents.includes(account),
    value:
      bidId === undefined
        ? market.bids.filter((bid) => bid.buyer === account)
        : (market.bids.find((bid) => bid.id === bidId) ?? null),
  });
}
/** Reconcile the intended effect, never an unrelated bid or registration change. */
export function reconciled(pending: PendingAction, market: Market): boolean {
  if (!pending.call) return false;
  const { method, args } = pending.call;
  let before: {
    registered: boolean;
    value: Market["bids"] | Market["bids"][number] | null;
  };
  try {
    before = JSON.parse(pending.before);
    if (!before || typeof before.registered !== "boolean") return false;
  } catch {
    return false;
  }
  if (method === "post_bid" && !Array.isArray(before.value)) return false;
  if (method === "register_agent")
    return market.agents.includes(pending.account) && !before.registered;
  if (method === "post_bid")
    return market.bids.some(
      (bid) =>
        bid.buyer === pending.account &&
        bid.check_hash === args.check_hash &&
        bid.reference_hash === args.reference_hash &&
        bid.description === args.description &&
        !(before.value as Market["bids"]).some((old) => old.id === bid.id),
    );
  const bid = market.bids.find((bid) => bid.id === pending.bidId);
  if (!bid) return false;
  const old = before.value as Market["bids"][number] | null;
  if (method === "create_job")
    return (
      bid.candidate_job_id !== null ||
      (bid.claim?.job_id !== null && bid.claim?.job_id !== undefined)
    );
  if (method === "claim")
    return (
      bid.claim?.agent === pending.account &&
      bid.claim.number !== old?.claim?.number
    );
  if (method === "link_job") return bid.claim?.job_id === args.job_id;
  if (method === "sync") return JSON.stringify(bid) !== JSON.stringify(old);
  if (method === "request_challenge")
    return (
      !!bid.job &&
      bid.claim?.job_id === old?.claim?.job_id &&
      (bid.job.state !== "Draft" ||
        (bid.job.attempt ?? 0) > (old?.job?.attempt ?? 0))
    );
  if (method === "request_verification")
    return (
      !!bid.job &&
      bid.claim?.job_id === old?.claim?.job_id &&
      (bid.job.state !== "Delivered" ||
        (bid.job.attempt ?? 0) > (old?.job?.attempt ?? 0))
    );
  if (method === "fund")
    return !!bid.job && !["Draft", "Challenged"].includes(bid.job.state);
  if (method === "deliver")
    return bid.job?.deliverable_hash === args.deliverable_hash;
  if (method === "release")
    return bid.job?.state === "Released" || bid.last_job?.state === "Released";
  if (method === "refund")
    return ["Refunded", "Expired"].includes(
      bid.job?.state ?? bid.last_job?.state ?? "",
    );
  return false;
}
export class ActionGate {
  active = false;
  enter() {
    if (this.active) return false;
    this.active = true;
    return true;
  }
  leave() {
    this.active = false;
  }
}
export function journalCall(pending: PendingAction, call: Call): PendingAction {
  return {
    ...pending,
    call: { receiver: call.receiver, method: call.method, args: call.args },
  };
}
export class DefinitiveWalletFailure extends Error {}
export function definitelyNotApplied(error: unknown) {
  return (
    error instanceof DefinitiveWalletFailure ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 4001)
  );
}
