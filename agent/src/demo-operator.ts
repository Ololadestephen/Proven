import { PublicError } from "./errors.ts";
import type { Actor } from "./types.ts";
import type { DemoContext, DemoEvidence, Outcome } from "./demo-runner.ts";

type Tool = DemoContext["io"]["tool"];
export interface OperatorStatus {
  enabled: boolean;
  session_id: string;
  remaining: number;
  jobs: number[];
  compute_payer: string;
  buyer: string;
  workers: string[];
  spec_hash: string;
  reference_hash: string;
  verifier_hash: string;
  escrow: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PublicError("Invalid private operator response.");
  return value as Record<string, unknown>;
}

/** Buyer and worker writes stay serialized; the operator key never enters this process. */
export function createOperatorDemoTools(
  call: Tool,
  request: (value: Record<string, unknown>) => Promise<unknown>,
  evidence: DemoEvidence,
  status: OperatorStatus,
  save: () => void,
  settle: (transaction: string, payer: string) => Promise<Outcome>,
) {
  const send = (value: Record<string, unknown>) =>
    request({ ...value, session_id: status.session_id });
  const queues = new Map<Actor, Promise<unknown>>();
  const cleanups: Promise<void>[] = [];
  async function compute(
    actor: Actor,
    name: string,
    args: Record<string, unknown>,
  ) {
    const kind = name === "challenge_check" ? "Challenge" : "Verify";
    await call(actor, name, { ...args, pin_only: true });
    const reply = object(
      await send({ action: "trigger", job_id: args.job_id, kind }),
    );
    if (
      reply.session_id !== status.session_id ||
      reply.compute_payer !== status.compute_payer ||
      typeof reply.transaction_hash !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(reply.transaction_hash)
    )
      throw new PublicError(
        "Operator compute outcome requires reconciliation. No write was retried.",
      );
    const entry = evidence.cases.find((row) => row.job_id === args.job_id);
    if (!entry)
      throw new PublicError(
        "Submitted operator call needs checkpoint reconciliation.",
      );
    const field = kind === "Challenge" ? "challenge" : "verification";
    entry[field] = { transaction_hash: reply.transaction_hash, pending: true };
    save();
    const settled = await settle(reply.transaction_hash, status.compute_payer);
    if (settled.pending || settled.failed || settled.result !== true)
      throw new PublicError(
        "Known operator transaction has no confirmed recorded result. No compute call was repeated.",
      );
    // Delete only after recorded settlement. Finish includes cleanup in the full command timer.
    cleanups.push(
      (async () => {
        const row = {
          job_id: args.job_id as number,
          kind,
          deleted: false,
          transaction_hash: undefined as string | undefined,
        };
        try {
          const deleted = object(
            await send({ action: "cleanup", job_id: args.job_id, kind }),
          );
          if (
            typeof deleted.transaction_hash === "string" &&
            /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(deleted.transaction_hash)
          ) {
            row.deleted = true;
            row.transaction_hash = deleted.transaction_hash;
          }
        } catch {
          /* Preserve the unconfirmed cleanup rather than retrying a write. */
        }
        (evidence.cleanup ??= []).push(row);
        save();
      })(),
    );
    return { ...reply, result: settled.result };
  }
  return {
    async begin(ids: number[]) {
      const registered = object(
        await send({ action: "register_demo", job_ids: ids }),
      );
      if (
        registered.session_id !== status.session_id ||
        JSON.stringify(registered.jobs) !== JSON.stringify(ids) ||
        registered.remaining !== status.remaining
      )
        throw new PublicError(
          "Operator session registration differs from this run. No compute was triggered.",
        );
    },
    async tool(
      actor: Actor,
      name: string,
      args: Record<string, unknown>,
      dry?: boolean,
    ) {
      if (dry || ["job_status", "list_jobs"].includes(name))
        return call(actor, name, args, dry);
      if (["challenge_check", "request_verification"].includes(name))
        return compute(actor, name, args);
      const next = (queues.get(actor) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => call(actor, name, args));
      queues.set(actor, next);
      return next;
    },
    async finish() {
      await Promise.all(cleanups);
      if (evidence.cleanup?.some((row) => !row.deleted))
        throw new PublicError(
          "Payments may be complete but secret cleanup needs reconciliation. No deletion was automatically repeated.",
        );
    },
  };
}
