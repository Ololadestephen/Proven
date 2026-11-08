import { PublicError } from "./errors.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Boundary errors never echo private input, provider responses or credentials. */
export function jsonObject(
  text: string,
  message: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PublicError(message);
  }
  if (!isObject(value)) throw new PublicError(message);
  return value;
}
