// Turns the verifier's output into the escrow call, refusing anything malformed. Only fields of
// the attested output are used; nothing is taken from the files being judged.

import type { Job } from "./near.ts";

type Common = { job_id: number; spec_hash: string; report_hash: string; attestation_hash: string };
type Call = readonly ["record_challenge" | "record_verdict", Record<string, unknown>];

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new Error(`the verifier output has an invalid ${name}`);
  }
  return value as number;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`the verifier output has an invalid ${name}`);
  return value;
}

export function challengeCall(verdict: Record<string, unknown>, job: Job, common: Common): Call {
  const total = count(verdict.fakes_total, "fakes_total");
  const caught = count(verdict.fakes_caught, "fakes_caught");
  if (caught > total) throw new Error("the verifier output has more fakes caught than planted");
  return ["record_challenge", { ...common, fakes_hash: job.fakes_hash, reference_passed: flag(verdict.reference_passed, "reference_passed"), fakes_total: total, fakes_caught: caught }];
}

export function verdictCall(verdict: Record<string, unknown>, job: Job, common: Common): Call {
  return ["record_verdict", { ...common, deliverable_hash: job.deliverable_hash, pass: flag(verdict.pass, "pass") }];
}
