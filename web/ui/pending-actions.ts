import {
  actionSnapshot,
  journalCall,
  reconciled,
  definitelyNotApplied,
  PENDING_KEY,
  type PendingAction,
} from "./action-guard.ts";
import type { Market, Call } from "./market-types.ts";
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
    send: (call: Call) => Promise<void>;
    onFresh: (market: Market) => void;
  },
) {
  const { locks, storage, marker, call, onPending } = env;
  if (!locks)
    throw new Error(
      "This browser cannot safely guard signing across tabs. Use a current browser.",
    );
  await locks.request(PENDING_KEY, { ifAvailable: true }, async (lock) => {
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
      await env.send(call);
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
