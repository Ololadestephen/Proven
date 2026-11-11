// The review a maintainer sees before signing: suggested branch, deadlines, fees and the exact
// total, and every way an override or the reward can be refused. No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import type { IssueMetadata } from "../ui/github-issue.ts";
import {
  ADVANCED_DEFAULTS,
  PREVIEW_FEES,
  branchProblem,
  duration,
  reviewPosting,
  signingBlock,
  type Advanced,
  type FeeSchedule,
  type Limits,
  type Review,
} from "../ui/posting-review.ts";

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;
const NOW = 1_793_000_000;
const META: IssueMetadata = {
  repo: "Ololadestephen/flop",
  repo_id: 1346702196,
  issue: 1,
  title: "Proven testnet pilot A: merge and payout",
  html_url: "https://github.com/Ololadestephen/flop/issues/1",
  default_branch: "main",
};
const PILOT = { repo: "Ololadestephen/flop", repo_id: 1346702196 };
const LIMITS = { max_reward: 2n * NEAR, room: 5n * NEAR };

function review(
  over: {
    rewardText?: string;
    advanced?: Partial<Advanced>;
    meta?: Partial<IssueMetadata>;
    fees?: FeeSchedule;
    limits?: Limits;
  } = {},
) {
  return reviewPosting({
    meta: { ...META, ...over.meta },
    rewardText: over.rewardText ?? "0.1",
    advanced: { ...ADVANCED_DEFAULTS, ...over.advanced },
    limits: over.limits ?? LIMITS,
    pilot: PILOT,
    fees: over.fees ?? PREVIEW_FEES,
    now: NOW,
  });
}
function ok(outcome: ReturnType<typeof review>): Review {
  assert.ok(outcome.ok, outcome.ok ? "" : JSON.stringify(outcome));
  return outcome.review;
}
function problems(outcome: ReturnType<typeof review>) {
  assert.equal(outcome.ok, false);
  return outcome.ok ? [] : outcome.problems;
}

test("the link and the reward alone give a complete review", () => {
  const r = ok(review());
  assert.equal(r.repo, "Ololadestephen/flop");
  assert.equal(r.issue, 1);
  assert.equal(r.title, META.title);
  assert.equal(r.branch, "main");
  assert.equal(r.branch_overridden, false);
  assert.deepEqual(r.deadlines, {
    claim_by: NOW + 7 * 86400,
    merge_deadline: NOW + 14 * 86400,
    grace_ends: NOW + 14 * 86400 + 24 * 3600,
    checks_until: NOW + 28 * 86400 + 24 * 3600,
    hard_refund_at: NOW + 28 * 86400 + 24 * 3600,
    refund_cap_secs: 14 * 86400,
    claim_secs: 48 * 3600,
    grace_secs: 24 * 3600,
  });
});

test("the checking period comes from the contract's refund cap, not a fixed 14 days", () => {
  const r = ok(review({ limits: { ...LIMITS, refund_cap_secs: 30 } }));
  assert.equal(r.deadlines.refund_cap_secs, 30);
  assert.equal(r.deadlines.checks_until, NOW + 14 * 86400 + 24 * 3600 + 30);
  assert.equal(r.deadlines.hard_refund_at, NOW + 14 * 86400 + 24 * 3600 + 30);
});

test("the total is exact: reward plus the record deposit, with no rounding", () => {
  const r = ok(review({ rewardText: "0.1" }));
  assert.equal(r.reward, 100n * MILLI);
  assert.equal(r.locked, 130n * MILLI);
  assert.equal(r.kept, 30n * MILLI);
  assert.equal(r.returned_on_refund, 100n * MILLI);
  // A reserve that is locked with the reward comes back with it.
  const reserve: FeeSchedule = { ...PREVIEW_FEES, check_reserve: 30n * MILLI };
  const withReserve = ok(review({ fees: reserve }));
  assert.equal(withReserve.locked, 160n * MILLI);
  assert.equal(withReserve.returned_on_refund, 130n * MILLI);
  assert.equal(withReserve.kept, 30n * MILLI);
  // Twenty-four decimals survive.
  const fine = ok(review({ rewardText: "0.000000000000000000000001" }));
  assert.equal(fine.reward, 1n);
});

test("the preview fees are labelled as samples and are not approved", () => {
  assert.equal(PREVIEW_FEES.source, "preview");
  assert.equal(PREVIEW_FEES.approved, false);
  assert.match(
    signingBlock({ fees: PREVIEW_FEES, connected: true, poster: true }),
    /Preview only/,
  );
});

test("signing needs approved fees, a wallet and a listed poster, in that order", () => {
  const approved: FeeSchedule = {
    ...PREVIEW_FEES,
    source: "contract",
    approved: true,
  };
  assert.equal(
    signingBlock({ fees: approved, connected: true, poster: true }),
    "",
  );
  assert.match(
    signingBlock({ fees: approved, connected: false, poster: true }),
    /Connect a wallet/,
  );
  assert.match(
    signingBlock({ fees: approved, connected: true, poster: false }),
    /approved posters/,
  );
});

test("a different branch is flagged, and the default is never changed silently", () => {
  const r = ok(review({ advanced: { branch: " proven-testnet-pilot " } }));
  assert.equal(r.branch, "proven-testnet-pilot");
  assert.equal(r.branch_suggested, "main");
  assert.equal(r.branch_overridden, true);
  const same = ok(review({ advanced: { branch: "main" } }));
  assert.equal(same.branch_overridden, false);
  const trunk = ok(review({ meta: { default_branch: "trunk" } }));
  assert.equal(trunk.branch, "trunk");
});

test("branch names git or the contract would refuse are refused", () => {
  for (const name of [
    "has space",
    "-leading",
    "a..b",
    "a//b",
    "ends.",
    "x.lock",
    "a~1",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a@{b",
    "@",
    "/lead",
    "trail/",
    ".hidden",
    "a/.hidden",
    "tab\tname",
    "x".repeat(256),
  ]) {
    const p = problems(review({ advanced: { branch: name } }));
    assert.equal(p[0]?.field, "branch", JSON.stringify(name));
  }
  for (const name of ["main", "release/1.2", "feature_x-1", "ü"])
    assert.equal(branchProblem(name), null, name);
});

test("deadline overrides are bounded where the contract bounds them", () => {
  const cases: [Partial<Advanced>, string][] = [
    [{ claim_hours: "0.5" }, "claim_hours"],
    [{ claim_hours: "abc" }, "claim_hours"],
    [{ claim_hours: "400", merge_days: "10" }, "claim_hours"],
    [{ merge_days: "31" }, "merge_days"],
    [{ merge_days: "0" }, "merge_days"],
    [{ open_days: "15" }, "open_days"],
    [{ open_days: "0" }, "open_days"],
    [{ grace_hours: "0.1" }, "grace_hours"],
    [{ grace_hours: "25" }, "grace_hours"],
    [{ grace_hours: "" }, "grace_hours"],
  ];
  for (const [advanced, field] of cases) {
    const p = problems(review({ advanced }));
    assert.ok(
      p.some((x) => x.field === field),
      `${JSON.stringify(advanced)} -> ${JSON.stringify(p)}`,
    );
  }
  const edge = ok(
    review({
      advanced: {
        claim_hours: "1",
        open_days: "30",
        merge_days: "30",
        grace_hours: "24",
      },
    }),
  );
  assert.equal(edge.deadlines.merge_deadline, NOW + 30 * 86400);
  const tenMinutes = ok(review({ advanced: { grace_hours: "0.1667" } }));
  assert.ok(tenMinutes.deadlines.grace_secs >= 600);
});

test("the reward is exact and inside the contract's limits", () => {
  for (const rewardText of ["", "0", "-1", "1e3", "0.1.2", " ", "abc"]) {
    const p = problems(review({ rewardText }));
    assert.equal(p[0]?.field, "reward", JSON.stringify(rewardText));
  }
  assert.equal(
    problems(review({ rewardText: "2.000001" }))[0]?.field,
    "reward",
  );
  assert.ok(ok(review({ rewardText: "2" })).locked > 2n * NEAR);
  const full = problems(
    review({ limits: { max_reward: 2n * NEAR, room: 50n * MILLI } }),
  );
  assert.match(full[0]?.message ?? "", /cannot lock that much/);
});

test("only the pilot repository is accepted, by name and by id", () => {
  const other = problems(
    review({ meta: { repo: "someone/else", repo_id: 5 } }),
  );
  assert.equal(other[0]?.field, "repository");
  assert.match(other[0]?.message ?? "", /Ololadestephen\/flop/);
  // The name matches but the repository is a different one with that name.
  assert.equal(
    problems(review({ meta: { repo_id: 99 } }))[0]?.field,
    "repository",
  );
  // Same repository with different letter case is the same repository.
  ok(review({ meta: { repo: "ololadestephen/FLOP" } }));
});

test("a problem is reported for its own field and the review is not built from a guess", () => {
  const p = problems(
    review({ rewardText: "x", advanced: { branch: "a b", grace_hours: "99" } }),
  );
  assert.deepEqual(p.map((x) => x.field).sort(), [
    "branch",
    "grace_hours",
    "reward",
  ]);
});

test("the review carries nothing the maintainer was not asked for", () => {
  const r = ok(review());
  const keys = Object.keys(r).join(" ");
  assert.doesNotMatch(keys, /contributor|github_id|backup|key|verifier/i);
});

test("durations are exact", () => {
  assert.equal(duration(48 * 3600), "2 days");
  assert.equal(duration(3600), "1 hour");
  assert.equal(duration(5400), "1 hour 30 minutes");
  assert.equal(duration(14 * 86400 + 3600), "14 days 1 hour");
  assert.equal(duration(30), "30 seconds");
});
