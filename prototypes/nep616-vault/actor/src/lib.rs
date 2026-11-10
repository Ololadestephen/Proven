//! Sandbox helper deployed on test accounts. near-workspaces 0.24 has no builder for
//! `DeployGlobalContract`, `DeterministicStateInit` or `UseGlobalContract`, so tests ask this
//! contract to send them from its own account. It holds no state.

use near_sdk::json_types::{Base58CryptoHash, Base64VecU8, U128};
use near_sdk::{env, near, AccountId, CryptoHash, Gas, NearToken, Promise, PublicKey};

#[near(contract_state)]
#[derive(Default)]
pub struct Actor {}

#[near]
impl Actor {
    /// Deploys `code` as a global contract identified by its hash, paid by this account.
    pub fn deploy_global(&mut self, code: Base64VecU8) {
        Promise::new(env::current_account_id())
            .deploy_global_contract(code.0)
            .detach();
    }

    /// Sends one receipt to `receiver` with `DeterministicStateInit` (code `code`, the given
    /// entries, `amount` attached) and, optionally, a call to `method` with `deposit`.
    #[allow(clippy::too_many_arguments)]
    pub fn state_init(
        &mut self,
        receiver: AccountId,
        code: Base58CryptoHash,
        entries: Vec<(Base64VecU8, Base64VecU8)>,
        amount: U128,
        method: Option<String>,
        args: Option<String>,
        deposit: Option<U128>,
    ) {
        let code: CryptoHash = code.into();
        let p = env::promise_batch_create(&receiver);
        let init =
            env::promise_batch_action_state_init(p, code, NearToken::from_yoctonear(amount.0));
        for (key, value) in entries {
            env::set_state_init_data_entry(p, init, &key.0, &value.0);
        }
        if let Some(method) = method {
            env::promise_batch_action_function_call(
                p,
                &method,
                args.unwrap_or_else(|| "{}".to_string()).as_bytes(),
                NearToken::from_yoctonear(deposit.map_or(0, |d| d.0)),
                Gas::from_tgas(20),
            );
        }
    }

    /// Asks `target` to run an action only the account itself may run on itself.
    pub fn poke(&mut self, target: AccountId, op: String, key: Option<PublicKey>) {
        let p = Promise::new(target);
        let p = match op.as_str() {
            "add_key" => p.add_full_access_key(key.expect("a key")),
            // The smallest valid module: an empty one.
            "deploy" => p.deploy_contract(b"\0asm\x01\0\0\0".to_vec()),
            "delete" => p.delete_account(env::current_account_id()),
            "use_global" => p.use_global_contract([0u8; 32]),
            _ => env::panic_str("unknown op"),
        };
        p.detach();
    }

    /// Calls `vault.withdraw` and, in the same execution, deletes this account, so the vault's
    /// transfer arrives at an account that no longer exists.
    pub fn withdraw_then_delete(&mut self, vault: AccountId, beneficiary: AccountId) {
        Promise::new(vault)
            .function_call(
                "withdraw".to_string(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(20),
            )
            .detach();
        Promise::new(env::current_account_id())
            .delete_account(beneficiary)
            .detach();
    }

    /// Two withdrawals in one execution: they reach the vault one after the other.
    pub fn withdraw_twice(&mut self, vault: AccountId) {
        for _ in 0..2 {
            Promise::new(vault.clone())
                .function_call(
                    "withdraw".to_string(),
                    b"{}".to_vec(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(20),
                )
                .detach();
        }
    }
}
