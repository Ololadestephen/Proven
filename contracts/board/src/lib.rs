//! Proven bid board. Buyers post checkable work, a reviewer can only let a bid through or block it,
//! and registered agents claim bids one at a time.
//!
//! The board holds only NEAR storage deposits. Job money stays in the escrow, which is not changed
//! by this contract and does not know it exists. Every payment still comes from the escrow's
//! callback-recorded verdict. The board only reads `get_job`, so nothing here can move money or set
//! a verdict: the worst a bad reviewer or a griefer can do is waste time.
//!
//! An agent's hashes record what its operator committed to, not proof of what actually ran.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub type BidId = u64;
pub type JobId = u64;

const MAX_DESCRIPTION_BYTES: usize = 2_048;
const MAX_LABEL_BYTES: usize = 128;
const MIN_CLAIM_WINDOW_SECS: u32 = 60;
const MAX_CLAIM_WINDOW_SECS: u32 = 86_400;
const NANOS: u64 = 1_000_000_000;
/// Added to a bid's own storage cost: it pays for the review record that is written later.
const POST_RESERVE: NearToken = NearToken::from_millinear(10);
/// Pays for what a claim writes: the attempt record and, later, the linked job id.
pub const CLAIM_DEPOSIT: NearToken = NearToken::from_millinear(5);
const READ_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(25);

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BidState {
    /// No result from the reviewer yet. Nothing can claim it, and a failed review leaves it here.
    Unreviewed,
    Blocked,
    Open,
    Claimed,
    /// A linked job was released to its worker.
    Done,
    /// A linked job's check failed the challenge, so the buyer's check is what is wrong.
    Closed,
    Cancelled,
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
    pub expires_at: U64,
    pub job_id: Option<JobId>,
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
    pub claim_window_secs: u32,
    pub state: BidState,
    pub review: Option<Review>,
    pub claim: Option<Claim>,
    pub claims_made: u32,
    pub funded_attempts: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub wallet: AccountId,
    pub prompt_hash: String,
    pub knowledge_hash: String,
    pub tools_hash: String,
    pub model: String,
}

/// One account's standing on one bid.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    Active,
    /// A claim the buyer never funded. It does not use up the attempt, but the account waits one
    /// more window, so it cannot immediately take the bid back from everyone else.
    Lapsed {
        retry_after: U64,
    },
    /// A funded job ended without paying this account. This was its one attempt.
    Used,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub escrow: AccountId,
    pub reviewer: AccountId,
}

/// The fields of the escrow's `Job` the board reads. Others are ignored.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JobView {
    pub buyer: AccountId,
    pub worker: AccountId,
    pub token: Option<AccountId>,
    pub amount: U128,
    pub spec_hash: String,
    pub fakes_hash: String,
    pub verifier_hash: String,
    pub state: String,
}

#[ext_contract(ext_escrow)]
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
    LinkedJobs,
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
    linked_jobs: LookupSet<JobId>,
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

/// Takes `extra` plus what the call wrote to storage from the deposit and returns the rest.
fn charge(storage_before: u64, extra: NearToken) {
    let written = env::storage_usage().saturating_sub(storage_before);
    let cost = env::storage_byte_cost()
        .saturating_mul(written as u128)
        .saturating_add(extra);
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        format!("attach at least {} yoctoNEAR", cost.as_yoctonear())
    );
    let rest = attached.saturating_sub(cost);
    if !rest.is_zero() {
        let _ = Promise::new(env::predecessor_account_id()).transfer(rest);
    }
}

/// Before funding: leaving the job here means the claim can lapse without costing the agent its try.
fn unfunded(state: &str) -> bool {
    matches!(state, "Draft" | "Challenging" | "Challenged")
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
            linked_jobs: LookupSet::new(Key::LinkedJobs),
        }
    }

    /// The caller becomes the bid's buyer. Nothing can claim it until the reviewer allows it.
    #[payable]
    pub fn post_bid(
        &mut self,
        description: String,
        amount: U128,
        check_hash: String,
        reference_hash: String,
        verifier_hash: String,
        claim_window_secs: u32,
    ) -> BidId {
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
            (MIN_CLAIM_WINDOW_SECS..=MAX_CLAIM_WINDOW_SECS).contains(&claim_window_secs),
            "claim_window_secs must be 60 to 86400"
        );
        let id = self.next_bid;
        self.next_bid += 1;
        self.bids.insert(
            id,
            Bid {
                buyer: env::predecessor_account_id(),
                description,
                amount,
                check_hash,
                reference_hash,
                verifier_hash,
                claim_window_secs,
                state: BidState::Unreviewed,
                review: None,
                claim: None,
                claims_made: 0,
                funded_attempts: 0,
            },
        );
        self.bids.flush();
        charge(before, POST_RESERVE);
        env::log_str(&format!("bid_posted {id}"));
        id
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
            },
        );
        self.agent_list.push(wallet.clone());
        self.agents.flush();
        self.agent_list.flush();
        charge(before, NearToken::from_yoctonear(0));
        env::log_str(&format!("agent_registered {wallet}"));
    }

    /// Signed by a registered agent's wallet. One claim at a time per bid.
    #[payable]
    pub fn claim(&mut self, bid_id: BidId) -> u32 {
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
        self.lapse_if_due(bid_id, now);
        let bid = self.bid(bid_id);
        require!(
            bid.state == BidState::Open,
            "this bid cannot be claimed now"
        );
        require!(bid.buyer != agent, "a buyer cannot claim its own bid");
        let window = bid.claim_window_secs as u64;
        match self.attempts.get(&(bid_id, agent.clone())) {
            None => {}
            Some(Attempt::Lapsed { retry_after }) => {
                require!(
                    now >= retry_after.0,
                    "this account must wait to claim again"
                )
            }
            Some(_) => env::panic_str("this account has used its attempt on this bid"),
        }
        let bid = self.bid_mut(bid_id);
        bid.claims_made += 1;
        let number = bid.claims_made;
        bid.state = BidState::Claimed;
        bid.claim = Some(Claim {
            number,
            agent: agent.clone(),
            claimed_at: U64(now),
            expires_at: U64(now + window * NANOS),
            job_id: None,
        });
        self.attempts
            .insert((bid_id, agent.clone()), Attempt::Active);
        let rest = env::attached_deposit().saturating_sub(CLAIM_DEPOSIT);
        if !rest.is_zero() {
            let _ = Promise::new(agent.clone()).transfer(rest);
        }
        env::log_str(&format!("bid_claimed {bid_id} {agent} claim={number}"));
        number
    }

    /// Anyone. Ties the active claim to an escrow job after checking the job on chain.
    pub fn link_job(&mut self, bid_id: BidId, job_id: JobId) -> Promise {
        let claim = self.active_unlinked_claim(bid_id, job_id);
        ext_escrow::ext(self.escrow.clone())
            .with_static_gas(READ_GAS)
            .get_job(job_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_link(bid_id, claim.number, job_id),
            )
    }

    #[private]
    pub fn on_link(
        &mut self,
        bid_id: BidId,
        claim_number: u32,
        job_id: JobId,
        #[callback_result] job: Result<Option<JobView>, PromiseError>,
    ) {
        let job = match job {
            Ok(Some(job)) => job,
            Ok(None) => env::panic_str("that job does not exist"),
            Err(_) => env::panic_str("could not read that job"),
        };
        // Everything is checked again here: the claim may have changed while the read was running.
        let claim = self.active_unlinked_claim(bid_id, job_id);
        require!(claim.number == claim_number, "that claim has ended");
        let bid = self.bid(bid_id);
        require!(job.buyer == bid.buyer, "the job has a different buyer");
        require!(
            job.worker == claim.agent,
            "the job names a different worker"
        );
        require!(
            job.spec_hash == bid.check_hash,
            "the job has a different check"
        );
        require!(
            job.fakes_hash == bid.reference_hash,
            "the job has a different reference"
        );
        require!(
            job.verifier_hash == bid.verifier_hash,
            "the job has a different verifier"
        );
        require!(job.amount == bid.amount, "the job has a different amount");
        require!(job.token.is_none(), "the job must be paid in NEAR");
        require!(
            unfunded(&job.state) || job.state == "Funded",
            "the job has gone past funding"
        );
        self.linked_jobs.insert(job_id);
        let linked = self.bid_mut(bid_id);
        if let Some(active) = linked.claim.as_mut() {
            active.job_id = Some(job_id);
        }
        env::log_str(&format!("job_linked {bid_id} {job_id}"));
    }

    /// Anyone. Brings the bid in line with its linked job, or lapses a claim nobody linked in time.
    /// A failed read changes nothing.
    pub fn sync(&mut self, bid_id: BidId) -> PromiseOrValue<BidState> {
        let now = env::block_timestamp();
        self.lapse_if_due(bid_id, now);
        let bid = self.bid(bid_id);
        match bid.claim.as_ref().map(|claim| (claim.number, claim.job_id)) {
            Some((number, Some(job_id))) => PromiseOrValue::Promise(
                ext_escrow::ext(self.escrow.clone())
                    .with_static_gas(READ_GAS)
                    .get_job(job_id)
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_sync(bid_id, number),
                    ),
            ),
            _ => PromiseOrValue::Value(bid.state),
        }
    }

    #[private]
    pub fn on_sync(
        &mut self,
        bid_id: BidId,
        claim_number: u32,
        #[callback_result] job: Result<Option<JobView>, PromiseError>,
    ) -> BidState {
        let now = env::block_timestamp();
        let bid = self.bid(bid_id);
        let (agent, expires_at) = match bid.claim.as_ref() {
            Some(claim) if claim.number == claim_number => {
                (claim.agent.clone(), claim.expires_at.0)
            }
            _ => return bid.state,
        };
        let job = match job {
            Err(_) => return bid.state,
            Ok(job) => job,
        };
        match job.as_ref().map(|job| job.state.as_str()) {
            // The escrow removes a cancelled job, and it can only cancel a job that was never funded.
            None => self.lapse_claim(bid_id, &agent, now),
            Some("Released") => {
                self.end_claim(bid_id, &agent, BidState::Done, true);
            }
            Some("Refunded") | Some("Expired") => {
                self.end_claim(bid_id, &agent, BidState::Open, true);
            }
            Some("CheckRejected") => {
                self.end_claim(bid_id, &agent, BidState::Closed, false);
            }
            Some(state) if unfunded(state) && now > expires_at => {
                self.lapse_claim(bid_id, &agent, now)
            }
            // Funded or running. A linked claim never lapses while its job can still finish.
            Some(_) => {}
        }
        self.bid(bid_id).state
    }

    /// The buyer takes a bid down, unless a linked job has been funded and has not ended.
    pub fn close_bid(&mut self, bid_id: BidId) -> PromiseOrValue<BidState> {
        let bid = self.bid(bid_id);
        require!(
            env::predecessor_account_id() == bid.buyer,
            "only the buyer can close a bid"
        );
        require!(
            matches!(
                bid.state,
                BidState::Unreviewed | BidState::Blocked | BidState::Open | BidState::Claimed
            ),
            "this bid has already ended"
        );
        match bid.claim.as_ref().and_then(|claim| claim.job_id) {
            None => {
                self.cancel_bid(bid_id);
                PromiseOrValue::Value(BidState::Cancelled)
            }
            Some(job_id) => PromiseOrValue::Promise(
                ext_escrow::ext(self.escrow.clone())
                    .with_static_gas(READ_GAS)
                    .get_job(job_id)
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_close(bid_id, job_id),
                    ),
            ),
        }
    }

    #[private]
    pub fn on_close(
        &mut self,
        bid_id: BidId,
        job_id: JobId,
        #[callback_result] job: Result<Option<JobView>, PromiseError>,
    ) -> BidState {
        let job = match job {
            Ok(job) => job,
            Err(_) => env::panic_str("could not read the linked job"),
        };
        let still_linked = self.bid(bid_id).claim.as_ref().and_then(|c| c.job_id) == Some(job_id);
        require!(still_linked, "the claim changed, try again");
        let closable = match job.as_ref().map(|job| job.state.as_str()) {
            None => true,
            Some(state) => {
                unfunded(state) || matches!(state, "CheckRejected" | "Refunded" | "Expired")
            }
        };
        require!(closable, "the linked job has been funded and has not ended");
        self.cancel_bid(bid_id);
        BidState::Cancelled
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

    fn active_unlinked_claim(&self, bid_id: BidId, job_id: JobId) -> Claim {
        require!(
            !self.linked_jobs.contains(&job_id),
            "that job has already been linked to a claim"
        );
        let bid = self.bid(bid_id);
        require!(
            bid.state == BidState::Claimed,
            "this bid has no active claim"
        );
        let claim = bid
            .claim
            .clone()
            .unwrap_or_else(|| env::panic_str("this bid has no active claim"));
        require!(claim.job_id.is_none(), "this claim already has a job");
        require!(
            env::block_timestamp() <= claim.expires_at.0,
            "this claim has lapsed"
        );
        claim
    }

    /// An unlinked claim past its window needs no read: no job can be running for it on this board.
    fn lapse_if_due(&mut self, bid_id: BidId, now: u64) {
        let bid = self.bid(bid_id);
        if let Some(claim) = bid.claim.as_ref() {
            if claim.job_id.is_none() && now > claim.expires_at.0 {
                let agent = claim.agent.clone();
                self.lapse_claim(bid_id, &agent, now);
            }
        }
    }

    fn lapse_claim(&mut self, bid_id: BidId, agent: &AccountId, now: u64) {
        let window = self.bid(bid_id).claim_window_secs as u64;
        self.attempts.insert(
            (bid_id, agent.clone()),
            Attempt::Lapsed {
                retry_after: U64(now + window * NANOS),
            },
        );
        let bid = self.bid_mut(bid_id);
        bid.claim = None;
        bid.state = BidState::Open;
        env::log_str(&format!("claim_lapsed {bid_id} {agent}"));
    }

    fn end_claim(&mut self, bid_id: BidId, agent: &AccountId, state: BidState, funded: bool) {
        if funded {
            self.attempts.insert((bid_id, agent.clone()), Attempt::Used);
        }
        let bid = self.bid_mut(bid_id);
        bid.claim = None;
        bid.state = state;
        if funded {
            bid.funded_attempts += 1;
        }
        env::log_str(&format!("claim_ended {bid_id} {agent} {state:?}"));
    }

    fn cancel_bid(&mut self, bid_id: BidId) {
        let bid = self.bid_mut(bid_id);
        bid.claim = None;
        bid.state = BidState::Cancelled;
        env::log_str(&format!("bid_cancelled {bid_id}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    fn context(who: usize, deposit: NearToken, now: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(who))
            .attached_deposit(deposit)
            .block_timestamp(now)
            .build());
    }

    fn board_with_open_bid() -> Board {
        context(0, NearToken::from_near(1), 1);
        let mut board = Board::new(accounts(5), accounts(4));
        let id = board.post_bid(
            "Convert these invoices".to_string(),
            U128(10),
            HASH.to_string(),
            HASH.to_string(),
            HASH.to_string(),
            60,
        );
        context(4, NearToken::from_yoctonear(0), 1);
        board.record_review(
            id,
            true,
            HASH.to_string(),
            "model".to_string(),
            "chat".to_string(),
        );
        for who in [1, 2] {
            context(who, NearToken::from_near(1), 1);
            board.register_agent(
                HASH.to_string(),
                HASH.to_string(),
                HASH.to_string(),
                "model".to_string(),
            );
        }
        board
    }

    #[test]
    #[should_panic(expected = "only the reviewer")]
    fn only_the_reviewer_reviews() {
        let mut board = board_with_open_bid();
        context(1, NearToken::from_yoctonear(0), 2);
        board.record_review(
            0,
            true,
            HASH.to_string(),
            "model".to_string(),
            "chat".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "must wait")]
    fn a_lapsed_account_waits_one_window_before_claiming_again() {
        let mut board = board_with_open_bid();
        context(1, CLAIM_DEPOSIT, 2);
        board.claim(0);
        // 61 seconds later the claim has lapsed.
        context(1, CLAIM_DEPOSIT, 2 + 61 * NANOS);
        board.claim(0);
    }

    #[test]
    fn a_lapsed_claim_does_not_use_up_the_attempt() {
        let mut board = board_with_open_bid();
        context(1, CLAIM_DEPOSIT, 2);
        board.claim(0);
        let lapsed_at = 2 + 61 * NANOS;
        context(2, CLAIM_DEPOSIT, lapsed_at);
        assert_eq!(board.claim(0), 2, "another agent can take a lapsed claim");
        // That one lapses too, and the first can come back after its wait.
        let later = lapsed_at + 61 * NANOS;
        context(1, CLAIM_DEPOSIT, later);
        assert_eq!(board.claim(0), 3);
    }

    #[test]
    #[should_panic(expected = "cannot be claimed")]
    fn one_claim_at_a_time() {
        let mut board = board_with_open_bid();
        context(1, CLAIM_DEPOSIT, 2);
        board.claim(0);
        context(2, CLAIM_DEPOSIT, 3);
        board.claim(0);
    }

    #[test]
    fn a_failed_read_changes_nothing() {
        let mut board = board_with_open_bid();
        context(1, CLAIM_DEPOSIT, 2);
        board.claim(0);
        if let Some(claim) = board.bid_mut(0).claim.as_mut() {
            claim.job_id = Some(7);
        }
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(env::current_account_id())
                .block_timestamp(u64::MAX / 2)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Failed]
        );
        assert_eq!(
            board.on_sync(0, 1, Err(PromiseError::Failed)),
            BidState::Claimed
        );
        assert_eq!(board.bid(0).claim.as_ref().unwrap().job_id, Some(7));
    }

    #[test]
    #[should_panic(expected = "registered agent")]
    fn an_unregistered_account_cannot_claim() {
        let mut board = board_with_open_bid();
        context(3, CLAIM_DEPOSIT, 2);
        board.claim(0);
    }
}
