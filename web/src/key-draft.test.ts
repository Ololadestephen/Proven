// Both keys signing through browser wallets: the primary account prepares the proofs, the
// backup key's account signs its proof from a draft kept in this browser, and the primary account
// picks it up. Also what a posting attaches, from the contract's recorded configuration.
// No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  base64,
  claimMessage,
  keyProofHash,
  keyText,
} from "../ui/bounty-keys.ts";
import {
  initialKeyState,
  keyReducer,
  submitCheck,
  type KeyConfirmState,
} from "../ui/key-confirm-state.ts";
import {
  addCandidate,
  backupProofsToSign,
  clearDraft,
  listDrafts,
  loadCandidates,
  loadDraft,
  saveDraft,
  withStoredProofs,
  type KeyDraft,
} from "../ui/key-draft.ts";
import { postingAttachment } from "../ui/bounty-costs.ts";

const CONTRACT = "pr-bounty.proven-funding.testnet";
const PRIMARY_ACCOUNT = "proven-fund-a.testnet";
const BACKUP_ACCOUNT = "backup.proven-fund-a.testnet";
const secret = (n: number) => new Uint8Array(32).fill(n);
const pub = (n: number) => keyText(ed25519.getPublicKey(secret(n)));

function memoryStore() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const texts = (s: KeyConfirmState) => ({
  primary: claimMessage(
    "testnet",
    CONTRACT,
    s.actor as string,
    3,
    "900000001",
    { primary: s.primary as string, backup: s.backup as string },
    s.expiresAt as number,
    "primary",
  ),
  backup: claimMessage(
    "testnet",
    CONTRACT,
    s.actor as string,
    3,
    "900000001",
    { primary: s.primary as string, backup: s.backup as string },
    s.expiresAt as number,
    "backup",
  ),
});
const signed = (
  message: string,
  key: number,
  signing: "primary" | "backup",
) => ({
  type: "signed" as const,
  signing,
  publicKey: pub(key),
  signature: base64(ed25519.sign(keyProofHash(message, CONTRACT), secret(key))),
  message,
  contract: CONTRACT,
});
const draftOf = (state: KeyConfirmState): KeyDraft => ({
  contract: CONTRACT,
  scope: "claim:3",
  role: "contributor",
  state,
  messages: state.actor ? texts(state) : null,
  frozen: null,
});

test("the backup key's account signs its proof in this browser, and the primary account picks it up", () => {
  const store = memoryStore();
  const now = 1_000;
  // The backup account offers its key.
  addCandidate(store, CONTRACT, { account: BACKUP_ACCOUNT, key: pub(2) });
  assert.deepEqual(loadCandidates(store, CONTRACT), [
    { account: BACKUP_ACCOUNT, key: pub(2) },
  ]);
  // The primary account prepares and signs its own proof.
  let primary = [
    { type: "primary" as const, key: pub(1) },
    { type: "backup" as const, key: pub(2) },
    { type: "start" as const, actor: PRIMARY_ACCOUNT, expiresAt: 2_000 },
  ].reduce(keyReducer, initialKeyState);
  primary = keyReducer(primary, signed(texts(primary).primary, 1, "primary"));
  saveDraft(store, draftOf(primary));
  // The primary account itself is not offered its own draft; the backup account is.
  assert.equal(
    backupProofsToSign(listDrafts(store, CONTRACT, now), PRIMARY_ACCOUNT)
      .length,
    0,
  );
  const open = backupProofsToSign(
    listDrafts(store, CONTRACT, now),
    BACKUP_ACCOUNT,
  );
  assert.equal(open.length, 1);
  const d = open[0] as KeyDraft;
  // A key that is not the named backup key is refused and nothing is stored.
  const wrong = keyReducer(d.state, signed(d.messages!.backup, 3, "backup"));
  assert.equal(wrong.proofs.backup, undefined);
  // The backup key signs exactly the stored text.
  const withBackup = keyReducer(
    d.state,
    signed(d.messages!.backup, 2, "backup"),
  );
  assert.ok(withBackup.proofs.backup);
  saveDraft(store, { ...d, state: withBackup });
  // Back on the primary account: its page state gains the backup proof, and only for the same texts.
  const merged = withStoredProofs(
    primary,
    loadDraft(store, CONTRACT, "claim:3", now),
  );
  assert.ok(merged.proofs.primary && merged.proofs.backup);
  const ready = keyReducer(merged, { type: "separate", value: true });
  assert.deepEqual(submitCheck(ready, PRIMARY_ACCOUNT, now), { ok: true });
  const otherExpiry = { ...primary, expiresAt: 2_001 };
  assert.equal(
    withStoredProofs(otherExpiry, loadDraft(store, CONTRACT, "claim:3", now)),
    otherExpiry,
  );
  const otherBackup = { ...primary, backup: pub(4) };
  assert.equal(
    withStoredProofs(otherBackup, loadDraft(store, CONTRACT, "claim:3", now)),
    otherBackup,
  );
  // Done: the draft is cleared, and expired drafts are never offered.
  clearDraft(store, CONTRACT, "claim:3");
  assert.equal(loadDraft(store, CONTRACT, "claim:3", now), null);
  saveDraft(store, draftOf(primary));
  assert.equal(
    listDrafts(store, CONTRACT, 2_000).length,
    0,
    "expired at 2,000",
  );
  assert.equal(loadDraft(store, CONTRACT, "claim:3", 2_000), null);
});

test("stored drafts never hold anything but public keys, signatures and texts", () => {
  const store = memoryStore();
  let s = [
    { type: "primary" as const, key: pub(1) },
    { type: "backup" as const, key: pub(2) },
    { type: "start" as const, actor: PRIMARY_ACCOUNT, expiresAt: 2_000 },
  ].reduce(keyReducer, initialKeyState);
  s = keyReducer(s, signed(texts(s).primary, 1, "primary"));
  saveDraft(store, draftOf(s));
  const raw = store.getItem(`proven:key-draft:${CONTRACT}:claim:3`) ?? "";
  for (const n of [1, 2]) {
    const hexSecret = Buffer.from(secret(n)).toString("hex");
    assert.ok(
      !raw.includes(hexSecret) &&
        !raw.includes(Buffer.from(secret(n)).toString("base64")),
    );
  }
  assert.ok(raw.includes(pub(1)) && raw.includes(pub(2)));
  // Malformed storage is ignored.
  store.setItem(`proven:key-draft:${CONTRACT}:claim:4`, "{not json");
  assert.equal(loadDraft(store, CONTRACT, "claim:4", 0), null);
  assert.equal(listDrafts(store, CONTRACT, 0).length, 1);
});

test("a posting attaches the reward, the budget and the contract's 0.029 NEAR storage deposit", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../test-fixtures/sandbox/config.json", import.meta.url),
      "utf8",
    ),
  ) as { budget: string; storage_deposit: string };
  assert.equal(config.storage_deposit, "29000000000000000000000");
  const reward = 50_000_000_000_000_000_000_000n;
  assert.deepEqual(postingAttachment(config, reward), {
    reward,
    budget: 30_000_000_000_000_000_000_000n,
    storage: 29_000_000_000_000_000_000_000n,
    total: 109_000_000_000_000_000_000_000n,
  });
});
