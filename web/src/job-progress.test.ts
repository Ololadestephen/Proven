import assert from "node:assert/strict";
import test from "node:test";
import { jobProgress, workerProgress } from "../ui/job-progress.ts";
import type { MarketBid } from "../ui/market-steps.ts";

const bid = (values: Record<string, unknown>) =>
  ({
    state: "Open",
    review: { allow: true },
    claim: null,
    job: null,
    last_job: null,
    ...values,
  }) as unknown as MarketBid;
const current = (value: MarketBid) =>
  jobProgress(value).find((stage) => stage.status === "current")?.label;

test("a new bid waits for its review", () => {
  assert.equal(
    current(
      bid({ state: "Unreviewed", review: null, job: { state: "Draft" } }),
    ),
    "Reviewed",
  );
});
test("a reviewed bid waits for its check to be tested, then for a worker", () => {
  assert.equal(current(bid({ job: { state: "Challenging" } })), "Check tested");
  assert.equal(
    current(bid({ job: { state: "Open", worker: null } })),
    "Claimed",
  );
});
test("a job with a worker waits for delivery", () => {
  assert.equal(
    current(bid({ state: "Claimed", job: { state: "Funded", worker: "w" } })),
    "Delivered",
  );
});
test("a paid job has every stage done and says paid", () => {
  const stages = jobProgress(
    bid({
      state: "Done",
      job: {
        state: "Released",
        worker: "w",
        delivered_at: "1",
        history: [{ worker: "w", outcome: "Paid" }],
      },
    }),
  );
  assert.ok(stages.every((stage) => stage.status === "done"));
  assert.equal(stages.at(-1)?.label, "Paid");
});
test("a refund, a rejected check and a blocked bid show as failures, never as success", () => {
  const refunded = jobProgress(
    bid({
      state: "Closed",
      job: {
        state: "Refunded",
        delivered_at: null,
        history: [{ worker: "w", outcome: "Failed" }],
      },
    }),
  );
  assert.equal(refunded[5]?.status, "failed");
  assert.equal(refunded[6]?.label, "Refunded");
  assert.equal(refunded[6]?.status, "failed");
  assert.equal(
    jobProgress(bid({ job: { state: "CheckRejected" } }))[2]?.status,
    "failed",
  );
  assert.equal(
    jobProgress(bid({ state: "Blocked", job: { state: "Open" } }))[1]?.status,
    "failed",
  );
});
test("a worker sees four stages", () => {
  assert.deepEqual(
    workerProgress(bid({ job: { state: "Funded", worker: "w" } })).map(
      (stage) => stage.label,
    ),
    ["Applied", "Delivered", "Verdict", "Paid"],
  );
});

test("a refund with no verdict never shows the work as verified", () => {
  for (const outcome of ["NoDelivery", "NoVerdict"]) {
    const stages = jobProgress(
      bid({
        state: "Closed",
        job: {
          state: "Refunded",
          worker: "w",
          delivered_at: outcome === "NoVerdict" ? "1" : null,
          verdict_request_id: null,
          history: [{ worker: "w", outcome }],
        },
      }),
    );
    const verified = stages.find((stage) => stage.id === "verified");
    assert.notEqual(verified?.status, "done", outcome);
    assert.notEqual(verified?.status, "failed", outcome);
    assert.equal(stages.at(-1)?.status, "failed");
  }
  const paid = jobProgress(
    bid({
      state: "Closed",
      job: { state: "Released", worker: "w", verdict_request_id: "9" },
    }),
  );
  assert.equal(paid.find((stage) => stage.id === "verified")?.status, "done");
});
