// What state a bounty is in and which calls the contract will accept now. No network.
import assert from "node:assert/strict";
import test from "node:test";
import type { Bounty } from "../ui/bounty-types.ts";
import {
  bountyStatus,
  checksUntil,
  graceEnds,
  claimEndable,
  claimExpirable,
  failedLookWarning,
  hardRefundAt,
  liveCheck,
  mergeCheckable,
  refundDue,
  utc,
} from "../ui/bounty-status.ts";

const NANOS = 1_000_000_000n;
const CAP = 14 * 86400;
const T0 = 1_800_000_000;
const KEY = "ed25519:6W6SaZv5FcUXp3G7SZP9o21hCudRJKTXqP9QZy4JhffW";
const VAULT = `0s${"ab".repeat(20)}`;
const bounty = (over: Partial<Bounty> = {}): Bounty => ({
  buyer: "maint.testnet",
  reward: "100000000000000000000000",
  sponsored_runs: 0,
  repo: "Ololadestephen/flop",
  repo_id: "1346702196",
  issue: 1,
  base_ref: "main",
  posted_at: String(BigInt(T0) * NANOS),
  claim_by: String(T0 + 1000),
  claim_secs: "3600",
  merge_deadline: String(T0 + 10_000),
  grace_secs: "3600",
  status: "Open",
  maintainer_key: KEY,
  maintainer_vault: VAULT,
  posting_nonce: "a".repeat(64),
  claim: null,
  binding: null,
  merge: null,
  live: null,
  last_check: null,
  definite_look: null,
  payout: null,
  refund: null,
  ...over,
});
const claim = (endsAt = T0 + 3000) => ({
  wallet: "contrib.testnet",
  github_id: "900000001",
  key: KEY,
  vault: VAULT,
  claimed_at: String(BigInt(T0) * NANOS),
  ends_at: String(endsAt),
});
const binding = {
  pr_number: 12,
  pr_id: "77",
  author_id: "900000001",
  wallet: "contrib.testnet",
  bound_at: String(BigInt(T0 + 100) * NANOS),
  request_id: "5",
};
const live = (kind: "Submit" | "Merge", at: number) => ({
  seq: "9",
  kind,
  requested_at: String(BigInt(at) * NANOS),
  pr_number: 12,
  payer: "contrib.testnet",
  sponsored: false,
  gist_id: null,
});
const claimed = (over: Partial<Bounty> = {}) =>
  bounty({ status: "Claimed", claim: claim(), ...over });
const bound = (over: Partial<Bounty> = {}) =>
  bounty({ status: "Bound", claim: claim(), binding, ...over });

test("each contract status has one status line", () => {
  assert.deepEqual(
    [
      bountyStatus(bounty(), T0).line,
      bountyStatus(claimed(), T0).line,
      bountyStatus(bound(), T0).line,
      bountyStatus(bound({ live: live("Merge", T0) }), T0 + 10).line,
      bountyStatus(bounty({ status: "Paid" }), T0).line,
      bountyStatus(bounty({ status: "Refunded" }), T0).line,
      bountyStatus(bounty({ status: "Cancelled" }), T0).line,
      bountyStatus(bounty({ status: "Ineligible" }), T0).line,
    ],
    [
      "Open",
      `Claimed, ends ${utc(T0 + 3000)}`,
      "PR submitted",
      "Verifying merge",
      "Paid",
      "Refunded",
      "Cancelled",
      "Ineligible",
    ],
  );
});

test("a check older than fifteen minutes is not live, so the status falls back", () => {
  const stale = bound({ live: live("Merge", T0) });
  assert.equal(bountyStatus(stale, T0 + 900).name, "Verifying merge");
  assert.equal(liveCheck(stale, T0 + 901), null);
  assert.equal(bountyStatus(stale, T0 + 901).name, "PR submitted");
});

test("a live submission check keeps the status Claimed, says so, and stops the claim from ending", () => {
  const b = claimed({ live: live("Submit", T0 + 50) });
  const status = bountyStatus(b, T0 + 60);
  assert.equal(status.name, "Claimed");
  assert.match(status.detail, /check of pull request #12 is running/);
  assert.equal(claimEndable(b, T0 + 60), false);
  // A check that is older than fifteen minutes no longer blocks, as in the contract.
  assert.equal(claimExpirable(b, T0 + 5000), true);
  const late = claimed({ live: live("Submit", T0 + 2990) });
  assert.equal(claimExpirable(late, T0 + 3000), false);
  assert.equal(claimEndable(claimed(), T0 + 60), true);
});

test("a claim can be expired only after its end", () => {
  assert.equal(claimExpirable(claimed(), T0 + 2999), false);
  assert.equal(claimExpirable(claimed(), T0 + 3000), true);
  assert.equal(claimExpirable(bounty(), T0 + 5000), false);
});

test("the refund opens as the contract's settle does", () => {
  // Open: after claim_by.
  assert.equal(refundDue(bounty(), T0 + 999, CAP), false);
  assert.equal(refundDue(bounty(), T0 + 1000, CAP), true);
  // Claimed: after the claim ends and claim_by passed, with no live check.
  assert.equal(refundDue(claimed(), T0 + 2999, CAP), false);
  assert.equal(refundDue(claimed(), T0 + 3000, CAP), true);
  assert.equal(
    refundDue(claimed({ live: live("Submit", T0 + 2990) }), T0 + 3000, CAP),
    false,
  );
  // Ineligible: always.
  assert.equal(refundDue(bounty({ status: "Ineligible" }), T0, CAP), true);
  // Done states: never.
  for (const status of ["Paid", "Refunded", "Cancelled"] as const)
    assert.equal(refundDue(bounty({ status }), T0 + 10 ** 9, CAP), false);
});

test("a submitted pull request is refunded only after a definite look past the deadline, or the cap", () => {
  const b = bound();
  const until = graceEnds(b);
  assert.equal(until, T0 + 13_600);
  assert.equal(hardRefundAt(b, CAP), until + CAP);
  assert.equal(checksUntil(b, CAP), until + CAP, "checks run to the cutoff");
  // Inside the window: never.
  assert.equal(refundDue(b, until - 1, CAP), false);
  // After the window with no look: not before the cap.
  assert.equal(refundDue(b, until + 1, CAP), false);
  assert.equal(refundDue(b, until + CAP - 1, CAP), false);
  assert.equal(refundDue(b, until + CAP, CAP), true);
  // A look requested before the merge deadline does not count.
  const early = bound({
    definite_look: {
      requested_at: String(BigInt(T0 + 9_999) * NANOS),
      resolved_at: String(BigInt(T0 + 10_000) * NANOS),
    },
  });
  assert.equal(refundDue(early, until + 1, CAP), false);
  // A look requested at the deadline, or 59 s after it, does not either: GitHub may not have
  // reported the merge yet.
  for (const early of [T0 + 10_000, T0 + 10_059]) {
    const b2 = bound({
      definite_look: {
        requested_at: String(BigInt(early) * NANOS),
        resolved_at: String(BigInt(early + 1) * NANOS),
      },
    });
    assert.equal(refundDue(b2, until + 1, CAP), false, `requested at ${early}`);
    assert.equal(
      refundDue(b2, until + CAP, CAP),
      true,
      "the cutoff still opens it",
    );
  }
  // A look requested a minute after the deadline does.
  const late = bound({
    definite_look: {
      requested_at: String(BigInt(T0 + 10_060) * NANOS),
      resolved_at: String(BigInt(T0 + 10_061) * NANOS),
    },
  });
  assert.equal(refundDue(late, until + 1, CAP), true);
  // A live check holds the refund back even then.
  assert.equal(
    refundDue({ ...late, live: live("Merge", until) }, until + 1, CAP),
    false,
  );
});

test("a merge check is offered until the hard cutoff, after the grace too, when none is live", () => {
  const b = bound();
  assert.equal(mergeCheckable(b, T0, CAP), true);
  assert.equal(mergeCheckable(b, graceEnds(b), CAP), true, "after the grace");
  assert.equal(mergeCheckable(b, hardRefundAt(b, CAP) - 1, CAP), true);
  assert.equal(mergeCheckable(b, hardRefundAt(b, CAP), CAP), false);
  assert.equal(
    mergeCheckable(bound({ live: live("Merge", T0) }), T0 + 5, CAP),
    false,
  );
  assert.equal(mergeCheckable(claimed(), T0, CAP), false);
});

test("a failed look is flagged, and a settled one is not", () => {
  const failed = bound({
    last_check: {
      seq: "4",
      kind: "merge",
      request_id: null,
      resolved_at: "1",
      outcome: "no_result:stale",
    },
  });
  assert.match(
    failedLookWarning(failed, CAP) ?? "",
    /could not read GitHub \(no_result:stale\)/,
  );
  assert.match(failedLookWarning(failed, CAP) ?? "", /changes nothing/);
  // It names the hard cutoff, not the end of the grace.
  assert.ok(
    (failedLookWarning(failed, CAP) ?? "").includes(
      utc(hardRefundAt(failed, CAP)),
    ),
  );
  assert.equal(
    failedLookWarning(
      bound({
        last_check: {
          seq: "4",
          kind: "merge",
          request_id: "1",
          resolved_at: "1",
          outcome: "pending",
        },
      }),
      CAP,
    ),
    null,
  );
  assert.equal(failedLookWarning(bounty(), CAP), null);
});
