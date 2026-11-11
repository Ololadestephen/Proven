// The PR bounty list's tabs, "needs action", search and the progress path. No network.
import assert from "node:assert/strict";
import test from "node:test";
import type { Bounty } from "../ui/bounty-types.ts";
import {
  activity,
  matches,
  needsAction,
  progressPath,
  stepFromHash,
  tabOf,
} from "../ui/bounty-board.ts";

const NANOS = 1_000_000_000n;
const T0 = 1_800_000_000;
const cfg = { refund_cap_secs: 14 * 86400 };
const base = {
  buyer: "maint.testnet",
  reward: "50000000000000000000000",
  sponsored_runs: 0,
  repo: "owner/repo",
  repo_id: "1",
  issue: 7,
  base_ref: "main",
  posted_at: String(BigInt(T0) * NANOS),
  claim_by: String(T0 + 1000),
  claim_secs: "3600",
  merge_deadline: String(T0 + 10_000),
  grace_secs: "900",
  status: "Open",
  maintainer_key: "ed25519:k",
  maintainer_vault: "0sv",
  posting_nonce: "n",
  claim: null,
  binding: null,
  merge: null,
  live: null,
  last_check: null,
  definite_look: null,
  payout: null,
  refund: null,
} as unknown as Bounty;
const b = (over: Partial<Bounty>) => ({ ...base, ...over }) as Bounty;
const claim = {
  wallet: "contrib.testnet",
  github_id: "9",
  key: "ed25519:k",
  vault: "0sc",
  claimed_at: String(BigInt(T0 + 10) * NANOS),
  ends_at: String(T0 + 3610),
};

test("each status falls in one tab; Ineligible stays in progress until refunded", () => {
  assert.equal(tabOf(b({ status: "Open" })), "open");
  assert.equal(tabOf(b({ status: "Claimed" })), "progress");
  assert.equal(tabOf(b({ status: "Bound" })), "progress");
  assert.equal(tabOf(b({ status: "Ineligible" })), "progress");
  assert.equal(tabOf(b({ status: "Paid" })), "paid");
  assert.equal(tabOf(b({ status: "Refunded" })), "refunded");
  assert.equal(tabOf(b({ status: "Cancelled" })), "refunded");
});

test("needs action: a claimant who has not submitted, and a maintainer whose refund is due", () => {
  const claimed = b({ status: "Claimed", claim });
  assert.equal(needsAction(claimed, "contrib.testnet", T0 + 20, cfg), true);
  assert.equal(needsAction(claimed, "maint.testnet", T0 + 20, cfg), false);
  assert.equal(needsAction(claimed, null, T0 + 20, cfg), false);
  const ineligible = b({ status: "Ineligible", claim });
  assert.equal(needsAction(ineligible, "maint.testnet", T0 + 20, cfg), true);
  assert.equal(needsAction(ineligible, "someone.testnet", T0 + 20, cfg), false);
});

test("search matches the repository, the issue number and the title", () => {
  assert.ok(matches(base, undefined, "owner/repo"));
  assert.ok(matches(base, undefined, "#7"));
  assert.ok(matches(base, "Fix the parser", "parser"));
  assert.ok(!matches(base, "Fix the parser", "lexer"));
  assert.ok(matches(base, undefined, "  "));
});

test("the path marks the next step, and ends as it happened", () => {
  const states = (x: Bounty) => progressPath(x).map((s) => s.state);
  assert.deepEqual(states(b({ status: "Open" })), [
    "done",
    "current",
    "todo",
    "todo",
    "todo",
  ]);
  assert.equal(
    progressPath(b({ status: "Refunded" })).at(-1)?.label,
    "Refunded",
  );
  assert.deepEqual(
    progressPath(b({ status: "Cancelled" })).map((s) => s.label),
    ["Posted", "Cancelled"],
  );
});

test("activity lists what happened, newest first", () => {
  const events = activity(b({ status: "Claimed", claim }));
  assert.deepEqual(
    events.map((e) => e.text),
    ["Claimed by the contributor", "Bounty posted"],
  );
});

test("a step link opens its step, and only a pull request number fills the submit box", () => {
  assert.deepEqual(stepFromHash("#claim"), { name: "claim", pr: "" });
  assert.deepEqual(stepFromHash("#submit-12"), { name: "submit", pr: "12" });
  assert.deepEqual(stepFromHash("#check"), { name: "check", pr: "" });
  assert.deepEqual(stepFromHash("#withdraw"), { name: "withdraw", pr: "" });
  for (const bad of [
    "",
    "#",
    "#submit-x",
    "#claim-3",
    "#pay",
    "#submit-12345678901",
  ])
    assert.deepEqual(stepFromHash(bad), { name: "", pr: "" }, bad);
});
