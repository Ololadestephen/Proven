//! Proven PR probe: the smallest contract that asks OutLayer's curated GitHub connector for one
//! pull request, with `pr_get` at a pinned connector version, and records what its own private
//! callback received. It is a testnet experiment for PR Merge Bounties. It holds no bounty money,
//! decides no payout and only its owner can start a read.
//!
//! Each read names the repository fixed at deployment and a pull request number. OutLayer runs the
//! connector with the GitHub token stored in the secrets row `secrets_owner`/`secrets_profile`,
//! charges the operation's price in stablecoin from this contract's own OutLayer balance, and
//! returns the connector's answer to `on_pr_read`. Whatever comes back is recorded as one of three
//! outcomes: the pull request's facts, the connector's refusal code, or no result.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::Vector;
use near_sdk::{
    env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
};

/// Gas for OutLayer's `request_execution`, which reserves 50 Tgas of it for its own settlement.
const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(150);
const GAS_FOR_READ_CALLBACK: Gas = Gas::from_tgas(30);
const MIN_PREPAID_GAS_FOR_READ: Gas = Gas::from_tgas(200);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
/// What one read may attach for compute. OutLayer refunds the unused part to the caller.
const MIN_READ_DEPOSIT: NearToken = NearToken::from_millinear(1);
const MAX_READ_DEPOSIT: NearToken = NearToken::from_millinear(50);
const READ_MAX_INSTRUCTIONS: u64 = 10_000_000_000;
const READ_MAX_MEMORY_MB: u32 = 128;
const READ_MAX_SECONDS: u32 = 30;
/// The most of the connector's answer the callback reads. The answer carries the pull request's
/// title and description, which its author controls, so a longer one is recorded as no result.
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024;
/// The most stablecoin (6 decimals) one read may attach: $0.01. The price of `pr_get` is $0.001.
const MAX_PRICE_USD: u128 = 10_000;
const MAX_READINGS: u32 = 100;
const MAX_CODE_LEN: usize = 40;
const MAX_LOGIN_LEN: usize = 39;
const MAX_REPO_LEN: usize = 140;
const MAX_BRANCH_LEN: usize = 255;
const MAX_STATE_LEN: usize = 16;
const MAX_TIME_LEN: usize = 32;
const SHA_LEN: usize = 40;

/// What a read of one pull request returned, cut to the fields a bounty would need.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PrFacts {
    pub number: u64,
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    /// The author's login. The connector returns no numeric user id.
    pub author: String,
    pub base_branch: String,
    /// The base repository's `owner/name`. The connector returns no numeric repository id.
    pub base_repo: String,
    pub head_sha: String,
    /// GitHub's `updated_at`. The connector returns no `merged_at`.
    pub updated_at: String,
    pub output_bytes: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Pending,
    /// The connector answered with the pull request asked for, in the probe's repository.
    Read(PrFacts),
    /// The connector ran and refused, with the word before the colon of its error.
    Refused {
        code: String,
    },
    /// Nothing usable: a failed promise, a failed run (`null`), an oversized or malformed
    /// answer, or an answer about another repository or pull request.
    NoResult {
        reason: String,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Reading {
    pub number: u64,
    pub requested_by: AccountId,
    pub requested_at: U64,
    pub resolved_at: Option<U64>,
    pub outcome: Outcome,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub project_id: String,
    pub version_key: String,
    pub secrets_owner: AccountId,
    pub secrets_profile: String,
    pub repo: String,
    pub price_usd: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PrProbe {
    owner: AccountId,
    outlayer: AccountId,
    project_id: String,
    version_key: String,
    secrets_owner: AccountId,
    secrets_profile: String,
    repo: String,
    price_usd: u128,
    readings: Vector<Reading>,
}

#[near]
impl PrProbe {
    /// `version_key` is the connector build's SHA-256 as OutLayer lists it in `list_versions`.
    /// `price_usd` is what each read attaches in stablecoin; OutLayer returns any excess.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        outlayer: AccountId,
        project_id: String,
        version_key: String,
        secrets_owner: AccountId,
        secrets_profile: String,
        repo: String,
        price_usd: U128,
    ) -> Self {
        require!(
            is_sha256_hex(&version_key),
            "version_key must be 64 lowercase hex characters"
        );
        require!(is_repo(&repo), "repo must be owner/name");
        require!(
            !project_id.is_empty() && project_id.len() <= 128,
            "project_id is required"
        );
        require!(
            !secrets_profile.is_empty() && secrets_profile.len() <= 64,
            "secrets_profile is required"
        );
        require!(
            price_usd.0 > 0 && price_usd.0 <= MAX_PRICE_USD,
            "price_usd must be between 1 and 10000"
        );
        Self {
            owner,
            outlayer,
            project_id,
            version_key,
            secrets_owner,
            secrets_profile,
            repo,
            price_usd: price_usd.0,
            readings: Vector::new(b"r"),
        }
    }

    /// Moves `amount` of the stablecoin this contract holds into its OutLayer balance, which pays
    /// each read's operation price. OutLayer has no withdrawal for this balance: send only what
    /// the reads will use.
    #[payable]
    pub fn fund_connector_balance(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR"
        );
        require!(
            amount.0 > 0 && amount.0 <= 1_000_000,
            "amount must be between 1 and 1000000"
        );
        let args = json!({
            "receiver_id": self.outlayer,
            "amount": amount,
            "msg": json!({"action": "deposit_balance"}).to_string(),
        });
        Promise::new(token).function_call(
            "ft_transfer_call".to_string(),
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(1),
            GAS_FOR_FT_TRANSFER_CALL,
        )
    }

    /// Asks the connector for pull request `number` of the probe's repository. The attached NEAR
    /// pays for compute; OutLayer returns the unused part to the caller.
    #[payable]
    pub fn read_pr(&mut self, number: u64) -> Promise {
        self.assert_owner();
        require!(
            number > 0 && number <= u32::MAX as u64,
            "number must be a pull request number"
        );
        let deposit = env::attached_deposit();
        require!(
            deposit >= MIN_READ_DEPOSIT && deposit <= MAX_READ_DEPOSIT,
            "attach between 0.001 and 0.05 NEAR for compute"
        );
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_READ,
            "attach at least 200 Tgas"
        );
        require!(self.readings.len() < MAX_READINGS, "the probe is full");
        let caller = env::predecessor_account_id();
        let index = self.readings.len();
        self.readings.push(Reading {
            number,
            requested_by: caller.clone(),
            requested_at: U64(env::block_timestamp()),
            resolved_at: None,
            outcome: Outcome::Pending,
        });
        let args = self.request_args(number, &caller);
        env::log_str(&format!("read_requested index={index} number={number}"));
        Promise::new(self.outlayer.clone())
            .refund_to(caller)
            .function_call_weight(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                deposit,
                GAS_FOR_OUTLAYER,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_READ_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_pr_read(index),
            )
    }

    /// The result of this contract's own `request_execution`. A reading is resolved once; a later
    /// call for the same index is ignored. Never panics on what OutLayer returned.
    #[private]
    pub fn on_pr_read(&mut self, index: u32) -> bool {
        let result = env::promise_result_checked(0, MAX_OUTPUT_BYTES);
        let repo = self.repo.clone();
        let Some(reading) = self.readings.get_mut(index) else {
            env::log_str(&format!("read_ignored index={index}"));
            return false;
        };
        if reading.outcome != Outcome::Pending {
            env::log_str(&format!("read_ignored index={index}"));
            return false;
        }
        reading.outcome = match result {
            Ok(bytes) => classify(&bytes, &repo, reading.number),
            Err(PromiseError::TooLong(_)) => no_result("oversized"),
            Err(_) => no_result("promise_failed"),
        };
        reading.resolved_at = Some(U64(env::block_timestamp()));
        let kind = match &reading.outcome {
            Outcome::Read(_) => "read",
            Outcome::Refused { .. } => "refused",
            _ => "no_result",
        };
        env::log_str(&format!("read_resolved index={index} outcome={kind}"));
        true
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            outlayer: self.outlayer.clone(),
            project_id: self.project_id.clone(),
            version_key: self.version_key.clone(),
            secrets_owner: self.secrets_owner.clone(),
            secrets_profile: self.secrets_profile.clone(),
            repo: self.repo.clone(),
            price_usd: U128(self.price_usd),
        }
    }

    pub fn get_reading(&self, index: u32) -> Option<Reading> {
        self.readings.get(index).cloned()
    }

    pub fn get_reading_count(&self) -> u32 {
        self.readings.len()
    }
}

impl PrProbe {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
    }

    fn request_args(&self, number: u64, payer: &AccountId) -> Value {
        json!({
            "source": { "Project": { "project_id": self.project_id, "version_key": self.version_key } },
            "resource_limits": {
                "max_instructions": READ_MAX_INSTRUCTIONS,
                "max_memory_mb": READ_MAX_MEMORY_MB,
                "max_execution_seconds": READ_MAX_SECONDS,
            },
            "input_data": json!({"operation": "pr_get", "repo": self.repo, "number": number}).to_string(),
            "secrets_ref": { "profile": self.secrets_profile, "account_id": self.secrets_owner },
            "response_format": "Json",
            "payer_account_id": payer,
            "params": { "attached_usd": U128(self.price_usd) },
        })
    }
}

fn no_result(reason: &str) -> Outcome {
    Outcome::NoResult {
        reason: reason.to_string(),
    }
}

/// Turns the connector's answer into an outcome. The answer is the connector's envelope,
/// `{success, operation, output, error, logs}`, or `null` when the run failed or timed out.
pub fn classify(bytes: &[u8], repo: &str, number: u64) -> Outcome {
    let Ok(answer) = serde_json::from_slice::<Value>(bytes) else {
        return no_result("malformed");
    };
    if answer.is_null() {
        return no_result("no_output");
    }
    if answer["operation"] != "pr_get" {
        return no_result("malformed");
    }
    match answer["success"].as_bool() {
        Some(true) => {}
        Some(false) => {
            let error = answer["error"].as_str().unwrap_or_default();
            let code = error.split(':').next().unwrap_or_default().trim();
            return if !code.is_empty()
                && code.len() <= MAX_CODE_LEN
                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            {
                Outcome::Refused {
                    code: code.to_string(),
                }
            } else {
                no_result("malformed")
            };
        }
        None => return no_result("malformed"),
    }
    let output = &answer["output"];
    let pr = &output["pull_request"];
    let Some(facts) = facts(pr, bytes.len()) else {
        return no_result("malformed");
    };
    if !output["repo"]
        .as_str()
        .is_some_and(|r| r.eq_ignore_ascii_case(repo))
        || !facts.base_repo.eq_ignore_ascii_case(repo)
    {
        return no_result("wrong_repo");
    }
    if facts.number != number {
        return no_result("wrong_pr");
    }
    Outcome::Read(facts)
}

fn facts(pr: &Value, output_bytes: usize) -> Option<PrFacts> {
    let text = |value: &Value, max: usize| {
        value
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= max)
            .map(str::to_string)
    };
    let head_sha = text(&pr["head"]["sha"], SHA_LEN)?;
    if head_sha.len() != SHA_LEN || !head_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(PrFacts {
        number: pr["number"].as_u64()?,
        state: text(&pr["state"], MAX_STATE_LEN)?,
        draft: pr["draft"].as_bool()?,
        merged: pr["merged"].as_bool()?,
        author: text(&pr["author"], MAX_LOGIN_LEN)?,
        base_branch: text(&pr["base"]["branch"], MAX_BRANCH_LEN)?,
        base_repo: text(&pr["base"]["repo"], MAX_REPO_LEN)?,
        head_sha,
        updated_at: text(&pr["updated_at"], MAX_TIME_LEN)?,
        output_bytes: output_bytes as u32,
    })
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_repo(value: &str) -> bool {
    let mut parts = value.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    };
    value.len() <= MAX_REPO_LEN && ok(owner) && ok(name)
}

#[cfg(test)]
mod tests;
