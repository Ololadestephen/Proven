//! The layout of the version already deployed on mainnet, read once by `migrate`.

use crate::{Job, JobId, JobState, StorageKey};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId, NearToken};

#[near(serializers = [borsh])]
pub(crate) struct OldCap {
    pub token: Option<AccountId>,
    pub max_job: U128,
    pub max_held: U128,
    pub held: U128,
}

#[near(serializers = [borsh])]
pub(crate) struct OldEscrow {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub secrets_owner: AccountId,
    pub tokens: Vec<AccountId>,
    pub jobs: LookupMap<JobId, OldJob>,
    pub next_id: JobId,
    pub paused: bool,
    pub caps: Vec<OldCap>,
}

#[near(serializers = [borsh])]
pub(crate) struct OldJob {
    pub buyer: AccountId,
    pub worker: AccountId,
    pub token: Option<AccountId>,
    pub amount: U128,
    pub spec_hash: String,
    pub fakes_hash: String,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub secrets_owner: AccountId,
    pub deadline: U64,
    pub verdict_window_secs: u32,
    pub state: JobState,
    pub storage_deposit: NearToken,
    pub attempt: u32,
    pub run_started_at: Option<U64>,
    pub fakes_total: u32,
    pub fakes_caught: u32,
    pub challenge_report_hash: Option<String>,
    pub challenge_request_id: Option<U64>,
    pub delivered_at: Option<U64>,
    pub deliverable_hash: Option<String>,
    pub report_hash: Option<String>,
    pub verdict_request_id: Option<U64>,
    pub failed_rule: Option<String>,
}

impl OldJob {
    pub(crate) fn upgraded(self) -> Job {
        Job {
            buyer: self.buyer,
            worker: self.worker,
            token: self.token,
            amount: self.amount,
            spec_hash: self.spec_hash,
            fakes_hash: self.fakes_hash,
            format_hash: String::new(),
            verifier_url: self.verifier_url,
            verifier_hash: self.verifier_hash,
            secrets_owner: self.secrets_owner,
            deadline: self.deadline,
            verdict_window_secs: self.verdict_window_secs,
            state: self.state,
            storage_deposit: self.storage_deposit,
            attempt: self.attempt,
            run_started_at: self.run_started_at,
            fakes_total: self.fakes_total,
            fakes_caught: self.fakes_caught,
            challenge_report_hash: self.challenge_report_hash,
            challenge_request_id: self.challenge_request_id,
            delivered_at: self.delivered_at,
            deliverable_hash: self.deliverable_hash,
            report_hash: self.report_hash,
            verdict_request_id: self.verdict_request_id,
            failed_rule: self.failed_rule,
        }
    }
}

/// Where the map keeps one job: the map's prefix, then the id, with no hashing. Read and written
/// directly, because the map itself would try to read an old job in the new layout.
pub(crate) fn job_key(id: JobId) -> Vec<u8> {
    let mut key = near_sdk::borsh::to_vec(&StorageKey::Jobs).unwrap_or_default();
    key.extend(near_sdk::borsh::to_vec(&id).unwrap_or_default());
    key
}
