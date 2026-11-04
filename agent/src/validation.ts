import { PublicError } from "./errors.ts";

export type Args = Record<string, unknown>;
export function object(value: unknown): Args {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new PublicError("Expected a JSON object.");
  return value as Args;
}
export function fields(args: Args, allowed: readonly string[]): void {
  if (Object.keys(args).some((k) => !allowed.includes(k)))
    throw new PublicError("Unknown field in request.");
}
export function text(args: Args, name: string, max = 262144): string {
  const value = args[name];
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > max
  )
    throw new PublicError(`Invalid ${name}.`);
  return value;
}
export function integer(
  args: Args,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const value = args[name] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new PublicError(`Invalid ${name}.`);
  return value;
}
export function flag(args: Args, name: string): boolean {
  if (args[name] === undefined) return false;
  if (typeof args[name] !== "boolean")
    throw new PublicError(`Invalid ${name}.`);
  return args[name];
}
export function accountId(value: string): string {
  if (
    !/^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$/.test(value) ||
    value.length < 2 ||
    value.length > 64
  )
    throw new PublicError("Invalid account id.");
  return value;
}
export function yocto(value: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(value))
    throw new PublicError("Invalid amount_near.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"));
  if (amount <= 0n || amount > 10n ** 23n)
    throw new PublicError(
      "Demo job amount must be greater than zero and at most 0.1 NEAR.",
    );
  return amount.toString();
}
export function requestId(value: string): string {
  if (
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new PublicError("Invalid request_id.");
  return value;
}
