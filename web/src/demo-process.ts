import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { DemoEvents, DemoJob } from "./demo.ts";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_LINE_LENGTH = 4096;
const PHASES = new Set([
  "challenge",
  "fund",
  "delivery",
  "verification",
  "payout",
  "Released",
  "Refunded",
]);

/** Only fixed progress grammar is public; never forward arbitrary child text or errors. */
function createdJob(line: string, jobs: DemoJob[]): DemoJob | undefined {
  const created = /^Scripted (honest|fake) case: job ([0-9]{1,16})$/.exec(line);
  if (!created) return;
  const id = Number(created[2]);
  if (
    !Number.isSafeInteger(id) ||
    jobs.some((job) => job.worker === created[1] || job.id === id)
  )
    return;
  return { worker: created[1] as DemoJob["worker"], id, phase: "created" };
}
export function progressLine(
  line: string,
  jobs: DemoJob[],
): DemoJob | undefined {
  if (line.startsWith("Scripted ")) return createdJob(line, jobs);
  const update =
    /^(?:[0-9TZ:.\-]+ )?Job ([0-9]{1,16}): (?:(?:starting )?([a-z]+)(?: returned after [0-9]+ ms)?|(Released|Refunded))$/.exec(
      line,
    );
  if (!update) return;
  const job = jobs.find((job) => job.id === Number(update[1])),
    phase = update[2] ?? update[3];
  if (job && phase && PHASES.has(phase)) return { ...job, phase };
}
interface CompletedCase {
  worker: string;
  job_id: number;
  final: {
    state: string;
    token: unknown;
    amount: string;
    worker: string;
    buyer: string;
  };
  payout: { transaction_hash: string };
  payout_proof: {
    job_id: number;
    amount: string;
    transaction_hash: string;
    receipt_id: string;
    receiver: string;
  };
}
interface Cleanup {
  job_id: number;
  kind: string;
  deleted: boolean;
  transaction_hash: string;
}
function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function payoutMatches(entry: CompletedCase): boolean {
  const proof = entry.payout_proof;
  if (
    !proof ||
    !entry.payout ||
    !boundedText(entry.payout.transaction_hash) ||
    !boundedText(proof.receipt_id)
  )
    return false;
  const receiver =
    entry.worker === "honest" ? entry.final.worker : entry.final.buyer;
  return (
    boundedText(receiver) &&
    proof.job_id === entry.job_id &&
    proof.amount === entry.final.amount &&
    proof.transaction_hash === entry.payout.transaction_hash &&
    proof.receiver === receiver
  );
}
function terminalCase(
  entry: CompletedCase | undefined,
  tracked: DemoJob | undefined,
  state: string,
) {
  return Boolean(
    entry &&
    tracked &&
    entry.job_id === tracked.id &&
    entry.final?.state === state &&
    entry.final?.token === null &&
    entry.final?.amount === "10000000000000000000000" &&
    payoutMatches(entry),
  );
}
function cleanupMatches(cleanup: Cleanup[], jobId: number) {
  return ["Challenge", "Verify"].every((kind) => {
    const records = cleanup.filter(
      (value) => value.job_id === jobId && value.kind === kind,
    );
    return (
      records.length === 1 &&
      records[0]!.deleted === true &&
      boundedText(records[0]!.transaction_hash)
    );
  });
}
/** Exit zero alone is insufficient. Require the runner's two exact payout proofs and cleanup. */
export function completedEvidence(text: string, jobs: DemoJob[]): boolean {
  try {
    const data = JSON.parse(text) as {
      scripted: boolean;
      dry_run: boolean;
      resumed?: boolean;
      compute_mode: string;
      completed: string;
      cases: CompletedCase[];
      cleanup: Cleanup[];
    };
    if (
      data.scripted !== true ||
      data.dry_run !== false ||
      data.resumed ||
      data.compute_mode !== "operator" ||
      !boundedText(data.completed) ||
      !Array.isArray(data.cases) ||
      data.cases.length !== 2 ||
      jobs.length !== 2 ||
      !Array.isArray(data.cleanup) ||
      data.cleanup.length !== 4
    )
      return false;
    return [
      ["honest", "Released"],
      ["fake", "Refunded"],
    ].every(([worker, state]) => {
      const tracked = jobs.find((job) => job.worker === worker);
      const entry = data.cases.find((value) => value.worker === worker);
      return (
        terminalCase(entry, tracked, state!) &&
        cleanupMatches(data.cleanup, entry!.job_id)
      );
    });
  } catch {
    return false;
  }
}

/** Fixed executable, arguments, cwd and testnet RPC. Browser input never reaches a command. */
export function launchFixedDemo(events: DemoEvents) {
  const child = spawn(
    process.execPath,
    ["agent/src/demo.ts", "--operator-compute"],
    {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NEAR_NETWORK: "testnet",
        NEAR_RPC_URL: "https://test.rpc.fastnear.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  observeDemo(child, events);
}

/** Stream reader is independently exercised without any funded runner. */
export function observeDemo(
  child: Pick<
    ChildProcessByStdio<null, Readable, Readable>,
    "stdout" | "stderr" | "once"
  >,
  events: DemoEvents,
) {
  const jobs: DemoJob[] = [];
  const output: Buffer[] = [];
  let bytes = 0,
    stderr = "",
    oversized = false;
  child.stdout.on("data", (data: Buffer) => {
    bytes += data.length;
    if (bytes <= MAX_STDOUT_BYTES) output.push(data);
    else {
      oversized = true;
      output.length = 0;
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString("utf8");
    // A large line is ignored, never exposed. Child continues so funds are not interrupted.
    if (stderr.length > MAX_STDERR_LINE_LENGTH) {
      stderr = "";
      return;
    }
    const lines = stderr.split("\n");
    stderr = lines.pop()!;
    for (const line of lines) {
      const job = progressLine(line.replace(/\r$/, ""), jobs);
      if (!job) continue;
      const existing = jobs.find((item) => item.worker === job.worker);
      if (existing) existing.phase = job.phase;
      else jobs.push(job);
      events.job(job);
    }
  });
  child.once("error", () => events.done(false));
  child.once("close", (code) =>
    events.done(
      code === 0 &&
        !oversized &&
        completedEvidence(Buffer.concat(output).toString("utf8"), jobs),
    ),
  );
}
