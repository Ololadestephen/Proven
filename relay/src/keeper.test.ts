import assert from "node:assert/strict";
import test from "node:test";
import { boardBehind, nextNudge, storageDue } from "./keeper.ts";

const NOW = 2_000_000_000_000_000_000n;
const held = { check: true, deliverable: true };

test("a recorded verdict is paid out or refunded, never decided here", () => {
  assert.deepEqual(nextNudge({ state: "Passed" }, NOW, held), {
    contract: "escrow",
    method: "release",
  });
  assert.deepEqual(nextNudge({ state: "Failed" }, NOW, held), {
    contract: "escrow",
    method: "refund",
  });
  assert.equal(nextNudge({ state: "Verifying" }, NOW, held), null);
});

test("an attempt expires only after its deadline or verdict window", () => {
  const before = (NOW + 1n).toString();
  const after = (NOW - 1n).toString();
  assert.equal(
    nextNudge({ state: "Funded", deadline: before }, NOW, held),
    null,
  );
  assert.deepEqual(nextNudge({ state: "Funded", deadline: after }, NOW, held), {
    contract: "escrow",
    method: "expire",
  });
  const delivered = {
    state: "Delivered",
    delivered_at: NOW.toString(),
    verdict_window_secs: 1_800,
  };
  assert.deepEqual(nextNudge(delivered, NOW, held), { run: "Verify" });
  assert.deepEqual(
    nextNudge(delivered, NOW, { check: true, deliverable: false }),
    null,
  );
  assert.deepEqual(nextNudge(delivered, NOW + 1_801_000_000_000n, held), {
    contract: "escrow",
    method: "expire",
  });
});

test("a challenge is retried only if the relay holds the check", () => {
  assert.deepEqual(nextNudge({ state: "Draft" }, NOW, held), {
    run: "Challenge",
  });
  assert.equal(
    nextNudge({ state: "Draft" }, NOW, { check: false, deliverable: false }),
    null,
  );
});

test("a paid job's leftover budget is returned once", () => {
  assert.deepEqual(
    nextNudge({ state: "Released", compute_budget: "5" }, NOW, held),
    {
      contract: "escrow",
      method: "return_budget",
    },
  );
  assert.equal(
    nextNudge({ state: "Released", compute_budget: "0" }, NOW, held),
    null,
  );
});

test("the board is synced only when it is behind its job", () => {
  const claimed = {
    state: "Claimed",
    claim: { agent: "w" },
    fees: ["Held", "Held"],
  };
  assert.equal(boardBehind(claimed, { state: "Funded", worker: "w" }), false);
  assert.equal(
    boardBehind(claimed, {
      state: "Open",
      worker: null,
      history: [{ worker: "w", outcome: "Failed" }],
    }),
    true,
  );
  assert.equal(boardBehind(claimed, { state: "Released", worker: "w" }), true);
  assert.equal(
    boardBehind(
      { state: "Open", claim: null, fees: ["Paying", "Held"] },
      { state: "Open", history: [{ worker: "w", outcome: "Failed" }] },
    ),
    false,
  );
  assert.equal(
    boardBehind(
      { state: "Done", claim: null, fees: ["ReturnedToBuyer"] },
      { state: "Released" },
    ),
    false,
  );
  assert.equal(
    boardBehind(
      { state: "Done", claim: null, fees: ["Held"] },
      { state: "Released" },
    ),
    true,
  );
});

test("storage goes back only from an ended bid with its fees settled, once", () => {
  const ended = {
    state: "Closed",
    claim: null,
    fees: ["PaidToWorker", "ReturnedToBuyer"],
    storage_paid: "1000",
    finished: false,
  };
  assert.equal(storageDue(ended), true);
  assert.equal(storageDue({ ...ended, finished: true }), false);
  assert.equal(storageDue({ ...ended, storage_paid: "0" }), false);
  assert.equal(storageDue({ ...ended, fees: ["Paying"] }), false);
  assert.equal(storageDue({ ...ended, state: "Open" }), false);
  // A bid from before this version records no storage payment.
  assert.equal(storageDue({ state: "Done", claim: null, fees: [] }), false);
});

test("a failed refund transfer is retried without delivery metadata, while in-flight transfers are left alone", () => {
  assert.deepEqual(
    nextNudge({ state: "RefundDue", delivered_at: null }, NOW, held),
    { contract: "escrow", method: "refund" },
  );
  for (const state of [
    "Releasing",
    "Refunding",
    "Expiring",
    "Challenging",
    "Verifying",
    "Refunded",
  ])
    assert.equal(
      nextNudge(
        { state, compute_budget: "1000000000000000000000000" },
        NOW,
        held,
      ),
      null,
      state,
    );
});

test("missing private texts cannot prevent expiry or authorize verification of unpaid work", () => {
  const absent = { check: false, deliverable: false };
  assert.deepEqual(
    nextNudge(
      { state: "Funded", deadline: (NOW - 1n).toString() },
      NOW,
      absent,
    ),
    { contract: "escrow", method: "expire" },
  );
  assert.deepEqual(
    nextNudge(
      {
        state: "Delivered",
        delivered_at: (NOW - 2_000_000_000n).toString(),
        verdict_window_secs: 1,
      },
      NOW,
      absent,
    ),
    { contract: "escrow", method: "expire" },
  );
  assert.equal(nextNudge({ state: "Funded" }, NOW, held), null);
  assert.equal(nextNudge({ state: "Released" }, NOW, held), null);
});

test("board sync follows unsettled attempts and final refunds without repeating settled bookkeeping", () => {
  const open = { state: "Open", claim: null, fees: ["ReturnedToBuyer"] };
  assert.equal(boardBehind(open, { state: "CheckRejected" }), true);
  assert.equal(boardBehind(open, { state: "Refunded" }), true);
  assert.equal(
    boardBehind(open, {
      state: "Open",
      history: [
        { worker: "first", outcome: "Failed" },
        { worker: "second", outcome: "Expired" },
      ],
    }),
    true,
  );
  assert.equal(
    boardBehind(open, {
      state: "Open",
      history: [{ worker: "first", outcome: "Failed" }],
    }),
    false,
  );
  const ended = { state: "Closed", claim: null, fees: ["Held"] };
  assert.equal(boardBehind(ended, { state: "Refunded" }), true);
  assert.equal(boardBehind(ended, { state: "Refunding" }), false);
  assert.equal(
    boardBehind({ ...ended, fees: ["ReturnedToBuyer"] }, { state: "Refunded" }),
    false,
  );
});

test("refundable storage never skips an unsettled or unknown fee state", () => {
  for (const state of ["Done", "Closed", "Cancelled"]) {
    const ended = { state, claim: null, storage_paid: "1", finished: false };
    assert.equal(storageDue({ ...ended, fees: [] }), true, state);
    for (const fee of ["Held", "Paying", "Unknown"])
      assert.equal(
        storageDue({ ...ended, fees: ["ReturnedToBuyer", fee] }),
        false,
        `${state}:${fee}`,
      );
  }
});
