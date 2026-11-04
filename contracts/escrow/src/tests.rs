use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const SPEC: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const FAKES: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const DELIVERABLE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const OTHER_HASH: &str = "4444444444444444444444444444444444444444444444444444444444444444";
const VERIFIER_URL: &str = "https://example.test/verifier.wasm";
const VERIFIER: &str = "5555555555555555555555555555555555555555555555555555555555555555";
const SEC: u64 = 1_000_000_000;
const START: u64 = 1_000 * SEC;
const DEADLINE: u64 = START + 3_600 * SEC;
const WINDOW_SECS: u32 = 1_800;
const DELIVERED_AT: u64 = START + 60 * SEC;
const WINDOW_END: u64 = DELIVERED_AT + WINDOW_SECS as u64 * SEC;
const RUN_DEPOSIT: NearToken = NearToken::from_millinear(100);

fn owner() -> AccountId { accounts(0) }
fn relay() -> AccountId { accounts(1) }
fn buyer() -> AccountId { accounts(2) }
fn worker() -> AccountId { accounts(3) }
fn stranger() -> AccountId { accounts(4) }
fn this_contract() -> AccountId { accounts(5) }
fn token() -> AccountId { "usd.token.near".parse().unwrap() }
fn outlayer() -> AccountId { "outlayer.testnet".parse().unwrap() }

fn context(who: AccountId, deposit: NearToken, at: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(this_contract())
        .predecessor_account_id(who)
        .attached_deposit(deposit)
        .block_timestamp(at)
        .prepaid_gas(Gas::from_tgas(300));
    builder
}

fn call(who: AccountId, deposit: NearToken, at: u64) {
    testing_env!(context(who, deposit, at).build());
}

/// The callback of the escrow's own promise, seeing `result`.
fn callback_context(result: PromiseResult, at: u64) {
    let built = context(this_contract(), zero(), at).build();
    testing_env!(built, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn zero() -> NearToken { NearToken::from_yoctonear(0) }
fn one_near() -> NearToken { NearToken::from_near(1) }

fn escrow() -> Escrow {
    call(owner(), zero(), START);
    let mut escrow = Escrow::new(owner(), outlayer(), VERIFIER_URL.into(), VERIFIER.into(), relay());
    escrow.add_token(token());
    escrow
}

fn create(escrow: &mut Escrow, token: Option<AccountId>) -> JobId {
    call(buyer(), NearToken::from_millinear(50), START);
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(one_near().as_yoctonear()), token, U64(DEADLINE), WINDOW_SECS, VERIFIER.into())
}

fn challenge_output(id: JobId, reference_passed: bool, total: u32, caught: u32) -> serde_json::Value {
    json!({
        "v": 1, "mode": "challenge", "error": null, "escrow": this_contract(), "job": id, "request_id": 700,
        "spec_hash": SPEC, "fakes_hash": FAKES, "reference_passed": reference_passed,
        "fakes_total": total, "fakes_caught": caught, "fakes_unconfirmed": 0, "accepted": false, "missed": [],
    })
}

fn verify_output(id: JobId, pass: bool) -> serde_json::Value {
    json!({
        "v": 1, "mode": "verify", "error": null, "escrow": this_contract(), "job": id, "request_id": 701,
        "spec_hash": SPEC, "deliverable_hash": DELIVERABLE, "pass": pass,
        "failed_rule": if pass { None } else { Some("grand_total") },
    })
}

fn returned(escrow: &mut Escrow, id: JobId, attempt: u32, kind: RunKind, result: PromiseResult, at: u64) -> bool {
    callback_context(result, at);
    escrow.on_run_result(id, attempt, kind)
}

fn returned_json(escrow: &mut Escrow, id: JobId, attempt: u32, kind: RunKind, output: &serde_json::Value, at: u64) -> bool {
    returned(escrow, id, attempt, kind, PromiseResult::Successful(output.to_string().into_bytes()), at)
}

fn challenging(escrow: &mut Escrow, id: JobId) {
    call(stranger(), RUN_DEPOSIT, START);
    let _ = escrow.request_challenge(id);
}

fn challenge(escrow: &mut Escrow, id: JobId, reference_passed: bool, total: u32, caught: u32) -> bool {
    challenging(escrow, id);
    let attempt = escrow.get_job(id).unwrap().attempt;
    returned_json(escrow, id, attempt, RunKind::Challenge, &challenge_output(id, reference_passed, total, caught), START)
}

fn funded() -> (Escrow, JobId) {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(buyer(), one_near(), START);
    escrow.fund(id);
    (escrow, id)
}

fn delivered() -> (Escrow, JobId) {
    let (mut escrow, id) = funded();
    call(worker(), zero(), DELIVERED_AT);
    escrow.deliver(id, DELIVERABLE.into());
    (escrow, id)
}

const TRIGGERED_AT: u64 = START + 120 * SEC;

fn verifying() -> (Escrow, JobId, u32) {
    let (mut escrow, id) = delivered();
    call(stranger(), RUN_DEPOSIT, TRIGGERED_AT);
    let _ = escrow.request_verification(id);
    let attempt = escrow.get_job(id).unwrap().attempt;
    (escrow, id, attempt)
}

fn state(escrow: &Escrow, id: JobId) -> JobState {
    escrow.get_job(id).unwrap().state
}

// ---- A result has only one way in. `#[private]` itself is tested in the sandbox. ----

#[test]
fn a_callback_for_a_job_not_waiting_for_a_run_records_nothing() {
    let (mut escrow, id) = delivered();
    let attempt = escrow.get_job(id).unwrap().attempt;
    assert!(!returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    assert_eq!(state(&escrow, id), JobState::Delivered);
}

#[test]
fn a_callback_of_the_wrong_kind_records_nothing() {
    let (mut escrow, id, attempt) = verifying();
    assert!(!returned_json(&mut escrow, id, attempt, RunKind::Challenge, &challenge_output(id, true, 6, 6), TRIGGERED_AT));
    assert_eq!(state(&escrow, id), JobState::Verifying);
}

// ---- Verdicts ----

#[test]
fn a_pass_is_recorded_with_its_request_id_and_report_hash_and_pays_the_worker() {
    let (mut escrow, id, attempt) = verifying();
    let output = verify_output(id, true);
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &output, TRIGGERED_AT));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Passed);
    assert_eq!(job.verdict_request_id, Some(U64(701)));
    assert_eq!(job.report_hash, Some(sha256_hex(output.to_string().as_bytes())));
    assert_eq!(job.run_started_at, None);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    assert_eq!(state(&escrow, id), JobState::Releasing);
}

#[test]
fn a_fail_is_recorded_with_its_rule_and_refunds_the_buyer() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, false), TRIGGERED_AT));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(job.failed_rule.as_deref(), Some("grand_total"));
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.refund(id);
    assert_eq!(state(&escrow, id), JobState::Refunding);
}

/// Every way a run can fail to give a result: no verdict, retriable, and never a pass or a fail.
fn assert_no_verdict(result: PromiseResult) {
    let (mut escrow, id, attempt) = verifying();
    assert!(!returned(&mut escrow, id, attempt, RunKind::Verify, result, TRIGGERED_AT));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Delivered);
    assert_eq!((job.report_hash, job.verdict_request_id, job.failed_rule), (None, None, None));
    assert_eq!(job.run_started_at, None);
    // And it can be tried again.
    call(stranger(), RUN_DEPOSIT, TRIGGERED_AT + SEC);
    let _ = escrow.request_verification(id);
    assert_eq!(state(&escrow, id), JobState::Verifying);
}

fn with(id: JobId, field: &str, value: serde_json::Value) -> PromiseResult {
    let mut output = verify_output(id, true);
    output[field] = value;
    PromiseResult::Successful(output.to_string().into_bytes())
}

fn without(id: JobId, field: &str) -> PromiseResult {
    let mut output = verify_output(id, true);
    output.as_object_mut().unwrap().remove(field);
    PromiseResult::Successful(output.to_string().into_bytes())
}

#[test]
fn a_failed_promise_is_no_verdict() {
    assert_no_verdict(PromiseResult::Failed);
}

#[test]
fn null_output_from_a_failed_or_timed_out_run_is_no_verdict() {
    assert_no_verdict(PromiseResult::Successful(b"null".to_vec()));
}

#[test]
fn empty_output_is_no_verdict() {
    assert_no_verdict(PromiseResult::Successful(Vec::new()));
}

#[test]
fn malformed_output_is_no_verdict() {
    assert_no_verdict(PromiseResult::Successful(b"{\"pass\":true".to_vec()));
    assert_no_verdict(PromiseResult::Successful(b"\"pass\"".to_vec()));
    assert_no_verdict(PromiseResult::Successful(b"true".to_vec()));
}

#[test]
fn output_too_large_is_no_verdict() {
    let mut output = verify_output(0, true);
    output["padding"] = json!("x".repeat(MAX_RESULT_BYTES));
    assert_no_verdict(PromiseResult::Successful(output.to_string().into_bytes()));
}

#[test]
fn a_verifier_error_is_no_verdict() {
    assert_no_verdict(with(0, "error", json!("secret_missing")));
    assert_no_verdict(PromiseResult::Successful(br#"{"v":1,"mode":"verify","error":"secret_mismatch"}"#.to_vec()));
}

#[test]
fn output_for_another_job_is_no_verdict() {
    assert_no_verdict(with(0, "job", json!(99)));
}

#[test]
fn output_for_another_escrow_is_no_verdict() {
    assert_no_verdict(with(0, "escrow", json!("other.testnet")));
}

#[test]
fn output_for_another_check_is_no_verdict() {
    assert_no_verdict(with(0, "spec_hash", json!(OTHER_HASH)));
}

#[test]
fn output_for_another_deliverable_is_no_verdict() {
    assert_no_verdict(with(0, "deliverable_hash", json!(OTHER_HASH)));
}

#[test]
fn output_of_the_wrong_mode_or_version_is_no_verdict() {
    assert_no_verdict(with(0, "mode", json!("challenge")));
    assert_no_verdict(with(0, "v", json!(2)));
}

#[test]
fn output_with_no_request_id_is_no_verdict() {
    assert_no_verdict(with(0, "request_id", json!(null)));
    assert_no_verdict(without(0, "request_id"));
}

#[test]
fn output_without_a_boolean_pass_is_no_verdict() {
    assert_no_verdict(with(0, "pass", json!("true")));
    assert_no_verdict(without(0, "pass"));
}

#[test]
fn output_shape_tricks_are_no_verdict() {
    // A duplicate key, as JSON the serialiser would never produce.
    let mut text = verify_output(0, false).to_string();
    text.pop();
    text.push_str(",\"pass\":true}");
    assert_no_verdict(PromiseResult::Successful(text.into_bytes()));
    assert_no_verdict(with(0, "job", json!("0")));
    assert_no_verdict(with(0, "job", json!(0.5)));
    assert_no_verdict(with(0, "request_id", json!("701")));
    assert_no_verdict(with(0, "request_id", json!(-1)));
    assert_no_verdict(with(0, "request_id", json!(1.5)));
    assert_no_verdict(with(0, "pass", json!(1)));
}

#[test]
fn extra_output_fields_change_nothing_and_large_request_ids_are_kept_exactly() {
    let (mut escrow, id, attempt) = verifying();
    let mut output = verify_output(id, true);
    output["request_id"] = json!(u64::MAX);
    output["accepted"] = json!(false);
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &output, TRIGGERED_AT));
    let job = escrow.get_job(id).unwrap();
    assert_eq!((job.state, job.verdict_request_id), (JobState::Passed, Some(U64(u64::MAX))));
}

#[test]
fn a_challenge_records_counts_and_ignores_the_outputs_own_accepted_field() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenging(&mut escrow, id);
    let mut output = challenge_output(id, true, 13, 4);
    output["accepted"] = json!(true);
    assert!(returned_json(&mut escrow, id, 1, RunKind::Challenge, &output, START));
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
fn an_oversized_failed_rule_is_no_verdict() {
    let mut output = verify_output(0, false);
    output["failed_rule"] = json!("x".repeat(MAX_FAILED_RULE_LEN + 1));
    assert_no_verdict(PromiseResult::Successful(output.to_string().into_bytes()));
}

// ---- Exactly once ----

#[test]
#[should_panic(expected = "job is not awaiting verification")]
fn a_second_trigger_while_a_run_is_in_flight_is_refused() {
    let (mut escrow, id, _) = verifying();
    call(stranger(), RUN_DEPOSIT, TRIGGERED_AT + SEC);
    let _ = escrow.request_verification(id);
}

#[test]
fn a_second_callback_changes_nothing() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, false), TRIGGERED_AT));
    assert!(!returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    assert_eq!(state(&escrow, id), JobState::Failed);
}

#[test]
#[should_panic(expected = "job is not awaiting verification")]
fn a_trigger_after_a_verdict_is_refused() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    call(stranger(), RUN_DEPOSIT, TRIGGERED_AT + SEC);
    let _ = escrow.request_verification(id);
}

#[test]
fn a_run_whose_callback_never_came_can_be_triggered_again_and_the_late_callback_is_ignored() {
    let (mut escrow, id, first) = verifying();
    // The first callback ran out of gas, say: it never recorded anything.
    let stale = TRIGGERED_AT + RUN_TIMEOUT_NANOS + 1;
    call(stranger(), RUN_DEPOSIT, stale);
    let _ = escrow.request_verification(id);
    let second = escrow.get_job(id).unwrap().attempt;
    assert_eq!(second, first + 1);
    // A late callback from the first run records nothing and leaves the second in flight.
    assert!(!returned_json(&mut escrow, id, first, RunKind::Verify, &verify_output(id, true), stale));
    assert_eq!(state(&escrow, id), JobState::Verifying);
    assert!(returned_json(&mut escrow, id, second, RunKind::Verify, &verify_output(id, false), stale));
    assert_eq!(state(&escrow, id), JobState::Failed);
}

#[test]
#[should_panic(expected = "job is not awaiting verification")]
fn a_run_cannot_be_retriggered_before_it_is_stale() {
    let (mut escrow, id, _) = verifying();
    call(stranger(), RUN_DEPOSIT, TRIGGERED_AT + RUN_TIMEOUT_NANOS);
    let _ = escrow.request_verification(id);
}

// ---- Windows and expiry ----

#[test]
#[should_panic(expected = "the verdict window has closed")]
fn a_trigger_after_the_window_is_refused() {
    let (mut escrow, id) = delivered();
    call(stranger(), RUN_DEPOSIT, WINDOW_END + 1);
    let _ = escrow.request_verification(id);
}

#[test]
#[should_panic(expected = "the verdict window has closed")]
fn a_stale_run_cannot_be_retriggered_after_the_window() {
    let (mut escrow, id, _) = verifying();
    call(stranger(), RUN_DEPOSIT, WINDOW_END + RUN_TIMEOUT_NANOS + 1);
    let _ = escrow.request_verification(id);
}

#[test]
fn a_result_for_a_run_started_in_the_window_counts_even_if_it_lands_after_it() {
    let (mut escrow, id) = delivered();
    call(stranger(), RUN_DEPOSIT, WINDOW_END);
    let _ = escrow.request_verification(id);
    let attempt = escrow.get_job(id).unwrap().attempt;
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), WINDOW_END + 5 * SEC));
    assert_eq!(state(&escrow, id), JobState::Passed);
}

#[test]
#[should_panic(expected = "job has not expired")]
fn a_run_in_flight_blocks_expiry_until_it_is_stale() {
    let (mut escrow, id) = delivered();
    call(stranger(), RUN_DEPOSIT, WINDOW_END);
    let _ = escrow.request_verification(id);
    call(stranger(), zero(), WINDOW_END + RUN_TIMEOUT_NANOS);
    let _ = escrow.expire(id);
}

#[test]
fn a_stale_run_after_the_window_expires_to_the_buyer_and_its_late_callback_is_ignored() {
    let (mut escrow, id, attempt) = verifying();
    let late = WINDOW_END + RUN_TIMEOUT_NANOS + 1;
    call(stranger(), zero(), late);
    let _ = escrow.expire(id);
    assert_eq!(state(&escrow, id), JobState::Expiring);
    assert!(!returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), late));
    assert_eq!(state(&escrow, id), JobState::Expiring);
    callback_context(PromiseResult::Successful(vec![]), late);
    assert!(escrow.on_payout(id, JobState::Expired, JobState::Verifying));
    assert!(!returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), late));
    assert_eq!(state(&escrow, id), JobState::Expired);
}

#[test]
fn a_delivered_job_with_no_verdict_expires_after_the_window() {
    let (mut escrow, id) = delivered();
    call(stranger(), zero(), WINDOW_END + 1);
    let _ = escrow.expire(id);
    assert_eq!(state(&escrow, id), JobState::Expiring);
}

#[test]
#[should_panic(expected = "job has not expired")]
fn a_delivered_job_cannot_expire_inside_the_window() {
    let (mut escrow, id) = delivered();
    call(stranger(), zero(), WINDOW_END);
    let _ = escrow.expire(id);
}

#[test]
#[should_panic(expected = "job has not expired")]
fn funded_job_cannot_expire_before_deadline() {
    let (mut escrow, id) = funded();
    call(stranger(), zero(), DEADLINE);
    let _ = escrow.expire(id);
}

#[test]
fn funded_job_expires_after_deadline() {
    let (mut escrow, id) = funded();
    call(stranger(), zero(), DEADLINE + 1);
    let _ = escrow.expire(id);
    assert_eq!(state(&escrow, id), JobState::Expiring);
}

#[test]
#[should_panic(expected = "job has not expired")]
fn passed_job_cannot_expire() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    call(stranger(), zero(), DEADLINE + 10_000 * SEC);
    let _ = escrow.expire(id);
}

#[test]
fn a_failed_expiry_transfer_leaves_the_job_expirable() {
    let (mut escrow, id, _) = verifying();
    let late = WINDOW_END + RUN_TIMEOUT_NANOS + 1;
    call(stranger(), zero(), late);
    let _ = escrow.expire(id);
    callback_context(PromiseResult::Failed, late);
    assert!(!escrow.on_payout(id, JobState::Expired, JobState::Verifying));
    assert_eq!(state(&escrow, id), JobState::Verifying);
    call(stranger(), zero(), late + SEC);
    let _ = escrow.expire(id);
    assert_eq!(state(&escrow, id), JobState::Expiring);
}

#[test]
fn a_genuine_late_verdict_after_a_failed_expiry_is_recorded_once() {
    let (mut escrow, id, attempt) = verifying();
    let late = WINDOW_END + RUN_TIMEOUT_NANOS + 1;
    call(stranger(), zero(), late);
    let _ = escrow.expire(id);
    callback_context(PromiseResult::Failed, late);
    assert!(!escrow.on_payout(id, JobState::Expired, JobState::Verifying));
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), late));
    assert_eq!(state(&escrow, id), JobState::Passed);
    assert!(!returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, false), late));
    assert_eq!(state(&escrow, id), JobState::Passed);
}

// ---- Triggering ----

#[test]
fn anyone_can_trigger_a_run() {
    let (mut escrow, id) = delivered();
    call(worker(), RUN_DEPOSIT, TRIGGERED_AT);
    let _ = escrow.request_verification(id);
    assert_eq!(state(&escrow, id), JobState::Verifying);
}

#[test]
#[should_panic(expected = "attach between 0.1 and 1 NEAR")]
fn a_run_needs_the_minimum_deposit() {
    let (mut escrow, id) = delivered();
    call(stranger(), NearToken::from_millinear(99), TRIGGERED_AT);
    let _ = escrow.request_verification(id);
}

#[test]
#[should_panic(expected = "attach between 0.1 and 1 NEAR")]
fn a_run_refuses_more_than_the_maximum_deposit() {
    let (mut escrow, id) = delivered();
    call(stranger(), NearToken::from_millinear(1_001), TRIGGERED_AT);
    let _ = escrow.request_verification(id);
}

#[test]
#[should_panic(expected = "attach at least 150 Tgas")]
fn a_run_needs_enough_gas_to_guarantee_its_callback() {
    let (mut escrow, id) = delivered();
    testing_env!(context(stranger(), RUN_DEPOSIT, TRIGGERED_AT).prepaid_gas(Gas::from_tgas(149)).build());
    let _ = escrow.request_verification(id);
}

#[test]
#[should_panic(expected = "job is not awaiting verification")]
fn a_job_with_no_delivery_cannot_be_verified() {
    let (mut escrow, id) = funded();
    call(stranger(), RUN_DEPOSIT, TRIGGERED_AT);
    let _ = escrow.request_verification(id);
}

#[test]
fn the_run_input_is_only_hashes_and_the_job_binding() {
    let (escrow, id, _) = verifying();
    let job = escrow.get_job(id).unwrap();
    let input: serde_json::Value = serde_json::from_str(&job.run_input(id, RunKind::Verify, &this_contract())).unwrap();
    assert_eq!(input, json!({ "mode": "verify", "escrow": this_contract(), "job": id, "check_hash": SPEC, "deliverable_hash": DELIVERABLE }));
    let input: serde_json::Value = serde_json::from_str(&job.run_input(id, RunKind::Challenge, &this_contract())).unwrap();
    assert_eq!(input, json!({ "mode": "challenge", "escrow": this_contract(), "job": id, "check_hash": SPEC, "reference_hash": FAKES }));
    assert_eq!(job.secrets_profile(id, RunKind::Verify), format!("v{id}-{}", &DELIVERABLE[..12]));
    assert_eq!(job.secrets_profile(id, RunKind::Challenge), format!("c{id}-{}", &FAKES[..12]));
}

#[test]
fn a_job_keeps_the_verifier_and_secrets_owner_it_was_created_with() {
    let (mut escrow, id) = delivered();
    call(owner(), zero(), TRIGGERED_AT);
    escrow.set_verifier("https://example.test/other.wasm".into(), OTHER_HASH.into());
    escrow.set_secrets_owner(stranger());
    let job = escrow.get_job(id).unwrap();
    assert_eq!((job.verifier_hash.as_str(), job.verifier_url.as_str(), &job.secrets_owner), (VERIFIER, VERIFIER_URL, &relay()));
    let config = escrow.get_config();
    assert_eq!((config.verifier_hash.as_str(), &config.secrets_owner), (OTHER_HASH, &stranger()));
}

#[test]
#[should_panic(expected = "only the owner")]
fn a_stranger_cannot_change_the_verifier() {
    let mut escrow = escrow();
    call(stranger(), zero(), START);
    escrow.set_verifier(VERIFIER_URL.into(), OTHER_HASH.into());
}

#[test]
#[should_panic(expected = "only the owner")]
fn a_stranger_cannot_change_the_secrets_owner() {
    let mut escrow = escrow();
    call(stranger(), zero(), START);
    escrow.set_secrets_owner(stranger());
}

#[test]
#[should_panic(expected = "verifier_hash must be")]
fn an_invalid_verifier_hash_is_refused() {
    let mut escrow = escrow();
    call(owner(), zero(), START);
    escrow.set_verifier(VERIFIER_URL.into(), "abc".into());
}

#[test]
#[should_panic(expected = "verifier_url must be https")]
fn a_non_https_verifier_url_is_refused() {
    let mut escrow = escrow();
    call(owner(), zero(), START);
    escrow.set_verifier("http://example.test/v.wasm".into(), VERIFIER.into());
}

// ---- Challenge ----

#[test]
fn a_strong_check_is_challenged_with_its_request_id() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, 13, 13));
    let job = escrow.get_job(id).unwrap();
    assert_eq!((job.state, job.fakes_total, job.fakes_caught), (JobState::Challenged, 13, 13));
    assert_eq!(job.challenge_request_id, Some(U64(700)));
    assert!(job.challenge_report_hash.is_some());
}

#[test]
fn a_check_that_misses_a_fake_is_rejected_and_records_the_counts() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, 13, 4));
    let job = escrow.get_job(id).unwrap();
    assert_eq!((job.state, job.fakes_caught), (JobState::CheckRejected, 4));
}

#[test]
fn a_check_that_fails_the_reference_is_rejected() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, false, 6, 6));
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
fn a_check_that_faced_too_few_fakes_is_rejected() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, MIN_FAKES - 1, MIN_FAKES - 1));
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
fn a_challenge_failure_is_no_result_and_can_be_retried() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenging(&mut escrow, id);
    assert!(!returned(&mut escrow, id, 1, RunKind::Challenge, PromiseResult::Successful(b"null".to_vec()), START));
    assert_eq!(state(&escrow, id), JobState::Draft);
    challenging(&mut escrow, id);
    assert!(!returned(&mut escrow, id, 2, RunKind::Challenge, PromiseResult::Failed, START));
    assert_eq!(state(&escrow, id), JobState::Draft);
}

#[test]
fn a_challenge_output_that_does_not_match_the_job_is_no_result() {
    let cases: [(&str, serde_json::Value); 6] = [
        ("job", json!(99)),
        ("escrow", json!("other.testnet")),
        ("spec_hash", json!(OTHER_HASH)),
        ("fakes_hash", json!(OTHER_HASH)),
        ("mode", json!("verify")),
        ("fakes_caught", json!(7)),
    ];
    for (field, value) in cases {
        let mut escrow = escrow();
        let id = create(&mut escrow, None);
        challenging(&mut escrow, id);
        let mut output = challenge_output(id, true, 6, 6);
        output[field] = value;
        assert!(!returned_json(&mut escrow, id, 1, RunKind::Challenge, &output, START), "{field}");
        assert_eq!(state(&escrow, id), JobState::Draft, "{field}");
    }
}

#[test]
#[should_panic(expected = "job is not awaiting a challenge")]
fn a_second_challenge_after_a_result_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, 13, 4));
    challenging(&mut escrow, id);
}

#[test]
#[should_panic(expected = "job is not awaiting a challenge")]
fn a_second_challenge_trigger_in_flight_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenging(&mut escrow, id);
    challenging(&mut escrow, id);
}

#[test]
#[should_panic(expected = "the check must pass its challenge first")]
fn a_rejected_check_cannot_be_funded() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, 6, 5));
    call(buyer(), one_near(), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "the check must pass its challenge first")]
fn an_unchallenged_job_cannot_be_funded() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    call(buyer(), one_near(), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "the check must pass its challenge first")]
fn a_job_cannot_be_funded_while_its_challenge_is_in_flight() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenging(&mut escrow, id);
    call(buyer(), one_near(), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "only an unfunded job can be cancelled")]
fn a_job_cannot_be_cancelled_while_its_challenge_is_in_flight() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenging(&mut escrow, id);
    call(buyer(), zero(), START + SEC);
    let _ = escrow.cancel(id);
}

#[test]
fn a_stale_challenge_can_be_cancelled_and_its_late_callback_is_ignored() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenging(&mut escrow, id);
    let late = START + RUN_TIMEOUT_NANOS + 1;
    call(buyer(), zero(), late);
    let _ = escrow.cancel(id);
    assert!(!returned_json(&mut escrow, id, 1, RunKind::Challenge, &challenge_output(id, true, 6, 6), late));
    assert!(escrow.get_job(id).is_none());
}

// ---- Creating, funding, delivering, paying ----

#[test]
fn create_job_charges_storage_and_records_it() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    let job = escrow.get_job(id).unwrap();
    assert!(!job.storage_deposit.is_zero());
    assert_eq!(job.state, JobState::Draft);
}

#[test]
#[should_panic(expected = "attach at least")]
fn create_job_without_storage_deposit_is_refused() {
    let mut escrow = escrow();
    call(buyer(), zero(), START);
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(1), None, U64(DEADLINE), WINDOW_SECS, VERIFIER.into());
}

#[test]
#[should_panic(expected = "the worker cannot be the buyer")]
fn buyer_cannot_name_itself_as_worker() {
    let mut escrow = escrow();
    call(buyer(), NearToken::from_millinear(50), START);
    escrow.create_job(buyer(), SPEC.into(), FAKES.into(), U128(1), None, U64(DEADLINE), WINDOW_SECS, VERIFIER.into());
}

#[test]
#[should_panic(expected = "token is not accepted")]
fn unknown_token_is_refused() {
    let mut escrow = escrow();
    create(&mut escrow, Some(stranger()));
}

#[test]
#[should_panic(expected = "deadline must be in the future")]
fn past_deadline_is_refused() {
    let mut escrow = escrow();
    call(buyer(), NearToken::from_millinear(50), START);
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(1), None, U64(START), WINDOW_SECS, VERIFIER.into());
}

#[test]
#[should_panic(expected = "verdict_window_secs must be")]
fn a_verdict_window_too_short_for_a_retry_is_refused() {
    let mut escrow = escrow();
    call(buyer(), NearToken::from_millinear(50), START);
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(1), None, U64(DEADLINE), 1_799, VERIFIER.into());
}

#[test]
#[should_panic(expected = "pay exactly the job amount")]
fn underfunding_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(buyer(), NearToken::from_millinear(999), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "only the buyer can fund")]
fn stranger_cannot_fund() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(stranger(), one_near(), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "pay in the job's token")]
fn token_job_cannot_be_funded_in_near() {
    let mut escrow = escrow();
    let id = create(&mut escrow, Some(token()));
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(buyer(), one_near(), START);
    escrow.fund(id);
}

#[test]
fn token_job_is_funded_through_ft_on_transfer() {
    let mut escrow = escrow();
    let id = create(&mut escrow, Some(token()));
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(token(), zero(), START);
    let unused = escrow.ft_on_transfer(buyer(), U128(one_near().as_yoctonear()), id.to_string());
    assert!(matches!(unused, PromiseOrValue::Value(U128(0))));
    assert_eq!(state(&escrow, id), JobState::Funded);
}

#[test]
#[should_panic(expected = "token is not accepted")]
fn ft_on_transfer_from_unknown_token_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, Some(token()));
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(stranger(), zero(), START);
    let _ = escrow.ft_on_transfer(buyer(), U128(one_near().as_yoctonear()), id.to_string());
}

#[test]
#[should_panic(expected = "only the job's worker can deliver")]
fn front_running_delivery_is_refused() {
    let (mut escrow, id) = funded();
    call(stranger(), zero(), START + 60 * SEC);
    escrow.deliver(id, DELIVERABLE.into());
}

#[test]
#[should_panic(expected = "the delivery deadline has passed")]
fn late_delivery_is_refused() {
    let (mut escrow, id) = funded();
    call(worker(), zero(), DEADLINE + 1);
    escrow.deliver(id, DELIVERABLE.into());
}

#[test]
#[should_panic(expected = "attach at least 50 Tgas")]
fn a_payout_needs_enough_gas_to_guarantee_its_callback() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    testing_env!(context(stranger(), zero(), TRIGGERED_AT).prepaid_gas(Gas::from_tgas(49)).build());
    let _ = escrow.release(id);
}

#[test]
#[should_panic(expected = "verifier_hash is not the build this contract runs")]
fn a_buyer_who_expects_another_verifier_build_is_refused() {
    let mut escrow = escrow();
    call(buyer(), NearToken::from_millinear(50), START);
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(1), None, U64(DEADLINE), WINDOW_SECS, OTHER_HASH.into());
}

#[test]
#[should_panic(expected = "job has not passed")]
fn release_before_verdict_is_refused() {
    let (mut escrow, id) = delivered();
    let _ = escrow.release(id);
}

#[test]
#[should_panic(expected = "job has not passed")]
fn release_while_verifying_is_refused() {
    let (mut escrow, id, _) = verifying();
    let _ = escrow.release(id);
}

#[test]
#[should_panic(expected = "job has not passed")]
fn second_release_while_paying_is_refused() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    let _ = escrow.release(id);
}

#[test]
fn successful_payout_settles_the_job() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    callback_context(PromiseResult::Successful(vec![]), TRIGGERED_AT);
    assert!(escrow.on_payout(id, JobState::Released, JobState::Passed));
    assert_eq!(state(&escrow, id), JobState::Released);
}

#[test]
fn failed_payout_returns_the_job_for_a_retry() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(&mut escrow, id, attempt, RunKind::Verify, &verify_output(id, true), TRIGGERED_AT));
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    callback_context(PromiseResult::Failed, TRIGGERED_AT);
    assert!(!escrow.on_payout(id, JobState::Released, JobState::Passed));
    assert_eq!(state(&escrow, id), JobState::Passed);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    assert_eq!(state(&escrow, id), JobState::Releasing);
}

#[test]
fn unfunded_job_can_be_cancelled() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    call(buyer(), zero(), START);
    let _ = escrow.cancel(id);
    assert!(escrow.get_job(id).is_none());
}

#[test]
#[should_panic(expected = "only an unfunded job can be cancelled")]
fn funded_job_cannot_be_cancelled() {
    let (mut escrow, id) = funded();
    call(buyer(), zero(), START);
    let _ = escrow.cancel(id);
}

#[test]
#[should_panic(expected = "only the buyer can cancel")]
fn stranger_cannot_cancel() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    call(stranger(), zero(), START);
    let _ = escrow.cancel(id);
}

#[test]
fn get_jobs_pages_and_skips_cancelled() {
    let mut escrow = escrow();
    let first = create(&mut escrow, None);
    let second = create(&mut escrow, None);
    call(buyer(), zero(), START);
    let _ = escrow.cancel(first);
    let jobs = escrow.get_jobs(0, 10);
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].0, second);
}
