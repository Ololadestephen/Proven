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
  const jobOf = (value: typeof bid | null) => value?.job ?? null;
  const job = jobOf(bid);
  const oldJob = jobOf(old);
  if (method === "claim")
    return (
      bid.claim?.agent === pending.account &&
      bid.claim.number !== old?.claim?.number
    );
  if (method === "sync" || method === "close_bid")
    return JSON.stringify(bid) !== JSON.stringify(old);
  // Any change to the job's state or attempts means the call was applied.
  if (method === "expire" || method === "refund")
    return (
      !!job &&
      (job.state !== oldJob?.state ||
        (job.history?.length ?? 0) > (oldJob?.history?.length ?? 0))
    );
  if (method === "request_verification")
    return (
      !!job &&
      (job.state !== "Delivered" || (job.attempt ?? 0) > (oldJob?.attempt ?? 0))
    );
  if (method === "deliver")
    return job?.deliverable_hash === args.deliverable_hash;
  if (method === "release")
    return job?.state === "Released" || job?.state === "Releasing";
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
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** A wallet failure that may still name the transaction it sent. */
export class DefinitiveWalletFailure extends Error {
  readonly transactionHash: string | null;
  constructor(message: string, transactionHash: string | null = null) {
    super(message);
    this.transactionHash = transactionHash;
  }
}
/** The wallet returned no final, successful outcome; the transaction may still have landed. */
export class IncompleteWalletOutcome extends Error {
  readonly transactionHash: string | null;
  constructor(message: string, transactionHash: string | null) {
    super(message);
    this.transactionHash = transactionHash;
  }
}
/** A transaction hash carried by a wallet error, if it names one in a known field. */
export function transactionHashOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as Record<string, unknown>;
  const nested = (v: unknown, key: string) =>
    typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)[key]
      : undefined;
  for (const candidate of [
    e.transactionHash,
    e.transaction_hash,
    e.txHash,
    nested(e.transaction, "hash"),
    nested(nested(e.outcome, "transaction"), "hash"),
  ])
    if (typeof candidate === "string" && TX_HASH.test(candidate))
      return candidate;
  return null;
}
export function definitelyNotApplied(error: unknown) {
  return (
    error instanceof DefinitiveWalletFailure ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 4001)
  );
}
