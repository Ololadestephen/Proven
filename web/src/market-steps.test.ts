import assert from "node:assert/strict";
import test from "node:test";
import {
  nextStep,
  type MarketBid,
  type MarketJob,
} from "../ui/market-steps.ts";

const NOW = 1_800_000_000_000;
const NS = BigInt(NOW) * 1_000_000n;
const job = (state: string, over: Partial<MarketJob> = {}): MarketJob =>
  ({
    id: 7,
    state,
    buyer: "b",
    worker: null,
    amount: "10000000000000000000000",
    deadline: "9000000000000000000",
    history: [],
    ...over,
  }) as MarketJob;
const bid = (over: Partial<MarketBid> = {}): MarketBid =>
  ({
    id: 1,
    buyer: "b",
    state: "Open",
    amount: "10000000000000000000000",
    job_id: 7,
    max_attempts: 3,
    claim: null,
    job: job("Open"),
    last_job: null,
    allowed_workers: null,
    expires_at: "9000000000000000000",
    format: "{}",
    format_hash: "f".repeat(64),
    funded_attempts: 0,
    fees: ["Held", "Held", "Held"],
    ...over,
  }) as MarketBid;
const id = (b: MarketBid, viewer: string | null, registered = true) =>
  nextStep(b, viewer, registered, NOW)?.id ?? null;

test("a bid still being created only waits", () => {
  assert.equal(
    id(bid({ state: "Pending", job: null, job_id: null }), "b"),
    "wait",
  );
});

test("anyone signed in can start the review, and the buyer can resend the check", () => {
  const unreviewed = bid({ state: "Unreviewed", job: job("Draft") });
  assert.equal(id(unreviewed, "b"), "review");
  assert.equal(id(unreviewed, "w"), "review");
  assert.equal(id(unreviewed, null), "wait");
  const draft = bid({ job: job("Draft") });
  assert.equal(id(draft, "b"), "send_check");
  assert.equal(id(draft, "w"), "wait");
});

test("a blocked bid lets only its buyer get the money back", () => {
  const blocked = bid({ state: "Blocked" });
  assert.equal(id(blocked, "b"), "close");
  assert.equal(id(blocked, "w"), null);
});

test("a worker registers, then applies, and the buyer only waits", () => {
  assert.equal(id(bid(), "w", false), "register");
  assert.equal(id(bid(), "w"), "claim");
  assert.equal(id(bid(), "b"), "wait");
  assert.equal(id(bid(), null), "wait");
  assert.equal(id(bid({ allowed_workers: ["x"] }), "w"), "wait");
  assert.equal(id(bid({ funded_attempts: 3 }), "w"), "wait");
});

test("no step asks the buyer to sign before a worker delivers", () => {
  for (const state of ["Draft", "Challenging", "Open", "Funded"])
    assert.notEqual(
      ["claim", "deliver", "settle", "close"].includes(
        id(bid({ state: "Claimed", job: job(state, { worker: "w" }) }), "b") ??
          "",
      ),
      true,
      state,
    );
});

test("each job state gives the right step", () => {
  const at = (state: string, over: Partial<MarketJob> = {}) =>
    bid({
      state: "Claimed",
      claim: { number: 1, agent: "w" },
      job: job(state, { worker: "w", ...over }),
    });
  assert.equal(id(at("Funded"), "w"), "deliver");
  assert.equal(id(at("Funded"), "b"), "wait");
  assert.equal(id(at("Delivered"), "x"), "verify");
  // The relay pays out and closes attempts itself, so nobody is asked to, unless it stalls.
  assert.equal(
    id(at("Passed", { delivered_at: (NS - 1n).toString() }), "b"),
    "wait",
  );
  assert.equal(
    id(at("Failed", { delivered_at: (NS - 1n).toString() }), "x"),
    "wait",
  );
  const longAgo = (NS - 21n * 60n * 1_000_000_000n).toString();
  assert.deepEqual(
    nextStep(at("Passed", { delivered_at: longAgo }), "x", true, NOW),
    {
      id: "settle",
      label: "Nothing happened: send the payment now",
      jobId: 7,
      method: "release",
    },
  );
  assert.equal(
    (
      nextStep(at("Failed", { delivered_at: longAgo }), "x", true, NOW) as {
        method?: string;
      }
    ).method,
    "refund",
  );
  // Paid: the buyer collects at once, even before the bid's record catches up.
  assert.equal(id(at("Released"), "b"), "collect");
  assert.equal(id(at("Released"), "x"), "wait");
  assert.equal(id(at("Verifying"), "b"), "wait");
  assert.equal(id(bid({ state: "Claimed", job: job("Open") }), "x"), "sync");
});

test("a missed deadline or verdict window can be ended by anyone", () => {
  const past = (NS - 1n).toString();
  const funded = bid({
    state: "Claimed",
    job: job("Funded", { worker: "w", deadline: past }),
  });
  assert.equal(id(funded, "stranger"), "expire");
  const delivered = bid({
    state: "Claimed",
    job: job("Delivered", {
      worker: "w",
      delivered_at: "1",
      verdict_window_secs: 1,
    }),
  });
  assert.equal(id(delivered, "stranger"), "expire");
});

test("an ended bid with no worker on it can be closed by anyone signed in", () => {
  const past = (NS - 1n).toString();
  assert.equal(id(bid({ expires_at: past }), "stranger"), "close");
  assert.equal(id(bid({ expires_at: past }), null), "wait");
  // A worker on it keeps it running.
  assert.equal(
    id(
      bid({
        expires_at: past,
        state: "Claimed",
        job: job("Funded", { worker: "w" }),
      }),
      "stranger",
    ),
    "wait",
  );
});

test("only the buyer collects, and only paid work", () => {
  const done = bid({ state: "Done", job: job("Released", { worker: "w" }) });
  assert.equal(id(done, "b"), "collect");
  assert.equal(id(done, "w"), null);
  const closed = bid({
    state: "Closed",
    job: job("Refunded"),
    fees: ["ReturnedToBuyer"],
  });
  assert.equal(id(closed, "b"), null);
  assert.equal(
    id(bid({ state: "Closed", job: job("Refunded"), fees: ["Held"] }), "x"),
    "sync",
  );
});
