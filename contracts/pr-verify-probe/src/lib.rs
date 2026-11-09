//! Proven PR verify probe: a testnet contract that runs Proven's PR verifier on OutLayer, pinned by
//! its WASM URL and SHA-256, and records the merge facts its own private callback received.
//!
//! The verifier is Proven's own program reading GitHub's public REST API, not OutLayer's curated
//! GitHub connector. The probe holds no bounty, pays nothing and only its owner can start a read.
//! Each read names a pull request number of the repository fixed at deployment, with the facts the
//! owner expects: the pull request id, the author id, the base branch and a merge window. The
//! callback records one outcome per reading:
//!
//! - `Confirmed`: every id and the branch match and the merge time is inside the window;
//! - `Mismatch`: GitHub's facts contradict an expectation, naming the first one;
//! - `Pending`: the facts match so far and the pull request is not merged;
//! - `NoResult`: the run produced no usable answer (a failed promise, a failed or late run, an
//!   oversized, malformed or wrongly bound answer, or the verifier's own no-result code).
//!
//! The expected ids are supplied by the operator. Nothing here proves that a contributor controls
//! the GitHub account, that a pull request solves an issue, or that a bounty could settle safely.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json;
use near_sdk::store::Vector;
use near_sdk::{
    env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
};

const GAS_FOR_OUTLAYER: Gas = Gas::from_tgas(150);
const GAS_FOR_READ_CALLBACK: Gas = Gas::from_tgas(30);
const GAS_FOR_CANCEL: Gas = Gas::from_tgas(50);
const MIN_PREPAID_GAS_FOR_READ: Gas = Gas::from_tgas(200);
const MIN_READ_DEPOSIT: NearToken = NearToken::from_millinear(1);
const MAX_READ_DEPOSIT: NearToken = NearToken::from_millinear(50);
const READ_MAX_INSTRUCTIONS: u64 = 5_000_000_000;
const READ_MAX_MEMORY_MB: u32 = 128;
const READ_MAX_SECONDS: u32 = 30;
const BUILD_TARGET: &str = "wasm32-wasip2";
/// The verifier's largest answer is under 1 KiB; anything longer is not its answer.
pub const MAX_OUTPUT_BYTES: usize = 1024;
/// A result that arrives this long after its request is recorded as no result.
pub const STALE_AFTER_NANOS: u64 = 15 * 60 * 1_000_000_000;
const MAX_READINGS: u32 = 20;
const MAX_URL_LEN: usize = 256;
const MAX_REF_LEN: usize = 255;
const OUTPUT_VERSION: u32 = 1;
const OUTPUT_KIND: &str = "proven-pr-facts";
/// The verifier's own no-result codes. Any other code is treated as a malformed answer.
const VERIFIER_REASONS: [&str; 12] = [
    "bad_request",
    "timeout",
    "unreachable",
    "rate_limited",
    "forbidden",
    "not_found",
    "redirect",
    "upstream_unavailable",
    "upstream_status",
    "oversized",
    "malformed",
    "incomplete",
];

/// What the owner expects of one pull request. Times are Unix seconds, inclusive.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Expectation {
    pub pr_id: U64,
    pub author_id: U64,
    pub base_ref: String,
    pub merged_after: U64,
    pub merged_by: U64,
}

/// The facts the verifier read from GitHub.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Facts {
    pub repo_id: U64,
    pub pr_id: U64,
    pub pr_number: u64,
    pub author_id: U64,
    pub base_ref: String,
    pub state: String,
    pub merged: bool,
    pub merged_at: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// The run was requested and its callback has not arrived.
    Requested,
    Confirmed {
        facts: Facts,
    },
    Mismatch {
        field: String,
        facts: Facts,
    },
    Pending {
        facts: Facts,
    },
    NoResult {
        reason: String,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Reading {
    pub number: u64,
    pub expect: Expectation,
    pub requested_by: AccountId,
    pub requested_at: U64,
    pub resolved_at: Option<U64>,
    /// OutLayer's request id, as the worker reported it to the verifier.
    pub request_id: Option<U64>,
    pub outcome: Outcome,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub outlayer: AccountId,
    pub verifier_url: String,
    pub verifier_hash: String,
    pub repo: String,
    pub repo_id: U64,
}

/// The verifier's answer, exactly as it prints it.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Answer {
    v: u32,
    kind: String,
    predecessor: Option<AccountId>,
    request_id: Option<u64>,
    probe: Option<AccountId>,
    reading: Option<u32>,
    repo: Option<String>,
    number: Option<u64>,
    status: String,
    facts: Option<AnswerFacts>,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct AnswerFacts {
    repo_id: u64,
    pr_id: u64,
    pr_number: u64,
    author_id: u64,
    base_ref: String,
    state: String,
    merged: bool,
    merged_at: Option<u64>,
}

/// The verifier's input: the request it answers and the pull request to read.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RunInput<'a> {
    v: u32,
    probe: &'a AccountId,
    reading: u32,
    repo: &'a str,
    number: u64,
}

/// The arguments of OutLayer's `request_execution`. No secret and no stablecoin is sent.
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct RunArgs<'a> {
    source: Source<'a>,
    resource_limits: Limits,
    input_data: String,
    response_format: &'static str,
    payer_account_id: &'a AccountId,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Source<'a> {
    #[serde(rename = "WasmUrl")]
    wasm_url: WasmUrl<'a>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct WasmUrl<'a> {
    url: &'a str,
    hash: &'a str,
    build_target: &'static str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Limits {
    max_instructions: u64,
    max_memory_mb: u32,
    max_execution_seconds: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PrVerifyProbe {
    owner: AccountId,
    outlayer: AccountId,
    verifier_url: String,
    verifier_hash: String,
    repo: String,
    repo_id: u64,
    readings: Vector<Reading>,
}

#[near]
impl PrVerifyProbe {
    #[init]
    pub fn new(
        owner: AccountId,
        outlayer: AccountId,
        verifier_url: String,
        verifier_hash: String,
        repo: String,
        repo_id: U64,
    ) -> Self {
        require!(
            verifier_url.starts_with("https://") && verifier_url.len() <= MAX_URL_LEN,
            "verifier_url must be an https URL"
        );
        require!(
            is_sha256_hex(&verifier_hash),
            "verifier_hash must be 64 lowercase hex characters"
        );
        require!(is_repo(&repo), "repo must be owner/name");
        require!(repo_id.0 > 0, "repo_id is required");
        Self {
            owner,
            outlayer,
            verifier_url,
            verifier_hash,
            repo,
            repo_id: repo_id.0,
            readings: Vector::new(b"r"),
        }
    }

    /// Runs the verifier on pull request `number`. The attached NEAR pays for compute; OutLayer
    /// returns the unused part to the caller.
    #[payable]
    pub fn read_pr(&mut self, number: u64, expect: Expectation) -> Promise {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
        require!(
            number > 0 && number <= u64::from(u32::MAX),
            "number must be a pull request number"
        );
        require!(
            expect.pr_id.0 > 0 && expect.author_id.0 > 0,
            "expected ids are required"
        );
        require!(
            !expect.base_ref.is_empty() && expect.base_ref.len() <= MAX_REF_LEN,
            "base_ref is required"
        );
        require!(
            expect.merged_after.0 <= expect.merged_by.0,
            "merged_after must not be later than merged_by"
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
            expect,
            requested_by: caller.clone(),
            requested_at: U64(env::block_timestamp()),
            resolved_at: None,
            request_id: None,
            outcome: Outcome::Requested,
        });
        let probe = env::current_account_id();
        let input = RunInput {
            v: OUTPUT_VERSION,
            probe: &probe,
            reading: index,
            repo: &self.repo,
            number,
        };
        let args = RunArgs {
            source: Source {
                wasm_url: WasmUrl {
                    url: &self.verifier_url,
                    hash: &self.verifier_hash,
                    build_target: BUILD_TARGET,
                },
            },
            resource_limits: Limits {
                max_instructions: READ_MAX_INSTRUCTIONS,
                max_memory_mb: READ_MAX_MEMORY_MB,
                max_execution_seconds: READ_MAX_SECONDS,
            },
            input_data: serde_json::to_string(&input).expect("serializable"),
            response_format: "Json",
            payer_account_id: &caller,
        };
        let args = serde_json::to_vec(&args).expect("serializable");
        env::log_str(&format!("read_requested reading={index} number={number}"));
        Promise::new(self.outlayer.clone())
            .refund_to(caller)
            .function_call_weight(
                "request_execution".to_string(),
                args,
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

    /// The result of this contract's own `request_execution` for `reading`. Recorded once; a
    /// second call for the same reading, or one for a reading that does not exist, changes
    /// nothing. Never panics on what OutLayer returned.
    #[private]
    pub fn on_pr_read(&mut self, reading: u32) -> bool {
        let result = env::promise_result_checked(0, MAX_OUTPUT_BYTES);
        let now = env::block_timestamp();
        let probe = env::current_account_id();
        let (repo, repo_id) = (self.repo.clone(), self.repo_id);
        let Some(entry) = self.readings.get_mut(reading) else {
            env::log_str(&format!("read_ignored reading={reading}"));
            return false;
        };
        if entry.outcome != Outcome::Requested {
            env::log_str(&format!("read_ignored reading={reading}"));
            return false;
        }
        let bound = Binding {
            probe: &probe,
            reading,
            repo: &repo,
            repo_id,
            number: entry.number,
            expect: &entry.expect,
        };
        let (outcome, request_id) = if now.saturating_sub(entry.requested_at.0) > STALE_AFTER_NANOS
        {
            (no_result("stale"), None)
        } else {
            match result {
                Ok(bytes) => bound.classify(&bytes),
                Err(PromiseError::TooLong(_)) => (no_result("oversized"), None),
                Err(_) => (no_result("promise_failed"), None),
            }
        };
        let kind = match &outcome {
            Outcome::Confirmed { .. } => "confirmed",
            Outcome::Mismatch { .. } => "mismatch",
            Outcome::Pending { .. } => "pending",
            _ => "no_result",
        };
        entry.outcome = outcome;
        entry.request_id = request_id.map(U64);
        entry.resolved_at = Some(U64(now));
        env::log_str(&format!(
            "read_resolved reading={reading} outcome={kind} request_id={}",
            request_id.map_or("none".to_string(), |id| id.to_string())
        ));
        true
    }

    /// Forwards OutLayer's `cancel_stale_execution` for a run this probe requested, which OutLayer
    /// only accepts from the original caller and after its ten-minute stale gate. OutLayer refunds
    /// the run's payer. The reading itself was already resolved by its callback.
    pub fn cancel_stale_outlayer_execution(&mut self, request_id: U64) -> Promise {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
        Promise::new(self.outlayer.clone()).function_call(
            "cancel_stale_execution".to_string(),
            format!("{{\"request_id\":{}}}", request_id.0).into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FOR_CANCEL,
        )
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            outlayer: self.outlayer.clone(),
            verifier_url: self.verifier_url.clone(),
            verifier_hash: self.verifier_hash.clone(),
            repo: self.repo.clone(),
            repo_id: U64(self.repo_id),
        }
    }

    pub fn get_reading(&self, reading: u32) -> Option<Reading> {
        self.readings.get(reading).cloned()
    }

    pub fn get_reading_count(&self) -> u32 {
        self.readings.len()
    }

    /// The compute deposit bounds, for the runbook: `(min, max)` in yoctoNEAR.
    pub fn get_deposit_bounds(&self) -> (U128, U128) {
        (
            U128(MIN_READ_DEPOSIT.as_yoctonear()),
            U128(MAX_READ_DEPOSIT.as_yoctonear()),
        )
    }
}

/// Everything a result must agree with: the request it answers and what the owner expects.
struct Binding<'a> {
    probe: &'a AccountId,
    reading: u32,
    repo: &'a str,
    repo_id: u64,
    number: u64,
    expect: &'a Expectation,
}

impl Binding<'_> {
    /// The outcome of one answer, and the request id it carried when it was bound to this read.
    fn classify(&self, bytes: &[u8]) -> (Outcome, Option<u64>) {
        if bytes == b"null" {
            return (no_result("no_output"), None);
        }
        let Ok(answer) = near_sdk::serde_json::from_slice::<Answer>(bytes) else {
            return (no_result("malformed"), None);
        };
        if answer.v != OUTPUT_VERSION || answer.kind != OUTPUT_KIND {
            return (no_result("malformed"), None);
        }
        let bound = answer.probe.as_ref() == Some(self.probe)
            && answer.predecessor.as_ref() == Some(self.probe)
            && answer.reading == Some(self.reading)
            && answer.repo.as_deref() == Some(self.repo)
            && answer.number == Some(self.number)
            && answer.request_id.is_some();
        if !bound {
            return (no_result("wrong_binding"), None);
        }
        let outcome = match (answer.status.as_str(), answer.facts, answer.reason) {
            ("ok", Some(facts), None) => self.judge(facts),
            ("no_result", None, Some(reason)) if VERIFIER_REASONS.contains(&reason.as_str()) => {
                no_result(&reason)
            }
            _ => no_result("malformed"),
        };
        (outcome, answer.request_id)
    }

    fn judge(&self, read: AnswerFacts) -> Outcome {
        let consistent = matches!(read.state.as_str(), "open" | "closed")
            && !read.base_ref.is_empty()
            && read.base_ref.len() <= MAX_REF_LEN
            && read.merged == read.merged_at.is_some()
            && !(read.merged && read.state == "open");
        if !consistent {
            return no_result("malformed");
        }
        let expect = self.expect;
        let mismatch = if read.repo_id != self.repo_id {
            Some("repo_id")
        } else if read.pr_number != self.number {
            Some("pr_number")
        } else if read.pr_id != expect.pr_id.0 {
            Some("pr_id")
        } else if read.author_id != expect.author_id.0 {
            Some("author_id")
        } else if read.base_ref != expect.base_ref {
            Some("base_ref")
        } else {
            match read.merged_at {
                None => None,
                Some(at) if at < expect.merged_after.0 => Some("merged_before_window"),
                Some(at) if at > expect.merged_by.0 => Some("merged_after_window"),
                Some(_) => None,
            }
        };
        let facts = Facts {
            repo_id: U64(read.repo_id),
            pr_id: U64(read.pr_id),
            pr_number: read.pr_number,
            author_id: U64(read.author_id),
            base_ref: read.base_ref,
            state: read.state,
            merged: read.merged,
            merged_at: read.merged_at.map(U64),
        };
        match mismatch {
            Some(field) => Outcome::Mismatch {
                field: field.to_string(),
                facts,
            },
            None if facts.merged => Outcome::Confirmed { facts },
            None => Outcome::Pending { facts },
        }
    }
}

fn no_result(reason: &str) -> Outcome {
    Outcome::NoResult {
        reason: reason.to_string(),
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The verifier's own rule for `owner/name`, so the probe never asks for a request it refuses.
fn is_repo(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    let owner_ok = (1..=39).contains(&owner.len())
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !owner.starts_with('-');
    let name_ok = (1..=100).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && name != "."
        && name != "..";
    owner_ok && name_ok
}

#[cfg(test)]
mod tests;
