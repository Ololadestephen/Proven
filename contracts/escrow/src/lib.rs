//! Proven escrow.
//!
//! A buyer creates a job for a named worker, fixed by the hash of its acceptance check and
//! the hash of its planted fakes. The verifier relay records the check challenge: only a check
//! that rejected every planted fake can be funded. The buyer funds the job in NEAR or an
//! accepted NEP-141 token, the worker delivers a deliverable hash before the deadline, and the
//! relay records the verdict for exactly that spec and deliverable. A pass pays the worker and a
//! fail refunds the buyer. If the worker never delivers, or the relay never rules within the
//! verdict window, anyone can expire the job and the buyer is refunded.
//!
//! Lifecycle:
//! - `Draft` -> `record_challenge` -> `Challenged`, or `CheckRejected` if any fake got through or
//!   the check failed the reference deliverable
//! - `Challenged` -> `fund` / `ft_transfer_call` -> `Funded` -> `deliver` -> `Delivered`
//! - `Delivered` -> `record_verdict` -> `Passed` or `Failed`
//! - `Passed` -> `release` -> `Released`; `Failed` -> `refund` -> `Refunded`
//! - `Funded` after the deadline, or `Delivered` after the verdict window -> `expire` -> `Expired`
//! - `Draft`, `CheckRejected` or `Challenged` -> `cancel`: the job is removed and its storage
//!   deposit returned
//!
//! Payouts pass through `Releasing`, `Refunding` or `Expiring` until the transfer's callback
//! confirms it. A failed transfer returns the job to the state it came from, so the payout can
//! be retried; nothing is marked paid until the money has moved.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub type JobId = u64;

const NANOS_PER_SEC: u64 = 1_000_000_000;
const MAX_DEADLINE_NANOS: u64 = 30 * 24 * 60 * 60 * NANOS_PER_SEC;
const MIN_VERDICT_WINDOW_SECS: u32 = 60;
const MAX_VERDICT_WINDOW_SECS: u32 = 7 * 24 * 60 * 60;
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Fewest confirmed fakes a check must face before it can be accepted (the verifier uses the same).
pub const MIN_FAKES: u32 = 5;
/// A 64-character placeholder used to size a job's storage at its largest.
const FULL_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    Draft,
    CheckRejected,
    Challenged,
    Funded,
    Delivered,
    Passed,
    Failed,
    Releasing,
    Refunding,
    Expiring,
    Released,
    Refunded,
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub buyer: AccountId,
    pub worker: AccountId,
    /// `None` means the job is paid in NEAR.
    pub token: Option<AccountId>,
    pub amount: U128,
    /// SHA-256 of the acceptance check, 64 lowercase hex characters.
    pub spec_hash: String,
    /// SHA-256 of the planted fakes the check is challenged with.
    pub fakes_hash: String,
    /// Delivery deadline, in nanoseconds since the Unix epoch.
    pub deadline: U64,
    /// How long the relay has to record a verdict after delivery.
    pub verdict_window_secs: u32,
    pub state: JobState,
    /// NEAR the buyer paid for this job's storage, returned if the job is cancelled.
    pub storage_deposit: NearToken,
    pub fakes_total: u32,
    pub fakes_caught: u32,
    pub challenge_report_hash: Option<String>,
    pub challenge_attestation_hash: Option<String>,
    pub delivered_at: Option<U64>,
    pub deliverable_hash: Option<String>,
    pub report_hash: Option<String>,
    pub attestation_hash: Option<String>,
}

impl Job {
    /// The same job with every optional field filled, used to charge storage at its largest.
    fn at_full_size(&self) -> Self {
        let full = Some(FULL_HASH.to_string());
        Self {
            challenge_report_hash: full.clone(),
            challenge_attestation_hash: full.clone(),
            delivered_at: Some(U64(u64::MAX)),
            deliverable_hash: full.clone(),
            report_hash: full.clone(),
            attestation_hash: full,
            ..self.clone()
        }
    }

    fn verdict_deadline(&self) -> u64 {
        let delivered_at = self.delivered_at.map_or(0, |t| t.0);
        delivered_at.saturating_add(u64::from(self.verdict_window_secs) * NANOS_PER_SEC)
    }
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub relay: AccountId,
    pub tokens: Vec<AccountId>,
    pub next_job_id: JobId,
}

// The macro generates `ext_ft` from this trait; the trait itself is never called directly.
#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Jobs,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    owner: AccountId,
    relay: AccountId,
    tokens: Vec<AccountId>,
    jobs: LookupMap<JobId, Job>,
    next_id: JobId,
}

fn require_hash(value: &str, name: &str) {
    let valid = value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    require!(valid, format!("{name} must be 64 lowercase hex characters"));
}

fn emit(event: &str, job_id: JobId) {
    let log = json!({
        "standard": "proven",
        "version": "1.0.0",
        "event": event,
        "data": [{ "job_id": job_id }],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

#[near]
impl Escrow {
    #[init]
    pub fn new(owner: AccountId, relay: AccountId) -> Self {
        Self { owner, relay, tokens: Vec::new(), jobs: LookupMap::new(StorageKey::Jobs), next_id: 0 }
    }

    // ---- Owner ----

    pub fn set_relay(&mut self, relay: AccountId) {
        self.require_owner();
        self.relay = relay;
    }

    pub fn add_token(&mut self, token: AccountId) {
        self.require_owner();
        if !self.tokens.contains(&token) {
            self.tokens.push(token);
        }
    }

    pub fn remove_token(&mut self, token: AccountId) {
        self.require_owner();
        self.tokens.retain(|t| *t != token);
    }

    // ---- Buyer ----

    /// Records a job. The caller attaches enough NEAR to pay for the job's storage at its
    /// largest; any excess is returned.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_job(
        &mut self,
        worker: AccountId,
        spec_hash: String,
        fakes_hash: String,
        amount: U128,
        token: Option<AccountId>,
        deadline: U64,
        verdict_window_secs: u32,
    ) -> JobId {
        let buyer = env::predecessor_account_id();
        let now = env::block_timestamp();
        require_hash(&spec_hash, "spec_hash");
        require_hash(&fakes_hash, "fakes_hash");
        require!(worker != buyer, "the worker cannot be the buyer");
        require!(amount.0 > 0, "amount must be greater than zero");
        if let Some(token) = &token {
            require!(self.tokens.contains(token), "token is not accepted");
        }
        require!(
            deadline.0 > now && deadline.0 - now <= MAX_DEADLINE_NANOS,
            "deadline must be in the future and at most 30 days away"
        );
        require!(
            (MIN_VERDICT_WINDOW_SECS..=MAX_VERDICT_WINDOW_SECS).contains(&verdict_window_secs),
            "verdict_window_secs must be between 60 and 604800"
        );

        let id = self.next_id;
        self.next_id += 1;
        let mut job = Job {
            buyer: buyer.clone(),
            worker,
            token,
            amount,
            spec_hash,
            fakes_hash,
            deadline,
            verdict_window_secs,
            state: JobState::Draft,
            storage_deposit: NearToken::from_yoctonear(0),
            fakes_total: 0,
            fakes_caught: 0,
            challenge_report_hash: None,
            challenge_attestation_hash: None,
            delivered_at: None,
            deliverable_hash: None,
            report_hash: None,
            attestation_hash: None,
        };

        // Charge for the job at its largest, so later steps never draw on the contract's balance.
        let storage_before = env::storage_usage();
        self.jobs.insert(id, job.at_full_size());
        self.jobs.flush();
        let storage_cost = env::storage_byte_cost()
            .saturating_mul(u128::from(env::storage_usage() - storage_before));
        let attached = env::attached_deposit();
        require!(attached >= storage_cost, format!("attach at least {storage_cost} for storage"));
        job.storage_deposit = storage_cost;
        self.jobs.insert(id, job);

        let excess = attached.saturating_sub(storage_cost);
        if !excess.is_zero() {
            Promise::new(buyer).transfer(excess).detach();
        }
        emit("job_created", id);
        id
    }

    /// Removes a job that was never funded and returns its storage deposit to the buyer.
    pub fn cancel(&mut self, job_id: JobId) -> Promise {
        let job = self.job(job_id).clone();
        require!(env::predecessor_account_id() == job.buyer, "only the buyer can cancel");
        require!(
            matches!(job.state, JobState::Draft | JobState::CheckRejected | JobState::Challenged),
            "only an unfunded job can be cancelled"
        );
        self.jobs.remove(&job_id);
        emit("job_cancelled", job_id);
        Promise::new(job.buyer).transfer(job.storage_deposit)
    }

    /// Locks the job's payment in NEAR. Only the buyer, with exactly the job amount attached.
    #[payable]
    pub fn fund(&mut self, job_id: JobId) {
        let amount = env::attached_deposit().as_yoctonear();
        self.lock_payment(job_id, &env::predecessor_account_id(), None, amount);
    }

    /// NEP-141 receiver: funds a token job. `msg` is the job id.
    /// A panic here makes the token contract return the tokens to the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(self.tokens.contains(&token), "token is not accepted");
        let job_id: JobId = msg.trim().parse().unwrap_or_else(|_| env::panic_str("msg must be the job id"));
        self.lock_payment(job_id, &sender_id, Some(&token), amount.0);
        PromiseOrValue::Value(U128(0))
    }

    // ---- Worker ----

    /// Fixes the deliverable by its hash. Only the job's worker, before the deadline.
    pub fn deliver(&mut self, job_id: JobId, deliverable_hash: String) {
        require_hash(&deliverable_hash, "deliverable_hash");
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let job = self.job_mut(job_id);
        require!(caller == job.worker, "only the job's worker can deliver");
        require!(job.state == JobState::Funded, "job is not awaiting delivery");
        require!(now <= job.deadline.0, "the delivery deadline has passed");
        job.deliverable_hash = Some(deliverable_hash);
        job.delivered_at = Some(U64(now));
        job.state = JobState::Delivered;
        emit("job_delivered", job_id);
    }

    // ---- Verifier relay ----

    /// Records the check challenge. The check is accepted only if it passed the reference
    /// deliverable and rejected every planted fake, and only if there were at least `MIN_FAKES`.
    #[allow(clippy::too_many_arguments)]
    pub fn record_challenge(
        &mut self,
        job_id: JobId,
        spec_hash: String,
        fakes_hash: String,
        reference_passed: bool,
        fakes_total: u32,
        fakes_caught: u32,
        report_hash: String,
        attestation_hash: String,
    ) {
        self.require_relay();
        require_hash(&report_hash, "report_hash");
        require_hash(&attestation_hash, "attestation_hash");
        require!(fakes_caught <= fakes_total, "fakes_caught cannot exceed fakes_total");
        let job = self.job_mut(job_id);
        require!(job.state == JobState::Draft, "the check has already been challenged");
        require!(job.spec_hash == spec_hash, "spec_hash does not match the job");
        require!(job.fakes_hash == fakes_hash, "fakes_hash does not match the job");
        job.fakes_total = fakes_total;
        job.fakes_caught = fakes_caught;
        job.challenge_report_hash = Some(report_hash);
        job.challenge_attestation_hash = Some(attestation_hash);
        let accepted = reference_passed && fakes_total >= MIN_FAKES && fakes_caught == fakes_total;
        job.state = if accepted { JobState::Challenged } else { JobState::CheckRejected };
        emit(if accepted { "check_accepted" } else { "check_rejected" }, job_id);
    }

    /// Records the verifier's verdict. Only the relay, once, within the verdict window, and only
    /// for the job's spec hash and the delivered hash.
    pub fn record_verdict(
        &mut self,
        job_id: JobId,
        pass: bool,
        spec_hash: String,
        deliverable_hash: String,
        report_hash: String,
        attestation_hash: String,
    ) {
        self.require_relay();
        require_hash(&report_hash, "report_hash");
        require_hash(&attestation_hash, "attestation_hash");
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        require!(job.state == JobState::Delivered, "job is not awaiting a verdict");
        require!(now <= job.verdict_deadline(), "the verdict window has closed");
        require!(job.spec_hash == spec_hash, "spec_hash does not match the job");
        require!(
            job.deliverable_hash.as_deref() == Some(deliverable_hash.as_str()),
            "deliverable_hash does not match the delivery"
        );
        job.report_hash = Some(report_hash);
        job.attestation_hash = Some(attestation_hash);
        job.state = if pass { JobState::Passed } else { JobState::Failed };
        emit(if pass { "verdict_passed" } else { "verdict_failed" }, job_id);
    }

    // ---- Anyone ----

    /// Pays the worker after a passing verdict.
    pub fn release(&mut self, job_id: JobId) -> Promise {
        self.start_payout(job_id, JobState::Passed, JobState::Releasing, JobState::Released, true)
    }

    /// Refunds the buyer after a failing verdict.
    pub fn refund(&mut self, job_id: JobId) -> Promise {
        self.start_payout(job_id, JobState::Failed, JobState::Refunding, JobState::Refunded, false)
    }

    /// Refunds the buyer when the worker missed the deadline or the relay missed the verdict window.
    pub fn expire(&mut self, job_id: JobId) -> Promise {
        let now = env::block_timestamp();
        let job = self.job(job_id);
        let from = job.state;
        let expired = match from {
            JobState::Funded => now > job.deadline.0,
            JobState::Delivered => now > job.verdict_deadline(),
            _ => false,
        };
        require!(expired, "job has not expired");
        self.start_payout(job_id, from, JobState::Expiring, JobState::Expired, false)
    }

    /// Settles a payout once its transfer has finished. On failure the job goes back to the
    /// state it came from, so the payout can be retried.
    #[private]
    pub fn on_payout(&mut self, job_id: JobId, done: JobState, revert_to: JobState) -> bool {
        // Only the outcome matters, so no result bytes are read. A result longer than that limit
        // still means the transfer succeeded, and must never be retried as if it had failed.
        let paid = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        self.job_mut(job_id).state = if paid { done } else { revert_to };
        emit(if paid { "payout_done" } else { "payout_failed" }, job_id);
        paid
    }

    // ---- Views ----

    pub fn get_job(&self, job_id: JobId) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    /// Jobs with ids from `from_id`, at most `limit` (capped at 50). Cancelled jobs are skipped.
    pub fn get_jobs(&self, from_id: JobId, limit: u64) -> Vec<(JobId, Job)> {
        let end = from_id.saturating_add(limit.min(50)).min(self.next_id);
        (from_id..end).filter_map(|id| self.jobs.get(&id).map(|job| (id, job.clone()))).collect()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            relay: self.relay.clone(),
            tokens: self.tokens.clone(),
            next_job_id: self.next_id,
        }
    }
}

impl Escrow {
    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    fn require_relay(&self) {
        require!(env::predecessor_account_id() == self.relay, "only the verifier relay can record this");
    }

    fn job(&self, job_id: JobId) -> &Job {
        self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("job not found"))
    }

    fn job_mut(&mut self, job_id: JobId) -> &mut Job {
        self.jobs.get_mut(&job_id).unwrap_or_else(|| env::panic_str("job not found"))
    }

    fn lock_payment(&mut self, job_id: JobId, payer: &AccountId, token: Option<&AccountId>, amount: u128) {
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        require!(*payer == job.buyer, "only the buyer can fund");
        require!(job.token.as_ref() == token, "pay in the job's token");
        require!(job.state == JobState::Challenged, "job is not ready to fund: the check must pass its challenge first");
        require!(amount == job.amount.0, "pay exactly the job amount");
        require!(now < job.deadline.0, "the delivery deadline has passed");
        job.state = JobState::Funded;
        emit("job_funded", job_id);
    }

    fn start_payout(
        &mut self,
        job_id: JobId,
        from: JobState,
        pending: JobState,
        done: JobState,
        to_worker: bool,
    ) -> Promise {
        let job = self.job_mut(job_id);
        require!(
            job.state == from,
            match from {
                JobState::Passed => "job has not passed",
                JobState::Failed => "job has not failed",
                _ => "job cannot be paid out now",
            }
        );
        job.state = pending;
        let receiver = if to_worker { job.worker.clone() } else { job.buyer.clone() };
        let transfer = match job.token.clone() {
            None => Promise::new(receiver).transfer(NearToken::from_yoctonear(job.amount.0)),
            Some(token) => ext_ft::ext(token)
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FOR_FT_TRANSFER)
                .ft_transfer(receiver, job.amount, Some(format!("Proven job {job_id}"))),
        };
        emit("payout_started", job_id);
        transfer.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                .on_payout(job_id, done, from),
        )
    }
}

#[cfg(test)]
mod tests;
