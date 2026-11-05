import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runDemo, type DemoContext, type DemoEvidence } from "./demo-runner.ts";
import type { Job } from "./types.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const PAYMENT = 10000000000000000000000n;
const CHECK = JSON.stringify({ verifier: "a".repeat(64) });
function fixture() {
  const evidence: DemoEvidence = { scripted: true, dry_run: false, cases: [] };
  const jobs = new Map<number, Job>();
  const writes: string[] = [],
    balances = new Map<string, bigint>();
  let fail = "",
    noVerdict = false,
    clock = Date.parse("2026-11-04T20:00:00Z");
  let corrupt = false;
  const ctx: DemoContext = {
    evidence,
    scenario: {
      buyer: "buyer.testnet",
      account: (worker) => `${worker}.testnet`,
      check: CHECK,
      reference: "fixed-reference",
      delivery: (worker) => `${worker}-delivery`,
    },
    io: {
      save() {},
      event() {},
      now: () => clock++,
      balance: async (account) => balances.get(account) ?? 0n,
      async tool(actor, name, args, dry) {
        if (name === "job_status") {
          const job = { ...jobs.get(args.job_id as number)! };
          if (corrupt) job.worker = "attacker.testnet";
          return job;
        }
        writes.push(name);
        if (name === fail) throw new Error("Uncertain submission");
        if (name === "post_job") {
          assert.equal(args.storage_deposit_near, "0.02");
          if (dry) return { dry_run: true };
          const id = 100 + jobs.size;
          jobs.set(id, {
            buyer: "buyer.testnet",
            worker: args.worker as string,
            amount: PAYMENT.toString(),
            token: null,
            state: "Draft",
            spec_hash: hash(CHECK),
            fakes_hash: hash("fixed-reference"),
            verifier_hash: "a".repeat(64),
            secrets_owner: "relay.testnet",
            deliverable_hash: null,
            deadline: "9999999999999999999",
            delivered_at: null,
            verdict_window_secs: 1800,
            attempt: 0,
            run_started_at: null,
            fakes_total: 0,
            fakes_caught: 0,
            challenge_request_id: null,
            challenge_report_hash: null,
            verdict_request_id: null,
            report_hash: null,
            failed_rule: null,
          });
          return { transaction_hash: "creation", result: id };
        }
        const job = jobs.get(args.job_id as number)!;
        if (name === "challenge_check") {
          job.state = "Challenged";
          job.challenge_request_id = "1";
          job.challenge_report_hash = "b".repeat(64);
        }
        if (name === "fund_job") job.state = "Funded";
        if (name === "deliver") {
          assert.equal(actor + ".testnet", job.worker);
          job.state = "Delivered";
          job.deliverable_hash = hash(args.deliverable as string);
        }
        if (name === "request_verification" && !noVerdict) {
          job.state = job.worker === "honest.testnet" ? "Passed" : "Failed";
          job.verdict_request_id = "2";
          job.report_hash = "c".repeat(64);
        }
        if (name === "release_or_refund") {
          const pass = job.state === "Passed";
          assert.ok(pass || job.state === "Failed");
          const receiver = pass ? job.worker : job.buyer;
          balances.set(receiver, (balances.get(receiver) ?? 0n) + PAYMENT);
          job.state = pass ? "Released" : "Refunded";
        }
        return { transaction_hash: name, private_handoff: true };
      },
    },
  };
  return {
    ctx,
    jobs,
    writes,
    fail: (name: string) => {
      fail = name;
    },
    noVerdict: () => {
      noVerdict = true;
    },
    corrupt: () => {
      corrupt = true;
    },
  };
}

test("one invocation settles honest and fake only from real recorded outcomes", async () => {
  const { ctx, writes } = fixture();
  await runDemo(ctx);
  assert.deepEqual(
    ctx.evidence.cases.map((c) => c.final?.state),
    ["Released", "Refunded"],
  );
  assert.deepEqual(
    ctx.evidence.cases.map((c) => c.balance_change),
    [PAYMENT.toString(), PAYMENT.toString()],
  );
  assert.equal(ctx.evidence.meets_two_minute_target, true);
  assert.equal(writes.filter((name) => name === "post_job").length, 2);
  // A terminal resume reads the same ids and evidence; it never resubmits writes.
  ctx.evidence.resumed = true;
  const before = writes.length;
  await runDemo(ctx);
  assert.equal(writes.length, before);
  assert.equal(ctx.evidence.meets_two_minute_target, false);
});

test("uncertain create/fund outcomes are never automatically submitted again", async () => {
  for (const phase of [
    "post_job",
    "challenge_check",
    "fund_job",
    "deliver",
    "request_verification",
    "release_or_refund",
  ]) {
    const { ctx, writes, fail } = fixture();
    fail(phase);
    await assert.rejects(runDemo(ctx));
    const count = writes.length;
    fail("");
    await assert.rejects(runDemo(ctx));
    assert.equal(writes.length, count, phase);
    assert.equal(ctx.evidence.completed, undefined);
  }
});

test("no verdict never becomes fake-fail or honest-pass", async () => {
  const { ctx, writes, noVerdict } = fixture();
  noVerdict();
  await assert.rejects(runDemo(ctx), /No verdict was inferred/);
  assert.ok(!writes.includes("release_or_refund"));
  assert.equal(ctx.evidence.completed, undefined);
});

test("saved job ids cannot redirect the fixed demo parties or commitments", async () => {
  const { ctx, writes, corrupt } = fixture();
  corrupt();
  await assert.rejects(runDemo(ctx), /fixed parties/);
  assert.deepEqual(writes, ["post_job"]);
});

test("dry plans have no funding/delivery/compute/payout and cannot satisfy the timing target", async () => {
  const { ctx, writes } = fixture();
  ctx.evidence.dry_run = true;
  await runDemo(ctx);
  assert.deepEqual(writes, ["post_job", "post_job"]);
  assert.equal(ctx.evidence.meets_two_minute_target, false);
  assert.ok(ctx.evidence.cases.every((c) => c.job_id === undefined));
});

test("preflight time belongs to the fresh command's two-minute budget", async () => {
  const { ctx } = fixture();
  ctx.evidence.started_at = "2026-11-04T19:57:59Z";
  await runDemo(ctx);
  assert.ok(ctx.evidence.elapsed_ms! >= 121000);
  assert.equal(ctx.evidence.meets_two_minute_target, false);
});

test("successful transfer receipts confirm payment even when final-balance reads still lag", async () => {
  const { ctx } = fixture();
  ctx.io.balance = async () => 0n;
  ctx.io.provePayout = async (id, transaction, receiver, amount) => ({
    job_id: id,
    transaction_hash: transaction,
    receipt_id: "receipt",
    receiver,
    amount,
  });
  await runDemo(ctx);
  assert.ok(
    ctx.evidence.cases.every(
      (entry) =>
        entry.balance_change === "0" &&
        entry.payout_proof?.amount === PAYMENT.toString(),
    ),
  );
});

test("parallel operator cases await both outcomes before reporting a failure", async () => {
  const { ctx, jobs } = fixture();
  ctx.scenario.parallel = true;
  ctx.evidence.compute_mode = "operator";
  ctx.io.begin = async (ids) => {
    assert.deepEqual(ids, [100, 101]);
  };
  ctx.io.finish = async () => {};
  ctx.io.provePayout = async (id, transaction, receiver, amount) => ({
    job_id: id,
    transaction_hash: transaction,
    receipt_id: "receipt",
    receiver,
    amount,
  });
  const original = ctx.io.tool;
  ctx.io.tool = async (actor, name, args, dry) => {
    if (name === "fund_job" && args.job_id === 100)
      throw new Error("Unknown first case");
    return original(actor, name, args, dry);
  };
  await assert.rejects(runDemo(ctx));
  assert.equal(jobs.get(101)?.state, "Refunded");
  assert.equal(ctx.evidence.completed, undefined);
});
