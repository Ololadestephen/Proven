//! Prototype NEP-616 vault (sandbox only).
//!
//! A vault lives at a deterministic `0s…` address derived from this code's hash (as a global
//! contract, by hash) and its initial state, which names one recipient. Anyone may send it NEAR;
//! everything it holds belongs to that recipient, who alone can withdraw it.
//!
//! For settlement, an issuer (any account, in practice the escrow) calls `deposit` with the
//! reward attached. The vault keeps a durable record per `(issuer, bounty, kind)`: the attempt and
//! the exact amount. `seal` answers whether that record exists and, if it does not, refuses every
//! later deposit for that attempt and earlier ones. A sealed "no record" is therefore final: a
//! deposit still in flight for that attempt will fail and its NEAR will go back to the issuer.
//!
//! The vault never deploys code, adds keys, deletes itself or pays anyone but its recipient.

use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

/// The record of one settlement slot, under one issuer.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Slot {
    /// The one accepted deposit, if any: its attempt and exact amount in yoctoNEAR.
    pub deposit: Option<Deposit>,
    /// Every attempt up to this one is sealed: a deposit for it is refused.
    pub sealed_through: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Deposit {
    pub attempt: u32,
    pub amount: U128,
}

/// Only the recipient is stored at `STATE`, so the escrow can build the exact initial state.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    recipient: AccountId,
}

fn slot_key(issuer: &AccountId, bounty: u64, kind: u8) -> Vec<u8> {
    let mut key = b"s".to_vec();
    key.extend(near_sdk::borsh::to_vec(&(issuer, bounty, kind)).expect("serializable"));
    key
}

fn read_slot(key: &[u8]) -> Slot {
    env::storage_read(key)
        .map(|bytes| Slot::try_from_slice(&bytes).expect("a slot"))
        .unwrap_or_default()
}

fn write_slot(key: &[u8], slot: &Slot) {
    env::storage_write(key, &near_sdk::borsh::to_vec(slot).expect("serializable"));
}

#[near]
impl Vault {
    pub fn recipient(&self) -> AccountId {
        self.recipient.clone()
    }

    pub fn slot(&self, issuer: AccountId, bounty: u64, kind: u8) -> Slot {
        read_slot(&slot_key(&issuer, bounty, kind))
    }

    /// Records the attached NEAR as the issuer's settlement `(bounty, kind)`, attempt `attempt`.
    /// Refused if that slot already has a deposit, or if this attempt has been sealed.
    #[payable]
    pub fn deposit(&mut self, bounty: u64, kind: u8, attempt: u32) {
        let issuer = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(
            amount > 0 && attempt > 0,
            "attach the amount, for attempt 1 or later"
        );
        let key = slot_key(&issuer, bounty, kind);
        let mut slot = read_slot(&key);
        require!(
            slot.deposit.is_none(),
            "this settlement already has a deposit"
        );
        require!(attempt > slot.sealed_through, "this attempt is sealed");
        slot.deposit = Some(Deposit {
            attempt,
            amount: U128(amount),
        });
        write_slot(&key, &slot);
        env::log_str(&format!(
            "vault_deposit issuer={issuer} bounty={bounty} kind={kind} attempt={attempt} amount={amount}"
        ));
    }

    /// Answers for the issuer's slot `(bounty, kind)`. With no deposit, it first seals every
    /// attempt up to `attempt`, so the answer cannot change for them afterwards. Calling it again
    /// gives the same answer. Any attached NEAR (for the record's storage) stays in the vault.
    #[payable]
    pub fn seal(&mut self, bounty: u64, kind: u8, attempt: u32) -> Slot {
        let issuer = env::predecessor_account_id();
        let key = slot_key(&issuer, bounty, kind);
        let mut slot = read_slot(&key);
        if slot.deposit.is_none() && slot.sealed_through < attempt {
            slot.sealed_through = attempt;
            write_slot(&key, &slot);
        }
        env::log_str(&format!(
            "vault_seal issuer={issuer} bounty={bounty} kind={kind} attempt={attempt} deposit={} sealed_through={}",
            slot.deposit.as_ref().map_or("none".to_string(), |d| format!("{}:{}", d.attempt, d.amount.0)),
            slot.sealed_through
        ));
        slot
    }

    /// Sends everything above the vault's own storage stake to the recipient. Only the recipient
    /// may call it. If the transfer fails, the runtime refunds it to the vault, and the recipient
    /// can withdraw again once that refund has arrived.
    pub fn withdraw(&mut self) -> U128 {
        require!(
            env::predecessor_account_id() == self.recipient,
            "only the recipient can withdraw"
        );
        let reserve = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let available = env::account_balance().saturating_sub(reserve);
        require!(!available.is_zero(), "nothing to withdraw");
        env::log_str(&format!(
            "vault_withdraw to={} amount={} reserve={}",
            self.recipient,
            available.as_yoctonear(),
            reserve.as_yoctonear()
        ));
        Promise::new(self.recipient.clone())
            .transfer(available)
            .detach();
        U128(available.as_yoctonear())
    }

    /// What `withdraw` would send now.
    pub fn available(&self) -> U128 {
        let reserve: NearToken =
            env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        U128(
            env::account_balance()
                .saturating_sub(reserve)
                .as_yoctonear(),
        )
    }
}
