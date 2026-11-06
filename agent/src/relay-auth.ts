// Signatures the relay asks for: NEP-413, addressed to the relay, naming the action, the job and a hash
// of the exact texts. A worker with a scoped key signs with it; a custody wallet signs through its API.
import { createHash } from "node:crypto";
import { KeyPair } from "near-api-js";
import { RELAY_RECIPIENT } from "./custody.ts";

const sha256 = (text: string | Buffer) =>
  createHash("sha256").update(text).digest();

export function relayPayload(request: Record<string, unknown>): string {
  const text =
    request.action === "challenge"
      ? `${String(request.check)}\0${String(request.reference)}`
      : request.action === "deliver"
        ? String(request.deliverable)
        : request.action === "cleanup"
          ? String(request.kind)
          : "";
  return sha256(text).toString("hex");
}

export const relayMessage = (request: Record<string, unknown>) =>
  `proven-relay:${String(request.action)}:${String(request.job_id)}:${relayPayload(request)}:${Date.now()}`;

const borsh = (text: string) => {
  const bytes = Buffer.from(text);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};

export function signWithKey(key: string, message: string) {
  const pair = KeyPair.fromString(key as `ed25519:${string}`);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061);
  const digest = sha256(
    Buffer.concat([
      tag,
      borsh(message),
      Buffer.from(nonce),
      borsh(RELAY_RECIPIENT),
      Buffer.from([0]),
    ]),
  );
  return {
    public_key: pair.getPublicKey().toString(),
    signature_base64: Buffer.from(pair.sign(digest).signature).toString(
      "base64",
    ),
    nonce_base64: Buffer.from(nonce).toString("base64"),
  };
}
