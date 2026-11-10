// The page's key-proof, terms, challenge, vault-address and withdrawal bytes against vectors the
// contract's and the vault's own code generated (contracts/pr-bounty/tests/vectors.rs). No network
// and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  base58,
  challenge,
  claimMessage,
  ed25519Key,
  fromBase58,
  fromHex,
  hex,
  keyPairDigest,
  keyProofHash,
  keyText,
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
  primary: string;
  backup: string;
  network: string;
  contract: string;
  maintainer: string;
  wallet: string;
  nonce: string;
  expires_at: string;
  bounty: number;
  github_id: string;
  terms: PostTerms;
  terms_digest: string;
  key_pair_digest: string;
  posting_message_primary: string;
  posting_message_backup: string;
  posting_hash_primary: string;
  posting_hash_backup: string;
  claim_message_primary: string;
  claim_message_backup: string;
  claim_hash_primary: string;
  claim_hash_backup: string;
  challenge: string;
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

test("there are vectors to check", () => {
  assert.ok(vectors.cases.length >= 50);
});

test("terms digests, key pair digests and both key-proof messages match the contract", () => {
  for (const c of vectors.cases) {
    const keys = { primary: c.primary, backup: c.backup };
    const nonce = fromHex(c.nonce);
    assert.equal(
      termsDigest(c.network, c.contract, c.maintainer, nonce, c.terms, keys),
      c.terms_digest,
    );
    assert.equal(keyPairDigest(keys), c.key_pair_digest);
    for (const signing of ["primary", "backup"] as const) {
      const posting = postingMessage(
        c.network,
        c.contract,
        c.maintainer,
        nonce,
        c.terms,
        keys,
        c.expires_at,
        signing,
      );
      assert.equal(posting, c[`posting_message_${signing}`]);
      assert.equal(
        hex(keyProofHash(posting, c.contract)),
        c[`posting_hash_${signing}`],
      );
      const claim = claimMessage(
        c.network,
        c.contract,
        c.wallet,
        c.bounty,
        c.github_id,
        keys,
        c.expires_at,
        signing,
      );
      assert.equal(claim, c[`claim_message_${signing}`]);
      assert.equal(
        hex(keyProofHash(claim, c.contract)),
        c[`claim_hash_${signing}`],
      );
    }
  }
});

test("claim challenges and vault addresses match the contract", () => {
  for (const c of vectors.cases) {
    const keys = { primary: c.primary, backup: c.backup };
    assert.equal(
      challenge(
        {
          network: c.network,
          contract: c.contract,
          bounty: c.bounty,
          repo: c.terms.repo,
          repo_id: c.terms.repo_id,
          issue: c.terms.issue,
          wallet: c.wallet,
          github_id: c.github_id,
          expires_at: c.expires_at,
        },
        keys,
      ),
      c.challenge,
    );
    assert.equal(vaultAddress(code, keys), c.vault);
    assert.notEqual(
      vaultAddress(code, { primary: c.backup, backup: c.primary }),
      c.vault,
      "the key order matters",
    );
  }
});

test("withdrawal messages, nonces, hashes and JSON arguments match the vault", () => {
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

test("every field a proof or a withdrawal covers changes its hash", () => {
  const c = vectors.cases[0] as Case;
  const keys = { primary: c.primary, backup: c.backup };
  const nonce = fromHex(c.nonce);
  const base = termsDigest(
    c.network,
    c.contract,
    c.maintainer,
    nonce,
    c.terms,
    keys,
  );
  const changed: Partial<PostTerms>[] = [
    { reward: (BigInt(c.terms.reward) + 1n).toString() },
    { repo: "proven-test/other" },
    { repo_id: (BigInt(c.terms.repo_id) + 1n).toString() },
    { issue: c.terms.issue + 1 },
    { base_ref: "dev" },
    {
      contributor_github_id: (
        BigInt(c.terms.contributor_github_id) + 1n
      ).toString(),
    },
    { claim_by: (BigInt(c.terms.claim_by) + 1n).toString() },
    { bind_by: (BigInt(c.terms.bind_by) + 1n).toString() },
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
        keys,
      ),
      base,
      JSON.stringify(change),
    );
  const flipped = Uint8Array.from(nonce);
  flipped[0] = (flipped[0] as number) ^ 1;
  for (const variant of [
    termsDigest("mainnet", c.contract, c.maintainer, nonce, c.terms, keys),
    termsDigest(c.network, "other.testnet", c.maintainer, nonce, c.terms, keys),
    termsDigest(c.network, c.contract, "other.testnet", nonce, c.terms, keys),
    termsDigest(c.network, c.contract, c.maintainer, flipped, c.terms, keys),
    termsDigest(c.network, c.contract, c.maintainer, nonce, c.terms, {
      primary: c.backup,
      backup: c.primary,
    }),
  ])
    assert.notEqual(variant, base);
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

test("signatures verify locally only for the right key, message and recipient", () => {
  const c = vectors.cases[1] as Case;
  const secret = new Uint8Array(32).fill(7);
  const publicKey = keyText(ed25519.getPublicKey(secret));
  const keys = { primary: publicKey, backup: c.backup };
  const message = claimMessage(
    c.network,
    c.contract,
    c.wallet,
    c.bounty,
    c.github_id,
    keys,
    c.expires_at,
    "primary",
  );
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
  assert.ok(!verifies(sig, hash, ed25519Key(c.backup)));
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
  assert.equal(keyText(ed25519Key(c.primary)), c.primary);
  assert.deepEqual(
    fromBase58(base58(new Uint8Array([0, 0, 1, 2]))),
    new Uint8Array([0, 0, 1, 2]),
  );
  for (const bad of [
    c.primary.replace("ed25519:", "secp256k1:"),
    "ed25519:",
    c.primary.slice(0, 20),
    `ed25519:${base58(new Uint8Array(33).fill(1))}`,
  ])
    assert.throws(() => ed25519Key(bad), bad);
});
