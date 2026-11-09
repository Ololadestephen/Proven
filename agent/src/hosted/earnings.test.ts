import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedStore, type HostedAgent } from "./store.ts";
import { recordEarnings, inferenceBudget } from "./earnings.ts";
import { dailyRemaining, settleSpending, reconcilePaidJobs } from "./runner.ts";
import { DAILY_LIMIT_NANO_USD, OPERATING_RESERVE } from "./limits.ts";
import { addPayload } from "./api.ts";
import type { Job } from "../types.ts";

const N = 10n ** 24n;
function fixture(t: test.TestContext, keep_bps = 0) {
  const root = mkdtempSync(join(tmpdir(), "proven-earnings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new HostedStore(root);
  const agent: HostedAgent = {
    wallet: "worker.testnet",
    wallet_id: "fixture",
    custody_key: "fixture",
    owner: "owner.testnet",
    prompt: "p",
    knowledge: "k",
    model: "m",
    skills: ["calculator"],
    review: { reason: "ok", model: "m", chat_id: "c", response_hash: "h" },
    min_buyer_paid_share: null,
    created_at: "2026-11-08T00:00:00Z",
    last_claim_at: null,
    settled_nano_usd: 0,
    paused: false,
    keep_bps,
  };
  store.save(agent);
  const job = {
    state: "Released",
    worker: agent.wallet,
    token: null,
    amount: (N / 10n).toString(),
    verdict_request_id: "12",
    deliverable_hash: "a".repeat(64),
    report_hash: "b".repeat(64),
  } as Job;
  return { root, store, agent, job };
}

test("a paid allocation is durable and idempotent across restart, including cleared board claims", async (t) => {
  const { root, store, agent, job } = fixture(t);
  const deps = {
    store,
    config: { escrow: "escrow.testnet" },
    earningsCapYocto: N.toString(),
  } as Parameters<typeof reconcilePaidJobs>[0];
  const bids = [[0, { state: "Done", job_id: 0, claim: null }]] as Parameters<
    typeof reconcilePaidJobs
  >[1];
  const board = { view: async () => job } as unknown as Parameters<
    typeof reconcilePaidJobs
  >[2];
  await reconcilePaidJobs(deps, bids, board);
  await reconcilePaidJobs(
    { ...deps, store: new HostedStore(root) },
    bids,
    board,
  );
  const paid = store.get(agent.wallet)!;
  assert.equal(paid.earnings?.length, 1);
  assert.equal(paid.earnings![0]!.job_id, 0);
  assert.equal(paid.earnings![0]!.verdict_request_id, "12");
  const before = inferenceBudget(agent, OPERATING_RESERVE + N / 10n, 0, 0);
  const after = inferenceBudget(paid, OPERATING_RESERVE + N / 5n, 0, 0);
  assert.ok(after > before);
  assert.equal(
    recordEarnings(store, agent.wallet, "escrow.testnet", 0, job, N.toString()),
    null,
  );
  assert.throws(
    () =>
      recordEarnings(
        store,
        agent.wallet,
        "escrow.testnet",
        0,
        { ...job, verdict_request_id: "13" },
        N.toString(),
      ),
    /conflicts/,
  );
});

test("refunds, pass-before-payment and another worker cannot create a credit", (t) => {
  const { store, agent, job } = fixture(t);
  for (const state of ["Refunded", "Passed", "Failed", "Paying"])
    assert.equal(
      recordEarnings(
        store,
        agent.wallet,
        "escrow.testnet",
        1,
        { ...job, state },
        N.toString(),
      ),
      null,
    );
  assert.equal(
    recordEarnings(
      store,
      agent.wallet,
      "escrow.testnet",
      1,
      { ...job, worker: "stranger.testnet" },
      N.toString(),
    ),
    null,
  );
  for (const over of [
    { verdict_request_id: null },
    { report_hash: "bad" },
    { amount: "-1" },
  ])
    assert.throws(
      () =>
        recordEarnings(
          store,
          agent.wallet,
          "escrow.testnet",
          1,
          { ...job, ...over },
          N.toString(),
        ),
      /incomplete/,
    );
  assert.equal(store.get(agent.wallet)!.earnings, undefined);
});

test("retained share and per-payment operator cap exclude funds rather than adding wallet credit twice", (t) => {
  const { store, agent, job } = fixture(t, 2500);
  const cap = N / 20n;
  const row = recordEarnings(
    store,
    agent.wallet,
    "escrow.testnet",
    1,
    job,
    cap.toString(),
  )!;
  assert.equal(row.inference_yocto, cap.toString());
  assert.equal(row.retained_yocto, cap.toString());
  const paid = store.get(agent.wallet)!;
  assert.equal(
    inferenceBudget(paid, OPERATING_RESERVE + N / 10n, 0, 0),
    100_000_000,
  );
  assert.equal(inferenceBudget(paid, OPERATING_RESERVE, 0, 0), 0);
});

test("uncertain settlement blocks repeated transfers after restart", async (t) => {
  const { root, store, agent } = fixture(t);
  let sends = 0;
  const deps = {
    store,
    ledger: { spentNanoUsd: () => 1000 },
    settle: async () => {
      sends++;
      throw Error("lost reply");
    },
    log: () => undefined,
  } as unknown as Parameters<typeof settleSpending>[0];
  await assert.rejects(settleSpending(deps, agent), /lost reply/);
  await assert.rejects(
    settleSpending({ ...deps, store: new HostedStore(root) }, agent),
    /reconciliation/,
  );
  assert.equal(sends, 1);
  assert.equal(store.get(agent.wallet)!.pending_settlement_nano_usd, 1000);
});

test("confirmed settlement is counted once and its pending marker clears", async (t) => {
  const { store, agent } = fixture(t);
  let sends = 0;
  const deps = {
    store,
    ledger: { spentNanoUsd: () => 1000 },
    settle: async () => {
      sends++;
      return "confirmed";
    },
    log: () => undefined,
  } as unknown as Parameters<typeof settleSpending>[0];
  await settleSpending(deps, agent);
  await settleSpending(deps, agent);
  assert.equal(sends, 1);
  assert.equal(store.get(agent.wallet)!.settled_nano_usd, 1000);
  assert.equal(store.get(agent.wallet)!.pending_settlement_nano_usd, undefined);
});

test("damaged state, logs, deliveries and setup storage fail closed", (t) => {
  const { root, store, agent } = fixture(t);
  assert.equal(store.get("missing.testnet"), null);
  assert.deepEqual(store.readLog(1), []);
  for (const content of [
    "{",
    "{}",
    JSON.stringify({ ...agent, settled_nano_usd: -1 }),
  ]) {
    writeFileSync(join(root, "agents", `${agent.wallet}.json`), content);
    assert.throws(() => store.get(agent.wallet), /persistence/);
    assert.throws(() => store.inOrder(), /persistence/);
  }
  store.save(agent);
  writeFileSync(join(root, "logs", "job-1.jsonl"), '{"step":"work_started"}\n');
  assert.throws(() => store.readLog(1), /persistence/);
  mkdirSync(join(root, "logs", "job-2.delivery"));
  assert.throws(() => store.readDelivery(2), /persistence/);
  const hash = "A".repeat(44);
  assert.equal(store.claimSetupTransaction(hash), true);
  assert.equal(store.claimSetupTransaction(hash), false);
  rmSync(root, { recursive: true, force: true });
  assert.throws(
    () => store.claimSetupTransaction("B".repeat(44)),
    /persistence/,
  );
});

test("daily spend includes model and skill charges on the UTC day, not other agents", () => {
  const ledger = {
    rows: () => [
      { spender: "a", at: "2026-11-08T00:00:00Z", cost_nano_usd: 1000 },
      { spender: "a", at: "2026-11-07T23:59:59Z", cost_nano_usd: 9000 },
      {
        spender: "b",
        at: "2026-11-08T00:00:00Z",
        cost_nano_usd: DAILY_LIMIT_NANO_USD,
      },
    ],
  } as unknown as Parameters<typeof dailyRemaining>[0];
  assert.equal(
    dailyRemaining(ledger, "a", new Date("2026-11-08T12:00:00Z")),
    DAILY_LIMIT_NANO_USD - 1000,
  );
});

test("enrollment signatures bind the eligibility threshold and retained share", () => {
  const base = {
    prompt: "p",
    knowledge: "k",
    skills: ["calculator"],
    min_buyer_paid_share: null,
    keep_bps: 0,
  };
  assert.notEqual(
    addPayload(base),
    addPayload({ ...base, min_buyer_paid_share: 0.5 }),
  );
  assert.notEqual(addPayload(base), addPayload({ ...base, keep_bps: 2500 }));
});

test("skill billing refuses a depleted wallet/day allowance, job ceiling or project ceiling before appending", async () => {
  const { chargeHostedSkill } = await import("./runner.ts");
  const { JOB_LIMIT_NANO_USD, PROJECT_LIMIT_NANO_USD } =
    await import("./limits.ts");
  for (const [cost, other, limit] of [
    [0, 0, 50],
    [JOB_LIMIT_NANO_USD - 50, 0, 1e12],
    [0, PROJECT_LIMIT_NANO_USD - 50, 1e12],
  ]) {
    let appends = 0;
    const ledger = {
      rows: () => [
        { spender: "a", run: "job", cost_nano_usd: cost },
        { spender: "b", run: "other", cost_nano_usd: other },
      ],
      spentNanoUsd: () => cost,
      append: () => {
        appends++;
      },
    };
    assert.throws(
      () => chargeHostedSkill(ledger as never, "a", "job", 100, limit),
      /exceed/,
    );
    assert.equal(appends, 0);
  }
});

test("an earlier worker's failed attempt does not consume the next worker's model attempt", async () => {
  const { canStartHostedWork } = await import("./runner.ts");
  const logs = [
    { step: "work_started", agent: "first.testnet" },
    { step: "finished", agent: "first.testnet" },
  ];
  assert.equal(canStartHostedWork(logs, "second.testnet"), true);
  assert.equal(canStartHostedWork(logs, "first.testnet"), false);
  assert.equal(
    canStartHostedWork(
      [...logs, { step: "work_interrupted", agent: "first.testnet" }],
      "first.testnet",
    ),
    true,
  );
  assert.equal(
    canStartHostedWork(
      [
        ...logs,
        { step: "work_interrupted", agent: "first.testnet" },
        { step: "work_started", agent: "first.testnet" },
        { step: "work_interrupted", agent: "first.testnet" },
      ],
      "first.testnet",
    ),
    false,
  );
  assert.throws(
    () => canStartHostedWork([{ step: "work_started" }], "second.testnet"),
    /Legacy/,
  );
});

test("withdrawal excludes a concurrent withdrawal and preserves a payment recorded during its read", async (t) => {
  const { withdraw } = await import("./api.ts");
  const { store, agent, job } = fixture(t);
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    store,
    verifier: { verify: async () => true },
    hasActiveClaim: async () => {
      await wait;
      return true;
    },
  } as unknown as Parameters<typeof withdraw>[0];
  const first = withdraw(deps, { wallet: agent.wallet });
  await Promise.resolve();
  assert.equal(store.get(agent.wallet)!.pending_withdrawal, true);
  await assert.rejects(
    withdraw(deps, { wallet: agent.wallet }),
    /reconciliation/,
  );
  recordEarnings(store, agent.wallet, "escrow.testnet", 1, job, N.toString());
  release();
  await assert.rejects(first, /holds a claim/);
  assert.equal(store.get(agent.wallet)!.pending_withdrawal, undefined);
  assert.equal(store.get(agent.wallet)!.earnings!.length, 1);
  assert.equal(
    store.get(agent.wallet)!.paused,
    false,
    "a refused withdrawal must not strand an active worker",
  );
});

test("pilot scope excludes signing on other bids while preserving their active claims and paid allocations", async (t) => {
  const { BoardClient } = await import("../board.ts");
  const { runnerPass } = await import("./runner.ts");
  const { store, agent, job } = fixture(t, 2500);
  t.mock.method(BoardClient.prototype, "bids", async () => [
    [0, { job_id: 10, state: "Claimed", claim: { agent: agent.wallet } }],
    [1, { job_id: 11, state: "Open", claim: null }],
    [2, { job_id: 12, state: "Done", claim: null }],
  ]);
  t.mock.method(
    BoardClient.prototype,
    "view",
    async (method: string, args: Record<string, unknown>) => {
      assert.equal(method, "get_job");
      return args.job_id === 12 ? job : { ...job, state: "Funded" };
    },
  );
  t.mock.method(BoardClient.prototype, "agent", async () => ({}));
  t.mock.method(BoardClient.prototype, "now", async () => 1n);
  const claim = t.mock.method(BoardClient.prototype, "claim", async () =>
    assert.fail("wallet already holds a claim"),
  );
  await runnerPass(
    {
      config: {
        rpc: "https://test.rpc.fastnear.com",
        escrow: "escrow.testnet",
      },
      store,
      balance: async () => N,
      ledger: { rows: () => [] },
    } as unknown as Parameters<typeof runnerPass>[0],
    new Set([1]),
  );
  assert.equal(claim.mock.callCount(), 0);
  const earnings = store.get(agent.wallet)!.earnings!;
  assert.equal(earnings.length, 1);
  assert.equal(earnings[0]!.job_id, 12);
  assert.equal(earnings[0]!.retained_yocto, (N / 40n).toString());
});
