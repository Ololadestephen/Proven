//! Proven escrow.
//!
//! A buyer pays once, through the board, for a job fixed by the hash of its acceptance check, its
//! reference and its public format. The payment and a compute budget are held here from then on.
//! The escrow itself asks OutLayer to run the verifier build pinned to the job, pays each run from
//! the job's compute budget, and records the result only in the private callback of that request.
//! No account can set a result: not the owner, not the board, not a relay, not the worker.
//!
//! Lifecycle of a job:
//! - `Draft` -> `request_challenge` -> `Challenging` -> `Open`, or `CheckRejected` if any fake got
//!   through or the check failed the reference
//! - `Open` -> `assign` (only from the board, for the worker it chose) -> `Funded`
//! - `Funded` -> `deliver` -> `Delivered` -> `request_verification` -> `Verifying` -> `Passed` or
//!   `Failed`
//! - `Passed` -> `release` -> `Released`, final
//! - `Failed` -> `refund`, `Funded` after its deadline or `Delivered` after its verdict window ->
//!   `expire`: the attempt is recorded. If attempts are left and the job has not ended, it goes
//!   back to `Open` for the next worker; otherwise the buyer is refunded: `Refunding` -> `Refunded`
//! - `Draft`, `Open` or `CheckRejected` -> `close`, by the buyer or the board at any time, or by
//!   anyone after the job's end -> refunded
//!
//! Any OutLayer failure means "no verdict", never a pass or a fail: a failed promise, a timed-out
//! run, malformed output, output too large, or output naming another job, check or deliverable. The
//! job goes back to `Draft` or `Delivered`, so a run can be tried again while budget lasts. If a
//! callback never arrives, a run counts as stale after `RUN_TIMEOUT_NANOS`. Each run has a number,
//! so a late callback from an earlier run is ignored and a result is recorded exactly once.
//!
//! Each run's deposit comes from the job's compute budget, and OutLayer returns its unused part
//! straight to the buyer. A run in flight blocks the next one until it finishes or goes stale, so
//! nobody can drain the budget by triggering runs.
//!
//! What this contract cannot check: it asks for the WASM by URL and hash, and OutLayer's worker is
//! what refuses other bytes. The callback sees only the output, so the contract trusts the OutLayer
//! contract, its registered worker keys and their approved measurements for what actually ran; the
//! TDX quote of each run is not verified on chain. The stored request id lets anyone check it off
//! chain.
//!
//! Payouts pass through `Releasing` or `Refunding` until the transfer's callback confirms it. A
//! failed transfer returns the job to the state it came from, so the payout can be retried; nothing
//! is marked paid until the money has moved.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

pub type JobId = u64;

const NANOS_PER_SEC: u64 = 1_000_000_000;
/// The longest a job can wait for workers.
const MAX_OPEN_NANOS: u64 = 7 * 24 * 60 * 60 * NANOS_PER_SEC;
/// Long enough for a stale run and one retry: see `RUN_TIMEOUT_NANOS`.
const MIN_WINDOW_SECS: u32 = 30 * 60;
const MAX_WINDOW_SECS: u32 = 24 * 60 * 60;
pub const MAX_ATTEMPTS: u32 = 3;
/// A challenge may need one retry, and so may each attempt's verification.
pub const RUNS_PER_JOB_BASE: u32 = 2;
pub const RUNS_PER_ATTEMPT: u32 = 2;
/// Charged with a job, for the per-buyer record it may create.
const BUYER_RECORD_BYTES: u128 = 200;
/// After this long with no callback, a run is stale. A real run resolves within NEAR's yield timeout
/// (200 blocks), which delivers `null`; this is reached only if the callback itself is lost.
const RUN_TIMEOUT_NANOS: u64 = 15 * 60 * NANOS_PER_SEC;
const GAS_FOR_PAYOUT_CALLBACK: Gas = Gas::from_tgas(20);
/// A payout's callback must always run: a lost one would leave the job in a pending state.
const MIN_PREPAID_GAS_FOR_PAYOUT: Gas = Gas::from_tgas(50);
/// Gas reserved for OutLayer's `request_execution`, which itself reserves 50 Tgas for settlement.
/// It also receives whatever the caller's prepaid gas leaves unused.
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(100);
const GAS_FOR_RUN_CALLBACK: Gas = Gas::from_tgas(30);
const MIN_PREPAID_GAS_FOR_RUN: Gas = Gas::from_tgas(150);
/// Bounds on the owner's setting for one run's deposit.
const MIN_RUN_DEPOSIT: NearToken = NearToken::from_millinear(1);
const MAX_RUN_DEPOSIT: NearToken = NearToken::from_near(1);
const RUN_MAX_INSTRUCTIONS: u64 = 50_000_000_000;
const RUN_MAX_MEMORY_MB: u32 = 128;
const RUN_MAX_SECONDS: u32 = 60;
const BUILD_TARGET: &str = "wasm32-wasip1";
/// The verifier's output never exceeds 900 bytes; anything longer is not its output.
const MAX_RESULT_BYTES: usize = 900;
const MAX_URL_LEN: usize = 256;
const MAX_FAILED_RULE_LEN: usize = 32;
const VERIFIER_OUTPUT_VERSION: u32 = 2;
/// Fewest confirmed fakes a check must face before it can be accepted (the verifier uses the same).
pub const MIN_FAKES: u32 = 5;
/// A 64-character placeholder used to size a job's storage at its largest.
const FULL_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// The longest valid account id, used to size records at their largest.
const LONGEST_ACCOUNT: &str = "0000000000000000000000000000000000000000000000000000000000000000";

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    Draft,
    Challenging,
    CheckRejected,
    /// The check passed its challenge and the job waits for a worker.
    Open,
    Funded,
    Delivered,
    Verifying,
    Passed,
    Failed,
    Releasing,
    Refunding,
    Released,
    Refunded,
    /// A refund decided but not yet paid, because its transfer failed. `refund` retries it.
    RefundDue,
    /// Kept only for jobs made before this version. A new job never enters these.
    Challenged,
    Expiring,
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunKind {
    Challenge,
    Verify,
}

/// What releases the payment. Only a recorded verdict does today; another kind would need its own
/// decision and review.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Release {
    Verdict,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Paid,
    /// A recorded failing verdict.
    Failed,
    /// No delivery before the deadline.
    NoDelivery,
    /// Delivered, but no verdict was recorded in the verdict window.
    NoVerdict,
}

/// One worker's turn at a job. Kept so the board can settle that attempt's fee, and so anyone can
/// find its evidence after the job reopens.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptRecord {
    pub worker: AccountId,
    pub outcome: Outcome,
    pub failed_rule: Option<String>,
    pub deliverable_hash: Option<String>,
    pub report_hash: Option<String>,
    pub verdict_request_id: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub buyer: AccountId,
    /// The current worker. `None` while the job waits for one.
    pub worker: Option<AccountId>,
    /// Always `None` for jobs made by this version: they are paid in NEAR.
    pub token: Option<AccountId>,
    pub amount: U128,
    /// SHA-256 of the acceptance check, 64 lowercase hex characters.
    pub spec_hash: String,
    /// SHA-256 of the reference the verifier generates its planted fakes from.
    pub fakes_hash: String,
    /// SHA-256 of the public format the verifier must judge by, the one the job's bid published.
    pub format_hash: String,
    /// The verifier build every run of this job uses, fixed when the job is created.
    pub verifier_url: String,
    pub verifier_hash: String,
    /// The account whose OutLayer secret holds this job's private texts, fixed when the job is
    /// created. It can withhold them, which leaves no verdict; it cannot change them unnoticed,
    /// because the verifier refuses texts that do not match the job's hashes.
    pub secrets_owner: AccountId,
    pub release: Release,
    /// NEAR held to pay for runs. OutLayer returns each run's unused part to the buyer.
    pub compute_budget: U128,
    /// After this, no new worker can be assigned, and anyone can close the job if no one is on it.
    pub expires_at: U64,
    /// How long each worker has to deliver after being assigned.
    pub deliver_secs: u32,
    /// The current worker's delivery deadline, in nanoseconds since the Unix epoch.
    pub deadline: U64,
    /// How long verification can be triggered after delivery.
    pub verdict_window_secs: u32,
    pub max_attempts: u32,
    pub history: Vec<AttemptRecord>,
    pub state: JobState,
    /// NEAR the board paid for this job's storage.
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
    /// True once nothing more can happen to the job's money: paid with its budget returned, or
    /// refunded.
    pub fn is_finished(&self) -> bool {
        match self.state {
            JobState::Released => self.compute_budget.0 == 0,
            JobState::Refunded | JobState::Expired => true,
            _ => false,
        }
    }

    /// The same job with every optional field filled, used to charge storage at its largest.
    fn at_full_size(&self) -> Self {
        let full = Some(FULL_HASH.to_string());
        let longest: AccountId = LONGEST_ACCOUNT.parse().unwrap_or_else(|_| env::abort());
        let record = AttemptRecord {
            worker: longest.clone(),
            outcome: Outcome::Failed,
            failed_rule: Some("x".repeat(MAX_FAILED_RULE_LEN)),
            deliverable_hash: full.clone(),
            report_hash: full.clone(),
            verdict_request_id: Some(U64(u64::MAX)),
        };
        Self {
            worker: Some(longest),
            history: vec![record; self.max_attempts as usize],
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
        self.run_started_at
            .is_some_and(|t| now > t.0.saturating_add(RUN_TIMEOUT_NANOS))
    }

    /// The OutLayer secret profile holding the private texts of one run.
    fn secrets_profile(&self, job_id: JobId, kind: RunKind) -> String {
        match kind {
            RunKind::Challenge => format!("c{job_id}-{}", &self.fakes_hash[..12]),
            RunKind::Verify => format!(
                "v{job_id}-{}",
                &self.deliverable_hash.as_deref().unwrap_or(FULL_HASH)[..12]
            ),
        }
    }

    /// The exact public input of one run: only hashes and the job binding.
    fn run_input(&self, job_id: JobId, kind: RunKind, escrow: &AccountId) -> String {
        match kind {
            RunKind::Challenge => json!({
                "mode": "challenge", "escrow": escrow, "job": job_id,
                "check_hash": self.spec_hash, "reference_hash": self.fakes_hash,
                "format_hash": self.format_hash,
            }),
            RunKind::Verify => json!({
                "mode": "verify", "escrow": escrow, "job": job_id, "format_hash": self.format_hash,
                "check_hash": self.spec_hash, "deliverable_hash": self.deliverable_hash,
            }),
        }
        .to_string()
    }

    /// Records a challenge output if it is exactly for this job. False means no result.
    fn apply_challenge(&mut self, bytes: &[u8], job_id: JobId, escrow: &AccountId) -> bool {
        let Ok(output) = serde_json::from_slice::<ChallengeOutput>(bytes) else {
            return false;
        };
        let valid = output.v == VERIFIER_OUTPUT_VERSION
            && output.mode == "challenge"
            && output.error.is_none()
            && output.escrow == *escrow
            && output.job == job_id
            && output.spec_hash == self.spec_hash
            && output.fakes_hash == self.fakes_hash
            && output.format_hash.as_ref() == Some(&self.format_hash)
            && output.fakes_caught <= output.fakes_total;
        if !valid {
            return false;
        }
        self.fakes_total = output.fakes_total;
        self.fakes_caught = output.fakes_caught;
        self.challenge_report_hash = Some(sha256_hex(bytes));
        self.challenge_request_id = Some(U64(output.request_id));
        let accepted = output.reference_passed
            && output.fakes_total >= MIN_FAKES
            && output.fakes_caught == output.fakes_total;
        self.state = if accepted {
            JobState::Open
        } else {
            JobState::CheckRejected
        };
        true
    }

    /// Records a verify output if it is exactly for this job and delivery. False means no result.
    fn apply_verdict(&mut self, bytes: &[u8], job_id: JobId, escrow: &AccountId) -> bool {
        let Ok(output) = serde_json::from_slice::<VerifyOutput>(bytes) else {
            return false;
        };
        let failed_rule_fits = output
            .failed_rule
            .as_ref()
            .is_none_or(|r| r.len() <= MAX_FAILED_RULE_LEN);
        let valid = output.v == VERIFIER_OUTPUT_VERSION
            && output.mode == "verify"
            && output.error.is_none()
            && output.escrow == *escrow
            && output.job == job_id
            && output.spec_hash == self.spec_hash
            && self.deliverable_hash.as_deref() == Some(output.deliverable_hash.as_str())
            && output.format_hash.as_ref() == Some(&self.format_hash)
            && failed_rule_fits;
        if !valid {
            return false;
        }
        self.report_hash = Some(sha256_hex(bytes));
        self.verdict_request_id = Some(U64(output.request_id));
        self.state = if output.pass {
            JobState::Passed
        } else {
            JobState::Failed
        };
        self.failed_rule = if output.pass {
            None
        } else {
            output.failed_rule
        };
        true
    }

    /// Ends the current worker's turn, keeping its evidence in the history.
    fn record_attempt(&mut self, outcome: Outcome) {
        let worker = self.worker.take().unwrap_or_else(|| env::abort());
        self.history.push(AttemptRecord {
            worker,
            outcome,
            failed_rule: self.failed_rule.take(),
            deliverable_hash: self.deliverable_hash.take(),
            report_hash: self.report_hash.take(),
            verdict_request_id: self.verdict_request_id.take(),
        });
        self.delivered_at = None;
        self.deadline = U64(0);
    }

    /// True if another worker can still take the job.
    fn can_reopen(&self, now: u64) -> bool {
        (self.history.len() as u32) < self.max_attempts && now < self.expires_at.0
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
    format_hash: Option<String>,
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
    format_hash: Option<String>,
    pass: bool,
    failed_rule: Option<String>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub pending_owner: Option<AccountId>,
    pub outlayer: AccountId,
    pub board: Option<AccountId>,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub secrets_owner: AccountId,
    pub next_job_id: JobId,
    pub paused: bool,
    pub run_deposit: U128,
    pub caps: Vec<AssetCap>,
}

/// Limits on NEAR, enforced here. `held` is what this contract is holding for jobs right now.
/// Caps only ever refuse money coming in: nothing here can stop a refund or payout, and lowering a
/// cap below `held` traps nothing.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AssetCap {
    pub token: Option<AccountId>,
    pub max_job: U128,
    pub max_held: U128,
    pub held: U128,
    /// The most one buyer can have held at once, so one account cannot fill `max_held`.
    pub max_held_per_buyer: U128,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Jobs,
    HeldByBuyer,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    owner: AccountId,
    /// The OutLayer contract, fixed at initialisation: no method can point results elsewhere.
    outlayer: AccountId,
    /// The only account that can create jobs and assign workers.
    board: Option<AccountId>,
    verifier_url: String,
    verifier_hash: String,
    secrets_owner: AccountId,
    jobs: LookupMap<JobId, Job>,
    next_id: JobId,
    /// Stops new jobs and new assignments only. Everything under way can still finish.
    paused: bool,
    /// What each run attaches for OutLayer, paid from the job's compute budget.
    run_deposit: NearToken,
    /// Only NEAR, the first entry.
    caps: Vec<AssetCap>,
    /// What each buyer has held now. An entry goes when it reaches zero, so this stays small.
    held_by_buyer: LookupMap<(AccountId, Option<AccountId>), u128>,
    /// The account the owner has offered the contract to, until it accepts.
    pending_owner: Option<AccountId>,
}

fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn require_hash(value: &str, name: &str) {
    require!(
        is_hash(value),
        format!("{name} must be 64 lowercase hex characters")
    );
}

fn require_verifier(url: &str, hash: &str) {
    require_hash(hash, "verifier_hash");
    require!(
        url.starts_with("https://") && url.len() <= MAX_URL_LEN,
        "verifier_url must be https and at most 256 characters"
    );
}

fn require_run_deposit(deposit: NearToken) {
    require!(
        deposit >= MIN_RUN_DEPOSIT && deposit <= MAX_RUN_DEPOSIT,
        "run_deposit must be between 0.001 and 1 NEAR"
    );
}

fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn emit(event: &str, job_id: JobId) {
    let log = json!({
        "standard": "proven",
        "version": "3.0.0",
        "event": event,
        "data": [{ "job_id": job_id }],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

/// The compute budget a job with this many attempts must bring.
pub fn budget_for(max_attempts: u32, run_deposit: NearToken) -> NearToken {
    run_deposit.saturating_mul(u128::from(
        RUNS_PER_JOB_BASE + RUNS_PER_ATTEMPT * max_attempts,
    ))
}

#[near]
impl Escrow {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        outlayer: AccountId,
        board: Option<AccountId>,
        verifier_url: String,
        verifier_hash: String,
        secrets_owner: AccountId,
        run_deposit: U128,
        max_job_amount: U128,
        max_held: U128,
        max_held_per_buyer: U128,
    ) -> Self {
        require_verifier(&verifier_url, &verifier_hash);
        let run_deposit = NearToken::from_yoctonear(run_deposit.0);
        require_run_deposit(run_deposit);
        Self {
            owner,
            outlayer,
            board,
            verifier_url,
            verifier_hash,
            secrets_owner,
            jobs: LookupMap::new(StorageKey::Jobs),
            next_id: 0,
            paused: false,
            run_deposit,
            caps: vec![AssetCap {
                token: None,
                max_job: max_job_amount,
                max_held,
                held: U128(0),
                max_held_per_buyer,
            }],
            held_by_buyer: LookupMap::new(StorageKey::HeldByBuyer),
            pending_owner: None,
        }
    }

    /// One-time upgrade from the version without storage return or owner handover. Only this
    /// contract's own account can call it, as part of deploying the new code. Jobs keep their
    /// layout, so none is rewritten and jobs under way carry on.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        let old: migration::OldEscrow =
            env::state_read().unwrap_or_else(|| env::panic_str("no earlier state"));
        Self {
            owner: old.owner,
            outlayer: old.outlayer,
            board: old.board,
            verifier_url: old.verifier_url,
            verifier_hash: old.verifier_hash,
            secrets_owner: old.secrets_owner,
            jobs: old.jobs,
            next_id: old.next_id,
            paused: old.paused,
            run_deposit: old.run_deposit,
            caps: old.caps,
            held_by_buyer: old.held_by_buyer,
            pending_owner: None,
        }
    }

    // ---- Owner: hand the contract to another account, in two steps ----

    /// Names the account that may take over as owner, or clears it with `null`. Nothing changes
    /// until that account accepts.
    pub fn propose_owner(&mut self, new_owner: Option<AccountId>) {
        self.require_owner();
        self.pending_owner = new_owner;
        env::log_str(&format!("owner proposed: {:?}", self.pending_owner));
    }

    /// Called by the proposed account to become the owner.
    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(
            self.pending_owner.as_ref() == Some(&caller),
            "only the proposed owner can accept"
        );
        self.owner = caller;
        self.pending_owner = None;
        env::log_str(&format!("owner is now {}", self.owner));
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

    /// The board is trusted to assign only the worker whose claim it accepted.
    pub fn set_board(&mut self, board: AccountId) {
        self.require_owner();
        self.board = Some(board);
    }

    /// Applies to jobs created after it; a job's budget was fixed when it was created.
    pub fn set_run_deposit(&mut self, run_deposit: U128) {
        self.require_owner();
        let deposit = NearToken::from_yoctonear(run_deposit.0);
        require_run_deposit(deposit);
        self.run_deposit = deposit;
    }

    /// Stops new jobs and new assignments, or lets them start again. It never blocks a delivery,
    /// a verification, a refund, a payout or a close.
    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        self.paused = paused;
        env::log_str(&format!("paused {paused}"));
    }

    /// Sets the limits on NEAR.
    pub fn set_caps(&mut self, max_job: U128, max_held: U128, max_held_per_buyer: U128) {
        self.require_owner();
        let cap = self.near_cap();
        cap.max_job = max_job;
        cap.max_held = max_held;
        cap.max_held_per_buyer = max_held_per_buyer;
    }

    // ---- Board: create jobs and assign workers ----

    /// Records a job and holds its payment and compute budget, for `buyer`. Only the board can
    /// call it, attaching exactly what the buyer paid for this: the amount, the compute budget for
    /// `max_attempts`, and storage at its largest. Any excess goes back to the buyer.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_open_job(
        &mut self,
        buyer: AccountId,
        spec_hash: String,
        fakes_hash: String,
        format_hash: String,
        amount: U128,
        verifier_hash: String,
        expires_at: U64,
        deliver_secs: u32,
        verdict_window_secs: u32,
        max_attempts: u32,
    ) -> JobId {
        self.require_board();
        require!(!self.paused, "new jobs are paused");
        let now = env::block_timestamp();
        require_hash(&spec_hash, "spec_hash");
        require_hash(&fakes_hash, "fakes_hash");
        require_hash(&format_hash, "format_hash");
        require!(
            verifier_hash == self.verifier_hash,
            "verifier_hash is not the build this contract runs"
        );
        require!(amount.0 > 0, "amount must be greater than zero");
        require!(
            (1..=MAX_ATTEMPTS).contains(&max_attempts),
            "max_attempts must be 1 to 3"
        );
        require!(
            expires_at.0 > now.saturating_add(u64::from(MIN_WINDOW_SECS) * NANOS_PER_SEC)
                && expires_at.0 - now <= MAX_OPEN_NANOS,
            "expires_at must be from 30 minutes to 7 days away"
        );
        for (secs, name) in [
            (deliver_secs, "deliver_secs"),
            (verdict_window_secs, "verdict_window_secs"),
        ] {
            require!(
                (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&secs),
                format!("{name} must be between 1800 and 86400")
            );
        }
        let budget = budget_for(max_attempts, self.run_deposit);

        let id = self.next_id;
        self.next_id += 1;
        let mut job = Job {
            buyer: buyer.clone(),
            worker: None,
            token: None,
            amount,
            spec_hash,
            fakes_hash,
            format_hash,
            verifier_url: self.verifier_url.clone(),
            verifier_hash,
            secrets_owner: self.secrets_owner.clone(),
            release: Release::Verdict,
            compute_budget: U128(budget.as_yoctonear()),
            expires_at,
            deliver_secs,
            deadline: U64(0),
            verdict_window_secs,
            max_attempts,
            history: Vec::new(),
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
            .saturating_mul(u128::from(env::storage_usage() - storage_before) + BUYER_RECORD_BYTES);
        let needed = NearToken::from_yoctonear(amount.0)
            .saturating_add(budget)
            .saturating_add(storage_cost);
        let attached = env::attached_deposit();
        require!(
            attached >= needed,
            format!("attach at least {needed}: the amount, the compute budget and storage")
        );
        job.storage_deposit = storage_cost;
        self.jobs.insert(id, job);
        self.hold(&buyer, amount.0);

        let excess = attached.saturating_sub(needed);
        if !excess.is_zero() {
            Promise::new(buyer).transfer(excess).detach();
        }
        emit("job_created", id);
        id
    }

    /// Gives an open job to the worker whose claim the board accepted. The money is already held,
    /// so the worker can start at once.
    pub fn assign(&mut self, job_id: JobId, worker: AccountId) {
        self.require_board();
        require!(!self.paused, "new assignments are paused");
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        require!(job.state == JobState::Open, "job is not open");
        require!(now < job.expires_at.0, "this job has ended");
        require!(worker != job.buyer, "the worker cannot be the buyer");
        require!(
            (job.history.len() as u32) < job.max_attempts,
            "no attempts are left"
        );
        job.worker = Some(worker);
        job.deadline = U64(now.saturating_add(u64::from(job.deliver_secs) * NANOS_PER_SEC));
        job.state = JobState::Funded;
        emit("job_assigned", job_id);
    }

    // ---- Worker ----

    /// Fixes the deliverable by its hash. Only the job's worker, before the deadline.
    pub fn deliver(&mut self, job_id: JobId, deliverable_hash: String) {
        require_hash(&deliverable_hash, "deliverable_hash");
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let job = self.job_mut(job_id);
        require!(
            job.worker.as_ref() == Some(&caller),
            "only the job's worker can deliver"
        );
        require!(
            job.state == JobState::Funded,
            "job is not awaiting delivery"
        );
        require!(now <= job.deadline.0, "the delivery deadline has passed");
        job.deliverable_hash = Some(deliverable_hash);
        job.delivered_at = Some(U64(now));
        job.state = JobState::Delivered;
        emit("job_delivered", job_id);
    }

    // ---- The job's own parties and its relay: run the verifier, paid from the job's budget ----

    /// Only the relay that holds the texts or the buyer can start it, so nobody else can spend the
    /// buyer's budget on runs that cannot read the texts.
    pub fn request_challenge(&mut self, job_id: JobId) -> Promise {
        let now = env::block_timestamp();
        let job = self.job(job_id);
        let caller = env::predecessor_account_id();
        require!(
            caller == job.secrets_owner || caller == job.buyer,
            "only the relay or the buyer can start the challenge"
        );
        let ready = match job.state {
            JobState::Draft => true,
            JobState::Challenging => job.run_is_stale(now),
            _ => false,
        };
        require!(ready, "job is not awaiting a challenge");
        require!(now < job.expires_at.0, "this job has ended");
        self.start_run(job_id, RunKind::Challenge, JobState::Challenging)
    }

    /// Only the relay that holds the texts or the job's worker can start it, so the buyer cannot use up
    /// the budget with failing runs and leave honest work without a verdict. Refused once the verdict
    /// window has closed.
    pub fn request_verification(&mut self, job_id: JobId) -> Promise {
        let now = env::block_timestamp();
        let job = self.job(job_id);
        let caller = env::predecessor_account_id();
        require!(
            caller == job.secrets_owner || job.worker.as_ref() == Some(&caller),
            "only the relay or the job's worker can start verification"
        );
        let ready = match job.state {
            JobState::Delivered => true,
            JobState::Verifying => job.run_is_stale(now),
            _ => false,
        };
        require!(ready, "job is not awaiting verification");
        require!(
            now <= job.verdict_deadline(),
            "the verdict window has closed"
        );
        self.start_run(job_id, RunKind::Verify, JobState::Verifying)
    }

    /// Lets the buyer pay for more runs, if failed runs used up the budget.
    #[payable]
    pub fn top_up(&mut self, job_id: JobId) {
        let added = env::attached_deposit().as_yoctonear();
        let job = self.job_mut(job_id);
        require!(
            matches!(
                job.state,
                JobState::Draft
                    | JobState::Challenging
                    | JobState::Open
                    | JobState::Funded
                    | JobState::Delivered
                    | JobState::Verifying
            ),
            "this job has finished"
        );
        job.compute_budget = U128(job.compute_budget.0.saturating_add(added));
        emit("budget_topped_up", job_id);
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
        let stale = job.run_is_stale(env::block_timestamp());
        job.run_started_at = None;
        let recorded = match (&result, kind) {
            _ if stale => false,
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
            (true, JobState::Open) => "check_accepted",
            (true, JobState::CheckRejected) => "check_rejected",
            (true, JobState::Passed) => "verdict_passed",
            (true, _) => "verdict_failed",
        };
        emit(event, job_id);
        recorded
    }

    /// Recovers unused compute deposits when OutLayer's own settlement callback failed. The
    /// request id is public in OutLayer's execution_requested event. OutLayer checks that this
    /// contract requested it, that it is stale, and that it has not already settled; its refund
    /// goes to the payer it was given, the job's buyer.
    pub fn cancel_stale_outlayer_execution(&self, request_id: U64) -> Promise {
        require!(
            env::prepaid_gas() >= Gas::from_tgas(70),
            "attach at least 70 Tgas"
        );
        Promise::new(self.outlayer.clone()).function_call(
            "cancel_stale_execution".to_string(),
            json!({ "request_id": request_id.0 })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(50),
        )
    }

    // ---- Anyone: move the money ----

    /// Pays the worker after a passing verdict.
    pub fn release(&mut self, job_id: JobId) -> Promise {
        Self::require_payout_gas();
        let job = self.job_mut(job_id);
        require!(job.state == JobState::Passed, "job has not passed");
        job.state = JobState::Releasing;
        let worker = job.worker.clone().unwrap_or_else(|| env::abort());
        let amount = NearToken::from_yoctonear(job.amount.0);
        emit("payout_started", job_id);
        Promise::new(worker).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                .on_payout(job_id, true),
        )
    }

    /// After a failing verdict: the next worker gets the job if attempts and time are left;
    /// otherwise the buyer is refunded. Also retries a refund whose transfer failed.
    pub fn refund(&mut self, job_id: JobId) -> Option<Promise> {
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        match job.state {
            JobState::Failed => {
                job.record_attempt(Outcome::Failed);
                self.reopen_or_refund(job_id, now)
            }
            JobState::RefundDue => Some(self.start_refund(job_id)),
            _ => env::panic_str("job has not failed"),
        }
    }

    /// When a worker missed the deadline, or no verdict was recorded in the verdict window. A run
    /// in flight gets `RUN_TIMEOUT_NANOS` to finish first; its late callback is then ignored.
    pub fn expire(&mut self, job_id: JobId) -> Option<Promise> {
        let now = env::block_timestamp();
        let job = self.job_mut(job_id);
        let outcome = match job.state {
            JobState::Funded if now > job.deadline.0 => Outcome::NoDelivery,
            JobState::Delivered if now > job.verdict_deadline() => Outcome::NoVerdict,
            JobState::Verifying if now > job.verdict_deadline() && job.run_is_stale(now) => {
                Outcome::NoVerdict
            }
            _ => env::panic_str("job has not expired"),
        };
        job.run_started_at = None;
        job.record_attempt(outcome);
        self.reopen_or_refund(job_id, now)
    }

    /// Ends a job no worker is on, and refunds the buyer. The buyer or the board can do this at
    /// any time; anyone can once the job has ended.
    pub fn close(&mut self, job_id: JobId) -> Promise {
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let by_board = self.board.as_ref() == Some(&caller);
        let job = self.job_mut(job_id);
        let idle = match job.state {
            JobState::Draft | JobState::Open | JobState::CheckRejected => true,
            JobState::Challenging => job.run_is_stale(now),
            _ => false,
        };
        require!(idle, "only a job with no worker on it can be closed");
        require!(
            caller == job.buyer || by_board || now >= job.expires_at.0,
            "only the buyer can close this job before it ends"
        );
        job.run_started_at = None;
        job.state = JobState::RefundDue;
        self.start_refund(job_id)
    }

    /// Settles a payout once its transfer has finished. On failure the job goes back, so the
    /// payout can be retried.
    #[private]
    pub fn on_payout(&mut self, job_id: JobId, to_worker: bool) -> bool {
        // Only the outcome matters, so no result bytes are read. A result longer than that limit
        // still means the transfer succeeded, and must never be retried as if it had failed.
        let paid = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let job = self.job_mut(job_id);
        let (buyer, amount) = (job.buyer.clone(), job.amount.0);
        if !paid {
            job.state = if to_worker {
                JobState::Passed
            } else {
                JobState::RefundDue
            };
            emit("payout_failed", job_id);
            return false;
        }
        if to_worker {
            job.state = JobState::Released;
            if let Some(worker) = job.worker.clone() {
                let record = AttemptRecord {
                    worker,
                    outcome: Outcome::Paid,
                    failed_rule: None,
                    deliverable_hash: job.deliverable_hash.clone(),
                    report_hash: job.report_hash.clone(),
                    verdict_request_id: job.verdict_request_id,
                };
                job.history.push(record);
            }
        } else {
            job.state = JobState::Refunded;
            job.compute_budget = U128(0);
        }
        self.release_hold(&buyer, amount);
        // A paid job's leftover compute budget goes back through `return_budget`, its own call
        // with its own gas, so this callback stays small enough to always finish.
        emit("payout_done", job_id);
        true
    }

    /// Returns what is left of a paid job's compute budget to the buyer. Anyone can retry it if a
    /// transfer failed.
    pub fn return_budget(&mut self, job_id: JobId) -> Promise {
        let job = self.job(job_id);
        require!(job.state == JobState::Released, "job has not been paid");
        require!(job.compute_budget.0 > 0, "nothing is left to return");
        self.start_budget_return(job_id)
    }

    #[private]
    pub fn on_budget_returned(&mut self, job_id: JobId, amount: U128) -> bool {
        let sent = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if !sent {
            let job = self.job_mut(job_id);
            job.compute_budget = U128(job.compute_budget.0.saturating_add(amount.0));
        }
        sent
    }

    /// Once a job has ended, returns to its buyer what the buyer paid for storage beyond what the
    /// finished record still uses. The job was charged at its largest when it was created; the
    /// record stays, as evidence. Anyone can call it. It never returns more than was paid, and a
    /// second call finds nothing left.
    pub fn finish_storage(&mut self, job_id: JobId) -> Promise {
        let job = self.job(job_id).clone();
        require!(
            job.is_finished(),
            "only a job that has ended, with its budget returned, can give back storage"
        );
        // Measure what the record uses now by taking it out and putting it back.
        self.jobs.flush();
        let before = env::storage_usage();
        self.jobs.remove(&job_id);
        self.jobs.flush();
        let record_bytes = before.saturating_sub(env::storage_usage());
        let still_used = env::storage_byte_cost().saturating_mul(u128::from(record_bytes));
        let back = job.storage_deposit.saturating_sub(still_used);
        require!(!back.is_zero(), "no storage is left to return");
        let buyer = job.buyer.clone();
        let mut job = job;
        job.storage_deposit = job.storage_deposit.saturating_sub(back);
        self.jobs.insert(job_id, job);
        self.jobs.flush();
        emit("storage_returned", job_id);
        Promise::new(buyer).transfer(back).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                .on_storage_returned(job_id, U128(back.as_yoctonear())),
        )
    }

    /// Puts the amount back on the job if the transfer failed, so `finish_storage` can be retried.
    #[private]
    pub fn on_storage_returned(&mut self, job_id: JobId, amount: U128) -> bool {
        let sent = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if !sent {
            let job = self.job_mut(job_id);
            job.storage_deposit = job
                .storage_deposit
                .saturating_add(NearToken::from_yoctonear(amount.0));
        }
        sent
    }

    // ---- Views ----

    pub fn get_job(&self, job_id: JobId) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    /// Jobs with ids from `from_id`, at most `limit` (capped at 50).
    pub fn get_jobs(&self, from_id: JobId, limit: u64) -> Vec<(JobId, Job)> {
        let end = from_id.saturating_add(limit.min(50)).min(self.next_id);
        (from_id..end)
            .filter_map(|id| self.jobs.get(&id).map(|job| (id, job.clone())))
            .collect()
    }

    /// The secret profile a run of this job will read, so whoever holds the texts can pin them.
    pub fn get_secrets_profile(&self, job_id: JobId, kind: RunKind) -> String {
        self.job(job_id).secrets_profile(job_id, kind)
    }

    /// What a new job with this many attempts must bring for runs, in yoctoNEAR.
    pub fn get_budget_for(&self, max_attempts: u32) -> U128 {
        U128(budget_for(max_attempts, self.run_deposit).as_yoctonear())
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            pending_owner: self.pending_owner.clone(),
            outlayer: self.outlayer.clone(),
            board: self.board.clone(),
            verifier_url: self.verifier_url.clone(),
            verifier_hash: self.verifier_hash.clone(),
            secrets_owner: self.secrets_owner.clone(),
            next_job_id: self.next_id,
            paused: self.paused,
            run_deposit: U128(self.run_deposit.as_yoctonear()),
            caps: self.caps.clone(),
        }
    }
}

impl Escrow {
    fn near_cap(&mut self) -> &mut AssetCap {
        self.caps
            .iter_mut()
            .find(|cap| cap.token.is_none())
            .unwrap_or_else(|| env::panic_str("NEAR has no cap"))
    }

    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can do this"
        );
    }

    fn require_board(&self) {
        require!(
            self.board.as_ref() == Some(&env::predecessor_account_id()),
            "only the board can do this"
        );
    }

    fn require_payout_gas() {
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_PAYOUT,
            "attach at least 50 Tgas"
        );
    }

    fn job(&self, job_id: JobId) -> &Job {
        self.jobs
            .get(&job_id)
            .unwrap_or_else(|| env::panic_str("job not found"))
    }

    fn job_mut(&mut self, job_id: JobId) -> &mut Job {
        self.jobs
            .get_mut(&job_id)
            .unwrap_or_else(|| env::panic_str("job not found"))
    }

    /// Counts a new job's payment against the caps.
    fn hold(&mut self, buyer: &AccountId, amount: u128) {
        let cap = self.near_cap();
        require!(amount <= cap.max_job.0, "amount is over the per-job cap");
        let held = cap.held.0.saturating_add(amount);
        require!(
            held <= cap.max_held.0,
            "this would pass the cap on money held"
        );
        cap.held = U128(held);
        let per_buyer = cap.max_held_per_buyer.0;
        let key = (buyer.clone(), None);
        let by_buyer = self
            .held_by_buyer
            .get(&key)
            .copied()
            .unwrap_or(0)
            .saturating_add(amount);
        require!(
            by_buyer <= per_buyer,
            "this would pass this buyer's cap on money held"
        );
        self.held_by_buyer.insert(key, by_buyer);
    }

    fn release_hold(&mut self, buyer: &AccountId, amount: u128) {
        let cap = self.near_cap();
        cap.held = U128(cap.held.0.saturating_sub(amount));
        let key = (buyer.clone(), None);
        let left = self
            .held_by_buyer
            .get(&key)
            .copied()
            .unwrap_or(0)
            .saturating_sub(amount);
        if left == 0 {
            self.held_by_buyer.remove(&key);
        } else {
            self.held_by_buyer.insert(key, left);
        }
    }

    /// After an attempt ended without a pass.
    fn reopen_or_refund(&mut self, job_id: JobId, now: u64) -> Option<Promise> {
        let job = self.job_mut(job_id);
        if job.can_reopen(now) {
            job.state = JobState::Open;
            emit("job_reopened", job_id);
            None
        } else {
            job.state = JobState::RefundDue;
            Some(self.start_refund(job_id))
        }
    }

    /// Returns the payment and what is left of the compute budget to the buyer, in one transfer.
    fn start_refund(&mut self, job_id: JobId) -> Promise {
        Self::require_payout_gas();
        let job = self.job_mut(job_id);
        require!(job.state == JobState::RefundDue, "no refund is due");
        job.state = JobState::Refunding;
        let total = NearToken::from_yoctonear(job.amount.0.saturating_add(job.compute_budget.0));
        let buyer = job.buyer.clone();
        emit("payout_started", job_id);
        Promise::new(buyer).transfer(total).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                .on_payout(job_id, false),
        )
    }

    /// Sends the rest of the compute budget to the buyer, counted out first so it cannot go twice.
    fn start_budget_return(&mut self, job_id: JobId) -> Promise {
        let job = self.job_mut(job_id);
        let amount = job.compute_budget;
        job.compute_budget = U128(0);
        Promise::new(job.buyer.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAYOUT_CALLBACK)
                    .on_budget_returned(job_id, amount),
            )
    }

    /// Starts one OutLayer run of the job's pinned verifier on the job's own hashes, paid from its
    /// compute budget, and chains the private callback that is the only way a result can be
    /// recorded.
    fn start_run(&mut self, job_id: JobId, kind: RunKind, running: JobState) -> Promise {
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_RUN,
            "attach at least 150 Tgas"
        );
        let deposit = self.run_deposit;
        let now = env::block_timestamp();
        let escrow = env::current_account_id();
        let outlayer = self.outlayer.clone();
        let job = self.job_mut(job_id);
        require!(
            job.compute_budget.0 >= deposit.as_yoctonear(),
            "the compute budget is used up: the buyer can top it up"
        );
        job.compute_budget = U128(job.compute_budget.0 - deposit.as_yoctonear());
        job.state = running;
        job.attempt = job.attempt.saturating_add(1);
        job.run_started_at = Some(U64(now));
        let attempt = job.attempt;
        let buyer = job.buyer.clone();
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
            // OutLayer returns the unused part of the deposit straight to the buyer, who paid it.
            "payer_account_id": buyer,
        });
        emit("run_started", job_id);
        Promise::new(outlayer)
            .refund_to(buyer)
            .function_call_weight(
                "request_execution",
                args.to_string().into_bytes(),
                deposit,
                GAS_FOR_OUTLAYER,
                GasWeight(1),
            )
            .then(
                Self::ext(escrow)
                    .with_static_gas(GAS_FOR_RUN_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_run_result(job_id, attempt, kind),
            )
    }
}

mod migration;

#[cfg(test)]
mod tests;
