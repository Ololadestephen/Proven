// The PR bounty page's call builders, pull request parsing, link outcomes and status rules.
// No network, no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  GAS,
  LINK_DEPOSIT,
  RUN_DEPOSIT,
  STORAGE_DEPOSIT,
  FlowError,
  activateLinkCall,
  cancelCall,
  cancelLinkChangeCall,
  checkMergeCall,
  claimCall,
  confirmLinkChangeCall,
  expireClaimCall,
  linkCall,
  linkChangeRoles,
  linkOutcomeOf,
  linkOutcomeStoresNothing,
  linkOutcomeText,
  parsePullRequestInput,
  postBountyCall,
  postTerms,
  reconcileCall,
  recoverSettlementCall,
  releaseClaimCall,
  revokeClaimCall,
  sendDueCall,
  settleCall,
  submitPrCall,
  withdrawCall,
} from "../ui/bounty-actions.ts";
import { base64, keyText } from "../ui/bounty-keys.ts";
import {
  ADVANCED_DEFAULTS,
  PREVIEW_FEES,
  reviewPosting,
  type Review,
} from "../ui/posting-review.ts";
import type { Withdrawal } from "../ui/vault-client.ts";
import { sendWithdrawal } from "../ui/vault-client.ts";

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;
const TGAS = 10n ** 12n;
const CONTRACT = "pr-bounty.proven-funding.testnet";
const KEY = keyText(ed25519.getPublicKey(new Uint8Array(32).fill(2)));
const NONCE = "ab".repeat(32);
const SIGNATURE = base64(new Uint8Array(64).fill(7));
const review = (): Review => {
  const out = reviewPosting({
    meta: {
      repo: "Ololadestephen/flop",
      repo_id: 1346702196,
      issue: 1,
      title: "Pilot A",
      html_url: "https://github.com/Ololadestephen/flop/issues/1",
      default_branch: "main",
    },
    rewardText: "0.1",
    advanced: ADVANCED_DEFAULTS,
    limits: { max_reward: 2n * NEAR, room: 5n * NEAR },
    pilot: { repo: "Ololadestephen/flop", repo_id: 1346702196 },
    fees: PREVIEW_FEES,
    now: 1_793_000_000,
  });
  assert.ok(out.ok);
  return out.review;
};

test("post_bounty carries the reviewed terms as the contract's JSON, and attaches reward plus 0.030 NEAR", () => {
  const r = review();
  const call = postBountyCall(CONTRACT, r, KEY, {
    nonce: NONCE,
    expires_at: "1793001800",
    signature: SIGNATURE,
  });
  assert.deepEqual(call, {
    receiver: CONTRACT,
    method: "post_bounty",
    args: {
      terms: {
        reward: "100000000000000000000000",
        repo: "Ololadestephen/flop",
        repo_id: "1346702196",
        // The contract's plain u64: a JSON number, not a string.
        issue: 1,
        base_ref: "main",
        claim_by: String(1_793_000_000 + 7 * 86400),
        claim_secs: String(48 * 3600),
        merge_deadline: String(1_793_000_000 + 14 * 86400),
        grace_secs: String(24 * 3600),
      },
      key: KEY,
      proof: {
        nonce: NONCE,
        expires_at: "1793001800",
        signature: SIGNATURE,
      },
    },
    deposit: 100n * MILLI + 30n * MILLI,
    gas: 100n * TGAS,
  });
  assert.equal(STORAGE_DEPOSIT, 30n * MILLI);
  assert.deepEqual(postTerms(r), call.args.terms);
});

test("post_bounty refuses a check reserve, a bad nonce and a signature that is not 64 bytes", () => {
  const r = review();
  const proof = { nonce: NONCE, expires_at: "1", signature: SIGNATURE };
  assert.throws(
    () =>
      postBountyCall(
        CONTRACT,
        { ...r, fees: { ...r.fees, check_reserve: 1n } },
        KEY,
        proof,
      ),
    /no check reserve/,
  );
  assert.throws(
    () => postBountyCall(CONTRACT, r, KEY, { ...proof, nonce: "xyz" }),
    FlowError,
  );
  assert.throws(
    () =>
      postBountyCall(CONTRACT, r, KEY, {
        ...proof,
        signature: base64(new Uint8Array(63)),
      }),
    /64 bytes/,
  );
  assert.throws(
    () => postBountyCall(CONTRACT, r, "ed25519:short", proof),
    /ed25519 public key/,
  );
});

test("link attaches exactly 0.017 NEAR (0.01 run and 0.007 storage) and 300 Tgas", () => {
  assert.equal(LINK_DEPOSIT, 17n * MILLI);
  assert.equal(RUN_DEPOSIT, 10n * MILLI);
  assert.deepEqual(linkCall(CONTRACT, "abcdef0123456789", 1793001800), {
    receiver: CONTRACT,
    method: "link",
    args: { gist_id: "abcdef0123456789", expires_at: "1793001800" },
    deposit: 17n * MILLI,
    gas: 300n * TGAS,
  });
});

test("claim, the claim endings, cancel and settlement calls have the contract's arguments and no deposit", () => {
  assert.deepEqual(
    claimCall(CONTRACT, 7, KEY, { expires_at: "9", signature: SIGNATURE }),
    {
      receiver: CONTRACT,
      method: "claim",
      args: {
        bounty_id: 7,
        key: KEY,
        proof: { expires_at: "9", signature: SIGNATURE },
      },
      deposit: 0n,
      gas: 30n * TGAS,
    },
  );
  for (const [build, method, gas] of [
    [releaseClaimCall, "release_claim", GAS.end],
    [revokeClaimCall, "revoke_claim", GAS.end],
    [expireClaimCall, "expire_claim", GAS.end],
    [cancelCall, "cancel", GAS.cancel],
    [settleCall, "settle", GAS.settle],
    [sendDueCall, "send_due", GAS.sendDue],
  ] as const)
    assert.deepEqual(build(CONTRACT, 7), {
      receiver: CONTRACT,
      method,
      args: { bounty_id: 7 },
      deposit: 0n,
      gas,
    });
  assert.deepEqual(recoverSettlementCall(CONTRACT, 7, "Payout"), {
    receiver: CONTRACT,
    method: "recover_settlement",
    args: { bounty_id: 7, kind: "Payout" },
    deposit: 0n,
    gas: GAS.recover,
  });
  assert.throws(() => cancelCall(CONTRACT, -1), /bounty number/);
  assert.throws(() => cancelCall(CONTRACT, 1.5), /bounty number/);
});

test("submit_pr, check_merge and reconcile attach 0.01 NEAR, and a sponsored check attaches nothing", () => {
  assert.deepEqual(submitPrCall(CONTRACT, 7, 42), {
    receiver: CONTRACT,
    method: "submit_pr",
    args: { bounty_id: 7, pr_number: 42 },
    deposit: 10n * MILLI,
    gas: 300n * TGAS,
  });
  assert.throws(() => submitPrCall(CONTRACT, 7, 0), /pull request number/);
  assert.throws(
    () => submitPrCall(CONTRACT, 7, 2 ** 32),
    /pull request number/,
  );
  assert.equal(checkMergeCall(CONTRACT, 7, false).deposit, 10n * MILLI);
  assert.equal(checkMergeCall(CONTRACT, 7, true).deposit, 0n);
  assert.equal(checkMergeCall(CONTRACT, 7, true).gas, 300n * TGAS);
  assert.deepEqual(reconcileCall(CONTRACT, 7, "Refund", 2), {
    receiver: CONTRACT,
    method: "reconcile",
    args: { bounty_id: 7, kind: "Refund", attempt: 2 },
    deposit: 10n * MILLI,
    gas: 100n * TGAS,
  });
});

test("link changes are single calls naming the wallet, with no deposit", () => {
  for (const [build, method] of [
    [activateLinkCall, "activate_link"],
    [confirmLinkChangeCall, "confirm_link_change"],
    [cancelLinkChangeCall, "cancel_link_change"],
  ] as const)
    assert.deepEqual(build(CONTRACT, "alice.testnet"), {
      receiver: CONTRACT,
      method,
      args: { wallet: "alice.testnet" },
      deposit: 0n,
      gas: GAS.linkChange,
    });
});

test("the vault withdraw call is the one sendWithdrawal sends", async () => {
  const w: Withdrawal = {
    chain: "testnet",
    vault: `0s${"ab".repeat(20)}`,
    to: "payee.testnet",
    amount: 5n * MILLI,
    n: 3n,
    deadline: 1_793_000_600,
  };
  const signature = new Uint8Array(64).fill(9);
  const sent: unknown[] = [];
  await sendWithdrawal(
    {
      call: async (c) => {
        sent.push(c);
        return { transaction_hash: "H".repeat(44) };
      },
    },
    w,
    signature,
  );
  assert.deepEqual(sent, [withdrawCall(w, signature)]);
});

const REPO = "Ololadestephen/flop";
test("a pull request is a number or a link in the bounty's repository", () => {
  const ok = (text: string) => {
    const parsed = parsePullRequestInput(text, REPO);
    assert.ok(parsed.ok, `${text}: ${parsed.ok ? "" : parsed.message}`);
    return parsed.number;
  };
  assert.equal(ok("42"), 42);
  assert.equal(ok("  #42 "), 42);
  assert.equal(ok("https://github.com/Ololadestephen/flop/pull/42"), 42);
  assert.equal(ok("https://github.com/ololadestephen/FLOP/pull/42/"), 42);
  assert.equal(ok("https://github.com/Ololadestephen/flop/pull/42/files"), 42);
  assert.equal(
    ok("https://github.com/Ololadestephen/flop/pull/42?diff=split#top"),
    42,
  );
  assert.equal(ok("4294967295"), 4294967295);
});

test("anything else is refused with what to enter instead", () => {
  const bad = (text: string, message: RegExp) => {
    const parsed = parsePullRequestInput(text, REPO);
    assert.equal(parsed.ok, false, text);
    if (!parsed.ok) assert.match(parsed.message, message, text);
  };
  bad("", /Enter the pull request number/);
  bad("   ", /Enter the pull request number/);
  bad("0", /not a pull request number/);
  bad("4294967296", /from 1 to 4294967295/);
  bad("12345678901", /not a pull request number or a GitHub link/);
  bad("forty two", /not a pull request number or a GitHub link/);
  bad("-3", /not a pull request number or a GitHub link/);
  bad(
    "https://github.com/someone/else/pull/42",
    /in someone\/else.*is for Ololadestephen\/flop/,
  );
  bad("https://github.com/Ololadestephen/flop/issues/1", /issue link/);
  bad("https://github.com/Ololadestephen/flop/pull/", /not a pull request/);
  bad(
    "https://github.com/Ololadestephen/flop/commit/abc",
    /not a pull request/,
  );
  bad(
    "https://github.com/Ololadestephen/flop/pull/abc",
    /not a pull request number/,
  );
  bad("https://github.com/Ololadestephen/flop/pull/42/evil", /extra parts/);
  bad(
    "http://github.com/Ololadestephen/flop/pull/42",
    /Only https:\/\/github.com/,
  );
  bad(
    "https://gitlab.com/Ololadestephen/flop/pull/42",
    /Only https:\/\/github.com/,
  );
  bad(
    "https://github.com.evil.example/Ololadestephen/flop/pull/42",
    /Only https:\/\/github.com/,
  );
  bad(
    "https://user@github.com/Ololadestephen/flop/pull/42",
    /Only https:\/\/github.com/,
  );
  bad(
    "https://github.com:8443/Ololadestephen/flop/pull/42",
    /Only https:\/\/github.com/,
  );
  bad(
    "Ololadestephen/flop/pull/42",
    /not a pull request number or a GitHub link/,
  );
});

test("who may act on a waiting link change", () => {
  const base = {
    wallet: "new.testnet",
    activatesAt: 1000,
    now: 500,
  };
  // The wallet that holds the GitHub id today can confirm and cancel; the asking wallet can cancel.
  assert.deepEqual(
    linkChangeRoles({ ...base, viewer: "old.testnet", owner: "old.testnet" }),
    { canActivate: false, canConfirm: true, canCancel: true },
  );
  assert.deepEqual(
    linkChangeRoles({ ...base, viewer: "new.testnet", owner: "old.testnet" }),
    { canActivate: false, canConfirm: false, canCancel: true },
  );
  // Nobody holds the id: the wallet itself confirms.
  assert.deepEqual(
    linkChangeRoles({ ...base, viewer: "new.testnet", owner: null }),
    { canActivate: false, canConfirm: true, canCancel: true },
  );
  assert.deepEqual(
    linkChangeRoles({ ...base, viewer: "other.testnet", owner: "old.testnet" }),
    { canActivate: false, canConfirm: false, canCancel: false },
  );
  // After the delay anyone may apply it.
  assert.equal(
    linkChangeRoles({
      ...base,
      now: 1000,
      viewer: "other.testnet",
      owner: "old.testnet",
    }).canActivate,
    true,
  );
});

test("the link outcome the contract returns is shown as plain text, with the refund of the storage deposit", () => {
  assert.equal(
    linkOutcomeOf({ transaction_hash: "h", result: "linked" }),
    "linked",
  );
  assert.equal(linkOutcomeOf({ transaction_hash: "h" }), null);
  assert.equal(linkOutcomeOf(undefined), null);
  for (const stored of ["linked", "link_pending", "link_refreshed"])
    assert.equal(linkOutcomeStoresNothing(stored), false, stored);
  for (const refused of [
    "mismatch:challenge",
    "mismatch:ambiguous",
    "mismatch:gist_used",
    "no_result:stale",
    "ignored:not_live",
  ]) {
    assert.equal(linkOutcomeStoresNothing(refused), true, refused);
    assert.match(
      linkOutcomeText(refused, 72 * 3600),
      /0\.007 NEAR storage deposit was returned/,
    );
  }
  assert.match(linkOutcomeText("link_pending", 72 * 3600), /waits 72 hours/);
  assert.match(linkOutcomeText("linked", 72 * 3600), /connected/);
});
