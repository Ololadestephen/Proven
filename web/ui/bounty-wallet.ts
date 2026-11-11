// A wallet whose every call goes through the PR bounty journal (action-guard.ts and
// pending-actions.ts). Before the wallet is asked, the journal must be empty, no other tab may be
// signing and the chain must still show what the page showed. The call is journaled, then sent
// once. A wallet error that is not definitely "not applied" leaves the journal in place: the
// transaction may have landed, so the only way forward is to read the chain
// (`reconcileBountyJournal`), never to send again. Nothing here signs a message.
import type { Call, Wallet } from "./market-types.ts";
import {
  BOUNTY_PENDING_KEY,
  bountyIntentOf,
  type PendingAction,
} from "./action-guard.ts";
import {
  bountySnapshotText,
  readBountySnapshot,
  type BountyIntent,
  type BountyReader,
} from "./bounty-reconcile.ts";
import {
  guardedBountyCall,
  readJournal,
  reconcileBountyPending,
  releaseUnappliedBounty,
} from "./pending-actions.ts";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface JournalEnv {
  locks: LockManager;
  storage: Store;
  reader: BountyReader;
  onPending: (pending: PendingAction | null) => void;
}

/** What the next wallet call is for: the bounty it acts on, and the call itself when it is known
 * up front, so the page can take its "before" read when the person clicks, before any signing. */
export interface BountyTarget {
  label: string;
  bountyId: number | null;
  call?: { receiver: string; method: string; args: Record<string, unknown> };
}
export type BountyRun = (
  label: string,
  target: Omit<BountyTarget, "label">,
  task: () => Promise<void | { release?: boolean }>,
  progress?: string,
) => Promise<void>;

/** A wallet whose calls are journaled, and which can say whether a call is still unresolved. */
export type BountyWallet = Wallet & { assertIdle(): void };

export const IDLE_MESSAGE =
  "An earlier action in this browser needs reconciliation first.";

/** Throws unless nothing is journaled. Flows call it before they ask for any signature. */
export function assertJournalIdle(storage: Pick<Storage, "getItem">): void {
  if (storage.getItem(BOUNTY_PENDING_KEY)) throw new Error(IDLE_MESSAGE);
}

/**
 * Wraps `base` so that `call` is guarded. `current` returns what the running action is for; a
 * call made outside any action is refused. The "before" snapshot is the one taken at the click
 * when the target named its call, otherwise it is read just before the call.
 */
export function guardBountyWallet(
  base: Wallet,
  env: JournalEnv,
  current: () => (BountyTarget & { before?: string }) | null,
): BountyWallet {
  return {
    ...base,
    assertIdle: () => assertJournalIdle(env.storage),
    call: async (call: Call) => {
      const target = current();
      if (!target)
        throw new Error("Start this action from a button on the bounty page.");
      const intent: BountyIntent = {
        account: base.accountId,
        receiver: call.receiver,
        method: call.method,
        args: call.args,
        bountyId: target.bountyId,
      };
      const readSnapshot = () => readBountySnapshot(env.reader, intent);
      const before = target.before ?? bountySnapshotText(await readSnapshot());
      const marker: PendingAction = {
        account: base.accountId,
        bountyId: target.bountyId,
        before,
        label: target.label,
        createdAt: Date.now(),
      };
      return await guardedBountyCall({
        locks: env.locks,
        storage: env.storage,
        marker,
        call,
        readSnapshot,
        send: base.call,
        onFresh: () => undefined,
        onPending: env.onPending,
      });
    },
  };
}

/** The snapshot text to keep as "before" for a call known up front. */
export async function snapshotBefore(
  reader: BountyReader,
  account: string,
  target: BountyTarget,
): Promise<string | undefined> {
  if (!target.call) return undefined;
  const intent: BountyIntent = {
    account,
    receiver: target.call.receiver,
    method: target.call.method,
    args: target.call.args,
    bountyId: target.bountyId,
  };
  return bountySnapshotText(await readBountySnapshot(reader, intent));
}

/** The journaled call, or null. A journal that cannot be read comes back as a blocking placeholder. */
export const readBountyJournal = (storage: Pick<Storage, "getItem">) =>
  readJournal(storage, BOUNTY_PENDING_KEY);

/**
 * Clears a journal this code cannot read (it holds no call to compare with the chain). The page
 * offers this only after telling the person to check their wallet history. A readable journal is
 * never cleared here.
 */
export function clearUnreadableJournal(
  env: Pick<JournalEnv, "storage" | "onPending">,
  saved: PendingAction,
): boolean {
  if (saved.call || saved.account !== "unknown") return false;
  env.storage.removeItem(BOUNTY_PENDING_KEY);
  env.onPending(null);
  return true;
}

/**
 * Reads the chain for the journaled call and clears the journal if the call took effect. Returns
 * true when it cleared. A journal without a complete bounty call is left for the person.
 */
export async function reconcileBountyJournal(
  env: JournalEnv,
  saved: PendingAction,
): Promise<boolean> {
  const intent = bountyIntentOf(saved);
  if (!intent) return false;
  const snapshot = await readBountySnapshot(env.reader, intent);
  await reconcileBountyPending(env, saved, snapshot);
  return readBountyJournal(env.storage) === null;
}

/**
 * After the person says they cancelled in their wallet: reads the chain, and clears the journal
 * only if the call has no effect there. Returns true when it cleared.
 */
export async function releaseBountyJournal(
  env: JournalEnv,
  saved: PendingAction,
): Promise<boolean> {
  const intent = bountyIntentOf(saved);
  if (!intent) {
    // Nothing is known about the call, so there is nothing to compare: only a person who has
    // looked at the wallet's history can release it, by clearing it themselves.
    return false;
  }
  const snapshot = await readBountySnapshot(env.reader, intent);
  return releaseUnappliedBounty(env, saved, snapshot);
}
