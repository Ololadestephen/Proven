// Who may ask the relay to do something: a NEP-413 signature, addressed to this relay, naming the action,
// the job and a hash of the exact texts, by a key belonging to the right account. The relay checks the
// key against the chain. Once the relay faces the internet, this is what stops strangers using it.
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

/** The recipient the buyer's wallet policy allows it to sign for, and nothing else. */
export const RELAY_RECIPIENT = "proven-relay";
const NEP413_TAG = 2147484061;
const MAX_AGE_MS = 300_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface RelayAuth {
  public_key: string;
  signature_base64: string;
  nonce_base64: string;
  message: string;
}

export function base58Decode(text: string): Buffer {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error("not base58");
    value = value * 58n + BigInt(digit);
  }
  const hex = value === 0n ? "" : value.toString(16);
  const bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}

const borshString = (text: string) => {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** The bytes a NEP-413 signature covers. */
export function nep413Digest(
  message: string,
  nonce: Buffer,
  recipient: string,
): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  return createHash("sha256")
    .update(
      Buffer.concat([
        tag,
        borshString(message),
        nonce,
        borshString(recipient),
        Buffer.from([0]), // No callback URL.
      ]),
    )
    .digest();
}

/** Binds a signature to the exact texts, so a signed request cannot carry different ones. */
export function relayPayload(request: Record<string, unknown>): string {
  const text =
    request.action === "challenge"
      ? `${String(request.check)}\0${String(request.reference)}`
      : request.action === "deliver"
        ? String(request.deliverable)
        : request.action === "cleanup"
          ? String(request.kind)
          : "";
  return createHash("sha256").update(text).digest("hex");
}

export const relayMessage = (
  action: string,
  id: number,
  payload: string,
  atMs: number,
) => `proven-relay:${action}:${id}:${payload}:${atMs}`;

/** An implicit account's id is its key. A named account's key must be on chain. */
export async function keyBelongsTo(
  account: string,
  publicKey: Buffer,
  isAccessKey: (account: string, publicKey: string) => Promise<boolean>,
  encoded: string,
): Promise<boolean> {
  if (account === publicKey.toString("hex")) return true;
  return isAccessKey(account, encoded);
}

/** Checks a signature for one action. Used nonces are remembered until they are too old. */
export class RelayVerifier {
  private readonly used = new Map<string, number>();
  private readonly isAccessKey: (
    account: string,
    publicKey: string,
  ) => Promise<boolean>;
  private readonly now: () => number;
  constructor(
    isAccessKey: (account: string, publicKey: string) => Promise<boolean>,
    now: () => number = Date.now,
  ) {
    this.isAccessKey = isAccessKey;
    this.now = now;
  }

  async verify(
    auth: RelayAuth | undefined,
    allowed: string[],
    action: string,
    id: number,
    payload: string,
  ): Promise<boolean> {
    if (!auth || typeof auth.message !== "string") return false;
    const parts = /^proven-relay:([a-z_]+):(\d+):([a-f0-9]{64}):(\d+)$/.exec(
      auth.message,
    );
    if (
      !parts ||
      parts[1] !== action ||
      Number(parts[2]) !== id ||
      parts[3] !== payload
    )
      return false;
    const now = this.now();
    if (Math.abs(now - Number(parts[4])) > MAX_AGE_MS) return false;
    if (!String(auth.public_key).startsWith("ed25519:")) return false;
    let key: Buffer;
    let nonce: Buffer;
    let signature: Buffer;
    try {
      key = base58Decode(auth.public_key.slice("ed25519:".length));
      nonce = Buffer.from(auth.nonce_base64, "base64");
      signature = Buffer.from(auth.signature_base64, "base64");
    } catch {
      return false;
    }
    if (key.length !== 32 || nonce.length !== 32 || signature.length !== 64)
      return false;
    const signed = verifySignature(
      null,
      nep413Digest(auth.message, nonce, RELAY_RECIPIENT),
      createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
        format: "der",
        type: "spki",
      }),
      signature,
    );
    if (!signed) return false;
    let belongs = false;
    for (const account of allowed)
      if (await keyBelongsTo(account, key, this.isAccessKey, auth.public_key))
        belongs = true;
    if (!belongs) return false;
    for (const [seen, time] of this.used)
      if (now - time > 2 * MAX_AGE_MS) this.used.delete(seen);
    if (this.used.has(auth.nonce_base64)) return false;
    this.used.set(auth.nonce_base64, now);
    return true;
  }
}
