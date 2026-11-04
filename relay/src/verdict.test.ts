import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "./near.ts";
import { challengeCall, verdictCall } from "./verdict.ts";

const job: Job = { buyer: "b", worker: "w", state: "Draft", spec_hash: "s".repeat(64), fakes_hash: "f".repeat(64), deliverable_hash: "d".repeat(64) };
const common = { job_id: 7, spec_hash: job.spec_hash, report_hash: "r".repeat(64), attestation_hash: "a".repeat(64) };

test("a challenge output becomes record_challenge with the job's own hashes", () => {
  const [method, args] = challengeCall({ reference_passed: true, fakes_total: 13, fakes_caught: 13 }, job, common);
  assert.equal(method, "record_challenge");
  assert.deepEqual(args, { ...common, fakes_hash: job.fakes_hash, reference_passed: true, fakes_total: 13, fakes_caught: 13 });
});

test("a verify output becomes record_verdict for the delivered hash", () => {
  const [method, args] = verdictCall({ pass: false }, job, common);
  assert.equal(method, "record_verdict");
  assert.deepEqual(args, { ...common, deliverable_hash: job.deliverable_hash, pass: false });
});

test("malformed outputs are refused, never coerced", () => {
  assert.throws(() => verdictCall({ pass: "true" }, job, common), /pass/);
  assert.throws(() => verdictCall({}, job, common), /pass/);
  assert.throws(() => challengeCall({ reference_passed: 1, fakes_total: 13, fakes_caught: 13 }, job, common), /reference_passed/);
  assert.throws(() => challengeCall({ reference_passed: true, fakes_total: -1, fakes_caught: 0 }, job, common), /fakes_total/);
  assert.throws(() => challengeCall({ reference_passed: true, fakes_total: 2, fakes_caught: 3 }, job, common), /more fakes caught/);
  assert.throws(() => challengeCall({ reference_passed: true, fakes_total: 1.5, fakes_caught: 1 }, job, common), /fakes_total/);
});
