// Native transfers must be final and bound to the exact source, destination and amount.
import { isObject } from "../json.ts";

export interface TransferExpectation {
  hash: string;
  from: string;
  to: string;
  amount: string;
}
export function confirmedTransfer(
  value: unknown,
  expected: TransferExpectation,
): boolean {
  if (
    !isObject(value) ||
    !isObject(value.transaction) ||
    !isObject(value.status) ||
    typeof value.status.SuccessValue !== "string"
  )
    return false;
  const tx = value.transaction;
  if (
    tx.hash !== expected.hash ||
    tx.signer_id !== expected.from ||
    tx.receiver_id !== expected.to ||
    !Array.isArray(tx.actions) ||
    tx.actions.length !== 1 ||
    !isObject(tx.actions[0]) ||
    !isObject(tx.actions[0].Transfer)
  )
    return false;
  const action = tx.actions[0].Transfer;
  return (
    action.deposit === expected.amount &&
    Object.keys(tx.actions[0]).length === 1
  );
}
