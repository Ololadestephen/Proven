//! The layout of the version deployed on mainnet before storage return and owner handover, read
//! once by `migrate`. Jobs are stored the same way in both, so only the contract's own record changes.

use crate::{AssetCap, Job, JobId};
use near_sdk::store::LookupMap;
use near_sdk::{near, AccountId, NearToken};

#[near(serializers = [borsh])]
pub(crate) struct OldEscrow {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub board: Option<AccountId>,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub secrets_owner: AccountId,
    pub jobs: LookupMap<JobId, Job>,
    pub next_id: JobId,
    pub paused: bool,
    pub run_deposit: NearToken,
    pub caps: Vec<AssetCap>,
    pub held_by_buyer: LookupMap<(AccountId, Option<AccountId>), u128>,
}
