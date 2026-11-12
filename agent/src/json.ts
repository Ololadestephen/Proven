import { PublicError } from "./errors.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse local JSON (a fixture, journal, policy file or tool output) and name its source on failure.
 * The message never includes the text itself, which may hold a key or a private response.
 */
export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON.`);
  }
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
