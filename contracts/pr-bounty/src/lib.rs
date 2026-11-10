//! Proven PR merge bounties: automatic payout after an attested GitHub merge check, settled into
//! NEP-616 vaults that only the recipient's keys can open.
//!
//! A maintainer posts a bounty for one issue of the pilot repository, fixed at deployment, and one
//! contributor, and locks a NEAR reward plus a 0.03 NEAR merge-check budget. The contributor proves
//! control of their GitHub account with a gist they own carrying an expiring challenge. Both
//! parties also prove control of two keys, a primary and a backup, with NEP-413 signatures. Those
//! key pairs, not account names, receive the money: every payout and refund goes into the vault
//! derived from the pinned vault code and the recipient's key pair, and either key can withdraw it
//! from there.
//!
//! The maintainer nominates the pull request, which is bound by id only if GitHub shows it open,
//! unmerged, on the agreed branch and by the contributor. A merge check that finds that pull
//! request merged before the deadline pays the reward to the contributor's vault and returns the
//! full budget to the maintainer's vault. Otherwise the bounty refunds reward and budget to the
//! maintainer's vault once its window ends.
//!
//! Every GitHub fact comes from Proven's PR bounty verifier, pinned by its WASM URL and SHA-256,
//! run on OutLayer and returned to this contract's own private callbacks. Merge checks that the
//! contributor starts without paying are sponsored by the owner's capped float; OutLayer returns
//! their unused compute to the owner's sponsor account. The rules are in `docs/pr-bounties.md`.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128, U64};
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
pub use keys::{KeyPair, PostTerms, PostingProof, Signing};

pub type BountyId = u64;

/// What every OutLayer run attaches, above OutLayer's 0.0040005 NEAR admission estimate.
pub const RUN_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// The maintainer's merge-check budget. It is never spent (sponsored runs use the owner's float)
/// and always returns in full to the maintainer's vault.
pub const BUDGET: NearToken = NearToken::from_millinear(30);
/// Sponsored merge checks one bounty may use.
pub const SPONSORED_RUNS_PER_BOUNTY: u32 = 3;
/// Pays for the bounty record, its entries and its settlement fees. Provisional (OD-5): the
/// sandbox measures the worst case before review.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
pub const CHALLENGE_TTL_SECS: u64 = 60 * 60;
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

/// Recovery delays (OD-1, OD-2) and the overlap guard. Test builds shorten them.
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
/// shortfall and returns the rest here. Provisional (OD-5).
pub const DEPOSIT_FEE: NearToken = NearToken::from_millinear(6);
/// What a reconciler attaches; the vault keeps the storage its seal needs and returns the rest
/// to the reconciler.
pub const RECONCILE_DEPOSIT: NearToken = NearToken::from_millinear(10);

const NANOS_PER_SEC: u64 = 1_000_000_000;
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(150);
const GAS_FOR_CLAIM_CALLBACK: Gas = Gas::from_tgas(30);
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
const RUN_MAX_SECONDS: u32 = 30;
const BUILD_TARGET: &str = "wasm32-wasip2";
const MAX_URL_LEN: usize = 256;
const MAX_REF_LEN: usize = 255;
const SLOT_LEN: usize = 25;
pub const CHALLENGE_PREFIX: &str = "proven-claim:";

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
    Nominate,
    Merge,
}

/// The vault's record kind byte: payout 0, budget return 1, refund 2.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementKind {
    Payout,
    BudgetReturn,
    Refund,
}

impl SettlementKind {
    pub fn byte(self) -> u8 {
        match self {
            SettlementKind::Payout => 0,
            SettlementKind::BudgetReturn => 1,
            SettlementKind::Refund => 2,
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
    /// Confirmed in the vault.
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

/// One payout, budget return or refund into one vault. Its keys, vault and principal never
/// change; the principal stays in `held` until a deposit of exactly it is confirmed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub kind: SettlementKind,
    pub keys: KeyPair,
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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub wallet: AccountId,
    pub github_id: U64,
    pub gist_id: String,
    pub claimed_at: U64,
    pub request_id: U64,
    pub keys: KeyPair,
    pub vault: AccountId,
}

/// Written by `prove_claim` into its own `on_claim` callback; never stored.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PendingClaim {
    pub seq: U64,
    pub wallet: AccountId,
    pub gist_id: String,
    pub requested_at: U64,
    pub expires_at: U64,
    pub keys: KeyPair,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub pr_number: u64,
    pub pr_id: U64,
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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bounty {
    pub buyer: AccountId,
    pub reward: U128,
    /// Always the full 0.03 NEAR: sponsored runs never spend it.
    pub budget: U128,
    pub sponsored_runs: u32,
    pub repo: String,
    pub repo_id: U64,
    pub issue: u64,
    pub base_ref: String,
    pub contributor_github_id: U64,
    pub posted_at: U64,
    pub claim_by: U64,
    pub bind_by: U64,
    pub merge_deadline: U64,
    pub grace_secs: U64,
    pub status: Status,
    pub maintainer_keys: KeyPair,
    pub maintainer_vault: AccountId,
    pub posting_nonce: String,
    pub claim: Option<Claim>,
    pub binding: Option<Binding>,
    pub merge: Option<MergeRecord>,
    pub live: Option<LiveRun>,
    pub last_check: Option<CheckRecord>,
    pub payout: Option<Settlement>,
    pub budget_return: Option<Settlement>,
    pub refund: Option<Settlement>,
}

impl Bounty {
    fn verify_until_nanos(&self) -> u64 {
        self.merge_deadline
            .0
            .saturating_add(self.grace_secs.0)
            .saturating_mul(NANOS_PER_SEC)
    }

    fn live_run(&self, now: u64) -> Option<&LiveRun> {
        self.live
            .as_ref()
            .filter(|run| now.saturating_sub(run.requested_at.0) <= RUN_TIMEOUT_NANOS)
    }

    fn settlement(&self, kind: SettlementKind) -> Option<&Settlement> {
        match kind {
            SettlementKind::Payout => self.payout.as_ref(),
            SettlementKind::BudgetReturn => self.budget_return.as_ref(),
            SettlementKind::Refund => self.refund.as_ref(),
        }
    }

    fn settlement_mut(&mut self, kind: SettlementKind) -> Option<&mut Settlement> {
        match kind {
            SettlementKind::Payout => self.payout.as_mut(),
            SettlementKind::BudgetReturn => self.budget_return.as_mut(),
            SettlementKind::Refund => self.refund.as_mut(),
        }
    }

    fn is_party(&self, account: &AccountId) -> bool {
        &self.buyer == account || self.claim.as_ref().map(|c| &c.wallet) == Some(account)
    }
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
    pub budget: U128,
    pub sponsored_runs_per_bounty: u32,
    pub storage_deposit: U128,
    pub deposit_fee: U128,
    pub reconcile_deposit: U128,
    pub party_reconcile_delay_secs: u64,
    pub open_reconcile_delay_secs: u64,
    pub reconcile_marker_ttl_secs: u64,
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
    /// Every reward and budget not yet confirmed in a vault.
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

    /// Posts a bounty. Attach exactly `reward` + 0.03 NEAR budget + 0.02 NEAR storage. Both of the
    /// maintainer's keys sign the posting's terms digest and a fresh nonce (NEP-413).
    #[payable]
    pub fn post_bounty(
        &mut self,
        terms: PostTerms,
        keys: KeyPair,
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
        let budget = BUDGET.as_yoctonear();
        let total = reward + budget;
        require!(
            env::attached_deposit().as_yoctonear() == total + STORAGE_DEPOSIT.as_yoctonear(),
            "attach exactly the reward plus 0.03 NEAR for merge checks and 0.02 NEAR for storage"
        );
        require!(
            self.held + total <= self.max_held,
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
        require!(
            terms.issue > 0 && terms.contributor_github_id.0 > 0,
            "ids are required"
        );
        require!(
            !terms.base_ref.is_empty()
                && terms.base_ref.len() <= MAX_REF_LEN
                && !terms.base_ref.chars().any(char::is_control),
            "base_ref must be a branch name"
        );
        let now = env::block_timestamp();
        require!(
            now < secs_to_nanos(terms.claim_by.0)
                && terms.claim_by.0 <= terms.bind_by.0
                && terms.bind_by.0 <= terms.merge_deadline.0,
            "times must satisfy now < claim_by <= bind_by <= merge_deadline"
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
        // The two key proofs, all before any state change.
        keys::check_pair(&keys);
        keys::check_expiry(proof.expires_at.0);
        let nonce = keys::parse_nonce(&proof.nonce);
        let nonce_key = keys::nonce_key(&buyer, &nonce);
        require!(
            !self.used_nonces.contains(&nonce_key),
            "this posting nonce has already been used"
        );
        let contract = env::current_account_id();
        let (network, maintainer) = (self.network.clone(), buyer.to_string());
        keys::verify_pair(
            &keys,
            &proof.primary_signature,
            &proof.backup_signature,
            contract.as_str(),
            |signing| {
                keys::posting_message(
                    &network,
                    contract.as_str(),
                    &maintainer,
                    &nonce,
                    &terms,
                    &keys,
                    proof.expires_at.0,
                    signing,
                )
            },
        );
        // Accepted: consume the nonce, record the bounty and reserve reward and budget.
        self.used_nonces.insert(nonce_key);
        self.held += total;
        self.open_by_buyer.insert(buyer.clone(), open + 1);
        let id = u64::from(self.bounties.len());
        let vault = keys::vault_of(self.vault_code, &keys);
        self.bounties.push(Bounty {
            buyer,
            reward: terms.reward,
            budget: U128(budget),
            sponsored_runs: 0,
            repo: terms.repo,
            repo_id: terms.repo_id,
            issue: terms.issue,
            base_ref: terms.base_ref,
            contributor_github_id: terms.contributor_github_id,
            posted_at: U64(now),
            claim_by: terms.claim_by,
            bind_by: terms.bind_by,
            merge_deadline: terms.merge_deadline,
            grace_secs: terms.grace_secs,
            status: Status::Open,
            maintainer_keys: keys,
            maintainer_vault: vault.clone(),
            posting_nonce: proof.nonce,
            claim: None,
            binding: None,
            merge: None,
            live: None,
            last_check: None,
            payout: None,
            budget_return: None,
            refund: None,
        });
        log(
            "bounty_posted",
            id,
            &format!("reward={reward} maintainer_vault={vault}"),
        );
        id
    }

    /// Withdraws a bounty nobody has claimed; reward and budget go to the maintainer's vault.
    pub fn cancel(&mut self, bounty_id: BountyId) {
        let bounty = self.bounty(bounty_id);
        require!(
            env::predecessor_account_id() == bounty.buyer,
            "only the maintainer can cancel"
        );
        require!(
            bounty.status == Status::Open,
            "only an unclaimed bounty can be cancelled"
        );
        self.start_refund(bounty_id, Status::Cancelled);
    }

    // ---- Contributor: claim ----

    /// The text the contributor puts, alone, as the only file of a gist on their GitHub account.
    /// It names this network, contract, bounty, repository, issue, wallet, GitHub id, expiry and
    /// the ordered key pair that will receive the payout.
    pub fn claim_challenge(
        &self,
        bounty_id: BountyId,
        wallet: AccountId,
        expires_at: U64,
        primary: PublicKey,
        backup: PublicKey,
    ) -> String {
        let keys = KeyPair { primary, backup };
        keys::check_pair(&keys);
        self.challenge(
            bounty_id,
            self.bounty(bounty_id),
            &wallet,
            expires_at.0,
            &keys,
        )
    }

    /// Starts the claim proof for the calling wallet. Both keys sign the claim intent; the gist
    /// must carry the challenge that names this wallet and key pair. Attach exactly 0.01 NEAR.
    #[payable]
    pub fn prove_claim(
        &mut self,
        bounty_id: BountyId,
        gist_id: String,
        expires_at: U64,
        keys: KeyPair,
        primary_signature: Base64VecU8,
        backup_signature: Base64VecU8,
    ) -> Promise {
        let wallet = env::predecessor_account_id();
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
            is_gist_id(&gist_id),
            "gist_id must be the gist's lowercase hex id"
        );
        let bounty = self.bounty(bounty_id).clone();
        require!(
            bounty.status == Status::Open,
            "this bounty is not open to claims"
        );
        require!(
            now < secs_to_nanos(bounty.claim_by.0),
            "the claim window has ended"
        );
        keys::check_expiry(expires_at.0);
        let contract = env::current_account_id();
        let network = self.network.clone();
        keys::verify_pair(
            &keys,
            &primary_signature,
            &backup_signature,
            contract.as_str(),
            |signing| {
                keys::claim_message(
                    &network,
                    contract.as_str(),
                    wallet.as_str(),
                    bounty_id,
                    bounty.contributor_github_id.0,
                    &keys,
                    expires_at.0,
                    signing,
                )
            },
        );
        let challenge = self.challenge(bounty_id, &bounty, &wallet, expires_at.0, &keys);
        let seq = self.next_seq();
        let input = self.input(
            bounty_id,
            seq,
            &bounty.repo,
            "gist",
            None,
            Some(&gist_id),
            Some(&challenge),
        );
        log(
            "claim_requested",
            bounty_id,
            &format!("seq={seq} wallet={wallet} gist={gist_id}"),
        );
        let pending = PendingClaim {
            seq: U64(seq),
            wallet: wallet.clone(),
            gist_id,
            requested_at: U64(now),
            expires_at,
            keys,
        };
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_CLAIM_CALLBACK)
            .with_unused_gas_weight(0)
            .on_claim(bounty_id, pending);
        self.run(input, &wallet, RUN_DEPOSIT).then(callback)
    }

    /// The result of one claim proof; applied only to that exact pending claim, while the
    /// bounty is still open and within the run timeout.
    #[private]
    pub fn on_claim(&mut self, bounty_id: BountyId, pending: PendingClaim) -> String {
        let result = env::promise_result_checked(0, answer::MAX_OUTPUT_BYTES);
        let now = env::block_timestamp();
        let (network, contract) = (self.network.clone(), env::current_account_id());
        let vault = keys::vault_of(self.vault_code, &pending.keys);
        let Some(bounty) = u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
        else {
            return "ignored:no_bounty".to_string();
        };
        let mut request_id = None;
        let outcome = if bounty.status != Status::Open {
            "ignored:not_open".to_string()
        } else if now.saturating_sub(pending.requested_at.0) > RUN_TIMEOUT_NANOS {
            "no_result:stale".to_string()
        } else {
            match parse(
                &result,
                &network,
                &contract,
                bounty_id,
                pending.seq.0,
                &bounty.repo,
                Parsed::Gist(&pending.gist_id),
            ) {
                Err(reason) => reason,
                Ok(answer) => {
                    request_id = Some(answer.request_id);
                    let facts = answer.gist.expect("parse returns the asked operation");
                    let mismatch = if facts.owner_id != bounty.contributor_github_id.0 {
                        Some("owner_id")
                    } else if facts.files != 1 {
                        Some("ambiguous")
                    } else if !facts.challenge_matches {
                        Some("challenge")
                    } else {
                        None
                    };
                    match mismatch {
                        Some(field) => format!("mismatch:{field}"),
                        None => {
                            bounty.claim = Some(Claim {
                                wallet: pending.wallet.clone(),
                                github_id: bounty.contributor_github_id,
                                gist_id: pending.gist_id.clone(),
                                claimed_at: U64(now),
                                request_id: U64(answer.request_id),
                                keys: pending.keys.clone(),
                                vault: vault.clone(),
                            });
                            bounty.status = Status::Claimed;
                            "claimed".to_string()
                        }
                    }
                }
            }
        };
        if !outcome.starts_with("ignored") {
            bounty.last_check = Some(CheckRecord {
                seq: pending.seq,
                kind: "claim".to_string(),
                request_id: request_id.map(U64),
                resolved_at: U64(now),
                outcome: outcome.clone(),
            });
        }
        log(
            "claim_resolved",
            bounty_id,
            &format!(
                "seq={} wallet={} outcome={outcome} request_id={}",
                pending.seq.0,
                pending.wallet,
                show(request_id)
            ),
        );
        outcome
    }

    // ---- Maintainer: nominate the pull request ----

    #[payable]
    pub fn nominate(&mut self, bounty_id: BountyId, pr_number: u64) -> Promise {
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
        let bounty = self.bounty(bounty_id);
        require!(caller == bounty.buyer, "only the maintainer can nominate");
        require!(
            bounty.status == Status::Claimed,
            "the bounty must be claimed and not yet bound"
        );
        require!(
            now < secs_to_nanos(bounty.bind_by.0),
            "the nomination window has ended"
        );
        self.start_check(bounty_id, RunKind::Nominate, pr_number, caller, false)
    }

    // ---- Anyone: check the merge ----

    /// Checks the bound pull request. Attach exactly 0.01 NEAR to pay for the check yourself. The
    /// contributor's wallet may instead attach nothing for a check sponsored by the owner's float,
    /// up to three times per bounty while the float and its caps allow.
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
            "the bounty has no bound pull request to check"
        );
        require!(
            now < bounty.verify_until_nanos(),
            "the verification window has ended"
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
            let wallet = bounty.claim.as_ref().map(|c| &c.wallet);
            require!(
                wallet == Some(&caller),
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
        )
    }

    /// The result of a nomination or merge check. Only the live run's result counts.
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
            RunKind::Nominate => "nominate",
            RunKind::Merge => "merge",
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
                Parsed::pull(live.pr_number),
            ) {
                Err(reason) => reason,
                Ok(answer) => {
                    request_id = Some(answer.request_id);
                    let facts = answer.pull.expect("parse returns the asked operation");
                    match live.kind {
                        RunKind::Nominate => {
                            let claimed = bounty.claim.as_ref().map(|c| c.github_id.0);
                            let mismatch = if facts.repo_id != bounty.repo_id.0 {
                                Some("repo_id")
                            } else if facts.pr_number != live.pr_number {
                                Some("pr_number")
                            } else if facts.base_ref != bounty.base_ref {
                                Some("base_ref")
                            } else if Some(facts.author_id) != claimed {
                                Some("author_id")
                            } else if facts.merged || facts.state != "open" {
                                Some("not_open")
                            } else if self.used_prs.contains_key(&facts.pr_id) {
                                Some("pr_already_bound")
                            } else {
                                None
                            };
                            match mismatch {
                                Some(field) => format!("mismatch:{field}"),
                                None => {
                                    self.used_prs.insert(facts.pr_id, bounty_id);
                                    bounty.binding = Some(Binding {
                                        pr_number: facts.pr_number,
                                        pr_id: U64(facts.pr_id),
                                        bound_at: live.requested_at,
                                        request_id: U64(answer.request_id),
                                    });
                                    bounty.status = Status::Bound;
                                    "bound".to_string()
                                }
                            }
                        }
                        RunKind::Merge => {
                            let binding =
                                bounty.binding.clone().expect("a merge check has a binding");
                            let github_id = bounty.claim.as_ref().map(|c| c.github_id.0);
                            let bound_secs = binding.bound_at.0 / NANOS_PER_SEC;
                            if facts.repo_id != bounty.repo_id.0
                                || facts.pr_id != binding.pr_id.0
                                || facts.pr_number != binding.pr_number
                                || Some(facts.author_id) != github_id
                            {
                                "no_result:inconsistent".to_string()
                            } else {
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
                                    Some(_) if bounty.claim.is_none() => {
                                        "no_result:no_key_pair".to_string()
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

    /// Refunds the maintainer's vault once the bounty can no longer pay.
    pub fn settle(&mut self, bounty_id: BountyId) {
        let now = env::block_timestamp();
        let bounty = self.bounty(bounty_id);
        let idle = bounty.live_run(now).is_none();
        let due = match bounty.status {
            Status::Open => {
                now >= secs_to_nanos(bounty.claim_by.0).saturating_add(RUN_TIMEOUT_NANOS)
            }
            Status::Claimed => idle && now >= secs_to_nanos(bounty.bind_by.0),
            Status::Bound => idle && now >= bounty.verify_until_nanos(),
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
        let (keys, vault) = (s.keys.clone(), s.vault.clone());
        log(
            "reconcile_started",
            bounty_id,
            &format!("kind={kind:?} attempt={attempt} caller={caller} party={party}"),
        );
        let p = env::promise_batch_create(&vault);
        init_vault(p, code, &keys);
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
            budget: U128(BUDGET.as_yoctonear()),
            sponsored_runs_per_bounty: SPONSORED_RUNS_PER_BOUNTY,
            storage_deposit: U128(STORAGE_DEPOSIT.as_yoctonear()),
            deposit_fee: U128(DEPOSIT_FEE.as_yoctonear()),
            reconcile_deposit: U128(RECONCILE_DEPOSIT.as_yoctonear()),
            party_reconcile_delay_secs: PARTY_RECONCILE_DELAY_NANOS / NANOS_PER_SEC,
            open_reconcile_delay_secs: OPEN_RECONCILE_DELAY_NANOS / NANOS_PER_SEC,
            reconcile_marker_ttl_secs: RECONCILE_MARKER_TTL_NANOS / NANOS_PER_SEC,
        }
    }

    pub fn is_poster(&self, account: AccountId) -> bool {
        self.posters.contains(&account)
    }

    pub fn bound_pr(&self, pr_id: U64) -> Option<BountyId> {
        self.used_prs.get(&pr_id.0).copied()
    }

    pub fn vault_of(&self, primary: PublicKey, backup: PublicKey) -> AccountId {
        let keys = KeyPair { primary, backup };
        keys::check_pair(&keys);
        keys::vault_of(self.vault_code, &keys)
    }

    pub fn is_nonce_used(&self, maintainer: AccountId, nonce: String) -> bool {
        self.used_nonces
            .contains(&keys::nonce_key(&maintainer, &keys::parse_nonce(&nonce)))
    }

    pub fn posting_terms_digest(
        &self,
        terms: PostTerms,
        keys: KeyPair,
        maintainer: AccountId,
        nonce: String,
    ) -> String {
        keys::terms_digest(
            &self.network,
            env::current_account_id().as_str(),
            maintainer.as_str(),
            &keys::parse_nonce(&nonce),
            &terms,
            &keys,
        )
    }

    /// The exact text each maintainer key signs for a posting; `signing` is `primary` or `backup`.
    pub fn posting_key_message(
        &self,
        terms: PostTerms,
        keys: KeyPair,
        maintainer: AccountId,
        nonce: String,
        expires_at: U64,
        signing: String,
    ) -> String {
        keys::posting_message(
            &self.network,
            env::current_account_id().as_str(),
            maintainer.as_str(),
            &keys::parse_nonce(&nonce),
            &terms,
            &keys,
            expires_at.0,
            signing_of(&signing),
        )
    }

    /// The exact text each contributor key signs for a claim.
    pub fn claim_key_message(
        &self,
        bounty_id: BountyId,
        wallet: AccountId,
        expires_at: U64,
        keys: KeyPair,
        signing: String,
    ) -> String {
        keys::claim_message(
            &self.network,
            env::current_account_id().as_str(),
            wallet.as_str(),
            bounty_id,
            self.bounty(bounty_id).contributor_github_id.0,
            &keys,
            expires_at.0,
            signing_of(&signing),
        )
    }

    /// The balance beyond storage, the reserved principals still in the contract and the
    /// sponsor float: what pays settlement fees.
    pub fn get_free_balance(&self) -> U128 {
        U128(self.free_balance())
    }
}

fn signing_of(signing: &str) -> Signing {
    match signing {
        "primary" => Signing::Primary,
        "backup" => Signing::Backup,
        _ => env::panic_str("signing must be primary or backup"),
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

/// Appends the vault's NEP-616 state init (code by hash, the key pair's initial state).
fn init_vault(p: PromiseIndex, code: CryptoHash, keys: &KeyPair) {
    let init = env::promise_batch_action_state_init(p, code, VAULT_INIT_DEPOSIT);
    for (k, v) in keys::vault_entries(keys) {
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
    /// Held and the bounty's budget are untouched (OD-9 variant B).
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

    /// Challenge v3 for this contract and bounty (see `keys::challenge`).
    fn challenge(
        &self,
        bounty_id: BountyId,
        bounty: &Bounty,
        wallet: &AccountId,
        expires_at: u64,
        keys: &KeyPair,
    ) -> String {
        keys::challenge(
            &keys::ClaimBinding {
                network: &self.network,
                contract: env::current_account_id().as_str(),
                bounty: bounty_id,
                repo: &bounty.repo,
                repo_id: bounty.repo_id.0,
                issue: bounty.issue,
                wallet: wallet.as_str(),
                github_id: bounty.contributor_github_id.0,
                expires_at,
            },
            keys,
        )
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
            v: 3,
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

    fn start_check(
        &mut self,
        bounty_id: BountyId,
        kind: RunKind,
        pr_number: u64,
        payer: AccountId,
        sponsored: bool,
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
        });
        let repo = bounty.repo.clone();
        let input = self.input(bounty_id, seq, &repo, "pull", Some(pr_number), None, None);
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
        keys: KeyPair,
        vault: AccountId,
        principal: u128,
    ) -> Settlement {
        Settlement {
            kind,
            keys,
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

    /// The reward to the contributor's vault and the full budget to the maintainer's vault, sent
    /// by a detached self-call so the verdict never depends on the sends.
    fn start_payout(&mut self, bounty_id: BountyId) {
        let bounty = self.bounty(bounty_id).clone();
        let claim = bounty.claim.clone().expect("a paid bounty has a claim");
        let payout = self.new_settlement(
            SettlementKind::Payout,
            claim.keys,
            claim.vault,
            bounty.reward.0,
        );
        let budget = self.new_settlement(
            SettlementKind::BudgetReturn,
            bounty.maintainer_keys.clone(),
            bounty.maintainer_vault.clone(),
            bounty.budget.0,
        );
        let b = self.bounty_mut(bounty_id);
        b.status = Status::Paid;
        b.payout = Some(payout);
        b.budget_return = Some(budget);
        self.close_for_buyer(&bounty.buyer);
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_SEND_DUE)
            .with_unused_gas_weight(0)
            .send_due_after_check(bounty_id)
            .detach();
    }

    /// Reward plus the full budget to the maintainer's vault, sent now.
    fn start_refund(&mut self, bounty_id: BountyId, status: Status) {
        let bounty = self.bounty(bounty_id).clone();
        let principal = bounty.reward.0 + bounty.budget.0;
        let refund = self.new_settlement(
            SettlementKind::Refund,
            bounty.maintainer_keys.clone(),
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

    /// Sends each due settlement of the bounty that the contract's balance can pay for, after
    /// storage, the principals still owed in the contract and the sponsor float. Returns how many
    /// were sent. A settlement that cannot be paid for stays due.
    fn send_affordable(&mut self, bounty_id: BountyId) -> u32 {
        let mut sent = 0;
        for kind in [
            SettlementKind::Payout,
            SettlementKind::BudgetReturn,
            SettlementKind::Refund,
        ] {
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
        let (keys, vault, principal, attempt) =
            (s.keys.clone(), s.vault.clone(), s.principal.0, s.attempt);
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
        if (faults::FAILED_FIRST_DEPOSIT_FROM_ISSUE..faults::DELAYED_DEPOSIT_ISSUE).contains(&issue)
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
        init_vault(p, code, &keys);
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
