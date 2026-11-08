import assert from "node:assert/strict";
import test from "node:test";
import { createStorageFinisher, nextNudge, type KeptBid } from "./keeper.ts";
const bid: KeptBid = {
  state: "Done",
  claim: null,
  fees: ["PaidToWorker"],
  storage_paid: "20",
  job_id: 7,
};
function fixture(rows: Array<[number, KeptBid]> = [[2, bid]]) {
  const calls: string[] = [];
  const failures: unknown[] = [];
  let paused = false;
  const deps = {
    readBids: async (from: number, limit: number) => {
      calls.push(`read:${from}`);
      return rows.slice(from, from + limit);
    },
    finishJob: async (id: number) => {
      calls.push(`job:${id}`);
    },
    finishBid: async (id: number) => {
      calls.push(`bid:${id}`);
    },
    suspended: () => paused,
    report: (_id: number, error: unknown) => {
      failures.push(error);
    },
  };
  return {
    calls,
    failures,
    deps,
    pause: () => {
      paused = true;
    },
  };
}
test("storage return orders escrow before board, skips unsettled fees, and records success once", async () => {
  const f = fixture([
    [1, { ...bid, fees: ["Held"] }],
    [2, bid],
  ]);
  const sweep = createStorageFinisher(f.deps);
  await sweep();
  await sweep();
  assert.deepEqual(f.calls, ["read:0", "job:7", "bid:2", "read:0"]);
});
test("failed escrow return leaves board untouched and retries on the next sweep", async () => {
  const f = fixture();
  let fail = true;
  f.deps.finishJob = async () => {
    f.calls.push("job:7");
    if (fail) throw new Error("transfer failed");
  };
  const sweep = createStorageFinisher(f.deps);
  await sweep();
  assert.deepEqual(f.calls, ["read:0", "job:7"]);
  assert.equal(f.failures.length, 1);
  fail = false;
  await sweep();
  assert.deepEqual(f.calls.slice(2), ["read:0", "job:7", "bid:2"]);
});
test("failed board return is retried and an already returned escrow is accepted", async () => {
  const f = fixture();
  let fail = true;
  f.deps.finishJob = async () => {
    throw new Error("no storage is left");
  };
  f.deps.finishBid = async () => {
    f.calls.push("bid:2");
    if (fail) throw new Error("temporary");
  };
  const sweep = createStorageFinisher(f.deps);
  await sweep();
  fail = false;
  await sweep();
  await sweep();
  assert.equal(f.calls.filter((x) => x === "bid:2").length, 2);
  assert.equal(f.failures.length, 1);
});
test("unknown submission pauses before reads and between escrow and board", async () => {
  const f = fixture();
  f.deps.finishJob = async () => {
    f.calls.push("job:7");
    f.pause();
  };
  const sweep = createStorageFinisher(f.deps);
  await sweep();
  await sweep();
  assert.deepEqual(f.calls, ["read:0", "job:7"]);
});
test("pagination finds later ended bids and overlapping sweeps cannot duplicate calls", async () => {
  const rows: Array<[number, KeptBid]> = Array.from({ length: 51 }, (_, i) => [
    i,
    { ...bid, job_id: null },
  ]);
  const f = fixture(rows);
  const sweep = createStorageFinisher(f.deps);
  await Promise.all([sweep(), sweep()]);
  assert.deepEqual(
    f.calls.filter((x) => x.startsWith("read")),
    ["read:0", "read:50"],
  );
  assert.equal(f.calls.filter((x) => x.startsWith("bid:")).length, 51);
});
test("expiry boundaries do not expire at the exact deadline", () => {
  const held = { check: false, deliverable: false };
  assert.equal(
    nextNudge({ state: "Funded", deadline: "100" }, 100n, held),
    null,
  );
  const job = {
    state: "Delivered",
    delivered_at: "100",
    verdict_window_secs: 1,
  };
  assert.equal(nextNudge(job, 1_000_000_100n, held), null);
  assert.deepEqual(nextNudge(job, 1_000_000_101n, held), {
    contract: "escrow",
    method: "expire",
  });
});
