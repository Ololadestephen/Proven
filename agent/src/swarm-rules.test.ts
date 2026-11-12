import assert from "node:assert/strict";
import test from "node:test";
import type { Bid } from "./board.ts";
import { workRefusal } from "./swarm-rules.ts";
import type { Job } from "./types.ts";

const EXPIRES = 10_000_000_000_000n;
const bid = (over: Partial<Bid> = {}): Bid =>
  ({
    state: "Claimed",
    amount: "10",
    expires_at: (EXPIRES * 1000n).toString(),
    job_id: 7,
    claim: { number: 1, agent: "agent.testnet", claimed_at: "0" },
    ...over,
  }) as Bid;
const job = (over: Partial<Job> = {}): Job =>
  ({
    state: "Funded",
    worker: "agent.testnet",
    token: null,
    amount: "10",
    deadline: "1000000000000",
    ...over,
  }) as Job;

test("the agent starts only on a funded job naming it, for this bid", () => {
  assert.equal(workRefusal(bid(), 7, job(), "agent.testnet", 0n), null);
  assert.match(
    workRefusal(bid(), 7, job({ state: "Challenged" }), "agent.testnet", 0n) ??
      "",
    /not funded/,
  );
  assert.match(
    workRefusal(
      bid(),
      7,
      job({ worker: "other.testnet" }),
      "agent.testnet",
      0n,
    ) ?? "",
    /different worker/,
  );
  assert.match(
    workRefusal(bid(), 7, job({ amount: "1" }), "agent.testnet", 0n) ?? "",
    /other than the bid/,
  );
  assert.match(
    workRefusal(bid(), 7, job({ token: "usd.testnet" }), "agent.testnet", 0n) ??
      "",
    /other than the bid/,
  );
  assert.match(
    workRefusal(bid(), 7, job(), "agent.testnet", 600_000_000_000n) ?? "",
    /too little time/,
  );
  assert.match(
    workRefusal(bid(), 8, job(), "agent.testnet", 0n) ?? "",
    /not this bid's/,
  );
});

test("a claim held by another agent is not this agent's job", () => {
  const theirs = bid({
    claim: { number: 1, agent: "other.testnet", claimed_at: "0" },
  });
  assert.match(
    workRefusal(theirs, 7, job(), "agent.testnet", 0n) ?? "",
    /claim is not this agent's/,
  );
});

test("work starts only with more than seven minutes before the deadline", () => {
  // The fixture's deadline is 1,000 seconds; the agent needs 420 seconds.
  const last = 1_000_000_000_000n - 420_000_000_000n;
  assert.equal(workRefusal(bid(), 7, job(), "agent.testnet", last - 1n), null);
  assert.match(
    workRefusal(bid(), 7, job(), "agent.testnet", last) ?? "",
    /too little time/,
  );
});
