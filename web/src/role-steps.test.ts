import assert from "node:assert/strict";
import test from "node:test";
import type { MarketBid, Step } from "../ui/market-steps.ts";
import {
  roleOf,
  stepForViewer,
  WORKER_VERIFY_AFTER_MS,
} from "../ui/role-steps.ts";

const NOW = 1_800_000_000_000;
const bid = (job: Record<string, unknown> | null, over = {}) =>
  ({
    buyer: "b",
    amount: "1000000000000000000000",
    claim: { agent: "w" },
    job,
    last_job: null,
    ...over,
  }) as unknown as MarketBid;
const verify: Step = { id: "verify", label: "Run verification", jobId: 1 };

test("each account sees its own role", () => {
  const value = bid({ worker: "w" });
  assert.equal(roleOf(value, "b"), "buyer");
  assert.equal(roleOf(value, "w"), "worker");
  assert.equal(roleOf(value, "x"), "visitor");
  assert.equal(roleOf(value, null), "visitor");
});

test("only the worker is offered verification", () => {
  assert.equal(stepForViewer(verify, bid(null), "buyer", NOW, "b")?.id, "wait");
});

test("the buyer sees every other step unchanged", () => {
  const step: Step = { id: "sync", label: "Update the bid" };
  assert.equal(stepForViewer(step, bid(null), "buyer", NOW, "b"), step);
});

test("the worker waits for the buyer to verify, then may run it", () => {
  const delivered = (BigInt(NOW - 60_000) * 1_000_000n).toString();
  const early = stepForViewer(
    verify,
    bid({ state: "Delivered", delivered_at: delivered }),
    "worker",
    NOW,
    "w",
  );
  assert.equal(early?.id, "wait");
  const late = stepForViewer(
    verify,
    bid({ state: "Delivered", delivered_at: delivered }),
    "worker",
    NOW + WORKER_VERIFY_AFTER_MS,
    "w",
  );
  assert.equal(late?.id, "verify");
});

test("after the end the worker sees the outcome, not bookkeeping", () => {
  const sync: Step = { id: "sync", label: "Update the bid" };
  const paid = stepForViewer(
    sync,
    bid(null, {
      last_job: {
        state: "Released",
        amount: "1000000000000000000000",
        worker: "w",
      },
    }),
    "worker",
    NOW,
    "w",
  );
  assert.equal(paid?.id, "wait");
  assert.match(paid?.label ?? "", /Paid/);
  const failed = stepForViewer(
    sync,
    bid(null, {
      last_job: {
        state: "Refunded",
        worker: null,
        history: [{ worker: "w", outcome: "Failed", failed_rule: "totals" }],
      },
    }),
    "worker",
    NOW,
    "w",
  );
  assert.match(failed?.label ?? "", /Not paid.*totals/);
});

test("a worker whose attempt failed sees its own result from the escrow's record", () => {
  const sync: Step = { id: "sync", label: "Update the bid" };
  const value = bid(
    {
      state: "Open",
      worker: null,
      history: [{ worker: "w", outcome: "NoDelivery" }],
    },
    { claim: null },
  );
  assert.equal(roleOf(value, "w"), "worker");
  assert.match(
    stepForViewer(sync, value, "worker", NOW, "w")?.label ?? "",
    /no delivery arrived/,
  );
});

test("a visitor can apply, and sees nothing of a job in progress", () => {
  const claim: Step = { id: "claim", label: "Apply" };
  assert.equal(stepForViewer(claim, bid(null), "visitor", NOW, "x"), claim);
  assert.equal(
    stepForViewer(verify, bid(null), "visitor", NOW, "x")?.id,
    "wait",
  );
});

test("after two attempts, each worker sees only its own result", () => {
  const value = bid(
    {
      state: "Released",
      worker: "second",
      amount: "1000000000000000000000",
      history: [
        { worker: "first", outcome: "Failed", failed_rule: "sum" },
        { worker: "second", outcome: "Paid", failed_rule: null },
      ],
    },
    { claim: { agent: "second" } },
  );
  const step: Step = { id: "sync", label: "Update the bid" };
  const first = stepForViewer(step, value, "worker", NOW, "first");
  assert.match(first?.label ?? "", /failed the rule “sum”/);
  assert.match(
    stepForViewer(step, value, "worker", NOW, "second")?.label ?? "",
    /^Paid/,
  );
  const settle: Step = {
    id: "settle",
    label: "Settle",
    method: "release",
  } as Step;
  assert.equal(
    stepForViewer(settle, value, "worker", NOW, "first")?.id,
    "wait",
  );
  assert.doesNotMatch(
    stepForViewer(settle, value, "worker", NOW, "first")?.label ?? "",
    /get paid/,
  );
});
