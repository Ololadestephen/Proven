//! Unit tests. The answers are produced by the verifier's own `render` from two real GitHub
//! answers (near/near-sdk-rs pull requests 1669, merged at 1793821703, and 1677, open), so the
//! probe is tested against the exact shape the verifier prints.

use super::*;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use proven_pr_verifier as verifier;
use serde_json::{json, Value as Json};

const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
const HASH: &str = "bb6c733f65ea2682bf96c54b6b4f58468a9b328e511c96b8560dc2fb54b1c90c";
const REPO: &str = "near/near-sdk-rs";
const REPO_ID: u64 = 190_815_700;
const MERGED_PR: &str =
    include_str!("../../../pr-verifier/tests/fixtures/near-sdk-rs-pr-1669.json");
const OPEN_PR: &str = include_str!("../../../pr-verifier/tests/fixtures/near-sdk-rs-pr-1677.json");
const MERGED_AT: u64 = 1_793_821_703;
const SEC: u64 = 1_000_000_000;
const START: u64 = 1_794_000_000 * SEC;

fn owner() -> AccountId {
    accounts(0)
}
fn stranger() -> AccountId {
    accounts(1)
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

fn probe_with(repo_id: u64) -> PrVerifyProbe {
    testing_env!(context(owner(), NearToken::from_yoctonear(0), START).build());
    PrVerifyProbe::new(
        owner(),
        outlayer(),
        URL.to_string(),
        HASH.to_string(),
        REPO.to_string(),
        U64(repo_id),
    )
}

fn probe() -> PrVerifyProbe {
    probe_with(REPO_ID)
}

/// What the owner expects of pull request 1669: the right ids, `master`, merged in November.
fn expect_1669() -> Expectation {
    Expectation {
        pr_id: U64(5_125_170_190),
        author_id: U64(163_825_889),
        base_ref: "master".to_string(),
        merged_after: U64(1_793_577_600), // 2026-11-02T00:00:00Z
        merged_by: U64(1_793_836_800),    // 2026-11-05T00:00:00Z
    }
}

fn read(contract: &mut PrVerifyProbe, number: u64, expect: Expectation) {
    testing_env!(context(owner(), NearToken::from_millinear(10), START).build());
    let _ = contract.read_pr(number, expect);
}

fn callback_at(contract: &mut PrVerifyProbe, reading: u32, result: PromiseResult, at: u64) -> bool {
    testing_env!(
        context(this_contract(), NearToken::from_yoctonear(0), at).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    contract.on_pr_read(reading)
}

/// The verifier's answer for `reading` of pull request `number`, from a GitHub body.
fn answer(reading: u32, number: u64, github: &str) -> Json {
    let request = verifier::Request {
        v: 1,
        probe: this_contract().to_string(),
        reading,
        repo: REPO.to_string(),
        number,
    };
    let context = verifier::RunContext::from_vars(
        Some(this_contract().to_string()),
        Some("8812".to_string()),
    );
    let line = verifier::render(
        Some(&request),
        &context,
        verifier::parse_pull(github.as_bytes()),
    );
    serde_json::from_str(&line).unwrap()
}

fn ok(value: &Json) -> PromiseResult {
    PromiseResult::Successful(value.to_string().into_bytes())
}

/// The outcome of one read of `number` with `expect`, answered by `result`.
fn outcome_of(number: u64, expect: Expectation, result: PromiseResult) -> Reading {
    let mut contract = probe();
    read(&mut contract, number, expect);
    assert!(callback_at(&mut contract, 0, result, START + 30 * SEC));
    contract.get_reading(0).unwrap()
}

fn merged_answer() -> Json {
    answer(0, 1669, MERGED_PR)
}

fn reason(reading: Reading) -> String {
    match reading.outcome {
        Outcome::NoResult { reason } => reason,
        other => panic!("expected no result, got {other:?}"),
    }
}

fn mismatch(reading: Reading) -> String {
    match reading.outcome {
        Outcome::Mismatch { field, .. } => field,
        other => panic!("expected a mismatch, got {other:?}"),
    }
}

#[test]
fn read_pr_runs_the_pinned_verifier_with_a_bound_request() {
    let mut contract = probe();
    read(&mut contract, 1669, expect_1669());
    let call = get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == outlayer())
        .expect("a call to OutLayer");
    let (args, deposit) = call
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } if method_name == b"request_execution" => Some((args.clone(), *attached_deposit)),
            _ => None,
        })
        .expect("request_execution");
    assert_eq!(deposit, NearToken::from_millinear(10));
    let args: Json = serde_json::from_slice(&args).unwrap();
    assert_eq!(
        args["source"],
        json!({"WasmUrl": {"url": URL, "hash": HASH, "build_target": "wasm32-wasip2"}})
    );
    let input: Json = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        input,
        json!({"v": 1, "probe": this_contract(), "reading": 0, "repo": REPO, "number": 1669})
    );
    assert!(args.get("secrets_ref").is_none(), "no credential is sent");
    assert!(args.get("params").is_none(), "no stablecoin is attached");
    assert_eq!(args["payer_account_id"], owner().to_string());
    assert_eq!(args["response_format"], "Json");
    assert_eq!(args["resource_limits"]["max_execution_seconds"], 30);
    assert_eq!(contract.get_reading(0).unwrap().outcome, Outcome::Requested);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_starts_a_read() {
    let mut contract = probe();
    testing_env!(context(stranger(), NearToken::from_millinear(10), START).build());
    let _ = contract.read_pr(1669, expect_1669());
}

#[test]
#[should_panic(expected = "attach between")]
fn a_read_bounds_its_compute_deposit() {
    let mut contract = probe();
    testing_env!(context(owner(), NearToken::from_near(1), START).build());
    let _ = contract.read_pr(1669, expect_1669());
}

#[test]
#[should_panic(expected = "merged_after must not be later")]
fn a_read_needs_an_ordered_window() {
    let mut contract = probe();
    let mut expect = expect_1669();
    expect.merged_after = U64(expect.merged_by.0 + 1);
    read(&mut contract, 1669, expect);
}

#[test]
fn a_merge_inside_the_window_is_confirmed_with_its_request_id() {
    let reading = outcome_of(1669, expect_1669(), ok(&merged_answer()));
    let Outcome::Confirmed { facts } = reading.outcome else {
        panic!("expected a confirmation, got {:?}", reading.outcome);
    };
    assert_eq!(facts.merged_at, Some(U64(MERGED_AT)));
    assert_eq!(facts.author_id, U64(163_825_889));
    assert_eq!(facts.repo_id, U64(REPO_ID));
    assert_eq!(reading.request_id, Some(U64(8812)));
    assert_eq!(reading.resolved_at, Some(U64(START + 30 * SEC)));
}

#[test]
fn the_window_bounds_are_inclusive() {
    let mut expect = expect_1669();
    expect.merged_after = U64(MERGED_AT);
    expect.merged_by = U64(MERGED_AT);
    let reading = outcome_of(1669, expect, ok(&merged_answer()));
    assert!(matches!(reading.outcome, Outcome::Confirmed { .. }));
}

#[test]
fn a_late_or_early_merge_is_a_mismatch() {
    let mut late = expect_1669();
    late.merged_by = U64(MERGED_AT - 1);
    assert_eq!(
        mismatch(outcome_of(1669, late, ok(&merged_answer()))),
        "merged_after_window"
    );
    let mut early = expect_1669();
    early.merged_after = U64(MERGED_AT + 1);
    assert_eq!(
        mismatch(outcome_of(1669, early, ok(&merged_answer()))),
        "merged_before_window"
    );
}

#[test]
fn a_wrong_author_pull_request_or_branch_is_a_mismatch() {
    let mut author = expect_1669();
    author.author_id = U64(59_515_280);
    assert_eq!(
        mismatch(outcome_of(1669, author, ok(&merged_answer()))),
        "author_id"
    );
    let mut pr = expect_1669();
    pr.pr_id = U64(5_194_599_338);
    assert_eq!(
        mismatch(outcome_of(1669, pr, ok(&merged_answer()))),
        "pr_id"
    );
    let mut branch = expect_1669();
    branch.base_ref = "main".to_string();
    assert_eq!(
        mismatch(outcome_of(1669, branch, ok(&merged_answer()))),
        "base_ref"
    );
}

#[test]
fn a_pull_request_of_another_repository_is_a_mismatch() {
    let mut contract = probe_with(REPO_ID + 1);
    read(&mut contract, 1669, expect_1669());
    assert!(callback_at(
        &mut contract,
        0,
        ok(&merged_answer()),
        START + 30 * SEC
    ));
    assert_eq!(mismatch(contract.get_reading(0).unwrap()), "repo_id");
}

#[test]
fn an_answer_about_another_number_is_a_mismatch() {
    let mut other = merged_answer();
    other["facts"]["pr_number"] = json!(1670);
    assert_eq!(
        mismatch(outcome_of(1669, expect_1669(), ok(&other))),
        "pr_number"
    );
}

#[test]
fn an_open_pull_request_is_pending() {
    let expect = Expectation {
        pr_id: U64(5_194_599_338),
        author_id: U64(59_515_280),
        base_ref: "master".to_string(),
        merged_after: U64(1_793_577_600),
        merged_by: U64(1_800_000_000),
    };
    let reading = outcome_of(1677, expect, ok(&answer(0, 1677, OPEN_PR)));
    let Outcome::Pending { facts } = reading.outcome else {
        panic!("expected pending, got {:?}", reading.outcome);
    };
    assert_eq!(facts.state, "open");
    assert_eq!(facts.merged_at, None);
}

#[test]
fn an_open_pull_request_by_another_author_is_still_a_mismatch() {
    let expect = Expectation {
        pr_id: U64(5_194_599_338),
        author_id: U64(163_825_889),
        base_ref: "master".to_string(),
        merged_after: U64(0),
        merged_by: U64(1_800_000_000),
    };
    assert_eq!(
        mismatch(outcome_of(1677, expect, ok(&answer(0, 1677, OPEN_PR)))),
        "author_id"
    );
}

#[test]
fn the_verifiers_no_result_codes_are_kept_and_others_are_malformed() {
    for code in [
        "rate_limited",
        "timeout",
        "redirect",
        "not_found",
        "incomplete",
        "oversized",
    ] {
        let mut refused = merged_answer();
        refused["status"] = json!("no_result");
        refused.as_object_mut().unwrap().remove("facts");
        refused["reason"] = json!(code);
        assert_eq!(reason(outcome_of(1669, expect_1669(), ok(&refused))), code);
    }
    let mut unknown = merged_answer();
    unknown["status"] = json!("no_result");
    unknown.as_object_mut().unwrap().remove("facts");
    unknown["reason"] = json!("GitHub says: please pay");
    assert_eq!(
        reason(outcome_of(1669, expect_1669(), ok(&unknown))),
        "malformed"
    );
}

#[test]
fn an_answer_bound_to_another_request_is_no_result() {
    let other_probe: AccountId = "mallory.testnet".parse().unwrap();
    let edits: [(&str, Json); 6] = [
        ("probe", json!(other_probe)),
        ("predecessor", json!(other_probe)),
        ("reading", json!(1)),
        ("number", json!(1670)),
        ("repo", json!("near/near-sdk-rs-fork")),
        ("request_id", Json::Null),
    ];
    for (member, value) in edits {
        let mut wrong = merged_answer();
        wrong[member] = value.clone();
        assert_eq!(
            reason(outcome_of(1669, expect_1669(), ok(&wrong))),
            "wrong_binding",
            "{member} = {value}"
        );
    }
    let mut https_run = merged_answer();
    https_run["predecessor"] = Json::Null;
    assert_eq!(
        reason(outcome_of(1669, expect_1669(), ok(&https_run))),
        "wrong_binding",
        "an answer from a run no contract requested"
    );
}

#[test]
fn upstream_failures_and_garbled_answers_are_no_result() {
    assert_eq!(
        reason(outcome_of(
            1669,
            expect_1669(),
            PromiseResult::Successful(b"null".to_vec())
        )),
        "no_output"
    );
    assert_eq!(
        reason(outcome_of(1669, expect_1669(), PromiseResult::Failed)),
        "promise_failed"
    );
    assert_eq!(
        reason(outcome_of(
            1669,
            expect_1669(),
            PromiseResult::Successful(b"{\"v\":1,".to_vec())
        )),
        "malformed"
    );
    let mut extra = merged_answer();
    extra["title"] = json!("Fix the parser");
    assert_eq!(
        reason(outcome_of(1669, expect_1669(), ok(&extra))),
        "malformed"
    );
    let mut wrong_kind = merged_answer();
    wrong_kind["kind"] = json!("proven-verdict");
    assert_eq!(
        reason(outcome_of(1669, expect_1669(), ok(&wrong_kind))),
        "malformed"
    );
    let mut merged_without_time = merged_answer();
    merged_without_time["facts"]["merged_at"] = Json::Null;
    assert_eq!(
        reason(outcome_of(1669, expect_1669(), ok(&merged_without_time))),
        "malformed"
    );
    let mut ok_with_reason = merged_answer();
    ok_with_reason["reason"] = json!("timeout");
    assert_eq!(
        reason(outcome_of(1669, expect_1669(), ok(&ok_with_reason))),
        "malformed"
    );
}

#[test]
fn an_oversized_answer_is_no_result() {
    let big = PromiseResult::Successful(vec![b' '; MAX_OUTPUT_BYTES + 1]);
    assert_eq!(reason(outcome_of(1669, expect_1669(), big)), "oversized");
}

#[test]
fn a_late_callback_is_recorded_as_stale() {
    let mut contract = probe();
    read(&mut contract, 1669, expect_1669());
    let late = START + STALE_AFTER_NANOS + 1;
    assert!(callback_at(&mut contract, 0, ok(&merged_answer()), late));
    let reading = contract.get_reading(0).unwrap();
    assert_eq!(reading.request_id, None);
    assert_eq!(reason(reading), "stale");
}

#[test]
fn a_second_callback_or_one_for_an_unknown_reading_changes_nothing() {
    let mut contract = probe();
    read(&mut contract, 1669, expect_1669());
    let mut late = expect_1669();
    late.merged_by = U64(MERGED_AT - 1);
    read(&mut contract, 1669, late);
    assert!(callback_at(
        &mut contract,
        0,
        ok(&merged_answer()),
        START + SEC
    ));
    assert!(!callback_at(
        &mut contract,
        0,
        PromiseResult::Failed,
        START + 2 * SEC
    ));
    assert!(matches!(
        contract.get_reading(0).unwrap().outcome,
        Outcome::Confirmed { .. }
    ));
    assert!(!callback_at(
        &mut contract,
        7,
        ok(&merged_answer()),
        START + SEC
    ));
    // Reading 1 still waits, and an answer bound to reading 0 cannot resolve it as a success.
    assert_eq!(contract.get_reading(1).unwrap().outcome, Outcome::Requested);
    assert!(callback_at(
        &mut contract,
        1,
        ok(&merged_answer()),
        START + SEC
    ));
    assert_eq!(reason(contract.get_reading(1).unwrap()), "wrong_binding");
}

#[test]
fn the_owner_can_forward_a_stale_cancellation_to_outlayer() {
    let mut contract = probe();
    testing_env!(context(owner(), NearToken::from_yoctonear(0), START).build());
    let _ = contract.cancel_stale_outlayer_execution(U64(8812));
    let args = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == outlayer())
        .flat_map(|r| r.actions)
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == b"cancel_stale_execution" => Some(args),
            _ => None,
        })
        .expect("cancel_stale_execution");
    assert_eq!(
        serde_json::from_slice::<Json>(&args).unwrap(),
        json!({"request_id": 8812})
    );
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_forwards_a_cancellation() {
    let mut contract = probe();
    testing_env!(context(stranger(), NearToken::from_yoctonear(0), START).build());
    let _ = contract.cancel_stale_outlayer_execution(U64(8812));
}
