import { createHash } from "node:crypto";
import { PublicError } from "./errors.ts";
import { loadConfig } from "./config.ts";
import { createRuntime } from "./near.ts";
import { boardTools, executeBoardTool, isBoardTool } from "./board-tools.ts";
import {
  accountId,
  fields,
  flag,
  integer,
  object,
  requestId,
  text,
  yocto,
  type Args,
} from "./validation.ts";
import type {
  Actor,
  CallPlan,
  ChainConfig,
  Job,
  RunKind,
  Runtime,
} from "./types.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const string = { type: "string" };
const id = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const boolean = { type: "boolean" };
const definitions: Array<[string, string, Record<string, unknown>, string[]]> =
  [
    [
      "post_job",
      "Create a native-NEAR job with a named worker and committed private check/reference. The worker must be on the operator's list; use post_job_for_claim for a board claim. Buyer custody only; amount at most 0.1 NEAR.",
      {
        worker: string,
        check: string,
        reference: string,
        amount_near: string,
        deadline_seconds: { type: "integer", minimum: 600 },
        verdict_window_secs: { type: "integer", minimum: 1800 },
        storage_deposit_near: string,
      },
      ["worker", "check", "reference", "amount_near"],
    ],
    [
      "challenge_check",
      "Privately hand off and pin a check/reference, then ask escrow to run its challenge. Can pin only.",
      { job_id: id, check: string, reference: string, pin_only: boolean },
      ["job_id", "check", "reference"],
    ],
    [
      "fund_job",
      "Fund a challenged native-NEAR job for exactly its recorded amount through buyer custody.",
      { job_id: id },
      ["job_id"],
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
function status(job: Job) {
  const attestation = (request: string | null) =>
    request
      ? `https://testnet-api.outlayer.ai/attestations/by-request/${request}`
      : null;
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
    if (name === "post_job") {
      payable(dry);
      const worker = accountId(text(args, "worker", 64));
      // A tool argument may come from a model, so it only selects from what the operator or a board
      // claim has already allowed. An empty list refuses everyone.
      if (!runtime.allowedWorkers.includes(worker))
        throw new PublicError(
          "That worker is not allowed. A worker comes from a board claim or the operator's list.",
        );
      const check = text(args, "check"),
        reference = text(args, "reference");
      const cfg = await runtime.view<ChainConfig>("get_config", {});
      checkedFiles(check, reference, {
        spec_hash: hash(check),
        fakes_hash: hash(reference),
        verifier_hash: cfg.verifier_hash,
      });
      const deadline =
        (await runtime.now()) +
        BigInt(integer(args, "deadline_seconds", 600, 2592000, 3600)) *
          1000000000n;
      const call = plan(
        "create_job",
        {
          worker,
          spec_hash: hash(check),
          fakes_hash: hash(reference),
          amount: yocto(text(args, "amount_near", 30)),
          token: null,
          deadline: deadline.toString(),
          verdict_window_secs: integer(
            args,
            "verdict_window_secs",
            1800,
            604800,
            1800,
          ),
          verifier_hash: cfg.verifier_hash,
        },
        args.storage_deposit_near === undefined
          ? "50000000000000000000000"
          : yocto(text(args, "storage_deposit_near", 30)),
      );
      if (BigInt(call.deposit) > 50000000000000000000000n)
        throw new PublicError("Job storage deposit cannot exceed 0.05 NEAR.");
      return submit(call, dry);
    }
    const jobId = integer(args, "job_id", 0, Number.MAX_SAFE_INTEGER);
    const current = await job(jobId);
    if (name === "job_status") return status(current);
    if (name === "fund_job") {
      payable(dry);
      if (current.state !== "Challenged" || current.token !== null)
        throw new PublicError(
          "Only challenged native-NEAR jobs can be funded by this custody policy. Token funding targets a different contract.",
        );
      if (!dry && current.buyer !== runtime.identity)
        throw new PublicError("Only the job's custody buyer can fund it.");
      if ((await runtime.now()) + 600000000000n >= BigInt(current.deadline))
        throw new PublicError(
          "Leave at least ten minutes before delivery deadline when funding.",
        );
      return submit(plan("fund", { job_id: jobId }, current.amount), dry);
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
        job: status(after),
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
      const call = plan("deliver", {
        job_id: jobId,
        deliverable_hash: commitment,
      });
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
        job: status(after),
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
  const config = loadConfig(options?.actor);
  const service = createService(createRuntime(config));
  if (isBoardTool(name))
    return executeBoardTool(
      name,
      args,
      config,
      (job_id) => service("fund_job", { job_id }),
      (worker, jobArgs) =>
        createService(createRuntime({ ...config, allowedWorkers: [worker] }))(
          "post_job",
          jobArgs,
          options?.dryRun,
        ),
      options?.dryRun,
    );
  return service(name, args, options?.dryRun);
}
