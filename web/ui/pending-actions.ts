import {
  actionSnapshot,
  bountyActionReconciled,
  journalCall,
  reconciled,
  definitelyNotApplied,
  BOUNTY_PENDING_KEY,
  PENDING_KEY,
  type PendingAction,
} from "./action-guard.ts";
import { bountySnapshotText, type BountySnapshot } from "./bounty-reconcile.ts";
import type { Market, Call, WalletCallResult } from "./market-types.ts";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface Environment {
  locks: LockManager;
  storage: Store;
  onPending: (pending: PendingAction | null) => void;
}
/** One kind of journaled action: its storage key, what it reads and how it tells a call landed. */
interface Domain<State> {
  key: string;
  snapshot(state: State, marker: PendingAction): string;
  applied(pending: PendingAction, state: State): boolean;
  staleMessage: string;
}
const jobBoard: Domain<Market> = {
  key: PENDING_KEY,
  snapshot: (market, marker) =>
    actionSnapshot(market, marker.account, marker.bidId),
  applied: reconciled,
  staleMessage:
    "This job changed in another tab or on chain. Review its current next action before continuing.",
};
const bounties: Domain<BountySnapshot> = {
  key: BOUNTY_PENDING_KEY,
  snapshot: (state) => bountySnapshotText(state),
  applied: bountyActionReconciled,
  staleMessage:
    "This bounty changed in another tab or on chain. Review its current next action before continuing.",
};
/**
 * Writes the journal, then asks the wallet, once. An error that is not definitely "not applied"
 * leaves the journal in place: the call may have landed, and only a chain read may clear it.
 */
async function guarded<State>(
  domain: Domain<State>,
  env: Environment & {
    marker: PendingAction;
    call: Call;
    read: () => Promise<State>;
    send: (call: Call) => Promise<WalletCallResult | void>;
    onFresh: (state: State) => void;
  },
) {
  const { locks, storage, marker, call, onPending } = env;
  if (!locks)
    throw new Error(
      "This browser cannot safely guard signing across tabs. Use a current browser.",
    );
  return locks.request(domain.key, { ifAvailable: true }, async (lock) => {
    if (!lock)
      throw new Error("Another tab is signing. Finish that action first.");
    if (storage.getItem(domain.key))
      throw new Error(
        "An earlier action in this browser needs reconciliation first.",
      );
    const fresh = await env.read();
    if (domain.snapshot(fresh, marker) !== marker.before) {
      env.onFresh(fresh);
      throw new Error(domain.staleMessage);
    }
    const journal = journalCall(marker, call);
    storage.setItem(domain.key, JSON.stringify(journal));
    onPending(journal);
    try {
      return await env.send(call);
    } catch (error) {
      if (definitelyNotApplied(error)) {
        storage.removeItem(domain.key);
        onPending(null);
      }
      throw error;
    }
  });
}
async function reconcile<State>(
  domain: Domain<State>,
  env: Environment,
  saved: PendingAction,
  state: State,
) {
  if (!env.locks || !domain.applied(saved, state)) return;
  await env.locks.request(domain.key, { ifAvailable: true }, (lock) => {
    if (lock && env.storage.getItem(domain.key) === JSON.stringify(saved)) {
      env.storage.removeItem(domain.key);
      env.onPending(null);
    }
  });
}
async function release<State>(
  domain: Domain<State>,
  env: Environment,
  saved: PendingAction,
  state: State,
): Promise<boolean> {
  if (!env.locks || domain.applied(saved, state)) return false;
  let released = false;
  await env.locks.request(domain.key, { ifAvailable: true }, (lock) => {
    if (lock && env.storage.getItem(domain.key) === JSON.stringify(saved)) {
      env.storage.removeItem(domain.key);
      env.onPending(null);
      released = true;
    }
  });
  return released;
}
export function guardedCall(
  env: Environment & {
    marker: PendingAction;
    call: Call;
    readMarket: () => Promise<Market>;
    send: (call: Call) => Promise<WalletCallResult | void>;
    onFresh: (market: Market) => void;
  },
) {
  return guarded(jobBoard, { ...env, read: env.readMarket });
}
export const reconcilePending = (
  env: Environment,
  saved: PendingAction,
  market: Market,
) => reconcile(jobBoard, env, saved, market);
/** The person says they cancelled in their wallet. Only clears the mark after a fresh read shows the
 * intended effect did not happen, and never for a different action than the one being looked at.
 * If a signed transaction did still land, the contract refuses a repeat of it. */
export const releaseUnapplied = (
  env: Environment,
  saved: PendingAction,
  market: Market,
) => release(jobBoard, env, saved, market);

/**
 * The same guard for a PR bounty call. `marker.before` is `bountySnapshotText` of what the page
 * showed; `readSnapshot` reads the chain again with `readBountySnapshot`. The wallet is asked only
 * if nothing is journaled, no other tab is signing and the chain still shows what the page showed.
 */
export function guardedBountyCall(
  env: Environment & {
    marker: PendingAction;
    call: Call;
    readSnapshot: () => Promise<BountySnapshot>;
    send: (call: Call) => Promise<WalletCallResult | void>;
    onFresh: (snapshot: BountySnapshot) => void;
  },
) {
  return guarded(bounties, { ...env, read: env.readSnapshot });
}
/** Clears the bounty journal once a fresh read shows the journaled call took effect. */
export const reconcileBountyPending = (
  env: Environment,
  saved: PendingAction,
  snapshot: BountySnapshot,
) => reconcile(bounties, env, saved, snapshot);
/** After a wallet cancel: clears the bounty journal only if a fresh read shows no effect. */
export const releaseUnappliedBounty = (
  env: Environment,
  saved: PendingAction,
  snapshot: BountySnapshot,
) => release(bounties, env, saved, snapshot);

/**
 * Reads a journal from storage. Nothing stored is null. A journal that cannot be read still blocks
 * new actions, as a placeholder that only a person can release after checking the chain.
 */
export function readJournal(
  storage: Pick<Storage, "getItem">,
  key: string,
): PendingAction | null {
  try {
    const value = storage.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value) as PendingAction;
    if (
      typeof parsed.account !== "string" ||
      typeof parsed.before !== "string" ||
      typeof parsed.label !== "string"
    )
      throw new Error("Invalid pending action");
    return parsed;
  } catch {
    return {
      account: "unknown",
      before: "",
      label: "An earlier action needs reconciliation",
      createdAt: 0,
    };
  }
}
