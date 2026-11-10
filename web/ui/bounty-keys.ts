// The bytes a PR bounty key proof covers, built in the browser exactly as the bounty contract
// builds them (contracts/pr-bounty/src/keys.rs): ed25519 key parsing, the posting terms digest,
// the key pair digest, both key-proof messages, the claim challenge (v3), the NEP-413 payload
// and hash, a local ed25519 check of a returned signature, and the NEP-616 vault address.
// Checked against web/test-fixtures/pr-bounty-vectors.json, which the contract's code generates.
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

export const NEP413_TAG = 2_147_484_061;
/** The longest a key proof may stay valid (OD-8), in seconds. */
export const KEY_PROOF_TTL_SECS = 60 * 60;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encoder = new TextEncoder();

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(text: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) throw new Error("Not lowercase hex.");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function fromBase58(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("Not base58.");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** The 32 bytes of an `ed25519:<base58>` public key; refuses any other curve or length. */
export function ed25519Key(text: string): Uint8Array {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(text.trim());
  if (!match) throw new Error("Use an ed25519 public key (ed25519:…).");
  const bytes = fromBase58(match[1] as string);
  if (bytes.length !== 32) throw new Error("An ed25519 key has 32 bytes.");
  return bytes;
}

export const keyText = (bytes: Uint8Array) => `ed25519:${base58(bytes)}`;

export interface KeyPair {
  primary: string;
  backup: string;
}

export interface PostTerms {
  reward: string;
  repo: string;
  repo_id: string;
  issue: number;
  base_ref: string;
  contributor_github_id: string;
  claim_by: string;
  bind_by: string;
  merge_deadline: string;
  grace_secs: string;
}

export type Signing = "primary" | "backup";

class Bytes {
  parts: number[] = [];
  raw(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  str(s: string | Uint8Array) {
    const b = typeof s === "string" ? encoder.encode(s) : s;
    return this.u32(b.length).raw(b);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return this.raw(b);
  }
  u64(v: bigint | string | number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    return this.raw(b);
  }
  u128(v: bigint | string) {
    const n = BigInt(v);
    return this.u64(n & 0xffff_ffff_ffff_ffffn).u64(n >> 64n);
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

/** The NEP-413 payload: tag, then borsh of message, 32-byte nonce, recipient and no URL. */
export function nep413Payload(
  message: string,
  nonce: Uint8Array,
  recipient: string,
): Uint8Array {
  if (nonce.length !== 32) throw new Error("A NEP-413 nonce has 32 bytes.");
  return new Bytes()
    .u32(NEP413_TAG)
    .str(message)
    .raw(nonce)
    .str(recipient)
    .raw(Uint8Array.of(0))
    .done();
}

export const nep413Hash = (
  message: string,
  nonce: Uint8Array,
  recipient: string,
) => sha256(nep413Payload(message, nonce, recipient));

/** A key proof's NEP-413 nonce: the SHA-256 of its message. */
export const keyProofNonce = (message: string) =>
  sha256(encoder.encode(message));

/** The hash a key proof signs: its recipient is the bounty contract. */
export const keyProofHash = (message: string, contract: string) =>
  nep413Hash(message, keyProofNonce(message), contract);

export function termsBytes(
  network: string,
  contract: string,
  maintainer: string,
  nonce: Uint8Array,
  terms: PostTerms,
  keys: KeyPair,
): Uint8Array {
  return new Bytes()
    .str("proven-pr-bounty-terms:v1")
    .str(network)
    .str(contract)
    .str(maintainer)
    .raw(nonce)
    .u128(terms.reward)
    .str(terms.repo)
    .u64(terms.repo_id)
    .u64(terms.issue)
    .str(terms.base_ref)
    .u64(terms.contributor_github_id)
    .u64(terms.claim_by)
    .u64(terms.bind_by)
    .u64(terms.merge_deadline)
    .u64(terms.grace_secs)
    .raw(ed25519Key(keys.primary))
    .raw(ed25519Key(keys.backup))
    .done();
}

export const termsDigest = (
  network: string,
  contract: string,
  maintainer: string,
  nonce: Uint8Array,
  terms: PostTerms,
  keys: KeyPair,
) => hex(sha256(termsBytes(network, contract, maintainer, nonce, terms, keys)));

const PROOF_TAIL = "Either key alone can withdraw everything in the vault.";

export function postingMessage(
  network: string,
  contract: string,
  maintainer: string,
  nonce: Uint8Array,
  terms: PostTerms,
  keys: KeyPair,
  expiresAt: number | string,
  signing: Signing,
): string {
  return [
    "Proven PR bounty key proof v1",
    "role: maintainer",
    `network: ${network}`,
    `contract: ${contract}`,
    `actor: ${maintainer}`,
    `nonce: ${hex(nonce)}`,
    `terms: ${termsDigest(network, contract, maintainer, nonce, terms, keys)}`,
    `reward_yocto: ${BigInt(terms.reward)}`,
    `issue: ${terms.repo}#${terms.issue}`,
    `signing: ${signing}`,
    `primary: ${keys.primary}`,
    `backup: ${keys.backup}`,
    `expires_at: ${expiresAt}`,
    PROOF_TAIL,
  ].join("\n");
}

export function claimMessage(
  network: string,
  contract: string,
  wallet: string,
  bounty: number,
  githubId: string,
  keys: KeyPair,
  expiresAt: number | string,
  signing: Signing,
): string {
  return [
    "Proven PR bounty key proof v1",
    "role: contributor",
    `network: ${network}`,
    `contract: ${contract}`,
    `actor: ${wallet}`,
    `bounty: ${bounty}`,
    `github_id: ${BigInt(githubId)}`,
    `signing: ${signing}`,
    `primary: ${keys.primary}`,
    `backup: ${keys.backup}`,
    `expires_at: ${expiresAt}`,
    PROOF_TAIL,
  ].join("\n");
}

export function keyPairDigest(keys: KeyPair): string {
  return hex(
    sha256(
      new Bytes()
        .str("proven-key-pair:v1")
        .raw(ed25519Key(keys.primary))
        .raw(ed25519Key(keys.backup))
        .done(),
    ),
  );
}

export interface ClaimBinding {
  network: string;
  contract: string;
  bounty: number;
  repo: string;
  repo_id: string;
  issue: number;
  wallet: string;
  github_id: string;
  expires_at: number | string;
}

/** Challenge v3: the text the contributor's gist holds. */
export function challenge(c: ClaimBinding, keys: KeyPair): string {
  const text = [
    "proven-pr-bounty-claim:v3",
    c.network,
    c.contract,
    c.bounty,
    c.repo,
    BigInt(c.repo_id),
    c.issue,
    c.wallet,
    BigInt(c.github_id),
    c.expires_at,
    keyPairDigest(keys),
  ].join("|");
  return `proven-claim:${hex(sha256(encoder.encode(text)))}`;
}

/** Checks an ed25519 signature over a NEP-413 hash. Never throws. */
export function verifies(
  signature: Uint8Array,
  hash: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, hash, publicKey);
  } catch {
    return false;
  }
}

/** A wallet's signature in base64, or `ed25519:<base58>`, as 64 bytes. */
export function signatureBytes(text: string): Uint8Array {
  const t = text.trim();
  let bytes: Uint8Array;
  if (t.startsWith("ed25519:")) bytes = fromBase58(t.slice(8));
  else if (/^[0-9a-f]{128}$/.test(t)) bytes = fromHex(t);
  else {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) throw new Error("Not a signature.");
    bytes = Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  }
  if (bytes.length !== 64) throw new Error("A signature has 64 bytes.");
  return bytes;
}

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** NEP-616: the vault account of a key pair, its code pinned by hash. */
export function vaultAddress(codeHash: Uint8Array, keys: KeyPair): string {
  if (codeHash.length !== 32) throw new Error("A code hash has 32 bytes.");
  const key = (text: string) => Uint8Array.from([0, ...ed25519Key(text)]);
  const zero = (n: number) => new Uint8Array(n);
  const entries: [string, Uint8Array][] = [
    ["b", key(keys.backup)],
    ["f", zero(16)],
    ["k", key(keys.primary)],
    ["n", zero(8)],
  ];
  const b = new Bytes()
    .raw(Uint8Array.of(0, 0))
    .raw(codeHash)
    .u32(entries.length);
  for (const [k, v] of entries) b.str(k).str(v);
  return `0s${hex(keccak_256(b.done()).slice(12))}`;
}
