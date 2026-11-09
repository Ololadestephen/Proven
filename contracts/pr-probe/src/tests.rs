use super::*;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use serde_json::Value as Json;

const VERSION: &str = "b8ae4fd3a60ef8f8fb9eab77f2f9a65f6bbfdd4b1ff6024e086f1fdd72e8379b";
const REPO: &str = "proven-test/pr-bounty-pilot";
const SHA: &str = "78731935ef2a271d561e24cdedd4eedea3beeeb2";

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

fn context(who: AccountId, deposit: NearToken) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(this_contract())
        .predecessor_account_id(who)
        .attached_deposit(deposit)
        .block_timestamp(1_000)
        .prepaid_gas(Gas::from_tgas(300));
    builder
}

fn probe() -> PrProbe {
    testing_env!(context(owner(), NearToken::from_yoctonear(0)).build());
    PrProbe::new(
        owner(),
        outlayer(),
        "connectors.outlayer.testnet/github".to_string(),
        VERSION.to_string(),
        owner(),
        "github".to_string(),
        REPO.to_string(),
        U128(1_000),
    )
}

fn read(contract: &mut PrProbe, number: u64) {
    testing_env!(context(owner(), NearToken::from_millinear(10)).build());
    let _ = contract.read_pr(number);
}

fn callback(contract: &mut PrProbe, index: u32, result: PromiseResult) -> bool {
    testing_env!(
        context(this_contract(), NearToken::from_yoctonear(0)).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    contract.on_pr_read(index)
}

fn answer(pr: Json) -> Json {
    serde_json::json!({"success": true, "operation": "pr_get", "logs": [], "output": {"repo": REPO, "pull_request": pr}})
}

fn pull_request(merged: bool) -> Json {
    serde_json::json!({
        "number": 7, "title": "Fix the parser", "state": if merged { "closed" } else { "open" }, "draft": false,
        "merged": merged, "mergeable": null, "mergeable_state": "unknown", "author": "alice",
        "head": {"branch": "fix-parser", "sha": SHA, "repo": "alice/pr-bounty-pilot"},
        "base": {"branch": "main", "sha": SHA, "repo": REPO},
        "commits": 1, "changed_files": 1, "additions": 3, "deletions": 1,
        "created_at": "2026-11-09T10:00:00Z", "updated_at": "2026-11-09T11:00:00Z",
        "url": "https://github.com/proven-test/pr-bounty-pilot/pull/7", "body": "Closes #3",
    })
}

fn ok(value: &Json) -> PromiseResult {
    PromiseResult::Successful(value.to_string().into_bytes())
}

fn outcome_after(result: PromiseResult) -> Outcome {
    let mut contract = probe();
    read(&mut contract, 7);
    assert!(callback(&mut contract, 0, result));
    contract.get_reading(0).unwrap().outcome
}

fn reason(outcome: Outcome) -> String {
    match outcome {
        Outcome::NoResult { reason } => reason,
        other => panic!("expected no result, got {other:?}"),
    }
}

#[test]
fn read_pr_calls_the_pinned_connector_version_with_pr_get() {
    let mut contract = probe();
    read(&mut contract, 7);
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
        serde_json::json!({"Project": {"project_id": "connectors.outlayer.testnet/github", "version_key": VERSION}})
    );
    let input: Json = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        input,
        serde_json::json!({"operation": "pr_get", "repo": REPO, "number": 7})
    );
    assert_eq!(
        args["secrets_ref"],
        serde_json::json!({"profile": "github", "account_id": owner()})
    );
    assert_eq!(args["params"]["attached_usd"], "1000");
    assert_eq!(args["payer_account_id"], owner().to_string());
    assert_eq!(args["response_format"], "Json");
    assert_eq!(contract.get_reading(0).unwrap().outcome, Outcome::Pending);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_starts_a_read() {
    let mut contract = probe();
    testing_env!(context(stranger(), NearToken::from_millinear(10)).build());
    let _ = contract.read_pr(7);
}

#[test]
#[should_panic(expected = "attach between")]
fn a_read_bounds_its_compute_deposit() {
    let mut contract = probe();
    testing_env!(context(owner(), NearToken::from_near(1)).build());
    let _ = contract.read_pr(7);
}

#[test]
#[should_panic(expected = "repo must be owner/name")]
fn the_repository_is_checked_at_deployment() {
    testing_env!(context(owner(), NearToken::from_yoctonear(0)).build());
    let _ = PrProbe::new(
        owner(),
        outlayer(),
        "connectors.outlayer.testnet/github".to_string(),
        VERSION.to_string(),
        owner(),
        "github".to_string(),
        "proven-test/x/../y".to_string(),
        U128(1_000),
    );
}

#[test]
fn a_merged_pull_request_is_read() {
    let outcome = outcome_after(ok(&answer(pull_request(true))));
    let Outcome::Read(facts) = outcome else {
        panic!("expected a read, got {outcome:?}");
    };
    assert!(facts.merged);
    assert_eq!(facts.state, "closed");
    assert_eq!(facts.author, "alice");
    assert_eq!(facts.base_branch, "main");
    assert_eq!(facts.base_repo, REPO);
    assert_eq!(facts.head_sha, SHA);
}

#[test]
fn an_open_pull_request_is_read_as_not_merged() {
    let Outcome::Read(facts) = outcome_after(ok(&answer(pull_request(false)))) else {
        panic!("expected a read");
    };
    assert!(!facts.merged);
    assert_eq!(facts.state, "open");
}

#[test]
fn a_connector_refusal_keeps_its_code() {
    let refusal = serde_json::json!({"success": false, "operation": "pr_get", "logs": [], "error": "rate_limited: GitHub asks to wait 60 seconds"});
    assert_eq!(
        outcome_after(ok(&refusal)),
        Outcome::Refused {
            code: "rate_limited".to_string()
        }
    );
}

#[test]
fn a_refusal_without_a_clean_code_is_no_result() {
    let refusal =
        serde_json::json!({"success": false, "operation": "pr_get", "error": "Weird Code: x"});
    assert_eq!(reason(outcome_after(ok(&refusal))), "malformed");
}

#[test]
fn a_failed_run_is_no_result() {
    assert_eq!(
        reason(outcome_after(PromiseResult::Successful(b"null".to_vec()))),
        "no_output"
    );
    assert_eq!(
        reason(outcome_after(PromiseResult::Failed)),
        "promise_failed"
    );
}

#[test]
fn malformed_answers_are_no_result() {
    assert_eq!(
        reason(outcome_after(PromiseResult::Successful(
            b"{\"success\":tr".to_vec()
        ))),
        "malformed"
    );
    let mut missing_merged = pull_request(true);
    missing_merged.as_object_mut().unwrap().remove("merged");
    assert_eq!(
        reason(outcome_after(ok(&answer(missing_merged)))),
        "malformed"
    );
    let mut long_login = pull_request(true);
    long_login["author"] = Json::from("a".repeat(40));
    assert_eq!(reason(outcome_after(ok(&answer(long_login)))), "malformed");
    let mut other_operation = answer(pull_request(true));
    other_operation["operation"] = Json::from("pr_list");
    assert_eq!(reason(outcome_after(ok(&other_operation))), "malformed");
}

#[test]
fn an_oversized_answer_is_no_result() {
    let mut big = pull_request(true);
    big["body"] = Json::from("x".repeat(MAX_OUTPUT_BYTES));
    assert_eq!(reason(outcome_after(ok(&answer(big)))), "oversized");
}

#[test]
fn an_answer_about_another_repository_or_pull_request_is_no_result() {
    let mut other_repo = pull_request(true);
    other_repo["base"]["repo"] = Json::from("mallory/pr-bounty-pilot");
    assert_eq!(reason(outcome_after(ok(&answer(other_repo)))), "wrong_repo");
    let mut other_number = pull_request(true);
    other_number["number"] = Json::from(8);
    assert_eq!(reason(outcome_after(ok(&answer(other_number)))), "wrong_pr");
}

#[test]
fn a_second_callback_for_the_same_reading_is_ignored() {
    let mut contract = probe();
    read(&mut contract, 7);
    assert!(callback(&mut contract, 0, ok(&answer(pull_request(false)))));
    assert!(!callback(&mut contract, 0, ok(&answer(pull_request(true)))));
    let Outcome::Read(facts) = contract.get_reading(0).unwrap().outcome else {
        panic!("expected the first read");
    };
    assert!(!facts.merged);
    assert!(!callback(&mut contract, 9, ok(&answer(pull_request(true)))));
}

#[test]
fn funding_moves_stablecoin_into_the_outlayer_balance() {
    let mut contract = probe();
    testing_env!(context(owner(), NearToken::from_yoctonear(1)).build());
    let token: AccountId = "usdc.fakes.testnet".parse().unwrap();
    let _ = contract.fund_connector_balance(token.clone(), U128(10_000));
    let call = get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == token)
        .expect("a call to the token");
    let args = call
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == b"ft_transfer_call" => Some(args.clone()),
            _ => None,
        })
        .expect("ft_transfer_call");
    let args: Json = serde_json::from_slice(&args).unwrap();
    assert_eq!(args["receiver_id"], "outlayer.testnet");
    assert_eq!(args["amount"], "10000");
    assert_eq!(args["msg"], "{\"action\":\"deposit_balance\"}");
}
