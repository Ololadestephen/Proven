import test from "node:test";
import assert from "node:assert/strict";
import {
  createOperatorDemoTools,
  type OperatorStatus,
} from "./demo-operator.ts";
import type { DemoEvidence } from "./demo-runner.ts";
const status: OperatorStatus = {
  enabled: true,
  session_id: "session",
  remaining: 4,
  jobs: [],
  compute_payer: "relay.testnet",
  buyer: "buyer.testnet",
  workers: ["honest.testnet", "fake.testnet"],
  spec_hash: "a",
  reference_hash: "b",
  verifier_hash: "c",
  escrow: "escrow.testnet",
};

test("operator mode uses pin-only tools and fixed private trigger; cleanup completes before finish", async () => {
  const evidence: DemoEvidence = {
    scripted: true,
    dry_run: false,
    cases: [{ worker: "honest", worker_account: "honest.testnet", job_id: 1 }],
  };
  const calls: unknown[] = [],
    requests: Record<string, unknown>[] = [];
  const tools = createOperatorDemoTools(
    async (_actor, name, args) => {
      calls.push({ name, args });
      return { pinned: true };
    },
    async (request) => {
      requests.push(request);
      if (request.action === "register_demo")
        return { ...status, jobs: [1, 2] };
      if (request.action === "trigger")
        return {
          transaction_hash: "1".repeat(44),
          session_id: "session",
          compute_payer: "relay.testnet",
        };
      return { transaction_hash: "2".repeat(44) };
    },
    evidence,
    status,
    () => {},
    async (transaction) => ({ transaction_hash: transaction, result: true }),
  );
  await tools.begin([1, 2]);
  await tools.tool("buyer", "challenge_check", { job_id: 1 });
  await tools.finish();
  assert.deepEqual(calls, [
    { name: "challenge_check", args: { job_id: 1, pin_only: true } },
  ]);
  assert.deepEqual(
    requests.map((r) => r.action),
    ["register_demo", "trigger", "cleanup"],
  );
  assert.equal(evidence.cleanup?.[0]?.deleted, true);
});

test("buyer and same-worker writes are serialized and a wrong operator session fails closed", async () => {
  let active = 0,
    max = 0;
  const evidence: DemoEvidence = { scripted: true, dry_run: false, cases: [] };
  const tools = createOperatorDemoTools(
    async () => {
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      return {};
    },
    async () => ({ session_id: "wrong", jobs: [1, 2], remaining: 4 }),
    evidence,
    status,
    () => {},
    async (transaction) => ({ transaction_hash: transaction, result: true }),
  );
  await Promise.all([
    tools.tool("buyer", "fund_job", { job_id: 1 }),
    tools.tool("buyer", "fund_job", { job_id: 2 }),
  ]);
  assert.equal(max, 1);
  await assert.rejects(tools.begin([1, 2]));
});

test("inclusion without a recorded result preserves the hash and never deletes inputs", async () => {
  for (const result of [
    { pending: true },
    { failed: true },
    { result: false },
  ]) {
    const evidence: DemoEvidence = {
      scripted: true,
      dry_run: false,
      cases: [
        { worker: "honest", worker_account: "honest.testnet", job_id: 1 },
      ],
    };
    const requests: string[] = [];
    let saved = false;
    const tools = createOperatorDemoTools(
      async () => ({ pinned: true }),
      async (request) => {
        requests.push(String(request.action));
        return {
          transaction_hash: "1".repeat(44),
          session_id: "session",
          compute_payer: "relay.testnet",
        };
      },
      evidence,
      status,
      () => {
        saved = true;
      },
      async (transaction_hash) => {
        assert.equal(saved, true);
        assert.equal(
          evidence.cases[0].challenge?.transaction_hash,
          transaction_hash,
        );
        return { transaction_hash, ...result };
      },
    );
    await assert.rejects(
      tools.tool("buyer", "challenge_check", { job_id: 1 }),
      /no confirmed recorded result/,
    );
    await tools.finish();
    assert.deepEqual(requests, ["trigger"]);
    assert.equal(evidence.cases[0].challenge?.pending, true);
    assert.equal(evidence.cleanup, undefined);
  }
});
