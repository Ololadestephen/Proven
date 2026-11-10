// What the page says about settlements and vaults, as pure functions over the contract's and
// the vault's views. A settlement is due, in flight or in the vault from the contract's view; it
// is withdrawn only when this browser holds a delivered withdrawal receipt from its vault and that
// vault holds no other settlement. A shared vault (one key pair, several settlements) shows its
// withdrawals only for the vault as a whole (OD-11). A failed read is "unavailable", never zero.

export type SettlementKind = "Payout" | "BudgetReturn" | "Refund";

export interface SettlementView {
  kind: SettlementKind;
  vault: string;
  principal: string;
  state: "Due" | "InFlight" | "Done";
  attempt: number;
  sent_at: string;
  outcome: "Unknown" | "Succeeded" | "Failed";
  reconcile: { attempt: number; started_at: string } | null;
  done_by: string | null;
}

export type SettlementStatus =
  | "unavailable"
  | "due"
  | "in_flight"
  | "needs_recording"
  | "in_vault"
  | "withdrawn";

export interface StoredWithdrawal {
  hash: string | null;
  sender: string;
  vault: string;
  to: string;
  amount: string;
  n: string;
  deadline: number;
  outcome: "delivered" | "returned" | "refused" | "unknown";
}

/** The sum this browser holds delivered receipts for, from one vault. */
export function deliveredFrom(
  vault: string,
  history: StoredWithdrawal[],
): bigint {
  return history
    .filter((w) => w.vault === vault && w.outcome === "delivered")
    .reduce((sum, w) => sum + BigInt(w.amount), 0n);
}

export function settlementStatus(
  s: SettlementView | null | undefined,
  settlementsInVault: number,
  delivered: bigint,
): SettlementStatus {
  if (!s || !["Due", "InFlight", "Done"].includes(s.state))
    return "unavailable";
  if (s.state === "Due") return "due";
  if (s.state === "InFlight")
    return s.outcome === "Unknown" ? "in_flight" : "needs_recording";
  if (settlementsInVault === 1 && delivered >= BigInt(s.principal))
    return "withdrawn";
  return "in_vault";
}

export const STATUS_TEXT: Record<SettlementStatus, string> = {
  unavailable: "unavailable",
  due: "due: not sent yet, still reserved in the contract; anyone can send it",
  in_flight:
    "in flight to the vault, still reserved until its result is recorded",
  needs_recording:
    "sent; its result is recorded and needs finishing (anyone, no cost)",
  in_vault: "in the vault, withdrawable with either key",
  withdrawn: "withdrawn from the vault (receipt held by this browser)",
};

const kindText: Record<SettlementKind, string> = {
  Payout: "payout",
  BudgetReturn: "budget return",
  Refund: "refund",
};
export const kindLabel = (k: SettlementKind) => kindText[k];

/** Seconds until a party (15 minutes) and anyone (24 hours) may reconcile an in-flight attempt. */
export function reconcileWindow(
  s: SettlementView,
  nowSecs: number,
  partyDelaySecs: number,
  openDelaySecs: number,
): { party: number; anyone: number } | null {
  if (s.state !== "InFlight") return null;
  const sent = Number(BigInt(s.sent_at) / 1_000_000_000n);
  return {
    party: Math.max(0, sent + partyDelaySecs - nowSecs),
    anyone: Math.max(0, sent + openDelaySecs - nowSecs),
  };
}

export interface VaultRead {
  exists: boolean;
  info: {
    primary: string;
    backup: string;
    n: string;
    fund: string;
    available: string;
  } | null;
}

/** The three vault numbers as text, or "unavailable" for each when the read failed or the vault
 * does not exist yet. */
export function vaultNumbers(
  read: VaultRead | null,
  near: (yocto: string) => string,
): { available: string; fund: string; n: string } {
  if (!read || !read.exists || !read.info)
    return { available: "unavailable", fund: "unavailable", n: "unavailable" };
  return {
    available: near(read.info.available),
    fund: near(read.info.fund),
    n: read.info.n,
  };
}

const STORE = (vault: string) => `proven:vault-withdrawals:${vault}`;

export function loadHistory(
  vault: string,
  storage: Pick<Storage, "getItem"> | null,
): StoredWithdrawal[] {
  try {
    const parsed = JSON.parse(storage?.getItem(STORE(vault)) ?? "[]");
    return Array.isArray(parsed) ? (parsed as StoredWithdrawal[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(
  vault: string,
  history: StoredWithdrawal[],
  storage: Pick<Storage, "setItem"> | null,
) {
  try {
    storage?.setItem(STORE(vault), JSON.stringify(history.slice(-50)));
  } catch {
    /* The vault's own views still show what it holds. */
  }
}
