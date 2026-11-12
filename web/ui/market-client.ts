import { Buffer } from "buffer";
import type { Wallet } from "./market-types.ts";
import {
  RELAY_RECIPIENT,
  relayMessage,
  relayPayloadText,
} from "../../shared/relay-auth.ts";

export { RELAY_RECIPIENT };
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "That did not work.");
  return data;
}
export const sha256 = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
export const randomNonce = () => crypto.getRandomValues(new Uint8Array(32));
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export const short = (account: string) =>
  account.length > 24
    ? `${account.slice(0, 10)}…${account.slice(-8)}`
    : account;

// Private texts stay in this browser until the relay checks them against the job's hashes.
export const remember = (hash: string, text: string) => {
  try {
    localStorage.setItem(`proven-private-${hash}`, text);
  } catch {
    /* The buyer can paste them again. */
  }
};
export const recall = (hash: string) => {
  try {
    return localStorage.getItem(`proven-private-${hash}`);
  } catch {
    return null;
  }
};

/** Matches the relay's check: a signature covers the action, the job and the exact texts. */
export const relayPayload = (request: Record<string, unknown>) =>
  sha256(relayPayloadText(request));
export async function signed(
  wallet: Wallet,
  request: Record<string, unknown>,
  id: number,
) {
  const message = relayMessage(
    String(request.action),
    id,
    await relayPayload(request),
    Date.now(),
  );
  return {
    ...request,
    auth: { ...(await wallet.signForRelay(message)), message },
  };
}
