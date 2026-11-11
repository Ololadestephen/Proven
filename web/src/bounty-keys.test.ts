// The page's withdrawal-key proof, terms, link challenge, vault-address and withdrawal bytes
// against vectors the contract's and the vault's own code generated
// (contracts/pr-bounty/tests/vectors.rs). No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  base58,
  claimMessage,
  ed25519Key,
  fromBase58,
  fromHex,
  hex,
  keyProofHash,
  keyText,
  linkChallenge,
  postingMessage,
  signatureBytes,
  termsDigest,
  vaultAddress,
  verifies,
  type PostTerms,
} from "../ui/bounty-keys.ts";
import {
  withdrawArgs,
  withdrawHash,
  withdrawMessage,
  withdrawNonce,
} from "../ui/vault-client.ts";

interface Case {
  key: string;
  network: string;
  contract: string;
  maintainer: string;
  wallet: string;
  nonce: string;
  expires_at: string;
  bounty: number;
  github_id: string;
  link_number: number;
  terms: PostTerms;
  terms_digest: string;
  posting_message: string;
  posting_hash: string;
  claim_message: string;
  claim_hash: string;
  link_challenge: string;
  vault: string;
  withdrawal: {
    chain: string;
    vault: string;
    to: string;
    amount: string;
    n: string;
    deadline: string;
    message: string;
    nonce: string;
    hash: string;
    args: string;
  };
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/pr-bounty-vectors.json", import.meta.url),
    "utf8",
  ),
) as { vault_code_hash_hex: string; cases: Case[] };
const code = fromHex(vectors.vault_code_hash_hex);
const posting = (c: Case, over: Partial<Case> = {}) => {
  const d = { ...c, ...over };
  return postingMessage(
    d.network,
    d.contract,
    d.maintainer,
    fromHex(d.nonce),
    d.terms,
    d.key,
    d.expires_at,
  );
};
const claim = (c: Case, over: Partial<Case> = {}) => {
  const d = { ...c, ...over };
  return claimMessage(
    d.network,
    d.contract,
    d.wallet,
    d.bounty,
    d.github_id,
    d.key,
    d.expires_at,
  );
};

test("there are vectors to check, with the single withdrawal key", () => {
  assert.ok(vectors.cases.length >= 50);
  for (const c of vectors.cases) {
    assert.match(c.key, /^ed25519:/);
    assert.ok(!("primary" in c) && !("backup" in c));
  }
});

test("terms digests match the contract in every case", () => {
  for (const c of vectors.cases)
    assert.equal(
      termsDigest(
        c.network,
        c.contract,
        c.maintainer,
        fromHex(c.nonce),
        c.terms,
        c.key,
      ),
      c.terms_digest,
    );
});

test("posting and claim messages and their NEP-413 hashes match the contract in every case", () => {
  for (const c of vectors.cases) {
    const post = posting(c);
    assert.equal(post, c.posting_message);
    assert.equal(hex(keyProofHash(post, c.contract)), c.posting_hash);
    const claimed = claim(c);
    assert.equal(claimed, c.claim_message);
    assert.equal(hex(keyProofHash(claimed, c.contract)), c.claim_hash);
    assert.notEqual(c.posting_hash, c.claim_hash);
  }
});

test("link challenges match the contract in every case", () => {
  for (const c of vectors.cases)
    assert.equal(
      linkChallenge(
        c.network,
        c.contract,
        c.wallet,
        c.link_number,
        c.expires_at,
      ),
      c.link_challenge,
    );
});

test("vault addresses match the contract in every case", () => {
  const seen = new Set<string>();
  for (const c of vectors.cases) {
    assert.equal(vaultAddress(code, c.key), c.vault);
    assert.equal(c.withdrawal.vault, c.vault);
    seen.add(c.vault);
  }
  assert.equal(seen.size, vectors.cases.length, "one vault per key");
  const c = vectors.cases[0] as Case;
  assert.notEqual(
    vaultAddress(fromHex("31".repeat(32)), c.key),
    c.vault,
    "the code hash matters",
  );
  assert.throws(() => vaultAddress(new Uint8Array(31), c.key));
});

test("withdrawal messages, nonces, hashes and JSON arguments match the vault in every case", () => {
  for (const c of vectors.cases) {
    const v = c.withdrawal;
    const w = {
      chain: v.chain,
      vault: v.vault,
      to: v.to,
      amount: BigInt(v.amount),
      n: BigInt(v.n),
      deadline: Number(v.deadline),
    };
    assert.equal(withdrawMessage(w), v.message);
    assert.equal(hex(withdrawNonce(w.n)), v.nonce);
    assert.equal(hex(withdrawHash(w)), v.hash);
    assert.equal(withdrawArgs(w, new Uint8Array(64).fill(0x5a)), v.args);
  }
});

test("every field a proof covers changes the proof text or its hash", () => {
  const c = vectors.cases[0] as Case;
  const nonce = fromHex(c.nonce);
  const base = termsDigest(
    c.network,
    c.contract,
    c.maintainer,
    nonce,
    c.terms,
    c.key,
  );
  const changed: Partial<PostTerms>[] = [
    { reward: (BigInt(c.terms.reward) + 1n).toString() },
    { repo: "proven-test/other" },
    { repo_id: (BigInt(c.terms.repo_id) + 1n).toString() },
    { issue: c.terms.issue + 1 },
    { base_ref: "dev" },
    { claim_by: (BigInt(c.terms.claim_by) + 1n).toString() },
    { claim_secs: (BigInt(c.terms.claim_secs) + 1n).toString() },
    { merge_deadline: (BigInt(c.terms.merge_deadline) + 1n).toString() },
    { grace_secs: (BigInt(c.terms.grace_secs) + 1n).toString() },
  ];
  for (const change of changed)
    assert.notEqual(
      termsDigest(
        c.network,
        c.contract,
        c.maintainer,
        nonce,
        { ...c.terms, ...change },
        c.key,
      ),
      base,
      JSON.stringify(change),
    );
  const flipped = Uint8Array.from(nonce);
  flipped[0] = (flipped[0] as number) ^ 1;
  const other = (vectors.cases[1] as Case).key;
  for (const variant of [
    termsDigest("mainnet", c.contract, c.maintainer, nonce, c.terms, c.key),
    termsDigest(
      c.network,
      "other.testnet",
      c.maintainer,
      nonce,
      c.terms,
      c.key,
    ),
    termsDigest(c.network, c.contract, "other.testnet", nonce, c.terms, c.key),
    termsDigest(c.network, c.contract, c.maintainer, flipped, c.terms, c.key),
    termsDigest(c.network, c.contract, c.maintainer, nonce, c.terms, other),
  ])
    assert.notEqual(variant, base);
  // The proof texts name the actor, the key, the expiry and the bounty or terms.
  assert.notEqual(
    posting(c, { maintainer: "other.testnet" }),
    c.posting_message,
  );
  assert.notEqual(posting(c, { key: other }), c.posting_message);
  assert.notEqual(posting(c, { expires_at: "1" }), c.posting_message);
  assert.notEqual(claim(c, { wallet: "other.testnet" }), c.claim_message);
  assert.notEqual(claim(c, { bounty: c.bounty + 1 }), c.claim_message);
  assert.notEqual(claim(c, { github_id: "1" }), c.claim_message);
  assert.notEqual(claim(c, { key: other }), c.claim_message);
  assert.notEqual(claim(c, { expires_at: "1" }), c.claim_message);
  // The link challenge names the wallet, the link number and the expiry.
  const link = (over: Partial<Record<string, string | number>> = {}) =>
    linkChallenge(
      c.network,
      c.contract,
      String(over.wallet ?? c.wallet),
      over.link_number ?? c.link_number,
      over.expires_at ?? c.expires_at,
    );
  assert.equal(link(), c.link_challenge);
  assert.notEqual(link({ wallet: "other.testnet" }), c.link_challenge);
  assert.notEqual(link({ link_number: c.link_number + 1 }), c.link_challenge);
  assert.notEqual(link({ expires_at: "1" }), c.link_challenge);
  assert.match(c.link_challenge, /^proven-link:[0-9a-f]{64}$/);
  // A withdrawal covers the chain, vault, destination, amount, number and deadline.
  const v = c.withdrawal;
  const w = {
    chain: v.chain,
    vault: v.vault,
    to: v.to,
    amount: BigInt(v.amount),
    n: BigInt(v.n),
    deadline: Number(v.deadline),
  };
  const h = hex(withdrawHash(w));
  for (const change of [
    { chain: "mainnet" },
    { vault: `0s${"1".repeat(40)}` },
    { to: "someone-else.testnet" },
    { amount: w.amount + 1n },
    { n: w.n + 1n },
    { deadline: w.deadline + 1 },
  ])
    assert.notEqual(
      hex(withdrawHash({ ...w, ...change })),
      h,
      JSON.stringify(change, (_, x) =>
        typeof x === "bigint" ? x.toString() : x,
      ),
    );
});

test("a malformed key, nonce or amount is refused instead of producing a message", () => {
  const c = vectors.cases[0] as Case;
  assert.throws(() => posting(c, { key: "secp256k1:abc" }));
  assert.throws(() => claim(c, { key: "ed25519:short" }));
  assert.throws(() =>
    termsDigest(
      c.network,
      c.contract,
      c.maintainer,
      new Uint8Array(31),
      c.terms,
      c.key,
    ),
  );
  assert.throws(() => claim(c, { github_id: "not a number" }));
});

test("signatures verify locally only for the right key, message and recipient", () => {
  const c = vectors.cases[1] as Case;
  const secret = new Uint8Array(32).fill(7);
  const publicKey = keyText(ed25519.getPublicKey(secret));
  const message = claim(c, { key: publicKey });
  const hash = keyProofHash(message, c.contract);
  const sig = ed25519.sign(hash, secret);
  assert.ok(verifies(sig, hash, ed25519Key(publicKey)));
  assert.ok(
    !verifies(
      sig,
      keyProofHash(message, "other.testnet"),
      ed25519Key(publicKey),
    ),
  );
  assert.ok(
    !verifies(
      sig,
      keyProofHash(message + " ", c.contract),
      ed25519Key(publicKey),
    ),
  );
  assert.ok(!verifies(sig, hash, ed25519Key(c.key)));
  assert.ok(!verifies(sig.slice(1), hash, ed25519Key(publicKey)));
  // The wallet's base64, a base58 `ed25519:` form and hex all read as the same 64 bytes.
  const b64 = Buffer.from(sig).toString("base64");
  assert.deepEqual(signatureBytes(b64), sig);
  assert.deepEqual(signatureBytes(`ed25519:${base58(sig)}`), sig);
  assert.deepEqual(signatureBytes(hex(sig)), sig);
  assert.throws(() =>
    signatureBytes(Buffer.from(sig.slice(1)).toString("base64")),
  );
});

test("only ed25519 public keys are accepted", () => {
  const c = vectors.cases[2] as Case;
  assert.equal(keyText(ed25519Key(c.key)), c.key);
  assert.deepEqual(
    fromBase58(base58(new Uint8Array([0, 0, 1, 2]))),
    new Uint8Array([0, 0, 1, 2]),
  );
  for (const bad of [
    c.key.replace("ed25519:", "secp256k1:"),
    "ed25519:",
    c.key.slice(0, 20),
    `ed25519:${base58(new Uint8Array(33).fill(1))}`,
  ])
    assert.throws(() => ed25519Key(bad), bad);
});
