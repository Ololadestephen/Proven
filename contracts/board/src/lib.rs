//! Proven bid board. A buyer posts checkable work and pays for it once. A reviewer can only let a bid
//! through or block it, and registered agents claim bids one at a time.
//!
//! Posting forwards the payment and a compute budget to the escrow, which holds them from then on
//! and is the only place job money moves. Every job payment comes from the escrow's callback-recorded
//! verdict. The board can only ask the escrow to create a job, to give an open job to the agent whose
//! claim it accepted, and to close a job no one is on.
//!
//! The one payment made here is the attempt fee, prepaid at posting for each attempt. Each attempt's
//! fee goes by that attempt's recorded outcome alone: to the worker if well-formed work failed a real
//! rule, otherwise back to the buyer. Unused fees go back when the bid ends. Nothing here depends on
//! a model, a message or anything the board decides itself.
//!
//! An agent's hashes record what its operator committed to, not proof of what actually ran.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub type BidId = u64;
pub type JobId = u64;

const MAX_DESCRIPTION_BYTES: usize = 2_048;
const MAX_LABEL_BYTES: usize = 128;
const NANOS: u64 = 1_000_000_000;
/// Added to a bid's own storage cost: it pays for the review, claim and fee records written later.
const POST_RESERVE: NearToken = NearToken::from_millinear(10);
/// Pays for what a claim writes: the attempt record.
pub const CLAIM_DEPOSIT: NearToken = NearToken::from_millinear(5);
const MAX_ALLOWED_WORKERS: usize = 20;
const MAX_FORMAT_BYTES: usize = 2_048;
/// Attempts per bid. With one attempt per account, this bounds what fees a bid can ever pay.
pub const MAX_ATTEMPTS: u32 = 3;
/// Prepaid by the buyer for each attempt. Roughly what a failed attempt costs a worker.
pub const ATTEMPT_FEE: NearToken = NearToken::from_millinear(15);
/// Pays for each attempt's fee record, and is not returned.
pub const FEE_RECORD_DEPOSIT: NearToken = NearToken::from_millinear(2);
/// A bid must end by this long after posting, so a buyer cannot avoid revealing its check.
const MAX_BID_LIFE_NANOS: u64 = 7 * 24 * 3_600 * NANOS;
const MIN_WINDOW_SECS: u32 = 30 * 60;
const MAX_WINDOW_SECS: u32 = 24 * 60 * 60;
/// How long verification can be triggered after each delivery.
const VERDICT_WINDOW_SECS: u32 = 30 * 60;
/// The verifier's reserved rule id for work that does not fit the public format.
const FORMAT_RULE: &str = "format";
/// A job is far smaller than this. A larger answer is not a job.
const MAX_JOB_VIEW_BYTES: usize = 16 * 1024;
const CREATE_GAS: Gas = Gas::from_tgas(30);
const ASSIGN_GAS: Gas = Gas::from_tgas(15);
const CLOSE_GAS: Gas = Gas::from_tgas(60);
const READ_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(25);
/// A sync may pay up to three fees, each with its own callback.
const SYNC_CALLBACK_GAS: Gas = Gas::from_tgas(80);
const FEE_PAID_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BidState {
    /// The escrow is creating the job and holding the payment. If it refuses, the bid is removed and
    /// everything goes back to the buyer.
    Pending,
    /// No result from the reviewer yet. Nothing can claim it, and a failed review leaves it here.
    Unreviewed,
    Blocked,
    Open,
    /// The escrow is giving the job to an agent.
    Assigning,
    Claimed,
    /// The job was paid to its worker.
    Done,
    /// The job ended without a payment: its check was rejected, its attempts ran out, it ended, or
    /// the buyer closed it. The buyer was refunded by the escrow.
    Closed,
    /// Kept only for bids made before this version.
    Cancelled,
}

/// Where one attempt fee stands. `Paying` holds it while a transfer is in flight, so it can go once.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeeState {
    Held,
    Paying,
    PaidToWorker,
    ReturnedToBuyer,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Review {
    pub allow: bool,
    pub review_hash: String,
    pub model: String,
    pub chat_id: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Claim {
    /// Numbered per bid, so a callback from an earlier claim can never act on a later one.
    pub number: u32,
    pub agent: AccountId,
    pub claimed_at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Bid {
    pub buyer: AccountId,
    pub description: String,
    pub amount: U128,
    pub check_hash: String,
    pub reference_hash: String,
    pub verifier_hash: String,
    /// The fields a delivery must have, as the exact text the verifier hashes. A check can only look
    /// at these.
    pub format: String,
    pub format_hash: String,
    /// After this, nobody can claim and anyone can close the bid.
    pub expires_at: U64,
    /// How long each worker has to deliver once it has the job.
    pub deliver_secs: u32,
    pub max_attempts: u32,
    /// The escrow job that holds this bid's money.
    pub job_id: Option<JobId>,
    pub state: BidState,
    pub review: Option<Review>,
    pub claim: Option<Claim>,
    pub claims_made: u32,
    /// Attempts that ended, as the escrow's history records them.
    pub funded_attempts: u32,
    /// One entry per attempt the buyer prepaid.
    pub fees: Vec<FeeState>,
    /// `None` is open entry. Otherwise only these accounts can claim, fixed when the bid is posted.
    pub allowed_workers: Option<Vec<AccountId>>,
    /// Everything the buyer attached when posting, returned in full if the escrow refuses the job.
    pub paid: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub wallet: AccountId,
    pub prompt_hash: String,
    pub knowledge_hash: String,
    pub tools_hash: String,
    pub model: String,
    /// Who an operator hosts this agent for, as the operator states it. `None` for an agent that runs
    /// itself.
    pub owner: Option<AccountId>,
}

/// One account's standing on one bid.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    Active,
    /// Kept only for bids made before this version.
    Lapsed {
        retry_after: U64,
    },
    /// The account had the job. This was its one attempt.
    Used,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub escrow: AccountId,
    pub reviewer: AccountId,
}

/// One attempt as the escrow records it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AttemptView {
    pub worker: AccountId,
    pub outcome: String,
    #[serde(default)]
    pub failed_rule: Option<String>,
    #[serde(default)]
    pub verdict_request_id: Option<U64>,
}

/// The fields of the escrow's `Job` the board reads. Others are ignored.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JobView {
    pub buyer: AccountId,
    #[serde(default)]
    pub worker: Option<AccountId>,
    pub state: String,
    #[serde(default)]
    pub history: Vec<AttemptView>,
}

#[ext_contract(ext_escrow)]
#[allow(dead_code)]
pub trait Escrow {
    fn get_job(&self, job_id: JobId) -> Option<JobView>;
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Bids,
    Agents,
    AgentList,
    Attempts,
    /// Used only by bids made before this version.
    LinkedJobs,
    UsedChecks,
    /// Used only by bids made before this version.
    Fees,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Board {
    escrow: AccountId,
    reviewer: AccountId,
    next_bid: BidId,
    bids: LookupMap<BidId, Bid>,
    agents: LookupMap<AccountId, Agent>,
    agent_list: Vector<AccountId>,
    attempts: LookupMap<(BidId, AccountId), Attempt>,
    /// A check's hash can be on one bid only. Changing one character gets past this, so it only stops
    /// the exact same check being reused after its reveal.
    used_checks: LookupSet<String>,
}

fn require_hash(value: &str, name: &str) {
    require!(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        format!("{name} must be 64 lowercase hex characters")
    );
}

fn require_label(value: &str, name: &str) {
    require!(
        !value.is_empty() && value.len() <= MAX_LABEL_BYTES,
        format!("{name} must be 1 to {MAX_LABEL_BYTES} bytes")
    );
}

/// Lowercase hex SHA-256.
fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Who an attempt's fee belongs to, from its recorded outcome alone.
pub fn fee_goes_to_worker(attempt: &AttemptView) -> bool {
    attempt.outcome == "Failed"
        && attempt.verdict_request_id.is_some()
        && attempt
            .failed_rule
            .as_deref()
            .is_some_and(|rule| rule != FORMAT_RULE)
}

/// Reads a job from a promise result by hand, never panicking on it.
fn read_job() -> Result<Option<JobView>, ()> {
    env::promise_result_checked(0, MAX_JOB_VIEW_BYTES)
        .map_err(|_| ())
        .and_then(|bytes| near_sdk::serde_json::from_slice(&bytes).map_err(|_| ()))
}

#[near]
impl Board {
    #[init]
    pub fn new(escrow: AccountId, reviewer: AccountId) -> Self {
        Self {
            escrow,
            reviewer,
            next_bid: 0,
            bids: LookupMap::new(Key::Bids),
            agents: LookupMap::new(Key::Agents),
            agent_list: Vector::new(Key::AgentList),
            attempts: LookupMap::new(Key::Attempts),
            used_checks: LookupSet::new(Key::UsedChecks),
        }
    }

    /// The caller becomes the bid's buyer and pays for everything at once: the payment, the escrow's
    /// compute budget and job storage (see the escrow's `get_budget_for`), this bid's storage and a
    /// fee for each attempt. The board keeps its part and forwards the rest to the escrow, which
    /// returns any excess straight to the buyer. Nothing can claim the bid until the reviewer allows
    /// it.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn post_bid(
        &mut self,
        description: String,
        amount: U128,
        check_hash: String,
        reference_hash: String,
        verifier_hash: String,
        format: String,
        expires_at: U64,
        reveal_agreed: bool,
        deliver_secs: u32,
        max_attempts: u32,
        allowed_workers: Option<Vec<AccountId>>,
    ) -> Promise {
        let before = env::storage_usage();
        require!(
            !description.is_empty() && description.len() <= MAX_DESCRIPTION_BYTES,
            "description must be 1 to 2048 bytes"
        );
        require!(amount.0 > 0, "amount must be positive");
        require_hash(&check_hash, "check_hash");
        require_hash(&reference_hash, "reference_hash");
        require_hash(&verifier_hash, "verifier_hash");
        require!(
            !format.is_empty() && format.len() <= MAX_FORMAT_BYTES,
            "format must be 1 to 2048 bytes"
        );
        require!(
            reveal_agreed,
            "the buyer must agree that the check is published when the bid closes"
        );
        let now = env::block_timestamp();
        require!(
            expires_at.0 > now && expires_at.0 - now <= MAX_BID_LIFE_NANOS,
            "expires_at must be in the future and at most 7 days away"
        );
        require!(
            (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&deliver_secs),
            "deliver_secs must be 1800 to 86400"
        );
        require!(
            (1..=MAX_ATTEMPTS).contains(&max_attempts),
            "max_attempts must be 1 to 3"
        );
        require!(
            self.used_checks.insert(check_hash.clone()),
            "this exact check was already used on a bid"
        );
        let format_hash = sha256_hex(format.as_bytes());
        if let Some(workers) = &allowed_workers {
            require!(
                !workers.is_empty() && workers.len() <= MAX_ALLOWED_WORKERS,
                "allowed_workers must list 1 to 20 accounts"
            );
        }
        let buyer = env::predecessor_account_id();
        let attached = env::attached_deposit();
        let id = self.next_bid;
        self.next_bid += 1;
        self.bids.insert(
            id,
            Bid {
                buyer: buyer.clone(),
                description,
                amount,
                check_hash: check_hash.clone(),
                reference_hash: reference_hash.clone(),
                verifier_hash: verifier_hash.clone(),
                format,
                format_hash: format_hash.clone(),
                expires_at,
                deliver_secs,
                max_attempts,
                job_id: None,
                state: BidState::Pending,
                review: None,
                claim: None,
                claims_made: 0,
                funded_attempts: 0,
                fees: vec![FeeState::Held; max_attempts as usize],
                allowed_workers,
                paid: U128(attached.as_yoctonear()),
            },
        );
        self.bids.flush();
        // What the board keeps: this bid's storage, a reserve for later records and the fees.
        let written = env::storage_usage().saturating_sub(before);
        let fees = ATTEMPT_FEE
            .saturating_add(FEE_RECORD_DEPOSIT)
            .saturating_mul(u128::from(max_attempts));
        let kept = env::storage_byte_cost()
            .saturating_mul(u128::from(written))
            .saturating_add(POST_RESERVE)
            .saturating_add(fees);
        require!(
            attached > kept.saturating_add(NearToken::from_yoctonear(amount.0)),
            "attach the payment, the escrow's budget and storage, and the fees"
        );
        let forwarded = attached.saturating_sub(kept);
        env::log_str(&format!("bid_posted {id}"));
        Promise::new(self.escrow.clone())
            .function_call(
                "create_open_job".to_string(),
                json!({
                    "buyer": buyer, "spec_hash": check_hash, "fakes_hash": reference_hash,
                    "format_hash": format_hash, "amount": amount, "verifier_hash": verifier_hash,
                    "expires_at": expires_at, "deliver_secs": deliver_secs,
                    "verdict_window_secs": VERDICT_WINDOW_SECS, "max_attempts": max_attempts,
                })
                .to_string()
                .into_bytes(),
                forwarded,
                CREATE_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_job_created(id),
            )
    }

    /// Records the escrow's job, or removes the bid and returns everything if the escrow refused.
    /// When a call fails, NEAR returns its attached deposit to this contract, so the buyer can be
    /// paid back in full from here.
    #[private]
    pub fn on_job_created(&mut self, bid_id: BidId) -> bool {
        let created: Option<JobId> = env::promise_result_checked(0, 64)
            .ok()
            .and_then(|bytes| near_sdk::serde_json::from_slice(&bytes).ok());
        let bid = self.bid_mut(bid_id);
        match created {
            Some(job_id) => {
                bid.job_id = Some(job_id);
                bid.state = BidState::Unreviewed;
                env::log_str(&format!("bid_job_created {bid_id} {job_id}"));
                true
            }
            None => {
                let (buyer, paid, check) = (
                    bid.buyer.clone(),
                    NearToken::from_yoctonear(bid.paid.0),
                    bid.check_hash.clone(),
                );
                self.bids.remove(&bid_id);
                self.used_checks.remove(&check);
                Promise::new(buyer).transfer(paid).detach();
                env::log_str(&format!("bid_refused {bid_id}"));
                false
            }
        }
    }

    /// The reviewer lets a bid through or blocks it, once. This touches no money. An allow only lets
    /// agents try; it never approves a payment.
    pub fn record_review(
        &mut self,
        bid_id: BidId,
        allow: bool,
        review_hash: String,
        model: String,
        chat_id: String,
    ) {
        require!(
            env::predecessor_account_id() == self.reviewer,
            "only the reviewer can record a review"
        );
        require_hash(&review_hash, "review_hash");
        require_label(&model, "model");
        require_label(&chat_id, "chat_id");
        let bid = self.bid_mut(bid_id);
        require!(
            bid.state == BidState::Unreviewed,
            "this bid is not waiting for a review"
        );
        bid.state = if allow {
            BidState::Open
        } else {
            BidState::Blocked
        };
        bid.review = Some(Review {
            allow,
            review_hash,
            model,
            chat_id,
        });
        env::log_str(&format!("bid_reviewed {bid_id} allow={allow}"));
        // A blocked bid can never run, so its buyer is refunded at once and its money stops counting
        // against the caps.
        if !allow {
            self.close_job(bid_id).detach();
        }
    }

    /// The caller's account is the agent's wallet. Its hashes never change: a new prompt needs a new
    /// wallet. The hashes record a commitment, not proof of what the agent actually ran.
    #[payable]
    pub fn register_agent(
        &mut self,
        prompt_hash: String,
        knowledge_hash: String,
        tools_hash: String,
        model: String,
        owner: Option<AccountId>,
    ) {
        let before = env::storage_usage();
        let wallet = env::predecessor_account_id();
        require!(!self.agents.contains_key(&wallet), "already registered");
        require_hash(&prompt_hash, "prompt_hash");
        require_hash(&knowledge_hash, "knowledge_hash");
        require_hash(&tools_hash, "tools_hash");
        require_label(&model, "model");
        self.agents.insert(
            wallet.clone(),
            Agent {
                wallet: wallet.clone(),
                prompt_hash,
                knowledge_hash,
                tools_hash,
                model,
                owner,
            },
        );
        self.agent_list.push(wallet.clone());
        self.agents.flush();
        self.agent_list.flush();
        let written = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(written));
        let attached = env::attached_deposit();
        require!(
            attached >= cost,
            format!("attach at least {} yoctoNEAR", cost.as_yoctonear())
        );
        let rest = attached.saturating_sub(cost);
        if !rest.is_zero() {
            Promise::new(wallet.clone()).transfer(rest).detach();
        }
        env::log_str(&format!("agent_registered {wallet}"));
    }

    /// Signed by a registered agent's wallet. The escrow gives the job to this agent straight away:
    /// the money is already held, so the agent can start as soon as the claim is confirmed.
    #[payable]
    pub fn claim(&mut self, bid_id: BidId) -> Promise {
        require!(
            env::attached_deposit() >= CLAIM_DEPOSIT,
            "attach the claim deposit"
        );
        let agent = env::predecessor_account_id();
        require!(
            self.agents.contains_key(&agent),
            "only a registered agent can claim"
        );
        let now = env::block_timestamp();
        let bid = self.bid(bid_id);
        require!(
            bid.state == BidState::Open,
            "this bid cannot be claimed now"
        );
        require!(now < bid.expires_at.0, "this bid has expired");
        require!(
            bid.funded_attempts < bid.max_attempts,
            "this bid has used all its attempts"
        );
        require!(bid.buyer != agent, "a buyer cannot claim its own bid");
        if let Some(workers) = &bid.allowed_workers {
            require!(
                workers.contains(&agent),
                "this bid does not allow this worker"
            );
        }
        require!(
            self.attempts.get(&(bid_id, agent.clone())).is_none(),
            "this account has used its attempt on this bid"
        );
        let job_id = bid
            .job_id
            .unwrap_or_else(|| env::panic_str("this bid has no job"));
        let bid = self.bid_mut(bid_id);
        bid.claims_made += 1;
        let number = bid.claims_made;
        bid.state = BidState::Assigning;
        bid.claim = Some(Claim {
            number,
            agent: agent.clone(),
            claimed_at: U64(now),
        });
        self.attempts
            .insert((bid_id, agent.clone()), Attempt::Active);
        let rest = env::attached_deposit().saturating_sub(CLAIM_DEPOSIT);
        if !rest.is_zero() {
            Promise::new(agent.clone()).transfer(rest).detach();
        }
        env::log_str(&format!("bid_claimed {bid_id} {agent} claim={number}"));
        Promise::new(self.escrow.clone())
            .function_call(
                "assign".to_string(),
                json!({ "job_id": job_id, "worker": agent })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                ASSIGN_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_assigned(bid_id, number),
            )
    }

    /// Confirms the claim if the escrow gave the job to the agent. If it did not (the check has not
    /// passed its challenge yet, the job is paused or has ended), the claim is undone, the attempt is
    /// not used, and the claim deposit goes back.
    #[private]
    pub fn on_assigned(&mut self, bid_id: BidId, claim_number: u32) -> bool {
        let assigned = env::promise_result_checked(0, 0).is_ok();
        let bid = self.bid_mut(bid_id);
        let Some(claim) = bid.claim.clone().filter(|c| c.number == claim_number) else {
            return false;
        };
        if assigned {
            bid.state = BidState::Claimed;
            env::log_str(&format!("bid_assigned {bid_id} {}", claim.agent));
            return true;
        }
        bid.claim = None;
        bid.state = BidState::Open;
        self.attempts.remove(&(bid_id, claim.agent.clone()));
        Promise::new(claim.agent.clone())
            .transfer(CLAIM_DEPOSIT)
            .detach();
        env::log_str(&format!("assign_refused {bid_id} {}", claim.agent));
        false
    }

    /// Anyone. Brings the bid in line with its escrow job: ends a finished attempt, settles the fees
    /// of every attempt the escrow has recorded, and returns unused fees once the job has ended. A
    /// failed read changes nothing.
    pub fn sync(&mut self, bid_id: BidId) -> PromiseOrValue<BidState> {
        let bid = self.bid(bid_id);
        // Only the claim seen now can be ended by this read, never one made while it was running.
        let claim_number = bid
            .claim
            .as_ref()
            .filter(|_| bid.state == BidState::Claimed)
            .map(|claim| claim.number);
        match bid.job_id {
            Some(job_id) => PromiseOrValue::Promise(
                ext_escrow::ext(self.escrow.clone())
                    .with_static_gas(READ_GAS)
                    .get_job(job_id)
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(SYNC_CALLBACK_GAS)
                            .on_sync(bid_id, claim_number),
                    ),
            ),
            None => PromiseOrValue::Value(bid.state),
        }
    }

    #[private]
    pub fn on_sync(&mut self, bid_id: BidId, claim_number: Option<u32>) -> BidState {
        let Ok(Some(job)) = read_job() else {
            return self.bid(bid_id).state;
        };
        // An attempt the escrow has recorded as finished frees the bid for the next agent. It must be
        // the claim this sync saw, and the escrow's history must show that agent's attempt ended.
        let bid = self.bid(bid_id);
        let finished_claim = bid
            .claim
            .as_ref()
            .filter(|_| bid.state == BidState::Claimed)
            .filter(|claim| Some(claim.number) == claim_number)
            .filter(|claim| job.worker.as_ref() != Some(&claim.agent))
            .filter(|claim| job.history.iter().any(|a| a.worker == claim.agent))
            .map(|claim| claim.agent.clone());
        if let Some(agent) = finished_claim {
            self.attempts.insert((bid_id, agent), Attempt::Used);
            let bid = self.bid_mut(bid_id);
            bid.claim = None;
            bid.state = BidState::Open;
        }
        let bid = self.bid_mut(bid_id);
        bid.funded_attempts = job.history.len() as u32;
        let ended = match job.state.as_str() {
            "Released" => Some(BidState::Done),
            "Refunded" => Some(BidState::Closed),
            _ => None,
        };
        if let Some(state) = ended {
            // Also a bid closed before its review: the escrow has refunded it either way.
            if matches!(
                bid.state,
                BidState::Unreviewed | BidState::Blocked | BidState::Open | BidState::Claimed
            ) {
                bid.state = state;
                bid.claim = None;
            }
        }
        // Each recorded attempt's fee, once, by its own outcome.
        for (index, attempt) in job.history.iter().enumerate() {
            if self.bid(bid_id).fees.get(index) == Some(&FeeState::Held) {
                let to_worker = fee_goes_to_worker(attempt);
                let receiver = if to_worker {
                    attempt.worker.clone()
                } else {
                    self.bid(bid_id).buyer.clone()
                };
                self.pay_fee(bid_id, index, receiver, to_worker);
            }
        }
        // A job that has ended cannot use the rest, so their fees go back.
        if ended.is_some() {
            let buyer = self.bid(bid_id).buyer.clone();
            let start = job.history.len();
            for index in start..self.bid(bid_id).fees.len() {
                if self.bid(bid_id).fees[index] == FeeState::Held {
                    self.pay_fee(bid_id, index, buyer.clone(), false);
                }
            }
        }
        // A rejected check means the job can never run: ask the escrow to refund the buyer.
        if job.state == "CheckRejected" {
            self.close_job(bid_id).detach();
        }
        self.bid(bid_id).state
    }

    /// One-time upgrade from the version where buyers funded each worker themselves. Only this
    /// contract's own account can call it, as part of deploying the new code. Earlier bids are kept
    /// readable; none of them can be claimed again.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        let old: migration::OldBoard =
            env::state_read().unwrap_or_else(|| env::panic_str("no earlier state"));
        for id in 0..old.next_bid {
            let key = migration::bid_key(id);
            let Some(bytes) = env::storage_read(&key) else {
                continue;
            };
            let bid = near_sdk::borsh::from_slice::<migration::OldBid>(&bytes)
                .unwrap_or_else(|_| env::panic_str("could not read an earlier bid"))
                .upgraded();
            let bytes = near_sdk::borsh::to_vec(&bid)
                .unwrap_or_else(|_| env::panic_str("could not write an upgraded bid"));
            env::storage_write(&key, &bytes);
        }
        Self {
            escrow: old.escrow,
            reviewer: old.reviewer,
            next_bid: old.next_bid,
            bids: LookupMap::new(Key::Bids),
            agents: LookupMap::new(Key::Agents),
            // A list keeps its length in this state, so the old one is carried over, not recreated.
            agent_list: old.agent_list,
            attempts: LookupMap::new(Key::Attempts),
            used_checks: LookupSet::new(Key::UsedChecks),
        }
    }

    #[private]
    pub fn on_fee_paid(&mut self, bid_id: BidId, index: u32, to_worker: bool) -> bool {
        let paid = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let bid = self.bid_mut(bid_id);
        if let Some(fee) = bid.fees.get_mut(index as usize) {
            *fee = match (paid, to_worker) {
                (false, _) => FeeState::Held,
                (true, true) => FeeState::PaidToWorker,
                (true, false) => FeeState::ReturnedToBuyer,
            };
        }
        env::log_str(&format!(
            "fee_settled {bid_id} {index} paid={paid} to_worker={to_worker}"
        ));
        paid
    }

    /// The buyer takes a bid down when no agent is on it, or anyone does once it has expired. The
    /// escrow refunds the payment and what is left of the budget; a later `sync` returns the fees.
    pub fn close_bid(&mut self, bid_id: BidId) -> Promise {
        let bid = self.bid(bid_id);
        require!(
            env::predecessor_account_id() == bid.buyer
                || env::block_timestamp() >= bid.expires_at.0,
            "only the buyer can close a bid before it expires"
        );
        require!(
            matches!(
                bid.state,
                BidState::Unreviewed | BidState::Blocked | BidState::Open
            ),
            "this bid cannot be closed now"
        );
        self.close_job(bid_id)
    }

    pub fn get_bid(&self, bid_id: BidId) -> Option<Bid> {
        self.bids.get(&bid_id).cloned()
    }

    /// Bids with ids from `from_id`, at most `limit` (capped at 50).
    pub fn get_bids(&self, from_id: BidId, limit: u64) -> Vec<(BidId, Bid)> {
        let end = from_id.saturating_add(limit.min(50)).min(self.next_bid);
        (from_id..end)
            .filter_map(|id| self.bids.get(&id).map(|bid| (id, bid.clone())))
            .collect()
    }

    pub fn get_agent(&self, wallet: AccountId) -> Option<Agent> {
        self.agents.get(&wallet).cloned()
    }

    /// Agents in registration order, at most `limit` (capped at 50).
    pub fn get_agents(&self, from_index: u32, limit: u32) -> Vec<Agent> {
        self.agent_list
            .iter()
            .skip(from_index as usize)
            .take(limit.min(50) as usize)
            .filter_map(|wallet| self.agents.get(wallet).cloned())
            .collect()
    }

    pub fn get_attempt(&self, bid_id: BidId, account: AccountId) -> Option<Attempt> {
        self.attempts.get(&(bid_id, account)).copied()
    }

    pub fn get_config(&self) -> Config {
        Config {
            escrow: self.escrow.clone(),
            reviewer: self.reviewer.clone(),
        }
    }

    /// What the board keeps from a posting with this many attempts, apart from the bid's own
    /// storage: the reserve and the fees.
    pub fn get_post_charges(&self, max_attempts: u32) -> U128 {
        U128(
            ATTEMPT_FEE
                .saturating_add(FEE_RECORD_DEPOSIT)
                .saturating_mul(u128::from(max_attempts))
                .saturating_add(POST_RESERVE)
                .as_yoctonear(),
        )
    }
}

impl Board {
    fn bid(&self, bid_id: BidId) -> &Bid {
        self.bids
            .get(&bid_id)
            .unwrap_or_else(|| env::panic_str("no such bid"))
    }

    fn bid_mut(&mut self, bid_id: BidId) -> &mut Bid {
        self.bids
            .get_mut(&bid_id)
            .unwrap_or_else(|| env::panic_str("no such bid"))
    }

    fn pay_fee(&mut self, bid_id: BidId, index: usize, receiver: AccountId, to_worker: bool) {
        self.bid_mut(bid_id).fees[index] = FeeState::Paying;
        env::log_str(&format!(
            "fee_paying {bid_id} {index} to_worker={to_worker}"
        ));
        Promise::new(receiver)
            .transfer(ATTEMPT_FEE)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(FEE_PAID_GAS)
                    .on_fee_paid(bid_id, index as u32, to_worker),
            )
            .detach();
    }

    fn close_job(&mut self, bid_id: BidId) -> Promise {
        let job_id = self
            .bid(bid_id)
            .job_id
            .unwrap_or_else(|| env::panic_str("this bid has no job"));
        env::log_str(&format!("bid_closing {bid_id} {job_id}"));
        Promise::new(self.escrow.clone()).function_call(
            "close".to_string(),
            json!({ "job_id": job_id }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            CLOSE_GAS,
        )
    }
}

mod migration;

#[cfg(test)]
mod tests;
