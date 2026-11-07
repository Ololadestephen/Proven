import { randomUUID } from "node:crypto";
import type { RunKind, SubmissionMetadata } from "./near.ts";

export interface SponsorJob {
  state: string;
  secrets_owner: string;
  buyer?: string;
  worker?: string | null;
  token?: string | null;
  amount?: string;
  spec_hash: string;
  fakes_hash: string;
  verifier_hash: string;
}
export interface DemoCompute {
  buyer: string;
  workers: readonly string[];
  specHash: string;
  referenceHash: string;
  verifierHash: string;
  trigger(
    jobId: number,
    kind: RunKind,
    beforeBroadcast: (
      hash: string,
      metadata: SubmissionMetadata,
    ) => Promise<void>,
  ): Promise<string>;
}
interface Reservation {
  job_id: number;
  kind: RunKind;
  transaction_hash?: string;
  submission?: SubmissionMetadata;
}
export interface SponsorRecord {
  session_id: string;
  jobs: number[];
  attempts: Reservation[];
  compute_payer: string;
}
type WalletQueue = <T>(action: () => Promise<T>) => Promise<T>;
function requireSafe(value: unknown): asserts value {
  if (!value) throw new Error("Demo sponsorship refused");
}

/** A single explicit operator session; durable intent precedes every fixed compute call. */
export function createDemoSponsor(
  config: DemoCompute | undefined,
  operator: string,
  getJob: (id: number) => Promise<SponsorJob | null>,
  wallet: WalletQueue,
  persist: (record: SponsorRecord) => Promise<void>,
) {
  const record: SponsorRecord = {
    session_id: randomUUID(),
    jobs: [],
    attempts: [],
    compute_payer: operator,
  };
  function fixed(job: SponsorJob | null): asserts job is SponsorJob {
    requireSafe(
      config &&
        job &&
        job.secrets_owner === operator &&
        job.buyer === config.buyer &&
        config.workers.includes(job.worker ?? "") &&
        job.amount === "10000000000000000000000" &&
        job.token === null &&
        job.spec_hash === config.specHash &&
        job.fakes_hash === config.referenceHash &&
        job.verifier_hash === config.verifierHash,
    );
  }
  return {
    status() {
      return {
        enabled: !!config,
        session_id: record.session_id,
        remaining: config ? 4 - record.attempts.length : 0,
        jobs: [...record.jobs],
        compute_payer: operator,
        buyer: config?.buyer,
        workers: config?.workers,
        spec_hash: config?.specHash,
        reference_hash: config?.referenceHash,
        verifier_hash: config?.verifierHash,
      };
    },
    async register(value: unknown, session: string) {
      requireSafe(session === record.session_id);
      requireSafe(
        config &&
          Array.isArray(value) &&
          value.length === 2 &&
          value.every((id) => Number.isSafeInteger(id) && id >= 0) &&
          value[0] !== value[1],
      );
      const ids = value as number[];
      return wallet(async () => {
        if (record.jobs.length) {
          requireSafe(JSON.stringify(record.jobs) === JSON.stringify(ids));
          return;
        }
        const jobs = await Promise.all(ids.map(getJob));
        jobs.forEach(fixed);
        requireSafe(
          jobs.every((job) => job!.state === "Draft") &&
            new Set(jobs.map((job) => job!.worker)).size === 2,
        );
        record.jobs = [...ids];
        await persist(record);
      });
    },
    async trigger(
      id: number,
      kind: RunKind,
      session: string,
      isPinned: () => boolean,
    ) {
      return wallet(async () => {
        requireSafe(
          session === record.session_id &&
            config &&
            isPinned() &&
            record.jobs.includes(id) &&
            record.attempts.length < 4 &&
            !record.attempts.some((a) => a.job_id === id && a.kind === kind),
        );
        const job = await getJob(id);
        fixed(job);
        requireSafe(
          job.state === (kind === "Challenge" ? "Draft" : "Delivered"),
        );
        const attempt: Reservation = { job_id: id, kind };
        record.attempts.push(attempt);
        await persist(record); // A failure or lost response still consumes the attempt.
        attempt.transaction_hash = await config!.trigger(
          id,
          kind,
          async (hash, metadata) => {
            requireSafe(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash));
            attempt.transaction_hash = hash;
            attempt.submission = metadata;
            await persist(record);
          },
        );
        await persist(record);
        return {
          transaction_hash: attempt.transaction_hash,
          compute_payer: operator,
          session_id: record.session_id,
        };
      });
    },
  };
}
