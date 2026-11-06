import assert from "node:assert/strict";
import test from "node:test";
import {
  nextStep,
  type MarketBid,
  type MarketJob,
} from "../ui/market-steps.ts";

const NOW = 1_800_000_000_000;
const NS = BigInt(NOW) * 1_000_000n;
const job = (state: string): MarketJob =>
  ({
    state,
    buyer: "b",
    worker: "w",
    amount: "10000000000000000000000",
    deadline: "9000000000000000000",
  }) as MarketJob;
const bid = (over: Partial<MarketBid> = {}): MarketBid =>
  ({
    id: 1,
    buyer: "b",
    state: "Open",
    amount: "10000000000000000000000",
    claim: null,
    job: null,
    last_job: null,
    candidate_job_id: null,
    allowed_workers: null,
    expires_at: "9000000000000000000",
    format: "{}",
    format_hash: "f".repeat(64),
    ...over,
  }) as MarketBid;
const claim = (job_id: number | null, expires = NS + 600_000_000_000n) => ({
  number: 1,
  agent: "w",
  expires_at: expires.toString(),
  job_id,
});
const id = (b: MarketBid, viewer: string | null, registered = true) =>
  nextStep(b, viewer, registered, NOW)?.id ?? null;

test("a worker registers, then applies, and a buyer cannot apply to its own bid", () => {
  assert.equal(id(bid(), "w", false), "register");
  assert.equal(id(bid(), "w"), "claim");
  assert.equal(id(bid(), "b"), "wait");
  assert.equal(id(bid(), null), "wait");
  assert.equal(id(bid({ allowed_workers: ["x"] }), "w"), "wait");
});

test("only the buyer can run the review, and a blocked bid has no step", () => {
  assert.equal(id(bid({ state: "Unreviewed" }), "b"), "review");
  assert.equal(id(bid({ state: "Unreviewed" }), "w"), "wait");
  assert.equal(id(bid({ state: "Blocked" }), "b"), null);
});

test("the buyer creates and links a job, and a reload finds the job already made", () => {
  const claimed = bid({ state: "Claimed", claim: claim(null) });
  assert.equal(id(claimed, "b"), "create_job");
  assert.equal(id(claimed, "w"), "wait");
  assert.equal(id({ ...claimed, candidate_job_id: 7 }, "b"), "link_job");
});

test("each job state gives the right person the right step", () => {
  const at = (state: string) =>
    bid({ state: "Claimed", claim: claim(7), job: job(state) });
  assert.equal(id(at("Draft"), "b"), "challenge");
  assert.equal(id(at("Draft"), "w"), "wait");
  assert.equal(id(at("Challenged"), "b"), "fund");
  assert.equal(id(at("Challenged"), "w"), "wait");
  assert.equal(id(at("Funded"), "w"), "deliver");
  assert.equal(id(at("Funded"), "b"), "wait");
  assert.equal(id(at("Delivered"), "x"), "verify");
  assert.deepEqual(nextStep(at("Passed"), "x", true, NOW), {
    id: "settle",
    label: "Release the payment",
    jobId: 7,
    method: "release",
  });
  assert.equal(id(at("Verifying"), "b"), "wait");
});

test("funding closes near the end of a claim, and the worker is told not to spend early", () => {
  const closing = bid({
    state: "Claimed",
    claim: claim(7, NS + 30_000_000_000n),
    job: job("Challenged"),
  });
  assert.equal(id(closing, "b"), "wait");
  assert.match(
    nextStep(bid({ state: "Claimed", claim: claim(null) }), "w", true, NOW)
      ?.label ?? "",
    /spend nothing/,
  );
});

test("only the buyer gets to collect, and only released work", () => {
  const released = bid({
    state: "Done",
    last_job: { ...job("Released"), id: 7 },
  });
  assert.equal(id(released, "b"), "collect");
  assert.equal(id(released, "w"), null);
  const refunded = bid({
    state: "Open",
    last_job: { ...job("Refunded"), id: 7 },
  });
  assert.equal(id(refunded, "b"), "wait");
});

test("an expired bid can be closed by anyone, and a stuck job or an unsettled fee can be moved on", () => {
  const past = (NS - 1n).toString();
  assert.equal(id(bid({ expires_at: past }), "stranger"), "close");
  assert.equal(id(bid({ expires_at: past }), null), "wait");
  const stuck = (state: string, over: Record<string, unknown>) =>
    bid({
      state: "Claimed",
      claim: claim(7),
      job: { state, deadline: (NS + 1n).toString(), ...over } as MarketJob,
    });
  assert.equal(id(stuck("Funded", { deadline: past }), "stranger"), "expire");
  assert.equal(id(stuck("Funded", {}), "stranger"), "wait");
  assert.equal(
    id(
      stuck("Delivered", { delivered_at: "1", verdict_window_secs: 1 }),
      "stranger",
    ),
    "expire",
  );
  assert.equal(
    id(
      bid({
        state: "Open",
        last_job: { state: "Refunded", id: 7 } as MarketJob,
        fee_job_id: 7,
        fee: { state: "Held", amount: "1" },
      }),
      "stranger",
    ),
    "settle_fee",
  );
  assert.equal(
    id(bid({ funded_attempts: 3 }), "stranger"),
    "wait",
    "a bid with no attempts left takes no more applications",
  );
});
