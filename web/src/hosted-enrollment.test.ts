import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  enrollmentText,
  type HostedEnrollment,
} from "../../shared/hosted-enrollment.ts";

const enrollment: HostedEnrollment = {
  prompt: "Extract only the supplied invoice data.",
  knowledge: "Amounts are integer cents.",
  skills: ["json_validator", "calculator"],
  keep_bps: 0,
  min_buyer_paid_share: null,
};
const digest = (value: HostedEnrollment) =>
  createHash("sha256").update(enrollmentText(value)).digest("hex");

test("the enrollment signature binds every owner-selected setting", () => {
  const original = digest(enrollment);
  const changes: Partial<HostedEnrollment>[] = [
    { prompt: "Different instructions" },
    { knowledge: "Different knowledge" },
    { skills: ["calculator"] },
    { keep_bps: 2500 },
    { keep_bps: 10000 },
    { min_buyer_paid_share: 0 },
    { min_buyer_paid_share: 1 },
  ];
  for (const change of changes)
    assert.notEqual(digest({ ...enrollment, ...change }), original);
});

test("skill order and duplicates do not change an enrollment or mutate its input", () => {
  const skills = Object.freeze(["calculator", "json_validator", "calculator"]);
  assert.equal(digest({ ...enrollment, skills }), digest(enrollment));
  assert.deepEqual(skills, ["calculator", "json_validator", "calculator"]);
  assert.deepEqual(JSON.parse(enrollmentText(enrollment)), {
    version: 2,
    prompt: enrollment.prompt,
    knowledge: enrollment.knowledge,
    skills: ["calculator", "json_validator"],
    keep_bps: 0,
    min_buyer_paid_share: null,
  });
});

test("embedded separators cannot move text between signed prompt and knowledge", () => {
  const left = { ...enrollment, prompt: "alpha\0beta", knowledge: "gamma" };
  const right = { ...enrollment, prompt: "alpha", knowledge: "beta\0gamma" };
  assert.notEqual(digest(left), digest(right));
  assert.equal(JSON.parse(enrollmentText(left)).prompt, left.prompt);
});
