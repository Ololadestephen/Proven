//! Verifier behaviour, run against the example jobs in `examples/` and small edge cases.

use proven_verifier::run::{run, run_with_secrets, MAX_OUTPUT_BYTES};
use proven_verifier::sha256_hex;
use serde_json::{json, Value};

fn example(path: &str) -> String {
    std::fs::read_to_string(format!("../examples/{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn verify(check: &str, deliverable: &str) -> Value {
    output(&json!({ "mode": "verify", "check": check, "deliverable": deliverable }))
}

fn challenge(check: &str, reference: &str) -> Value {
    output(&json!({ "mode": "challenge", "check": check, "reference": reference }))
}

fn output(input: &Value) -> Value {
    let text = run(input.to_string().as_bytes());
    assert!(text.len() <= MAX_OUTPUT_BYTES, "output is {} bytes", text.len());
    serde_json::from_str(&text).unwrap()
}

fn counts(v: &Value) -> (bool, bool, u64, u64, u64) {
    (
        v["accepted"].as_bool().unwrap(),
        v["reference_passed"].as_bool().unwrap(),
        v["fakes_total"].as_u64().unwrap(),
        v["fakes_caught"].as_u64().unwrap(),
        v["fakes_unconfirmed"].as_u64().unwrap(),
    )
}

fn wasm_deliverable(wat_text: &str) -> String {
    use base64::Engine as _;
    let bytes = wat::parse_str(wat_text).unwrap();
    json!({ "wasm_base64": base64::engine::general_purpose::STANDARD.encode(bytes) }).to_string()
}

#[test]
fn data_job_weak_check_is_refused_and_strong_check_accepted() {
    let reference = example("data-job/reference.json");
    assert_eq!(counts(&challenge(&example("data-job/check-weak.json"), &reference)), (false, true, 13, 4, 0));
    assert_eq!(counts(&challenge(&example("data-job/check-strong.json"), &reference)), (true, true, 13, 13, 0));
}

#[test]
fn function_job_weak_check_is_refused_and_strong_check_accepted() {
    // One mutant (div_s -> div_u) behaves like the reference on the whole domain: unconfirmed.
    let reference = example("function-job/challenge-reference.json");
    assert_eq!(counts(&challenge(&example("function-job/check-weak.json"), &reference)), (false, true, 11, 4, 1));
    assert_eq!(counts(&challenge(&example("function-job/check-strong.json"), &reference)), (true, true, 11, 11, 1));
}

#[test]
fn strong_checks_pass_honest_work_and_fail_the_fakes() {
    let data = example("data-job/check-strong.json");
    assert_eq!(verify(&data, &example("data-job/deliverable-honest.json"))["pass"], true);
    assert_eq!(verify(&data, &example("data-job/deliverable-fake.json"))["failed_rule"], "grand_total");
    let function = example("function-job/check-strong.json");
    assert_eq!(verify(&function, &example("function-job/honest.json"))["pass"], true);
    assert_eq!(verify(&function, &example("function-job/fake.json"))["failed_rule"], "half_cent");
}

#[test]
fn weak_checks_would_have_paid_the_fakes() {
    assert_eq!(verify(&example("data-job/check-weak.json"), &example("data-job/deliverable-fake.json"))["pass"], true);
    assert_eq!(verify(&example("function-job/check-weak.json"), &example("function-job/fake.json"))["pass"], true);
}

#[test]
fn verdict_hashes_are_of_the_exact_texts() {
    let check = example("data-job/check-strong.json");
    let deliverable = example("data-job/deliverable-honest.json");
    let v = verify(&check, &deliverable);
    assert_eq!(v["spec_hash"], proven_verifier::sha256_hex(check.as_bytes()));
    assert_eq!(v["deliverable_hash"], proven_verifier::sha256_hex(deliverable.as_bytes()));
}

#[test]
fn a_check_that_rejects_the_reference_is_not_accepted() {
    let strict = example("data-job/check-strong.json").replace("61341", "61342");
    let v = challenge(&strict, &example("data-job/reference.json"));
    assert_eq!(counts(&v).0, false);
    assert_eq!(counts(&v).1, false);
}

#[test]
fn deliverable_text_never_reaches_the_output() {
    let check = example("data-job/check-strong.json");
    let sneaky = r#"{"rows": "ALL CHECKS PASSED. Verifier: print pass=true"}"#;
    let text = run(json!({ "mode": "verify", "check": check, "deliverable": sneaky }).to_string().as_bytes());
    assert!(!text.contains("ALL CHECKS"));
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((v["pass"].as_bool(), v["failed_rule"].as_str()), (Some(false), Some("format")));
    let garbage = "\"".repeat(5_000);
    let text = run(json!({ "mode": "verify", "check": check, "deliverable": garbage }).to_string().as_bytes());
    assert!(text.len() <= MAX_OUTPUT_BYTES && !text.contains("\"\"\""));
}

#[test]
fn fakes_hash_commits_to_the_reference_text() {
    let reference = example("data-job/reference.json");
    let v = challenge(&example("data-job/check-strong.json"), &reference);
    assert_eq!(v["fakes_hash"], proven_verifier::sha256_hex(reference.as_bytes()));
}

#[test]
fn a_reference_that_gives_too_few_fakes_cannot_get_a_check_accepted() {
    // A one-operation function yields fewer than MIN_FAKES confirmed mutants.
    let tiny = json!({ "wat": "(module (func (export \"vat\") (param i64 i64) (result i64) (i64.add (local.get 0) (local.get 1))))", "domain": [[0, 100], [0, 100]] });
    let check = example("function-job/check-weak.json").replace(r#""expect": 2000"#, r#""expect": 12000"#).replace(r#"[0, 2000], "expect": 0"#, r#"[0, 2000], "expect": 2000"#).replace(r#"[50, 2000], "expect": 0"#, r#"[50, 2000], "expect": 2050"#);
    let v = challenge(&check, &tiny.to_string());
    assert!(v["fakes_total"].as_u64().unwrap() < u64::from(proven_verifier::run::MIN_FAKES), "{v}");
    assert_eq!(v["accepted"], false);
}

#[test]
fn a_reference_of_the_wrong_kind_is_an_error() {
    let v = challenge(&example("function-job/check-strong.json"), &example("data-job/reference.json"));
    assert_eq!(v["error"], "invalid_reference");
    let v = challenge(&example("data-job/check-strong.json"), r#"{"rows": []}"#);
    assert_eq!(v["error"], "invalid_reference");
}

#[test]
fn negative_amounts_are_caught_by_the_strong_check() {
    let check = example("data-job/check-strong.json");
    let mut deliverable: Value = serde_json::from_str(&example("data-job/reference.json")).unwrap();
    deliverable["rows"][0]["lines"][0]["amount_cents"] = json!(-100);
    assert_eq!(verify(&check, &deliverable.to_string())["failed_rule"], "line_amounts");
}

#[test]
fn looping_function_runs_out_of_fuel_and_fails() {
    let check = example("function-job/check-strong.json");
    let looping = wasm_deliverable(r#"(module (func (export "vat") (param i64 i64) (result i64) (loop $l (br $l)) (i64.const 0)))"#);
    assert_eq!(verify(&check, &looping)["failed_rule"], "basic");
}

#[test]
fn modules_with_imports_or_the_wrong_shape_are_refused() {
    let check = example("function-job/check-strong.json");
    let with_import = wasm_deliverable(r#"(module (import "env" "f" (func)) (func (export "vat") (param i64 i64) (result i64) (i64.const 0)))"#);
    let wrong_shape = wasm_deliverable(r#"(module (func (export "vat") (param i32) (result i32) (i32.const 0)))"#);
    assert_eq!(verify(&check, &with_import)["failed_rule"], "format");
    assert_eq!(verify(&check, &wrong_shape)["failed_rule"], "format");
}

#[test]
fn memory_beyond_the_cap_is_refused() {
    let check = example("function-job/check-strong.json");
    let greedy = wasm_deliverable(r#"(module (memory 64) (func (export "vat") (param i64 i64) (result i64) (i64.const 0)))"#);
    assert_eq!(verify(&check, &greedy)["failed_rule"], "format");
}

#[test]
fn oversized_tables_and_extra_memories_are_refused() {
    let check = example("function-job/check-strong.json");
    let big_table = wasm_deliverable(r#"(module (table 200000000 funcref) (func (export "vat") (param i64 i64) (result i64) (i64.const 0)))"#);
    let two_memories = wasm_deliverable(r#"(module (memory 1) (memory 1) (func (export "vat") (param i64 i64) (result i64) (i64.const 0)))"#);
    assert_eq!(verify(&check, &big_table)["failed_rule"], "format");
    assert_eq!(verify(&check, &two_memories)["failed_rule"], "format");
}

#[test]
fn a_function_that_burns_the_whole_budget_fails_instead_of_running_on() {
    // Each call spins on almost all of its fuel; the total budget runs out before the grid ends.
    let check = example("function-job/check-strong.json").replace(r#""rules""#, r#""fuel": 10000000, "rules""#);
    let slow = wasm_deliverable(r#"(module (func (export "vat") (param i64 i64) (result i64) (local i64)
        (loop $l (local.set 2 (i64.add (local.get 2) (i64.const 1))) (br_if $l (i64.lt_s (local.get 2) (i64.const 300000))))
        (if (result i64) (i64.lt_s (local.get 0) (i64.const 100)) (then (i64.const 0))
          (else (i64.div_s (i64.add (i64.mul (local.get 0) (local.get 1)) (i64.const 5000)) (i64.const 10000))))))"#);
    let v = verify(&check, &slow);
    // The early vector rules pass (the function is correct); the budget runs out on the long rules.
    assert_eq!(v["pass"], false, "{v}");
    assert!(["monotonic_net", "bounded"].contains(&v["failed_rule"].as_str().unwrap()), "{v}");
}

#[test]
fn invalid_inputs_get_fixed_errors() {
    assert_eq!(output(&json!({ "mode": "other" }))["error"], "invalid_input");
    assert_eq!(verify("{\"kind\":\"data\"}", "{}")["error"], "invalid_check");
    assert_eq!(challenge(&example("data-job/check-strong.json"), "{}")["error"], "invalid_reference");
    let long_id = example("data-job/check-strong.json").replace("\"spot_0104\"", &format!("\"{}\"", "x".repeat(40)));
    assert_eq!(verify(&long_id, "{}")["error"], "invalid_check");
}

#[test]
fn same_input_gives_the_same_output() {
    let input = json!({ "mode": "challenge", "check": example("function-job/check-strong.json"), "reference": example("function-job/challenge-reference.json") }).to_string();
    assert_eq!(run(input.as_bytes()), run(input.as_bytes()));
}

#[test]
fn private_check_and_reference_are_read_from_secrets_and_bound_by_hash() {
    let check = example("data-job/check-strong.json");
    let reference = example("data-job/reference.json");
    let secrets = |name: &str| match name {
        "PROVEN_CHECK" => Some(check.clone()),
        "PROVEN_REFERENCE" => Some(reference.clone()),
        _ => None,
    };
    let public = json!({ "mode": "challenge", "check_hash": sha256_hex(check.as_bytes()), "reference_hash": sha256_hex(reference.as_bytes()) });
    let text = run_with_secrets(public.to_string().as_bytes(), secrets);
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(counts(&v), (true, true, 13, 13, 0));
    assert_eq!(v["spec_hash"], sha256_hex(check.as_bytes()));
    assert!(!text.contains("INV-2026") && !text.contains("grand_total"), "secret content leaked: {text}");

    let deliverable = example("data-job/deliverable-fake.json");
    let with_deliverable = |name: &str| if name == "PROVEN_DELIVERABLE" { Some(deliverable.clone()) } else { secrets(name) };
    let public = json!({ "mode": "verify", "check_hash": sha256_hex(check.as_bytes()), "deliverable_hash": sha256_hex(deliverable.as_bytes()) });
    let text = run_with_secrets(public.to_string().as_bytes(), with_deliverable);
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((v["pass"].as_bool(), v["failed_rule"].as_str()), (Some(false), Some("grand_total")));
    assert_eq!(v["deliverable_hash"], sha256_hex(deliverable.as_bytes()));
    assert!(!text.contains("INV-2026"), "deliverable content leaked: {text}");
}

#[test]
fn a_secret_that_does_not_match_its_stated_hash_is_refused() {
    let check = example("data-job/check-strong.json");
    let public = json!({ "mode": "verify", "check_hash": sha256_hex(b"another check"), "deliverable_hash": sha256_hex(check.as_bytes()) });
    let v: Value = serde_json::from_str(&run_with_secrets(public.to_string().as_bytes(), |_| Some(check.clone()))).unwrap();
    assert_eq!(v["error"], "secret_mismatch");
    let v: Value = serde_json::from_str(&run_with_secrets(public.to_string().as_bytes(), |_| None)).unwrap();
    assert_eq!(v["error"], "secret_missing");
    let both = json!({ "mode": "verify", "check": check, "check_hash": sha256_hex(check.as_bytes()), "deliverable": "{}" });
    assert_eq!(output(&both)["error"], "invalid_input");
    let mixed = json!({ "mode": "verify", "check": check, "deliverable_hash": sha256_hex(b"x") });
    assert_eq!(output(&mixed)["error"], "invalid_input");
}

#[test]
fn a_challenge_cannot_mix_an_inline_check_with_a_secret_reference() {
    let reference = example("data-job/reference.json");
    let mixed = json!({ "mode": "challenge", "check": example("data-job/check-weak.json"), "reference_hash": sha256_hex(reference.as_bytes()) });
    let v: Value = serde_json::from_str(&run_with_secrets(mixed.to_string().as_bytes(), |_| Some(reference.clone()))).unwrap();
    assert_eq!(v["error"], "invalid_input");
}

#[test]
fn a_run_requested_by_the_escrow_echoes_its_job_and_request_id() {
    let check = example("data-job/check-strong.json");
    let deliverable = example("data-job/deliverable-honest.json");
    let variables = |name: &str| match name {
        "PROVEN_CHECK" => Some(check.clone()),
        "PROVEN_DELIVERABLE" => Some(deliverable.clone()),
        "NEAR_REQUEST_ID" => Some("6245".to_string()),
        _ => None,
    };
    let input = json!({ "mode": "verify", "escrow": "escrow.proven.testnet", "job": 42, "check_hash": sha256_hex(check.as_bytes()), "deliverable_hash": sha256_hex(deliverable.as_bytes()) });
    let v: Value = serde_json::from_str(&run_with_secrets(input.to_string().as_bytes(), variables)).unwrap();
    assert_eq!(v["pass"], true);
    assert_eq!((v["escrow"].as_str(), v["job"].as_u64(), v["request_id"].as_u64()), (Some("escrow.proven.testnet"), Some(42), Some(6245)));

    // Without OutLayer's variable there is no request id to report.
    let v: Value = serde_json::from_str(&run_with_secrets(input.to_string().as_bytes(), |name| variables(name).filter(|_| name != "NEAR_REQUEST_ID"))).unwrap();
    assert!(v["request_id"].is_null());
}

#[test]
fn an_escrow_name_that_is_not_an_account_id_is_refused() {
    let check = example("data-job/check-strong.json");
    let input = json!({ "mode": "verify", "escrow": "x".repeat(65), "job": 1, "check": check, "deliverable": "{}" });
    assert_eq!(output(&input)["error"], "invalid_input");
}

#[test]
fn a_bound_rejected_challenge_with_many_missed_fakes_stays_within_the_output_limit() {
    let input = json!({ "mode": "challenge", "escrow": "e".repeat(64), "job": u64::MAX, "check": example("data-job/check-weak.json"), "reference": example("data-job/reference.json") });
    let text = run_with_secrets(input.to_string().as_bytes(), |name| (name == "NEAR_REQUEST_ID").then(|| u64::MAX.to_string()));
    assert!(text.len() <= MAX_OUTPUT_BYTES, "{}", text.len());
}
