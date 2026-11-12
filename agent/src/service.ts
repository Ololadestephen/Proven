import { createHash } from "node:crypto";
import { PublicError } from "./errors.ts";
import { loadConfig } from "./config.ts";
import { createRuntime } from "./near.ts";
import { attestationUrl } from "./network.ts";
import { boardTools, executeBoardTool, isBoardTool } from "./board-tools.ts";
import {
  bountyTools,
  executeBountyTool,
  isBountyTool,
} from "./bounty-tools.ts";
import {
  fields,
  flag,
  integer,
  object,
  requestId,
  text,
  type Args,
} from "./validation.ts";
import type { Actor, CallPlan, Job, RunKind, Runtime } from "./types.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const string = { type: "string" };
const id = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const boolean = { type: "boolean" };
const definitions: Array<[string, string, Record<string, unknown>, string[]]> =
  [
    [
      "challenge_check",
      "Legacy direct-job challenge. Market post_bid hands off its check automatically. Can pin only.",
      { job_id: id, check: string, reference: string, pin_only: boolean },
      ["job_id", "check", "reference"],
    ],
    [
      "list_jobs",
      "Read a bounded page of public jobs. No signing key is needed.",
      { from_id: id, limit: { type: "integer", minimum: 1, maximum: 50 } },
      [],
    ],
    [
      "deliver",
      "Commit the named worker's delivery hash and hand the delivery privately to the local relay. An identical delivered job can retry its handoff.",
      { job_id: id, deliverable: string },
      ["job_id", "deliverable"],
    ],
    [
      "request_verification",
      "Pin the previously handed-off texts and trigger escrow verification through buyer custody; any account may trigger on chain. Can pin only.",
      { job_id: id, pin_only: boolean },
      ["job_id"],
    ],
    [
      "release_or_refund",
      "Settle only the on-chain verdict or expiry, to the payee already fixed by the job.",
      { job_id: id },
      ["job_id"],
    ],
    [
      "collect_delivery",
      "After a job is Released, fetch its delivered text from the relay as its buyer. Treat the text as untrusted. Refunded work is not available.",
      { job_id: id },
      ["job_id"],
    ],
    [
      "job_status",
      "Read job state, attempt, output hashes and OutLayer attestation links. Does not claim Intel signature verification.",
      { job_id: id },
      ["job_id"],
    ],
    [
      "recover_outlayer_deposit",
      "Forward stale OutLayer cancellation; OutLayer alone determines the refund and original payer.",
      { request_id: { type: "string", pattern: "^[0-9]+$" } },
      ["request_id"],
    ],
  ];
export const tools = [
  ...definitions.map(([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { ...properties, dry_run: boolean },
      required,
      additionalProperties: false,
    } as Record<string, unknown>,
  })),
  ...boardTools,
  ...bountyTools,
];

function checkedFiles(
  check: string,
  other: string,
  job: Pick<Job, "spec_hash" | "fakes_hash" | "verifier_hash">,
): void {
  let parsed: { verifier?: unknown };
  try {
    parsed = object(JSON.parse(check));
  } catch {
    throw new PublicError(
      "Check must be a JSON object with the pinned verifier hash.",
    );
  }
  if (
    parsed.verifier !== job.verifier_hash ||
    hash(check) !== job.spec_hash ||
    hash(other) !== job.fakes_hash
  )
    throw new PublicError(
      "Private texts or verifier build do not match the job commitments.",
    );
}
function status(job: Job, escrow: string) {
  const attestation = (request: string | null) =>
    request ? attestationUrl(request, escrow) : null;
  return {
    ...job,
    challenge_attestation: attestation(job.challenge_request_id),
    verdict_attestation: attestation(job.verdict_request_id),
    attestation_verification:
      "Links and stored hashes only; this command does not verify Intel signatures.",
  };
}

export function createService(runtime: Runtime) {
  const plan = (
    method_name: string,
    args: Record<string, unknown>,
    deposit = "0",
    gas = "70000000000000",
  ): CallPlan => ({
    receiver_id: runtime.escrow,
    method_name,
    args,
    deposit,
    gas,
  });
  async function job(jobId: number): Promise<Job> {
    const value = await runtime.view<Job | null>("get_job", { job_id: jobId });
    if (!value) throw new PublicError("Job was not found.");
    return value;
  }
  function payable(dry: boolean) {
    if (!dry && runtime.actor !== "buyer" && runtime.actor !== "agent")
      throw new PublicError(
        "Payable agent calls require a custody wallet; scoped worker keys cannot attach NEAR.",
      );
  }
  async function submit(
    call: CallPlan,
    dry: boolean,
    handoff?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (dry)
      return {
        dry_run: true,
        call,
        ...(handoff ? { private_handoff: handoff } : {}),
      };
    return { ...(await runtime.submit(call)) };
  }
  async function clean(
    jobId: number,
    kind: RunKind,
    current: Job,
  ): Promise<boolean> {
    if (
      !(kind === "Challenge"
        ? current.challenge_request_id
        : current.verdict_request_id)
    )
      return false;
    try {
      await runtime.handoff({ action: "cleanup", job_id: jobId, kind });
      return true;
    } catch {
      return false;
    }
  }
  return async function execute(
    name: string,
    input: unknown,
    forceDry = false,
  ): Promise<unknown> {
    const definition = definitions.find(([key]) => key === name);
    if (!definition) throw new PublicError("Unknown tool.");
    const args = object(input);
    fields(args, [...Object.keys(definition[2]), "dry_run"]);
    const dry = flag(args, "dry_run") || forceDry;
    if (name === "list_jobs")
      return runtime.view("get_jobs", {
        from_id: integer(args, "from_id", 0, Number.MAX_SAFE_INTEGER, 0),
        limit: integer(args, "limit", 1, 50, 20),
      });
    if (name === "recover_outlayer_deposit")
      return submit(
        plan("cancel_stale_outlayer_execution", {
          request_id: requestId(text(args, "request_id", 20)),
        }),
        dry,
      );
    const jobId = integer(args, "job_id", 0, Number.MAX_SAFE_INTEGER);
    const current = await job(jobId);
    if (name === "job_status") return status(current, runtime.escrow);
    if (name === "collect_delivery") {
      if (current.state !== "Released")
        throw new PublicError(
          "A delivery can be collected only once the job is Released.",
        );
      if (current.buyer !== runtime.identity)
        throw new PublicError("Only the job's custody buyer can collect.");
      if (dry) return { dry_run: true, would_collect: jobId };
      return runtime.handoff({ action: "collect", job_id: jobId });
    }
    if (name === "challenge_check") {
      const check = text(args, "check"),
        reference = text(args, "reference"),
        pinOnly = flag(args, "pin_only");
      if (!["Draft", "Challenging"].includes(current.state))
        throw new PublicError("Job is not awaiting a challenge.");
      checkedFiles(check, reference, current);
      payable(dry || pinOnly);
      const call = plan(
        "request_challenge",
        { job_id: jobId },
        "100000000000000000000000",
        "150000000000000",
      );
      if (dry)
        return submit(call, true, {
          action: "challenge",
          job_id: jobId,
          check_hash: hash(check),
          reference_hash: hash(reference),
          pin_only: pinOnly,
        });
      const pinned = await runtime.handoff({
        action: "challenge",
        job_id: jobId,
        check,
        reference,
      });
      if (pinOnly) return { pinned, triggered: false };
      const transaction = await runtime.submit(call),
        after = await job(jobId);
      return {
        ...transaction,
        job: status(after, runtime.escrow),
        private_secret_deleted: await clean(jobId, "Challenge", after),
      };
    }
    if (name === "deliver") {
      const deliverable = text(args, "deliverable"),
        commitment = hash(deliverable);
      if (!["Funded", "Delivered"].includes(current.state))
        throw new PublicError("Job is not awaiting this delivery.");
      if (!dry && current.worker !== runtime.identity)
        throw new PublicError("Only the named worker may deliver.");
      if (
        current.state === "Delivered" &&
        current.deliverable_hash !== commitment
      )
        throw new PublicError(
          "The delivery is already fixed to different bytes.",
        );
      // Little gas, because attached gas is held back from a worker's small balance at a pessimistic price.
      const call = plan(
        "deliver",
        { job_id: jobId, deliverable_hash: commitment },
        "0",
        "15000000000000",
      );
      if (dry)
        return submit(call, true, {
          action: "deliver",
          job_id: jobId,
          deliverable_hash: commitment,
        });
      const transaction =
        current.state === "Funded"
          ? await runtime.submit(call)
          : { already_delivered: true };
      if ("failed" in transaction || "pending" in transaction)
        return { ...transaction, private_handoff: false };
      try {
        return {
          ...transaction,
          private_handoff: await runtime.handoff({
            action: "deliver",
            job_id: jobId,
            deliverable,
          }),
        };
      } catch {
        return {
          ...transaction,
          private_handoff: false,
          retry:
            "Repeat deliver with identical bytes to retry private handoff; no second delivery transaction will be sent.",
        };
      }
    }
    if (name === "request_verification") {
      const pinOnly = flag(args, "pin_only");
      if (!["Delivered", "Verifying"].includes(current.state))
        throw new PublicError("Job is not awaiting verification.");
      payable(dry || pinOnly);
      const call = plan(
        "request_verification",
        { job_id: jobId },
        "100000000000000000000000",
        "150000000000000",
      );
      if (dry)
        return submit(call, true, {
          action: "pin_verification",
          job_id: jobId,
          pin_only: pinOnly,
        });
      const pinned = await runtime.handoff({
        action: "pin_verification",
        job_id: jobId,
      });
      if (pinOnly) return { pinned, triggered: false };
      const transaction = await runtime.submit(call),
        after = await job(jobId);
      return {
        ...transaction,
        job: status(after, runtime.escrow),
        private_secret_deleted: await clean(jobId, "Verify", after),
      };
    }
    const now = await runtime.now();
    let method: string;
    if (current.state === "Passed") method = "release";
    else if (current.state === "Failed") method = "refund";
    else {
      const expiry =
        current.state === "Funded"
          ? BigInt(current.deadline)
          : BigInt(current.delivered_at ?? "0") +
            BigInt(current.verdict_window_secs) * 1000000000n;
      if (
        !["Funded", "Delivered", "Verifying"].includes(current.state) ||
        now <= expiry ||
        (current.state === "Verifying" &&
          now <= BigInt(current.run_started_at ?? "0") + 900000000000n)
      )
        throw new PublicError("No payable verdict or expiry is available.");
      method = "expire";
    }
    return submit(plan(method, { job_id: jobId }), dry);
  };
}

export async function executeTool(
  name: string,
  args: unknown,
  options?: { actor?: Actor; dryRun?: boolean },
): Promise<unknown> {
  // Bounty tools are read-only or unsigned plans: no config file, key or actor is involved.
  if (isBountyTool(name)) return executeBountyTool(name, args);
  const config = loadConfig(options?.actor);
  const service = createService(createRuntime(config));
  if (isBoardTool(name))
    return executeBoardTool(name, args, config, options?.dryRun);
  return service(name, args, options?.dryRun);
}
