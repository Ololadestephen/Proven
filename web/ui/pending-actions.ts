import {
  actionSnapshot,
  journalCall,
  reconciled,
  definitelyNotApplied,
  PENDING_KEY,
  type PendingAction,
} from "./action-guard.ts";
import type { Market, Call, WalletCallResult } from "./market-types.ts";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface Environment {
  locks: LockManager;
  storage: Store;
  onPending: (pending: PendingAction | null) => void;
}
export async function guardedCall(
  env: Environment & {
    marker: PendingAction;
    call: Call;
    readMarket: () => Promise<Market>;
    send: (call: Call) => Promise<WalletCallResult | void>;
    onFresh: (market: Market) => void;
  },
) {
  const { locks, storage, marker, call, onPending } = env;
  if (!locks)
    throw new Error(
      "This browser cannot safely guard signing across tabs. Use a current browser.",
    );
  return locks.request(PENDING_KEY, { ifAvailable: true }, async (lock) => {
    if (!lock)
      throw new Error("Another tab is signing. Finish that action first.");
    if (storage.getItem(PENDING_KEY))
      throw new Error(
        "An earlier action in this browser needs reconciliation first.",
      );
    const fresh = await env.readMarket();
    if (actionSnapshot(fresh, marker.account, marker.bidId) !== marker.before) {
      env.onFresh(fresh);
      throw new Error(
        "This job changed in another tab or on chain. Review its current next action before continuing.",
      );
    }
    const journal = journalCall(marker, call);
    storage.setItem(PENDING_KEY, JSON.stringify(journal));
    onPending(journal);
    try {
      return await env.send(call);
    } catch (error) {
      if (definitelyNotApplied(error)) {
        storage.removeItem(PENDING_KEY);
        onPending(null);
      }
      throw error;
    }
  });
}
export async function reconcilePending(
  env: Environment,
  saved: PendingAction,
  market: Market,
) {
  if (!env.locks || !reconciled(saved, market)) return;
  await env.locks.request(PENDING_KEY, { ifAvailable: true }, (lock) => {
    if (lock && env.storage.getItem(PENDING_KEY) === JSON.stringify(saved)) {
      env.storage.removeItem(PENDING_KEY);
      env.onPending(null);
    }
  });
}

/** The person says they cancelled in their wallet. Only clears the mark after a fresh read shows the
 * intended effect did not happen, and never for a different action than the one being looked at.
 * If a signed transaction did still land, the contract refuses a repeat of it. */
export async function releaseUnapplied(
  env: Environment,
  saved: PendingAction,
  market: Market,
): Promise<boolean> {
  if (!env.locks || reconciled(saved, market)) return false;
  let released = false;
  await env.locks.request(PENDING_KEY, { ifAvailable: true }, (lock) => {
    if (lock && env.storage.getItem(PENDING_KEY) === JSON.stringify(saved)) {
      env.storage.removeItem(PENDING_KEY);
      env.onPending(null);
      released = true;
    }
  });
  return released;
}
