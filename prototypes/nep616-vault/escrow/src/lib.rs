//! Prototype escrow (sandbox only) for NEP-616 vault settlement bound to a recipient key.
//!
//! A settlement is one payout or refund, `(bounty, kind)`, with a fixed amount and a fixed
//! recipient *key*. The key is bound when the settlement is reserved, with a NEP-413 signature
//! that proves the recipient holds it (in the bounty contract: the contributor at claim time,
//! the maintainer at posting). The amount stays reserved in `held` until it is confirmed.
//!
//! Settling sends one receipt to the key's vault: `StateInit` (code by hash; the key, a zero
//! withdrawal number and a zero storage fund) and `deposit` with the amount plus a storage fee.
//! The vault keeps only the storage its record needs and returns the rest of the fee here. Two
//! callbacks follow, and both can be made to fail.
//!
//! When neither callback recorded the attempt, anyone may `reconcile`: the escrow asks the same
//! vault to `seal` that attempt and applies the answer in its own callback. A deposit for this
//! attempt and amount releases the reservation once; a sealed attempt with no deposit is failed
//! and due again, still reserved, and its NEAR comes back here as a refund. A new attempt goes out
//! only once everything due is covered by the escrow's balance, so it never spends another
//! settlement's reservation ahead of a refund.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128};
use near_sdk::state_init::{StateInit, StateInitV1};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, AccountId, CryptoHash, Gas, GlobalContractId, NearToken, PanicOnDefault,
    PromiseError, PublicKey,
};

const GAS_FOR_DEPOSIT: Gas = Gas::from_tgas(10);
/// The fault that makes a funding receipt fail: the vault has no such method.
const FAILING_DEPOSIT_METHOD: &str = "no_such_method";
const GAS_FOR_SEAL: Gas = Gas::from_tgas(10);
const GAS_FOR_SETTLE_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_OUTCOME_CALLBACK: Gas = Gas::from_tgas(5);
const GAS_FOR_RECONCILE_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_HOP: Gas = Gas::from_tgas(3);
/// The smallest settlement this prototype accepts.
pub const MIN_AMOUNT: NearToken = NearToken::from_millinear(10);
/// Attached to `StateInit`. A vault starts far below the 770-byte zero-balance limit, so the
/// runtime keeps nothing and returns it all; it only matters if that rule ever changes.
pub const VAULT_INIT_DEPOSIT: NearToken = NearToken::from_millinear(5);
/// Attached to each `deposit` and `seal` on top of any amount: enough for 500 bytes of storage.
/// The vault keeps exactly what its storage needs and returns the rest.
pub const STORAGE_FEE: NearToken = NearToken::from_millinear(5);
/// What `reconcile` must attach: the `StateInit` deposit and the seal's storage fee. Whatever the
/// vault does not keep goes back to the caller.
pub const RECONCILE_DEPOSIT: NearToken = NearToken::from_millinear(10);
const NEP413_TAG: u32 = 2_147_484_061;
const SLOT_LEN: usize = 25;

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
    pub key: PublicKey,
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
    pub callbacks: bool,
    pub deposit: bool,
    pub reconcile_callback: bool,
    pub delay_hops: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    vault_code: CryptoHash,
    /// Every settlement not confirmed done.
    held: u128,
    /// The part of `held` whose NEAR has left in an attempt with no result yet.
    in_flight: u128,
    settlements: LookupMap<(u64, u8), Settlement>,
    faults: Faults,
}

fn slot_args(bounty: u64, kind: u8, attempt: u32) -> Vec<u8> {
    let mut out = bounty.to_le_bytes().to_vec();
    out.push(kind);
    out.extend(attempt.to_le_bytes());
    out
}

fn key_bytes(key: &PublicKey) -> [u8; 32] {
    let bytes = key.as_bytes();
    require(
        bytes.len() == 33 && bytes[0] == 0,
        "the recipient key must be ed25519",
    );
    bytes[1..].try_into().expect("32 bytes")
}

fn require(ok: bool, msg: &str) {
    if !ok {
        env::panic_str(msg)
    }
}

/// The NEP-413 hash a key signs to bind itself to a settlement: message
/// `proven-vault-bind:v1|chain=…|escrow=…|bounty=…|kind=…`, recipient the escrow, zero nonce.
fn bind_hash(bounty: u64, kind: u8) -> [u8; 32] {
    let me = env::current_account_id();
    let message = format!(
        "proven-vault-bind:v1|chain={}|escrow={me}|bounty={bounty}|kind={kind}",
        env::chain_id()
    );
    let mut payload = NEP413_TAG.to_le_bytes().to_vec();
    payload.extend((message.len() as u32).to_le_bytes());
    payload.extend(message.as_bytes());
    payload.extend([0u8; 32]);
    payload.extend((me.as_str().len() as u32).to_le_bytes());
    payload.extend(me.as_bytes());
    payload.push(0);
    env::sha256_array(&payload)
}

#[near]
impl Escrow {
    #[init]
    pub fn new(vault_code: Base58CryptoHash) -> Self {
        Self {
            vault_code: vault_code.into(),
            held: 0,
            in_flight: 0,
            settlements: LookupMap::new(b"s"),
            faults: Faults::default(),
        }
    }

    /// The vault of `key`: NEP-616 over the pinned code hash and its initial state.
    pub fn vault_of(&self, key: PublicKey) -> AccountId {
        self.state_init(&key).derive_account_id()
    }

    /// Locks the attached NEAR (at least 0.01) for the holder of `key`, who proves it by signing
    /// the bind message for this settlement (NEP-413).
    #[payable]
    pub fn reserve(&mut self, bounty: u64, kind: u8, key: PublicKey, proof: Base64VecU8) {
        require(
            !self.settlements.contains_key(&(bounty, kind)),
            "already reserved",
        );
        let amount = env::attached_deposit().as_yoctonear();
        require(
            amount >= MIN_AMOUNT.as_yoctonear(),
            "attach at least 0.01 NEAR",
        );
        let signature: [u8; 64] = proof
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("proof must be a 64-byte signature"));
        require(
            env::ed25519_verify(&signature, bind_hash(bounty, kind), &key_bytes(&key)),
            "the key did not sign this settlement",
        );
        let vault = self.vault_of(key.clone());
        self.held += amount;
        self.settlements.insert(
            (bounty, kind),
            Settlement {
                key,
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
        require(s.state == State::Due, "this settlement is not due");
        // Everything due must be here, plus this attempt's fees, before it leaves.
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let fees = STORAGE_FEE.saturating_add(VAULT_INIT_DEPOSIT);
        require(
            env::account_balance()
                .saturating_sub(storage)
                .saturating_sub(fees)
                .as_yoctonear()
                >= self.held - self.in_flight,
            "waiting for an earlier attempt's refund to arrive",
        );
        let faults = self.faults;
        let code = self.vault_code;
        let s = self.settlements.get_mut(&(bounty, kind)).expect("checked");
        self.in_flight += s.amount.0;
        s.state = State::Sending;
        s.attempt += 1;
        s.outcome = Outcome::Unknown;
        let (key, vault, amount, attempt) = (s.key.clone(), s.vault.clone(), s.amount.0, s.attempt);
        env::log_str(&format!(
            "settle_sent bounty={bounty} kind={kind} attempt={attempt} vault={vault} amount={amount}"
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
        self.init_vault(p, code, &key);
        let mut args = slot_args(bounty, kind, attempt);
        args.extend(amount.to_le_bytes());
        let method = if faults.deposit {
            FAILING_DEPOSIT_METHOD
        } else {
            "deposit"
        };
        env::promise_batch_action_function_call(
            p,
            method,
            &args,
            NearToken::from_yoctonear(amount).saturating_add(STORAGE_FEE),
            GAS_FOR_DEPOSIT,
        );
        let a = near_sdk::serde_json::to_vec(
            &near_sdk::serde_json::json!({"bounty": bounty, "kind": kind, "attempt": attempt}),
        )
        .expect("json");
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
        require(!self.faults.callbacks, "fault: on_settle fails");
        let ok = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        self.finish(bounty, kind, attempt, ok, "callback")
    }

    #[private]
    pub fn on_settle_outcome(&mut self, bounty: u64, kind: u8, attempt: u32) {
        require(!self.faults.callbacks, "fault: on_settle_outcome fails");
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

    /// Asks the vault to seal `attempt` and records its answer. Anyone may call it, for the
    /// current attempt or an earlier one, as often as they like. Attach exactly 0.01 NEAR; what
    /// the vault does not keep for the seal's storage comes back to the caller.
    #[payable]
    pub fn reconcile(&mut self, bounty: u64, kind: u8, attempt: u32) {
        require(
            env::attached_deposit() == RECONCILE_DEPOSIT,
            "attach exactly 0.01 NEAR",
        );
        let s = self
            .settlements
            .get(&(bounty, kind))
            .unwrap_or_else(|| env::panic_str("no such settlement"))
            .clone();
        require(
            attempt >= 1 && attempt <= s.attempt,
            "no such attempt was sent",
        );
        let p = env::promise_batch_create(&s.vault);
        self.init_vault(p, self.vault_code, &s.key);
        env::promise_batch_action_function_call(
            p,
            "seal",
            &slot_args(bounty, kind, attempt),
            STORAGE_FEE,
            GAS_FOR_SEAL,
        );
        env::promise_set_refund_to(p, &env::predecessor_account_id());
        let a = near_sdk::serde_json::to_vec(
            &near_sdk::serde_json::json!({"bounty": bounty, "kind": kind, "attempt": attempt}),
        )
        .expect("json");
        let answer = env::promise_then(
            p,
            env::current_account_id(),
            "on_reconcile",
            a,
            NearToken::from_yoctonear(0),
            GAS_FOR_RECONCILE_CALLBACK,
        );
        env::promise_return(answer);
    }

    /// Applies the vault's sealed answer to `attempt`, only while that attempt is in flight.
    #[private]
    pub fn on_reconcile(&mut self, bounty: u64, kind: u8, attempt: u32) -> String {
        require(!self.faults.reconcile_callback, "fault: on_reconcile fails");
        let slot = match env::promise_result_checked(0, SLOT_LEN) {
            Ok(bytes) if bytes.len() == SLOT_LEN => bytes,
            Ok(_) => return note(bounty, kind, attempt, "ignored:malformed"),
            Err(_) => return note(bounty, kind, attempt, "ignored:seal_failed"),
        };
        let deposited = slot[0] == 1;
        let d_attempt = u32::from_le_bytes(slot[1..5].try_into().expect("4"));
        let d_amount = u128::from_le_bytes(slot[5..21].try_into().expect("16"));
        let sealed_through = u32::from_le_bytes(slot[21..25].try_into().expect("4"));
        let Some(s) = self.settlements.get(&(bounty, kind)) else {
            return "ignored:no_settlement".to_string();
        };
        if s.state != State::Sending || s.attempt != attempt {
            return note(bounty, kind, attempt, "ignored:not_in_flight");
        }
        let amount = s.amount.0;
        if deposited && d_attempt == attempt && d_amount == amount {
            self.finish(bounty, kind, attempt, true, "reconcile");
            note(bounty, kind, attempt, "deposited")
        } else if deposited {
            note(bounty, kind, attempt, "ignored:other_deposit")
        } else if sealed_through >= attempt {
            self.finish(bounty, kind, attempt, false, "reconcile");
            note(bounty, kind, attempt, "sealed_without_deposit")
        } else {
            note(bounty, kind, attempt, "ignored:not_sealed")
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
}

fn note(bounty: u64, kind: u8, attempt: u32, outcome: &str) -> String {
    env::log_str(&format!(
        "reconcile_resolved bounty={bounty} kind={kind} attempt={attempt} outcome={outcome}"
    ));
    outcome.to_string()
}

impl Escrow {
    fn entries(key: &PublicKey) -> [(Vec<u8>, Vec<u8>); 3] {
        [
            (b"k".to_vec(), key.as_bytes().to_vec()),
            (b"n".to_vec(), 0u64.to_le_bytes().to_vec()),
            (b"f".to_vec(), 0u128.to_le_bytes().to_vec()),
        ]
    }

    fn state_init(&self, key: &PublicKey) -> StateInit {
        key_bytes(key);
        StateInit::V1(StateInitV1 {
            code: GlobalContractId::CodeHash(self.vault_code),
            data: Self::entries(key).into_iter().collect(),
        })
    }

    fn init_vault(&self, p: near_sdk::PromiseIndex, code: CryptoHash, key: &PublicKey) {
        let init = env::promise_batch_action_state_init(p, code, VAULT_INIT_DEPOSIT);
        for (k, v) in Self::entries(key) {
            env::set_state_init_data_entry(p, init, &k, &v);
        }
    }

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
}
