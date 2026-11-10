// Withdrawals from a key-bound vault (contracts/vault): the signed message and its NEP-413 nonce,
// the JSON `withdraw` arguments, the `info` and `slot` views, destination and amount checks, the
// deadline, and the classification of a withdrawal transaction's final outcome. Pure functions:
// nothing here signs, sends or reads the chain.
import { hex, nep413Hash } from "./bounty-keys.ts";

/** The vault refuses a deadline more than 15 minutes ahead (OD-7); the page asks for 10. */
export const MAX_DEADLINE_AHEAD_SECS = 15 * 60;
export const DEADLINE_AHEAD_SECS = 10 * 60;
export const INFO_LEN = 106;
export const RECORD_LEN = 25;
export const SETTLEMENT_KIND = {
  Payout: 0,
  BudgetReturn: 1,
  Refund: 2,
} as const;
export type SettlementKindName = keyof typeof SETTLEMENT_KIND;

const ACCOUNT =
  /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;

export const isAccountId = (id: string) => ACCOUNT.test(id);
/** Implicit and deterministic accounts exist by name; only named accounts must exist already. */
export const isNamedAccount = (id: string) =>
  !/^[0-9a-f]{64}$/.test(id) &&
  !/^0x[0-9a-f]{40}$/.test(id) &&
  !/^0s[0-9a-f]{40}$/.test(id);

export interface Withdrawal {
  chain: string;
  vault: string;
  to: string;
  amount: bigint;
  n: bigint;
  deadline: number;
}

export function withdrawMessage(w: Withdrawal): string {
  return `proven-vault-withdraw:v2|chain=${w.chain}|vault=${w.vault}|to=${w.to}|amount=${w.amount}|n=${w.n}|deadline=${w.deadline}`;
}

/** 24 zero bytes, then the withdrawal number as 8 big-endian bytes. */
export function withdrawNonce(n: bigint): Uint8Array {
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setBigUint64(24, n, false);
  return nonce;
}

/** The hash either vault key signs for this withdrawal; its NEP-413 recipient is the vault. */
export const withdrawHash = (w: Withdrawal) =>
  nep413Hash(withdrawMessage(w), withdrawNonce(w.n), w.vault);

/** The JSON arguments of the vault's `withdraw`, with the 64-byte signature as hex. */
export function withdrawArgs(w: Withdrawal, signature: Uint8Array): string {
  if (signature.length !== 64) throw new Error("A signature has 64 bytes.");
  return JSON.stringify({
    to: w.to,
    amount: w.amount.toString(),
    n: w.n.toString(),
    deadline: String(w.deadline),
    signature: hex(signature),
  });
}

/** The NEAR CLI fallback for the same call, from any account that pays the gas. */
export function cliCommand(
  w: Withdrawal,
  args: string,
  signer: string,
): string {
  return `near contract call-function as-transaction ${w.vault} withdraw json-args '${args}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as ${signer} network-config ${w.chain} sign-with-keychain send`;
}

export interface VaultInfo {
  primary: Uint8Array;
  backup: Uint8Array;
  n: bigint;
  fund: bigint;
  available: bigint;
}

const le = (b: Uint8Array) => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--)
    v = (v << 8n) | BigInt(b[i] as number);
  return v;
};
const toLe = (v: bigint, len: number) => {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

export function decodeInfo(bytes: Uint8Array): VaultInfo {
  if (bytes.length !== INFO_LEN) throw new Error("Unreadable vault view.");
  return {
    primary: bytes.slice(0, 33),
    backup: bytes.slice(33, 66),
    n: le(bytes.slice(66, 74)),
    fund: le(bytes.slice(74, 90)),
    available: le(bytes.slice(90, 106)),
  };
}

export function encodeInfo(i: VaultInfo): Uint8Array {
  const out = new Uint8Array(INFO_LEN);
  out.set(i.primary, 0);
  out.set(i.backup, 33);
  out.set(toLe(i.n, 8), 66);
  out.set(toLe(i.fund, 16), 74);
  out.set(toLe(i.available, 16), 90);
  return out;
}

export interface DepositRecord {
  deposited: boolean;
  attempt: number;
  amount: bigint;
  sealedThrough: number;
}

export function decodeRecord(bytes: Uint8Array): DepositRecord {
  if (bytes.length !== RECORD_LEN || (bytes[0] as number) > 1)
    throw new Error("Unreadable deposit record.");
  return {
    deposited: bytes[0] === 1,
    attempt: Number(le(bytes.slice(1, 5))),
    amount: le(bytes.slice(5, 21)),
    sealedThrough: Number(le(bytes.slice(21, 25))),
  };
}

export function encodeRecord(r: DepositRecord): Uint8Array {
  const out = new Uint8Array(RECORD_LEN);
  out[0] = r.deposited ? 1 : 0;
  out.set(toLe(BigInt(r.attempt), 4), 1);
  out.set(toLe(r.amount, 16), 5);
  out.set(toLe(BigInt(r.sealedThrough), 4), 21);
  return out;
}

/** `slot` arguments: issuer as a borsh string, bounty u64, kind u8. */
export function slotArgs(
  issuer: string,
  bounty: number,
  kind: SettlementKindName,
): Uint8Array {
  const name = new TextEncoder().encode(issuer);
  return Uint8Array.from([
    ...toLe(BigInt(name.length), 4),
    ...name,
    ...toLe(BigInt(bounty), 8),
    SETTLEMENT_KIND[kind],
  ]);
}

/** A deadline later than the latest block time read, and inside the vault's limit. */
export const chooseDeadline = (blockSecs: number) =>
  blockSecs + DEADLINE_AHEAD_SECS;

export type Refusal =
  | "bad_destination"
  | "destination_is_vault"
  | "destination_missing"
  | "zero_amount"
  | "above_balance"
  | "deadline_passed"
  | "deadline_too_far";

/**
 * Checks a withdrawal before any signature is requested. `exists` is the read of the destination
 * account (null when not read); a named destination must exist.
 */
export function checkWithdrawal(
  w: Withdrawal,
  available: bigint,
  exists: boolean | null,
  blockSecs: number,
): Refusal | null {
  if (!isAccountId(w.to)) return "bad_destination";
  if (w.to === w.vault) return "destination_is_vault";
  if (isNamedAccount(w.to) && exists !== true) return "destination_missing";
  if (w.amount <= 0n) return "zero_amount";
  if (w.amount > available) return "above_balance";
  if (w.deadline <= blockSecs) return "deadline_passed";
  if (w.deadline - blockSecs > MAX_DEADLINE_AHEAD_SECS)
    return "deadline_too_far";
  return null;
}

export type WithdrawalOutcome =
  | { kind: "delivered"; to: string; amount: bigint; n: bigint }
  | { kind: "returned"; amount: bigint; n: bigint; next: bigint }
  | { kind: "refused"; reason: string; n: bigint }
  | { kind: "unknown" };

interface Receipt {
  predecessor_id?: string;
  receiver_id?: string;
  receipt_id?: string;
  receipt?: {
    Action?: { actions?: unknown[] };
    ActionV2?: { actions?: unknown[] };
  };
}
interface ReceiptOutcome {
  id?: string;
  outcome?: { status?: Record<string, unknown> };
}

const transferAmount = (r: Receipt): bigint | null => {
  const actions =
    r.receipt?.Action?.actions ?? r.receipt?.ActionV2?.actions ?? [];
  const t =
    actions.length === 1
      ? (actions[0] as { Transfer?: { deposit?: string } })
      : null;
  return t?.Transfer?.deposit ? BigInt(t.Transfer.deposit) : null;
};

/**
 * Classifies a withdrawal from an `EXPERIMENTAL_tx_status` answer: delivered only if the vault
 * accepted it and the transfer to the destination succeeded; returned if that transfer failed
 * (the number is used, the next one is n + 1); refused if the vault refused the call (the number
 * is unchanged); unknown otherwise.
 */
export function classifyWithdrawal(
  status: unknown,
  vault: string,
  signed: { to: string; amount: bigint; n: bigint },
): WithdrawalOutcome {
  const tx = status as {
    transaction?: { receiver_id?: string };
    receipts?: Receipt[];
    receipts_outcome?: ReceiptOutcome[];
    transaction_outcome?: { outcome?: { status?: Record<string, unknown> } };
    final_execution_status?: string;
  } | null;
  if (!tx || !Array.isArray(tx.receipts_outcome) || !Array.isArray(tx.receipts))
    return { kind: "unknown" };
  if (tx.transaction?.receiver_id !== vault) return { kind: "unknown" };
  const outcomes = tx.receipts_outcome;
  const byId = (id: string | undefined) =>
    tx.receipts?.find((r) => r.receipt_id === id);
  // The call receipt is the first outcome; it ran on the vault.
  const call = outcomes[0];
  const callStatus = call?.outcome?.status;
  if (!callStatus) return { kind: "unknown" };
  if ("Failure" in callStatus) {
    const text = JSON.stringify(callStatus.Failure);
    const reason = /ExecutionError":"([^"]*)"/.exec(text)?.[1] ?? "refused";
    return { kind: "refused", reason, n: signed.n };
  }
  if (!("SuccessValue" in callStatus) && !("SuccessReceiptId" in callStatus))
    return { kind: "unknown" };
  for (const o of outcomes.slice(1)) {
    const r = byId(o.id);
    if (!r || r.predecessor_id !== vault || r.receiver_id !== signed.to)
      continue;
    const amount = transferAmount(r);
    if (amount === null) continue;
    const s = o.outcome?.status;
    if (!s) return { kind: "unknown" };
    if ("Failure" in s)
      return { kind: "returned", amount, n: signed.n, next: signed.n + 1n };
    if ("SuccessValue" in s)
      return { kind: "delivered", to: r.receiver_id, amount, n: signed.n };
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/**
 * Whether a new authorization may be offered: never while an earlier one's outcome is unknown,
 * its number is still the vault's number and its deadline has not passed.
 */
export function mayAuthorizeAgain(
  pending: {
    n: bigint;
    deadline: number;
    outcome: WithdrawalOutcome["kind"];
  } | null,
  vaultN: bigint,
  blockSecs: number,
): boolean {
  if (!pending || pending.outcome !== "unknown") return true;
  return !(vaultN === pending.n && blockSecs < pending.deadline);
}
