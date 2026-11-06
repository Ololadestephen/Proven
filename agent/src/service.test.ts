import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createService } from "./service.ts";
import type { Actor, CallPlan, Job, Runtime } from "./types.ts";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const build = "c".repeat(64),
  check = JSON.stringify({
    verifier: build,
    format: "{}",
    private: "hidden-check",
  }),
  reference = "private-reference",
  delivery = "private-delivery";
function fixture(state = "Delivered", actor: Actor = "buyer") {
  const current: Job = {
    buyer: "buyer.testnet",
    worker: "honest.testnet",
    amount: "10000000000000000000000",
    token: null,
    state,
    spec_hash: digest(check),
    fakes_hash: digest(reference),
    verifier_hash: build,
    secrets_owner: "relay.testnet",
    deliverable_hash: digest(delivery),
    deadline: "10000000000000",
    delivered_at: "1000000000",
    verdict_window_secs: 1800,
    attempt: 1,
    run_started_at: null,
    fakes_total: 13,
    fakes_caught: 13,
    challenge_request_id: null,
    challenge_report_hash: null,
    verdict_request_id: null,
    report_hash: null,
    failed_rule: null,
  };
  const calls: CallPlan[] = [],
    handoffs: Record<string, unknown>[] = [];
  let clock = 1000000000n;
  let handoffFails = false;
  const runtime: Runtime = {
    actor,
    allowedWorkers: ["honest.testnet"],
    identity: actor === "buyer" ? current.buyer : `${actor}.testnet`,
    escrow: "escrow-v2.proven.testnet",
    async view<T>(method: string): Promise<T> {
      return (
        method === "get_config"
          ? { verifier_hash: build }
          : method === "get_jobs"
            ? [[1, current]]
            : { ...current }
      ) as T;
    },
    now: async () => clock,
    async submit(call) {
      calls.push(call);
      if (call.method_name === "deliver") {
        current.state = "Delivered";
        current.deliverable_hash = call.args.deliverable_hash as string;
      }
      if (call.method_name === "request_verification") {
        current.state = "Passed";
        current.verdict_request_id = "42";
      }
      if (call.method_name === "request_challenge") {
        current.state = "Challenged";
        current.challenge_request_id = "41";
      }
      return {
        transaction_hash: "test-transaction",
        result: call.method_name === "create_job" ? 1 : true,
      };
    },
    async handoff(value) {
      handoffs.push(value);
      if (handoffFails) throw new Error("private-delivery key=SECRET");
      return { profile: "private-profile" };
    },
  };
  return {
    current,
    runtime,
    calls,
    handoffs,
    run: createService(runtime),
    advance: (time: bigint) => {
      clock = time;
    },
    failHandoff: () => {
      handoffFails = true;
    },
  };
}
test("every write tool dry-run avoids signing and private writes, returning hashes only", async () => {
  const requests = [
    [
      "post_job",
      "Draft",
      { worker: "honest.testnet", check, reference, amount_near: "0.01" },
    ],
    ["challenge_check", "Draft", { job_id: 1, check, reference }],
    ["fund_job", "Challenged", { job_id: 1 }],
    ["deliver", "Funded", { job_id: 1, deliverable: delivery }],
    ["request_verification", "Delivered", { job_id: 1 }],
    ["release_or_refund", "Passed", { job_id: 1 }],
    [
      "recover_outlayer_deposit",
      "Delivered",
      { request_id: "18446744073709551615" },
    ],
  ] as const;
  for (const [name, state, args] of requests) {
    const f = fixture(state);
    const output = await f.run(name, { ...args, dry_run: true });
    assert.equal((output as { dry_run: boolean }).dry_run, true);
    assert.equal(f.calls.length + f.handoffs.length, 0);
    assert.doesNotMatch(
      JSON.stringify(output),
      /hidden-check|private-reference|private-delivery/,
    );
  }
});
test("bad commitments, unsupported fields, unsafe ids and verifier mismatch fail before writes", async () => {
  const f = fixture("Draft");
  for (const [name, args] of [
    ["challenge_check", { job_id: 1, check, reference: "tampered" }],
    [
      "post_job",
      { worker: "honest.testnet", check: "{}", reference, amount_near: "0.01" },
    ],
    [
      "post_job",
      {
        worker: "honest.testnet",
        check,
        reference,
        amount_near: "0.01",
        deadline_seconds: 60,
      },
    ],
    [
      "post_job",
      {
        worker: "honest.testnet",
        check,
        reference,
        amount_near: "0.100000000000000000000001",
      },
    ],
    ["job_status", { job_id: Number.MAX_SAFE_INTEGER + 1 }],
    ["recover_outlayer_deposit", { request_id: "18446744073709551616" }],
    ["fund_job", { job_id: 1, receiver_id: "attacker.testnet" }],
  ] as const)
    await assert.rejects(f.run(name, args));
  assert.equal(f.calls.length + f.handoffs.length, 0);
});
test("funding uses the recorded amount and buyer, rejects FT targets and short delivery windows", async () => {
  const f = fixture("Challenged");
  await f.run("fund_job", { job_id: 1 });
  assert.deepEqual(f.calls[0].args, { job_id: 1 });
  assert.equal(f.calls[0].deposit, f.current.amount);
  f.current.token = "pusd.proven.testnet";
  await assert.rejects(f.run("fund_job", { job_id: 1 }));
  f.current.token = null;
  f.current.buyer = "another.testnet";
  await assert.rejects(f.run("fund_job", { job_id: 1 }));
  f.current.buyer = "buyer.testnet";
  f.advance(BigInt(f.current.deadline) - 600000000000n);
  await assert.rejects(f.run("fund_job", { job_id: 1 }));
});
test("scoped worker never incurs a relay pin before a payable trigger is refused", async () => {
  const f = fixture("Draft", "honest");
  await assert.rejects(
    f.run("challenge_check", { job_id: 1, check, reference }),
  );
  assert.equal(f.handoffs.length + f.calls.length, 0);
  const pinned = await f.run("challenge_check", {
    job_id: 1,
    check,
    reference,
    pin_only: true,
  });
  assert.equal((pinned as { triggered: boolean }).triggered, false);
  assert.equal(f.handoffs.length, 1);
  assert.equal(f.calls.length, 0);
});
test("delivery is worker-bound, fixes only a hash, and can retry private handoff without replaying transaction", async () => {
  const f = fixture("Funded", "fake");
  await assert.rejects(f.run("deliver", { job_id: 1, deliverable: delivery }));
  assert.equal(f.calls.length, 0);
  const honest = fixture("Funded", "honest");
  honest.failHandoff();
  const first = (await honest.run("deliver", {
    job_id: 1,
    deliverable: delivery,
  })) as Record<string, unknown>;
  assert.equal(first.transaction_hash, "test-transaction");
  assert.equal(first.private_handoff, false);
  await honest.run("deliver", { job_id: 1, deliverable: delivery });
  assert.equal(honest.calls.length, 1);
  assert.equal(honest.calls[0].args.deliverable_hash, digest(delivery));
  await assert.rejects(
    honest.run("deliver", { job_id: 1, deliverable: "changed" }),
  );
});
test("challenge and verification trigger escrow only, expose request links and clean after a result", async () => {
  const f = fixture("Draft");
  const challenge = (await f.run("challenge_check", {
    job_id: 1,
    check,
    reference,
  })) as { job: Record<string, unknown> };
  assert.match(String(challenge.job.challenge_attestation), /by-request\/41$/);
  assert.equal(f.calls[0].receiver_id, f.runtime.escrow);
  assert.equal(f.calls[0].deposit, "100000000000000000000000");
  assert.equal(f.handoffs[1].action, "cleanup");
  f.current.state = "Delivered";
  const verify = (await f.run("request_verification", { job_id: 1 })) as {
    job: Record<string, unknown>;
  };
  assert.match(String(verify.job.verdict_attestation), /by-request\/42$/);
  assert.equal(f.calls[1].method_name, "request_verification");
  assert.equal(f.handoffs[2].action, "pin_verification");
});
test("settlement follows only the stored verdict or bounded expiry, never a caller payee", async () => {
  for (const [state, method] of [
    ["Passed", "release"],
    ["Failed", "refund"],
  ]) {
    const f = fixture(state);
    await f.run("release_or_refund", { job_id: 1 });
    assert.equal(f.calls[0].method_name, method);
    assert.equal(f.calls[0].deposit, "0");
  }
  const f = fixture("Delivered");
  await assert.rejects(f.run("release_or_refund", { job_id: 1 }));
  f.advance(1801000000001n);
  await f.run("release_or_refund", { job_id: 1 });
  assert.equal(f.calls[0].method_name, "expire");
  f.current.state = "Verifying";
  f.current.run_started_at = "1801000000001";
  await assert.rejects(f.run("release_or_refund", { job_id: 1 }));
  f.advance(2701000000002n);
  await f.run("release_or_refund", { job_id: 1 });
  await assert.rejects(
    f.run("release_or_refund", { job_id: 1, payee: "attacker.testnet" }),
  );
});

test("explicit storage deposit reduces attachment without widening the custody cap", async () => {
  const f = fixture("Draft");
  const args = {
    worker: "honest.testnet",
    check,
    reference,
    amount_near: "0.01",
  };
  const custom = (await f.run(
    "post_job",
    { ...args, storage_deposit_near: "0.02" },
    true,
  )) as { call: CallPlan };
  assert.equal(custom.call.deposit, "20000000000000000000000");
  const defaults = (await f.run("post_job", args, true)) as { call: CallPlan };
  assert.equal(defaults.call.deposit, "20000000000000000000000");
  await assert.rejects(
    f.run(
      "post_job",
      { ...args, storage_deposit_near: "0.050000000000000000000001" },
      true,
    ),
  );
  assert.equal(f.calls.length, 0);
});

test("a job can only name a worker the operator or a board claim allowed", async () => {
  const f = fixture("Draft");
  await assert.rejects(
    f.run(
      "post_job",
      { worker: "attacker.testnet", check, reference, amount_near: "0.01" },
      true,
    ),
    /not allowed/,
  );
});
