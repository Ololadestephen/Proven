// What the page says about settlements and vaults, as pure functions over the contract's and
// the vault's views. Two receipts are kept apart. The VAULT CREDIT is the contract's view: the
// settlement is Done because the vault's own record shows the deposit. The WALLET WITHDRAWAL is a
// finalized `withdraw` transaction whose transfer succeeded, which only this browser's history
// (or a transaction hash) can show and which the contract never learns. One never implies the
// other. A vault holds the money of one withdrawal key, which may back several settlements, so a
// withdrawal is attributed to a settlement only when it is alone in its vault. A failed read is
// "unavailable", never zero.

export type SettlementKind = "Payout" | "Refund";

export interface SettlementView {
  kind: SettlementKind;
  /** The withdrawal key, `ed25519:…`. */
  key: string;
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
  outcome: "delivered" | "returned" | "refused" | "pending";
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
  in_vault: "in the vault, withdrawable with the withdrawal key",
  withdrawn: "withdrawn from the vault (receipt held by this browser)",
};

const kindText: Record<SettlementKind, string> = {
  Payout: "payout",
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
    key: string;
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

export type VaultCredit = "none" | "sending" | "unknown" | "in vault";
export type WalletWithdrawal =
  | "not withdrawn"
  | "withdrawing"
  | "withdrawn"
  | "returned to vault"
  | "refused";
/** A withdrawal this browser recorded for the vault, as far as the display needs it. */
export type WithdrawalRecord = Pick<StoredWithdrawal, "outcome"> &
  Partial<Pick<StoredWithdrawal, "to" | "amount">>;
export interface SettlementDisplay {
  vaultCredit: VaultCredit;
  vaultCreditText: string;
  wallet: WalletWithdrawal;
  walletText: string;
}
const CREDIT_TEXT: Record<VaultCredit, string> = {
  none: "No payout or refund exists for this bounty yet.",
  sending:
    "Not confirmed in the vault yet. The amount stays reserved in the contract until the vault's own record shows it.",
  unknown:
    "Sent to the vault, but no result is recorded. It stays reserved in the contract, and the vault's own record decides it when someone asks (reconcile).",
  "in vault":
    "In the vault. The vault's own record shows the deposit, so the contract's part is finished. This is not a withdrawal to a wallet.",
};
const accountText = (w: WithdrawalRecord | null) =>
  w?.to ? ` to ${w.to}` : "";
const WALLET_TEXT: Record<
  WalletWithdrawal,
  (w: WithdrawalRecord | null) => string
> = {
  "not withdrawn": () =>
    "Not withdrawn to a wallet. Nothing leaves the vault until the withdrawal key signs a withdrawal.",
  withdrawing: (w) =>
    `A withdrawal${accountText(w)} was submitted and is not final yet. Check its result before signing another.`,
  withdrawn: (w) =>
    `Withdrawn${accountText(w)}: a finalized withdrawal delivered the amount (receipt held by this browser). The contract does not track this.`,
  "returned to vault": (w) =>
    `The transfer${accountText(w)} failed and the amount came back to the vault. Withdraw again to another account.`,
  refused: () =>
    "The vault refused the withdrawal and nothing moved. Check the details and sign a new withdrawal.",
};
const WALLET_OF: Record<StoredWithdrawal["outcome"], WalletWithdrawal> = {
  pending: "withdrawing",
  delivered: "withdrawn",
  returned: "returned to vault",
  refused: "refused",
};
/**
 * The vault credit and the wallet withdrawal of one settlement, kept apart.
 * - `settlement`: the contract's view; `null` is a bounty with no such settlement, `undefined` a
 *   read that failed or has not happened.
 * - `withdrawal`: the latest withdrawal this browser recorded for the vault, or `null` for none.
 * The credit depends only on the settlement, the wallet only on the withdrawal: a Done settlement
 * never implies a withdrawal, and a withdrawal never marks anything done in the contract.
 * `now` (with the party reconcile delay) turns an old in-flight attempt with no recorded result
 * from "sending" into "unknown".
 */
export function settlementDisplay(
  settlement: SettlementView | null | undefined,
  withdrawal: WithdrawalRecord | null,
  now?: { nowSecs: number; partyDelaySecs: number },
): SettlementDisplay {
  let vaultCredit: VaultCredit;
  if (settlement === null) vaultCredit = "none";
  else if (
    !settlement ||
    !["Due", "InFlight", "Done"].includes(settlement.state)
  )
    vaultCredit = "unknown";
  else if (settlement.state === "Done") vaultCredit = "in vault";
  else if (settlement.state === "Due") vaultCredit = "sending";
  else {
    const sentSecs = Number(BigInt(settlement.sent_at) / 1_000_000_000n);
    const old =
      !!now &&
      settlement.outcome === "Unknown" &&
      sentSecs + now.partyDelaySecs <= now.nowSecs;
    vaultCredit = old ? "unknown" : "sending";
  }
  const wallet = withdrawal ? WALLET_OF[withdrawal.outcome] : "not withdrawn";
  return {
    vaultCredit,
    vaultCreditText: CREDIT_TEXT[vaultCredit],
    wallet,
    walletText: WALLET_TEXT[wallet](withdrawal),
  };
}
/** The latest withdrawal recorded for a vault (the history is in the order it was recorded). */
export function latestWithdrawal(
  vault: string,
  history: StoredWithdrawal[],
): StoredWithdrawal | null {
  const mine = history.filter((w) => w.vault === vault);
  return mine.length ? (mine[mine.length - 1] as StoredWithdrawal) : null;
}
