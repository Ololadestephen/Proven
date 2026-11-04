export type Actor = "buyer" | "honest" | "fake";
export type RunKind = "Challenge" | "Verify";
export interface Job {
  buyer: string;
  worker: string;
  amount: string;
  token: string | null;
  state: string;
  spec_hash: string;
  fakes_hash: string;
  verifier_hash: string;
  secrets_owner: string;
  deliverable_hash: string | null;
  deadline: string;
  delivered_at: string | null;
  verdict_window_secs: number;
  attempt: number;
  run_started_at: string | null;
  fakes_total: number;
  fakes_caught: number;
  challenge_request_id: string | null;
  challenge_report_hash: string | null;
  verdict_request_id: string | null;
  report_hash: string | null;
  failed_rule: string | null;
}
export interface ChainConfig {
  verifier_hash: string;
  next_job_id: number;
}
export interface CallPlan {
  receiver_id: string;
  method_name: string;
  args: Record<string, unknown>;
  deposit: string;
  gas: string;
}
export interface CallResult {
  transaction_hash: string;
  result?: unknown;
  pending?: boolean;
  failed?: boolean;
}
export interface Runtime {
  actor: Actor;
  identity: string | null;
  escrow: string;
  view<T>(method: string, args: Record<string, unknown>): Promise<T>;
  now(): Promise<bigint>;
  submit(plan: CallPlan): Promise<CallResult>;
  handoff(request: Record<string, unknown>): Promise<unknown>;
}
