use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const SPEC: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const FAKES: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const DELIVERABLE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const REPORT: &str = "4444444444444444444444444444444444444444444444444444444444444444";
const ATTESTATION: &str = "5555555555555555555555555555555555555555555555555555555555555555";
const SEC: u64 = 1_000_000_000;
const START: u64 = 1_000 * SEC;
const DEADLINE: u64 = START + 3_600 * SEC;
const WINDOW_SECS: u32 = 600;

fn owner() -> AccountId { accounts(0) }
fn relay() -> AccountId { accounts(1) }
fn buyer() -> AccountId { accounts(2) }
fn worker() -> AccountId { accounts(3) }
fn stranger() -> AccountId { accounts(4) }
fn token() -> AccountId { "usd.token.near".parse().unwrap() }

fn call(who: AccountId, deposit: NearToken, at: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(who)
        .attached_deposit(deposit)
        .block_timestamp(at)
        .build());
}

fn callback_with(result: PromiseResult) {
    let context = VMContextBuilder::new()
        .current_account_id(accounts(5))
        .predecessor_account_id(accounts(5))
        .build();
    testing_env!(context, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn zero() -> NearToken { NearToken::from_yoctonear(0) }
fn one_near() -> NearToken { NearToken::from_near(1) }

fn escrow() -> Escrow {
    call(owner(), zero(), START);
    let mut escrow = Escrow::new(owner(), relay());
    escrow.add_token(token());
    escrow
}

fn create(escrow: &mut Escrow, token: Option<AccountId>) -> JobId {
    call(buyer(), NearToken::from_millinear(50), START);
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(one_near().as_yoctonear()), token, U64(DEADLINE), WINDOW_SECS)
}

fn challenge(escrow: &mut Escrow, id: JobId, total: u32, caught: u32) {
    challenge_with_reference(escrow, id, true, total, caught);
}

fn challenge_with_reference(escrow: &mut Escrow, id: JobId, reference_passed: bool, total: u32, caught: u32) {
    call(relay(), zero(), START);
    escrow.record_challenge(id, SPEC.into(), FAKES.into(), reference_passed, total, caught, REPORT.into(), ATTESTATION.into());
}

fn funded() -> (Escrow, JobId) {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, 6, 6);
    call(buyer(), one_near(), START);
    escrow.fund(id);
    (escrow, id)
}

fn delivered() -> (Escrow, JobId) {
    let (mut escrow, id) = funded();
    call(worker(), zero(), START + 60 * SEC);
    escrow.deliver(id, DELIVERABLE.into());
    (escrow, id)
}

fn verdict(escrow: &mut Escrow, id: JobId, pass: bool, at: u64) {
    call(relay(), zero(), at);
    escrow.record_verdict(id, pass, SPEC.into(), DELIVERABLE.into(), REPORT.into(), ATTESTATION.into());
}

fn state(escrow: &Escrow, id: JobId) -> JobState {
    escrow.get_job(id).unwrap().state
}

#[test]
fn full_path_reaches_releasing() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, true, START + 120 * SEC);
    assert_eq!(state(&escrow, id), JobState::Passed);
    let _ = escrow.release(id);
    assert_eq!(state(&escrow, id), JobState::Releasing);
}

#[test]
fn failing_verdict_reaches_refunding() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, false, START + 120 * SEC);
    let _ = escrow.refund(id);
    assert_eq!(state(&escrow, id), JobState::Refunding);
}

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
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(1), None, U64(DEADLINE), WINDOW_SECS);
}

#[test]
#[should_panic(expected = "the worker cannot be the buyer")]
fn buyer_cannot_name_itself_as_worker() {
    let mut escrow = escrow();
    call(buyer(), NearToken::from_millinear(50), START);
    escrow.create_job(buyer(), SPEC.into(), FAKES.into(), U128(1), None, U64(DEADLINE), WINDOW_SECS);
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
    escrow.create_job(worker(), SPEC.into(), FAKES.into(), U128(1), None, U64(START), WINDOW_SECS);
}

#[test]
fn check_that_misses_a_fake_is_rejected_and_cannot_be_funded() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, 6, 5);
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
    assert_eq!(escrow.get_job(id).unwrap().fakes_caught, 5);
}

#[test]
#[should_panic(expected = "the check must pass its challenge first")]
fn rejected_check_cannot_be_funded() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, 6, 5);
    call(buyer(), one_near(), START);
    escrow.fund(id);
}

#[test]
fn check_that_fails_the_reference_is_rejected() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge_with_reference(&mut escrow, id, false, 6, 6);
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
fn check_that_faced_too_few_fakes_is_rejected() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, MIN_FAKES - 1, MIN_FAKES - 1);
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
fn check_with_no_fakes_is_rejected() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, 0, 0);
    assert_eq!(state(&escrow, id), JobState::CheckRejected);
}

#[test]
#[should_panic(expected = "the check must pass its challenge first")]
fn unchallenged_job_cannot_be_funded() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    call(buyer(), one_near(), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "fakes_hash does not match")]
fn challenge_for_other_fakes_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    call(relay(), zero(), START);
    escrow.record_challenge(id, SPEC.into(), REPORT.into(), true, 6, 6, REPORT.into(), ATTESTATION.into());
}

#[test]
#[should_panic(expected = "only the verifier relay")]
fn challenge_from_non_relay_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    call(buyer(), zero(), START);
    escrow.record_challenge(id, SPEC.into(), FAKES.into(), true, 6, 6, REPORT.into(), ATTESTATION.into());
}

#[test]
#[should_panic(expected = "the check has already been challenged")]
fn second_challenge_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, 6, 5);
    challenge(&mut escrow, id, 6, 6);
}

#[test]
#[should_panic(expected = "pay exactly the job amount")]
fn underfunding_is_refused() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, 6, 6);
    call(buyer(), NearToken::from_millinear(999), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "only the buyer can fund")]
fn stranger_cannot_fund() {
    let mut escrow = escrow();
    let id = create(&mut escrow, None);
    challenge(&mut escrow, id, 6, 6);
    call(stranger(), one_near(), START);
    escrow.fund(id);
}

#[test]
#[should_panic(expected = "pay in the job's token")]
fn token_job_cannot_be_funded_in_near() {
    let mut escrow = escrow();
    let id = create(&mut escrow, Some(token()));
    challenge(&mut escrow, id, 6, 6);
    call(buyer(), one_near(), START);
    escrow.fund(id);
}

#[test]
fn token_job_is_funded_through_ft_on_transfer() {
    let mut escrow = escrow();
    let id = create(&mut escrow, Some(token()));
    challenge(&mut escrow, id, 6, 6);
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
    challenge(&mut escrow, id, 6, 6);
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
#[should_panic(expected = "only the verifier relay")]
fn verdict_from_non_relay_is_refused() {
    let (mut escrow, id) = delivered();
    call(worker(), zero(), START + 120 * SEC);
    escrow.record_verdict(id, true, SPEC.into(), DELIVERABLE.into(), REPORT.into(), ATTESTATION.into());
}

#[test]
#[should_panic(expected = "job is not awaiting a verdict")]
fn second_verdict_is_refused() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, false, START + 120 * SEC);
    verdict(&mut escrow, id, true, START + 121 * SEC);
}

#[test]
#[should_panic(expected = "deliverable_hash does not match")]
fn verdict_for_other_deliverable_is_refused() {
    let (mut escrow, id) = delivered();
    call(relay(), zero(), START + 120 * SEC);
    escrow.record_verdict(id, true, SPEC.into(), REPORT.into(), REPORT.into(), ATTESTATION.into());
}

#[test]
#[should_panic(expected = "spec_hash does not match")]
fn verdict_for_other_spec_is_refused() {
    let (mut escrow, id) = delivered();
    call(relay(), zero(), START + 120 * SEC);
    escrow.record_verdict(id, true, FAKES.into(), DELIVERABLE.into(), REPORT.into(), ATTESTATION.into());
}

#[test]
#[should_panic(expected = "the verdict window has closed")]
fn late_verdict_is_refused() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, true, START + 60 * SEC + u64::from(WINDOW_SECS) * SEC + 1);
}

#[test]
#[should_panic(expected = "job has not passed")]
fn release_before_verdict_is_refused() {
    let (mut escrow, id) = delivered();
    let _ = escrow.release(id);
}

#[test]
#[should_panic(expected = "job has not passed")]
fn second_release_while_paying_is_refused() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, true, START + 120 * SEC);
    let _ = escrow.release(id);
    let _ = escrow.release(id);
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
fn delivered_job_expires_when_relay_misses_the_window() {
    let (mut escrow, id) = delivered();
    call(stranger(), zero(), START + 60 * SEC + u64::from(WINDOW_SECS) * SEC + 1);
    let _ = escrow.expire(id);
    assert_eq!(state(&escrow, id), JobState::Expiring);
}

#[test]
#[should_panic(expected = "job has not expired")]
fn passed_job_cannot_expire() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, true, START + 120 * SEC);
    call(stranger(), zero(), DEADLINE + 10_000 * SEC);
    let _ = escrow.expire(id);
}

#[test]
fn successful_payout_settles_the_job() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, true, START + 120 * SEC);
    let _ = escrow.release(id);
    callback_with(PromiseResult::Successful(vec![]));
    assert!(escrow.on_payout(id, JobState::Released, JobState::Passed));
    assert_eq!(state(&escrow, id), JobState::Released);
}

#[test]
fn failed_payout_returns_the_job_for_a_retry() {
    let (mut escrow, id) = delivered();
    verdict(&mut escrow, id, true, START + 120 * SEC);
    let _ = escrow.release(id);
    callback_with(PromiseResult::Failed);
    assert!(!escrow.on_payout(id, JobState::Released, JobState::Passed));
    assert_eq!(state(&escrow, id), JobState::Passed);
    call(stranger(), zero(), START + 130 * SEC);
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
fn owner_can_rotate_the_relay() {
    let mut escrow = escrow();
    call(owner(), zero(), START);
    escrow.set_relay(stranger());
    assert_eq!(escrow.get_config().relay, stranger());
}

#[test]
#[should_panic(expected = "only the owner")]
fn stranger_cannot_rotate_the_relay() {
    let mut escrow = escrow();
    call(stranger(), zero(), START);
    escrow.set_relay(stranger());
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
