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

test("only a connected buyer is offered collection, and only an actually Released current job", () => {
  const paid = bid({ state: "Claimed", job: job("Released", { worker: "w" }) });
  assert.equal(id(paid, "b"), "collect");
  for (const viewer of ["w", "stranger", null])
    assert.notEqual(id(paid, viewer), "collect");
  for (const state of [
    "Open",
    "Funded",
    "Delivered",
    "Verifying",
    "Passed",
    "Failed",
    "RefundDue",
    "Refunding",
    "Refunded",
    "Releasing",
    "Expiring",
    "Unknown",
  ]) {
    const current = bid({
      state: "Claimed",
      job: job(state, {
        worker: "w",
        history: [
          {
            worker: "old-worker",
            outcome: "Paid",
            failed_rule: null,
            verdict_request_id: "old-request",
          },
        ],
      }),
    });
    for (const viewer of ["b", "w", "stranger", null])
      assert.notEqual(id(current, viewer), "collect", `${state} / ${viewer}`);
  }
});

test("job zero is usable, but a missing current job cannot borrow payment authority from last_job", () => {
  assert.equal(
    nextStep(
      bid({ job_id: 0, job: job("Released", { id: 0 }) }),
      "b",
      true,
      NOW,
    )?.id,
    "collect",
  );
  assert.equal(
    (
      nextStep(
        bid({ job_id: null, job: job("Released", { id: 0 }) }),
        "b",
        true,
        NOW,
      ) as { jobId?: number }
    )?.jobId,
    0,
  );
  assert.equal(
    (
      nextStep(
        bid({ job_id: 0, job: job("Released", { id: 7 }) }),
        "b",
        true,
        NOW,
      ) as { jobId?: number }
    )?.jobId,
    0,
  );
  assert.notEqual(
    id(
      bid({
        job_id: null,
        job: null,
        last_job: job("Released"),
        state: "Done",
      }),
      "b",
    ),
    "collect",
  );
  assert.notEqual(
    id(
      bid({ job: job("Funded", { worker: "w" }), last_job: job("Released") }),
      "b",
    ),
    "collect",
  );
  assert.notEqual(
    id(bid({ job_id: null, job: job("Released", { id: null }) }), "b"),
    "collect",
  );
});

test("bid expiry closes at the exact boundary without interrupting an assigned worker", () => {
  const ending = bid({ expires_at: NS.toString() });
  assert.equal(nextStep(ending, "w", true, NOW - 1)?.id, "claim");
  assert.equal(nextStep(ending, "w", true, NOW)?.id, "close");
  assert.equal(nextStep(ending, null, true, NOW)?.id, "wait");
  const assigned = {
    ...ending,
    state: "Claimed",
    job: job("Funded", {
      worker: "w",
      deadline: (NS + 60_000_000_000n).toString(),
    }),
  };
  assert.equal(nextStep(assigned, "w", true, NOW)?.id, "deliver");
  assert.notEqual(nextStep(assigned, "stranger", true, NOW)?.id, "close");
});

test("delivery and verdict deadlines expire only after their exact chain boundary", () => {
  const funded = bid({
    state: "Claimed",
    job: job("Funded", { worker: "w", deadline: NS.toString() }),
  });
  assert.equal(nextStep(funded, "w", true, NOW)?.id, "deliver");
  assert.equal(nextStep(funded, "stranger", true, NOW + 1)?.id, "expire");
  const delivered = bid({
    state: "Claimed",
    job: job("Delivered", {
      worker: "w",
      delivered_at: (NS - 60_000_000_000n).toString(),
      verdict_window_secs: 60,
    }),
  });
  assert.equal(nextStep(delivered, "stranger", true, NOW)?.id, "verify");
  assert.equal(nextStep(delivered, "stranger", true, NOW + 1)?.id, "expire");
});

test("an in-flight run needs both expired verdict time and a strictly stale run before expiry", () => {
  const at = (
    deliveredAgoSeconds: bigint,
    windowSeconds: number,
    runAgoSeconds: bigint,
  ) =>
    bid({
      state: "Claimed",
      job: job("Verifying", {
        worker: "w",
        delivered_at: (NS - deliveredAgoSeconds * 1_000_000_000n).toString(),
        verdict_window_secs: windowSeconds,
        run_started_at: (NS - runAgoSeconds * 1_000_000_000n).toString(),
      }),
    });
  assert.equal(id(at(1000n, 1200, 901n), "stranger"), "wait");
  assert.equal(id(at(1000n, 60, 899n), "stranger"), "wait");
  assert.equal(id(at(1000n, 60, 900n), "stranger"), "wait");
  assert.equal(id(at(1000n, 60, 901n), "stranger"), "expire");
  assert.equal(
    id(
      bid({
        job: job("Verifying", { delivered_at: null, run_started_at: "1" }),
      }),
      "stranger",
    ),
    "wait",
  );
  assert.equal(
    id(
      bid({
        job: job("Verifying", { delivered_at: "1", run_started_at: null }),
      }),
      "stranger",
    ),
    "wait",
  );
});

test("the relay gets the full stalled interval and the UI never releases a failed attempt", () => {
  const boundary = (NS - 20n * 60n * 1_000_000_000n).toString();
  for (const state of ["Passed", "Failed"]) {
    const current = bid({
      state: "Claimed",
      job: job(state, { delivered_at: boundary }),
    });
    assert.equal(nextStep(current, "stranger", true, NOW)?.id, "wait");
    const after = nextStep(current, "stranger", true, NOW + 1);
    assert.equal(after?.id, "settle");
    assert.equal(
      (after as { method?: string }).method,
      state === "Passed" ? "release" : "refund",
    );
  }
  assert.equal(
    id(bid({ job: job("Passed", { delivered_at: null }) }), "stranger"),
    "wait",
  );
});

test("assignment and terminal bookkeeping cannot offer a second claim or payout", () => {
  for (const viewer of ["b", "w", "stranger", null])
    assert.equal(id(bid({ state: "Assigning" }), viewer), "wait");
  assert.equal(id(bid({ max_attempts: 1, funded_attempts: 1 }), "w"), "wait");
  assert.equal(id(bid({ max_attempts: 1, funded_attempts: 0 }), "w"), "claim");
  for (const state of ["Done", "Closed", "Cancelled"]) {
    const current = bid({
      state,
      job: job("Refunded"),
      fees: ["ReturnedToBuyer"],
    });
    for (const viewer of ["b", "w", "stranger", null])
      assert.equal(id(current, viewer), null);
  }
  assert.equal(
    id(
      bid({ state: "Cancelled", job: job("Refunded"), fees: ["Held"] }),
      "stranger",
    ),
    "sync",
  );
  assert.equal(
    id(bid({ state: "Cancelled", job: job("Refunded"), fees: ["Held"] }), null),
    null,
  );
  assert.equal(
    id(
      bid({ state: "Closed", job: job("Refunded"), fees: ["Paying"] }),
      "stranger",
    ),
    null,
  );
});

// Refund callbacks clear delivered_at: recovery must not depend on that earlier timestamp.
test("refund retry and record sync remain available after delivery metadata is cleared", () => {
  const refund = bid({
    state: "Claimed",
    job: job("RefundDue", { delivered_at: null }),
  });
  const step = nextStep(refund, "stranger", true, NOW);
  assert.equal(step?.id, "settle");
  assert.equal((step as { method?: string }).method, "refund");
  assert.equal(
    nextStep(
      bid({ state: "Claimed", job: job("Refunded", { delivered_at: null }) }),
      "b",
      true,
      NOW,
    )?.id,
    "sync",
  );
  assert.notEqual(nextStep(refund, "stranger", true, NOW)?.id, "collect");
});

test("refund recovery waits for a connected wallet and cannot offer a second payment", () => {
  for (const state of ["RefundDue", "Refunded"]) {
    const current = bid({
      state: "Claimed",
      job: job(state, { delivered_at: null }),
    });
    assert.equal(nextStep(current, null, true, NOW)?.id, "wait");
    assert.notEqual(nextStep(current, "stranger", true, NOW)?.id, "claim");
    assert.notEqual(
      (nextStep(current, "stranger", true, NOW) as { method?: string }).method,
      "release",
    );
  }
});
