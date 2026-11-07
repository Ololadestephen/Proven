use super::*;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const START: u64 = 1_000 * NANOS;

fn buyer() -> AccountId {
    accounts(0)
}
fn agent() -> AccountId {
    accounts(1)
}
fn second() -> AccountId {
    accounts(2)
}
fn reviewer() -> AccountId {
    accounts(4)
}
fn escrow() -> AccountId {
    accounts(5)
}
fn board_owner() -> AccountId {
    "owner.near".parse().unwrap()
}
fn this() -> AccountId {
    "board.near".parse().unwrap()
}

fn builder(who: AccountId, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(this())
        .predecessor_account_id(who)
        .attached_deposit(deposit)
        .block_timestamp(START)
        .storage_usage(1_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn context(who: AccountId, deposit: NearToken) {
    testing_env!(builder(who, deposit).build());
}

/// The board's own callback, seeing `result`.
fn callback(result: PromiseResult) {
    testing_env!(
        builder(this(), NearToken::from_yoctonear(0)).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn posted(board: &mut Board, attempts: u32, check: &str) -> BidId {
    context(buyer(), NearToken::from_near(2));
    let _ = board.post_bid(
        "Convert these invoices".to_string(),
        U128(NearToken::from_near(1).as_yoctonear()),
        check.to_string(),
        HASH.to_string(),
        HASH.to_string(),
        "{}".to_string(),
        U64(START + 3_600 * NANOS),
        true,
        3_600,
        attempts,
        None,
    );
    board.next_bid - 1
}

fn json_result(value: near_sdk::serde_json::Value) -> PromiseResult {
    PromiseResult::Successful(value.to_string().into_bytes())
}

/// A bid whose escrow job is 7, reviewed and open, with two registered agents.
fn open_board(attempts: u32) -> (Board, BidId) {
    context(buyer(), NearToken::from_yoctonear(0));
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    let id = posted(&mut board, attempts, HASH);
    callback(json_result(json!(7)));
    assert!(board.on_job_created(id));
    context(reviewer(), NearToken::from_yoctonear(0));
    board.record_review(
        id,
        true,
        HASH.to_string(),
        "model".to_string(),
        "chat".to_string(),
    );
    for who in [agent(), second()] {
        context(who, NearToken::from_near(1));
        board.register_agent(
            HASH.to_string(),
            HASH.to_string(),
            HASH.to_string(),
            "model".to_string(),
            None,
        );
    }
    (board, id)
}

fn claimed(attempts: u32) -> (Board, BidId) {
    let (mut board, id) = open_board(attempts);
    context(agent(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
    callback(PromiseResult::Successful(vec![]));
    assert!(board.on_assigned(id, 1));
    (board, id)
}

fn job(
    state: &str,
    worker: Option<AccountId>,
    history: near_sdk::serde_json::Value,
) -> PromiseResult {
    json_result(json!({ "buyer": buyer(), "worker": worker, "state": state, "history": history }))
}

fn attempt(
    worker: AccountId,
    outcome: &str,
    rule: Option<&str>,
    verdict: bool,
) -> near_sdk::serde_json::Value {
    json!({ "worker": worker, "outcome": outcome, "failed_rule": rule, "verdict_request_id": if verdict { Some("9") } else { None } })
}

fn view(worker: AccountId, outcome: &str, rule: Option<&str>, verdict: bool) -> AttemptView {
    near_sdk::serde_json::from_value(attempt(worker, outcome, rule, verdict)).unwrap()
}

/// Transfers this call scheduled, as (receiver, yoctoNEAR).
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
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

#[test]
fn an_attempt_fee_follows_only_the_recorded_outcome() {
    assert!(fee_goes_to_worker(&view(
        agent(),
        "Failed",
        Some("totals"),
        true
    )));
    assert!(!fee_goes_to_worker(&view(
        agent(),
        "Failed",
        Some("format"),
        true
    )));
    assert!(!fee_goes_to_worker(&view(
        agent(),
        "Failed",
        Some("totals"),
        false
    )));
    for outcome in ["Paid", "NoDelivery", "NoVerdict"] {
        assert!(!fee_goes_to_worker(&view(agent(), outcome, None, true)));
    }
}

#[test]
fn posting_keeps_the_fees_and_forwards_the_rest_to_the_escrow() {
    context(buyer(), NearToken::from_yoctonear(0));
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    let id = posted(&mut board, 3, HASH);
    let receipt = get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == escrow())
        .unwrap();
    let (method, args, forwarded) = receipt
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } => Some((
                String::from_utf8(method_name.clone()).unwrap(),
                args.clone(),
                *attached_deposit,
            )),
            _ => None,
        })
        .unwrap();
    assert_eq!(method, "create_open_job");
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args).unwrap();
    assert_eq!(args["buyer"], json!(buyer()));
    assert_eq!(args["max_attempts"], 3);
    let fees = ATTEMPT_FEE
        .saturating_add(FEE_RECORD_DEPOSIT)
        .saturating_mul(3);
    assert!(forwarded < NearToken::from_near(2).saturating_sub(fees));
    assert_eq!(board.get_bid(id).unwrap().state, BidState::Pending);
}

#[test]
fn a_refused_job_removes_the_bid_and_returns_everything() {
    context(buyer(), NearToken::from_yoctonear(0));
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    let id = posted(&mut board, 1, HASH);
    callback(PromiseResult::Failed);
    assert!(!board.on_job_created(id));
    assert!(board.get_bid(id).is_none());
    assert_eq!(
        transfers(),
        vec![(buyer().to_string(), NearToken::from_near(2).as_yoctonear())]
    );
    // The check can be used again.
    posted(&mut board, 1, HASH);
}

#[test]
#[should_panic(expected = "this exact check was already used on a bid")]
fn the_same_check_cannot_be_on_two_bids() {
    let (mut board, _) = open_board(1);
    posted(&mut board, 1, HASH);
}

#[test]
#[should_panic(expected = "only the reviewer can record a review")]
fn only_the_reviewer_reviews() {
    context(buyer(), NearToken::from_yoctonear(0));
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    let id = posted(&mut board, 1, HASH);
    callback(json_result(json!(7)));
    board.on_job_created(id);
    context(agent(), NearToken::from_yoctonear(0));
    board.record_review(id, true, HASH.to_string(), "m".to_string(), "c".to_string());
}

#[test]
#[should_panic(expected = "this bid cannot be claimed now")]
fn an_unreviewed_bid_cannot_be_claimed() {
    context(buyer(), NearToken::from_yoctonear(0));
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    let id = posted(&mut board, 1, HASH);
    callback(json_result(json!(7)));
    board.on_job_created(id);
    context(agent(), NearToken::from_near(1));
    board.register_agent(HASH.into(), HASH.into(), HASH.into(), "m".into(), None);
    context(agent(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
}

#[test]
#[should_panic(expected = "only a registered agent can claim")]
fn an_unregistered_account_cannot_claim() {
    let (mut board, id) = open_board(1);
    context(accounts(3), CLAIM_DEPOSIT);
    let _ = board.claim(id);
}

#[test]
#[should_panic(expected = "this bid cannot be claimed now")]
fn one_claim_at_a_time() {
    let (mut board, id) = claimed(2);
    context(second(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
}

#[test]
fn a_claim_asks_the_escrow_to_assign_the_agent() {
    let (mut board, id) = open_board(1);
    context(agent(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
    let receipt = get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == escrow())
        .unwrap();
    let args = receipt
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { args, .. } => Some(args.clone()),
            _ => None,
        })
        .unwrap();
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args).unwrap();
    assert_eq!(args, json!({ "job_id": 7, "worker": agent() }));
    assert_eq!(board.get_bid(id).unwrap().state, BidState::Assigning);
}

#[test]
fn a_refused_assignment_undoes_the_claim_and_keeps_the_attempt() {
    let (mut board, id) = open_board(1);
    context(agent(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
    callback(PromiseResult::Failed);
    assert!(!board.on_assigned(id, 1));
    let bid = board.get_bid(id).unwrap();
    assert_eq!(bid.state, BidState::Open);
    assert!(bid.claim.is_none());
    assert_eq!(board.get_attempt(id, agent()), None);
    assert_eq!(
        transfers(),
        vec![(agent().to_string(), CLAIM_DEPOSIT.as_yoctonear())]
    );
}

#[test]
fn a_callback_for_an_earlier_claim_changes_nothing() {
    let (mut board, id) = claimed(1);
    callback(PromiseResult::Failed);
    assert!(!board.on_assigned(id, 99));
    assert_eq!(board.get_bid(id).unwrap().state, BidState::Claimed);
}

#[test]
fn a_failed_attempt_frees_the_bid_and_pays_its_fee_by_its_outcome() {
    let (mut board, id) = claimed(2);
    callback(job(
        "Open",
        None,
        json!([attempt(agent(), "Failed", Some("totals"), true)]),
    ));
    assert_eq!(board.on_sync(id, Some(1)), BidState::Open);
    assert_eq!(
        transfers(),
        vec![(agent().to_string(), ATTEMPT_FEE.as_yoctonear())]
    );
    let bid = board.get_bid(id).unwrap();
    assert_eq!(bid.funded_attempts, 1);
    assert_eq!(bid.fees, vec![FeeState::Paying, FeeState::Held]);
    assert_eq!(board.get_attempt(id, agent()), Some(Attempt::Used));
    // The same agent cannot claim again; another can.
    context(second(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
}

#[test]
#[should_panic(expected = "this account has used its attempt on this bid")]
fn an_agent_gets_one_attempt_per_bid() {
    let (mut board, id) = claimed(2);
    callback(job(
        "Open",
        None,
        json!([attempt(agent(), "NoDelivery", None, false)]),
    ));
    board.on_sync(id, Some(1));
    context(agent(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
}

#[test]
fn a_paid_job_finishes_the_bid_and_returns_the_unused_fees() {
    let (mut board, id) = claimed(3);
    callback(job(
        "Released",
        Some(agent()),
        json!([attempt(agent(), "Paid", None, true)]),
    ));
    assert_eq!(board.on_sync(id, Some(1)), BidState::Done);
    let fee = ATTEMPT_FEE.as_yoctonear();
    assert_eq!(
        transfers(),
        vec![
            (buyer().to_string(), fee),
            (buyer().to_string(), fee),
            (buyer().to_string(), fee),
        ]
    );
}

#[test]
fn a_fee_is_settled_once() {
    let (mut board, id) = claimed(2);
    let failed = || {
        job(
            "Open",
            None,
            json!([attempt(agent(), "Failed", Some("totals"), true)]),
        )
    };
    callback(failed());
    board.on_sync(id, Some(1));
    callback(failed());
    board.on_sync(id, Some(1));
    assert!(transfers().is_empty());
}

#[test]
fn a_failed_fee_transfer_can_be_settled_again() {
    let (mut board, id) = claimed(2);
    callback(job(
        "Open",
        None,
        json!([attempt(agent(), "NoDelivery", None, false)]),
    ));
    board.on_sync(id, Some(1));
    callback(PromiseResult::Failed);
    assert!(!board.on_fee_paid(id, 0, false));
    assert_eq!(board.get_bid(id).unwrap().fees[0], FeeState::Held);
    callback(job(
        "Open",
        None,
        json!([attempt(agent(), "NoDelivery", None, false)]),
    ));
    board.on_sync(id, Some(1));
    assert_eq!(
        transfers(),
        vec![(buyer().to_string(), ATTEMPT_FEE.as_yoctonear())]
    );
}

#[test]
fn a_failed_read_changes_nothing() {
    let (mut board, id) = claimed(1);
    callback(PromiseResult::Failed);
    assert_eq!(board.on_sync(id, Some(1)), BidState::Claimed);
    callback(PromiseResult::Successful(b"not json".to_vec()));
    assert_eq!(board.on_sync(id, Some(1)), BidState::Claimed);
    assert!(transfers().is_empty());
}

#[test]
fn a_rejected_check_asks_the_escrow_to_refund_the_buyer() {
    let (mut board, id) = open_board(1);
    callback(job("CheckRejected", None, json!([])));
    board.on_sync(id, Some(1));
    let closes = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == escrow())
        .count();
    assert_eq!(closes, 1);
}

#[test]
#[should_panic(expected = "only the buyer can close a bid before it expires")]
fn a_stranger_cannot_close_a_bid_before_it_expires() {
    let (mut board, id) = open_board(1);
    context(accounts(3), NearToken::from_yoctonear(0));
    let _ = board.close_bid(id);
}

#[test]
#[should_panic(expected = "this bid cannot be closed now")]
fn a_bid_with_an_agent_on_it_cannot_be_closed() {
    let (mut board, id) = claimed(1);
    context(buyer(), NearToken::from_yoctonear(0));
    let _ = board.close_bid(id);
}

#[test]
fn the_buyer_closes_an_open_bid_through_the_escrow() {
    let (mut board, id) = open_board(1);
    context(buyer(), NearToken::from_yoctonear(0));
    let _ = board.close_bid(id);
    callback(job("Refunded", None, json!([])));
    assert_eq!(board.on_sync(id, Some(1)), BidState::Closed);
    assert_eq!(
        transfers(),
        vec![(buyer().to_string(), ATTEMPT_FEE.as_yoctonear())]
    );
}

#[test]
fn a_stale_sync_cannot_end_a_newer_claim() {
    let (mut board, id) = claimed(2);
    // A sync started before this claim existed read the job before the escrow assigned it.
    callback(job("Open", None, json!([])));
    assert_eq!(board.on_sync(id, None), BidState::Claimed);
    // Even for the claim it saw, nothing ends without the escrow recording that attempt.
    callback(job("Open", None, json!([])));
    assert_eq!(board.on_sync(id, Some(1)), BidState::Claimed);
}

#[test]
fn a_blocked_review_asks_the_escrow_to_refund_the_buyer() {
    context(buyer(), NearToken::from_yoctonear(0));
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    let id = posted(&mut board, 1, HASH);
    callback(json_result(json!(7)));
    board.on_job_created(id);
    context(reviewer(), NearToken::from_yoctonear(0));
    board.record_review(id, false, HASH.into(), "m".into(), "c".into());
    let closes = get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == escrow())
        .count();
    assert_eq!(closes, 1);
    assert_eq!(board.get_bid(id).unwrap().state, BidState::Blocked);
}

#[test]
fn closing_a_bid_before_its_review_still_ends_it() {
    context(buyer(), NearToken::from_yoctonear(0));
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    let id = posted(&mut board, 1, HASH);
    callback(json_result(json!(7)));
    board.on_job_created(id);
    callback(job("Refunded", None, json!([])));
    assert_eq!(board.on_sync(id, None), BidState::Closed);
}

fn none() -> NearToken {
    NearToken::from_yoctonear(0)
}

/// A one-attempt bid whose worker failed a real rule: the job was refunded and the fee paid.
fn ended_and_settled() -> (Board, BidId) {
    let (mut board, id) = claimed(1);
    callback(job(
        "Refunded",
        None,
        json!([attempt(agent(), "Failed", Some("totals"), true)]),
    ));
    assert_eq!(board.on_sync(id, Some(1)), BidState::Closed);
    callback(PromiseResult::Successful(vec![]));
    assert!(board.on_fee_paid(id, 0, true));
    (board, id)
}

#[test]
fn a_closed_market_takes_bids_only_from_listed_buyers() {
    context(buyer(), none());
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    context(board_owner(), none());
    board.set_market_open(false);
    board.add_buyers(vec![buyer()]);
    posted(&mut board, 1, HASH);
    assert_eq!(board.get_access().buyers, vec![buyer()]);
    assert!(!board.get_access().open);
}

#[test]
#[should_panic(expected = "the market is closed to this account")]
fn a_closed_market_refuses_an_unlisted_buyer() {
    context(buyer(), none());
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    context(board_owner(), none());
    board.set_market_open(false);
    posted(&mut board, 1, HASH);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_changes_who_may_post() {
    context(buyer(), none());
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    context(buyer(), none());
    board.set_market_open(true);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_the_owner_changes_the_reviewer() {
    context(buyer(), none());
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    context(reviewer(), none());
    board.set_reviewer(buyer());
}

#[test]
fn the_owner_changes_the_reviewer_and_hands_the_board_over_in_two_steps() {
    context(buyer(), none());
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    context(board_owner(), none());
    board.set_reviewer(second());
    assert_eq!(board.get_config().reviewer, second());
    board.propose_owner(Some(agent()));
    assert_eq!(board.get_config().owner, board_owner());
    context(agent(), none());
    board.accept_owner();
    assert_eq!(board.get_config().owner, agent());
    assert_eq!(board.get_config().pending_owner, None);
}

#[test]
#[should_panic(expected = "only the proposed owner can accept")]
fn nobody_else_can_take_the_board() {
    context(buyer(), none());
    let mut board = Board::new(escrow(), reviewer(), board_owner());
    context(board_owner(), none());
    board.propose_owner(Some(agent()));
    context(second(), none());
    board.accept_owner();
}

#[test]
fn each_attempt_counts_once_in_its_agents_record() {
    let (mut board, id) = claimed(3);
    let history = json!([attempt(agent(), "Failed", Some("totals"), true)]);
    callback(job("Open", None, history.clone()));
    board.on_sync(id, Some(1));
    // A second sync of the same history counts nothing more.
    callback(job("Open", None, history));
    board.on_sync(id, None);
    assert_eq!(
        board.get_agent_record(agent()),
        AgentRecord {
            failed: 1,
            ..Default::default()
        }
    );
    context(second(), CLAIM_DEPOSIT);
    let _ = board.claim(id);
    callback(PromiseResult::Successful(vec![]));
    assert!(board.on_assigned(id, 2));
    callback(job(
        "Open",
        None,
        json!([
            attempt(agent(), "Failed", Some("totals"), true),
            attempt(second(), "Failed", Some("format"), true),
        ]),
    ));
    board.on_sync(id, Some(2));
    assert_eq!(
        board.get_agent_record(agent()),
        AgentRecord {
            failed: 1,
            ..Default::default()
        }
    );
    assert_eq!(
        board.get_agent_record(second()),
        AgentRecord {
            failed_format: 1,
            ..Default::default()
        }
    );
}

#[test]
fn every_outcome_has_its_own_count() {
    let (mut board, id) = claimed(3);
    callback(job(
        "Released",
        Some(agent()),
        json!([
            attempt(agent(), "NoDelivery", None, false),
            attempt(agent(), "NoVerdict", None, false),
            attempt(agent(), "Paid", None, true),
        ]),
    ));
    board.on_sync(id, Some(1));
    assert_eq!(
        board.get_agent_record(agent()),
        AgentRecord {
            paid: 1,
            no_delivery: 1,
            no_verdict: 1,
            ..Default::default()
        }
    );
}

#[test]
fn a_finished_bid_keeps_its_hashes_and_a_title_and_gives_back_storage_once() {
    let (mut board, id) = ended_and_settled();
    let before = board.get_bid(id).unwrap();
    context(second(), none());
    let _ = board.finish_bid(id);
    let sent = transfers();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, buyer().to_string());
    assert!(sent[0].1 > 0 && sent[0].1 < before.storage_paid.0);
    let after = board.get_bid(id).unwrap();
    assert!(after.finished);
    assert_eq!(after.description, "Convert these invoices");
    assert_eq!(after.format, "");
    assert_eq!(after.check_hash, before.check_hash);
    assert_eq!(after.format_hash, before.format_hash);
    assert_eq!(after.storage_paid.0, before.storage_paid.0 - sent[0].1);
    // The check still cannot be used again.
    context(buyer(), NearToken::from_near(2));
    let reused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        posted(&mut board, 1, HASH);
    }));
    assert!(reused.is_err());
}

#[test]
#[should_panic(expected = "no storage is left to return")]
fn a_bid_gives_back_storage_only_once() {
    let (mut board, id) = ended_and_settled();
    context(second(), none());
    let _ = board.finish_bid(id);
    context(second(), none());
    let _ = board.finish_bid(id);
}

#[test]
fn a_failed_storage_return_can_be_retried() {
    let (mut board, id) = ended_and_settled();
    let paid = board.get_bid(id).unwrap().storage_paid;
    context(second(), none());
    let _ = board.finish_bid(id);
    let back = transfers()[0].1;
    callback(PromiseResult::Failed);
    assert!(!board.on_storage_returned(id, U128(back)));
    assert_eq!(board.get_bid(id).unwrap().storage_paid, paid);
    context(second(), none());
    let _ = board.finish_bid(id);
    assert_eq!(transfers()[0].1, back);
}

#[test]
#[should_panic(expected = "every attempt fee must be settled first")]
fn a_bid_with_a_fee_in_flight_keeps_its_storage() {
    let (mut board, id) = claimed(1);
    callback(job(
        "Refunded",
        None,
        json!([attempt(agent(), "Failed", Some("totals"), true)]),
    ));
    board.on_sync(id, Some(1));
    context(second(), none());
    let _ = board.finish_bid(id);
}

#[test]
#[should_panic(expected = "only a bid that has ended can give back storage")]
fn an_open_bid_keeps_its_storage() {
    let (mut board, id) = open_board(1);
    context(second(), none());
    let _ = board.finish_bid(id);
}

#[test]
fn a_title_is_the_first_line_cut_on_a_character() {
    assert_eq!(title_of("Fix the build\nDetails here"), "Fix the build");
    let long = "é".repeat(100);
    let title = title_of(&long);
    assert!(title.len() <= 120);
    assert!(title.chars().all(|c| c == 'é'));
}
