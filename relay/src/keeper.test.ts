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
