//! Prototype escrow (sandbox only) for NEP-616 vault settlement.
//!
//! A settlement is one payout or refund, `(bounty, kind)`, with a fixed recipient and amount,
//! reserved in `held` until it is confirmed. Settling sends one receipt to the recipient's vault:
//! `StateInit` (code by hash, recipient in its state) and `deposit(bounty, kind, attempt)` with
//! the amount attached. Two callbacks follow it, as in the production contract, and both can be
//! made to fail.
//!
//! When neither callback has recorded the attempt, anyone may call `reconcile`. It asks the same
//! vault, again with `StateInit` so the vault exists, to `seal` that attempt, and reads the
//! answer in its own callback. The vault's code is fixed by its address, so its answer is
//! authentic:
//! - a deposit for this attempt with this amount: the settlement is done and released once;
//! - no deposit, sealed through this attempt: the attempt can never be deposited, so it is
//!   failed and due again, still reserved. Its NEAR comes back to the escrow as a refund.
//!
//! A new attempt is sent only while the escrow's balance covers its storage and everything it
//! holds, so a resend never spends another settlement's reservation while an old attempt's
//! refund is still on its way. That guard decides when to send, never what happened.

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{Base58CryptoHash, U128};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json;
use near_sdk::state_init::{StateInit, StateInitV1};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, CryptoHash, Gas, GlobalContractId, NearToken, PanicOnDefault,
    PromiseError,
};

const GAS_FOR_DEPOSIT: Gas = Gas::from_tgas(10);
/// The fault that makes a funding receipt fail: the vault has no such method.
const FAILING_DEPOSIT_METHOD: &str = "no_such_method";
const GAS_FOR_SEAL: Gas = Gas::from_tgas(10);
const GAS_FOR_SETTLE_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_OUTCOME_CALLBACK: Gas = Gas::from_tgas(5);
const GAS_FOR_RECONCILE_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_HOP: Gas = Gas::from_tgas(3);
/// Attached to `StateInit`; the runtime keeps what the vault's storage needs and returns the
/// rest to the escrow.
pub const VAULT_INIT_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// What `reconcile` must attach: it pays the vault's `StateInit` (unused part returned) and stays
/// in the vault as the storage of the seal record.
pub const RECONCILE_DEPOSIT: NearToken = NearToken::from_millinear(11);
const SEAL_DEPOSIT: NearToken = NearToken::from_millinear(1);
const MAX_SEAL_ANSWER: usize = 512;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Due,
    Sending,
    Done,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Unknown,
    Succeeded,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub to: AccountId,
    pub vault: AccountId,
    pub amount: U128,
    pub state: State,
    pub attempt: u32,
    pub outcome: Outcome,
}

/// Fault injection for the sandbox.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Faults {
    /// Both settlement callbacks panic.
    pub callbacks: bool,
    /// The vault deposit gets too little gas, so the funding receipt fails.
    pub deposit: bool,
    /// The reconcile callback panics (after the vault has sealed).
    pub reconcile_callback: bool,
    /// Holds the funding receipt back behind this many self-calls, so a seal can overtake it.
    pub delay_hops: u8,
}

/// The vault's `seal` answer.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Slot {
    deposit: Option<DepositRecord>,
    sealed_through: u32,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct DepositRecord {
    attempt: u32,
    amount: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct SlotArgs {
    bounty: u64,
    kind: u8,
    attempt: u32,
}

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct VaultState<'a> {
    recipient: &'a AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    owner: AccountId,
    vault_code: CryptoHash,
    /// Every settlement not confirmed done.
    held: u128,
    /// The part of `held` whose NEAR has left the escrow in an attempt with no result yet.
    in_flight: u128,
    settlements: LookupMap<(u64, u8), Settlement>,
    faults: Faults,
}

fn vault_state(recipient: &AccountId) -> Vec<u8> {
    near_sdk::borsh::to_vec(&VaultState { recipient }).expect("serializable")
}

fn args(bounty: u64, kind: u8, attempt: u32) -> Vec<u8> {
    serde_json::to_vec(&SlotArgs {
        bounty,
        kind,
        attempt,
    })
    .expect("serializable")
}

#[near]
impl Escrow {
    #[init]
    pub fn new(owner: AccountId, vault_code: Base58CryptoHash) -> Self {
        Self {
            owner,
            vault_code: vault_code.into(),
            held: 0,
            in_flight: 0,
            settlements: LookupMap::new(b"s"),
            faults: Faults::default(),
        }
    }

    /// The vault address of `recipient`: NEP-616 over the pinned code hash and its state.
    pub fn vault_of(&self, recipient: AccountId) -> AccountId {
        self.state_init(&recipient).derive_account_id()
    }

    /// Stands in for a bounty's payout or refund decision: locks the attached NEAR for `to`.
    #[payable]
    pub fn reserve(&mut self, bounty: u64, kind: u8, to: AccountId) {
        require!(
            !self.settlements.contains_key(&(bounty, kind)),
            "already reserved"
        );
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the amount");
        let vault = self.vault_of(to.clone());
        self.held += amount;
        self.settlements.insert(
            (bounty, kind),
            Settlement {
                to,
                vault,
                amount: U128(amount),
                state: State::Due,
                attempt: 0,
                outcome: Outcome::Unknown,
            },
        );
    }

    /// Sends a due settlement as a new attempt. Anyone may call it.
    pub fn settle(&mut self, bounty: u64, kind: u8) {
        let s = self
            .settlements
            .get(&(bounty, kind))
            .unwrap_or_else(|| env::panic_str("no such settlement"));
        require!(s.state == State::Due, "this settlement is not due");
        // Every due settlement's NEAR must be here, this one's included. A failed attempt's
        // refund that has not arrived yet leaves the balance short, so we wait for it.
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        require!(
            env::account_balance()
                .saturating_sub(storage)
                .as_yoctonear()
                >= self.held - self.in_flight,
            "waiting for an earlier attempt's refund to arrive"
        );
        let faults = self.faults;
        let code = self.vault_code;
        let s = self
            .settlements
            .get_mut(&(bounty, kind))
            .expect("checked above");
        self.in_flight += s.amount.0;
        s.state = State::Sending;
        s.attempt += 1;
        s.outcome = Outcome::Unknown;
        let (to, vault, amount, attempt) = (s.to.clone(), s.vault.clone(), s.amount.0, s.attempt);
        env::log_str(&format!(
            "settle_sent bounty={bounty} kind={kind} attempt={attempt} to={to} vault={vault} amount={amount}"
        ));
        let me = env::current_account_id();
        let zero = NearToken::from_yoctonear(0);
        let p = if faults.delay_hops == 0 {
            env::promise_batch_create(&vault)
        } else {
            let mut hop = env::promise_create(me.clone(), "hop", b"{}", zero, GAS_FOR_HOP);
            for _ in 1..faults.delay_hops {
                hop = env::promise_then(hop, me.clone(), "hop", b"{}", zero, GAS_FOR_HOP);
            }
            env::promise_batch_then(hop, &vault)
        };
        let init = env::promise_batch_action_state_init(p, code, VAULT_INIT_DEPOSIT);
        env::set_state_init_data_entry(p, init, b"STATE", &vault_state(&to));
        let method = if faults.deposit {
            FAILING_DEPOSIT_METHOD
        } else {
            "deposit"
        };
        env::promise_batch_action_function_call(
            p,
            method,
            &args(bounty, kind, attempt),
            NearToken::from_yoctonear(amount),
            GAS_FOR_DEPOSIT,
        );
        let a = args(bounty, kind, attempt);
        env::promise_then(
            p,
            me.clone(),
            "on_settle",
            &a,
            zero,
            GAS_FOR_SETTLE_CALLBACK,
        );
        env::promise_then(
            p,
            me,
            "on_settle_outcome",
            &a,
            zero,
            GAS_FOR_OUTCOME_CALLBACK,
        );
    }

    #[private]
    pub fn on_settle(&mut self, bounty: u64, kind: u8, attempt: u32) -> bool {
        require!(!self.faults.callbacks, "fault: on_settle fails");
        let ok = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        self.finish(bounty, kind, attempt, ok, "callback")
    }

    #[private]
    pub fn on_settle_outcome(&mut self, bounty: u64, kind: u8, attempt: u32) {
        require!(!self.faults.callbacks, "fault: on_settle_outcome fails");
        let ok = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if let Some(s) = self.settlements.get_mut(&(bounty, kind)) {
            if s.attempt == attempt && s.state == State::Sending && s.outcome == Outcome::Unknown {
                s.outcome = if ok {
                    Outcome::Succeeded
                } else {
                    Outcome::Failed
                };
            }
        }
    }

    /// Asks the recipient's vault to seal `attempt` of this settlement and records its answer.
    /// Anyone may call it, for the current attempt or an earlier one, as often as they like.
    /// Attach exactly 0.011 NEAR (0.001 stays in the vault as the seal's storage).
    #[payable]
    pub fn reconcile(&mut self, bounty: u64, kind: u8, attempt: u32) {
        require!(
            env::attached_deposit() == RECONCILE_DEPOSIT,
            "attach exactly 0.011 NEAR"
        );
        let s = self
            .settlements
            .get(&(bounty, kind))
            .unwrap_or_else(|| env::panic_str("no such settlement"));
        require!(
            attempt >= 1 && attempt <= s.attempt,
            "no such attempt was sent"
        );
        let p = env::promise_batch_create(&s.vault);
        let init = env::promise_batch_action_state_init(p, self.vault_code, VAULT_INIT_DEPOSIT);
        env::set_state_init_data_entry(p, init, b"STATE", &vault_state(&s.to));
        env::promise_batch_action_function_call(
            p,
            "seal",
            &args(bounty, kind, attempt),
            SEAL_DEPOSIT,
            GAS_FOR_SEAL,
        );
        // Whatever this receipt does not use, or all of it if it fails, goes back to the caller.
        env::promise_set_refund_to(p, &env::predecessor_account_id());
        let answer = env::promise_then(
            p,
            env::current_account_id(),
            "on_reconcile",
            args(bounty, kind, attempt),
            NearToken::from_yoctonear(0),
            GAS_FOR_RECONCILE_CALLBACK,
        );
        env::promise_return(answer);
    }

    /// Applies the vault's sealed answer to `attempt`, only if that attempt is still the one in
    /// flight with no recorded result.
    #[private]
    pub fn on_reconcile(&mut self, bounty: u64, kind: u8, attempt: u32) -> String {
        require!(!self.faults.reconcile_callback, "fault: on_reconcile fails");
        let answer = match env::promise_result_checked(0, MAX_SEAL_ANSWER) {
            Ok(bytes) => match serde_json::from_slice::<Slot>(&bytes) {
                Ok(slot) => slot,
                Err(_) => return self.note(bounty, kind, attempt, "ignored:malformed"),
            },
            Err(_) => return self.note(bounty, kind, attempt, "ignored:seal_failed"),
        };
        let Some(s) = self.settlements.get(&(bounty, kind)) else {
            return "ignored:no_settlement".to_string();
        };
        if s.state != State::Sending || s.attempt != attempt {
            return self.note(bounty, kind, attempt, "ignored:not_in_flight");
        }
        let amount = s.amount.0;
        match answer.deposit {
            Some(d) if d.attempt == attempt && d.amount.0 == amount => {
                self.finish(bounty, kind, attempt, true, "reconcile");
                self.note(bounty, kind, attempt, "deposited")
            }
            Some(_) => self.note(bounty, kind, attempt, "ignored:other_deposit"),
            None if answer.sealed_through >= attempt => {
                self.finish(bounty, kind, attempt, false, "reconcile");
                self.note(bounty, kind, attempt, "sealed_without_deposit")
            }
            None => self.note(bounty, kind, attempt, "ignored:not_sealed"),
        }
    }

    /// One step of the `delay_hops` fault.
    #[private]
    pub fn hop(&self) {}

    #[private]
    pub fn set_faults(&mut self, faults: Faults) {
        self.faults = faults;
    }

    pub fn get_settlement(&self, bounty: u64, kind: u8) -> Option<Settlement> {
        self.settlements.get(&(bounty, kind)).cloned()
    }

    pub fn held(&self) -> U128 {
        U128(self.held)
    }

    pub fn in_flight(&self) -> U128 {
        U128(self.in_flight)
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}

impl Escrow {
    fn state_init(&self, recipient: &AccountId) -> StateInit {
        StateInit::V1(StateInitV1 {
            code: GlobalContractId::CodeHash(self.vault_code),
            data: [(b"STATE".to_vec(), vault_state(recipient))].into(),
        })
    }

    /// One attempt's result, if that attempt is still in flight: success releases the
    /// reservation once; failure makes the settlement due again, still reserved.
    fn finish(&mut self, bounty: u64, kind: u8, attempt: u32, ok: bool, by: &str) -> bool {
        let Some(s) = self.settlements.get_mut(&(bounty, kind)) else {
            return false;
        };
        if s.state != State::Sending || s.attempt != attempt {
            return false;
        }
        s.outcome = if ok {
            Outcome::Succeeded
        } else {
            Outcome::Failed
        };
        self.in_flight -= s.amount.0;
        if ok {
            s.state = State::Done;
            self.held -= s.amount.0;
        } else {
            s.state = State::Due;
        }
        env::log_str(&format!(
            "settle_finished bounty={bounty} kind={kind} attempt={attempt} ok={ok} by={by}"
        ));
        true
    }

    fn note(&self, bounty: u64, kind: u8, attempt: u32, outcome: &str) -> String {
        env::log_str(&format!(
            "reconcile_resolved bounty={bounty} kind={kind} attempt={attempt} outcome={outcome}"
        ));
        outcome.to_string()
    }
}
