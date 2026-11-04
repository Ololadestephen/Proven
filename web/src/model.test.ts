import test from "node:test";
import assert from "node:assert/strict";
import { parseJob, progress, jobNumber, RUN_TIMEOUT_NS } from "./model.ts";

import { fixture } from "../test-fixtures/job.ts";

test("only recorded outcomes and confirmed payout states produce verdict/payment labels", () => {
  for (const state of [
    "Draft",
    "Challenging",
    "CheckRejected",
    "Challenged",
    "Funded",
    "Delivered",
    "Verifying",
    "Passed",
    "Failed",
    "Releasing",
    "Refunding",
    "Expiring",
    "Released",
    "Refunded",
    "Expired",
  ]) {
    const job = fixture(state),
      result = progress(job, 100n);
    assert.match(result.verdict, /No recorded delivery verdict/);
    if (["Releasing", "Refunding", "Expiring"].includes(state))
      assert.match(result.funds, /not confirmed/);
    if (state === "Released") assert.match(result.funds, /Paid to the worker/);
    if (["Refunded", "Expired"].includes(state))
      assert.match(result.funds, /Returned to the buyer/);
    if (
      ["Funded", "Delivered", "Verifying", "Passed", "Failed"].includes(state)
    )
      assert.match(result.funds, /locked/);
  }
  const passed = {
    ...fixture("Released"),
    verdict_request_id: "8815",
    report_hash: "a".repeat(64),
  };
  assert.match(progress(passed, 100n).verdict, /Pass recorded/);
  assert.match(
    progress({ ...passed, state: "Refunded" }, 100n).verdict,
    /Fail recorded/,
  );
});

test("stale, retry and expiry boundaries mirror contract strict inequalities", () => {
  const start = 1_000_000_000_000n;
  const job = { ...fixture("Verifying"), run_started_at: String(start) };
  assert.match(progress(job, start + RUN_TIMEOUT_NS).run, /pending/);
  assert.match(progress(job, start + RUN_TIMEOUT_NS + 1n).run, /stale/);
  assert.match(
    progress(job, start + RUN_TIMEOUT_NS + 1n).retry,
    /may be triggered/,
  );
  const end = start + 1800_000_000_000n;
  assert.doesNotMatch(progress(job, end).expiry, /Expiry is available/);
  assert.match(progress(job, end).retry, /may be triggered/);
  assert.match(progress(job, end + 1n).expiry, /Expiry is available/);
  assert.match(progress(job, end + 1n).retry, /unavailable/);
  // An active recent attempt cannot be expired even after its verdict window ends.
  assert.doesNotMatch(
    progress({ ...job, run_started_at: String(end) }, end + 1n).expiry,
    /Expiry is available/,
  );
  assert.match(
    progress(fixture("Funded"), start + 1n).expiry,
    /Expiry is available/,
  );
  assert.match(progress(fixture("Draft"), start).retry, /unavailable/);
});

test("unsafe ids, malformed fields and unknown states fail closed", () => {
  for (const id of ["-1", "01", "1.2", "9007199254740992", "1e3", "../1"])
    assert.throws(() => jobNumber(id));
  assert.equal(jobNumber("0"), 0);
  assert.throws(() => parseJob(null), /does not exist/);
  for (const fields of [
    { state: "NewState" },
    { amount: 1 },
    { spec_hash: "bad" },
    { buyer: "<script>" },
    { attempt: -1 },
    { deadline: "-1" },
  ])
    assert.throws(() => parseJob({ ...fixture(), ...fields }));
});
