// Resolves a journaled wallet action without asking the person. While the wallet is still open
// (busy), nothing happens: a late signature is still possible. Once the wallet has answered, the
// chain is read every few seconds. If the call shows up, the journal clears as a success. If it has
// not shown up after `GIVE_UP_MS`, the journal is released only when a fresh read shows no effect,
// so the person can sign again. A NEAR transaction is final within seconds, and the wallet has
// already returned, so nothing signed in that request can still land later in normal operation;
// if one ever did, the contract refuses a repeat of an action that already took effect.
import { useEffect, useRef } from "react";
import type { PendingAction } from "./action-guard.ts";

export const POLL_MS = 3000;
export const GIVE_UP_MS = 30000;

/** What to do now for a journal, given when the wallet answered. Pure, for tests. */
export function nextStep(settledAt: number, now: number): "check" | "release" {
  return now - settledAt >= GIVE_UP_MS ? "release" : "check";
}

/** A journal this page cannot compare with the chain: only the person can clear it. */
export const unreadable = (pending: PendingAction) =>
  pending.account === "unknown";

export function useAutoResolve(input: {
  pending: PendingAction | null;
  busy: boolean;
  /** Reads the chain and clears the journal if the call took effect. */
  check: () => Promise<unknown>;
  /** Clears the journal only if a fresh read shows no effect. */
  release: () => Promise<unknown>;
}) {
  const { pending, busy } = input;
  const calls = useRef(input);
  calls.current = input;
  const settled = useRef<{ key: number; at: number } | null>(null);
  useEffect(() => {
    if (!pending || busy || unreadable(pending)) {
      if (!pending) settled.current = null;
      return;
    }
    if (settled.current?.key !== pending.createdAt)
      settled.current = { key: pending.createdAt, at: Date.now() };
    let stopped = false;
    let running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const step = nextStep(settled.current?.at ?? Date.now(), Date.now());
        if (step === "check") await calls.current.check();
        else await calls.current.release();
      } catch {
        // A failed read changes nothing; the next tick reads again.
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pending, busy]);
}
