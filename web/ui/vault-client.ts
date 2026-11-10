// Withdrawals from a key-bound vault (contracts/vault): the signed message and its NEP-413 nonce,
// the JSON `withdraw` arguments, the `info` and `slot` views, destination and amount checks, the
// deadline, and the classification of a withdrawal transaction's final outcome. Pure functions:
// nothing here signs, sends or reads the chain.
import { hex, nep413Hash } from "./bounty-keys.ts";
import { transactionHashOf } from "./action-guard.ts";

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
  | { kind: "pending"; why: string };

/** What this browser signed and submitted, which the evidence must match exactly. */
export interface ExpectedWithdrawal {
  vault: string;
  to: string;
  amount: bigint;
  n: bigint;
  /** The account that submitted the transaction, when known. */
  sender?: string;
}

type Status = Record<string, unknown>;
interface Receipt {
  predecessor_id?: unknown;
  receiver_id?: unknown;
  receipt_id?: unknown;
  receipt?: {
    Action?: { actions?: unknown };
    ActionV2?: { actions?: unknown };
  };
}
interface ReceiptOutcome {
  id?: unknown;
  outcome?: { status?: unknown; receipt_ids?: unknown; executor_id?: unknown };
}
interface TxStatus {
  final_execution_status?: unknown;
  transaction?: {
    signer_id?: unknown;
    receiver_id?: unknown;
    actions?: unknown;
  };
  transaction_outcome?: { outcome?: { receipt_ids?: unknown } };
  receipts?: unknown;
  receipts_outcome?: unknown;
}

const pending = (why: string): WithdrawalOutcome => ({ kind: "pending", why });
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const statusOf = (o: ReceiptOutcome | undefined): Status | null =>
  isObject(o?.outcome?.status) ? (o.outcome.status as Status) : null;
const children = (o: ReceiptOutcome | undefined): string[] => {
  const ids = o?.outcome?.receipt_ids;
  return Array.isArray(ids) && ids.every((x) => typeof x === "string")
    ? (ids as string[])
    : [];
};

/** The deposit of a receipt whose only action is one transfer, or null. */
const transferAmount = (r: Receipt): bigint | null => {
  const actions = r.receipt?.Action?.actions ?? r.receipt?.ActionV2?.actions;
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const deposit = (actions[0] as { Transfer?: { deposit?: unknown } })?.Transfer
    ?.deposit;
  return typeof deposit === "string" && /^[0-9]{1,40}$/.test(deposit)
    ? BigInt(deposit)
    : null;
};

/** The transaction's own `withdraw` arguments, if it is exactly one such call. */
function withdrawCall(
  tx: TxStatus,
): { to: string; amount: bigint; n: bigint } | null {
  const actions = tx.transaction?.actions;
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const call = (actions[0] as { FunctionCall?: Record<string, unknown> })
    ?.FunctionCall;
  if (!call || call.method_name !== "withdraw" || typeof call.args !== "string")
    return null;
  try {
    const bytes = Uint8Array.from(atob(call.args), (c) => c.charCodeAt(0));
    const args = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !isObject(args) ||
      typeof args.to !== "string" ||
      typeof args.amount !== "string" ||
      typeof args.n !== "string" ||
      !/^[0-9]{1,40}$/.test(args.amount) ||
      !/^[0-9]{1,20}$/.test(args.n)
    )
      return null;
    return { to: args.to, amount: BigInt(args.amount), n: BigInt(args.n) };
  } catch {
    return null;
  }
}

/**
 * Classifies a withdrawal from a finalized `EXPERIMENTAL_tx_status` answer. The transaction must
 * be exactly one `withdraw` call to the expected vault with the expected destination, amount and
 * number. Then:
 * - delivered: the call succeeded and the one transfer receipt it created, from the vault to the
 *   destination for exactly the signed amount, succeeded;
 * - returned: that transfer failed and the refund it created, from the system to the vault for
 *   exactly that amount, succeeded (the number is used; the next one is n + 1);
 * - refused: the call itself failed (the number is unchanged);
 * - pending: anything else, including answers that are not final, partial, mismatched or
 *   malformed. Pending shows the funds as neither delivered nor returned.
 */
export function classifyWithdrawal(
  status: unknown,
  expected: ExpectedWithdrawal,
): WithdrawalOutcome {
  if (!isObject(status)) return pending("no answer");
  const tx = status as TxStatus;
  if (tx.final_execution_status !== "FINAL") return pending("not final");
  if (!Array.isArray(tx.receipts) || !Array.isArray(tx.receipts_outcome))
    return pending("malformed answer");
  const receipts = tx.receipts as Receipt[];
  const outcomes = tx.receipts_outcome as ReceiptOutcome[];
  if (tx.transaction?.receiver_id !== expected.vault)
    return pending("another receiver");
  if (
    expected.sender !== undefined &&
    tx.transaction?.signer_id !== expected.sender
  )
    return pending("another sender");
  const args = withdrawCall(tx);
  if (
    !args ||
    args.to !== expected.to ||
    args.amount !== expected.amount ||
    args.n !== expected.n
  )
    return pending("not this withdrawal");
  const first = tx.transaction_outcome?.outcome?.receipt_ids;
  const callId = Array.isArray(first) && first.length === 1 ? first[0] : null;
  const call = outcomes.find((o) => o.id === callId);
  const callStatus = statusOf(call);
  if (!call || !callStatus || call.outcome?.executor_id !== expected.vault)
    return pending("no call outcome");
  if ("Failure" in callStatus) {
    const text = JSON.stringify(callStatus.Failure);
    const reason = /ExecutionError":"([^"]*)"/.exec(text)?.[1] ?? "refused";
    return { kind: "refused", reason, n: expected.n };
  }
  if (!("SuccessValue" in callStatus)) return pending("call not finished");
  const byId = (id: string) => receipts.find((r) => r.receipt_id === id);
  const outcomeOf = (id: string) => outcomes.find((o) => o.id === id);
  // The transfer must be a direct child of the call.
  const transfers = children(call).filter((id) => {
    const r = byId(id);
    return (
      !!r &&
      r.predecessor_id === expected.vault &&
      r.receiver_id === expected.to
    );
  });
  if (transfers.length !== 1) return pending("no single transfer");
  const transferId = transfers[0] as string;
  const transfer = byId(transferId) as Receipt;
  if (transferAmount(transfer) !== expected.amount)
    return pending("transfer amount differs");
  const transferStatus = statusOf(outcomeOf(transferId));
  if (!transferStatus) return pending("transfer not finished");
  if ("SuccessValue" in transferStatus)
    return {
      kind: "delivered",
      to: expected.to,
      amount: expected.amount,
      n: expected.n,
    };
  if (!("Failure" in transferStatus)) return pending("transfer not finished");
  // A failed transfer returns its deposit to the vault in a refund receipt it created.
  const refunds = children(outcomeOf(transferId)).filter((id) => {
    const r = byId(id);
    return (
      !!r &&
      r.predecessor_id === "system" &&
      r.receiver_id === expected.vault &&
      transferAmount(r) === expected.amount
    );
  });
  if (refunds.length !== 1) return pending("refund not recorded");
  const refundStatus = statusOf(outcomeOf(refunds[0] as string));
  if (!refundStatus || !("SuccessValue" in refundStatus))
    return pending("refund not finished");
  return {
    kind: "returned",
    amount: expected.amount,
    n: expected.n,
    next: expected.n + 1n,
  };
}

/**
 * Whether a new authorization may be offered: never while an earlier one is pending, its number
 * is still the vault's number and its deadline has not passed.
 */
export function mayAuthorizeAgain(
  earlier: {
    n: bigint;
    deadline: number;
    outcome: WithdrawalOutcome["kind"];
  } | null,
  vaultN: bigint,
  blockSecs: number,
): boolean {
  if (!earlier || earlier.outcome !== "pending") return true;
  return !(vaultN === earlier.n && blockSecs < earlier.deadline);
}

/**
 * Submits a signed withdrawal from the connected wallet. Returns the transaction hash whenever
 * the wallet names one, including when it reports a failure or an incomplete outcome, so the page
 * can re-check the transaction instead of losing it.
 */
export async function sendWithdrawal(
  wallet: {
    call(call: {
      receiver: string;
      method: string;
      args: Record<string, unknown>;
      deposit: bigint;
      gas: bigint;
    }): Promise<{ transaction_hash: string } | void>;
  },
  w: Withdrawal,
  signature: Uint8Array,
): Promise<{ hash: string | null; error: unknown }> {
  try {
    const result = await wallet.call({
      receiver: w.vault,
      method: "withdraw",
      args: JSON.parse(withdrawArgs(w, signature)),
      deposit: 0n,
      gas: 30n * 10n ** 12n,
    });
    const hash =
      result && result.transaction_hash ? result.transaction_hash : null;
    return { hash, error: null };
  } catch (error) {
    return { hash: transactionHashOf(error), error };
  }
}
