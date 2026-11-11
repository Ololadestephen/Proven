//! Proven PR bounties, one wallet each.
//!
//! A maintainer posts a bounty for one issue of the pilot repository (fixed at deployment) by
//! pasting its link and a reward; the contract locks the reward and a small storage deposit. The
//! maintainer's wallet proves, with a NEP-413 signature, control of a withdrawal key before any
//! money is locked: that key alone receives a refund, through a NEP-616 vault derived from it.
//!
//! A contributor connects a GitHub account to a wallet once (`link`): the wallet's GitHub account
//! creates a gist holding a challenge that names the wallet, and the pinned verifier reads it. A
//! wallet then claims a bounty with its own withdrawal-key proof, which fixes the payout key, and
//! has a limited time to submit a pull request. Submitting runs the verifier once over the pull
//! request and the link gist; the contract pins the GitHub author id, the pull request id and the
//! payout key from then on. A relink only affects later submissions.
//!
//! The maintainer confirms by merging on GitHub. A merge check that finds the pinned pull request
//! merged before the deadline pays the reward into the contributor's vault. Otherwise the reward
//! returns to the maintainer's vault. Nothing is forwarded to a wallet automatically and nothing
//! is ever swept: the vaults release money only against the withdrawal key's signature.
//!
//! Every GitHub fact comes from Proven's PR bounty verifier, pinned by its WASM URL and SHA-256,
//! run on OutLayer and returned to this contract's own private callbacks.

use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, near, require, AccountId, CryptoHash, Gas, GasWeight, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseIndex, PublicKey,
};

mod answer;
pub mod keys;
use answer::{parse, Parsed};
pub use keys::{ClaimProof, PostTerms, PostingProof};

pub type BountyId = u64;

/// What every OutLayer run attaches, above OutLayer's admission estimate.
pub const RUN_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Sponsored merge checks one bounty may use.
pub const SPONSORED_RUNS_PER_BOUNTY: u32 = 3;
/// Pays for the bounty record, a claim, the vault storage and the settlement fees while they are
/// in flight. Measured in the sandbox for the worst case after Option A: a payout leaves 0.00928
/// NEAR of this deposit unused and a refund 0.00900, so neither borrows from other balance.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(30);
/// Pays for a wallet's link record (measured worst case 618 bytes, 0.00618 NEAR). It comes back
/// to the caller unless the link, or the change it asks for, is recorded.
pub const LINK_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(7);
/// A run whose result has not landed after this long is stale: its late result changes nothing.
pub const RUN_TIMEOUT_NANOS: u64 = 15 * 60 * NANOS_PER_SEC;
pub const MAX_CLOCK_SKEW_SECS: u64 = 60;
pub const MIN_GRACE_SECS: u64 = 10 * 60;
pub const MAX_GRACE_SECS: u64 = 24 * 60 * 60;
pub const MAX_DURATION_SECS: u64 = 30 * 24 * 60 * 60;
pub const HARD_MAX_REWARD: NearToken = NearToken::from_near(5);
pub const HARD_MAX_HELD: NearToken = NearToken::from_near(10);
pub const HARD_MAX_OPEN_PER_BUYER: u32 = 5;
pub const HARD_MAX_SPONSOR_FLOAT: NearToken = NearToken::from_near(1);
pub const HARD_MAX_SPONSOR_SPENT: NearToken = NearToken::from_near(2);

/// How long a changed GitHub link waits before it applies to later submissions (72 hours).
#[cfg(not(feature = "test-faults"))]
pub const RELINK_DELAY_SECS: u64 = 72 * 60 * 60;
/// How long after the grace merge checks are still accepted, and a bounty whose merge could not
/// be read stays unrefunded (14 days). A merge that is verifiably on time is paid at any look before this.
#[cfg(not(feature = "test-faults"))]
pub const REFUND_CAP_SECS: u64 = 14 * 24 * 60 * 60;
/// The shortest a claim may last.
#[cfg(not(feature = "test-faults"))]
pub const MIN_CLAIM_SECS: u64 = 60 * 60;
#[cfg(feature = "test-faults")]
pub const RELINK_DELAY_SECS: u64 = 6;
#[cfg(feature = "test-faults")]
pub const REFUND_CAP_SECS: u64 = 30;
#[cfg(feature = "test-faults")]
pub const MIN_CLAIM_SECS: u64 = 4;

/// Recovery delays and the overlap guard. Test builds shorten them.
#[cfg(not(feature = "test-faults"))]
pub const PARTY_RECONCILE_DELAY_NANOS: u64 = 15 * 60 * NANOS_PER_SEC;
#[cfg(not(feature = "test-faults"))]
pub const OPEN_RECONCILE_DELAY_NANOS: u64 = 24 * 60 * 60 * NANOS_PER_SEC;
#[cfg(not(feature = "test-faults"))]
pub const RECONCILE_MARKER_TTL_NANOS: u64 = 10 * 60 * NANOS_PER_SEC;
#[cfg(feature = "test-faults")]
pub const PARTY_RECONCILE_DELAY_NANOS: u64 = 3 * NANOS_PER_SEC;
#[cfg(feature = "test-faults")]
pub const OPEN_RECONCILE_DELAY_NANOS: u64 = 9 * NANOS_PER_SEC;
#[cfg(feature = "test-faults")]
pub const RECONCILE_MARKER_TTL_NANOS: u64 = 4 * NANOS_PER_SEC;

/// Attached to each attempt's `StateInit`. A vault starts far below the zero-balance limit, so
/// nothing is needed; any amount would come back.
pub const VAULT_INIT_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
/// Attached to each deposit on top of the principal; the vault keeps exactly its storage
/// shortfall and returns the rest here. To be re-measured.
pub const DEPOSIT_FEE: NearToken = NearToken::from_millinear(6);
/// What a reconciler attaches; the vault keeps the storage its seal needs and returns the rest
/// to the reconciler.
pub const RECONCILE_DEPOSIT: NearToken = NearToken::from_millinear(10);

const NANOS_PER_SEC: u64 = 1_000_000_000;
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(150);
const GAS_FOR_LINK_CALLBACK: Gas = Gas::from_tgas(30);
/// Enough to read the answer, record the verdict and schedule `send_due`.
const GAS_FOR_CHECK_CALLBACK: Gas = Gas::from_tgas(100);
const GAS_FOR_SEND_DUE: Gas = Gas::from_tgas(80);
const GAS_FOR_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FOR_SEAL: Gas = Gas::from_tgas(10);
const GAS_FOR_SETTLE_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_SETTLE_OUTCOME: Gas = Gas::from_tgas(5);
const GAS_FOR_RECONCILE_CALLBACK: Gas = Gas::from_tgas(10);
/// Gas one attempt needs, with its two callbacks, from the sending call.
const GAS_PER_SEND: Gas = Gas::from_tgas(32);
pub const MIN_GAS_FOR_RECONCILE: Gas = Gas::from_tgas(40);
const GAS_FOR_CANCEL: Gas = Gas::from_tgas(50);
pub const MIN_PREPAID_GAS_FOR_RUN: Gas = Gas::from_tgas(260);
const RUN_MAX_INSTRUCTIONS: u64 = 5_000_000_000;
const RUN_MAX_MEMORY_MB: u32 = 128;
const RUN_MAX_SECONDS: u32 = 60;
const BUILD_TARGET: &str = "wasm32-wasip2";
const MAX_URL_LEN: usize = 256;
const MAX_REF_LEN: usize = 255;
const SLOT_LEN: usize = 25;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Open,
    Claimed,
    Bound,
    Paid,
    Ineligible,
    Refunded,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunKind {
    Submit,
    Merge,
}

/// The vault's record kind byte: payout 0, refund 1.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementKind {
    Payout,
    Refund,
}

impl SettlementKind {
    pub fn byte(self) -> u8 {
        match self {
            SettlementKind::Payout => 0,
            SettlementKind::Refund => 1,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementState {
    /// Owed and not in flight: anyone may send it with `send_due`.
    Due,
    /// Sent as attempt `attempt`, result not recorded yet.
    InFlight,
    /// Confirmed in the vault: the vault's own record shows the deposit.
    Done,
}

/// The runtime's result for the current attempt, written by the minimal second callback.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptOutcome {
    Unknown,
    Succeeded,
    Failed,
}

/// A reconciliation in progress for one attempt; blocks overlapping reconciles until it is
/// cleared by its callback or expires.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReconcileMarker {
    pub attempt: u32,
    pub started_at: U64,
}

/// A payout or a refund into one vault. Its key, vault and principal never change; the principal
/// stays in `held` until a deposit of exactly it is confirmed in the vault. That confirmation is
/// the vault receipt. A withdrawal to a wallet is a separate event that this contract never sees.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub kind: SettlementKind,
    pub key: PublicKey,
    pub vault: AccountId,
    pub principal: U128,
    pub state: SettlementState,
    pub attempt: u32,
    /// Block time (ns) the current attempt was sent.
    pub sent_at: U64,
    pub outcome: AttemptOutcome,
    pub reconcile: Option<ReconcileMarker>,
    /// `callback`, `recorded_outcome` or `reconcile`.
    pub done_by: Option<String>,
}

/// One wallet's claim. The GitHub id and the payout key are fixed here and never change.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub wallet: AccountId,
    pub github_id: U64,
    pub key: PublicKey,
    pub vault: AccountId,
    pub claimed_at: U64,
    /// Unix seconds. After this anyone can end the claim unless a submission is being checked.
    pub ends_at: U64,
}

/// The pull request a claim submitted, pinned for settlement.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub pr_number: u64,
    pub pr_id: U64,
    pub author_id: U64,
    pub wallet: AccountId,
    pub bound_at: U64,
    pub request_id: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MergeRecord {
    pub merged_at: U64,
    pub request_id: U64,
    pub checked_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LiveRun {
    pub seq: U64,
    pub kind: RunKind,
    pub requested_at: U64,
    pub pr_number: u64,
    pub payer: AccountId,
    pub sponsored: bool,
    /// For a submission: the link gist read in the same run.
    pub gist_id: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CheckRecord {
    pub seq: U64,
    pub kind: String,
    pub request_id: Option<U64>,
    pub resolved_at: U64,
    pub outcome: String,
}

/// The latest merge look that read GitHub's facts for the pinned pull request and found it not
/// merged: a definitive negative. A look that failed (timeout, `no_result`, inconsistent facts)
/// is never one. A refund before the hard cutoff needs one requested at least `MAX_CLOCK_SKEW_SECS`
/// (60 s) after the merge deadline, as clocks may differ and GitHub may report a merge late.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Look {
    pub requested_at: U64,
    pub resolved_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bounty {
    pub buyer: AccountId,
    pub reward: U128,
    pub sponsored_runs: u32,
    pub repo: String,
    pub repo_id: U64,
    pub issue: u64,
    pub base_ref: String,
    pub posted_at: U64,
    pub claim_by: U64,
    pub claim_secs: U64,
    pub merge_deadline: U64,
    pub grace_secs: U64,
    pub status: Status,
    pub maintainer_key: PublicKey,
    pub maintainer_vault: AccountId,
    pub posting_nonce: String,
    pub claim: Option<Claim>,
    pub binding: Option<Binding>,
    pub merge: Option<MergeRecord>,
    pub live: Option<LiveRun>,
    pub last_check: Option<CheckRecord>,
    pub definite_look: Option<Look>,
    pub payout: Option<Settlement>,
    pub refund: Option<Settlement>,
}

impl Bounty {
    /// The end of the grace after the merge deadline: from then on a definitive negative look
    /// lets anyone refund. Merge checks continue after it.
    fn grace_end_nanos(&self) -> u64 {
        self.merge_deadline
            .0
            .saturating_add(self.grace_secs.0)
            .saturating_mul(NANOS_PER_SEC)
    }

    /// The hard cutoff: merge checks are accepted until here, and from here a refund opens without
    /// any definitive look. A merge before the deadline is paid by any check that reads it before
    /// this time.
    fn hard_refund_nanos(&self) -> u64 {
        self.grace_end_nanos()
            .saturating_add(REFUND_CAP_SECS.saturating_mul(NANOS_PER_SEC))
    }

    fn live_run(&self, now: u64) -> Option<&LiveRun> {
        self.live
            .as_ref()
            .filter(|run| now.saturating_sub(run.requested_at.0) <= RUN_TIMEOUT_NANOS)
    }

    fn settlement(&self, kind: SettlementKind) -> Option<&Settlement> {
        match kind {
            SettlementKind::Payout => self.payout.as_ref(),
            SettlementKind::Refund => self.refund.as_ref(),
        }
    }

    fn settlement_mut(&mut self, kind: SettlementKind) -> Option<&mut Settlement> {
        match kind {
            SettlementKind::Payout => self.payout.as_mut(),
            SettlementKind::Refund => self.refund.as_mut(),
        }
    }

    fn is_party(&self, account: &AccountId) -> bool {
        &self.buyer == account || self.claim.as_ref().map(|c| &c.wallet) == Some(account)
    }
}

/// A wallet's GitHub link: the gist that proved it and the challenge that gist held.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub github_id: U64,
    pub gist_id: String,
    pub challenge: String,
    pub linked_at: U64,
}

/// A link that waits its delay before it applies to later submissions.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingLink {
    pub link: Link,
    pub activates_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct WalletLink {
    pub active: Option<Link>,
    pub pending: Option<PendingLink>,
}

/// A link check in progress for one wallet; blocks overlapping checks until its callback runs or
/// it goes stale.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkRun {
    pub seq: U64,
    pub requested_at: U64,
}

/// Written by `link` into its own `on_link` callback; never stored.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PendingLinkRun {
    pub seq: U64,
    pub gist_id: String,
    pub challenge: String,
    pub link_number: U64,
    pub requested_at: U64,
    pub expires_at: U64,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub network: String,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub pilot_repo: String,
    pub pilot_repo_id: U64,
    pub vault_code_hash: Base58CryptoHash,
    pub sponsor: AccountId,
    pub paused: bool,
    pub max_reward: U128,
    pub max_held: U128,
    pub max_open_per_buyer: u32,
    pub held: U128,
    pub in_flight: U128,
    pub sponsor_float: U128,
    pub sponsor_spent: U128,
    pub max_sponsor_float: U128,
    pub max_sponsor_spent: U128,
    pub bounty_count: u64,
    pub run_deposit: U128,
    pub sponsored_runs_per_bounty: u32,
    pub storage_deposit: U128,
    pub link_storage_deposit: U128,
    pub deposit_fee: U128,
    pub reconcile_deposit: U128,
    pub party_reconcile_delay_secs: u64,
    pub open_reconcile_delay_secs: u64,
    pub reconcile_marker_ttl_secs: u64,
    pub relink_delay_secs: u64,
    pub refund_cap_secs: u64,
    pub min_claim_secs: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PrBounty {
    owner: AccountId,
    outlayer: AccountId,
    network: String,
    verifier_url: String,
    verifier_hash: String,
    pilot_repo: String,
    pilot_repo_id: u64,
    /// The reviewed vault code's hash, fixed at deployment.
    vault_code: CryptoHash,
    /// The owner's account that OutLayer refunds sponsored runs to, fixed at deployment.
    sponsor: AccountId,
    paused: bool,
    max_reward: u128,
    max_held: u128,
    max_open_per_buyer: u32,
    /// Every reward not yet confirmed in a vault.
    held: u128,
    /// The part of `held` whose NEAR has left in an attempt with no recorded result.
    in_flight: u128,
    /// Owner money for sponsored merge checks; never part of `held`.
    sponsor_float: u128,
    sponsor_spent: u128,
    max_sponsor_float: u128,
    max_sponsor_spent: u128,
    posters: LookupSet<AccountId>,
    open_by_buyer: LookupMap<AccountId, u32>,
    bounties: Vector<Bounty>,
    used_prs: LookupMap<u64, BountyId>,
    used_nonces: LookupSet<[u8; 32]>,
    /// (bounty, wallet) pairs that held a claim that ended, so one wallet cannot hold a bounty
    /// again and again.
    barred: LookupSet<[u8; 32]>,
    links: LookupMap<AccountId, WalletLink>,
    /// The wallet that currently holds each GitHub id.
    github_owner: LookupMap<u64, AccountId>,
    used_gists: LookupSet<String>,
    /// How many links each wallet has completed; part of the next challenge.
    link_numbers: LookupMap<AccountId, u64>,
    link_runs: LookupMap<AccountId, LinkRun>,
    next_seq: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct AttemptArgs {
    bounty_id: BountyId,
    kind: SettlementKind,
    attempt: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct ReconcileArgs {
    bounty_id: BountyId,
    kind: SettlementKind,
    attempt: u32,
    started_at: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RunInput<'a> {
    v: u32,
    network: &'a str,
    contract: &'a AccountId,
    bounty: BountyId,
    seq: u64,
    op: &'static str,
    repo: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gist_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    challenge: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RunArgs<'a> {
    source: Source<'a>,
    resource_limits: Limits,
    input_data: String,
    response_format: &'static str,
    payer_account_id: &'a AccountId,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Source<'a> {
    #[serde(rename = "WasmUrl")]
    wasm_url: WasmUrl<'a>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct WasmUrl<'a> {
    url: &'a str,
    hash: &'a str,
    build_target: &'static str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Limits {
    max_instructions: u64,
    max_memory_mb: u32,
    max_execution_seconds: u32,
}

fn log(event: &str, bounty: BountyId, detail: &str) {
    env::log_str(&format!("{event} bounty={bounty} {detail}"));
}

fn secs_to_nanos(secs: u64) -> u64 {
    secs.saturating_mul(NANOS_PER_SEC)
}

/// Test builds only: deterministic faults keyed by the bounty's issue number or the signer, so
/// one build covers every recovery case. The release build has none of this.
#[cfg(feature = "test-faults")]
mod faults {
    /// From here up to the lost-callback issues: the first deposit fails and its callbacks run.
    pub const FAILED_FIRST_SEND_FROM_ISSUE: u64 = 8_500;
    pub const LOST_CALLBACKS_FROM_ISSUE: u64 = 9_000;
    /// From here up to, not including, the delayed-deposit issue.
    pub const FAILED_FIRST_DEPOSIT_FROM_ISSUE: u64 = 9_500;
    /// A real deposit, delayed by `DELAY_HOPS` self-calls, with lost callbacks.
    pub const DELAYED_DEPOSIT_ISSUE: u64 = 9_900;
    pub const DELAY_HOPS: u32 = 60;
}

#[near]
impl PrBounty {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        outlayer: AccountId,
        network: String,
        verifier_url: String,
        verifier_hash: String,
        pilot_repo: String,
        pilot_repo_id: U64,
        vault_code_hash: Base58CryptoHash,
        sponsor: AccountId,
        max_reward: U128,
        max_held: U128,
        max_open_per_buyer: u32,
        max_sponsor_float: U128,
        max_sponsor_spent: U128,
    ) -> Self {
        require!(
            network == "testnet" || network == "mainnet",
            "network must be testnet or mainnet"
        );
        require!(
            verifier_url.starts_with("https://") && verifier_url.len() <= MAX_URL_LEN,
            "verifier_url must be an https URL"
        );
        require!(
            is_sha256_hex(&verifier_hash),
            "verifier_hash must be 64 lowercase hex characters"
        );
        require!(is_repo(&pilot_repo), "pilot_repo must be owner/name");
        require!(pilot_repo_id.0 > 0, "pilot_repo_id is required");
        let mut contract = Self {
            owner,
            outlayer,
            network,
            verifier_url,
            verifier_hash,
            pilot_repo,
            pilot_repo_id: pilot_repo_id.0,
            vault_code: vault_code_hash.into(),
            sponsor,
            paused: false,
            max_reward: 0,
            max_held: 0,
            max_open_per_buyer: 0,
            held: 0,
            in_flight: 0,
            sponsor_float: 0,
            sponsor_spent: 0,
            max_sponsor_float: 0,
            max_sponsor_spent: 0,
            posters: LookupSet::new(b"p"),
            open_by_buyer: LookupMap::new(b"o"),
            bounties: Vector::new(b"b"),
            used_prs: LookupMap::new(b"u"),
            used_nonces: LookupSet::new(b"n"),
            barred: LookupSet::new(b"x"),
            links: LookupMap::new(b"l"),
            github_owner: LookupMap::new(b"g"),
            used_gists: LookupSet::new(b"s"),
            link_numbers: LookupMap::new(b"k"),
            link_runs: LookupMap::new(b"r"),
            next_seq: 0,
        };
        contract.apply_caps(max_reward, max_held, max_open_per_buyer);
        contract.apply_sponsor_limits(max_sponsor_float, max_sponsor_spent);
        contract
    }

    // ---- Owner: allowlist, caps, pause on new bounties, sponsor float ----

    pub fn add_poster(&mut self, account: AccountId) {
        self.assert_owner();
        self.posters.insert(account.clone());
        env::log_str(&format!("poster_added {account}"));
    }

    pub fn remove_poster(&mut self, account: AccountId) {
        self.assert_owner();
        self.posters.remove(&account);
        env::log_str(&format!("poster_removed {account}"));
    }

    /// Stops new bounties only. Everything else, including recovery and withdrawals, still works.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        env::log_str(&format!("paused {paused}"));
    }

    pub fn set_caps(&mut self, max_reward: U128, max_held: U128, max_open_per_buyer: u32) {
        self.assert_owner();
        self.apply_caps(max_reward, max_held, max_open_per_buyer);
    }

    pub fn set_sponsor_limits(&mut self, max_sponsor_float: U128, max_sponsor_spent: U128) {
        self.assert_owner();
        self.apply_sponsor_limits(max_sponsor_float, max_sponsor_spent);
    }

    /// Adds exactly the attached NEAR to the sponsor float. Only the owner or the sponsor
    /// account may fund it, and never above the float cap.
    #[payable]
    pub fn fund_sponsor(&mut self) -> U128 {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner || caller == self.sponsor,
            "only the owner or the sponsor account can fund the float"
        );
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the amount");
        let float = self.sponsor_float + amount;
        require!(
            float <= self.max_sponsor_float,
            "the sponsor float would exceed its cap"
        );
        self.sponsor_float = float;
        env::log_str(&format!("sponsor_funded amount={amount} float={float}"));
        U128(float)
    }

    // ---- Maintainer: post and cancel ----

    /// Posts a bounty. Attach exactly the reward plus the storage deposit. The maintainer's wallet
    /// signs a NEP-413 proof of the withdrawal key `key` over these exact terms and a fresh nonce.
    /// That key will receive any refund, so no money is locked for a key nobody has proved.
    #[payable]
    pub fn post_bounty(
        &mut self,
        terms: PostTerms,
        key: PublicKey,
        proof: PostingProof,
    ) -> BountyId {
        let buyer = env::predecessor_account_id();
        require!(!self.paused, "new bounties are paused");
        require!(
            self.posters.contains(&buyer),
            "only an approved maintainer can post"
        );
        let reward = terms.reward.0;
        require!(
            reward > 0 && reward <= self.max_reward,
            "reward is over the cap"
        );
        require!(
            env::attached_deposit().as_yoctonear() == reward + STORAGE_DEPOSIT.as_yoctonear(),
            "attach exactly the reward plus the storage deposit"
        );
        require!(
            self.held + reward <= self.max_held,
            "the contract's total cap is reached"
        );
        let open = self.open_by_buyer.get(&buyer).copied().unwrap_or(0);
        require!(
            open < self.max_open_per_buyer,
            "this maintainer has too many open bounties"
        );
        require!(
            terms.repo_id.0 == self.pilot_repo_id && terms.repo == self.pilot_repo,
            "this pilot only pays for its approved repository"
        );
        require!(terms.issue > 0, "the issue number is required");
        require!(
            !terms.base_ref.is_empty()
                && terms.base_ref.len() <= MAX_REF_LEN
                && !terms.base_ref.chars().any(char::is_control),
            "base_ref must be a branch name"
        );
        let now = env::block_timestamp();
        require!(
            now < secs_to_nanos(terms.claim_by.0) && terms.claim_by.0 <= terms.merge_deadline.0,
            "times must satisfy now < claim_by <= merge_deadline"
        );
        require!(
            secs_to_nanos(terms.merge_deadline.0)
                <= now.saturating_add(secs_to_nanos(MAX_DURATION_SECS)),
            "merge_deadline is more than 30 days away"
        );
        require!(
            (MIN_GRACE_SECS..=MAX_GRACE_SECS).contains(&terms.grace_secs.0),
            "grace must be 10 minutes to 1 day"
        );
        require!(
            (MIN_CLAIM_SECS..=MAX_DURATION_SECS).contains(&terms.claim_secs.0),
            "a claim must last at least the minimum and at most 30 days"
        );
        // The withdrawal-key proof, before any state change.
        keys::ed25519_bytes(&key);
        keys::check_expiry(proof.expires_at.0);
        let nonce = keys::parse_nonce(&proof.nonce);
        let nonce_key = keys::nonce_key(&buyer, &nonce);
        require!(
            !self.used_nonces.contains(&nonce_key),
            "this posting nonce has already been used"
        );
        let contract = env::current_account_id();
        let message = keys::posting_message(
            &self.network,
            contract.as_str(),
            buyer.as_str(),
            &nonce,
            &terms,
            &key,
            proof.expires_at.0,
        );
        keys::verify_key(&key, &proof.signature, contract.as_str(), &message);
        // Accepted: consume the nonce, record the bounty and reserve the reward.
        self.used_nonces.insert(nonce_key);
        self.held += reward;
        self.open_by_buyer.insert(buyer.clone(), open + 1);
        let id = u64::from(self.bounties.len());
        let vault = keys::vault_of(self.vault_code, &key);
        self.bounties.push(Bounty {
            buyer,
            reward: terms.reward,
            sponsored_runs: 0,
            repo: terms.repo,
            repo_id: terms.repo_id,
            issue: terms.issue,
            base_ref: terms.base_ref,
            posted_at: U64(now),
            claim_by: terms.claim_by,
            claim_secs: terms.claim_secs,
            merge_deadline: terms.merge_deadline,
            grace_secs: terms.grace_secs,
            status: Status::Open,
            maintainer_key: key,
            maintainer_vault: vault.clone(),
            posting_nonce: proof.nonce,
            claim: None,
            binding: None,
            merge: None,
            live: None,
            last_check: None,
            definite_look: None,
            payout: None,
            refund: None,
        });
        log(
            "bounty_posted",
            id,
            &format!("reward={reward} maintainer_vault={vault}"),
        );
        id
    }

    /// Withdraws a bounty nobody holds a claim on; the reward goes to the maintainer's vault.
    pub fn cancel(&mut self, bounty_id: BountyId) {
        let bounty = self.bounty(bounty_id);
        require!(
            env::predecessor_account_id() == bounty.buyer,
            "only the maintainer can cancel"
        );
        require!(
            bounty.status == Status::Open,
            "only a bounty with no claim can be cancelled"
        );
        self.start_refund(bounty_id, Status::Cancelled);
    }

    // ---- Contributor: connect GitHub once ----

    /// The text that goes, alone, in the link gist: it names this network, contract, wallet, the
    /// wallet's link number and the expiry.
    pub fn link_challenge(&self, wallet: AccountId, expires_at: U64) -> String {
        keys::link_challenge(
            &self.network,
            env::current_account_id().as_str(),
            wallet.as_str(),
            self.link_numbers.get(&wallet).copied().unwrap_or(0),
            expires_at.0,
        )
    }

    /// Starts the check of a link gist for the calling wallet. The gist's owner becomes the
    /// wallet's GitHub account if the verifier finds the wallet's challenge as its only file.
    /// Attach exactly 0.017 NEAR: 0.01 for the run (the unused compute returns to the caller) and
    /// 0.007 for the link's storage, returned unless the link or the change it asks for is
    /// recorded, so nobody can fill the contract's storage at the contract's expense.
    #[payable]
    pub fn link(&mut self, gist_id: String, expires_at: U64) -> Promise {
        let wallet = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(
            env::attached_deposit() == RUN_DEPOSIT.saturating_add(LINK_STORAGE_DEPOSIT),
            "attach exactly 0.017 NEAR"
        );
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_RUN,
            "attach at least 260 Tgas"
        );
        require!(
            is_gist_id(&gist_id),
            "gist_id must be the gist's lowercase hex id"
        );
        keys::check_expiry(expires_at.0);
        require!(
            !self.used_gists.contains(&gist_id),
            "this gist has already been used for a link"
        );
        if let Some(run) = self.link_runs.get(&wallet) {
            require!(
                now.saturating_sub(run.requested_at.0) > RUN_TIMEOUT_NANOS,
                "a link check is already running for this wallet"
            );
        }
        let number = self.link_numbers.get(&wallet).copied().unwrap_or(0);
        let challenge = keys::link_challenge(
            &self.network,
            env::current_account_id().as_str(),
            wallet.as_str(),
            number,
            expires_at.0,
        );
        let seq = self.next_seq();
        let repo = self.pilot_repo.clone();
        let input = self.input(
            0,
            seq,
            &repo,
            "gist",
            None,
            Some(&gist_id),
            Some(&challenge),
        );
        self.link_runs.insert(
            wallet.clone(),
            LinkRun {
                seq: U64(seq),
                requested_at: U64(now),
            },
        );
        env::log_str(&format!(
            "link_requested wallet={wallet} seq={seq} gist={gist_id}"
        ));
        let pending = PendingLinkRun {
            seq: U64(seq),
            gist_id,
            challenge,
            link_number: U64(number),
            requested_at: U64(now),
            expires_at,
        };
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_LINK_CALLBACK)
            .with_unused_gas_weight(0)
            .on_link(wallet.clone(), pending);
        self.run(input, &wallet, RUN_DEPOSIT).then(callback)
    }

    /// The result of one link check; applied only to that exact run.
    #[private]
    pub fn on_link(&mut self, wallet: AccountId, pending: PendingLinkRun) -> String {
        let result = env::promise_result_checked(0, answer::MAX_OUTPUT_BYTES);
        let now = env::block_timestamp();
        let (network, contract) = (self.network.clone(), env::current_account_id());
        let live = matches!(
            self.link_runs.get(&wallet),
            Some(run) if run.seq == pending.seq
        );
        if !live {
            Promise::new(wallet).transfer(LINK_STORAGE_DEPOSIT).detach();
            return "ignored:not_live".to_string();
        }
        self.link_runs.remove(&wallet);
        let current = self.link_numbers.get(&wallet).copied().unwrap_or(0);
        let mut request_id = None;
        let outcome = if now.saturating_sub(pending.requested_at.0) > RUN_TIMEOUT_NANOS {
            "no_result:stale".to_string()
        } else if now > secs_to_nanos(pending.expires_at.0) {
            "no_result:expired".to_string()
        } else if current != pending.link_number.0 {
            "ignored:link_changed".to_string()
        } else if self.used_gists.contains(&pending.gist_id) {
            "mismatch:gist_used".to_string()
        } else {
            let repo = self.pilot_repo.clone();
            match parse(
                &result,
                &network,
                &contract,
                0,
                pending.seq.0,
                &repo,
                Parsed::Gist(&pending.gist_id),
            ) {
                Err(reason) => reason,
                Ok(answer) => {
                    request_id = Some(answer.request_id);
                    let facts = answer.gist.expect("parse returns the asked operation");
                    if facts.files != 1 {
                        "mismatch:ambiguous".to_string()
                    } else if !facts.challenge_matches {
                        "mismatch:challenge".to_string()
                    } else {
                        self.apply_link(
                            &wallet,
                            facts.owner_id,
                            pending.gist_id.clone(),
                            pending.challenge.clone(),
                            now,
                        )
                    }
                }
            }
        };
        env::log_str(&format!(
            "link_resolved wallet={wallet} seq={} outcome={outcome} request_id={}",
            pending.seq.0,
            show(request_id)
        ));
        if !matches!(
            outcome.as_str(),
            "linked" | "link_pending" | "link_refreshed"
        ) {
            // Nothing was stored for this call, so its storage deposit goes back.
            Promise::new(wallet).transfer(LINK_STORAGE_DEPOSIT).detach();
        }
        outcome
    }

    /// Applies a change that was waiting for its delay, if the delay has passed. Anyone may call.
    pub fn activate_link(&mut self, wallet: AccountId) -> bool {
        let due = self
            .links
            .get(&wallet)
            .and_then(|w| w.pending.as_ref())
            .map(|p| env::block_timestamp() >= secs_to_nanos(p.activates_at.0))
            .unwrap_or(false);
        require!(due, "no link change of this wallet is due");
        self.activate(&wallet)
    }

    /// Applies a waiting change now. Only the account that would be displaced may: the wallet
    /// that holds the GitHub id today, or the wallet itself if nobody does.
    pub fn confirm_link_change(&mut self, wallet: AccountId) -> bool {
        let pending = self
            .links
            .get(&wallet)
            .and_then(|w| w.pending.clone())
            .unwrap_or_else(|| env::panic_str("no link change is waiting for this wallet"));
        let incumbent = self
            .github_owner
            .get(&pending.link.github_id.0)
            .cloned()
            .unwrap_or_else(|| wallet.clone());
        require!(
            env::predecessor_account_id() == incumbent,
            "only the wallet that holds this GitHub account today can confirm early"
        );
        self.activate(&wallet)
    }

    /// Drops a waiting change. The wallet that asked for it, or the wallet that holds the GitHub
    /// id today, may.
    pub fn cancel_link_change(&mut self, wallet: AccountId) {
        let mut state = self
            .links
            .get(&wallet)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no link change is waiting for this wallet"));
        let pending = state
            .pending
            .take()
            .unwrap_or_else(|| env::panic_str("no link change is waiting for this wallet"));
        let caller = env::predecessor_account_id();
        let incumbent = self.github_owner.get(&pending.link.github_id.0).cloned();
        require!(
            caller == wallet || incumbent.as_ref() == Some(&caller),
            "only the wallet itself or the wallet that holds this GitHub account can cancel"
        );
        self.links.insert(wallet.clone(), state);
        env::log_str(&format!("link_change_cancelled wallet={wallet}"));
    }

    // ---- Contributor: claim, release, submit ----

    /// The text the contributor's wallet signs, with the withdrawal key, to claim.
    pub fn claim_key_message(
        &self,
        bounty_id: BountyId,
        wallet: AccountId,
        github_id: U64,
        key: PublicKey,
        expires_at: U64,
    ) -> String {
        keys::claim_message(
            &self.network,
            env::current_account_id().as_str(),
            wallet.as_str(),
            bounty_id,
            github_id.0,
            &key,
            expires_at.0,
        )
    }

    /// Claims an open bounty for the calling wallet, which must have a GitHub link. The proof
    /// shows control of the payout key `key`. The claim lasts the bounty's claim time and cannot
    /// be repeated by a wallet whose claim ended.
    pub fn claim(&mut self, bounty_id: BountyId, key: PublicKey, proof: ClaimProof) {
        let wallet = env::predecessor_account_id();
        let now = env::block_timestamp();
        self.refresh_link(&wallet);
        let bounty = self.bounty(bounty_id);
        require!(
            bounty.status == Status::Open,
            "this bounty is not open to claims"
        );
        require!(
            now < secs_to_nanos(bounty.claim_by.0),
            "the claim window has ended"
        );
        require!(
            !self.barred.contains(&keys::bar_key(bounty_id, &wallet)),
            "this wallet's earlier claim on the bounty ended; it cannot claim again"
        );
        let link = self
            .links
            .get(&wallet)
            .and_then(|w| w.active.clone())
            .unwrap_or_else(|| env::panic_str("connect a GitHub account to this wallet first"));
        keys::ed25519_bytes(&key);
        keys::check_expiry(proof.expires_at.0);
        let contract = env::current_account_id();
        let message = keys::claim_message(
            &self.network,
            contract.as_str(),
            wallet.as_str(),
            bounty_id,
            link.github_id.0,
            &key,
            proof.expires_at.0,
        );
        keys::verify_key(&key, &proof.signature, contract.as_str(), &message);
        let vault = keys::vault_of(self.vault_code, &key);
        let bounty = self.bounty_mut(bounty_id);
        let ends_at = (now / NANOS_PER_SEC)
            .saturating_add(bounty.claim_secs.0)
            .min(bounty.merge_deadline.0);
        bounty.claim = Some(Claim {
            wallet: wallet.clone(),
            github_id: link.github_id,
            key,
            vault: vault.clone(),
            claimed_at: U64(now),
            ends_at: U64(ends_at),
        });
        bounty.status = Status::Claimed;
        log(
            "claimed",
            bounty_id,
            &format!(
                "wallet={wallet} github_id={} vault={vault} ends_at={ends_at}",
                link.github_id.0
            ),
        );
    }

    /// The claimant gives the bounty back. The wallet cannot claim it again.
    pub fn release_claim(&mut self, bounty_id: BountyId) {
        let claimant = self
            .bounty(bounty_id)
            .claim
            .as_ref()
            .map(|c| c.wallet.clone());
        require!(
            claimant.as_ref() == Some(&env::predecessor_account_id()),
            "only the claimant can release the claim"
        );
        self.end_claim(bounty_id, "released");
    }

    /// The maintainer ends a claim that has no submitted pull request.
    pub fn revoke_claim(&mut self, bounty_id: BountyId) {
        require!(
            env::predecessor_account_id() == self.bounty(bounty_id).buyer,
            "only the maintainer can revoke a claim"
        );
        self.end_claim(bounty_id, "revoked");
    }

    /// Anyone ends a claim whose time has passed, so the bounty is open again.
    pub fn expire_claim(&mut self, bounty_id: BountyId) {
        let ends = self
            .bounty(bounty_id)
            .claim
            .as_ref()
            .map(|c| c.ends_at.0)
            .unwrap_or(u64::MAX);
        require!(
            env::block_timestamp() >= secs_to_nanos(ends),
            "the claim has not ended yet"
        );
        self.end_claim(bounty_id, "expired");
    }

    /// Submits a pull request for the caller's claim. One verifier run reads the pull request
    /// and the caller's link gist; the contract binds the GitHub author id, the pull request id
    /// and the payout key only if both match. Attach exactly 0.01 NEAR.
    #[payable]
    pub fn submit_pr(&mut self, bounty_id: BountyId, pr_number: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(
            env::attached_deposit() == RUN_DEPOSIT,
            "attach exactly 0.01 NEAR"
        );
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_RUN,
            "attach at least 260 Tgas"
        );
        require!(
            (1..=u64::from(u32::MAX)).contains(&pr_number),
            "pr_number must be a pull request number"
        );
        self.refresh_link(&caller);
        let bounty = self.bounty(bounty_id);
        let claim = bounty
            .claim
            .clone()
            .unwrap_or_else(|| env::panic_str("this bounty has no claim"));
        require!(
            bounty.status == Status::Claimed && claim.wallet == caller,
            "only the claimant can submit, and only while the bounty is claimed"
        );
        require!(now < secs_to_nanos(claim.ends_at.0), "your claim has ended");
        let link = self
            .links
            .get(&caller)
            .and_then(|w| w.active.clone())
            .unwrap_or_else(|| env::panic_str("connect a GitHub account to this wallet first"));
        require!(
            link.github_id == claim.github_id,
            "this wallet's GitHub link changed after it claimed, so this claim cannot be submitted; a released or ended claim cannot be made again by this wallet"
        );
        self.start_check(
            bounty_id,
            RunKind::Submit,
            pr_number,
            caller,
            false,
            Some((link.gist_id, link.challenge)),
        )
    }

    // ---- Anyone: check the merge ----

    /// Checks the pinned pull request. Attach exactly 0.01 NEAR to pay for the check yourself.
    /// The contributor's wallet may instead attach nothing for a check sponsored by the owner's
    /// float, up to three times per bounty while the float and its caps allow. A check may be
    /// repeated: a failed look changes nothing. Checks are accepted until the hard refund cutoff,
    /// so a merge before the deadline can still be verified after the grace.
    #[payable]
    pub fn check_merge(&mut self, bounty_id: BountyId) -> Promise {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_RUN,
            "attach at least 260 Tgas"
        );
        let bounty = self.bounty(bounty_id).clone();
        require!(
            bounty.status == Status::Bound,
            "the bounty has no submitted pull request to check"
        );
        require!(
            now < bounty.hard_refund_nanos(),
            "merge checks ended at the hard refund cutoff"
        );
        let binding = bounty
            .binding
            .clone()
            .expect("a bound bounty has a binding");
        let attached = env::attached_deposit();
        let (payer, sponsored) = if attached == RUN_DEPOSIT {
            (caller, false)
        } else {
            require!(
                attached.is_zero(),
                "attach exactly 0.01 NEAR, or nothing for a sponsored check"
            );
            require!(
                binding.wallet == caller,
                "only the contributor's wallet can use a sponsored check"
            );
            self.charge_sponsor(bounty_id);
            (self.sponsor.clone(), true)
        };
        self.start_check(
            bounty_id,
            RunKind::Merge,
            binding.pr_number,
            payer,
            sponsored,
            None,
        )
    }

    /// The result of a submission or merge check. Only the live run's result counts.
    #[private]
    pub fn on_check(&mut self, bounty_id: BountyId, seq: U64) -> String {
        let result = env::promise_result_checked(0, answer::MAX_OUTPUT_BYTES);
        let now = env::block_timestamp();
        let (network, contract) = (self.network.clone(), env::current_account_id());
        let Some(bounty) = u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
        else {
            return "ignored:no_bounty".to_string();
        };
        let live = match &bounty.live {
            Some(run) if run.seq == seq => run.clone(),
            _ => {
                log("check_ignored", bounty_id, &format!("seq={}", seq.0));
                return "ignored:not_live".to_string();
            }
        };
        bounty.live = None;
        let kind = match live.kind {
            RunKind::Submit => "submit",
            RunKind::Merge => "merge",
        };
        let asked_gist = live.gist_id.clone().unwrap_or_default();
        let asked = match live.kind {
            RunKind::Submit => Parsed::PullGist(live.pr_number, &asked_gist),
            RunKind::Merge => Parsed::pull(live.pr_number),
        };
        let mut request_id = None;
        let mut pay = false;
        let outcome = if now.saturating_sub(live.requested_at.0) > RUN_TIMEOUT_NANOS {
            "no_result:stale".to_string()
        } else {
            match parse(
                &result,
                &network,
                &contract,
                bounty_id,
                seq.0,
                &bounty.repo,
                asked,
            ) {
                Err(reason) => reason,
                Ok(answer) => {
                    request_id = Some(answer.request_id);
                    let facts = answer.pull.expect("parse returns the asked operation");
                    match live.kind {
                        RunKind::Submit => {
                            let claim = bounty.claim.clone();
                            let gist = answer.gist.expect("parse returns the asked operation");
                            let mismatch = match &claim {
                                Some(claim) if bounty.status == Status::Claimed => {
                                    if facts.repo_id != bounty.repo_id.0 {
                                        Some("repo_id")
                                    } else if facts.pr_number != live.pr_number {
                                        Some("pr_number")
                                    } else if facts.base_ref != bounty.base_ref {
                                        Some("base_ref")
                                    } else if facts.author_id != claim.github_id.0 {
                                        Some("author_id")
                                    } else if gist.owner_id != claim.github_id.0 {
                                        Some("link_owner")
                                    } else if gist.files != 1 {
                                        Some("link_ambiguous")
                                    } else if !gist.challenge_matches {
                                        Some("link_challenge")
                                    } else if facts.merged || facts.state != "open" {
                                        Some("not_open")
                                    } else if self.used_prs.contains_key(&facts.pr_id) {
                                        Some("pr_already_bound")
                                    } else {
                                        None
                                    }
                                }
                                _ => Some("not_claimed"),
                            };
                            match (mismatch, claim) {
                                (None, Some(claim)) => {
                                    self.used_prs.insert(facts.pr_id, bounty_id);
                                    bounty.binding = Some(Binding {
                                        pr_number: facts.pr_number,
                                        pr_id: U64(facts.pr_id),
                                        author_id: U64(facts.author_id),
                                        wallet: claim.wallet,
                                        bound_at: live.requested_at,
                                        request_id: U64(answer.request_id),
                                    });
                                    bounty.status = Status::Bound;
                                    "bound".to_string()
                                }
                                (Some(field), _) => format!("mismatch:{field}"),
                                (None, None) => "mismatch:not_claimed".to_string(),
                            }
                        }
                        RunKind::Merge => {
                            let binding =
                                bounty.binding.clone().expect("a merge check has a binding");
                            let bound_secs = binding.bound_at.0 / NANOS_PER_SEC;
                            if facts.repo_id != bounty.repo_id.0
                                || facts.pr_id != binding.pr_id.0
                                || facts.pr_number != binding.pr_number
                                || facts.author_id != binding.author_id.0
                            {
                                "no_result:inconsistent".to_string()
                            } else {
                                if facts.merged_at.is_none() {
                                    // GitHub's facts for the pinned pull request say it is not
                                    // merged: a definitive negative at the time it was requested.
                                    let newer = bounty
                                        .definite_look
                                        .map(|l| l.requested_at.0 < live.requested_at.0)
                                        .unwrap_or(true);
                                    if newer {
                                        bounty.definite_look = Some(Look {
                                            requested_at: live.requested_at,
                                            resolved_at: U64(now),
                                        });
                                    }
                                }
                                match facts.merged_at {
                                    None if facts.base_ref != bounty.base_ref => {
                                        "pending:base_ref".to_string()
                                    }
                                    None => "pending".to_string(),
                                    Some(_) if facts.base_ref != bounty.base_ref => {
                                        bounty.status = Status::Ineligible;
                                        "ineligible:base_ref".to_string()
                                    }
                                    Some(at) if at >= bounty.merge_deadline.0 => {
                                        bounty.status = Status::Ineligible;
                                        bounty.merge = Some(MergeRecord {
                                            merged_at: U64(at),
                                            request_id: U64(answer.request_id),
                                            checked_at: U64(now),
                                        });
                                        "ineligible:merged_after_deadline".to_string()
                                    }
                                    Some(at)
                                        if at.saturating_add(MAX_CLOCK_SKEW_SECS) < bound_secs =>
                                    {
                                        "no_result:merged_before_binding".to_string()
                                    }
                                    Some(at) => {
                                        bounty.merge = Some(MergeRecord {
                                            merged_at: U64(at),
                                            request_id: U64(answer.request_id),
                                            checked_at: U64(now),
                                        });
                                        pay = true;
                                        "paid".to_string()
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
        bounty.last_check = Some(CheckRecord {
            seq,
            kind: kind.to_string(),
            request_id: request_id.map(U64),
            resolved_at: U64(now),
            outcome: outcome.clone(),
        });
        log(
            "check_resolved",
            bounty_id,
            &format!(
                "seq={} kind={kind} outcome={outcome} request_id={}",
                seq.0,
                show(request_id)
            ),
        );
        if pay {
            self.start_payout(bounty_id);
        }
        outcome
    }

    // ---- Anyone: settle, send, recover, cancel a stale OutLayer request ----

    /// Refunds the maintainer's vault once the bounty can no longer pay. A bound bounty is
    /// refunded only while no check is running, and only (a) after the grace, with a definitive
    /// negative look requested 60 s (`MAX_CLOCK_SKEW_SECS`) or more after the deadline, or (b) at the cutoff.
    /// A timeout or `no_result` is never a negative. Under (b) a pull request merged on time
    /// goes unpaid if no check read GitHub before the cutoff, and the refund is final. A check in
    /// flight blocks the refund until its result lands or the run goes stale; a result that lands
    /// after the refund is ignored.
    pub fn settle(&mut self, bounty_id: BountyId) {
        let now = env::block_timestamp();
        let bounty = self.bounty(bounty_id);
        let idle = bounty.live_run(now).is_none();
        // A "not merged" answer counts only if it was requested at least the clock skew after the
        // deadline: GitHub's `merged_at` and NEAR's block time may differ by that much, and GitHub
        // may report a merge late. An earlier "not merged" never opens the refund.
        let looked = bounty
            .definite_look
            .map(|l| {
                l.requested_at.0
                    >= secs_to_nanos(bounty.merge_deadline.0.saturating_add(MAX_CLOCK_SKEW_SECS))
            })
            .unwrap_or(false);
        let due = match bounty.status {
            Status::Open => now >= secs_to_nanos(bounty.claim_by.0),
            Status::Claimed => {
                let ends = bounty.claim.as_ref().map_or(0, |c| c.ends_at.0);
                idle && now >= secs_to_nanos(ends) && now >= secs_to_nanos(bounty.claim_by.0)
            }
            Status::Bound => {
                idle && ((looked && now >= bounty.grace_end_nanos())
                    || now >= bounty.hard_refund_nanos())
            }
            Status::Ineligible => true,
            _ => false,
        };
        require!(due, "this bounty cannot be refunded yet");
        self.start_refund(bounty_id, Status::Refunded);
    }

    /// Sends every due settlement of the bounty that the contract can afford, each as a new
    /// attempt into the same vault for the same principal. Refused if none could be sent.
    pub fn send_due(&mut self, bounty_id: BountyId) -> u32 {
        let sent = self.send_affordable(bounty_id);
        require!(sent > 0, "no settlement of this bounty could be sent now");
        sent
    }

    /// The detached send after a paid check: like `send_due`, but never fails, so a bounty that
    /// cannot be sent yet simply stays due.
    #[private]
    pub fn send_due_after_check(&mut self, bounty_id: BountyId) -> u32 {
        self.send_affordable(bounty_id)
    }

    /// Finishes the current attempt from the outcome its second callback recorded, if its first
    /// callback did not run. Sends nothing.
    pub fn recover_settlement(&mut self, bounty_id: BountyId, kind: SettlementKind) -> bool {
        let s = self
            .bounty(bounty_id)
            .settlement(kind)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such settlement"));
        require!(
            s.state == SettlementState::InFlight,
            "this settlement is not in flight"
        );
        let ok = match s.outcome {
            AttemptOutcome::Succeeded => true,
            AttemptOutcome::Failed => false,
            AttemptOutcome::Unknown => {
                env::panic_str("no outcome is recorded for this attempt; reconcile instead")
            }
        };
        self.finish(bounty_id, kind, s.attempt, ok, "recorded_outcome")
    }

    #[private]
    pub fn on_settle(&mut self, bounty_id: BountyId, kind: SettlementKind, attempt: u32) -> bool {
        #[cfg(feature = "test-faults")]
        if self.bounty(bounty_id).issue >= faults::LOST_CALLBACKS_FROM_ISSUE {
            env::panic_str("fault injection: on_settle fails");
        }
        let ok = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        self.finish(bounty_id, kind, attempt, ok, "callback")
    }

    /// Records the runtime's result for one attempt and nothing else.
    #[private]
    pub fn on_settle_outcome(&mut self, bounty_id: BountyId, kind: SettlementKind, attempt: u32) {
        #[cfg(feature = "test-faults")]
        if self.bounty(bounty_id).issue >= faults::LOST_CALLBACKS_FROM_ISSUE {
            env::panic_str("fault injection: on_settle_outcome fails");
        }
        let ok = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if let Some(s) = u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
            .and_then(|b| b.settlement_mut(kind))
        {
            if s.attempt == attempt
                && s.state == SettlementState::InFlight
                && s.outcome == AttemptOutcome::Unknown
            {
                s.outcome = if ok {
                    AttemptOutcome::Succeeded
                } else {
                    AttemptOutcome::Failed
                };
            }
        }
    }

    /// Asks the vault to seal the current in-flight attempt and records its answer. A bounty
    /// party may call it 15 minutes after the attempt was sent, anyone after 24 hours; one
    /// reconciliation runs at a time. Attach exactly 0.01 NEAR; the vault returns what it does
    /// not keep for the seal's storage to the caller.
    #[payable]
    pub fn reconcile(&mut self, bounty_id: BountyId, kind: SettlementKind, attempt: u32) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(
            env::attached_deposit() == RECONCILE_DEPOSIT,
            "attach exactly 0.01 NEAR"
        );
        require!(
            env::prepaid_gas() >= MIN_GAS_FOR_RECONCILE,
            "attach at least 40 Tgas"
        );
        let code = self.vault_code;
        let bounty = self.bounty_mut(bounty_id);
        let party = bounty.is_party(&caller);
        let s = bounty
            .settlement_mut(kind)
            .unwrap_or_else(|| env::panic_str("no such settlement"));
        require!(
            s.state == SettlementState::InFlight,
            "this settlement is not in flight"
        );
        require!(
            attempt == s.attempt,
            "only the current attempt can be reconciled"
        );
        let delay = if party {
            PARTY_RECONCILE_DELAY_NANOS
        } else {
            OPEN_RECONCILE_DELAY_NANOS
        };
        require!(
            now >= s.sent_at.0.saturating_add(delay),
            "too early to reconcile this attempt"
        );
        if let Some(m) = s.reconcile {
            require!(
                now >= m.started_at.0.saturating_add(RECONCILE_MARKER_TTL_NANOS),
                "a reconciliation of this settlement is in progress"
            );
        }
        s.reconcile = Some(ReconcileMarker {
            attempt,
            started_at: U64(now),
        });
        let (key, vault) = (s.key.clone(), s.vault.clone());
        log(
            "reconcile_started",
            bounty_id,
            &format!("kind={kind:?} attempt={attempt} caller={caller} party={party}"),
        );
        let p = env::promise_batch_create(&vault);
        init_vault(p, code, &key);
        env::promise_batch_action_function_call(
            p,
            "seal",
            &slot_args(bounty_id, kind, attempt),
            RECONCILE_DEPOSIT,
            GAS_FOR_SEAL,
        );
        env::promise_set_refund_to(p, &caller);
        let args = serde_json::to_vec(&ReconcileArgs {
            bounty_id,
            kind,
            attempt,
            started_at: U64(now),
        })
        .expect("serializable");
        let answer = env::promise_then(
            p,
            env::current_account_id(),
            "on_reconcile",
            &args,
            NearToken::from_yoctonear(0),
            GAS_FOR_RECONCILE_CALLBACK,
        );
        env::promise_return(answer);
    }

    /// Applies the vault's sealed answer for one attempt, only while that attempt is in flight.
    #[private]
    pub fn on_reconcile(
        &mut self,
        bounty_id: BountyId,
        kind: SettlementKind,
        attempt: u32,
        started_at: U64,
    ) -> String {
        #[cfg(feature = "test-faults")]
        if env::signer_account_id().as_str().starts_with("fault-") {
            env::panic_str("fault injection: on_reconcile fails");
        }
        let result = env::promise_result_checked(0, SLOT_LEN);
        let Some(s) = u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
            .and_then(|b| b.settlement_mut(kind))
        else {
            return "ignored:no_settlement".to_string();
        };
        if s.reconcile
            == Some(ReconcileMarker {
                attempt,
                started_at,
            })
        {
            s.reconcile = None;
        }
        let slot = match result {
            Ok(bytes) if bytes.len() == SLOT_LEN => bytes,
            Ok(_) => return note(bounty_id, kind, attempt, "ignored:malformed"),
            Err(_) => return note(bounty_id, kind, attempt, "ignored:seal_failed"),
        };
        if s.state != SettlementState::InFlight || s.attempt != attempt {
            return note(bounty_id, kind, attempt, "ignored:not_in_flight");
        }
        let deposited = slot[0] == 1;
        let d_attempt = u32::from_le_bytes(slot[1..5].try_into().expect("4"));
        let d_amount = u128::from_le_bytes(slot[5..21].try_into().expect("16"));
        let sealed_through = u32::from_le_bytes(slot[21..25].try_into().expect("4"));
        let principal = s.principal.0;
        if deposited && d_attempt == attempt && d_amount == principal {
            self.finish(bounty_id, kind, attempt, true, "reconcile");
            note(bounty_id, kind, attempt, "deposited")
        } else if deposited {
            note(bounty_id, kind, attempt, "ignored:other_deposit")
        } else if sealed_through >= attempt {
            self.finish(bounty_id, kind, attempt, false, "reconcile");
            note(bounty_id, kind, attempt, "sealed_without_deposit")
        } else {
            note(bounty_id, kind, attempt, "ignored:not_sealed")
        }
    }

    /// One step of the delayed-deposit fault (test builds only).
    #[cfg(feature = "test-faults")]
    #[private]
    pub fn hop() {}

    pub fn cancel_stale_outlayer_execution(&self, request_id: U64) -> Promise {
        Promise::new(self.outlayer.clone()).function_call(
            "cancel_stale_execution".to_string(),
            format!("{{\"request_id\":{}}}", request_id.0).into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FOR_CANCEL,
        )
    }

    // ---- Views ----

    pub fn get_bounty(&self, bounty_id: BountyId) -> Option<Bounty> {
        u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get(i))
            .cloned()
    }

    pub fn get_bounties(&self, from_id: BountyId, limit: u64) -> Vec<(BountyId, Bounty)> {
        let end = from_id
            .saturating_add(limit.min(50))
            .min(u64::from(self.bounties.len()));
        (from_id..end)
            .filter_map(|id| self.get_bounty(id).map(|b| (id, b)))
            .collect()
    }

    pub fn get_settlement(&self, bounty_id: BountyId, kind: SettlementKind) -> Option<Settlement> {
        self.get_bounty(bounty_id)
            .and_then(|b| b.settlement(kind).cloned())
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            outlayer: self.outlayer.clone(),
            network: self.network.clone(),
            verifier_url: self.verifier_url.clone(),
            verifier_hash: self.verifier_hash.clone(),
            pilot_repo: self.pilot_repo.clone(),
            pilot_repo_id: U64(self.pilot_repo_id),
            vault_code_hash: self.vault_code.into(),
            sponsor: self.sponsor.clone(),
            paused: self.paused,
            max_reward: U128(self.max_reward),
            max_held: U128(self.max_held),
            max_open_per_buyer: self.max_open_per_buyer,
            held: U128(self.held),
            in_flight: U128(self.in_flight),
            sponsor_float: U128(self.sponsor_float),
            sponsor_spent: U128(self.sponsor_spent),
            max_sponsor_float: U128(self.max_sponsor_float),
            max_sponsor_spent: U128(self.max_sponsor_spent),
            bounty_count: u64::from(self.bounties.len()),
            run_deposit: U128(RUN_DEPOSIT.as_yoctonear()),
            sponsored_runs_per_bounty: SPONSORED_RUNS_PER_BOUNTY,
            storage_deposit: U128(STORAGE_DEPOSIT.as_yoctonear()),
            link_storage_deposit: U128(LINK_STORAGE_DEPOSIT.as_yoctonear()),
            deposit_fee: U128(DEPOSIT_FEE.as_yoctonear()),
            reconcile_deposit: U128(RECONCILE_DEPOSIT.as_yoctonear()),
            party_reconcile_delay_secs: PARTY_RECONCILE_DELAY_NANOS / NANOS_PER_SEC,
            open_reconcile_delay_secs: OPEN_RECONCILE_DELAY_NANOS / NANOS_PER_SEC,
            reconcile_marker_ttl_secs: RECONCILE_MARKER_TTL_NANOS / NANOS_PER_SEC,
            relink_delay_secs: RELINK_DELAY_SECS,
            refund_cap_secs: REFUND_CAP_SECS,
            min_claim_secs: MIN_CLAIM_SECS,
        }
    }

    pub fn is_poster(&self, account: AccountId) -> bool {
        self.posters.contains(&account)
    }

    pub fn bound_pr(&self, pr_id: U64) -> Option<BountyId> {
        self.used_prs.get(&pr_id.0).copied()
    }

    /// The vault that holds a withdrawal key's money.
    pub fn vault_of(&self, key: PublicKey) -> AccountId {
        keys::vault_of(self.vault_code, &key)
    }

    pub fn is_nonce_used(&self, maintainer: AccountId, nonce: String) -> bool {
        self.used_nonces
            .contains(&keys::nonce_key(&maintainer, &keys::parse_nonce(&nonce)))
    }

    pub fn posting_terms_digest(
        &self,
        terms: PostTerms,
        key: PublicKey,
        maintainer: AccountId,
        nonce: String,
    ) -> String {
        keys::terms_digest(
            &self.network,
            env::current_account_id().as_str(),
            maintainer.as_str(),
            &keys::parse_nonce(&nonce),
            &terms,
            &key,
        )
    }

    /// The exact text the maintainer's withdrawal key signs for a posting.
    pub fn posting_key_message(
        &self,
        terms: PostTerms,
        key: PublicKey,
        maintainer: AccountId,
        nonce: String,
        expires_at: U64,
    ) -> String {
        keys::posting_message(
            &self.network,
            env::current_account_id().as_str(),
            maintainer.as_str(),
            &keys::parse_nonce(&nonce),
            &terms,
            &key,
            expires_at.0,
        )
    }

    /// A wallet's active GitHub link and any change that is waiting for its delay.
    pub fn get_link(&self, wallet: AccountId) -> Option<WalletLink> {
        self.links.get(&wallet).cloned()
    }

    /// How many links the wallet has completed: the number its next link challenge names. The
    /// page builds the challenge itself from this, the wallet, the network, the contract and the
    /// expiry, so a server or RPC cannot hand it a challenge for another wallet.
    pub fn get_link_number(&self, wallet: AccountId) -> U64 {
        U64(self.link_numbers.get(&wallet).copied().unwrap_or(0))
    }

    /// The wallet that holds a GitHub id today.
    pub fn github_owner_of(&self, github_id: U64) -> Option<AccountId> {
        self.github_owner.get(&github_id.0).cloned()
    }

    pub fn is_barred(&self, bounty_id: BountyId, wallet: AccountId) -> bool {
        self.barred.contains(&keys::bar_key(bounty_id, &wallet))
    }

    /// The balance beyond storage, the reserved principals still in the contract and the
    /// sponsor float: what pays settlement fees.
    pub fn get_free_balance(&self) -> U128 {
        U128(self.free_balance())
    }
}

fn note(bounty: BountyId, kind: SettlementKind, attempt: u32, outcome: &str) -> String {
    log(
        "reconcile_resolved",
        bounty,
        &format!("kind={kind:?} attempt={attempt} outcome={outcome}"),
    );
    outcome.to_string()
}

fn slot_args(bounty: BountyId, kind: SettlementKind, attempt: u32) -> Vec<u8> {
    let mut out = bounty.to_le_bytes().to_vec();
    out.push(kind.byte());
    out.extend(attempt.to_le_bytes());
    out
}

/// Appends the vault's NEP-616 state init (code by hash, the withdrawal key's initial state).
fn init_vault(p: PromiseIndex, code: CryptoHash, key: &PublicKey) {
    let init = env::promise_batch_action_state_init(p, code, VAULT_INIT_DEPOSIT);
    for (k, v) in keys::vault_entries(key) {
        env::set_state_init_data_entry(p, init, &k, &v);
    }
}

impl PrBounty {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
    }

    fn apply_caps(&mut self, max_reward: U128, max_held: U128, max_open_per_buyer: u32) {
        require!(
            max_reward.0 > 0 && max_reward.0 <= HARD_MAX_REWARD.as_yoctonear(),
            "max_reward must be at most 5 NEAR"
        );
        require!(
            max_held.0 >= max_reward.0 && max_held.0 <= HARD_MAX_HELD.as_yoctonear(),
            "max_held must be between max_reward and 10 NEAR"
        );
        require!(
            (1..=HARD_MAX_OPEN_PER_BUYER).contains(&max_open_per_buyer),
            "max_open_per_buyer must be 1 to 5"
        );
        self.max_reward = max_reward.0;
        self.max_held = max_held.0;
        self.max_open_per_buyer = max_open_per_buyer;
        env::log_str(&format!(
            "caps max_reward={} max_held={} max_open_per_buyer={max_open_per_buyer}",
            max_reward.0, max_held.0
        ));
    }

    fn apply_sponsor_limits(&mut self, max_float: U128, max_spent: U128) {
        require!(
            max_float.0 <= HARD_MAX_SPONSOR_FLOAT.as_yoctonear(),
            "max_sponsor_float must be at most 1 NEAR"
        );
        require!(
            max_spent.0 <= HARD_MAX_SPONSOR_SPENT.as_yoctonear(),
            "max_sponsor_spent must be at most 2 NEAR"
        );
        self.max_sponsor_float = max_float.0;
        self.max_sponsor_spent = max_spent.0;
        env::log_str(&format!(
            "sponsor_limits max_float={} max_spent={}",
            max_float.0, max_spent.0
        ));
    }

    /// Pays one sponsored run from the owner's float, within the per-bounty and aggregate caps.
    /// Held is untouched.
    fn charge_sponsor(&mut self, bounty_id: BountyId) {
        let run = RUN_DEPOSIT.as_yoctonear();
        require!(
            self.bounty(bounty_id).sponsored_runs < SPONSORED_RUNS_PER_BOUNTY,
            "this bounty has used its three sponsored checks"
        );
        require!(
            self.sponsor_spent + run <= self.max_sponsor_spent,
            "the sponsor's total spending cap is reached"
        );
        require!(
            self.sponsor_float >= run,
            "the sponsor float cannot pay for this check"
        );
        self.sponsor_float -= run;
        self.sponsor_spent += run;
        self.bounty_mut(bounty_id).sponsored_runs += 1;
    }

    fn storage_cost(&self) -> u128 {
        env::storage_byte_cost()
            .saturating_mul(u128::from(env::storage_usage()))
            .as_yoctonear()
    }

    /// Balance beyond storage, principals still in the contract, and the sponsor float.
    fn free_balance(&self) -> u128 {
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(self.storage_cost())
            .saturating_sub(self.held - self.in_flight)
            .saturating_sub(self.sponsor_float)
    }

    fn bounty(&self, bounty_id: BountyId) -> &Bounty {
        u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get(i))
            .unwrap_or_else(|| env::panic_str("no such bounty"))
    }

    fn bounty_mut(&mut self, bounty_id: BountyId) -> &mut Bounty {
        u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
            .unwrap_or_else(|| env::panic_str("no such bounty"))
    }

    fn next_seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }

    /// Applies a waiting link change that is due, so a later claim or submission sees it.
    fn refresh_link(&mut self, wallet: &AccountId) {
        let due = self
            .links
            .get(wallet)
            .and_then(|w| w.pending.as_ref())
            .map(|p| env::block_timestamp() >= secs_to_nanos(p.activates_at.0))
            .unwrap_or(false);
        if due {
            self.activate(wallet);
        }
    }

    /// Makes the waiting link the wallet's active one. The previous holder of the GitHub id loses
    /// it, and the wallet gives up its own previous GitHub id. Claims and submissions already
    /// accepted keep the ids and keys they pinned.
    fn activate(&mut self, wallet: &AccountId) -> bool {
        let Some(mut state) = self.links.get(wallet).cloned() else {
            return false;
        };
        let Some(pending) = state.pending.take() else {
            return false;
        };
        let github_id = pending.link.github_id.0;
        if let Some(previous) = self.github_owner.get(&github_id).cloned() {
            if &previous != wallet {
                if let Some(mut other) = self.links.get(&previous).cloned() {
                    if other.active.as_ref().map(|a| a.github_id.0) == Some(github_id) {
                        other.active = None;
                    }
                    self.links.insert(previous, other);
                }
            }
        }
        if let Some(own) = &state.active {
            if own.github_id.0 != github_id
                && self.github_owner.get(&own.github_id.0) == Some(wallet)
            {
                self.github_owner.remove(&own.github_id.0);
            }
        }
        state.active = Some(pending.link);
        self.github_owner.insert(github_id, wallet.clone());
        self.links.insert(wallet.clone(), state);
        env::log_str(&format!(
            "link_activated wallet={wallet} github_id={github_id}"
        ));
        true
    }

    /// Records a verified gist. The first link of a wallet and of a GitHub id is immediate; a
    /// change waits for the relink delay and is applied to later submissions only.
    fn apply_link(
        &mut self,
        wallet: &AccountId,
        github_id: u64,
        gist_id: String,
        challenge: String,
        now: u64,
    ) -> String {
        self.used_gists.insert(gist_id.clone());
        let number = self.link_numbers.get(wallet).copied().unwrap_or(0);
        self.link_numbers.insert(wallet.clone(), number + 1);
        let link = Link {
            github_id: U64(github_id),
            gist_id,
            challenge,
            linked_at: U64(now),
        };
        let mut state = self.links.get(wallet).cloned().unwrap_or_default();
        let holder = self.github_owner.get(&github_id).cloned();
        let same = state.active.as_ref().map(|a| a.github_id.0) == Some(github_id);
        let outcome = if same {
            state.active = Some(link);
            "link_refreshed"
        } else if state.active.is_none() && holder.is_none() {
            state.active = Some(link);
            self.github_owner.insert(github_id, wallet.clone());
            "linked"
        } else {
            state.pending = Some(PendingLink {
                link,
                activates_at: U64((now / NANOS_PER_SEC).saturating_add(RELINK_DELAY_SECS)),
            });
            "link_pending"
        };
        self.links.insert(wallet.clone(), state);
        outcome.to_string()
    }

    /// Ends a claim that has no submitted pull request and bars its wallet from the bounty.
    fn end_claim(&mut self, bounty_id: BountyId, how: &str) {
        let now = env::block_timestamp();
        let bounty = self.bounty_mut(bounty_id);
        require!(
            bounty.status == Status::Claimed,
            "this bounty has no claim to end"
        );
        require!(
            bounty.live_run(now).is_none(),
            "a submission is being checked; wait for its result"
        );
        let claim = bounty.claim.take().expect("a claimed bounty has a claim");
        bounty.live = None;
        bounty.status = Status::Open;
        self.barred.insert(keys::bar_key(bounty_id, &claim.wallet));
        log(
            "claim_ended",
            bounty_id,
            &format!("how={how} wallet={}", claim.wallet),
        );
    }

    fn start_check(
        &mut self,
        bounty_id: BountyId,
        kind: RunKind,
        pr_number: u64,
        payer: AccountId,
        sponsored: bool,
        link: Option<(String, String)>,
    ) -> Promise {
        let now = env::block_timestamp();
        let seq = self.next_seq();
        let bounty = self.bounty_mut(bounty_id);
        require!(
            bounty.live_run(now).is_none(),
            "a check is already running for this bounty"
        );
        if let Some(stale) = bounty.live.take() {
            log("check_stale", bounty_id, &format!("seq={}", stale.seq.0));
        }
        bounty.live = Some(LiveRun {
            seq: U64(seq),
            kind,
            requested_at: U64(now),
            pr_number,
            payer: payer.clone(),
            sponsored,
            gist_id: link.as_ref().map(|(gist, _)| gist.clone()),
        });
        let repo = bounty.repo.clone();
        let input = self.input(
            bounty_id,
            seq,
            &repo,
            "pull",
            Some(pr_number),
            link.as_ref().map(|(gist, _)| gist.as_str()),
            link.as_ref().map(|(_, challenge)| challenge.as_str()),
        );
        log(
            "check_requested",
            bounty_id,
            &format!("seq={seq} kind={kind:?} pr={pr_number} payer={payer} sponsored={sponsored}"),
        );
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_CHECK_CALLBACK)
            .with_unused_gas_weight(0)
            .on_check(bounty_id, U64(seq));
        self.run(input, &payer, RUN_DEPOSIT).then(callback)
    }

    fn new_settlement(
        &self,
        kind: SettlementKind,
        key: PublicKey,
        vault: AccountId,
        principal: u128,
    ) -> Settlement {
        Settlement {
            kind,
            key,
            vault,
            principal: U128(principal),
            state: SettlementState::Due,
            attempt: 0,
            sent_at: U64(0),
            outcome: AttemptOutcome::Unknown,
            reconcile: None,
            done_by: None,
        }
    }

    /// The reward to the claimant's vault, sent by a detached self-call so the verdict never
    /// depends on the send.
    fn start_payout(&mut self, bounty_id: BountyId) {
        let bounty = self.bounty(bounty_id).clone();
        let claim = bounty.claim.clone().expect("a paid bounty has a claim");
        let payout = self.new_settlement(
            SettlementKind::Payout,
            claim.key,
            claim.vault,
            bounty.reward.0,
        );
        let b = self.bounty_mut(bounty_id);
        b.status = Status::Paid;
        b.payout = Some(payout);
        self.close_for_buyer(&bounty.buyer);
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_SEND_DUE)
            .with_unused_gas_weight(0)
            .send_due_after_check(bounty_id)
            .detach();
    }

    /// The reward to the maintainer's vault, sent now.
    fn start_refund(&mut self, bounty_id: BountyId, status: Status) {
        let bounty = self.bounty(bounty_id).clone();
        let principal = bounty.reward.0;
        let refund = self.new_settlement(
            SettlementKind::Refund,
            bounty.maintainer_key.clone(),
            bounty.maintainer_vault.clone(),
            principal,
        );
        let b = self.bounty_mut(bounty_id);
        b.status = status;
        b.live = None;
        b.refund = Some(refund);
        self.close_for_buyer(&bounty.buyer);
        log(
            "refund_started",
            bounty_id,
            &format!("status={status:?} principal={principal}"),
        );
        self.send_affordable(bounty_id);
    }

    fn close_for_buyer(&mut self, buyer: &AccountId) {
        let open = self.open_by_buyer.get(buyer).copied().unwrap_or(0);
        self.open_by_buyer
            .insert(buyer.clone(), open.saturating_sub(1));
    }

    #[allow(clippy::too_many_arguments)]
    fn input(
        &self,
        bounty_id: BountyId,
        seq: u64,
        repo: &str,
        op: &'static str,
        number: Option<u64>,
        gist_id: Option<&str>,
        challenge: Option<&str>,
    ) -> String {
        let contract = env::current_account_id();
        serde_json::to_string(&RunInput {
            v: 4,
            network: &self.network,
            contract: &contract,
            bounty: bounty_id,
            seq,
            op,
            repo,
            number,
            gist_id,
            challenge,
        })
        .expect("serializable")
    }

    /// One OutLayer run of the pinned verifier. Unused compute and a refused admission's deposit
    /// go to `payer` (the caller, or the owner's sponsor account for a sponsored run).
    fn run(&self, input: String, payer: &AccountId, deposit: NearToken) -> Promise {
        let args = RunArgs {
            source: Source {
                wasm_url: WasmUrl {
                    url: &self.verifier_url,
                    hash: &self.verifier_hash,
                    build_target: BUILD_TARGET,
                },
            },
            resource_limits: Limits {
                max_instructions: RUN_MAX_INSTRUCTIONS,
                max_memory_mb: RUN_MAX_MEMORY_MB,
                max_execution_seconds: RUN_MAX_SECONDS,
            },
            input_data: input,
            response_format: "Json",
            payer_account_id: payer,
        };
        Promise::new(self.outlayer.clone())
            .refund_to(payer.clone())
            .function_call_weight(
                "request_execution".to_string(),
                serde_json::to_vec(&args).expect("serializable"),
                deposit,
                GAS_FOR_OUTLAYER,
                GasWeight(1),
            )
    }

    /// Sends each due settlement of the bounty that the contract's balance can pay for, after
    /// storage, the principals still owed in the contract and the sponsor float. Returns how many
    /// were sent. A settlement that cannot be paid for stays due.
    fn send_affordable(&mut self, bounty_id: BountyId) -> u32 {
        let mut sent = 0;
        for kind in [SettlementKind::Payout, SettlementKind::Refund] {
            let due = self
                .bounty(bounty_id)
                .settlement(kind)
                .is_some_and(|s| s.state == SettlementState::Due);
            if !due {
                continue;
            }
            let fee = DEPOSIT_FEE.as_yoctonear() + VAULT_INIT_DEPOSIT.as_yoctonear();
            let gas_left = env::prepaid_gas().saturating_sub(env::used_gas());
            if self.free_balance() < fee || gas_left < GAS_PER_SEND {
                log(
                    "settlement_waiting",
                    bounty_id,
                    &format!(
                        "kind={kind:?} reason={}",
                        if gas_left < GAS_PER_SEND {
                            "gas"
                        } else {
                            "balance"
                        }
                    ),
                );
                continue;
            }
            self.send(bounty_id, kind);
            sent += 1;
        }
        sent
    }

    /// One attempt: StateInit + deposit to the vault, then the two callbacks.
    fn send(&mut self, bounty_id: BountyId, kind: SettlementKind) {
        let now = env::block_timestamp();
        let code = self.vault_code;
        #[cfg(feature = "test-faults")]
        let issue = self.bounty(bounty_id).issue;
        let s = self
            .bounty_mut(bounty_id)
            .settlement_mut(kind)
            .expect("checked by the caller");
        s.state = SettlementState::InFlight;
        s.attempt += 1;
        s.sent_at = U64(now);
        s.outcome = AttemptOutcome::Unknown;
        s.reconcile = None;
        let (key, vault, principal, attempt) =
            (s.key.clone(), s.vault.clone(), s.principal.0, s.attempt);
        self.in_flight += principal;
        log(
            "settlement_sent",
            bounty_id,
            &format!("kind={kind:?} attempt={attempt} vault={vault} principal={principal}"),
        );
        let me = env::current_account_id();
        let zero = NearToken::from_yoctonear(0);
        #[allow(unused_mut)]
        let mut method = "deposit";
        #[cfg(feature = "test-faults")]
        if ((faults::FAILED_FIRST_SEND_FROM_ISSUE..faults::LOST_CALLBACKS_FROM_ISSUE)
            .contains(&issue)
            || (faults::FAILED_FIRST_DEPOSIT_FROM_ISSUE..faults::DELAYED_DEPOSIT_ISSUE)
                .contains(&issue))
            && attempt == 1
        {
            method = "no_such_method";
        }
        #[cfg(not(feature = "test-faults"))]
        let p = env::promise_batch_create(&vault);
        #[cfg(feature = "test-faults")]
        let p = if issue == faults::DELAYED_DEPOSIT_ISSUE && attempt == 1 {
            let hop = Gas::from_tgas(2);
            let mut h = env::promise_create(me.clone(), "hop", b"{}", zero, hop);
            for _ in 1..faults::DELAY_HOPS {
                h = env::promise_then(h, me.clone(), "hop", b"{}", zero, hop);
            }
            env::promise_batch_then(h, &vault)
        } else {
            env::promise_batch_create(&vault)
        };
        init_vault(p, code, &key);
        let mut args = slot_args(bounty_id, kind, attempt);
        args.extend(principal.to_le_bytes());
        env::promise_batch_action_function_call(
            p,
            method,
            &args,
            NearToken::from_yoctonear(principal).saturating_add(DEPOSIT_FEE),
            GAS_FOR_DEPOSIT,
        );
        let a = serde_json::to_vec(&AttemptArgs {
            bounty_id,
            kind,
            attempt,
        })
        .expect("serializable");
        env::promise_then(
            p,
            me.clone(),
            "on_settle",
            &a,
            zero,
            GAS_FOR_SETTLE_CALLBACK,
        );
        env::promise_then(p, me, "on_settle_outcome", &a, zero, GAS_FOR_SETTLE_OUTCOME);
    }

    /// One attempt's result, if that attempt is still in flight: success releases the principal
    /// from `held` once; failure makes the settlement due again, still reserved.
    fn finish(
        &mut self,
        bounty_id: BountyId,
        kind: SettlementKind,
        attempt: u32,
        ok: bool,
        by: &str,
    ) -> bool {
        let Some(s) = u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
            .and_then(|b| b.settlement_mut(kind))
        else {
            return false;
        };
        if s.state != SettlementState::InFlight || s.attempt != attempt {
            return false;
        }
        let principal = s.principal.0;
        s.outcome = if ok {
            AttemptOutcome::Succeeded
        } else {
            AttemptOutcome::Failed
        };
        s.reconcile = None;
        if ok {
            s.state = SettlementState::Done;
            s.done_by = Some(by.to_string());
        } else {
            s.state = SettlementState::Due;
        }
        self.in_flight -= principal;
        if ok {
            self.held -= principal;
        }
        log(
            "settlement_finished",
            bounty_id,
            &format!("kind={kind:?} attempt={attempt} ok={ok} by={by}"),
        );
        true
    }
}

fn show(id: Option<u64>) -> String {
    id.map_or_else(|| "none".to_string(), |id| id.to_string())
}

fn is_gist_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_repo(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    let owner_ok = (1..=39).contains(&owner.len())
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !owner.starts_with('-');
    let name_ok = (1..=100).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && name != "."
        && name != "..";
    owner_ok && name_ok
}

#[cfg(test)]
mod tests;
