import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./market-client.ts";
import { useWallet } from "./use-wallet.ts";
import type { Market, Wallet, Run } from "./market-types.ts";
import {
  ActionGate,
  actionSnapshot,
  PENDING_KEY,
  type PendingAction,
} from "./action-guard.ts";
import {
  guardedCall,
  readJournal,
  reconcilePending,
  releaseUnapplied,
} from "./pending-actions.ts";
import { useBountyActions } from "./use-bounty-actions.ts";
const readPending = () => readJournal(localStorage, PENDING_KEY);
async function readFreshMarket(): Promise<Market> {
  const value = await api<Market>("/api/market");
  if (value.snapshot_stale)
    throw new Error(
      "Wait for the job board to reconnect before starting an action.",
    );
  return value;
}

export function useMarket(bidId?: number) {
  const [market, setMarket] = useState<Market | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(readPending);
  const pendingRef = useRef(pending);
  const gate = useRef(new ActionGate());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardUnavailable, setBoardUnavailable] = useState(false);
  const boardFailed = useRef(false);
  const [clock, setClock] = useState(Date.now());
  const { wallet: baseWallet, connect, connecting, dev, useDev } = useWallet();
  const intentRef = useRef<PendingAction | null>(null);
  // The PR bounty page: its own wallet, run function and journal, sharing the busy line.
  const bounty = useBountyActions({
    wallet: baseWallet,
    gate: gate.current,
    setBusy,
    setError,
    setNotice,
  });
  const wallet = useMemo<Wallet | null>(
    () =>
      baseWallet
        ? {
            ...baseWallet,
            call: async (call) => {
              const marker = intentRef.current;
              if (!marker)
                throw new Error("Start this action from its job workspace.");
              return await guardedCall({
                locks: navigator.locks,
                storage: localStorage,
                marker,
                call,
                readMarket: readFreshMarket,
                send: baseWallet.call,
                onFresh: setMarket,
                onPending: (value) => {
                  pendingRef.current = value;
                  setPending(value);
                },
              });
            },
          }
        : null,
    [baseWallet],
  );
  const refresh = useCallback(async () => {
    const value = await api<Market>("/api/market")
      .then((snapshot) => {
        if (snapshot.snapshot_stale) {
          setMarket((current) => current ?? snapshot);
          throw new Error("The job board is temporarily unavailable.");
        }
        return snapshot;
      })
      .catch((reason: unknown) => {
        setBoardUnavailable(true);
        if (!boardFailed.current) {
          boardFailed.current = true;
          setError(
            "We can’t reach the job board right now. We’ll try again shortly.",
          );
        }
        throw reason;
      });
    boardFailed.current = false;
    setBoardUnavailable(false);
    setMarket(value);
    setClock(Date.now());
    const saved = pendingRef.current;
    if (saved)
      await reconcilePending(
        {
          locks: navigator.locks,
          storage: localStorage,
          onPending: (value) => {
            pendingRef.current = value;
            setPending(value);
          },
        },
        saved,
        value,
      );
    return value;
  }, []);
  useEffect(() => {
    const sync = () => {
      const value = readPending();
      pendingRef.current = value;
      setPending(value);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = setInterval(
      () => void refresh().catch(() => undefined),
      10000,
    );
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);
  // A confirmation is news for a moment. It should not stay on the page and look like a waiting state.
  useEffect(() => {
    if (!notice) return;
    if (!pending && notice.startsWith("Submitted")) {
      setNotice("Confirmed on the board.");
      return;
    }
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice, pending]);
  const run: Run = async (label, task, progress) => {
    if (!gate.current.enter()) return;
    if (pendingRef.current) {
      setError(
        "An earlier action is still awaiting chain reconciliation. Check its wallet history before sending anything else.",
      );
      gate.current.leave();
      return;
    }
    if (boardFailed.current) {
      setError(
        "Wait for the job board to reconnect before starting an action.",
      );
      gate.current.leave();
      return;
    }
    if (!market || !wallet) {
      setError("Connect a wallet and wait for the board to load.");
      gate.current.leave();
      return;
    }
    setBusy(progress ?? `${label}… check your wallet for any request.`);
    setError(null);
    setNotice(null);
    const readOnly = label === "Collect the work";
    try {
      if (!readOnly)
        intentRef.current = {
          account: wallet.accountId,
          bidId: bidId,
          before: actionSnapshot(market, wallet.accountId, bidId),
          label,
          createdAt: Date.now(),
        };
      await task();
      await refresh().catch(() => undefined);
      setNotice(
        readOnly
          ? "The delivery is ready below."
          : pendingRef.current
            ? "Submitted. Waiting for the board to confirm."
            : `${label}: done.`,
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "That did not work. Check wallet history before retrying.",
      );
    } finally {
      intentRef.current = null;
      setBusy(null);
      gate.current.leave();
    }
  };

  /** After a wallet cancel: read the chain again, and carry on only if nothing happened. */
  const releasePending = async () => {
    const saved = pendingRef.current;
    if (!saved) return;
    setError(null);
    const fresh = await readFreshMarket();
    setMarket(fresh);
    const released = await releaseUnapplied(
      {
        locks: navigator.locks,
        storage: localStorage,
        onPending: (value) => {
          pendingRef.current = value;
          setPending(value);
        },
      },
      saved,
      fresh,
    );
    if (released) setNotice("Nothing reached the chain. You can carry on.");
    else await refresh();
  };

  return {
    market,
    wallet,
    connect,
    connecting,
    dev,
    useDev,
    busy,
    pending,
    notice,
    error,
    boardUnavailable,
    setError,
    clock,
    run,
    refresh,
    releasePending,
    bounty,
  };
}
