// When a journaled wallet action is checked or released without asking the person. No network.
import assert from "node:assert/strict";
import test from "node:test";
import {
  GIVE_UP_MS,
  POLL_MS,
  nextStep,
  unreadable,
} from "../ui/auto-resolve.ts";

test("the chain is read until the give-up time, then the action is released if it never landed", () => {
  const settled = 1_000_000;
  assert.equal(nextStep(settled, settled), "check");
  assert.equal(nextStep(settled, settled + GIVE_UP_MS - 1), "check");
  assert.equal(nextStep(settled, settled + GIVE_UP_MS), "release");
  assert.ok(POLL_MS < GIVE_UP_MS);
  // NEAR finality is a few seconds: several reads happen before anything is released.
  assert.ok(GIVE_UP_MS / POLL_MS >= 5);
});

test("only an unreadable journal is left for the person", () => {
  const base = { before: "", label: "Posting", createdAt: 1 };
  assert.equal(unreadable({ ...base, account: "unknown" }), true);
  assert.equal(unreadable({ ...base, account: "maint.testnet" }), false);
});
