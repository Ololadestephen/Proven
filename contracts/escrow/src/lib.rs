//! Proven escrow.
//!
//! A buyer creates a job for a named worker, fixed by the hash of its acceptance check and the
//! hash of its reference. The escrow itself asks OutLayer to run the verifier build pinned to the
//! job, and records the result only in the private callback of that request. No account can set a
//! result: not the owner, not a relay, not the worker. Anyone may trigger a run and pays OutLayer's
//! deposit for it; OutLayer returns what it does not use directly to that caller.
//!
//! Lifecycle:
//! - `Draft` -> `request_challenge` -> `Challenging` -> `Challenged`, or `CheckRejected` if any fake
//!   got through or the check failed the reference
//! - `Challenged` -> `fund` / `ft_transfer_call` -> `Funded` -> `deliver` -> `Delivered`
//! - `Delivered` -> `request_verification` -> `Verifying` -> `Passed` or `Failed`
//! - `Passed` -> `release` -> `Released`; `Failed` -> `refund` -> `Refunded`
//! - `Funded` after the deadline, or `Delivered` after the verdict window -> `expire` -> `Expired`
//! - `Draft`, `CheckRejected` or `Challenged` -> `cancel`: the job is removed and its storage
//!   deposit returned
//!
//! Any OutLayer failure means "no verdict", never a pass or a fail: a failed promise, a timed-out
//! run, malformed output, output too large, or output naming another job, check or deliverable. The
//! job goes back to `Draft` or `Delivered`, so a run can be tried again. If a callback never arrives
//! (for example it ran out of gas), a run counts as stale after `RUN_TIMEOUT_NANOS`: it can be
//! triggered again, and a `Verifying` job can expire once its window has also closed. Each run has
//! an attempt number, so a late callback from an earlier run is ignored and a result is recorded
//! exactly once.
//!
//! What this contract cannot check: it asks for the WASM by URL and hash, and OutLayer's worker is
//! what refuses other bytes. The callback sees only the output, so the contract trusts the OutLayer
//! contract, its registered worker keys and their approved measurements for what actually ran; the
//! TDX quote of each run is not verified on chain. The stored request id lets anyone check it off
//! chain.
//!
//! Payouts pass through `Releasing`, `Refunding` or `Expiring` until the transfer's callback
//! confirms it. A failed transfer returns the job to the state it came from, so the payout can be
//! retried; nothing is marked paid until the money has moved.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

pub type JobId = u64;

const NANOS_PER_SEC: u64 = 1_000_000_000;
const MAX_DEADLINE_NANOS: u64 = 30 * 24 * 60 * 60 * NANOS_PER_SEC;
/// Long enough for a stale run and one retry: see `RUN_TIMEOUT_NANOS`.
const MIN_VERDICT_WINDOW_SECS: u32 = 30 * 60;
const MAX_VERDICT_WINDOW_SECS: u32 = 7 * 24 * 60 * 60;
/// After this long with no callback, a run is stale. Longer than OutLayer's own stale-request
/// timeout (10 minutes), so a run that can still resolve normally is not raced.
const RUN_TIMEOUT_NANOS: u64 = 15 * 60 * NANOS_PER_SEC;
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(10);
/// Gas reserved for OutLayer's `request_execution`, which itself reserves 50 Tgas for settlement.
/// It also receives whatever the caller's prepaid gas leaves unused.
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(100);
const GAS_FOR_RUN_CALLBACK: Gas = Gas::from_tgas(30);
const MIN_PREPAID_GAS_FOR_RUN: Gas = Gas::from_tgas(150);
/// OutLayer's deposit for one run, paid by whoever triggers it. Unused NEAR comes back to them
/// from OutLayer. The cap bounds what can be stranded if OutLayer refuses the call outright.
const MIN_RUN_DEPOSIT: NearToken = NearToken::from_millinear(100);
const MAX_RUN_DEPOSIT: NearToken = NearToken::from_near(1);
const RUN_MAX_INSTRUCTIONS: u64 = 50_000_000_000;
const RUN_MAX_MEMORY_MB: u32 = 128;
const RUN_MAX_SECONDS: u32 = 60;
const BUILD_TARGET: &str = "wasm32-wasip1";
/// The verifier's output never exceeds 900 bytes; anything longer is not its output.
const MAX_RESULT_BYTES: usize = 1024;
const MAX_URL_LEN: usize = 256;
const MAX_FAILED_RULE_LEN: usize = 32;
const VERIFIER_OUTPUT_VERSION: u32 = 1;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Fewest confirmed fakes a check must face before it can be accepted (the verifier uses the same).
pub const MIN_FAKES: u32 = 5;
/// A 64-character placeholder used to size a job's storage at its largest.
const FULL_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
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

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunKind {
    Challenge,
    Verify,
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
    /// SHA-256 of the reference the verifier generates its planted fakes from.
    pub fakes_hash: String,
    /// The verifier build every run of this job uses, fixed when the job is created.
    pub verifier_url: String,
    pub verifier_hash: String,
    /// The account whose OutLayer secret holds this job's private texts, fixed when the job is
    /// created. It can withhold them, which leaves no verdict; it cannot change them unnoticed,
    /// because the verifier refuses texts that do not match the job's hashes.
    pub secrets_owner: AccountId,
    /// Delivery deadline, in nanoseconds since the Unix epoch.
    pub deadline: U64,
    /// How long verification can be triggered after delivery.
    pub verdict_window_secs: u32,
    pub state: JobState,
    /// NEAR the buyer paid for this job's storage, returned if the job is cancelled.
    pub storage_deposit: NearToken,
    /// Number of the latest OutLayer run; only that run's callback can record a result.
    pub attempt: u32,
    pub run_started_at: Option<U64>,
    pub fakes_total: u32,
    pub fakes_caught: u32,
    /// SHA-256 of the challenge output; it equals the attestation's `output_hash`.
    pub challenge_report_hash: Option<String>,
    /// OutLayer request id of the recorded challenge: it finds the attestation.
    pub challenge_request_id: Option<U64>,
    pub delivered_at: Option<U64>,
    pub deliverable_hash: Option<String>,
    /// SHA-256 of the verify output; it equals the attestation's `output_hash`.
    pub report_hash: Option<String>,
    /// OutLayer request id of the recorded verdict: it finds the attestation.
    pub verdict_request_id: Option<U64>,
    pub failed_rule: Option<String>,
}

impl Job {
    /// The same job with every optional field filled, used to charge storage at its largest.
    fn at_full_size(&self) -> Self {
        let full = Some(FULL_HASH.to_string());
        Self {
            run_started_at: Some(U64(u64::MAX)),
            challenge_report_hash: full.clone(),
            challenge_request_id: Some(U64(u64::MAX)),
            delivered_at: Some(U64(u64::MAX)),
            deliverable_hash: full.clone(),
            report_hash: full,
            verdict_request_id: Some(U64(u64::MAX)),
            failed_rule: Some("x".repeat(MAX_FAILED_RULE_LEN)),
            ..self.clone()
        }
    }

    fn verdict_deadline(&self) -> u64 {
        let delivered_at = self.delivered_at.map_or(0, |t| t.0);
        delivered_at.saturating_add(u64::from(self.verdict_window_secs) * NANOS_PER_SEC)
    }

    /// True if a run was started and its callback is overdue.
    fn run_is_stale(&self, now: u64) -> bool {
        self.run_started_at.is_some_and(|t| now > t.0.saturating_add(RUN_TIMEOUT_NANOS))
    }

    /// The OutLayer secret profile holding the private texts of one run.
    fn secrets_profile(&self, job_id: JobId, kind: RunKind) -> String {
        match kind {
            RunKind::Challenge => format!("c{job_id}-{}", &self.fakes_hash[..12]),
            RunKind::Verify => format!("v{job_id}-{}", &self.deliverable_hash.as_deref().unwrap_or(FULL_HASH)[..12]),
        }
    }

    /// The exact public input of one run: only hashes and the job binding.
    fn run_input(&self, job_id: JobId, kind: RunKind, escrow: &AccountId) -> String {
        match kind {
            RunKind::Challenge => json!({
                "mode": "challenge", "escrow": escrow, "job": job_id,
                "check_hash": self.spec_hash, "reference_hash": self.fakes_hash,
            }),
            RunKind::Verify => json!({
                "mode": "verify", "escrow": escrow, "job": job_id,
                "check_hash": self.spec_hash, "deliverable_hash": self.deliverable_hash,
            }),
        }
        .to_string()
    }

    /// Records a challenge output if it is exactly for this job. False means no result.
    fn apply_challenge(&mut self, bytes: &[u8], job_id: JobId, escrow: &AccountId) -> bool {
        let Ok(output) = serde_json::from_slice::<ChallengeOutput>(bytes) else { return false };
        let valid = output.v == VERIFIER_OUTPUT_VERSION
            && output.mode == "challenge"
            && output.error.is_none()
            && output.escrow == *escrow
            && output.job == job_id
            && output.spec_hash == self.spec_hash
            && output.fakes_hash == self.fakes_hash
            && output.fakes_caught <= output.fakes_total;
        if !valid {
            return false;
        }
        self.fakes_total = output.fakes_total;
        self.fakes_caught = output.fakes_caught;
        self.challenge_report_hash = Some(sha256_hex(bytes));
        self.challenge_request_id = Some(U64(output.request_id));
        let accepted = output.reference_passed && output.fakes_total >= MIN_FAKES && output.fakes_caught == output.fakes_total;
        self.state = if accepted { JobState::Challenged } else { JobState::CheckRejected };
        true
    }

    /// Records a verify output if it is exactly for this job and delivery. False means no result.
    fn apply_verdict(&mut self, bytes: &[u8], job_id: JobId, escrow: &AccountId) -> bool {
        let Ok(output) = serde_json::from_slice::<VerifyOutput>(bytes) else { return false };
        let failed_rule_fits = output.failed_rule.as_ref().is_none_or(|r| r.len() <= MAX_FAILED_RULE_LEN);
        let valid = output.v == VERIFIER_OUTPUT_VERSION
            && output.mode == "verify"
            && output.error.is_none()
            && output.escrow == *escrow
            && output.job == job_id
            && output.spec_hash == self.spec_hash
            && self.deliverable_hash.as_deref() == Some(output.deliverable_hash.as_str())
            && failed_rule_fits;
        if !valid {
            return false;
        }
        self.report_hash = Some(sha256_hex(bytes));
        self.verdict_request_id = Some(U64(output.request_id));
        self.state = if output.pass { JobState::Passed } else { JobState::Failed };
        self.failed_rule = if output.pass { None } else { output.failed_rule };
        true
    }
}

/// The parts of the verifier's challenge output the contract relies on.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChallengeOutput {
    v: u32,
    mode: String,
    error: Option<String>,
    escrow: AccountId,
    job: JobId,
    request_id: u64,
    spec_hash: String,
    fakes_hash: String,
    reference_passed: bool,
    fakes_total: u32,
    fakes_caught: u32,
}

/// The parts of the verifier's verify output the contract relies on.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VerifyOutput {
    v: u32,
    mode: String,
    error: Option<String>,
    escrow: AccountId,
    job: JobId,
    request_id: u64,
    spec_hash: String,
    deliverable_hash: String,
    pass: bool,
    failed_rule: Option<String>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub secrets_owner: AccountId,
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
    /// The OutLayer contract, fixed at initialisation: no method can point results elsewhere.
    outlayer: AccountId,
    verifier_url: String,
    verifier_hash: String,
    secrets_owner: AccountId,
    tokens: Vec<AccountId>,
    jobs: LookupMap<JobId, Job>,
    next_id: JobId,
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn require_hash(value: &str, name: &str) {
    require!(is_hash(value), format!("{name} must be 64 lowercase hex characters"));
}

fn require_verifier(url: &str, hash: &str) {
    require_hash(hash, "verifier_hash");
    require!(url.starts_with("https://") && url.len() <= MAX_URL_LEN, "verifier_url must be https and at most 256 characters");
}

fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn emit(event: &str, job_id: JobId) {
    let log = json!({
        "standard": "proven",
        "version": "2.0.0",
        "event": event,
        "data": [{ "job_id": job_id }],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

#[near]
impl Escrow {
    #[init]
    pub fn new(owner: AccountId, outlayer: AccountId, verifier_url: String, verifier_hash: String, secrets_owner: AccountId) -> Self {
        require_verifier(&verifier_url, &verifier_hash);
        Self {
            owner,
            outlayer,
            verifier_url,
            verifier_hash,
            secrets_owner,
            tokens: Vec::new(),
            jobs: LookupMap::new(StorageKey::Jobs),
            next_id: 0,
        }
    }

    // ---- Owner: settings for future jobs. Existing jobs keep what they were created with. ----

    pub fn set_verifier(&mut self, verifier_url: String, verifier_hash: String) {
        self.require_owner();
        require_verifier(&verifier_url, &verifier_hash);
        self.verifier_url = verifier_url;
        self.verifier_hash = verifier_hash;
    }

    pub fn set_secrets_owner(&mut self, secrets_owner: AccountId) {
        self.require_owner();
        self.secrets_owner = secrets_owner;
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
            "verdict_window_secs must be between 1800 and 604800"
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
            verifier_url: self.verifier_url.clone(),
            verifier_hash: self.verifier_hash.clone(),
            secrets_owner: self.secrets_owner.clone(),
            deadline,
            verdict_window_secs,
            state: JobState::Draft,
            storage_deposit: NearToken::from_yoctonear(0),
            attempt: 0,
            run_started_at: None,
            fakes_total: 0,
            fakes_caught: 0,
            challenge_report_hash: None,
            challenge_request_id: None,
            delivered_at: None,
            deliverable_hash: None,
            report_hash: None,
            verdict_request_id: None,
            failed_rule: None,
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

    /// Removes a job that was never funded and returns its storage deposit to the buyer. A
    /// challenge in flight must finish or go stale first.
    pub fn cancel(&mut self, job_id: JobId) -> Promise {
        let job = self.job(job_id).clone();
        let now = env::block_timestamp();
        require!(env::predecessor_account_id() == job.buyer, "only the buyer can cancel");
        let cancellable = match job.state {
            JobState::Draft | JobState::CheckRejected | JobState::Challenged => true,
            JobState::Challenging => job.run_is_stale(now),
            _ => false,
        };
        require!(cancellable, "only an unfunded job can be cancelled");
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

    // ---- Anyone: run the verifier ----

    /// Asks OutLayer to run the check challenge. The caller attaches OutLayer's deposit and gets
    /// the unused part back from OutLayer.
    #[payable]
    pub fn request_challenge(&mut self, job_id: JobId) -> Promise {
        let now = env::block_timestamp();
        let job = self.job(job_id);
        let ready = match job.state {
            JobState::Draft => true,
            JobState::Challenging => job.run_is_stale(now),
            _ => false,
        };
        require!(ready, "job is not awaiting a challenge");
        require!(now < job.deadline.0, "the delivery deadline has passed");
        self.start_run(job_id, RunKind::Challenge, JobState::Challenging)
    }

    /// Asks OutLayer to run the check on the delivery. The caller attaches OutLayer's deposit and
    /// gets the unused part back from OutLayer. Refused once the verdict window has closed.
    #[payable]
    pub fn request_verification(&mut self, job_id: JobId) -> Promise {
        let now = env::block_timestamp();
        let job = self.job(job_id);
        let ready = match job.state {
            JobState::Delivered => true,
            JobState::Verifying => job.run_is_stale(now),
            _ => false,
        };
        require!(ready, "job is not awaiting verification");
        require!(now <= job.verdict_deadline(), "the verdict window has closed");
        self.start_run(job_id, RunKind::Verify, JobState::Verifying)
    }

    /// Records a run's result, if it is still the latest run of a job waiting for it. Anything
    /// else leaves no result: the job is ready for another run, and this method never panics on
    /// what OutLayer returned, so no failure can look like a verdict or leave the job stuck.
    #[private]
    pub fn on_run_result(&mut self, job_id: JobId, attempt: u32, kind: RunKind) -> bool {
        let escrow = env::current_account_id();
        let result = env::promise_result_checked(0, MAX_RESULT_BYTES);
        let Some(job) = self.jobs.get_mut(&job_id) else {
            emit("run_ignored", job_id);
            return false;
        };
        let (running, ready_again) = match kind {
            RunKind::Challenge => (JobState::Challenging, JobState::Draft),
            RunKind::Verify => (JobState::Verifying, JobState::Delivered),
        };
        if job.state != running || job.attempt != attempt {
            emit("run_ignored", job_id);
            return false;
        }
        job.run_started_at = None;
        let recorded = match (&result, kind) {
            (Ok(bytes), RunKind::Challenge) => job.apply_challenge(bytes, job_id, &escrow),
            (Ok(bytes), RunKind::Verify) => job.apply_verdict(bytes, job_id, &escrow),
            // A failed promise, or a result too long to be the verifier's.
            (Err(_), _) => false,
        };
        if !recorded {
            job.state = ready_again;
        }
        let event = match (recorded, job.state) {
            (false, _) => "run_no_result",
            (true, JobState::Challenged) => "check_accepted",
            (true, JobState::CheckRejected) => "check_rejected",
            (true, JobState::Passed) => "verdict_passed",
            (true, _) => "verdict_failed",
        };
        emit(event, job_id);
        recorded
    }

    // ---- Anyone: move the money ----

    /// Pays the worker after a passing verdict.
    pub fn release(&mut self, job_id: JobId) -> Promise {
        self.start_payout(job_id, JobState::Passed, JobState::Releasing, JobState::Released, true)
    }

    /// Refunds the buyer after a failing verdict.
    pub fn refund(&mut self, job_id: JobId) -> Promise {
        self.start_payout(job_id, JobState::Failed, JobState::Refunding, JobState::Refunded, false)
    }

    /// Refunds the buyer when the worker missed the deadline, or no verdict was recorded in the
    /// verdict window. A run in flight gets `RUN_TIMEOUT_NANOS` to finish first; its late callback
    /// is ignored once the job has expired.
    pub fn expire(&mut self, job_id: JobId) -> Promise {
        let now = env::block_timestamp();
        let job = self.job(job_id);
        let from = job.state;
        let expired = match from {
            JobState::Funded => now > job.deadline.0,
            JobState::Delivered => now > job.verdict_deadline(),
            JobState::Verifying => now > job.verdict_deadline() && job.run_is_stale(now),
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

    /// The secret profile a run of this job will read, so whoever holds the texts can pin them.
    pub fn get_secrets_profile(&self, job_id: JobId, kind: RunKind) -> String {
        self.job(job_id).secrets_profile(job_id, kind)
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            outlayer: self.outlayer.clone(),
            verifier_url: self.verifier_url.clone(),
            verifier_hash: self.verifier_hash.clone(),
            secrets_owner: self.secrets_owner.clone(),
            tokens: self.tokens.clone(),
            next_job_id: self.next_id,
        }
    }
}

impl Escrow {
    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
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

    /// Starts one OutLayer run of the job's pinned verifier on the job's own hashes, and chains
    /// the private callback that is the only way a result can be recorded.
    fn start_run(&mut self, job_id: JobId, kind: RunKind, running: JobState) -> Promise {
        let deposit = env::attached_deposit();
        require!(
            deposit >= MIN_RUN_DEPOSIT && deposit <= MAX_RUN_DEPOSIT,
            "attach between 0.1 and 1 NEAR for OutLayer; the unused part comes back"
        );
        require!(env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_RUN, "attach at least 150 Tgas");
        let now = env::block_timestamp();
        let escrow = env::current_account_id();
        let payer = env::predecessor_account_id();
        let outlayer = self.outlayer.clone();
        let job = self.job_mut(job_id);
        job.state = running;
        job.attempt = job.attempt.saturating_add(1);
        job.run_started_at = Some(U64(now));
        let attempt = job.attempt;
        let args = json!({
            "source": { "WasmUrl": { "url": job.verifier_url, "hash": job.verifier_hash, "build_target": BUILD_TARGET } },
            "input_data": job.run_input(job_id, kind, &escrow),
            "resource_limits": {
                "max_instructions": RUN_MAX_INSTRUCTIONS,
                "max_memory_mb": RUN_MAX_MEMORY_MB,
                "max_execution_seconds": RUN_MAX_SECONDS,
            },
            "secrets_ref": { "profile": job.secrets_profile(job_id, kind), "account_id": job.secrets_owner },
            "response_format": "Json",
            // OutLayer returns unused NEAR straight to whoever triggered this run.
            "payer_account_id": payer,
        });
        emit("run_started", job_id);
        Promise::new(outlayer)
            .function_call_weight("request_execution", args.to_string().into_bytes(), deposit, GAS_FOR_OUTLAYER, GasWeight(1))
            .then(
                Self::ext(escrow)
                    .with_static_gas(GAS_FOR_RUN_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_run_result(job_id, attempt, kind),
            )
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
