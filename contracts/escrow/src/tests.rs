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
const DEADLINE: u64 = START + 3_600 * SEC; // assigned at START with DELIVER_SECS
const WINDOW_SECS: u32 = 1_800;
const DELIVERED_AT: u64 = START + 60 * SEC;
const WINDOW_END: u64 = DELIVERED_AT + WINDOW_SECS as u64 * SEC;

const FORMAT: &str = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

fn owner() -> AccountId {
    accounts(0)
}
fn relay() -> AccountId {
    accounts(1)
}
fn buyer() -> AccountId {
    accounts(2)
}
fn worker() -> AccountId {
    accounts(3)
}
fn stranger() -> AccountId {
    accounts(4)
}
fn this_contract() -> AccountId {
    accounts(5)
}
fn outlayer() -> AccountId {
    "outlayer.testnet".parse().unwrap()
}

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
    testing_env!(
        built,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}
fn one_near() -> NearToken {
    NearToken::from_near(1)
}

const EXPIRES: u64 = START + 2 * 24 * 3_600 * SEC;
const DELIVER_SECS: u32 = 3_600;
const RUN: NearToken = NearToken::from_millinear(10);

fn board() -> AccountId {
    "board.near".parse().unwrap()
}

fn escrow() -> Escrow {
    call(owner(), zero(), START);
    Escrow::new(
        owner(),
        outlayer(),
        Some(board()),
        VERIFIER_URL.into(),
        VERIFIER.into(),
        relay(),
        U128(RUN.as_yoctonear()),
        U128(1_000 * NearToken::from_near(1).as_yoctonear()),
        U128(10_000 * NearToken::from_near(1).as_yoctonear()),
        U128(10_000 * NearToken::from_near(1).as_yoctonear()),
    )
}

/// What the board attaches for a one-NEAR job with `attempts` attempts: generous on storage.
fn posting(attempts: u32) -> NearToken {
    one_near()
        .saturating_add(budget_for(attempts, RUN))
        .saturating_add(NearToken::from_millinear(50))
}

fn create_with(escrow: &mut Escrow, attempts: u32) -> JobId {
    call(board(), posting(attempts), START);
    escrow.create_open_job(
        buyer(),
        SPEC.into(),
        FAKES.into(),
        FORMAT.into(),
        U128(one_near().as_yoctonear()),
        VERIFIER.into(),
        U64(EXPIRES),
        DELIVER_SECS,
        WINDOW_SECS,
        attempts,
    )
}

fn create(escrow: &mut Escrow) -> JobId {
    create_with(escrow, 1)
}

fn challenging(escrow: &mut Escrow, id: JobId) {
    call(relay(), zero(), START);
    let _ = escrow.request_challenge(id);
}

fn challenge(
    escrow: &mut Escrow,
    id: JobId,
    reference_passed: bool,
    total: u32,
    caught: u32,
) -> bool {
    challenging(escrow, id);
    let attempt = escrow.get_job(id).unwrap().attempt;
    returned_json(
        escrow,
        id,
        attempt,
        RunKind::Challenge,
        &challenge_output(id, reference_passed, total, caught),
        START,
    )
}

fn assign(escrow: &mut Escrow, id: JobId, at: u64) {
    call(board(), zero(), at);
    escrow.assign(id, worker());
}

fn funded_with(attempts: u32) -> (Escrow, JobId) {
    let mut escrow = escrow();
    let id = create_with(&mut escrow, attempts);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    assign(&mut escrow, id, START);
    (escrow, id)
}

fn funded() -> (Escrow, JobId) {
    funded_with(1)
}

fn challenge_output(
    id: JobId,
    reference_passed: bool,
    total: u32,
    caught: u32,
) -> serde_json::Value {
    json!({
        "v": 2, "format_hash": FORMAT, "mode": "challenge", "error": null, "escrow": this_contract(), "job": id, "request_id": 700,
        "spec_hash": SPEC, "fakes_hash": FAKES, "reference_passed": reference_passed,
        "fakes_total": total, "fakes_caught": caught, "fakes_unconfirmed": 0, "accepted": false, "missed": [],
    })
}

fn verify_output(id: JobId, pass: bool) -> serde_json::Value {
    json!({
        "v": 2, "format_hash": FORMAT, "mode": "verify", "error": null, "escrow": this_contract(), "job": id, "request_id": 701,
        "spec_hash": SPEC, "deliverable_hash": DELIVERABLE, "pass": pass,
        "failed_rule": if pass { None } else { Some("grand_total") },
    })
}

fn returned(
    escrow: &mut Escrow,
    id: JobId,
    attempt: u32,
    kind: RunKind,
    result: PromiseResult,
    at: u64,
) -> bool {
    callback_context(result, at);
    escrow.on_run_result(id, attempt, kind)
}

fn returned_json(
    escrow: &mut Escrow,
    id: JobId,
    attempt: u32,
    kind: RunKind,
    output: &serde_json::Value,
    at: u64,
) -> bool {
    returned(
        escrow,
        id,
        attempt,
        kind,
        PromiseResult::Successful(output.to_string().into_bytes()),
        at,
    )
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
    call(relay(), zero(), TRIGGERED_AT);
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
    assert!(!returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, true),
        TRIGGERED_AT
    ));
    assert_eq!(state(&escrow, id), JobState::Delivered);
}

#[test]
fn a_callback_of_the_wrong_kind_records_nothing() {
    let (mut escrow, id, attempt) = verifying();
    assert!(!returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Challenge,
        &challenge_output(id, true, 6, 6),
        TRIGGERED_AT
    ));
    assert_eq!(state(&escrow, id), JobState::Verifying);
}

// ---- Verdicts ----

#[test]
fn a_pass_is_recorded_with_its_request_id_and_report_hash_and_pays_the_worker() {
    let (mut escrow, id, attempt) = verifying();
    let output = verify_output(id, true);
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &output,
        TRIGGERED_AT
    ));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Passed);
    assert_eq!(job.verdict_request_id, Some(U64(701)));
    assert_eq!(
        job.report_hash,
        Some(sha256_hex(output.to_string().as_bytes()))
    );
    assert_eq!(job.run_started_at, None);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    assert_eq!(state(&escrow, id), JobState::Releasing);
}

fn assert_no_verdict(result: PromiseResult) {
    let (mut escrow, id, attempt) = verifying();
    assert!(!returned(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        result,
        TRIGGERED_AT
    ));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Delivered);
    assert_eq!(
        (job.report_hash, job.verdict_request_id, job.failed_rule),
        (None, None, None)
    );
    assert_eq!(job.run_started_at, None);
    // And it can be tried again.
    call(relay(), zero(), TRIGGERED_AT + SEC);
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
    assert_no_verdict(PromiseResult::Successful(
        br#"{"v":1,"mode":"verify","error":"secret_mismatch"}"#.to_vec(),
    ));
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
    assert_no_verdict(with(0, "v", json!(3)));
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
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &output,
        TRIGGERED_AT
    ));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(
        (job.state, job.verdict_request_id),
        (JobState::Passed, Some(U64(u64::MAX)))
    );
}

#[test]
fn a_challenge_records_counts_and_ignores_the_outputs_own_accepted_field() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    challenging(&mut escrow, id);
    let mut output = challenge_output(id, true, 13, 4);
    output["accepted"] = json!(true);
    assert!(returned_json(
        &mut escrow,
        id,
        1,
        RunKind::Challenge,
        &output,
        START
    ));
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
    call(relay(), zero(), TRIGGERED_AT + SEC);
    let _ = escrow.request_verification(id);
}

#[test]
fn a_second_callback_changes_nothing() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, false),
        TRIGGERED_AT
    ));
    assert!(!returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, true),
        TRIGGERED_AT
    ));
    assert_eq!(state(&escrow, id), JobState::Failed);
}

#[test]
#[should_panic(expected = "job is not awaiting verification")]
fn a_trigger_after_a_verdict_is_refused() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, true),
        TRIGGERED_AT
    ));
    call(relay(), zero(), TRIGGERED_AT + SEC);
    let _ = escrow.request_verification(id);
}

#[test]
fn a_run_whose_callback_never_came_can_be_triggered_again_and_the_late_callback_is_ignored() {
    let (mut escrow, id, first) = verifying();
    // The first callback ran out of gas, say: it never recorded anything.
    let stale = TRIGGERED_AT + RUN_TIMEOUT_NANOS + 1;
    call(relay(), zero(), stale);
    let _ = escrow.request_verification(id);
    let second = escrow.get_job(id).unwrap().attempt;
    assert_eq!(second, first + 1);
    // A late callback from the first run records nothing and leaves the second in flight.
    assert!(!returned_json(
        &mut escrow,
        id,
        first,
        RunKind::Verify,
        &verify_output(id, true),
        stale
    ));
    assert_eq!(state(&escrow, id), JobState::Verifying);
    assert!(returned_json(
        &mut escrow,
        id,
        second,
        RunKind::Verify,
        &verify_output(id, false),
        stale
    ));
    assert_eq!(state(&escrow, id), JobState::Failed);
}

#[test]
#[should_panic(expected = "job is not awaiting verification")]
fn a_run_cannot_be_retriggered_before_it_is_stale() {
    let (mut escrow, id, _) = verifying();
    call(relay(), zero(), TRIGGERED_AT + RUN_TIMEOUT_NANOS);
    let _ = escrow.request_verification(id);
}

// ---- Windows and expiry ----

#[test]
#[should_panic(expected = "the verdict window has closed")]
fn a_trigger_after_the_window_is_refused() {
    let (mut escrow, id) = delivered();
    call(relay(), zero(), WINDOW_END + 1);
    let _ = escrow.request_verification(id);
}

#[test]
#[should_panic(expected = "the verdict window has closed")]
fn a_stale_run_cannot_be_retriggered_after_the_window() {
    let (mut escrow, id, _) = verifying();
    call(relay(), zero(), WINDOW_END + RUN_TIMEOUT_NANOS + 1);
    let _ = escrow.request_verification(id);
}

#[test]
fn a_result_for_a_run_started_in_the_window_counts_even_if_it_lands_after_it() {
    let (mut escrow, id) = delivered();
    call(relay(), zero(), WINDOW_END);
    let _ = escrow.request_verification(id);
    let attempt = escrow.get_job(id).unwrap().attempt;
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, true),
        WINDOW_END + 5 * SEC
    ));
    assert_eq!(state(&escrow, id), JobState::Passed);
}

#[test]
#[should_panic(expected = "job has not expired")]
fn a_run_in_flight_blocks_expiry_until_it_is_stale() {
    let (mut escrow, id) = delivered();
    call(relay(), zero(), WINDOW_END);
    let _ = escrow.request_verification(id);
    call(stranger(), zero(), WINDOW_END + RUN_TIMEOUT_NANOS);
    let _ = escrow.expire(id);
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
#[should_panic(expected = "job has not expired")]
fn passed_job_cannot_expire() {
    let (mut escrow, id, attempt) = verifying();
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, true),
        TRIGGERED_AT
    ));
    call(stranger(), zero(), DEADLINE + 10_000 * SEC);
    let _ = escrow.expire(id);
}

#[test]
fn a_callback_is_accepted_at_the_timeout_boundary_but_not_after_it() {
    for (offset, expected) in [(RUN_TIMEOUT_NANOS, true), (RUN_TIMEOUT_NANOS + 1, false)] {
        let (mut escrow, id, attempt) = verifying();
        assert_eq!(
            returned_json(
                &mut escrow,
                id,
                attempt,
                RunKind::Verify,
                &verify_output(id, true),
                TRIGGERED_AT + offset
            ),
            expected
        );
        assert_eq!(
            state(&escrow, id),
            if expected {
                JobState::Passed
            } else {
                JobState::Delivered
            }
        );
    }
}

#[test]
fn a_stale_challenge_callback_cannot_accept_or_reject_the_check() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    challenging(&mut escrow, id);
    assert!(!returned_json(
        &mut escrow,
        id,
        1,
        RunKind::Challenge,
        &challenge_output(id, true, 13, 13),
        START + RUN_TIMEOUT_NANOS + 1
    ));
    assert_eq!(state(&escrow, id), JobState::Draft);
}

// ---- Triggering ----

#[test]
fn the_worker_can_start_its_own_verification() {
    let (mut escrow, id) = delivered();
    call(worker(), zero(), TRIGGERED_AT);
    let _ = escrow.request_verification(id);
    assert_eq!(state(&escrow, id), JobState::Verifying);
}

#[test]
#[should_panic(expected = "only the relay or the job's worker can start verification")]
fn the_buyer_cannot_spend_the_budget_on_verification_runs() {
    let (mut escrow, id) = delivered();
    call(buyer(), zero(), TRIGGERED_AT);
    let _ = escrow.request_verification(id);
}

#[test]
#[should_panic(expected = "only the relay or the buyer can start the challenge")]
fn a_stranger_cannot_spend_the_budget_on_challenge_runs() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    call(stranger(), zero(), START);
    let _ = escrow.request_challenge(id);
}

#[test]
#[should_panic(expected = "this job has finished")]
fn a_finished_job_takes_no_top_up() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    escrow.jobs.get_mut(&id).unwrap().state = JobState::Expired;
    call(buyer(), RUN, START);
    escrow.top_up(id);
}

#[test]
#[should_panic(expected = "attach at least 150 Tgas")]
fn a_run_needs_enough_gas_to_guarantee_its_callback() {
    let (mut escrow, id) = delivered();
    testing_env!(context(relay(), zero(), TRIGGERED_AT)
        .prepaid_gas(Gas::from_tgas(149))
        .build());
    let _ = escrow.request_verification(id);
}

#[test]
#[should_panic(expected = "job is not awaiting verification")]
fn a_job_with_no_delivery_cannot_be_verified() {
    let (mut escrow, id) = funded();
    call(relay(), zero(), TRIGGERED_AT);
    let _ = escrow.request_verification(id);
}

#[test]
fn the_run_input_is_only_hashes_and_the_job_binding() {
    let (escrow, id, _) = verifying();
    let job = escrow.get_job(id).unwrap();
    let input: serde_json::Value =
        serde_json::from_str(&job.run_input(id, RunKind::Verify, &this_contract())).unwrap();
    assert_eq!(
        input,
        json!({ "mode": "verify", "escrow": this_contract(), "job": id, "format_hash": FORMAT, "check_hash": SPEC, "deliverable_hash": DELIVERABLE })
    );
    let input: serde_json::Value =
        serde_json::from_str(&job.run_input(id, RunKind::Challenge, &this_contract())).unwrap();
    assert_eq!(
        input,
        json!({ "mode": "challenge", "escrow": this_contract(), "job": id, "format_hash": FORMAT, "check_hash": SPEC, "reference_hash": FAKES })
    );
    assert_eq!(
        job.secrets_profile(id, RunKind::Verify),
        format!("v{id}-{}", &DELIVERABLE[..12])
    );
    assert_eq!(
        job.secrets_profile(id, RunKind::Challenge),
        format!("c{id}-{}", &FAKES[..12])
    );
}

#[test]
fn a_job_keeps_the_verifier_and_secrets_owner_it_was_created_with() {
    let (mut escrow, id) = delivered();
    call(owner(), zero(), TRIGGERED_AT);
    escrow.set_verifier("https://example.test/other.wasm".into(), OTHER_HASH.into());
    escrow.set_secrets_owner(stranger());
    let job = escrow.get_job(id).unwrap();
    assert_eq!(
        (
            job.verifier_hash.as_str(),
            job.verifier_url.as_str(),
            &job.secrets_owner
        ),
        (VERIFIER, VERIFIER_URL, &relay())
    );
    let config = escrow.get_config();
    assert_eq!(
        (config.verifier_hash.as_str(), &config.secrets_owner),
        (OTHER_HASH, &stranger())
    );
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
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 13, 13));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(
        (job.state, job.fakes_total, job.fakes_caught),
        (JobState::Open, 13, 13)
    );
    assert_eq!(job.challenge_request_id, Some(U64(700)));
    assert!(job.challenge_report_hash.is_some());
}

#[test]
fn a_check_that_misses_a_fake_is_rejected_and_records_the_counts() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 13, 4));
    let job = escrow.get_job(id).unwrap();
    assert_eq!((job.state, job.fakes_caught), (JobState::CheckRejected, 4));
}

#[test]
fn a_check_that_fails_the_reference_is_rejected() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, false, 6, 6));
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
fn a_check_that_faced_too_few_fakes_is_rejected() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(
        &mut escrow,
        id,
        true,
        MIN_FAKES - 1,
        MIN_FAKES - 1
    ));
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
fn a_challenge_failure_is_no_result_and_can_be_retried() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    challenging(&mut escrow, id);
    assert!(!returned(
        &mut escrow,
        id,
        1,
        RunKind::Challenge,
        PromiseResult::Successful(b"null".to_vec()),
        START
    ));
    assert_eq!(state(&escrow, id), JobState::Draft);
    challenging(&mut escrow, id);
    assert!(!returned(
        &mut escrow,
        id,
        2,
        RunKind::Challenge,
        PromiseResult::Failed,
        START
    ));
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
        let id = create(&mut escrow);
        challenging(&mut escrow, id);
        let mut output = challenge_output(id, true, 6, 6);
        output[field] = value;
        assert!(
            !returned_json(&mut escrow, id, 1, RunKind::Challenge, &output, START),
            "{field}"
        );
        assert_eq!(state(&escrow, id), JobState::Draft, "{field}");
    }
}

#[test]
#[should_panic(expected = "job is not awaiting a challenge")]
fn a_second_challenge_after_a_result_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 13, 4));
    challenging(&mut escrow, id);
}

#[test]
#[should_panic(expected = "job is not awaiting a challenge")]
fn a_second_challenge_trigger_in_flight_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    challenging(&mut escrow, id);
    challenging(&mut escrow, id);
}

// ---- Creating, funding, delivering, paying ----

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
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, true),
        TRIGGERED_AT
    ));
    testing_env!(context(stranger(), zero(), TRIGGERED_AT)
        .prepaid_gas(Gas::from_tgas(49))
        .build());
    let _ = escrow.release(id);
}

#[test]
#[should_panic(expected = "verifier_hash is not the build this contract runs")]
fn a_buyer_who_expects_another_verifier_build_is_refused() {
    let mut escrow = escrow();
    call(board(), posting(1), START);
    escrow.create_open_job(
        buyer(),
        SPEC.into(),
        FAKES.into(),
        FORMAT.into(),
        U128(1),
        OTHER_HASH.into(),
        U64(EXPIRES),
        DELIVER_SECS,
        WINDOW_SECS,
        1,
    );
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
    assert!(returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, true),
        TRIGGERED_AT
    ));
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    let _ = escrow.release(id);
}

// ---- Public format, per-buyer cap and shorter deadlines ----

fn challenged_job(escrow: &mut Escrow) -> JobId {
    let id = create(escrow);
    assert!(challenge(escrow, id, true, 6, 6));
    id
}

#[test]
fn a_verdict_for_a_different_format_is_no_verdict() {
    let (mut escrow, id, attempt) = verifying();
    let mut output = verify_output(id, false);
    output["format_hash"] = json!("0".repeat(64));
    assert!(!returned_json(
        &mut escrow,
        id,
        attempt,
        RunKind::Verify,
        &output,
        TRIGGERED_AT
    ));
    assert_eq!(state(&escrow, id), JobState::Delivered);
}

// ---- One-signature jobs: creating, assigning, paying for runs, reopening, closing ----

fn verify_returns(escrow: &mut Escrow, id: JobId, pass: bool, at: u64) {
    call(relay(), zero(), at);
    let _ = escrow.request_verification(id);
    let attempt = escrow.get_job(id).unwrap().attempt;
    assert!(returned_json(
        escrow,
        id,
        attempt,
        RunKind::Verify,
        &verify_output(id, pass),
        at
    ));
}

fn deliver(escrow: &mut Escrow, id: JobId, at: u64) {
    call(worker(), zero(), at);
    escrow.deliver(id, DELIVERABLE.into());
}

fn paid(result: PromiseResult, escrow: &mut Escrow, id: JobId, to_worker: bool) -> bool {
    callback_context(result, START + 300 * SEC);
    escrow.on_payout(id, to_worker)
}

fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

/// The NEAR sent by transfers this call scheduled, by receiver.
fn transfers() -> Vec<(String, u128)> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let to = receipt.receiver_id.to_string();
            receipt
                .actions
                .into_iter()
                .filter_map(move |action| match action {
                    near_sdk::mock::MockAction::Transfer { deposit, .. } => {
                        Some((to.clone(), deposit.as_yoctonear()))
                    }
                    _ => None,
                })
        })
        .collect()
}

fn held(escrow: &Escrow) -> u128 {
    escrow.get_config().caps[0].held.0
}

#[test]
#[should_panic(expected = "only the board can do this")]
fn only_the_board_creates_jobs() {
    let mut escrow = escrow();
    call(buyer(), posting(1), START);
    escrow.create_open_job(
        buyer(),
        SPEC.into(),
        FAKES.into(),
        FORMAT.into(),
        U128(one_near().as_yoctonear()),
        VERIFIER.into(),
        U64(EXPIRES),
        DELIVER_SECS,
        WINDOW_SECS,
        1,
    );
}

#[test]
fn a_new_job_holds_the_payment_and_the_budget_and_returns_the_excess() {
    let mut escrow = escrow();
    let id = create_with(&mut escrow, 3);
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Draft);
    assert_eq!(job.worker, None);
    assert_eq!(job.compute_budget.0, budget_for(3, RUN).as_yoctonear());
    assert_eq!(job.release, Release::Verdict);
    assert_eq!(held(&escrow), one_near().as_yoctonear());
    let back: u128 = transfers()
        .into_iter()
        .filter(|(to, _)| *to == buyer().to_string())
        .map(|(_, amount)| amount)
        .sum();
    let kept = one_near()
        .saturating_add(budget_for(3, RUN))
        .saturating_add(job.storage_deposit);
    assert_eq!(back, posting(3).as_yoctonear() - kept.as_yoctonear());
}

#[test]
#[should_panic(expected = "attach at least")]
fn a_job_without_its_budget_is_refused() {
    let mut escrow = escrow();
    call(board(), one_near(), START);
    escrow.create_open_job(
        buyer(),
        SPEC.into(),
        FAKES.into(),
        FORMAT.into(),
        U128(one_near().as_yoctonear()),
        VERIFIER.into(),
        U64(EXPIRES),
        DELIVER_SECS,
        WINDOW_SECS,
        1,
    );
}

#[test]
#[should_panic(expected = "max_attempts must be 1 to 3")]
fn more_than_three_attempts_is_refused() {
    let mut escrow = escrow();
    create_with(&mut escrow, 4);
}

#[test]
#[should_panic(expected = "expires_at must be from 30 minutes to 7 days away")]
fn a_job_cannot_stay_open_more_than_seven_days() {
    let mut escrow = escrow();
    call(board(), posting(1), START);
    escrow.create_open_job(
        buyer(),
        SPEC.into(),
        FAKES.into(),
        FORMAT.into(),
        U128(one_near().as_yoctonear()),
        VERIFIER.into(),
        U64(START + 8 * 24 * 3_600 * SEC),
        DELIVER_SECS,
        WINDOW_SECS,
        1,
    );
}

#[test]
#[should_panic(expected = "this would pass this buyer's cap on money held")]
fn one_buyer_cannot_hold_more_than_its_cap() {
    let mut escrow = escrow();
    call(owner(), zero(), START);
    escrow.set_caps(
        U128(one_near().as_yoctonear()),
        U128(10 * one_near().as_yoctonear()),
        U128(one_near().as_yoctonear()),
    );
    create(&mut escrow);
    create(&mut escrow);
}

#[test]
#[should_panic(expected = "new jobs are paused")]
fn the_pause_stops_new_jobs() {
    let mut escrow = escrow();
    call(owner(), zero(), START);
    escrow.set_paused(true);
    create(&mut escrow);
}

#[test]
fn a_run_is_paid_from_the_budget_and_names_the_buyer_as_payer() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    let before = escrow.get_job(id).unwrap().compute_budget.0;
    challenging(&mut escrow, id);
    assert_eq!(
        escrow.get_job(id).unwrap().compute_budget.0,
        before - RUN.as_yoctonear()
    );
    let call = near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == outlayer())
        .unwrap();
    let args = call
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { args, .. } => Some(args.clone()),
            _ => None,
        })
        .unwrap();
    let args: serde_json::Value = serde_json::from_slice(&args).unwrap();
    assert_eq!(args["payer_account_id"], json!(buyer()));
    let deposit = call
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                attached_deposit, ..
            } => Some(*attached_deposit),
            _ => None,
        })
        .unwrap();
    assert_eq!(deposit, RUN);
}

#[test]
#[should_panic(expected = "the compute budget is used up")]
fn a_used_up_budget_stops_runs_until_topped_up() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    escrow.jobs.get_mut(&id).unwrap().compute_budget = U128(0);
    challenging(&mut escrow, id);
}

#[test]
fn a_top_up_lets_runs_continue() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    escrow.jobs.get_mut(&id).unwrap().compute_budget = U128(0);
    call(buyer(), RUN, START);
    escrow.top_up(id);
    challenging(&mut escrow, id);
    assert_eq!(state(&escrow, id), JobState::Challenging);
}

#[test]
#[should_panic(expected = "only the board can do this")]
fn only_the_board_assigns() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(worker(), zero(), START);
    escrow.assign(id, worker());
}

#[test]
#[should_panic(expected = "job is not open")]
fn a_job_whose_check_was_not_accepted_cannot_be_assigned() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 6, 5));
    assign(&mut escrow, id, START);
}

#[test]
#[should_panic(expected = "the worker cannot be the buyer")]
fn the_buyer_cannot_be_assigned() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    call(board(), zero(), START);
    escrow.assign(id, buyer());
}

#[test]
#[should_panic(expected = "this job has ended")]
fn no_worker_can_be_assigned_after_the_job_ends() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    assign(&mut escrow, id, EXPIRES);
}

#[test]
fn an_assignment_starts_the_workers_deadline() {
    let (escrow, id) = funded();
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Funded);
    assert_eq!(job.worker, Some(worker()));
    assert_eq!(job.deadline, U64(START + u64::from(DELIVER_SECS) * SEC));
}

#[test]
fn a_pass_pays_the_worker_and_the_budget_goes_back_once() {
    let (mut escrow, id) = funded();
    deliver(&mut escrow, id, DELIVERED_AT);
    verify_returns(&mut escrow, id, true, TRIGGERED_AT);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    assert_eq!(
        transfers(),
        vec![(worker().to_string(), one_near().as_yoctonear())]
    );
    assert!(paid(ok(), &mut escrow, id, true));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Released);
    assert_eq!(job.history.last().unwrap().outcome, Outcome::Paid);
    assert_eq!(held(&escrow), 0);
    let left = job.compute_budget.0;
    assert!(left > 0);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.return_budget(id);
    assert_eq!(transfers(), vec![(buyer().to_string(), left)]);
    assert_eq!(escrow.get_job(id).unwrap().compute_budget.0, 0);
}

#[test]
#[should_panic(expected = "nothing is left to return")]
fn the_budget_cannot_be_returned_twice() {
    let (mut escrow, id) = funded();
    deliver(&mut escrow, id, DELIVERED_AT);
    verify_returns(&mut escrow, id, true, TRIGGERED_AT);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    assert!(paid(ok(), &mut escrow, id, true));
    let _ = escrow.return_budget(id);
    let _ = escrow.return_budget(id);
}

#[test]
fn a_failed_budget_return_can_be_retried() {
    let (mut escrow, id) = funded();
    deliver(&mut escrow, id, DELIVERED_AT);
    verify_returns(&mut escrow, id, true, TRIGGERED_AT);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    assert!(paid(ok(), &mut escrow, id, true));
    let left = escrow.get_job(id).unwrap().compute_budget;
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.return_budget(id);
    callback_context(PromiseResult::Failed, TRIGGERED_AT);
    assert!(!escrow.on_budget_returned(id, left));
    assert_eq!(escrow.get_job(id).unwrap().compute_budget, left);
}

#[test]
fn a_failed_release_transfer_keeps_the_job_payable() {
    let (mut escrow, id) = funded();
    deliver(&mut escrow, id, DELIVERED_AT);
    verify_returns(&mut escrow, id, true, TRIGGERED_AT);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.release(id);
    assert!(!paid(PromiseResult::Failed, &mut escrow, id, true));
    assert_eq!(state(&escrow, id), JobState::Passed);
    assert_eq!(held(&escrow), one_near().as_yoctonear());
}

#[test]
fn a_fail_with_attempts_left_reopens_the_job_for_the_next_worker() {
    let (mut escrow, id) = funded_with(2);
    deliver(&mut escrow, id, DELIVERED_AT);
    verify_returns(&mut escrow, id, false, TRIGGERED_AT);
    call(stranger(), zero(), TRIGGERED_AT);
    assert!(escrow.refund(id).is_none());
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Open);
    assert_eq!(job.worker, None);
    assert_eq!(job.deliverable_hash, None);
    let record = &job.history[0];
    assert_eq!(record.outcome, Outcome::Failed);
    assert_eq!(record.worker, worker());
    assert_eq!(record.failed_rule.as_deref(), Some("grand_total"));
    assert_eq!(record.verdict_request_id, Some(U64(701)));
    assert_eq!(record.deliverable_hash.as_deref(), Some(DELIVERABLE));
    // The money stays held for the next worker.
    assert_eq!(held(&escrow), one_near().as_yoctonear());
    assert!(transfers().is_empty());
}

#[test]
fn the_last_failed_attempt_refunds_the_payment_and_the_budget() {
    let (mut escrow, id) = funded();
    deliver(&mut escrow, id, DELIVERED_AT);
    verify_returns(&mut escrow, id, false, TRIGGERED_AT);
    let budget = escrow.get_job(id).unwrap().compute_budget.0;
    call(stranger(), zero(), TRIGGERED_AT);
    assert!(escrow.refund(id).is_some());
    assert_eq!(
        transfers(),
        vec![(buyer().to_string(), one_near().as_yoctonear() + budget)]
    );
    assert!(paid(ok(), &mut escrow, id, false));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Refunded);
    assert_eq!(job.compute_budget.0, 0);
    assert_eq!(held(&escrow), 0);
}

#[test]
fn a_failed_refund_transfer_is_retried_without_recording_the_attempt_twice() {
    let (mut escrow, id) = funded();
    deliver(&mut escrow, id, DELIVERED_AT);
    verify_returns(&mut escrow, id, false, TRIGGERED_AT);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.refund(id);
    assert!(!paid(PromiseResult::Failed, &mut escrow, id, false));
    assert_eq!(state(&escrow, id), JobState::RefundDue);
    call(stranger(), zero(), TRIGGERED_AT);
    let _ = escrow.refund(id);
    assert!(paid(ok(), &mut escrow, id, false));
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Refunded);
    assert_eq!(job.history.len(), 1);
}

#[test]
fn no_delivery_reopens_the_job_and_records_it() {
    let (mut escrow, id) = funded_with(2);
    call(stranger(), zero(), DEADLINE + 1);
    assert!(escrow.expire(id).is_none());
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Open);
    assert_eq!(job.history[0].outcome, Outcome::NoDelivery);
}

#[test]
fn no_verdict_in_the_window_is_recorded_and_the_last_attempt_refunds() {
    let (mut escrow, id) = funded();
    deliver(&mut escrow, id, DELIVERED_AT);
    call(stranger(), zero(), WINDOW_END + 1);
    assert!(escrow.expire(id).is_some());
    let job = escrow.get_job(id).unwrap();
    assert_eq!(job.state, JobState::Refunding);
    assert_eq!(job.history[0].outcome, Outcome::NoVerdict);
}

#[test]
fn a_failed_attempt_after_the_job_ended_refunds_instead_of_reopening() {
    let (mut escrow, id) = funded_with(3);
    call(stranger(), zero(), EXPIRES);
    assert!(escrow.expire(id).is_some());
    assert_eq!(state(&escrow, id), JobState::Refunding);
}

#[test]
fn a_late_verdict_from_an_earlier_worker_is_ignored_after_the_job_reopens() {
    let (mut escrow, id) = funded_with(2);
    deliver(&mut escrow, id, DELIVERED_AT);
    call(relay(), zero(), TRIGGERED_AT);
    let _ = escrow.request_verification(id);
    let old_run = escrow.get_job(id).unwrap().attempt;
    // The run is lost; the window passes and the attempt expires.
    call(stranger(), zero(), WINDOW_END + RUN_TIMEOUT_NANOS + 1);
    let _ = escrow.expire(id);
    assert_eq!(state(&escrow, id), JobState::Open);
    assert!(!returned_json(
        &mut escrow,
        id,
        old_run,
        RunKind::Verify,
        &verify_output(id, true),
        WINDOW_END + RUN_TIMEOUT_NANOS + 2
    ));
    assert_eq!(state(&escrow, id), JobState::Open);
}

#[test]
fn the_buyer_can_close_an_open_job_and_get_everything_back() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 6, 6));
    let budget = escrow.get_job(id).unwrap().compute_budget.0;
    call(buyer(), zero(), START);
    let _ = escrow.close(id);
    assert_eq!(
        transfers(),
        vec![(buyer().to_string(), one_near().as_yoctonear() + budget)]
    );
    assert!(paid(ok(), &mut escrow, id, false));
    assert_eq!(state(&escrow, id), JobState::Refunded);
    assert_eq!(held(&escrow), 0);
}

#[test]
#[should_panic(expected = "only the buyer can close this job before it ends")]
fn a_stranger_cannot_close_a_job_before_it_ends() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    call(stranger(), zero(), START);
    let _ = escrow.close(id);
}

#[test]
fn anyone_can_close_an_idle_job_after_it_ends() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    assert!(challenge(&mut escrow, id, true, 6, 4));
    call(stranger(), zero(), EXPIRES);
    let _ = escrow.close(id);
    assert_eq!(state(&escrow, id), JobState::Refunding);
}

#[test]
#[should_panic(expected = "only a job with no worker on it can be closed")]
fn a_job_with_a_worker_on_it_cannot_be_closed() {
    let (mut escrow, id) = funded();
    call(buyer(), zero(), START);
    let _ = escrow.close(id);
}

#[test]
#[should_panic(expected = "only a job with no worker on it can be closed")]
fn a_job_cannot_be_closed_while_its_challenge_is_in_flight() {
    let mut escrow = escrow();
    let id = create(&mut escrow);
    challenging(&mut escrow, id);
    call(buyer(), zero(), START);
    let _ = escrow.close(id);
}

#[test]
#[should_panic(expected = "only the job's worker can deliver")]
fn a_worker_from_an_earlier_attempt_cannot_deliver_again() {
    let (mut escrow, id) = funded_with(2);
    call(stranger(), zero(), DEADLINE + 1);
    let _ = escrow.expire(id);
    deliver(&mut escrow, id, DEADLINE + 2);
}
