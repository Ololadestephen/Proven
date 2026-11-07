//! The layout of the board deployed on mainnet before one-signature jobs, read once by `migrate`.

use crate::{Agent, Attempt, Bid, BidId, BidState, Claim, JobId, Key, Review};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{near, AccountId};

#[near(serializers = [borsh])]
pub(crate) struct OldBoard {
    pub escrow: AccountId,
    pub reviewer: AccountId,
    pub next_bid: BidId,
    pub bids: LookupMap<BidId, OldBid>,
    pub agents: LookupMap<AccountId, Agent>,
    pub agent_list: Vector<AccountId>,
    pub attempts: LookupMap<(BidId, AccountId), Attempt>,
    pub linked_jobs: LookupSet<JobId>,
    pub used_checks: LookupSet<String>,
    pub fees: LookupMap<JobId, OldFee>,
}

#[near(serializers = [borsh])]
pub(crate) struct OldFee {
    pub bid_id: BidId,
    pub buyer: AccountId,
    pub worker: AccountId,
    pub amount: near_sdk::NearToken,
    pub state: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub(crate) enum OldState {
    Unreviewed,
    Blocked,
    Open,
    Claimed,
    Done,
    Closed,
    Cancelled,
}

#[near(serializers = [borsh])]
pub(crate) struct OldClaim {
    pub number: u32,
    pub agent: AccountId,
    pub claimed_at: U64,
    pub expires_at: U64,
    pub job_id: Option<JobId>,
}

#[near(serializers = [borsh])]
pub(crate) struct OldPastJob {
    pub agent: AccountId,
    pub job_id: JobId,
    pub funded: bool,
    pub bid_state_after: OldState,
}

#[near(serializers = [borsh])]
pub(crate) struct OldBid {
    pub buyer: AccountId,
    pub description: String,
    pub amount: U128,
    pub check_hash: String,
    pub reference_hash: String,
    pub verifier_hash: String,
    pub format: String,
    pub format_hash: String,
    pub expires_at: U64,
    pub claim_window_secs: u32,
    pub state: OldState,
    pub review: Option<Review>,
    pub claim: Option<OldClaim>,
    pub claims_made: u32,
    pub funded_attempts: u32,
    pub past_jobs: Vec<OldPastJob>,
    pub allowed_workers: Option<Vec<AccountId>>,
}

impl OldBid {
    /// An earlier bid's job is the one its last claim used, and its fees were settled per job, so
    /// none are carried over. An open earlier bid is closed: it has no money held to run with.
    pub(crate) fn upgraded(self) -> Bid {
        let job_id = self
            .claim
            .as_ref()
            .and_then(|claim| claim.job_id)
            .or_else(|| self.past_jobs.last().map(|job| job.job_id));
        let state = match self.state {
            OldState::Done => BidState::Done,
            OldState::Blocked => BidState::Blocked,
            OldState::Cancelled => BidState::Cancelled,
            _ => BidState::Closed,
        };
        Bid {
            buyer: self.buyer,
            description: self.description,
            amount: self.amount,
            check_hash: self.check_hash,
            reference_hash: self.reference_hash,
            verifier_hash: self.verifier_hash,
            format: self.format,
            format_hash: self.format_hash,
            expires_at: self.expires_at,
            deliver_secs: 0,
            max_attempts: 3,
            job_id,
            state,
            review: self.review,
            claim: self.claim.map(|claim| Claim {
                number: claim.number,
                agent: claim.agent,
                claimed_at: claim.claimed_at,
            }),
            claims_made: self.claims_made,
            funded_attempts: self.funded_attempts,
            fees: Vec::new(),
            allowed_workers: self.allowed_workers,
            paid: U128(0),
        }
    }
}

/// Where the map keeps one bid: the map's prefix, then the id, with no hashing.
pub(crate) fn bid_key(id: BidId) -> Vec<u8> {
    let mut key = near_sdk::borsh::to_vec(&Key::Bids).unwrap_or_default();
    key.extend(near_sdk::borsh::to_vec(&id).unwrap_or_default());
    key
}
