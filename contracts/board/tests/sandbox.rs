//! The board against the real compiled escrow and a mock of the OutLayer contract. Build all three
//! first: `cargo near build non-reproducible-wasm` in `contracts/board`, `contracts/escrow` and
//! `contracts/mock-outlayer`.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const CHECK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const REFERENCE: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const DELIVERABLE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const VERIFIER: &str = "5555555555555555555555555555555555555555555555555555555555555555";
const OTHER: &str = "6666666666666666666666666666666666666666666666666666666666666666";
const SEC: u64 = 1_000_000_000;
const WINDOW: u64 = 60;
const NONE: NearToken = NearToken::from_yoctonear(0);
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

struct Env {
    sandbox: Worker<Sandbox>,
    board: Contract,
    escrow: Contract,
    outlayer: Contract,
    reviewer: Account,
    buyer: Account,
    agent: Account,
    second: Account,
    stranger: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let escrow = sandbox
        .dev_deploy(&std::fs::read("../escrow/target/near/proven_escrow.wasm")?)
        .await?;
    let outlayer = sandbox
        .dev_deploy(&std::fs::read(
            "../mock-outlayer/target/near/proven_mock_outlayer.wasm",
        )?)
        .await?;
    let board = sandbox
        .dev_deploy(&std::fs::read("target/near/proven_board.wasm")?)
        .await?;
    let owner = sandbox.dev_create_account().await?;
    let reviewer = sandbox.dev_create_account().await?;
    let buyer = sandbox.dev_create_account().await?;
    let agent = sandbox.dev_create_account().await?;
    let second = sandbox.dev_create_account().await?;
    let stranger = sandbox.dev_create_account().await?;
    outlayer.call("new").transact().await?.into_result()?;
    escrow
        .call("new")
        .args_json(json!({
            "owner": owner.id(), "outlayer": outlayer.id(),
            "verifier_url": "https://example.test/verifier.wasm",
            "verifier_hash": VERIFIER, "secrets_owner": owner.id(),
        }))
        .transact()
        .await?
        .into_result()?;
    board
        .call("new")
        .args_json(json!({ "escrow": escrow.id(), "reviewer": reviewer.id() }))
        .transact()
        .await?
        .into_result()?;
    let env = Env {
        sandbox,
        board,
        escrow,
        outlayer,
        reviewer,
        buyer,
        agent,
        second,
        stranger,
    };
    register(&env, &env.agent).await?;
    register(&env, &env.second).await?;
    Ok(env)
}

async fn on_board(
    env: &Env,
    who: &Account,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.board.id(), method)
        .args_json(args)
        .deposit(deposit)
        .max_gas()
        .transact()
        .await?)
}

async fn on_escrow(
    env: &Env,
    who: &Account,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.escrow.id(), method)
        .args_json(args)
        .deposit(deposit)
        .max_gas()
        .transact()
        .await?)
}

fn refused(result: &ExecutionFinalResult, reason: &str) {
    assert!(result.is_failure(), "expected a refusal: {reason}");
    let failure = format!("{:?}", result.clone().into_result().unwrap_err());
    assert!(
        failure.contains(reason),
        "expected {reason:?}, got {failure}"
    );
}

async fn register(env: &Env, who: &Account) -> anyhow::Result<()> {
    on_board(
        env,
        who,
        "register_agent",
        json!({ "prompt_hash": CHECK, "knowledge_hash": REFERENCE, "tools_hash": VERIFIER, "model": "z-ai/glm-5.3-flash" }),
        NearToken::from_millinear(100),
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn post(env: &Env) -> anyhow::Result<u64> {
    Ok(on_board(
        env,
        &env.buyer,
        "post_bid",
        json!({
            "description": "Convert these invoice lines to JSON.", "amount": ONE_NEAR.to_string(),
            "check_hash": CHECK, "reference_hash": REFERENCE, "verifier_hash": VERIFIER,
            "claim_window_secs": WINDOW,
        }),
        NearToken::from_millinear(100),
    )
    .await?
    .into_result()?
    .json()?)
}

async fn review(env: &Env, bid: u64, allow: bool) -> anyhow::Result<ExecutionFinalResult> {
    on_board(
        env,
        &env.reviewer,
        "record_review",
        json!({ "bid_id": bid, "allow": allow, "review_hash": OTHER, "model": "m", "chat_id": "c" }),
        NONE,
    )
    .await
}

async fn open_bid(env: &Env) -> anyhow::Result<u64> {
    let bid = post(env).await?;
    review(env, bid, true).await?.into_result()?;
    Ok(bid)
}

async fn claim(env: &Env, who: &Account, bid: u64) -> anyhow::Result<ExecutionFinalResult> {
    on_board(
        env,
        who,
        "claim",
        json!({ "bid_id": bid }),
        NearToken::from_millinear(5),
    )
    .await
}

async fn link(env: &Env, bid: u64, job: u64) -> anyhow::Result<ExecutionFinalResult> {
    on_board(
        env,
        &env.stranger,
        "link_job",
        json!({ "bid_id": bid, "job_id": job }),
        NONE,
    )
    .await
}

async fn sync(env: &Env, bid: u64) -> anyhow::Result<String> {
    Ok(
        on_board(env, &env.stranger, "sync", json!({ "bid_id": bid }), NONE)
            .await?
            .into_result()?
            .json()?,
    )
}

async fn bid_of(env: &Env, bid: u64) -> anyhow::Result<Value> {
    Ok(env
        .board
        .view("get_bid")
        .args_json(json!({ "bid_id": bid }))
        .await?
        .json()?)
}

async fn attempt(env: &Env, bid: u64, who: &Account) -> anyhow::Result<Value> {
    Ok(env
        .board
        .view("get_attempt")
        .args_json(json!({ "bid_id": bid, "account": who.id() }))
        .await?
        .json()?)
}

async fn job_for(
    env: &Env,
    buyer: &Account,
    worker: &Account,
    check: &str,
    amount: u128,
) -> anyhow::Result<u64> {
    let now = env.sandbox.view_block().await?.timestamp();
    Ok(on_escrow(
        env,
        buyer,
        "create_job",
        json!({
            "worker": worker.id(), "spec_hash": check, "fakes_hash": REFERENCE,
            "amount": amount.to_string(), "token": null,
            "deadline": (now + 3_600 * SEC).to_string(), "verdict_window_secs": 1_800,
            "verifier_hash": VERIFIER,
        }),
        NearToken::from_millinear(50),
    )
    .await?
    .into_result()?
    .json()?)
}

async fn behave(env: &Env, behaviour: &str) -> anyhow::Result<()> {
    env.outlayer
        .call("set_behaviour")
        .args_json(json!({ "behaviour": behaviour }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn run(env: &Env, method: &str, job: u64) -> anyhow::Result<()> {
    on_escrow(
        env,
        &env.stranger,
        method,
        json!({ "job_id": job }),
        NearToken::from_millinear(100),
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn challenged(env: &Env, job: u64) -> anyhow::Result<()> {
    behave(env, "strong_check").await?;
    run(env, "request_challenge", job).await
}

async fn fund(env: &Env, job: u64) -> anyhow::Result<()> {
    on_escrow(
        env,
        &env.buyer,
        "fund",
        json!({ "job_id": job }),
        NearToken::from_near(1),
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn deliver(env: &Env, who: &Account, job: u64) -> anyhow::Result<ExecutionFinalResult> {
    on_escrow(
        env,
        who,
        "deliver",
        json!({ "job_id": job, "deliverable_hash": DELIVERABLE }),
        NONE,
    )
    .await
}

async fn funded_job(env: &Env, bid: u64, who: &Account) -> anyhow::Result<u64> {
    let job = job_for(env, &env.buyer, who, CHECK, ONE_NEAR).await?;
    link(env, bid, job).await?.into_result()?;
    challenged(env, job).await?;
    fund(env, job).await?;
    Ok(job)
}

async fn settle(env: &Env, job: u64, behaviour: &str, method: &str) -> anyhow::Result<()> {
    behave(env, behaviour).await?;
    run(env, "request_verification", job).await?;
    on_escrow(env, &env.stranger, method, json!({ "job_id": job }), NONE)
        .await?
        .into_result()?;
    Ok(())
}

async fn advance(env: &Env, secs: u64) -> anyhow::Result<()> {
    let target = env.sandbox.view_block().await?.timestamp() + secs * SEC;
    for _ in 0..200 {
        if env.sandbox.view_block().await?.timestamp() > target {
            return Ok(());
        }
        env.sandbox.fast_forward(100).await?;
    }
    anyhow::bail!("the sandbox clock did not advance")
}

#[tokio::test]
async fn a_passing_job_finishes_the_bid_and_only_the_escrow_pays() -> anyhow::Result<()> {
    let env = setup().await?;
    let bid = open_bid(&env).await?;
    let board_before = env.board.view_account().await?.balance.as_yoctonear();
    claim(&env, &env.agent, bid).await?.into_result()?;
    let job = funded_job(&env, bid, &env.agent).await?;
    assert_eq!(bid_of(&env, bid).await?["state"], "Claimed");
    deliver(&env, &env.agent, job).await?.into_result()?;

    // Syncing while the job runs changes nothing, and nothing moved through the board.
    assert_eq!(sync(&env, bid).await?, "Claimed");
    let earned_before = env.agent.view_account().await?.balance.as_yoctonear();
    settle(&env, job, "pass", "release").await?;
    assert_eq!(
        env.agent.view_account().await?.balance.as_yoctonear() - earned_before,
        ONE_NEAR
    );
    assert_eq!(sync(&env, bid).await?, "Done");
    assert_eq!(attempt(&env, bid, &env.agent).await?, json!("Used"));
    let board_after = env.board.view_account().await?.balance.as_yoctonear();
    assert!(
        board_after < board_before + ONE_NEAR / 10,
        "the board must not receive job money"
    );
    refused(&claim(&env, &env.second, bid).await?, "cannot be claimed");
    Ok(())
}

#[tokio::test]
async fn a_failed_attempt_reopens_the_bid_for_another_agent_only() -> anyhow::Result<()> {
    let env = setup().await?;
    let bid = open_bid(&env).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    let job = funded_job(&env, bid, &env.agent).await?;
    deliver(&env, &env.agent, job).await?.into_result()?;
    settle(&env, job, "fail", "refund").await?;

    assert_eq!(sync(&env, bid).await?, "Open");
    assert_eq!(bid_of(&env, bid).await?["funded_attempts"], 1);
    let past = &bid_of(&env, bid).await?["past_jobs"][0];
    assert_eq!(past["job_id"], job);
    assert_eq!(past["funded"], true);
    assert_eq!(past["bid_state_after"], "Open");
    refused(&claim(&env, &env.agent, bid).await?, "used its attempt");
    claim(&env, &env.second, bid).await?.into_result()?;
    let again = funded_job(&env, bid, &env.second).await?;
    assert_ne!(again, job);
    Ok(())
}

#[tokio::test]
async fn nothing_can_claim_without_an_allowing_review() -> anyhow::Result<()> {
    let env = setup().await?;
    let unreviewed = post(&env).await?;
    refused(
        &claim(&env, &env.agent, unreviewed).await?,
        "cannot be claimed",
    );
    refused(
        &on_board(
            &env,
            &env.stranger,
            "record_review",
            json!({ "bid_id": unreviewed, "allow": true, "review_hash": OTHER, "model": "m", "chat_id": "c" }),
            NONE,
        )
        .await?,
        "only the reviewer",
    );
    // A malformed review record leaves the bid unreviewed.
    refused(
        &on_board(
            &env,
            &env.reviewer,
            "record_review",
            json!({ "bid_id": unreviewed, "allow": true, "review_hash": "bad", "model": "m", "chat_id": "c" }),
            NONE,
        )
        .await?,
        "review_hash",
    );
    assert_eq!(bid_of(&env, unreviewed).await?["state"], "Unreviewed");

    review(&env, unreviewed, false).await?.into_result()?;
    assert_eq!(bid_of(&env, unreviewed).await?["state"], "Blocked");
    refused(
        &claim(&env, &env.agent, unreviewed).await?,
        "cannot be claimed",
    );
    refused(
        &review(&env, unreviewed, true).await?,
        "not waiting for a review",
    );
    Ok(())
}

#[tokio::test]
async fn a_job_links_only_if_it_matches_the_bid_and_the_claim() -> anyhow::Result<()> {
    let env = setup().await?;
    let bid = open_bid(&env).await?;
    refused(&link(&env, bid, 0).await?, "no active claim");
    claim(&env, &env.agent, bid).await?.into_result()?;

    let wrong_worker = job_for(&env, &env.buyer, &env.second, CHECK, ONE_NEAR).await?;
    refused(&link(&env, bid, wrong_worker).await?, "different worker");
    let wrong_buyer = job_for(&env, &env.stranger, &env.agent, CHECK, ONE_NEAR).await?;
    refused(&link(&env, bid, wrong_buyer).await?, "different buyer");
    let wrong_check = job_for(&env, &env.buyer, &env.agent, OTHER, ONE_NEAR).await?;
    refused(&link(&env, bid, wrong_check).await?, "different check");
    let wrong_amount = job_for(&env, &env.buyer, &env.agent, CHECK, ONE_NEAR / 2).await?;
    refused(&link(&env, bid, wrong_amount).await?, "different amount");
    refused(&link(&env, bid, 999).await?, "does not exist");
    assert!(bid_of(&env, bid).await?["claim"]["job_id"].is_null());

    let right = job_for(&env, &env.buyer, &env.agent, CHECK, ONE_NEAR).await?;
    link(&env, bid, right).await?.into_result()?;
    assert_eq!(bid_of(&env, bid).await?["claim"]["job_id"], right);
    let other_right = job_for(&env, &env.buyer, &env.agent, CHECK, ONE_NEAR).await?;
    refused(&link(&env, bid, other_right).await?, "already has a job");

    // A job already linked once cannot serve a second bid, even an identical one.
    let second_bid = open_bid(&env).await?;
    claim(&env, &env.agent, second_bid).await?.into_result()?;
    refused(&link(&env, second_bid, right).await?, "already been linked");
    Ok(())
}

#[tokio::test]
async fn a_job_past_funding_cannot_be_linked() -> anyhow::Result<()> {
    let env = setup().await?;
    let job = job_for(&env, &env.buyer, &env.agent, CHECK, ONE_NEAR).await?;
    challenged(&env, job).await?;
    fund(&env, job).await?;
    deliver(&env, &env.agent, job).await?.into_result()?;
    let bid = open_bid(&env).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    refused(&link(&env, bid, job).await?, "past funding");
    Ok(())
}

#[tokio::test]
async fn a_linked_claim_lapses_only_if_the_job_was_never_funded() -> anyhow::Result<()> {
    let env = setup().await?;
    // Funded: it survives its window, and the agent can still deliver.
    let bid = open_bid(&env).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    let job = funded_job(&env, bid, &env.agent).await?;
    advance(&env, WINDOW + 5).await?;
    assert_eq!(sync(&env, bid).await?, "Claimed");
    deliver(&env, &env.agent, job).await?.into_result()?;
    refused(&claim(&env, &env.second, bid).await?, "cannot be claimed");

    // Linked but never funded: it lapses, and the attempt survives after one more window.
    let idle = open_bid(&env).await?;
    claim(&env, &env.agent, idle).await?.into_result()?;
    let unfunded = job_for(&env, &env.buyer, &env.agent, CHECK, ONE_NEAR).await?;
    link(&env, idle, unfunded).await?.into_result()?;
    refused(&claim(&env, &env.second, idle).await?, "cannot be claimed");
    advance(&env, WINDOW + 5).await?;
    assert_eq!(sync(&env, idle).await?, "Open");
    assert!(attempt(&env, idle, &env.agent).await?["Lapsed"].is_object());
    refused(&claim(&env, &env.agent, idle).await?, "must wait");
    advance(&env, WINDOW + 5).await?;
    claim(&env, &env.agent, idle).await?.into_result()?;

    // The remaining race: a buyer can still fund the old job after the lapse. The board cannot stop
    // that. The money is safe in the escrow, and the old job can never be linked again.
    challenged(&env, unfunded).await?;
    fund(&env, unfunded).await?;
    refused(&link(&env, idle, unfunded).await?, "already been linked");
    Ok(())
}

#[tokio::test]
async fn a_cancelled_job_or_a_rejected_check_ends_the_claim() -> anyhow::Result<()> {
    let env = setup().await?;
    let bid = open_bid(&env).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    let job = job_for(&env, &env.buyer, &env.agent, CHECK, ONE_NEAR).await?;
    link(&env, bid, job).await?.into_result()?;
    on_escrow(&env, &env.buyer, "cancel", json!({ "job_id": job }), NONE)
        .await?
        .into_result()?;
    assert_eq!(sync(&env, bid).await?, "Open");
    assert!(attempt(&env, bid, &env.agent).await?["Lapsed"].is_object());
    assert_eq!(bid_of(&env, bid).await?["funded_attempts"], 0);

    claim(&env, &env.second, bid).await?.into_result()?;
    let rejected = job_for(&env, &env.buyer, &env.second, CHECK, ONE_NEAR).await?;
    link(&env, bid, rejected).await?.into_result()?;
    behave(&env, "weak_check").await?;
    run(&env, "request_challenge", rejected).await?;
    assert_eq!(sync(&env, bid).await?, "Closed");
    Ok(())
}

#[tokio::test]
async fn the_buyer_can_close_a_bid_with_no_funded_job() -> anyhow::Result<()> {
    let env = setup().await?;
    let close = json!({ "bid_id": 0 });
    let bid = open_bid(&env).await?;
    assert_eq!(bid, 0);
    refused(
        &on_board(&env, &env.stranger, "close_bid", close.clone(), NONE).await?,
        "only the buyer",
    );
    claim(&env, &env.agent, bid).await?.into_result()?;
    let job = funded_job(&env, bid, &env.agent).await?;
    refused(
        &on_board(&env, &env.buyer, "close_bid", close.clone(), NONE).await?,
        "has been funded",
    );
    assert_eq!(state_of(&env, job).await?, "Funded");

    let idle = open_bid(&env).await?;
    claim(&env, &env.agent, idle).await?.into_result()?;
    on_board(
        &env,
        &env.buyer,
        "close_bid",
        json!({ "bid_id": idle }),
        NONE,
    )
    .await?
    .into_result()?;
    assert_eq!(bid_of(&env, idle).await?["state"], "Cancelled");

    let linked = open_bid(&env).await?;
    claim(&env, &env.agent, linked).await?.into_result()?;
    let unfunded = job_for(&env, &env.buyer, &env.agent, CHECK, ONE_NEAR).await?;
    link(&env, linked, unfunded).await?.into_result()?;
    on_board(
        &env,
        &env.buyer,
        "close_bid",
        json!({ "bid_id": linked }),
        NONE,
    )
    .await?
    .into_result()?;
    assert_eq!(bid_of(&env, linked).await?["state"], "Cancelled");
    Ok(())
}

async fn state_of(env: &Env, job: u64) -> anyhow::Result<String> {
    let job: Value = env
        .escrow
        .view("get_job")
        .args_json(json!({ "job_id": job }))
        .await?
        .json()?;
    Ok(job["state"].as_str().unwrap_or("none").to_string())
}

#[tokio::test]
async fn callbacks_are_private_and_a_stranger_cannot_deliver_for_a_claim() -> anyhow::Result<()> {
    let env = setup().await?;
    let bid = open_bid(&env).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    let job = funded_job(&env, bid, &env.agent).await?;
    for (method, args) in [
        (
            "on_link",
            json!({ "bid_id": bid, "claim_number": 1, "job_id": job }),
        ),
        ("on_sync", json!({ "bid_id": bid, "claim_number": 1 })),
        ("on_close", json!({ "bid_id": bid, "job_id": job })),
    ] {
        for who in [&env.stranger, &env.buyer, &env.reviewer] {
            refused(
                &on_board(&env, who, method, args.clone(), NONE).await?,
                "is private",
            );
        }
    }
    refused(
        &deliver(&env, &env.second, job).await?,
        "only the job's worker",
    );
    Ok(())
}

/// Measures what the griefing limit in the README states: two accounts taking turns keep a bid
/// claimed with no job, for as long as they keep paying the claim deposit.
#[tokio::test]
async fn repeated_claims_can_hold_a_bid_until_the_buyer_closes_it() -> anyhow::Result<()> {
    let env = setup().await?;
    let bid = open_bid(&env).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    advance(&env, WINDOW + 5).await?;
    claim(&env, &env.second, bid).await?.into_result()?;
    advance(&env, WINDOW + 5).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    assert_eq!(bid_of(&env, bid).await?["claims_made"], 3);
    assert_eq!(bid_of(&env, bid).await?["funded_attempts"], 0);
    on_board(
        &env,
        &env.buyer,
        "close_bid",
        json!({ "bid_id": bid }),
        NONE,
    )
    .await?
    .into_result()?;
    assert_eq!(bid_of(&env, bid).await?["state"], "Cancelled");
    Ok(())
}

#[tokio::test]
async fn a_stranger_can_finalize_but_cannot_complete_or_redirect_another_workers_claim(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let bid = open_bid(&env).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    let job = funded_job(&env, bid, &env.agent).await?;
    refused(
        &deliver(&env, &env.stranger, job).await?,
        "only the job's worker",
    );
    assert_eq!(state_of(&env, job).await?, "Funded");
    assert_eq!(sync(&env, bid).await?, "Claimed");
    deliver(&env, &env.agent, job).await?.into_result()?;
    behave(&env, "pass").await?;
    run(&env, "request_verification", job).await?;
    let before = env.agent.view_account().await?.balance.as_yoctonear();
    // An unknown recipient argument is not authority: release still uses the recorded worker.
    on_escrow(
        &env,
        &env.stranger,
        "release",
        json!({"job_id":job,"recipient":env.stranger.id()}),
        NONE,
    )
    .await?
    .into_result()?;
    assert_eq!(
        env.agent.view_account().await?.balance.as_yoctonear() - before,
        ONE_NEAR
    );
    assert_eq!(sync(&env, bid).await?, "Done");
    assert_eq!(attempt(&env, bid, &env.agent).await?, json!("Used"));
    assert_eq!(attempt(&env, bid, &env.stranger).await?, Value::Null);
    Ok(())
}

#[tokio::test]
async fn same_account_self_claim_is_blocked_but_a_second_controlled_account_can_be_paid(
) -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env, &env.buyer).await?;
    let bid = open_bid(&env).await?;
    refused(
        &claim(&env, &env.buyer, bid).await?,
        "a buyer cannot claim its own bid",
    );
    // This fixture's operator controls both accounts; there is no on-chain identity proof.
    claim(&env, &env.second, bid).await?.into_result()?;
    let job = funded_job(&env, bid, &env.second).await?;
    let unrelated = job_for(&env, &env.stranger, &env.agent, CHECK, ONE_NEAR).await?;
    challenged(&env, unrelated).await?;
    on_escrow(
        &env,
        &env.stranger,
        "fund",
        json!({"job_id":unrelated}),
        NearToken::from_near(1),
    )
    .await?
    .into_result()?;
    deliver(&env, &env.second, job).await?.into_result()?;
    behave(&env, "pass").await?;
    run(&env, "request_verification", job).await?;
    // Take the payout baseline after verification, allowing prior delivery refunds to settle.
    let unrelated_before: Value = env
        .escrow
        .view("get_job")
        .args_json(json!({"job_id":unrelated}))
        .await?
        .json()?;
    let before = env.second.view_account().await?.balance.as_yoctonear();
    on_escrow(&env, &env.stranger, "release", json!({"job_id":job}), NONE)
        .await?
        .into_result()?;
    assert_eq!(
        env.second.view_account().await?.balance.as_yoctonear() - before,
        ONE_NEAR
    );
    assert_eq!(sync(&env, bid).await?, "Done");
    assert_eq!(state_of(&env, unrelated).await?, "Funded");
    let unrelated_after: Value = env
        .escrow
        .view("get_job")
        .args_json(json!({"job_id":unrelated}))
        .await?
        .json()?;
    assert_eq!(unrelated_before, unrelated_after);
    assert!(env.escrow.view_account().await?.balance.as_yoctonear() >= ONE_NEAR);
    Ok(())
}
