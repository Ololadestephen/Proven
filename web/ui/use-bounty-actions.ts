import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./market-client.ts";
import type { Wallet } from "./market-types.ts";
import {
  ActionGate,
  BOUNTY_PENDING_KEY,
  bountyIntentOf,
  type PendingAction,
} from "./action-guard.ts";
import { bountyChain } from "./bounty-chain.ts";
import {
  clearUnreadableJournal,
  guardBountyWallet,
  readBountyJournal,
  reconcileBountyJournal,
  releaseBountyJournal,
  snapshotBefore,
  type BountyRun,
  type BountyTarget,
  type BountyWallet,
  type JournalEnv,
} from "./bounty-wallet.ts";

export interface BountyActions {
  wallet: BountyWallet | null;
  run: BountyRun;
  /** The journaled call that has not been seen on the chain yet, if any. */
  pending: PendingAction | null;
  /** Reads the chain for the journaled call and clears the journal if it took effect. */
  check(): Promise<void>;
  /** After a wallet cancel: clears the journal only if the chain shows no effect. */
  release(): Promise<void>;
  /** The automatic release: the same check, with no error shown while the chain still lags. */
  autoRelease(): Promise<void>;
}

/**
 * The PR bounty page's wallet, run function and journal. It shares the busy line, the notices and
 * the one-action-at-a-time gate with the job board, and keeps its own journal in storage, so a
 * landed-but-errored bounty call is resolved from chain state and never sent a second time.
 */
export function useBountyActions(shared: {
  wallet: Wallet | null;
  gate: ActionGate;
  setBusy: (value: string | null) => void;
  setError: (value: string | null) => void;
  setNotice: (value: string | null) => void;
}): BountyActions {
  const { wallet: base, gate, setBusy, setError, setNotice } = shared;
  const [pending, setPending] = useState<PendingAction | null>(() =>
    readBountyJournal(localStorage),
  );
  const pendingRef = useRef(pending);
  const target = useRef<(BountyTarget & { before?: string }) | null>(null);
  const reader = useMemo(() => bountyChain(api), []);
  const env = useMemo<JournalEnv>(
    () => ({
      locks: navigator.locks,
      storage: localStorage,
      reader,
      onPending: (value) => {
        pendingRef.current = value;
        setPending(value);
      },
    }),
    [reader],
  );
  const wallet = useMemo(
    () => (base ? guardBountyWallet(base, env, () => target.current) : null),
    [base, env],
  );

  const check = useCallback(async () => {
    const saved = pendingRef.current;
    if (saved) await reconcileBountyJournal(env, saved);
  }, [env]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== BOUNTY_PENDING_KEY) return;
      const value = readBountyJournal(localStorage);
      pendingRef.current = value;
      setPending(value);
    };
    window.addEventListener("storage", sync);
    void check().catch(() => undefined);
    const timer = setInterval(() => void check().catch(() => undefined), 10000);
    return () => {
      window.removeEventListener("storage", sync);
      clearInterval(timer);
    };
  }, [check]);

  const release = useCallback(async () => {
    const saved = pendingRef.current;
    if (!saved) return;
    setError(null);
    try {
      if (!bountyIntentOf(saved)) {
        // The record cannot be compared with the chain. Only the person can say it is safe.
        clearUnreadableJournal(env, saved);
        setNotice(
          "The unreadable record was cleared. Check your wallet history.",
        );
      } else if (await releaseBountyJournal(env, saved))
        setNotice("Not on the chain, so nothing was sent. You can sign again.");
      else {
        await check();
        if (pendingRef.current)
          setError(
            "The chain shows this action took effect, or could not be read. Wait for it to clear.",
          );
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The chain could not be read.",
      );
    }
  }, [env, check, setError, setNotice]);

  const autoRelease = useCallback(async () => {
    const saved = pendingRef.current;
    if (!saved || !bountyIntentOf(saved)) return;
    if (await releaseBountyJournal(env, saved))
      setNotice(
        `${saved.label}: not on the chain, so nothing was sent. You can sign again.`,
      );
    else await check();
  }, [env, check, setNotice]);

  const run: BountyRun = async (label, what, task, progress) => {
    if (!gate.enter()) return;
    if (pendingRef.current) {
      setError(
        "The last action is still being confirmed on chain. Try again in a few seconds.",
      );
      gate.leave();
      return;
    }
    if (!base) {
      setError("Connect a wallet first.");
      gate.leave();
      return;
    }
    setBusy(progress ?? `${label}… check your wallet for any request.`);
    setError(null);
    setNotice(null);
    try {
      const full = { label, ...what };
      target.current = {
        ...full,
        before: await snapshotBefore(reader, base.accountId, full),
      };
      const outcome = await task();
      if (outcome && outcome.release) await release().catch(() => undefined);
      setNotice(
        pendingRef.current
          ? "Submitted. Waiting for the chain to confirm."
          : `${label}: done.`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "That did not work. Check wallet history before retrying.",
      );
    } finally {
      target.current = null;
      setBusy(null);
      gate.leave();
    }
  };

  return { wallet, run, pending, check, release, autoRelease };
}
