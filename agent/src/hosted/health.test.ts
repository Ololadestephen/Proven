import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "../config.ts";
import type { BoardClient } from "../board.ts";
import {
  healthBalances,
  healthReport,
  MAINNET_RELAY_ACCOUNT,
  MAINNET_RELAY_MINIMUM,
} from "./health.ts";

const NEAR = 10n ** 24n;
const mainnet = {
  escrow: "proven-escrow.near",
  rpc: "https://rpc.mainnet.near.org",
} as Config;
const board: Pick<BoardClient, "now" | "view" | "bids"> = {
  now: async () => 1_000_000_000_000n,
  view: async <T>(method: string) => {
    assert.equal(method, "get_config");
    return { next_job_id: 0 } as T;
  },
  bids: async () => [],
};

function report(
  balance: bigint,
  balances: Parameters<typeof healthReport>[0]["balances"] = [],
) {
  const reads: string[] = [];
  return {
    reads,
    result: healthReport({
      config: mainnet,
      board,
      balances,
      balance: async (account) => {
        reads.push(account);
        return balance;
      },
      spentNanoUsd: 0,
      limitNanoUsd: 1,
    }),
  };
}

test("mainnet always watches the relay at a minimum of 0.25 NEAR", () => {
  assert.deepEqual(healthBalances(mainnet.escrow, []), [
    {
      name: "The relay",
      account: MAINNET_RELAY_ACCOUNT,
      minimum: MAINNET_RELAY_MINIMUM,
    },
  ]);
  const supplied = {
    name: "Run payer",
    account: MAINNET_RELAY_ACCOUNT,
    minimum: (15n * NEAR) / 100n,
  };
  assert.equal(
    healthBalances(mainnet.escrow, [supplied])[0]?.minimum,
    MAINNET_RELAY_MINIMUM,
  );
  assert.equal(
    healthBalances(mainnet.escrow, [{ ...supplied, minimum: NEAR / 2n }])[0]
      ?.minimum,
    NEAR / 2n,
  );
  assert.equal(
    healthBalances(mainnet.escrow, [
      supplied,
      { ...supplied, minimum: NEAR / 2n },
    ]).length,
    1,
  );
  assert.equal(
    supplied.minimum,
    (15n * NEAR) / 100n,
    "caller data is not mutated",
  );
});

test("a relay one yocto below 0.25 warns with the run gas reason; at or above the threshold does not", async () => {
  const low = report(MAINNET_RELAY_MINIMUM - 1n);
  const result = await low.result;
  assert.deepEqual(low.reads, [MAINNET_RELAY_ACCOUNT]);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0]?.kind, "low_balance");
  assert.match(result.alerts[0]!.detail, /proven-relay\.near/);
  assert.match(result.alerts[0]!.detail, /0\.25 NEAR minimum/);
  assert.match(result.alerts[0]!.detail, /reserves about 0\.2 NEAR for gas/);
  for (const balance of [MAINNET_RELAY_MINIMUM, MAINNET_RELAY_MINIMUM + 1n]) {
    assert.deepEqual((await report(balance).result).alerts, []);
  }
});

test("the actual health check raises a caller's lower threshold and preserves a higher one", async () => {
  const watch = {
    name: "Relay",
    account: MAINNET_RELAY_ACCOUNT,
    minimum: NEAR / 10n,
  };
  assert.equal(
    (await report(NEAR / 5n, [watch]).result).alerts[0]?.kind,
    "low_balance",
  );
  const higher = await report((3n * NEAR) / 10n, [
    { ...watch, minimum: NEAR / 2n },
  ]).result;
  assert.equal(higher.alerts[0]?.kind, "low_balance");
  assert.match(higher.alerts[0]!.detail, /0\.5 NEAR minimum/);
});

test("testnet health never queries the mainnet relay, including a stale caller setting", async () => {
  const treasury = {
    name: "Treasury",
    account: "treasury.testnet",
    minimum: NEAR / 10n,
  };
  const stale = {
    name: "Wrong-network relay",
    account: MAINNET_RELAY_ACCOUNT,
    minimum: NEAR / 10n,
  };
  const reads: string[] = [];
  const result = await healthReport({
    config: { ...mainnet, escrow: "escrow-v5.proven.testnet" },
    board,
    balances: [treasury, stale],
    balance: async (account) => {
      reads.push(account);
      return NEAR;
    },
    spentNanoUsd: 0,
    limitNanoUsd: 1,
  });
  assert.deepEqual(reads, [treasury.account]);
  assert.deepEqual(result.alerts, []);
  assert.deepEqual(healthBalances("escrow.testnet", []), []);
});

test("credit alerts distinguish low estimated credit, stale snapshots and unavailable provider balance", async () => {
  const { inferenceCreditAlerts } = await import("./health.ts");
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(
    inferenceCreditAlerts(null, now)[0]?.kind,
    "credit_snapshot_unavailable",
  );
  assert.deepEqual(
    inferenceCreditAlerts(
      { usd: 10, spentSinceUsd: 1, asOf: "2026-11-08T00:00:00Z" },
      now,
    ),
    [],
  );
  const low = inferenceCreditAlerts(
    { usd: 1, spentSinceUsd: 0.3, asOf: "2026-11-08T00:00:00Z" },
    now,
  );
  assert.equal(low[0]?.kind, "low_inference_credit");
  assert.match(low[0]!.detail, /owner-entered snapshot/);
  assert.equal(
    inferenceCreditAlerts(
      { usd: 10, spentSinceUsd: 0, asOf: "2026-11-06T00:00:00Z" },
      now,
    )[0]?.kind,
    "credit_snapshot_stale",
  );
  for (const snapshot of [
    { usd: NaN, spentSinceUsd: 0, asOf: "bad" },
    { usd: 10, spentSinceUsd: 0, asOf: "2026-11-09T00:00:00Z" },
  ])
    assert.equal(
      inferenceCreditAlerts(snapshot, now)[0]?.kind,
      "credit_snapshot_unavailable",
    );
});
