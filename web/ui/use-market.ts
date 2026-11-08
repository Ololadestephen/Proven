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
  reconcilePending,
  releaseUnapplied,
} from "./pending-actions.ts";
function readPending(): PendingAction | null {
  try {
    const value = localStorage.getItem(PENDING_KEY);
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
export function useMarket(bidId?: number) {
  const [market, setMarket] = useState<Market | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(readPending);
  const pendingRef = useRef(pending);
  const gate = useRef(new ActionGate());
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const { wallet: baseWallet, connect, connecting, dev, useDev } = useWallet();
  const intentRef = useRef<PendingAction | null>(null);
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
                readMarket: () => api<Market>("/api/market"),
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
    const value = await api<Market>("/api/market");
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
    void refresh().catch((reason) => setError(String(reason.message)));
    const timer = setInterval(
      () => void refresh().catch(() => undefined),
      10000,
    );
    return () => clearInterval(timer);
  }, [refresh]);
  // A confirmation is news for a moment. It should not stay on the page and look like a waiting state.
  useEffect(() => {
    if (!notice) return;
    if (!pending && notice.startsWith("Submitted")) {
      setNotice("Confirmed on the board.");
      return;
    }
    if (pending) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice, pending]);
  const run: Run = async (label, task) => {
    if (!gate.current.enter()) return;
    if (pendingRef.current) {
      setError(
        "An earlier action is still awaiting chain reconciliation. Check its wallet history before sending anything else.",
      );
      gate.current.leave();
      return;
    }
    if (!market || !wallet) {
      setError("Connect a wallet and wait for the board to load.");
      gate.current.leave();
      return;
    }
    setBusy(label);
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
      await refresh();
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
    const fresh = await api<Market>("/api/market");
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
    setError,
    clock,
    run,
    refresh,
    releasePending,
  };
}
