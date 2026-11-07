import assert from "node:assert/strict";
import test from "node:test";
import { jobProgress } from "../ui/job-progress.ts";
import type { MarketBid } from "../ui/market-steps.ts";

const bid = (values: Record<string, unknown>) =>
  ({
    state: "Open",
    claim: null,
    job: null,
    last_job: null,
    ...values,
  }) as unknown as MarketBid;
const current = (value: MarketBid) =>
  jobProgress(value).find((stage) => stage.status === "current")?.label;

test("a new bid waits for its review", () => {
  assert.equal(current(bid({ state: "Unreviewed" })), "Reviewed");
});
test("an open bid waits for a claim", () => {
  assert.equal(current(bid({})), "Claimed");
});
test("a funded job waits for delivery", () => {
  assert.equal(
    current(bid({ state: "Claimed", job: { state: "Funded" } })),
    "Delivered",
  );
});
test("a paid job has every stage done and says paid", () => {
  const stages = jobProgress(
    bid({ state: "Done", last_job: { state: "Released" } }),
  );
  assert.ok(stages.every((stage) => stage.status === "done"));
  assert.equal(stages.at(-1)?.label, "Paid");
});
test("a refund and a blocked bid are shown as failures, never as passing", () => {
  const refunded = jobProgress(bid({ last_job: { state: "Refunded" } }));
  assert.equal(refunded[6]?.status, "failed");
  assert.equal(refunded[7]?.label, "Refunded");
  assert.equal(jobProgress(bid({ state: "Blocked" }))[1]?.status, "failed");
});
