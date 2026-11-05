import { PublicError } from "./errors.ts";
import { createHash } from "node:crypto";
import type { Actor, Job } from "./types.ts";
import type { PayoutProof } from "./payout-proof.ts";

type Worker = "honest" | "fake";
export interface Outcome {
  transaction_hash?: string;
  result?: unknown;
  failed?: boolean;
  pending?: boolean;
  private_handoff?: unknown;
}
export interface DemoCase {
  worker: Worker;
  worker_account: string;
  job_id?: number;
  post_started?: boolean;
  post?: Outcome;
  started?: string;
  challenge?: Outcome;
  fund?: Outcome;
  delivery?: Outcome;
  verification?: Outcome;
  payout?: Outcome;
  receiver?: string;
  balance_before?: string;
  balance_after?: string;
  balance_change?: string;
  final?: Job;
  payout_proof?: PayoutProof;
}
export interface DemoEvidence {
  scripted: boolean;
  dry_run: boolean;
  cases: DemoCase[];
  started_at?: string;
  elapsed_ms?: number;
  completed?: string;
  resumed?: boolean;
  meets_two_minute_target?: boolean;
  compute_mode?: "custody" | "operator";
  operator_session?: string;
  cleanup?: Array<{
    job_id: number;
    kind: string;
    deleted: boolean;
    transaction_hash?: string;
  }>;
}
interface DemoScenario {
  parallel?: boolean;
  buyer: string;
  account(worker: Worker): string;
  check: string;
  reference: string;
  delivery(worker: Worker): string;
}
interface DemoIO {
  provePayout?(
    id: number,
    transaction: string,
    receiver: string,
    amount: string,
  ): Promise<PayoutProof>;
  begin?(ids: number[]): Promise<void>;
  finish?(): Promise<void>;
  tool(
    actor: Actor,
    name: string,
    args: Record<string, unknown>,
    dry?: boolean,
  ): Promise<unknown>;
  balance(account: string): Promise<bigint>;
  save(): void;
  event(message: string): void;
  now(): number;
}
export interface DemoContext {
  evidence: DemoEvidence;
  scenario: DemoScenario;
  io: DemoIO;
}
const PAYMENT = 10_000_000_000_000_000_000_000n;
const CASES: Worker[] = ["honest", "fake"];

/** Resume only saved ids. Never repeat an operation whose submission is uncertain. */
async function operation(
  ctx: DemoContext,
  entry: DemoCase,
  field: "challenge" | "fund" | "delivery" | "verification" | "payout",
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
) {
  if (entry.started || entry[field])
    throw new PublicError(
      "A previous operation has not been reconciled with chain state. Inspect the saved evidence before resuming; no write was repeated.",
    );
  entry.started = field;
  ctx.io.save();
  const startedAt = ctx.io.now();
  ctx.io.event(
    `${new Date(startedAt).toISOString()} Job ${entry.job_id}: starting ${field}`,
  );
  const result = (await ctx.io.tool(actor, name, args)) as Outcome;
  entry[field] = result;
  delete entry.started;
  ctx.io.save();
  ctx.io.event(
    `${new Date(ctx.io.now()).toISOString()} Job ${entry.job_id}: ${field} returned after ${ctx.io.now() - startedAt} ms`,
  );
  if (result.failed || result.pending)
    throw new PublicError(
      "The submitted transaction failed or is still pending. Inspect its saved hash before resuming; no write was repeated.",
    );
  return result;
}
async function observe(ctx: DemoContext, id: number): Promise<Job> {
  const job = (await ctx.io.tool("buyer", "job_status", { job_id: id })) as Job;
  const entry = ctx.evidence.cases.find((c) => c.job_id === id);
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  let build: unknown;
  try {
    build = (JSON.parse(ctx.scenario.check) as { verifier?: unknown }).verifier;
  } catch {
    throw new PublicError(
      "The fixed demo check is invalid. No further transaction was sent.",
    );
  }
  if (
    !entry ||
    job.buyer !== ctx.scenario.buyer ||
    job.worker !== entry.worker_account ||
    job.token !== null ||
    job.amount !== PAYMENT.toString() ||
    job.verifier_hash !== build ||
    job.spec_hash !== hash(ctx.scenario.check) ||
    job.fakes_hash !== hash(ctx.scenario.reference) ||
    (job.deliverable_hash !== null &&
      job.deliverable_hash !== hash(ctx.scenario.delivery(entry.worker)))
  )
    throw new PublicError(
      "Saved job differs from this demo's fixed parties, amount or input commitments. No further transaction was sent.",
    );
  return job;
}
function confirmed(entry: DemoCase, field: string) {
  if (entry.started === field) delete entry.started;
}

async function createJob(ctx: DemoContext, entry: DemoCase) {
  if (!entry.post) {
    if (entry.post_started)
      throw new PublicError(
        "Job creation has an unknown prior outcome. Reconcile custody history and record its id before resuming.",
      );
    entry.post_started = true;
    ctx.io.save();
    entry.post = (await ctx.io.tool(
      "buyer",
      "post_job",
      {
        worker: entry.worker_account,
        check: ctx.scenario.check,
        reference: ctx.scenario.reference,
        amount_near: "0.01",
        storage_deposit_near: "0.02",
        deadline_seconds: 3600,
        verdict_window_secs: 1800,
      },
      ctx.evidence.dry_run,
    )) as Outcome;
    ctx.io.save();
  }
  if (ctx.evidence.dry_run) return;
  if (
    entry.post.failed ||
    entry.post.pending ||
    !Number.isSafeInteger(entry.post.result) ||
    (entry.post.result as number) < 0
  )
    throw new PublicError(
      "Job creation has no confirmed id. Inspect custody history before retrying.",
    );
  entry.job_id = entry.post.result as number;
  ctx.io.save();
}

async function prepareDelivery(ctx: DemoContext, entry: DemoCase) {
  const jobId = entry.job_id!;
  let job = await observe(ctx, jobId);
  if (job.state === "Draft") {
    await operation(ctx, entry, "challenge", "buyer", "challenge_check", {
      job_id: jobId,
      check: ctx.scenario.check,
      reference: ctx.scenario.reference,
    });
    job = await observe(ctx, jobId);
  }
  if (job.state === "Challenged") {
    // A completed previous step is now established by the recorded state.
    confirmed(entry, "challenge");
    await operation(ctx, entry, "fund", "buyer", "fund_job", { job_id: jobId });
    job = await observe(ctx, jobId);
  }
  if (job.state === "Funded") {
    confirmed(entry, "fund");
    const delivered = await operation(
      ctx,
      entry,
      "delivery",
      entry.worker,
      "deliver",
      { job_id: jobId, deliverable: ctx.scenario.delivery(entry.worker) },
    );
    if (delivered.private_handoff === false)
      throw new PublicError(
        "Delivery was committed but private handoff needs retry with identical bytes. Inspect the job before resuming.",
      );
    job = await observe(ctx, jobId);
  }
  if (job.state === "Delivered") {
    if (!entry.delivery || entry.delivery.private_handoff === false)
      throw new PublicError(
        "The delivery needs its identical private handoff before verification. No transaction was repeated.",
      );
    confirmed(entry, "delivery");
    await operation(
      ctx,
      entry,
      "verification",
      "buyer",
      "request_verification",
      { job_id: jobId },
    );
  }
}

async function pay(ctx: DemoContext, entry: DemoCase) {
  const jobId = entry.job_id!,
    worker = entry.worker;
  const job = await observe(ctx, jobId);
  const expected = worker === "honest" ? "Passed" : "Failed";
  const terminal = worker === "honest" ? "Released" : "Refunded";
  const receiver =
    worker === "honest" ? entry.worker_account : ctx.scenario.buyer;
  if (job.state === expected) {
    if (!job.verdict_request_id || !job.report_hash)
      throw new PublicError(
        "Expected verdict has no stored request/output commitment.",
      );
    confirmed(entry, "verification");
    entry.receiver = receiver;
    entry.balance_before = (await ctx.io.balance(receiver)).toString();
    ctx.io.save();
    await operation(ctx, entry, "payout", "fake", "release_or_refund", {
      job_id: jobId,
    });
  } else if (job.state !== terminal) {
    throw new PublicError(
      "Verification did not reach the expected real verdict. No verdict was inferred from a timeout or compute failure.",
    );
  }
  await confirmPayout(ctx, entry, terminal, receiver);
}

async function confirmPayout(
  ctx: DemoContext,
  entry: DemoCase,
  terminal: string,
  receiver: string,
) {
  if (
    !entry.payout?.transaction_hash ||
    !entry.balance_before ||
    entry.receiver !== receiver
  )
    throw new PublicError(
      "Terminal job needs its saved payout hash and receiver balance evidence before completion. Reconcile receipts before resuming.",
    );
  entry.balance_after ??= (await ctx.io.balance(receiver)).toString();
  entry.balance_change = (
    BigInt(entry.balance_after) - BigInt(entry.balance_before)
  ).toString();
  entry.final = await observe(ctx, entry.job_id!);
  let proven = false;
  if (ctx.io.provePayout) {
    const proof = await ctx.io.provePayout(
      entry.job_id!,
      entry.payout.transaction_hash,
      receiver,
      PAYMENT.toString(),
    );
    if (
      proof.job_id !== entry.job_id ||
      proof.transaction_hash !== entry.payout.transaction_hash ||
      proof.receiver !== receiver ||
      proof.amount !== PAYMENT.toString()
    )
      throw new PublicError(
        "Payout proof does not match this job and payment.",
      );
    entry.payout_proof = proof;
    proven = true;
  }
  ctx.io.save();
  if (
    entry.final.state !== terminal ||
    (!proven && BigInt(entry.balance_change) < PAYMENT)
  )
    throw new PublicError(
      "Payout state or receiver balance did not confirm the expected payment. Inspect receipts.",
    );
  ctx.io.event(`Job ${entry.job_id}: ${terminal}`);
}

export async function runDemo(ctx: DemoContext) {
  if (
    ctx.scenario.parallel &&
    (ctx.evidence.compute_mode !== "operator" ||
      !ctx.io.begin ||
      !ctx.io.finish ||
      !ctx.io.provePayout)
  )
    throw new PublicError(
      "Parallel mode requires the bounded operator session and serialized tool adapter.",
    );
  ctx.evidence.started_at ??= new Date(ctx.io.now()).toISOString();
  ctx.io.save();
  const entries: DemoCase[] = [];
  for (const worker of CASES) {
    const account = ctx.scenario.account(worker);
    let entry = ctx.evidence.cases.find((c) => c.worker === worker);
    if (!entry) {
      entry = { worker, worker_account: account };
      ctx.evidence.cases.push(entry);
      ctx.io.save();
    }
    if (entry.worker_account !== account)
      throw new PublicError(
        "Saved worker identity differs from the configured scoped signer.",
      );
    await createJob(ctx, entry);
    entries.push(entry);
    if (!ctx.scenario.parallel && !ctx.evidence.dry_run)
      await completeCase(ctx, entry);
  }
  if (ctx.scenario.parallel && !ctx.evidence.dry_run) {
    await ctx.io.begin?.(entries.map((entry) => entry.job_id!));
    const outcomes = await Promise.allSettled(
      entries.map((entry) => completeCase(ctx, entry)),
    );
    await ctx.io.finish?.();
    const failed = outcomes.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } else {
    await ctx.io.finish?.();
  }
  ctx.evidence.completed = new Date(ctx.io.now()).toISOString();
  ctx.evidence.elapsed_ms = ctx.io.now() - Date.parse(ctx.evidence.started_at);
  ctx.evidence.meets_two_minute_target =
    !ctx.evidence.dry_run &&
    !ctx.evidence.resumed &&
    ctx.evidence.elapsed_ms >= 0 &&
    ctx.evidence.elapsed_ms < 120_000;
  ctx.io.save();
  return ctx.evidence;
}

async function completeCase(ctx: DemoContext, entry: DemoCase) {
  ctx.io.event(`Scripted ${entry.worker} case: job ${entry.job_id}`);
  await prepareDelivery(ctx, entry);
  await pay(ctx, entry);
}
