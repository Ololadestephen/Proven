import assert from "node:assert/strict";
import test from "node:test";
import { FallbackRpcProvider } from "../../relay/src/rpc.ts";
import { readMarketCached } from "./market.ts";

test("a slow refresh is shared and a failed refresh marks the prior snapshot stale", async (t) => {
  const now = Date.now();
  let fail = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  t.mock.method(
    FallbackRpcProvider.prototype,
    "callFunction",
    async ({ method }: { method: string }) => {
      calls++;
      if (fail) throw new Error("Temporary outage");
      if (method === "get_config") {
        await pending;
        return { paused: false, verifier_hash: "hash", run_deposit: "10" };
      }
      if (method === "get_bids" || method === "get_agents") return [];
      assert.fail("Unexpected board read");
    },
  );
  const first = readMarketCached(now);
  assert.equal(readMarketCached(now + 5_000), first);
  release();
  const snapshot = (await first) as Record<string, unknown>;
  assert.deepEqual(snapshot.bids, []);
  assert.equal(snapshot.snapshot_stale, undefined);
  assert.equal(calls, 3);

  fail = true;
  assert.deepEqual(await readMarketCached(now + 10_000), {
    ...snapshot,
    snapshot_stale: true,
  });
  assert.equal(calls, 4);
  fail = false;
  assert.deepEqual(await readMarketCached(now + 20_000), snapshot);
  assert.equal(calls, 7);
});
