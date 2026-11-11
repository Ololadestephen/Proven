// The bounty contract's JSON, as its views return it (contracts/pr-bounty/src/lib.rs). u64 and
// u128 values that the contract wraps as U64 and U128 arrive as decimal strings; plain u64
// fields (issue, pr_number, attempt) arrive as numbers.
import type { SettlementView } from "./vault-view.ts";

export type BountyStatusName =
  | "Open"
  | "Claimed"
  | "Bound"
  | "Paid"
  | "Ineligible"
  | "Refunded"
  | "Cancelled";

export interface Claim {
  wallet: string;
  github_id: string;
  key: string;
  vault: string;
  /** Nanoseconds. */
  claimed_at: string;
  /** Unix seconds. */
  ends_at: string;
}
export interface Binding {
  pr_number: number;
  pr_id: string;
  author_id: string;
  wallet: string;
  bound_at: string;
  request_id: string;
}
export interface LiveRun {
  seq: string;
  kind: "Submit" | "Merge";
  /** Nanoseconds. */
  requested_at: string;
  pr_number: number;
  payer: string;
  sponsored: boolean;
  gist_id: string | null;
}
export interface CheckRecord {
  seq: string;
  kind: string;
  request_id: string | null;
  /** Nanoseconds. */
  resolved_at: string;
  outcome: string;
}
export interface Bounty {
  buyer: string;
  reward: string;
  sponsored_runs: number;
  repo: string;
  repo_id: string;
  issue: number;
  base_ref: string;
  posted_at: string;
  /** Unix seconds. */
  claim_by: string;
  claim_secs: string;
  /** Unix seconds. */
  merge_deadline: string;
  grace_secs: string;
  status: BountyStatusName;
  maintainer_key: string;
  maintainer_vault: string;
  posting_nonce: string;
  claim: Claim | null;
  binding: Binding | null;
  merge: { merged_at: string; request_id: string; checked_at: string } | null;
  live: LiveRun | null;
  last_check: CheckRecord | null;
  /** Nanoseconds. */
  definite_look: { requested_at: string; resolved_at: string } | null;
  payout: SettlementView | null;
  refund: SettlementView | null;
}
export interface Config {
  owner: string;
  network: string;
  verifier_url: string;
  verifier_hash: string;
  pilot_repo: string;
  pilot_repo_id: string;
  vault_code_hash: string;
  sponsor: string;
  paused: boolean;
  max_reward: string;
  max_held: string;
  held: string;
  run_deposit: string;
  sponsored_runs_per_bounty: number;
  sponsor_float: string;
  storage_deposit: string;
  link_storage_deposit: string;
  reconcile_deposit: string;
  party_reconcile_delay_secs: number;
  open_reconcile_delay_secs: number;
  relink_delay_secs: number;
  refund_cap_secs: number;
  min_claim_secs: number;
}
export type Listing =
  | { configured: false }
  | {
      configured: true;
      contract: string;
      config: Config;
      bounties: [number, Bounty][];
    };

export interface LinkRecord {
  github_id: string;
  gist_id: string;
  challenge: string;
  linked_at: string;
}
/** `get_link`: the link in force and a change waiting for its delay. `null` before any link. */
export interface WalletLink {
  active: LinkRecord | null;
  pending: { link: LinkRecord; activates_at: string } | null;
}
