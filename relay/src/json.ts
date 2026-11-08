import { isHash } from "./hash.ts";

/** Only fixed context is reported; malformed private input is never included in errors. */
export class JsonInputError extends Error {}

export function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new JsonInputError(`${context} is not valid JSON.`);
  }
}

export function parseJsonObject(
  text: string,
  context: string,
): Record<string, unknown> {
  const value = parseJson(text, context);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new JsonInputError(`${context} must be a JSON object.`);
  return value as Record<string, unknown>;
}

export function verifierFromCheck(text: string): string {
  const check = parseJsonObject(text, "Check");
  if (typeof check.verifier !== "string" || !isHash(check.verifier))
    throw new JsonInputError("Check must name a valid verifier hash.");
  return check.verifier;
}
