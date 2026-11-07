//! The layout of the board deployed on mainnet before storage return, owner and market access, read
//! once by `migrate`.

use crate::{Agent, Attempt, Bid, BidId, BidState, Claim, FeeState, JobId, Review};
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
    pub used_checks: LookupSet<String>,
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
    pub deliver_secs: u32,
    pub max_attempts: u32,
    pub job_id: Option<JobId>,
    pub state: BidState,
    pub review: Option<Review>,
    pub claim: Option<Claim>,
    pub claims_made: u32,
    pub funded_attempts: u32,
    pub fees: Vec<FeeState>,
    pub allowed_workers: Option<Vec<AccountId>>,
    pub paid: U128,
}

impl OldBid {
    /// What the buyer paid for storage was not recorded before, so an earlier bid returns none. Its
    /// attempts are counted into agent records by its next sync.
    pub(crate) fn upgraded(self) -> Bid {
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
            deliver_secs: self.deliver_secs,
            max_attempts: self.max_attempts,
            job_id: self.job_id,
            state: self.state,
            review: self.review,
            claim: self.claim,
            claims_made: self.claims_made,
            funded_attempts: self.funded_attempts,
            fees: self.fees,
            allowed_workers: self.allowed_workers,
            paid: self.paid,
            storage_paid: U128(0),
            recorded_attempts: 0,
            finished: false,
        }
    }
}

/// Where the map keeps one bid: the map's prefix, then the id, with no hashing.
pub(crate) fn bid_key(id: BidId) -> Vec<u8> {
    let mut key = near_sdk::borsh::to_vec(&crate::Key::Bids).unwrap_or_default();
    key.extend(near_sdk::borsh::to_vec(&id).unwrap_or_default());
    key
}
