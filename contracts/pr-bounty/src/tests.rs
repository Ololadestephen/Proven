//! Unit tests. Every answer is produced by the bounty verifier's own `render`, so the contract is
//! tested against the exact shape the verifier prints.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use proven_pr_bounty_verifier as verifier;
use serde_json::Value as Json;
use verifier::{PullFacts as VPull, Reason, RunContext};

const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
const HASH: &str = "75a43fb03170017304f2bf53eb21d7d77bd630741ea568f649a4de1efac3948d";
const REPO: &str = "proven-test/bounty-pilot";
const REPO_ID: u64 = 800_000_001;
const ISSUE: u64 = 3;
const GH: u64 = 900_000_001;
const OTHER_GH: u64 = 900_000_002;
const PR: u64 = 12;
const PR_ID: u64 = 5_000_000_012;
const SEC: u64 = 1_000_000_000;
const START_S: u64 = 1_794_300_000;
const START: u64 = START_S * SEC;
const CLAIM_BY: u64 = START_S + 3_600;
const BIND_BY: u64 = START_S + 7_200;
const DEADLINE: u64 = START_S + 86_400;
const GRACE: u64 = 3_600;
const REWARD: u128 = 1_000_000_000_000_000_000_000_000;

fn owner() -> AccountId {
    accounts(0)
}
fn buyer() -> AccountId {
    accounts(1)
}
fn wallet() -> AccountId {
    accounts(2)
}
fn stranger() -> AccountId {
    accounts(3)
}
fn this() -> AccountId {
    accounts(5)
}
fn outlayer() -> AccountId {
    "outlayer.testnet".parse().unwrap()
}
fn budget() -> u128 {
    RUN_DEPOSIT.as_yoctonear() * u128::from(BUDGET_RUNS)
}
fn post_deposit() -> NearToken {
    NearToken::from_yoctonear(REWARD + budget() + STORAGE_DEPOSIT.as_yoctonear())
}

fn context(who: AccountId, deposit: NearToken, at: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(this())
        .predecessor_account_id(who)
        .attached_deposit(deposit)
        .block_timestamp(at)
        .account_balance(NearToken::from_near(20))
        .prepaid_gas(Gas::from_tgas(300));
    builder
}

fn act(who: AccountId, deposit: NearToken, at: u64) {
    testing_env!(context(who, deposit, at).build());
}

fn callback(at: u64, result: PromiseResult) {
    testing_env!(
        context(this(), NearToken::from_yoctonear(0), at).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn contract() -> PrBounty {
    act(owner(), NearToken::from_yoctonear(0), START);
    let mut c = PrBounty::new(
        owner(),
        outlayer(),
        "testnet".into(),
        URL.into(),
        HASH.into(),
        U128(2 * REWARD),
        U128(5 * REWARD),
        3,
    );
    c.add_poster(buyer());
    c
}

fn post(c: &mut PrBounty) -> BountyId {
    act(buyer(), post_deposit(), START);
    c.post_bounty(
        U128(REWARD),
        REPO.into(),
        U64(REPO_ID),
        ISSUE,
        "main".into(),
        U64(GH),
        U64(CLAIM_BY),
        U64(BIND_BY),
        U64(DEADLINE),
        U64(GRACE),
    )
}

fn request(bounty: BountyId, seq: u64, op: verifier::Op) -> verifier::Request {
    verifier::Request {
        network: "testnet".into(),
        contract: this().to_string(),
        bounty,
        seq,
        repo: REPO.into(),
        op,
    }
}

fn ctx(id: u64) -> RunContext {
    RunContext::from_vars(Some(this().to_string()), Some(id.to_string()))
}

fn comment_facts(created_at: u64) -> verifier::CommentFacts {
    verifier::CommentFacts {
        repo_id: REPO_ID,
        comment_id: 77,
        author_id: GH,
        issue_number: ISSUE,
        created_at,
        updated_at: created_at,
        challenge_matches: true,
    }
}

fn comment_answer(bounty: BountyId, seq: u64, facts: verifier::CommentFacts) -> Json {
    let op = verifier::Op::Comment {
        comment_id: 77,
        challenge: format!("proven-claim:{}", "0".repeat(64)),
    };
    let line = verifier::render(
        Some(&request(bounty, seq, op)),
        &ctx(15_100 + seq),
        Ok(verifier::Answer::Comment(facts)),
    );
    serde_json::from_str(&line).unwrap()
}

fn pull(state: &str, merged_at: Option<u64>) -> VPull {
    VPull {
        repo_id: REPO_ID,
        pr_id: PR_ID,
        pr_number: PR,
        author_id: GH,
        base_ref: "main".into(),
        state: state.into(),
        merged: merged_at.is_some(),
        merged_at,
    }
}

fn pull_answer(bounty: BountyId, seq: u64, facts: VPull) -> Json {
    let line = verifier::render(
        Some(&request(
            bounty,
            seq,
            verifier::Op::Pull {
                number: facts.pr_number,
            },
        )),
        &ctx(15_100 + seq),
        Ok(verifier::Answer::Pull(facts)),
    );
    serde_json::from_str(&line).unwrap()
}

fn no_result_answer(bounty: BountyId, seq: u64, op: verifier::Op, reason: Reason) -> Json {
    serde_json::from_str(&verifier::render(
        Some(&request(bounty, seq, op)),
        &ctx(1),
        Err(reason),
    ))
    .unwrap()
}

/// Runs `case` on its own thread, so it gets its own mocked chain and storage.
fn isolated(case: impl FnOnce() + Send + 'static) {
    std::thread::spawn(case).join().expect("case passed");
}

fn ok(value: &Json) -> PromiseResult {
    PromiseResult::Successful(value.to_string().into_bytes())
}

/// One edit to a reply's facts, for table-driven cases.
type CommentEdit = Box<dyn Fn(&mut verifier::CommentFacts) + Send>;
type PullEdit = Box<dyn Fn(&mut VPull) + Send + Sync>;

const T_CLAIM: u64 = START + 600 * SEC;
const EXPIRES: u64 = START_S + 600 + 1_800;

/// Proves the claim at T_CLAIM with `answer`, returning the callback's outcome.
fn claim_with(c: &mut PrBounty, id: BountyId, answer: PromiseResult) -> String {
    act(wallet(), RUN_DEPOSIT, T_CLAIM);
    let _ = c.prove_claim(id, U64(77), U64(EXPIRES));
    callback(T_CLAIM + 10 * SEC, answer);
    c.on_claim(id, U64(1), wallet(), U64(77), U64(EXPIRES), U64(T_CLAIM))
}

fn claimed() -> (PrBounty, BountyId) {
    let mut c = contract();
    let id = post(&mut c);
    let outcome = claim_with(
        &mut c,
        id,
        ok(&comment_answer(id, 1, comment_facts(START_S + 900))),
    );
    assert_eq!(outcome, "claimed");
    (c, id)
}

const T_NOMINATE: u64 = START + 1_200 * SEC;

fn nominate_with(c: &mut PrBounty, id: BountyId, answer: impl Fn(u64) -> PromiseResult) -> String {
    act(buyer(), RUN_DEPOSIT, T_NOMINATE);
    let _ = c.nominate(id, PR);
    let seq = c.get_bounty(id).unwrap().live.unwrap().seq.0;
    callback(T_NOMINATE + 10 * SEC, answer(seq));
    c.on_check(id, U64(seq))
}

fn bound() -> (PrBounty, BountyId) {
    let (mut c, id) = claimed();
    let outcome = nominate_with(&mut c, id, |seq| {
        ok(&pull_answer(id, seq, pull("open", None)))
    });
    assert_eq!(outcome, "bound");
    (c, id)
}

/// Starts a merge check by `who` at `at` and delivers `facts` `delay` later.
fn check_with(
    c: &mut PrBounty,
    id: BountyId,
    who: AccountId,
    deposit: NearToken,
    at: u64,
    delay: u64,
    facts: VPull,
) -> String {
    act(who, deposit, at);
    let _ = c.check_merge(id);
    let seq = c.get_bounty(id).unwrap().live.unwrap().seq.0;
    callback(at + delay, ok(&pull_answer(id, seq, facts)));
    c.on_check(id, U64(seq))
}

fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn outlayer_call() -> (Json, NearToken) {
    let call = get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == outlayer())
        .expect("a call to OutLayer");
    call.actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } if method_name == b"request_execution" => {
                Some((serde_json::from_slice(args).unwrap(), *attached_deposit))
            }
            _ => None,
        })
        .expect("request_execution")
}

// ---- Posting ----

#[test]
fn posting_locks_reward_budget_and_storage_exactly() {
    let mut c = contract();
    let id = post(&mut c);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(
        (b.status, b.reward.0, b.budget.0, b.budget_runs_left),
        (Status::Open, REWARD, budget(), 3)
    );
    assert_eq!(c.get_config().held.0, REWARD + budget());
}

#[test]
#[should_panic(expected = "only an approved maintainer can post")]
fn only_allowlisted_maintainers_post() {
    let mut c = contract();
    act(stranger(), post_deposit(), START);
    c.post_bounty(
        U128(REWARD),
        REPO.into(),
        U64(REPO_ID),
        ISSUE,
        "main".into(),
        U64(GH),
        U64(CLAIM_BY),
        U64(BIND_BY),
        U64(DEADLINE),
        U64(GRACE),
    );
}

#[test]
#[should_panic(expected = "attach exactly the reward")]
fn posting_needs_the_exact_deposit() {
    let mut c = contract();
    act(buyer(), NearToken::from_near(1), START);
    c.post_bounty(
        U128(REWARD),
        REPO.into(),
        U64(REPO_ID),
        ISSUE,
        "main".into(),
        U64(GH),
        U64(CLAIM_BY),
        U64(BIND_BY),
        U64(DEADLINE),
        U64(GRACE),
    );
}

#[test]
#[should_panic(expected = "times must satisfy")]
fn deadlines_must_be_ordered() {
    let mut c = contract();
    act(buyer(), post_deposit(), START);
    c.post_bounty(
        U128(REWARD),
        REPO.into(),
        U64(REPO_ID),
        ISSUE,
        "main".into(),
        U64(GH),
        U64(BIND_BY),
        U64(CLAIM_BY),
        U64(DEADLINE),
        U64(GRACE),
    );
}

#[test]
#[should_panic(expected = "reward is over the cap")]
fn rewards_are_capped() {
    let mut c = contract();
    let reward = 3 * REWARD;
    act(
        buyer(),
        NearToken::from_yoctonear(reward + budget() + STORAGE_DEPOSIT.as_yoctonear()),
        START,
    );
    c.post_bounty(
        U128(reward),
        REPO.into(),
        U64(REPO_ID),
        ISSUE,
        "main".into(),
        U64(GH),
        U64(CLAIM_BY),
        U64(BIND_BY),
        U64(DEADLINE),
        U64(GRACE),
    );
}

#[test]
#[should_panic(expected = "too many open bounties")]
fn open_bounties_per_maintainer_are_capped() {
    let mut c = contract();
    act(owner(), NearToken::from_yoctonear(0), START);
    c.set_caps(U128(REWARD), U128(10 * REWARD), 2);
    post(&mut c);
    post(&mut c);
    post(&mut c);
}

#[test]
fn the_pause_stops_new_bounties_only() {
    let mut c = contract();
    let id = post(&mut c);
    act(owner(), NearToken::from_yoctonear(0), START);
    c.set_paused(true);
    assert_eq!(
        claim_with(
            &mut c,
            id,
            ok(&comment_answer(id, 1, comment_facts(START_S + 900)))
        ),
        "claimed"
    );
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        post(&mut c);
    }));
    assert!(result.is_err(), "posting is paused");
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_the_owner_pauses() {
    let mut c = contract();
    act(stranger(), NearToken::from_yoctonear(0), START);
    c.set_paused(true);
}

// ---- Claims ----

#[test]
fn the_challenge_binds_network_contract_bounty_wallet_id_and_expiry() {
    let mut c = contract();
    let id = post(&mut c);
    act(stranger(), NearToken::from_yoctonear(0), START);
    let base = c.claim_challenge(id, wallet(), U64(EXPIRES));
    assert!(base.starts_with("proven-claim:") && base.len() == 13 + 64);
    assert_ne!(
        base,
        c.claim_challenge(id, stranger(), U64(EXPIRES)),
        "another wallet"
    );
    assert_ne!(
        base,
        c.claim_challenge(id, wallet(), U64(EXPIRES + 1)),
        "another expiry"
    );
    let other = post(&mut c);
    act(stranger(), NearToken::from_yoctonear(0), START);
    assert_ne!(
        base,
        c.claim_challenge(other, wallet(), U64(EXPIRES)),
        "another bounty"
    );
    act(wallet(), RUN_DEPOSIT, T_CLAIM);
    let _ = c.prove_claim(id, U64(77), U64(EXPIRES));
    let (args, deposit) = outlayer_call();
    assert_eq!(deposit, RUN_DEPOSIT);
    assert_eq!(args["source"]["WasmUrl"]["hash"], HASH);
    assert_eq!(args["source"]["WasmUrl"]["build_target"], "wasm32-wasip2");
    assert_eq!(args["payer_account_id"], wallet().to_string());
    assert!(args.get("secrets_ref").is_none());
    let input: Json = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input["op"], "comment");
    assert_eq!(input["challenge"], base);
    assert_eq!(input["network"], "testnet");
    assert_eq!(input["contract"], this().to_string());
}

#[test]
fn an_accepted_claim_fixes_the_wallet_and_github_id() {
    let (c, id) = claimed();
    let claim = c.get_bounty(id).unwrap().claim.unwrap();
    assert_eq!(
        (
            claim.wallet,
            claim.github_id.0,
            claim.comment_id.0,
            claim.request_id.0
        ),
        (wallet(), GH, 77, 15_101)
    );
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Claimed);
}

#[test]
fn claim_proofs_that_do_not_hold_are_refused() {
    let cases: Vec<(&str, CommentEdit)> = vec![
        ("mismatch:author_id", Box::new(|f| f.author_id = OTHER_GH)),
        ("mismatch:issue", Box::new(|f| f.issue_number = ISSUE + 1)),
        ("mismatch:repo_id", Box::new(|f| f.repo_id = REPO_ID + 1)),
        (
            "mismatch:challenge",
            Box::new(|f| f.challenge_matches = false),
        ),
        (
            "mismatch:edited",
            Box::new(|f| f.updated_at = f.created_at + 5),
        ),
        (
            "mismatch:challenge_time",
            Box::new(|f| {
                f.created_at = EXPIRES - CHALLENGE_TTL_SECS - 1;
                f.updated_at = f.created_at;
            }),
        ),
        (
            "mismatch:challenge_time",
            Box::new(|f| {
                f.created_at = EXPIRES + 1;
                f.updated_at = f.created_at;
            }),
        ),
    ];
    for (expected, edit) in cases {
        isolated(move || {
            let mut c = contract();
            let id = post(&mut c);
            let mut facts = comment_facts(START_S + 900);
            edit(&mut facts);
            assert_eq!(
                claim_with(&mut c, id, ok(&comment_answer(id, 1, facts))),
                expected
            );
            assert_eq!(c.get_bounty(id).unwrap().status, Status::Open);
        });
    }
}

#[test]
fn a_comment_written_before_the_bounty_was_posted_is_refused() {
    let mut c = contract();
    let id = post(&mut c);
    // Inside the challenge hour but before posting.
    let early = START_S - 10;
    let mut facts = comment_facts(early);
    facts.updated_at = early;
    act(wallet(), RUN_DEPOSIT, START + 5 * SEC);
    let expires = START_S + 30;
    let _ = c.prove_claim(id, U64(77), U64(expires));
    callback(START + 15 * SEC, ok(&comment_answer(id, 1, facts)));
    assert_eq!(
        c.on_claim(
            id,
            U64(1),
            wallet(),
            U64(77),
            U64(expires),
            U64(START + 5 * SEC)
        ),
        "mismatch:challenge_time"
    );
}

#[test]
fn a_claim_answer_bound_to_anything_else_is_no_result() {
    let edits: Vec<(&str, Json)> = vec![
        ("bounty", Json::from(9)),
        ("seq", Json::from(2)),
        ("contract", Json::from("other.testnet")),
        ("predecessor", Json::from("other.testnet")),
        ("predecessor", Json::Null),
        ("network", Json::from("mainnet")),
        ("comment_id", Json::from(78)),
        ("repo", Json::from("proven-test/other")),
        ("request_id", Json::Null),
    ];
    for (member, value) in edits {
        isolated(move || {
            let mut c = contract();
            let id = post(&mut c);
            let mut answer = comment_answer(id, 1, comment_facts(START_S + 900));
            answer[member] = value.clone();
            assert_eq!(
                claim_with(&mut c, id, ok(&answer)),
                "no_result:wrong_binding",
                "{member}={value}"
            );
        });
    }
}

#[test]
fn upstream_failures_and_bad_replies_are_no_result() {
    let comment_op = verifier::Op::Comment {
        comment_id: 77,
        challenge: format!("proven-claim:{}", "0".repeat(64)),
    };
    let cases: Vec<(PromiseResult, &'static str)> = vec![
        (
            ok(&no_result_answer(
                0,
                1,
                comment_op.clone(),
                Reason::RateLimited,
            )),
            "no_result:rate_limited",
        ),
        (
            ok(&no_result_answer(0, 1, comment_op.clone(), Reason::Timeout)),
            "no_result:timeout",
        ),
        (
            ok(&no_result_answer(0, 1, comment_op, Reason::Incomplete)),
            "no_result:incomplete",
        ),
        (
            PromiseResult::Successful(b"null".to_vec()),
            "no_result:no_output",
        ),
        (
            PromiseResult::Successful(b"{\"v\":2,".to_vec()),
            "no_result:malformed",
        ),
        (
            PromiseResult::Successful(vec![b' '; answer::MAX_OUTPUT_BYTES + 1]),
            "no_result:oversized",
        ),
        (PromiseResult::Failed, "no_result:promise_failed"),
    ];
    for (result, expected) in cases {
        isolated(move || {
            let mut c = contract();
            let id = post(&mut c);
            assert_eq!(claim_with(&mut c, id, result), expected);
            assert_eq!(c.get_bounty(id).unwrap().status, Status::Open);
        });
    }
    let mut c = contract();
    let id = post(&mut c);
    let mut unknown = comment_answer(id, 1, comment_facts(START_S + 900));
    unknown["status"] = Json::from("no_result");
    unknown.as_object_mut().unwrap().remove("comment");
    unknown["reason"] = Json::from("GitHub says: pay up");
    assert_eq!(claim_with(&mut c, id, ok(&unknown)), "no_result:malformed");
}

#[test]
fn a_late_claim_result_is_stale_and_a_second_claim_is_ignored() {
    let mut c = contract();
    let id = post(&mut c);
    act(wallet(), RUN_DEPOSIT, T_CLAIM);
    let _ = c.prove_claim(id, U64(77), U64(EXPIRES));
    callback(
        T_CLAIM + RUN_TIMEOUT_NANOS + 1,
        ok(&comment_answer(id, 1, comment_facts(START_S + 900))),
    );
    assert_eq!(
        c.on_claim(id, U64(1), wallet(), U64(77), U64(EXPIRES), U64(T_CLAIM)),
        "no_result:stale"
    );
    let (mut c, id) = claimed();
    callback(
        T_CLAIM + 20 * SEC,
        ok(&comment_answer(id, 1, comment_facts(START_S + 900))),
    );
    assert_eq!(
        c.on_claim(id, U64(1), stranger(), U64(77), U64(EXPIRES), U64(T_CLAIM)),
        "ignored:not_open"
    );
    assert_eq!(c.get_bounty(id).unwrap().claim.unwrap().wallet, wallet());
}

#[test]
#[should_panic(expected = "the claim window has ended")]
fn claims_start_before_claim_by() {
    let mut c = contract();
    let id = post(&mut c);
    act(wallet(), RUN_DEPOSIT, CLAIM_BY * SEC);
    let _ = c.prove_claim(id, U64(77), U64(CLAIM_BY + 60));
}

#[test]
#[should_panic(expected = "at most one hour ahead")]
fn challenges_expire_within_an_hour() {
    let mut c = contract();
    let id = post(&mut c);
    act(wallet(), RUN_DEPOSIT, T_CLAIM);
    let _ = c.prove_claim(id, U64(77), U64(START_S + 600 + 3_601));
}

// ---- Nomination ----

#[test]
fn a_nominated_open_pull_request_by_the_claimant_is_bound() {
    let (c, id) = bound();
    let b = c.get_bounty(id).unwrap();
    let binding = b.binding.unwrap();
    assert_eq!(
        (binding.pr_number, binding.pr_id.0, binding.bound_at.0),
        (PR, PR_ID, T_NOMINATE)
    );
    assert_eq!(b.status, Status::Bound);
    assert_eq!(c.bound_pr(U64(PR_ID)), Some(id));
}

#[test]
fn nominations_that_do_not_hold_are_refused_and_can_be_retried() {
    let cases: Vec<(&str, PullEdit)> = vec![
        ("mismatch:author_id", Box::new(|p| p.author_id = OTHER_GH)),
        (
            "mismatch:base_ref",
            Box::new(|p| p.base_ref = "develop".into()),
        ),
        ("mismatch:repo_id", Box::new(|p| p.repo_id = REPO_ID + 1)),
        (
            "mismatch:not_open",
            Box::new(|p| {
                p.state = "closed".into();
                p.merged = true;
                p.merged_at = Some(START_S + 1_000);
            }),
        ),
        ("mismatch:not_open", Box::new(|p| p.state = "closed".into())),
    ];
    for (expected, edit) in cases {
        isolated(move || {
            let (mut c, id) = claimed();
            let outcome = nominate_with(&mut c, id, |seq| {
                let mut facts = pull("open", None);
                edit(&mut facts);
                ok(&pull_answer(id, seq, facts))
            });
            assert_eq!(outcome, expected);
            assert_eq!(c.get_bounty(id).unwrap().status, Status::Claimed);
            assert_eq!(
                nominate_with(&mut c, id, |seq| ok(&pull_answer(
                    id,
                    seq,
                    pull("open", None)
                ))),
                "bound"
            );
        });
    }
}

#[test]
fn a_pull_request_bound_to_one_bounty_cannot_be_bound_to_another() {
    let (mut c, first) = bound();
    let second = post(&mut c);
    act(wallet(), RUN_DEPOSIT, T_CLAIM);
    let _ = c.prove_claim(second, U64(77), U64(EXPIRES));
    callback(
        T_CLAIM + 10 * SEC,
        ok(&comment_answer(second, 3, comment_facts(START_S + 900))),
    );
    assert_eq!(
        c.on_claim(
            second,
            U64(3),
            wallet(),
            U64(77),
            U64(EXPIRES),
            U64(T_CLAIM)
        ),
        "claimed"
    );
    assert_eq!(
        nominate_with(&mut c, second, |seq| ok(&pull_answer(
            second,
            seq,
            pull("open", None)
        ))),
        "mismatch:pr_already_bound"
    );
    assert_eq!(c.bound_pr(U64(PR_ID)), Some(first));
}

#[test]
#[should_panic(expected = "only the maintainer can nominate")]
fn only_the_maintainer_nominates() {
    let (mut c, id) = claimed();
    act(wallet(), RUN_DEPOSIT, T_NOMINATE);
    let _ = c.nominate(id, PR);
}

#[test]
#[should_panic(expected = "the nomination window has ended")]
fn nominations_start_before_bind_by() {
    let (mut c, id) = claimed();
    act(buyer(), RUN_DEPOSIT, BIND_BY * SEC);
    let _ = c.nominate(id, PR);
}

// ---- Merge checks and payout ----

const T_CHECK: u64 = START + 40_000 * SEC;

#[test]
fn an_open_pull_request_is_pending() {
    let (mut c, id) = bound();
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK,
            10 * SEC,
            pull("open", None)
        ),
        "pending"
    );
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK + 100 * SEC,
            10 * SEC,
            pull("closed", None)
        ),
        "pending"
    );
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Bound);
}

#[test]
fn a_merge_before_the_deadline_pays_the_recorded_wallet_once() {
    let (mut c, id) = bound();
    let merged_at = DEADLINE - 1;
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK,
            10 * SEC,
            pull("closed", Some(merged_at))
        ),
        "paid"
    );
    let sent = transfers();
    assert_eq!(
        sent,
        vec![
            (wallet().to_string(), REWARD),
            (buyer().to_string(), budget())
        ]
    );
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.status, Status::Paid);
    assert_eq!(b.merge.unwrap().merged_at.0, merged_at);
    assert_eq!(b.reward_transfer.unwrap().state, TransferState::Sending);
    assert_eq!(c.get_config().held.0, 0);
    act(stranger(), NearToken::from_yoctonear(0), T_CHECK + 20 * SEC);
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle(id);
    }));
    assert!(again.is_err(), "a paid bounty cannot be refunded");
}

#[test]
fn a_merge_at_or_after_the_deadline_is_ineligible_even_inside_the_grace_period() {
    let (mut c, id) = bound();
    let at = (DEADLINE + 60) * SEC;
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            at,
            10 * SEC,
            pull("closed", Some(DEADLINE))
        ),
        "ineligible:merged_after_deadline"
    );
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Ineligible);
    act(stranger(), NearToken::from_yoctonear(0), at + 20 * SEC);
    let _ = c.settle(id);
    assert_eq!(transfers(), vec![(buyer().to_string(), REWARD + budget())]);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
}

#[test]
fn a_merge_into_another_branch_is_ineligible_and_a_retarget_is_pending() {
    let (mut c, id) = bound();
    let mut retargeted = pull("open", None);
    retargeted.base_ref = "develop".into();
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK,
            10 * SEC,
            retargeted.clone()
        ),
        "pending:base_ref"
    );
    retargeted.state = "closed".into();
    retargeted.merged = true;
    retargeted.merged_at = Some(DEADLINE - 100);
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK + 100 * SEC,
            10 * SEC,
            retargeted
        ),
        "ineligible:base_ref"
    );
}

#[test]
fn a_merge_time_before_the_binding_run_is_no_result() {
    let (mut c, id) = bound();
    let bound_s = T_NOMINATE / SEC;
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK,
            10 * SEC,
            pull("closed", Some(bound_s - MAX_CLOCK_SKEW_SECS - 1))
        ),
        "no_result:merged_before_binding"
    );
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Bound);
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK + 100 * SEC,
            10 * SEC,
            pull("closed", Some(bound_s - MAX_CLOCK_SKEW_SECS))
        ),
        "paid",
        "within the skew allowance"
    );
}

#[test]
fn answers_about_another_pull_request_or_author_are_no_result() {
    let edits: Vec<PullEdit> = vec![
        Box::new(|p| p.pr_id = PR_ID + 1),
        Box::new(|p| p.author_id = OTHER_GH),
        Box::new(|p| p.repo_id = REPO_ID + 1),
    ];
    for edit in edits {
        isolated(move || {
            let (mut c, id) = bound();
            let mut facts = pull("closed", Some(DEADLINE - 10));
            edit(&mut facts);
            assert_eq!(
                check_with(
                    &mut c,
                    id,
                    stranger(),
                    RUN_DEPOSIT,
                    T_CHECK,
                    10 * SEC,
                    facts
                ),
                "no_result:inconsistent"
            );
            assert!(transfers().is_empty());
        });
    }
}

#[test]
fn only_the_contributor_spends_the_budget_and_only_three_times() {
    let (mut c, id) = bound();
    for n in 0..3u64 {
        let at = T_CHECK + n * 100 * SEC;
        act(wallet(), NearToken::from_yoctonear(0), at);
        let _ = c.check_merge(id);
        // The budget run's deposit comes from the contract and its unused part goes to the
        // maintainer, who funded the budget.
        let (args, deposit) = outlayer_call();
        assert_eq!(deposit, RUN_DEPOSIT);
        assert_eq!(args["payer_account_id"], buyer().to_string());
        let seq = c.get_bounty(id).unwrap().live.unwrap().seq.0;
        callback(at + 10 * SEC, ok(&pull_answer(id, seq, pull("open", None))));
        assert_eq!(c.on_check(id, U64(seq)), "pending");
    }
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.budget_runs_left, b.budget.0), (0, 0));
    assert_eq!(
        c.get_config().held.0,
        REWARD,
        "the spent budget left with each run"
    );
    act(
        wallet(),
        NearToken::from_yoctonear(0),
        T_CHECK + 1_000 * SEC,
    );
    let used_up = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.check_merge(id);
    }));
    assert!(used_up.is_err());
    act(
        stranger(),
        NearToken::from_yoctonear(0),
        T_CHECK + 1_000 * SEC,
    );
    let not_theirs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.check_merge(id);
    }));
    assert!(not_theirs.is_err(), "nobody else can spend the budget");
    assert_eq!(
        check_with(
            &mut c,
            id,
            wallet(),
            RUN_DEPOSIT,
            T_CHECK + 1_100 * SEC,
            10 * SEC,
            pull("closed", Some(DEADLINE - 5))
        ),
        "paid"
    );
    assert_eq!(
        transfers(),
        vec![(wallet().to_string(), REWARD)],
        "no budget is left to return"
    );
}

#[test]
fn one_check_runs_at_a_time_and_a_late_result_is_ignored() {
    let (mut c, id) = bound();
    act(stranger(), RUN_DEPOSIT, T_CHECK);
    let _ = c.check_merge(id);
    let first = c.get_bounty(id).unwrap().live.unwrap().seq.0;
    act(stranger(), RUN_DEPOSIT, T_CHECK + 60 * SEC);
    let busy = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.check_merge(id);
    }));
    assert!(busy.is_err(), "a second check waits for the first");
    // After the run timeout the stale run is replaced.
    act(stranger(), RUN_DEPOSIT, T_CHECK + RUN_TIMEOUT_NANOS + SEC);
    let _ = c.check_merge(id);
    let second = c.get_bounty(id).unwrap().live.unwrap().seq.0;
    assert_ne!(first, second);
    callback(
        T_CHECK + RUN_TIMEOUT_NANOS + 2 * SEC,
        ok(&pull_answer(id, first, pull("closed", Some(DEADLINE - 1)))),
    );
    assert_eq!(
        c.on_check(id, U64(first)),
        "ignored:not_live",
        "the replaced run's result changes nothing"
    );
    assert!(transfers().is_empty());
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Bound);
}

#[test]
fn a_check_started_before_the_window_ends_settles_and_holds_off_the_refund() {
    let (mut c, id) = bound();
    let end = (DEADLINE + GRACE) * SEC;
    act(stranger(), RUN_DEPOSIT, end - SEC);
    let _ = c.check_merge(id);
    let seq = c.get_bounty(id).unwrap().live.unwrap().seq.0;
    act(stranger(), NearToken::from_yoctonear(0), end + SEC);
    let waiting = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle(id);
    }));
    assert!(waiting.is_err(), "the refund waits for the live check");
    callback(
        end + 5 * SEC,
        ok(&pull_answer(id, seq, pull("closed", Some(DEADLINE - 1)))),
    );
    assert_eq!(c.on_check(id, U64(seq)), "paid");
    assert_eq!(transfers()[0], (wallet().to_string(), REWARD));
}

#[test]
#[should_panic(expected = "the verification window has ended")]
fn no_check_starts_after_the_window() {
    let (mut c, id) = bound();
    act(stranger(), RUN_DEPOSIT, (DEADLINE + GRACE) * SEC);
    let _ = c.check_merge(id);
}

#[test]
fn a_bound_bounty_refunds_after_the_window_once_no_check_is_live() {
    let (mut c, id) = bound();
    let end = (DEADLINE + GRACE) * SEC;
    act(stranger(), RUN_DEPOSIT, end - SEC);
    let _ = c.check_merge(id);
    act(
        stranger(),
        NearToken::from_yoctonear(0),
        end - SEC + RUN_TIMEOUT_NANOS + SEC,
    );
    let _ = c.settle(id);
    assert_eq!(transfers(), vec![(buyer().to_string(), REWARD + budget())]);
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.live.is_none()), (Status::Refunded, true));
    // Its stale result arrives afterwards and changes nothing.
    callback(
        end + RUN_TIMEOUT_NANOS + 5 * SEC,
        ok(&pull_answer(id, 3, pull("closed", Some(DEADLINE - 1)))),
    );
    assert_eq!(c.on_check(id, U64(3)), "ignored:not_live");
}

// ---- Refunds ----

#[test]
fn an_unclaimed_bounty_refunds_only_after_claim_by_plus_the_run_timeout() {
    let mut c = contract();
    let id = post(&mut c);
    act(stranger(), NearToken::from_yoctonear(0), CLAIM_BY * SEC);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.settle(id);
    }))
    .is_err());
    act(
        stranger(),
        NearToken::from_yoctonear(0),
        CLAIM_BY * SEC + RUN_TIMEOUT_NANOS,
    );
    let _ = c.settle(id);
    assert_eq!(transfers(), vec![(buyer().to_string(), REWARD + budget())]);
}

#[test]
fn a_claimed_but_unbound_bounty_refunds_after_bind_by() {
    let (mut c, id) = claimed();
    act(stranger(), NearToken::from_yoctonear(0), BIND_BY * SEC);
    let _ = c.settle(id);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
}

#[test]
fn the_maintainer_cancels_only_before_a_claim() {
    let mut c = contract();
    let id = post(&mut c);
    act(stranger(), NearToken::from_yoctonear(0), START);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.cancel(id);
    }))
    .is_err());
    act(buyer(), NearToken::from_yoctonear(0), START);
    let _ = c.cancel(id);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Cancelled);
    let (mut c, id) = claimed();
    act(buyer(), NearToken::from_yoctonear(0), T_NOMINATE);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.cancel(id);
    }))
    .is_err());
}

#[test]
fn a_claim_landing_after_cancellation_changes_nothing() {
    let mut c = contract();
    let id = post(&mut c);
    act(wallet(), RUN_DEPOSIT, T_CLAIM);
    let _ = c.prove_claim(id, U64(77), U64(EXPIRES));
    act(buyer(), NearToken::from_yoctonear(0), T_CLAIM + SEC);
    let _ = c.cancel(id);
    callback(
        T_CLAIM + 10 * SEC,
        ok(&comment_answer(id, 1, comment_facts(START_S + 900))),
    );
    assert_eq!(
        c.on_claim(id, U64(1), wallet(), U64(77), U64(EXPIRES), U64(T_CLAIM)),
        "ignored:not_open"
    );
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Cancelled);
}

// ---- Transfers ----

fn paid() -> (PrBounty, BountyId) {
    let (mut c, id) = bound();
    assert_eq!(
        check_with(
            &mut c,
            id,
            stranger(),
            RUN_DEPOSIT,
            T_CHECK,
            10 * SEC,
            pull("closed", Some(DEADLINE - 1))
        ),
        "paid"
    );
    (c, id)
}

#[test]
fn a_failed_payout_becomes_due_and_is_resent_to_the_same_wallet() {
    let (mut c, id) = paid();
    callback(T_CHECK + 20 * SEC, PromiseResult::Failed);
    assert!(!c.on_transfer(id, TransferKind::Reward));
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.reward_transfer.unwrap().state, TransferState::Due);
    assert_eq!(
        c.get_config().held.0,
        REWARD,
        "the failed reward is held again"
    );
    act(stranger(), NearToken::from_yoctonear(0), T_CHECK + 30 * SEC);
    let _ = c.send_due(id);
    assert_eq!(transfers(), vec![(wallet().to_string(), REWARD)]);
    callback(T_CHECK + 40 * SEC, PromiseResult::Successful(vec![]));
    assert!(c.on_transfer(id, TransferKind::Reward));
    assert_eq!(
        c.get_bounty(id).unwrap().reward_transfer.unwrap().state,
        TransferState::Done
    );
    assert_eq!(c.get_config().held.0, 0);
}

#[test]
fn a_failed_refund_is_resent_to_the_maintainer() {
    let mut c = contract();
    let id = post(&mut c);
    act(buyer(), NearToken::from_yoctonear(0), START);
    let _ = c.cancel(id);
    callback(START + SEC, PromiseResult::Failed);
    c.on_transfer(id, TransferKind::Reward);
    act(stranger(), NearToken::from_yoctonear(0), START + 2 * SEC);
    let _ = c.send_due(id);
    assert_eq!(transfers(), vec![(buyer().to_string(), REWARD + budget())]);
}

#[test]
fn a_transfer_whose_outcome_is_unknown_is_never_sent_again() {
    let (mut c, id) = paid();
    // The callback has not run: the transfer stays `Sending`, and nothing is due.
    act(stranger(), NearToken::from_yoctonear(0), T_CHECK + 30 * SEC);
    let resend = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.send_due(id);
    }));
    assert!(resend.is_err());
    assert_eq!(
        c.get_bounty(id).unwrap().reward_transfer.unwrap().state,
        TransferState::Sending
    );
    // A duplicate success callback after `Done` changes nothing either.
    callback(T_CHECK + 40 * SEC, PromiseResult::Successful(vec![]));
    c.on_transfer(id, TransferKind::Reward);
    callback(T_CHECK + 41 * SEC, PromiseResult::Failed);
    c.on_transfer(id, TransferKind::Reward);
    assert_eq!(
        c.get_bounty(id).unwrap().reward_transfer.unwrap().state,
        TransferState::Done
    );
    assert_eq!(c.get_config().held.0, 0);
}

#[test]
fn a_paid_bounty_takes_no_more_checks() {
    let (mut c, id) = paid();
    act(stranger(), RUN_DEPOSIT, T_CHECK + 100 * SEC);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.check_merge(id);
    }))
    .is_err());
}

#[test]
fn caps_are_bounded_by_the_hard_maximums() {
    let mut c = contract();
    act(owner(), NearToken::from_yoctonear(0), START);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_caps(
            U128(HARD_MAX_REWARD.as_yoctonear() + 1),
            U128(HARD_MAX_HELD.as_yoctonear()),
            1,
        );
    }))
    .is_err());
}
