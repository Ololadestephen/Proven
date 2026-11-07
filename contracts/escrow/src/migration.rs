//! The layout of the version deployed on mainnet before one-signature jobs, read once by `migrate`.

use crate::{AssetCap, Job, JobId, JobState, Release, StorageKey};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId, NearToken};

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
    pub caps: Vec<AssetCap>,
    pub held_by_buyer: LookupMap<(AccountId, Option<AccountId>), u128>,
}

/// The earlier job's state names, in their earlier order.
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub(crate) enum OldState {
    Draft,
    Challenging,
    CheckRejected,
    Challenged,
    Funded,
    Delivered,
    Verifying,
    Passed,
    Failed,
    Releasing,
    Refunding,
    Expiring,
    Released,
    Refunded,
    Expired,
}

impl OldState {
    fn upgraded(self) -> JobState {
        match self {
            Self::Draft => JobState::Draft,
            Self::Challenging => JobState::Challenging,
            Self::CheckRejected => JobState::CheckRejected,
            Self::Challenged => JobState::Challenged,
            Self::Funded => JobState::Funded,
            Self::Delivered => JobState::Delivered,
            Self::Verifying => JobState::Verifying,
            Self::Passed => JobState::Passed,
            Self::Failed => JobState::Failed,
            Self::Releasing => JobState::Releasing,
            Self::Refunding => JobState::Refunding,
            Self::Expiring => JobState::Expiring,
            Self::Released => JobState::Released,
            Self::Refunded => JobState::Refunded,
            Self::Expired => JobState::Expired,
        }
    }
}

#[near(serializers = [borsh])]
pub(crate) struct OldJob {
    pub buyer: AccountId,
    pub worker: AccountId,
    pub token: Option<AccountId>,
    pub amount: U128,
    pub spec_hash: String,
    pub fakes_hash: String,
    pub format_hash: String,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub secrets_owner: AccountId,
    pub deadline: U64,
    pub verdict_window_secs: u32,
    pub state: OldState,
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
    /// An earlier job had one named worker and one attempt, and no compute budget.
    pub(crate) fn upgraded(self) -> Job {
        Job {
            buyer: self.buyer,
            worker: Some(self.worker),
            token: self.token,
            amount: self.amount,
            spec_hash: self.spec_hash,
            fakes_hash: self.fakes_hash,
            format_hash: self.format_hash,
            verifier_url: self.verifier_url,
            verifier_hash: self.verifier_hash,
            secrets_owner: self.secrets_owner,
            release: Release::Verdict,
            compute_budget: U128(0),
            expires_at: self.deadline,
            deliver_secs: 0,
            deadline: self.deadline,
            verdict_window_secs: self.verdict_window_secs,
            max_attempts: 1,
            history: Vec::new(),
            state: self.state.upgraded(),
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

#[allow(dead_code)]
const _: Option<(U64, NearToken)> = None;
