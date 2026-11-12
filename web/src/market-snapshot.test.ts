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

test("the page gets a recent snapshot at once while a refresh runs; a fresh read waits for it", async (t) => {
  const { readMarketSnapshot } = await import("./market.ts");
  let release!: () => void;
  let gate: Promise<void> = Promise.resolve();
  let config = 1;
  t.mock.method(
    FallbackRpcProvider.prototype,
    "callFunction",
    async ({ method }: { method: string }) => {
      if (method === "get_config") {
        await gate;
        return {
          paused: false,
          verifier_hash: "hash",
          run_deposit: String(config),
        };
      }
      return [];
    },
  );
  // Past any earlier test's snapshot, so this read refreshes; the cache records real time.
  const first = (await readMarketCached(Date.now() + 100_000)) as {
    run_deposit: string;
  };
  const start = Date.now();
  config = 2;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Ten seconds later: the page is answered from the snapshot without waiting.
  const page = (await readMarketSnapshot(start + 10_000)) as {
    run_deposit: string;
  };
  assert.equal(page.run_deposit, first.run_deposit);
  // A fresh read shares the refresh already running and gets the new value.
  const fresh = readMarketCached(start + 10_000) as Promise<{
    run_deposit: string;
  }>;
  release();
  assert.equal((await fresh).run_deposit, "2");
});
