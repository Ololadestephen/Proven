import assert from "node:assert/strict";
import test from "node:test";
import { parseReview } from "./bid-review.ts";
import { FUND_MARGIN_NANOS, fundRefusal, type Bid } from "./board.ts";
import { inferenceLimit, workRefusal } from "./swarm.ts";
import type { Job } from "./types.ts";

const EXPIRES = 10_000_000_000_000n;
const bid = (over: Partial<Bid> = {}): Bid =>
  ({
    state: "Claimed",
    amount: "10",
    claim: { number: 1, agent: "agent.testnet", claimed_at: "0", expires_at: EXPIRES.toString(), job_id: 7 },
    ...over,
  }) as Bid;
const job = (over: Partial<Job> = {}): Job => ({ state: "Funded", worker: "agent.testnet", token: null, amount: "10", ...over }) as Job;

test("the buyer funds only an active claim linked to this job, with time left", () => {
  assert.equal(fundRefusal(bid(), 7, 0n), null);
  assert.match(fundRefusal(bid(), 8, 0n) ?? "", /not linked/);
  assert.match(fundRefusal(bid({ state: "Open", claim: null }), 7, 0n) ?? "", /no active claim/);
  assert.match(fundRefusal(bid(), 7, EXPIRES - FUND_MARGIN_NANOS) ?? "", /about to end/);
});

test("the agent starts only on a funded job naming it, for this bid", () => {
  assert.equal(workRefusal(bid(), 7, job(), "agent.testnet"), null);
  assert.match(workRefusal(bid(), 7, job({ state: "Challenged" }), "agent.testnet") ?? "", /not funded/);
  assert.match(workRefusal(bid(), 7, job({ worker: "other.testnet" }), "agent.testnet") ?? "", /different worker/);
  assert.match(workRefusal(bid(), 7, job({ amount: "1" }), "agent.testnet") ?? "", /other than the bid/);
  assert.match(workRefusal(bid(), 7, job({ token: "usd.testnet" }), "agent.testnet") ?? "", /other than the bid/);
  assert.match(workRefusal(bid(), 8, job(), "agent.testnet") ?? "", /not linked/);
});

test("earnings raise the inference limit up to a ceiling", () => {
  assert.equal(inferenceLimit(0n), 50_000_000);
  assert.equal(inferenceLimit(10n ** 22n), 60_000_000);
  assert.equal(inferenceLimit(10n ** 26n), 300_000_000);
});

test("only an exact review answer counts", () => {
  assert.deepEqual(parseReview('{"allow":true,"reason":"ok"}'), { allow: true, reason: "ok" });
  assert.deepEqual(parseReview('  {"allow":false,"reason":"no"}\n'), { allow: false, reason: "no" });
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
