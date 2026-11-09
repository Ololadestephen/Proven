//! Proven PR merge bounties: automatic payout after an attested GitHub merge check.
//!
//! A maintainer posts a bounty for one issue of one public repository and one contributor, and
//! locks a NEAR reward. The contributor proves control of their GitHub account with a one-time
//! challenge comment, which fixes the payout wallet. The maintainer nominates the pull request,
//! which is bound by id only if GitHub shows it open, unmerged, on the agreed branch and by the
//! contributor. A merge check that finds that pull request merged before the deadline pays the
//! reward to the recorded wallet in the same callback. Otherwise the bounty refunds the maintainer
//! once its window ends.
//!
//! Every GitHub fact comes from Proven's PR bounty verifier, pinned by its WASM URL and SHA-256,
//! run on OutLayer and returned to this contract's own private callbacks. The rules are in
//! `docs/pr-bounties.md`; this file follows them.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
};

mod answer;
use answer::{parse, Parsed};

pub type BountyId = u64;

/// What every OutLayer run attaches, above OutLayer's 0.0040005 NEAR admission estimate for the
/// limits below. OutLayer returns what it does not charge to the run's payer.
pub const RUN_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Merge checks the contributor may start from the bounty's own budget.
pub const BUDGET_RUNS: u32 = 3;
/// Pays for the bounty record and its used-pull-request entry, both kept as evidence.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
pub const CHALLENGE_TTL_SECS: u64 = 60 * 60;
/// A run whose result has not landed after this long is stale: its late result changes nothing.
pub const RUN_TIMEOUT_NANOS: u64 = 15 * 60 * NANOS_PER_SEC;
/// How far a merge time may sit before the binding run's block time before the answer is treated
/// as contradicting the attested "open and unmerged" observation.
pub const MAX_CLOCK_SKEW_SECS: u64 = 60;
pub const MIN_GRACE_SECS: u64 = 10 * 60;
pub const MAX_GRACE_SECS: u64 = 24 * 60 * 60;
pub const MAX_DURATION_SECS: u64 = 30 * 24 * 60 * 60;
pub const HARD_MAX_REWARD: NearToken = NearToken::from_near(5);
pub const HARD_MAX_HELD: NearToken = NearToken::from_near(10);
pub const HARD_MAX_OPEN_PER_BUYER: u32 = 5;
const NANOS_PER_SEC: u64 = 1_000_000_000;
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(150);
const GAS_FOR_CLAIM_CALLBACK: Gas = Gas::from_tgas(30);
/// Enough to read the answer and, when it pays, start two transfers with their callbacks.
const GAS_FOR_CHECK_CALLBACK: Gas = Gas::from_tgas(60);
const GAS_FOR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_CANCEL: Gas = Gas::from_tgas(50);
pub const MIN_PREPAID_GAS_FOR_RUN: Gas = Gas::from_tgas(250);
const RUN_MAX_INSTRUCTIONS: u64 = 5_000_000_000;
const RUN_MAX_MEMORY_MB: u32 = 128;
const RUN_MAX_SECONDS: u32 = 30;
const BUILD_TARGET: &str = "wasm32-wasip2";
const MAX_URL_LEN: usize = 256;
const MAX_REF_LEN: usize = 255;
pub const CHALLENGE_PREFIX: &str = "proven-claim:";

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Posted, nobody has proved a claim.
    Open,
    /// The contributor's wallet and GitHub id are fixed; no pull request is bound yet.
    Claimed,
    /// A pull request is bound; merge checks may run.
    Bound,
    /// The reward was released to the contributor.
    Paid,
    /// The bound pull request merged too late or into another branch. Waiting for `settle`.
    Ineligible,
    /// The reward was released to the maintainer.
    Refunded,
    /// The maintainer withdrew the bounty before any claim.
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunKind {
    Nominate,
    Merge,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferKind {
    Reward,
    Budget,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferState {
    /// Owed and not in flight: anyone may send it with `send_due`.
    Due,
    /// Sent; its callback has not recorded the outcome. Never sent again from this state.
    Sending,
    Done,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Transfer {
    pub to: AccountId,
    pub amount: U128,
    pub state: TransferState,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub wallet: AccountId,
    pub github_id: U64,
    pub comment_id: U64,
    pub claimed_at: U64,
    pub request_id: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Binding {
    pub pr_number: u64,
    pub pr_id: U64,
    /// Block time (ns) of the run that saw the pull request open and unmerged.
    pub bound_at: U64,
    pub request_id: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MergeRecord {
    /// GitHub's `merged_at`, Unix seconds.
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
    pub from_budget: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CheckRecord {
    pub seq: U64,
    /// `claim`, `nominate` or `merge`.
    pub kind: String,
    pub request_id: Option<U64>,
    pub resolved_at: U64,
    /// For example `claimed`, `bound`, `pending`, `paid`, `mismatch:author_id`,
    /// `ineligible:merged_after_deadline` or `no_result:rate_limited`.
    pub outcome: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bounty {
    pub buyer: AccountId,
    pub reward: U128,
    /// What is left of the merge-check budget.
    pub budget: U128,
    pub budget_runs_left: u32,
    pub repo: String,
    pub repo_id: U64,
    pub issue: u64,
    pub base_ref: String,
    pub contributor_github_id: U64,
    pub posted_at: U64,
    /// Unix seconds.
    pub claim_by: U64,
    pub bind_by: U64,
    pub merge_deadline: U64,
    pub grace_secs: U64,
    pub status: Status,
    pub claim: Option<Claim>,
    pub binding: Option<Binding>,
    pub merge: Option<MergeRecord>,
    pub live: Option<LiveRun>,
    pub last_check: Option<CheckRecord>,
    pub reward_transfer: Option<Transfer>,
    pub budget_transfer: Option<Transfer>,
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

    fn transfer_mut(&mut self, kind: TransferKind) -> &mut Option<Transfer> {
        match kind {
            TransferKind::Reward => &mut self.reward_transfer,
            TransferKind::Budget => &mut self.budget_transfer,
        }
    }
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub network: String,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub paused: bool,
    pub max_reward: U128,
    pub max_held: U128,
    pub max_open_per_buyer: u32,
    pub held: U128,
    pub bounty_count: u64,
    pub run_deposit: U128,
    pub budget_runs: u32,
    pub storage_deposit: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PrBounty {
    owner: AccountId,
    outlayer: AccountId,
    network: String,
    verifier_url: String,
    verifier_hash: String,
    paused: bool,
    max_reward: u128,
    max_held: u128,
    max_open_per_buyer: u32,
    /// Rewards and budgets owed and not yet sent.
    held: u128,
    posters: LookupSet<AccountId>,
    open_by_buyer: LookupMap<AccountId, u32>,
    bounties: Vector<Bounty>,
    /// GitHub pull request id -> the bounty it is bound to. Never removed.
    used_prs: LookupMap<u64, BountyId>,
    next_seq: u64,
}

/// The verifier's input. Optional members are left out for the other operation.
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
    comment_id: Option<u64>,
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
        max_reward: U128,
        max_held: U128,
        max_open_per_buyer: u32,
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
        let mut contract = Self {
            owner,
            outlayer,
            network,
            verifier_url,
            verifier_hash,
            paused: false,
            max_reward: 0,
            max_held: 0,
            max_open_per_buyer: 0,
            held: 0,
            posters: LookupSet::new(b"p"),
            open_by_buyer: LookupMap::new(b"o"),
            bounties: Vector::new(b"b"),
            used_prs: LookupMap::new(b"u"),
            next_seq: 0,
        };
        contract.apply_caps(max_reward, max_held, max_open_per_buyer);
        contract
    }

    // ---- Owner: allowlist, caps, pause on new bounties ----

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

    /// Stops new bounties only. Claims, nominations, checks, settlements and resends still work.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        env::log_str(&format!("paused {paused}"));
    }

    pub fn set_caps(&mut self, max_reward: U128, max_held: U128, max_open_per_buyer: u32) {
        self.assert_owner();
        self.apply_caps(max_reward, max_held, max_open_per_buyer);
    }

    // ---- Maintainer: post and cancel ----

    /// Posts a bounty. Attach exactly `reward` + the merge-check budget + the storage deposit.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn post_bounty(
        &mut self,
        reward: U128,
        repo: String,
        repo_id: U64,
        issue: u64,
        base_ref: String,
        contributor_github_id: U64,
        claim_by: U64,
        bind_by: U64,
        merge_deadline: U64,
        grace_secs: U64,
    ) -> BountyId {
        let buyer = env::predecessor_account_id();
        require!(!self.paused, "new bounties are paused");
        require!(
            self.posters.contains(&buyer),
            "only an approved maintainer can post"
        );
        require!(
            reward.0 > 0 && reward.0 <= self.max_reward,
            "reward is over the cap"
        );
        let budget = RUN_DEPOSIT.as_yoctonear() * u128::from(BUDGET_RUNS);
        let total = reward.0 + budget;
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
        require!(is_repo(&repo), "repo must be owner/name");
        require!(
            repo_id.0 > 0 && issue > 0 && contributor_github_id.0 > 0,
            "ids are required"
        );
        require!(
            !base_ref.is_empty()
                && base_ref.len() <= MAX_REF_LEN
                && !base_ref.chars().any(char::is_control),
            "base_ref must be a branch name"
        );
        let now = env::block_timestamp();
        require!(
            now < secs_to_nanos(claim_by.0)
                && claim_by.0 <= bind_by.0
                && bind_by.0 <= merge_deadline.0,
            "times must satisfy now < claim_by <= bind_by <= merge_deadline"
        );
        require!(
            secs_to_nanos(merge_deadline.0) <= now.saturating_add(secs_to_nanos(MAX_DURATION_SECS)),
            "merge_deadline is more than 30 days away"
        );
        require!(
            (MIN_GRACE_SECS..=MAX_GRACE_SECS).contains(&grace_secs.0),
            "grace must be 10 minutes to 1 day"
        );
        self.held += total;
        self.open_by_buyer.insert(buyer.clone(), open + 1);
        let id = u64::from(self.bounties.len());
        self.bounties.push(Bounty {
            buyer,
            reward,
            budget: U128(budget),
            budget_runs_left: BUDGET_RUNS,
            repo,
            repo_id,
            issue,
            base_ref,
            contributor_github_id,
            posted_at: U64(now),
            claim_by,
            bind_by,
            merge_deadline,
            grace_secs,
            status: Status::Open,
            claim: None,
            binding: None,
            merge: None,
            live: None,
            last_check: None,
            reward_transfer: None,
            budget_transfer: None,
        });
        log("bounty_posted", id, &format!("reward={}", reward.0));
        id
    }

    /// Withdraws a bounty nobody has claimed. A claim proof still in flight then finds the
    /// bounty cancelled and changes nothing.
    pub fn cancel(&mut self, bounty_id: BountyId) -> Promise {
        let bounty = self.bounty(bounty_id);
        require!(
            env::predecessor_account_id() == bounty.buyer,
            "only the maintainer can cancel"
        );
        require!(
            bounty.status == Status::Open,
            "only an unclaimed bounty can be cancelled"
        );
        self.start_refund(bounty_id, Status::Cancelled)
    }

    // ---- Contributor: claim ----

    /// The text the contributor posts, alone, as a comment on the bounty's issue.
    pub fn claim_challenge(
        &self,
        bounty_id: BountyId,
        wallet: AccountId,
        expires_at: U64,
    ) -> String {
        let bounty = self.bounty(bounty_id);
        self.challenge(
            bounty_id,
            &wallet,
            bounty.contributor_github_id.0,
            expires_at.0,
        )
    }

    /// Starts the claim proof for the calling wallet: the verifier reads `comment_id`. Attach
    /// exactly 0.01 NEAR; OutLayer returns the unused part to the caller.
    #[payable]
    pub fn prove_claim(
        &mut self,
        bounty_id: BountyId,
        comment_id: U64,
        expires_at: U64,
    ) -> Promise {
        let wallet = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(
            env::attached_deposit() == RUN_DEPOSIT,
            "attach exactly 0.01 NEAR"
        );
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_RUN,
            "attach at least 250 Tgas"
        );
        require!(comment_id.0 > 0, "comment_id is required");
        let bounty = self.bounty(bounty_id).clone();
        require!(
            bounty.status == Status::Open,
            "this bounty is not open to claims"
        );
        require!(
            now < secs_to_nanos(bounty.claim_by.0),
            "the claim window has ended"
        );
        let expires = secs_to_nanos(expires_at.0);
        require!(
            now < expires && expires <= now.saturating_add(secs_to_nanos(CHALLENGE_TTL_SECS)),
            "expires_at must be in the future and at most one hour ahead"
        );
        let challenge = self.challenge(
            bounty_id,
            &wallet,
            bounty.contributor_github_id.0,
            expires_at.0,
        );
        let seq = self.next_seq();
        let input = self.input(
            bounty_id,
            seq,
            &bounty.repo,
            "comment",
            None,
            Some(comment_id.0),
            Some(&challenge),
        );
        log(
            "claim_requested",
            bounty_id,
            &format!("seq={seq} wallet={wallet} comment={}", comment_id.0),
        );
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_CLAIM_CALLBACK)
            .with_unused_gas_weight(0)
            .on_claim(
                bounty_id,
                U64(seq),
                wallet.clone(),
                comment_id,
                expires_at,
                U64(now),
            );
        self.run(input, &wallet, RUN_DEPOSIT).then(callback)
    }

    /// The result of a claim proof. Only the first accepted proof fixes the claim.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_claim(
        &mut self,
        bounty_id: BountyId,
        seq: U64,
        wallet: AccountId,
        comment_id: U64,
        expires_at: U64,
        requested_at: U64,
    ) -> String {
        let result = env::promise_result_checked(0, answer::MAX_OUTPUT_BYTES);
        let now = env::block_timestamp();
        let (network, contract) = (self.network.clone(), env::current_account_id());
        let Some(bounty) = u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
        else {
            return "ignored:no_bounty".to_string();
        };
        let mut request_id = None;
        let outcome = if bounty.status != Status::Open {
            "ignored:not_open".to_string()
        } else if now.saturating_sub(requested_at.0) > RUN_TIMEOUT_NANOS {
            "no_result:stale".to_string()
        } else {
            match parse(
                &result,
                &network,
                &contract,
                bounty_id,
                seq.0,
                &bounty.repo,
                Parsed::comment(comment_id.0),
            ) {
                Err(reason) => reason,
                Ok(answer) => {
                    request_id = Some(answer.request_id);
                    let facts = answer.comment.expect("parse returns the asked operation");
                    let window_start = expires_at.0.saturating_sub(CHALLENGE_TTL_SECS);
                    let posted_secs = bounty.posted_at.0 / NANOS_PER_SEC;
                    let mismatch = if facts.repo_id != bounty.repo_id.0 {
                        Some("repo_id")
                    } else if facts.issue_number != bounty.issue {
                        Some("issue")
                    } else if facts.comment_id != comment_id.0 {
                        Some("comment_id")
                    } else if facts.author_id != bounty.contributor_github_id.0 {
                        Some("author_id")
                    } else if !facts.challenge_matches {
                        Some("challenge")
                    } else if facts.updated_at != facts.created_at {
                        Some("edited")
                    } else if facts.created_at < window_start
                        || facts.created_at > expires_at.0
                        || facts.created_at < posted_secs
                    {
                        Some("challenge_time")
                    } else {
                        None
                    };
                    match mismatch {
                        Some(field) => format!("mismatch:{field}"),
                        None => {
                            bounty.claim = Some(Claim {
                                wallet: wallet.clone(),
                                github_id: bounty.contributor_github_id,
                                comment_id,
                                claimed_at: U64(now),
                                request_id: U64(answer.request_id),
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
                seq,
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
                "seq={} wallet={wallet} outcome={outcome} request_id={}",
                seq.0,
                show(request_id)
            ),
        );
        outcome
    }

    // ---- Maintainer: nominate the pull request ----

    /// Nominates pull request `pr_number` as the work for this issue. The verifier then checks it
    /// is open, unmerged, on the agreed branch and by the claimed contributor. Attach exactly
    /// 0.01 NEAR; OutLayer returns the unused part to the maintainer.
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
            "attach at least 250 Tgas"
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

    /// Checks the bound pull request. Attach exactly 0.01 NEAR to pay for the check yourself
    /// (OutLayer returns the unused part to you). The contributor's wallet may instead attach
    /// nothing and use the bounty's own budget, up to three times.
    #[payable]
    pub fn check_merge(&mut self, bounty_id: BountyId) -> Promise {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_RUN,
            "attach at least 250 Tgas"
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
        let (payer, from_budget) = if attached == RUN_DEPOSIT {
            (caller, false)
        } else {
            require!(
                attached.is_zero(),
                "attach exactly 0.01 NEAR, or nothing to use the budget"
            );
            let wallet = bounty.claim.as_ref().map(|c| &c.wallet);
            require!(
                wallet == Some(&caller),
                "only the contributor's wallet can use the budget"
            );
            require!(
                bounty.budget_runs_left > 0,
                "the bounty's merge-check budget is used up"
            );
            (bounty.buyer.clone(), true)
        };
        self.start_check(
            bounty_id,
            RunKind::Merge,
            binding.pr_number,
            payer,
            from_budget,
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

    // ---- Anyone: settle, resend, cancel a stale OutLayer request ----

    /// Refunds the maintainer once the bounty can no longer pay: never claimed by `claim_by`
    /// (plus the run timeout), claimed but unbound after `bind_by`, bound but unpaid after
    /// `merge_deadline` plus grace, or ineligible. Waits while a check is live.
    pub fn settle(&mut self, bounty_id: BountyId) -> Promise {
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
        self.start_refund(bounty_id, Status::Refunded)
    }

    /// Sends again any transfer of this bounty whose earlier attempt failed, to the same account.
    pub fn send_due(&mut self, bounty_id: BountyId) -> Promise {
        let mut promises: Vec<Promise> = Vec::new();
        for kind in [TransferKind::Reward, TransferKind::Budget] {
            let due = self.bounty(bounty_id).clone();
            let transfer = match kind {
                TransferKind::Reward => due.reward_transfer,
                TransferKind::Budget => due.budget_transfer,
            };
            if transfer.as_ref().map(|t| t.state) == Some(TransferState::Due) {
                promises.push(self.send(bounty_id, kind));
            }
        }
        let mut promises = promises.into_iter();
        let first = promises
            .next()
            .unwrap_or_else(|| env::panic_str("no transfer is due"));
        promises.fold(first, |all, next| all.and(next))
    }

    /// Records a transfer's outcome. A failed transfer becomes due again, to the same account.
    #[private]
    #[cfg_attr(
        feature = "fault-transfer-callback",
        allow(unreachable_code, unused_variables)
    )]
    pub fn on_transfer(&mut self, bounty_id: BountyId, kind: TransferKind) -> bool {
        #[cfg(feature = "fault-transfer-callback")]
        env::panic_str("fault injection: the transfer callback fails");
        let sent = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let mut returned = 0;
        if let Some(bounty) = u32::try_from(bounty_id)
            .ok()
            .and_then(|i| self.bounties.get_mut(i))
        {
            if let Some(transfer) = bounty.transfer_mut(kind) {
                if transfer.state == TransferState::Sending {
                    if sent {
                        transfer.state = TransferState::Done;
                    } else {
                        transfer.state = TransferState::Due;
                        returned = transfer.amount.0;
                    }
                }
            }
        }
        self.held += returned;
        log(
            "transfer_resolved",
            bounty_id,
            &format!("kind={kind:?} sent={sent}"),
        );
        sent
    }

    /// Forwards OutLayer's `cancel_stale_execution` for a run this contract requested; OutLayer
    /// only accepts it from the original caller after its ten-minute stale gate, and refunds the
    /// run's own payer.
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

    /// Bounties with ids from `from_id`, at most `limit` (capped at 50).
    pub fn get_bounties(&self, from_id: BountyId, limit: u64) -> Vec<(BountyId, Bounty)> {
        let end = from_id
            .saturating_add(limit.min(50))
            .min(u64::from(self.bounties.len()));
        (from_id..end)
            .filter_map(|id| self.get_bounty(id).map(|b| (id, b)))
            .collect()
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            outlayer: self.outlayer.clone(),
            network: self.network.clone(),
            verifier_url: self.verifier_url.clone(),
            verifier_hash: self.verifier_hash.clone(),
            paused: self.paused,
            max_reward: U128(self.max_reward),
            max_held: U128(self.max_held),
            max_open_per_buyer: self.max_open_per_buyer,
            held: U128(self.held),
            bounty_count: u64::from(self.bounties.len()),
            run_deposit: U128(RUN_DEPOSIT.as_yoctonear()),
            budget_runs: BUDGET_RUNS,
            storage_deposit: U128(STORAGE_DEPOSIT.as_yoctonear()),
        }
    }

    pub fn is_poster(&self, account: AccountId) -> bool {
        self.posters.contains(&account)
    }

    /// The bounty a GitHub pull request id is bound to, if any.
    pub fn bound_pr(&self, pr_id: U64) -> Option<BountyId> {
        self.used_prs.get(&pr_id.0).copied()
    }

    /// The contract's balance beyond what it owes and what its storage needs. It starts as the
    /// operator's float; an unexplained rise means a transfer failed without its callback running.
    pub fn get_free_balance(&self) -> U128 {
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        U128(
            env::account_balance()
                .as_yoctonear()
                .saturating_sub(storage.as_yoctonear())
                .saturating_sub(self.held),
        )
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

    fn challenge(
        &self,
        bounty_id: BountyId,
        wallet: &AccountId,
        github_id: u64,
        expires_at: u64,
    ) -> String {
        let message = format!(
            "proven-pr-bounty-claim:v1|{}|{}|{bounty_id}|{wallet}|{github_id}|{expires_at}",
            self.network,
            env::current_account_id()
        );
        let digest = env::sha256(message.as_bytes());
        let mut out = String::with_capacity(CHALLENGE_PREFIX.len() + 64);
        out.push_str(CHALLENGE_PREFIX);
        for byte in digest {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn input(
        &self,
        bounty_id: BountyId,
        seq: u64,
        repo: &str,
        op: &'static str,
        number: Option<u64>,
        comment_id: Option<u64>,
        challenge: Option<&str>,
    ) -> String {
        let contract = env::current_account_id();
        serde_json::to_string(&RunInput {
            v: 2,
            network: &self.network,
            contract: &contract,
            bounty: bounty_id,
            seq,
            op,
            repo,
            number,
            comment_id,
            challenge,
        })
        .expect("serializable")
    }

    /// One OutLayer run of the pinned verifier. Its unused deposit, and a refused admission's,
    /// go back to `payer`.
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
        from_budget: bool,
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
        if from_budget {
            bounty.budget_runs_left -= 1;
            bounty.budget = U128(bounty.budget.0 - RUN_DEPOSIT.as_yoctonear());
        }
        bounty.live = Some(LiveRun {
            seq: U64(seq),
            kind,
            requested_at: U64(now),
            pr_number,
            payer: payer.clone(),
            from_budget,
        });
        let repo = bounty.repo.clone();
        if from_budget {
            self.held -= RUN_DEPOSIT.as_yoctonear();
        }
        let input = self.input(bounty_id, seq, &repo, "pull", Some(pr_number), None, None);
        log(
            "check_requested",
            bounty_id,
            &format!(
                "seq={seq} kind={kind:?} pr={pr_number} payer={payer} from_budget={from_budget}"
            ),
        );
        let callback = Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOR_CHECK_CALLBACK)
            .with_unused_gas_weight(0)
            .on_check(bounty_id, U64(seq));
        self.run(input, &payer, RUN_DEPOSIT).then(callback)
    }

    /// The reward to the recorded wallet and the unused budget to the maintainer, each recorded as
    /// sent before it is sent.
    fn start_payout(&mut self, bounty_id: BountyId) {
        let bounty = self.bounty_mut(bounty_id);
        let wallet = bounty
            .claim
            .as_ref()
            .expect("a paid bounty has a claim")
            .wallet
            .clone();
        let (buyer, reward, budget) = (bounty.buyer.clone(), bounty.reward.0, bounty.budget.0);
        bounty.status = Status::Paid;
        bounty.budget = U128(0);
        bounty.reward_transfer = Some(Transfer {
            to: wallet,
            amount: U128(reward),
            state: TransferState::Due,
        });
        if budget > 0 {
            bounty.budget_transfer = Some(Transfer {
                to: buyer.clone(),
                amount: U128(budget),
                state: TransferState::Due,
            });
        }
        self.close_for_buyer(&buyer);
        self.send(bounty_id, TransferKind::Reward).detach();
        if budget > 0 {
            self.send(bounty_id, TransferKind::Budget).detach();
        }
    }

    fn start_refund(&mut self, bounty_id: BountyId, status: Status) -> Promise {
        let bounty = self.bounty_mut(bounty_id);
        let buyer = bounty.buyer.clone();
        let amount = bounty.reward.0 + bounty.budget.0;
        bounty.status = status;
        bounty.budget = U128(0);
        bounty.live = None;
        bounty.reward_transfer = Some(Transfer {
            to: buyer.clone(),
            amount: U128(amount),
            state: TransferState::Due,
        });
        self.close_for_buyer(&buyer);
        log(
            "refund_started",
            bounty_id,
            &format!("status={status:?} amount={amount}"),
        );
        self.send(bounty_id, TransferKind::Reward)
    }

    fn close_for_buyer(&mut self, buyer: &AccountId) {
        let open = self.open_by_buyer.get(buyer).copied().unwrap_or(0);
        self.open_by_buyer
            .insert(buyer.clone(), open.saturating_sub(1));
    }

    /// Marks a due transfer as sent, takes it off what the contract holds, and sends it.
    fn send(&mut self, bounty_id: BountyId, kind: TransferKind) -> Promise {
        let bounty = self.bounty_mut(bounty_id);
        let transfer = bounty
            .transfer_mut(kind)
            .as_mut()
            .unwrap_or_else(|| env::panic_str("no such transfer"));
        require!(
            transfer.state == TransferState::Due,
            "this transfer is not due"
        );
        transfer.state = TransferState::Sending;
        let (to, amount) = (transfer.to.clone(), transfer.amount.0);
        self.held -= amount;
        log(
            "transfer_sent",
            bounty_id,
            &format!("kind={kind:?} to={to} amount={amount}"),
        );
        Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_transfer(bounty_id, kind),
            )
    }
}

fn show(id: Option<u64>) -> String {
    id.map_or_else(|| "none".to_string(), |id| id.to_string())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The verifier's rule for `owner/name`, so the contract never asks for a request it refuses.
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
