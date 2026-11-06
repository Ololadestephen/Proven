import test from "node:test";
import assert from "node:assert/strict";
import { completedEvidence, progressLine } from "./demo-process.ts";
import type { DemoJob } from "./demo.ts";
const jobs: DemoJob[] = [
  { worker: "honest", id: 101, phase: "Released" },
  { worker: "fake", id: 102, phase: "Refunded" },
];
function evidence() {
  return {
    scripted: true,
    dry_run: false,
    compute_mode: "operator",
    completed: "2026-11-05T00:00:00Z",
    cases: jobs.map((job) => ({
      worker: job.worker,
      job_id: job.id,
      final: {
        state: job.phase,
        amount: "10000000000000000000000",
        token: null,
        worker: "honest.testnet",
        buyer: "buyer.testnet",
      },
      payout: { transaction_hash: `tx${job.id}` },
      payout_proof: {
        job_id: job.id,
        transaction_hash: `tx${job.id}`,
        receipt_id: "receipt",
        amount: "10000000000000000000000",
        receiver: job.worker === "honest" ? "honest.testnet" : "buyer.testnet",
      },
    })),
    cleanup: jobs.flatMap((job) =>
      ["Challenge", "Verify"].map((kind) => ({
        job_id: job.id,
        kind,
        deleted: true,
        transaction_hash: "cleanup",
      })),
    ),
  };
}
test("public progress recognizes only known fixed jobs and phases, never arbitrary output", () => {
  assert.deepEqual(progressLine("Scripted honest case: job 101", []), {
    worker: "honest",
    id: 101,
    phase: "created",
  });
  assert.deepEqual(
    progressLine("2026-11-05T19:00:02.610Z Job 101: starting challenge", jobs),
    { worker: "honest", id: 101, phase: "challenge" },
  );
  for (const line of [
    "PRIVATE key",
    "Job 999: Released",
    "Job 101: PRIVATE",
    "Scripted honest case: job 101",
    "Scripted fake case: job 101",
  ])
    assert.equal(progressLine(line, jobs), undefined);
  assert.equal(
    progressLine("Scripted fake case: job 9999999999999999", []),
    undefined,
  );
});
test("completion requires both exact terminal payout proofs and all four cleanup results", () => {
  assert.ok(completedEvidence(JSON.stringify(evidence()), jobs));
  const changes: Array<
    (d: ReturnType<typeof evidence> & { resumed?: boolean }) => unknown
  > = [
    (d) => (d.dry_run = true),
    (d) => (d.resumed = true),
    (d) => (d.compute_mode = "custody"),
    (d) => (d.cases[0].final.state = "Passed"),
    (d) => (d.cases[1].payout_proof.receiver = "attacker.testnet"),
    (d) => (d.cases[0].payout_proof.amount = "1"),
    (d) => (d.cases[0].payout_proof.transaction_hash = "other"),
    (d) => (d.cleanup[0].deleted = false),
    (d) => (d.cleanup[0] = d.cleanup[1]),
    (d) => (d.cases[0].job_id = 102),
  ];
  for (const change of changes) {
    const data = evidence();
    change(data);
    assert.equal(completedEvidence(JSON.stringify(data), jobs), false);
  }
  for (const field of ["transaction_hash", "receiver", "receipt_id"]) {
    const data = evidence();
    const proof = data.cases[0]!.payout_proof as unknown as Record<
      string,
      unknown
    >;
    delete proof[field];
    assert.equal(completedEvidence(JSON.stringify(data), jobs), false);
  }
  assert.equal(completedEvidence("{", jobs), false);
});

test("real child streams are bounded, redact arbitrary logs, and cannot complete on exit code alone", async () => {
  const { spawn } = await import("node:child_process");
  const { observeDemo } = await import("./demo-process.ts");
  const scenarios = [
    {
      output: JSON.stringify(evidence()),
      exit: 0,
      oversized: false,
      expected: true,
    },
    {
      output: JSON.stringify(evidence()),
      exit: 1,
      oversized: false,
      expected: false,
    },
    {
      output: '{"PRIVATE":"token"}',
      exit: 0,
      oversized: false,
      expected: false,
    },
    {
      output: JSON.stringify(evidence()),
      exit: 0,
      oversized: true,
      expected: false,
    },
  ];
  for (const scenario of scenarios) {
    const code = `process.stderr.write('PRIVATE token\\nScripted honest case: job 101\\nScripted fake case: job 102\\n'); process.stdout.write(${JSON.stringify(scenario.output)}); ${scenario.oversized ? "process.stdout.write('x'.repeat(1048577));" : ""} process.exitCode=${scenario.exit};`;
    const child = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    const progress: DemoJob[] = [];
    const success = await new Promise<boolean>((resolve) =>
      observeDemo(child, { job: (job) => progress.push(job), done: resolve }),
    );
    assert.equal(success, scenario.expected);
    assert.deepEqual(
      progress.map((job) => job.id),
      [101, 102],
    );
    assert.ok(!JSON.stringify(progress).includes("PRIVATE"));
  }
});
