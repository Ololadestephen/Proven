//! The verifier's entry point: one JSON input in, one compact verdict out.
//!
//! Input:
//! - `{"mode": "verify", "check": "<check file text>", "deliverable": "<deliverable file text>"}`
//! - `{"mode": "challenge", "check": "<check file text>", "reference": "<reference file text>"}`
//!
//! The texts can instead stay private: give `check_hash` with `reference_hash` (challenge) or
//! `deliverable_hash` (verify) in the public input, and the texts arrive inside the TEE as the
//! OutLayer secret variables `PROVEN_CHECK`, `PROVEN_REFERENCE` and `PROVEN_DELIVERABLE`. Either
//! every text of a run is inline or every one is private. The verifier refuses a secret whose SHA-256 is not the
//! stated hash, so the attested input binds exactly which check and reference were used, and a
//! later reveal can be checked against it. No secret text is ever copied into the output.
//!
//! A data reference is the correct `{"rows": [...]}`. A function reference is
//! `{"wat": "<WebAssembly text>", "domain": [[low, high], ...]}`. The challenge's `fakes_hash` is
//! the SHA-256 of the reference file text: the fakes are fully determined by that text and the
//! verifier build.
//!
//! When the escrow contract requests the run, it adds `escrow` and `job` to the input. The verifier
//! echoes them, with OutLayer's `NEAR_REQUEST_ID`, in the output, so the contract can tell which job
//! a verdict belongs to and store the request id that finds its attestation.
//!
//! The output is compact JSON with sorted keys, the same canonical form OutLayer hashes for its
//! attestation, so the SHA-256 of the printed bytes equals the attestation's `output_hash`.

use crate::check::Check;
use crate::fakes::{self, FunctionReference, Planted};
use crate::{data, function, sha256_hex, FailedRule};
use serde::Deserialize;
use serde_json::{json, Value};

/// OutLayer's documented stdout limit.
pub const MAX_OUTPUT_BYTES: usize = 900;
/// Fewest confirmed fakes a check must face before it can be accepted.
pub const MIN_FAKES: u32 = 5;
const VERSION: u32 = 1;
/// Room kept in the output for the job binding: `escrow` (at most 64 characters), `job` and
/// `request_id`.
const BINDING_BYTES: usize = 140;
const MAX_ACCOUNT_ID_LEN: usize = 64;
/// The variable OutLayer sets to the on-chain request id of the run.
const REQUEST_ID_VARIABLE: &str = "NEAR_REQUEST_ID";

/// Secret variable names the verifier reads when only hashes are in the public input.
pub const CHECK_SECRET: &str = "PROVEN_CHECK";
pub const REFERENCE_SECRET: &str = "PROVEN_REFERENCE";
pub const DELIVERABLE_SECRET: &str = "PROVEN_DELIVERABLE";

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    Verify {
        check: Option<String>,
        check_hash: Option<String>,
        deliverable: Option<String>,
        deliverable_hash: Option<String>,
        escrow: Option<String>,
        job: Option<u64>,
    },
    Challenge {
        check: Option<String>,
        check_hash: Option<String>,
        reference: Option<String>,
        reference_hash: Option<String>,
        escrow: Option<String>,
        job: Option<u64>,
    },
}

/// Runs one input, reading any private texts from the process environment (OutLayer secrets).
pub fn run(input: &[u8]) -> String {
    run_with_secrets(input, |name| std::env::var(name).ok())
}

/// Runs one input with private texts supplied by `secret`.
pub fn run_with_secrets(input: &[u8], secret: impl Fn(&str) -> Option<String>) -> String {
    let verdict = match serde_json::from_slice::<Input>(input) {
        // Every text inline, or every text private: a mixture would let a caller test a chosen
        // text against a secret one and learn from the result.
        Ok(Input::Verify { check, deliverable, .. }) if check.is_some() != deliverable.is_some() => {
            json!({ "v": VERSION, "mode": "verify", "error": "invalid_input" })
        }
        Ok(Input::Verify { check, check_hash, deliverable, deliverable_hash, escrow, job }) => {
            let verdict = match (text(check, check_hash, CHECK_SECRET, &secret), text(deliverable, deliverable_hash, DELIVERABLE_SECRET, &secret)) {
                (Ok(check), Ok(deliverable)) => verify(&check, &deliverable),
                (Err(error), _) | (_, Err(error)) => json!({ "v": VERSION, "mode": "verify", "error": error }),
            };
            bind(verdict, escrow, job, &secret)
        }
        Ok(Input::Challenge { check, reference, .. }) if check.is_some() != reference.is_some() => {
            json!({ "v": VERSION, "mode": "challenge", "error": "invalid_input" })
        }
        Ok(Input::Challenge { check, check_hash, reference, reference_hash, escrow, job }) => {
            let verdict = match (text(check, check_hash, CHECK_SECRET, &secret), text(reference, reference_hash, REFERENCE_SECRET, &secret)) {
                (Ok(check), Ok(reference)) => challenge(&check, &reference),
                (Err(error), _) | (_, Err(error)) => json!({ "v": VERSION, "mode": "challenge", "error": error }),
            };
            bind(verdict, escrow, job, &secret)
        }
        Err(_) => json!({ "v": VERSION, "error": "invalid_input" }),
    };
    let text = verdict.to_string();
    debug_assert!(text.len() <= MAX_OUTPUT_BYTES);
    text
}

/// Adds the job binding to a verdict. An `escrow` too long to be an account id is refused, so the
/// output limit always holds.
fn bind(mut verdict: Value, escrow: Option<String>, job: Option<u64>, variable: &impl Fn(&str) -> Option<String>) -> Value {
    if escrow.as_ref().is_some_and(|e| e.len() > MAX_ACCOUNT_ID_LEN || !e.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')) {
        return json!({ "v": VERSION, "error": "invalid_input" });
    }
    if escrow.is_some() || job.is_some() {
        verdict["escrow"] = json!(escrow);
        verdict["job"] = json!(job);
        verdict["request_id"] = json!(variable(REQUEST_ID_VARIABLE).and_then(|id| id.parse::<u64>().ok()));
    }
    verdict
}

/// A text given directly in the input, or read from the named secret and checked against the
/// stated hash. Errors are fixed strings so no secret content can reach the output.
fn text(given: Option<String>, hash: Option<String>, secret_name: &str, secret: &impl Fn(&str) -> Option<String>) -> Result<String, &'static str> {
    match (given, hash) {
        (Some(text), None) => Ok(text),
        (None, Some(hash)) => {
            let text = secret(secret_name).ok_or("secret_missing")?;
            if sha256_hex(text.as_bytes()) == hash { Ok(text) } else { Err("secret_mismatch") }
        }
        _ => Err("invalid_input"),
    }
}

fn evaluate(check: &Check, deliverable: &Value) -> Result<(), FailedRule> {
    match check {
        Check::Data(c) => data::evaluate(&c.rules, deliverable),
        Check::Function(c) => function::evaluate(c, deliverable),
    }
}

fn verify(check_text: &str, deliverable_text: &str) -> Value {
    let mut verdict = json!({
        "v": VERSION,
        "mode": "verify",
        "spec_hash": sha256_hex(check_text.as_bytes()),
        "deliverable_hash": sha256_hex(deliverable_text.as_bytes()),
        "pass": false,
        "failed_rule": null,
        "error": null,
    });
    let Some(check) = Check::parse(check_text) else {
        verdict["error"] = json!("invalid_check");
        return verdict;
    };
    let outcome = serde_json::from_str::<Value>(deliverable_text)
        .map_err(|_| FailedRule::format())
        .and_then(|deliverable| evaluate(&check, &deliverable));
    match outcome {
        Ok(()) => verdict["pass"] = json!(true),
        Err(FailedRule(rule)) => verdict["failed_rule"] = json!(rule),
    }
    verdict
}

fn challenge(check_text: &str, reference_text: &str) -> Value {
    let mut verdict = json!({
        "v": VERSION,
        "mode": "challenge",
        "spec_hash": sha256_hex(check_text.as_bytes()),
        "fakes_hash": sha256_hex(reference_text.as_bytes()),
        "accepted": false,
        "reference_passed": false,
        "fakes_total": 0,
        "fakes_caught": 0,
        "fakes_unconfirmed": 0,
        "missed": [],
        "missed_more": 0,
        "error": null,
    });
    let Some(check) = Check::parse(check_text) else {
        verdict["error"] = json!("invalid_check");
        return verdict;
    };
    let Some((reference, planted, unconfirmed)) = generate(&check, reference_text) else {
        verdict["error"] = json!("invalid_reference");
        return verdict;
    };

    let reference_passed = evaluate(&check, &reference).is_ok();
    let missed: Vec<&str> =
        planted.iter().filter(|fake| evaluate(&check, &fake.deliverable).is_ok()).map(|fake| fake.name.as_str()).collect();
    let total = planted.len() as u32;
    let caught = total - missed.len() as u32;

    verdict["reference_passed"] = json!(reference_passed);
    verdict["fakes_total"] = json!(total);
    verdict["fakes_caught"] = json!(caught);
    verdict["fakes_unconfirmed"] = json!(unconfirmed);
    verdict["accepted"] = json!(reference_passed && total >= MIN_FAKES && caught == total);
    // List as many missed fakes by name as fit within the output limit; count the rest.
    let mut listed = missed.len();
    loop {
        verdict["missed"] = json!(missed[..listed]);
        verdict["missed_more"] = json!(missed.len() - listed);
        if verdict.to_string().len() + BINDING_BYTES <= MAX_OUTPUT_BYTES || listed == 0 {
            return verdict;
        }
        listed -= 1;
    }
}

/// The reference deliverable, the planted fakes generated from it, and how many mutants could
/// not be confirmed wrong. `None` if the reference does not fit the check's job type.
fn generate(check: &Check, reference_text: &str) -> Option<(Value, Vec<Planted>, usize)> {
    match check {
        Check::Data(_) => {
            let reference: Value = serde_json::from_str(reference_text).ok()?;
            let planted = fakes::data_fakes(&reference).ok()?;
            Some((reference, planted, 0))
        }
        Check::Function(c) => {
            let reference: FunctionReference = serde_json::from_str(reference_text).ok()?;
            let generated = fakes::function_fakes(&reference, &c.export, c.arity).ok()?;
            Some((generated.reference, generated.planted, generated.unconfirmed.len()))
        }
    }
}
