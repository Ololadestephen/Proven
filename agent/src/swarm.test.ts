import assert from "node:assert/strict";
import test from "node:test";
import { parseReview } from "./bid-review.ts";
import { inferenceLimit } from "./swarm.ts";

test("earnings raise the inference limit up to a ceiling", () => {
  assert.equal(inferenceLimit(0n), 50_000_000);
  assert.equal(inferenceLimit(10n ** 22n), 60_000_000);
  assert.equal(inferenceLimit(10n ** 26n), 300_000_000);
});

test("only an exact review answer counts", () => {
  assert.deepEqual(parseReview('{"allow":true,"reason":"ok"}'), {
    allow: true,
    reason: "ok",
  });
  assert.deepEqual(parseReview('  {"allow":false,"reason":"no"}\n'), {
    allow: false,
    reason: "no",
  });
  for (const bad of [
    "",
    "yes",
    "[]",
    "null",
    '{"allow":"true","reason":"ok"}',
    '{"allow":true}',
    '{"allow":true,"reason":"ok","amount":5}',
    '```json\n{"allow":true,"reason":"ok"}\n```',
    '{"allow":true,"reason":"ok"} {"allow":false,"reason":"no"}',
    `{"allow":true,"reason":"${"x".repeat(201)}"}`,
  ]) {
    assert.equal(parseReview(bad), null, bad);
  }
});
