import test from "node:test";
import assert from "node:assert/strict";
import { guardedCall, reconcilePending } from "../ui/pending-actions.ts";
import {
  actionSnapshot,
  PENDING_KEY,
  journalCall,
  type PendingAction,
} from "../ui/action-guard.ts";
import type { Market, Call } from "../ui/market-types.ts";
import type { MarketBid } from "../ui/market-steps.ts";
const bid = {
  id: 1,
  buyer: "buyer.testnet",
  claim: { agent: "worker.testnet", number: 1, job_id: null },
  candidate_job_id: null,
} as MarketBid;
const market: Market = {
  bids: [bid],
  agents: [],
  board: "board.testnet",
  escrow: "escrow.testnet",
  verifier_hash: "hash",
  paused: false,
};
const call: Call = {
  receiver: "escrow.testnet",
  method: "create_job",
  args: { worker: "worker.testnet" },
  deposit: 2n,
  gas: 70n,
};
function fixture() {
  const data = new Map<string, string>();
  let locked = false;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const locks = {
    request: async (
      _name: string,
      _options: unknown,
      callback: (value: object | null) => Promise<unknown>,
    ) => {
      if (locked) return callback(null);
      locked = true;
      try {
        return await callback({});
      } finally {
        locked = false;
      }
    },
  } as LockManager;
  const marker: PendingAction = {
    account: bid.buyer,
    bidId: 1,
    before: actionSnapshot(market, bid.buyer, 1),
    label: "Create",
    createdAt: 1,
  };
  const changes: (PendingAction | null)[] = [];
  return {
    storage,
    locks,
    marker,
    call,
    readMarket: async () => market,
    onFresh: () => {},
    onPending: (pending: PendingAction | null) => {
      changes.push(pending);
    },
    changes,
  };
}
test("two tabs cannot queue duplicate signing; successful but unobserved call stays journaled", async () => {
  const env = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  const first = guardedCall({
    ...env,
    send: async () => {
      sends++;
      await wait;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    guardedCall({
      ...env,
      send: async () => {
        sends++;
      },
    }),
    /Another tab/,
  );
  release();
  await first;
  assert.equal(sends, 1);
  assert.ok(env.storage.getItem(PENDING_KEY));
  await assert.rejects(
    guardedCall({
      ...env,
      send: async () => {
        sends++;
      },
    }),
    /earlier action/,
  );
  assert.equal(sends, 1);
});
test("stale tab must refresh instead of sending an obsolete Create action", async () => {
  const env = fixture();
  let sends = 0;
  await assert.rejects(
    guardedCall({
      ...env,
      readMarket: async () => ({
        ...market,
        bids: [{ ...bid, candidate_job_id: 5 }],
      }),
      send: async () => {
        sends++;
      },
    }),
    /changed/,
  );
  assert.equal(sends, 0);
  assert.equal(env.storage.getItem(PENDING_KEY), null);
});
test("unknown network error retains journal and unavailable storage prevents signing", async () => {
  const env = fixture();
  await assert.rejects(
    guardedCall({
      ...env,
      send: async () => {
        throw new Error("network timeout");
      },
    }),
    /timeout/,
  );
  assert.ok(env.storage.getItem(PENDING_KEY));
  const noStorage = fixture();
  let sent = false;
  await assert.rejects(
    guardedCall({
      ...noStorage,
      storage: {
        ...noStorage.storage,
        setItem: () => {
          throw new Error("quota");
        },
      },
      send: async () => {
        sent = true;
      },
    }),
    /quota/,
  );
  assert.equal(sent, false);
});
test("stale reconciliation cannot erase a newer journal", async () => {
  const env = fixture();
  const old = journalCall(env.marker, call);
  const next = { ...old, createdAt: 2 };
  env.storage.setItem(PENDING_KEY, JSON.stringify(next));
  const observed = { ...market, bids: [{ ...bid, candidate_job_id: 5 }] };
  await reconcilePending(env, old, observed);
  assert.equal(env.storage.getItem(PENDING_KEY), JSON.stringify(next));
  await reconcilePending(env, next, observed);
  assert.equal(env.storage.getItem(PENDING_KEY), null);
});
