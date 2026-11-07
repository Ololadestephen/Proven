//! The board against the real compiled escrow and a mock of the OutLayer contract. Build all three
//! first: `cargo near build non-reproducible-wasm` in `contracts/board`, `contracts/escrow` and
//! `contracts/mock-outlayer`.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const REFERENCE: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const DELIVERABLE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const VERIFIER: &str = "5555555555555555555555555555555555555555555555555555555555555555";
const FORMAT: &str = "{}";
const SEC: u64 = 1_000_000_000;
const NONE: NearToken = NearToken::from_yoctonear(0);
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = ONE_NEAR / 1_000;
/// The escrow's run deposit in these tests.
const RUN: u128 = 10 * MILLI;
const FEE: u128 = 15 * MILLI;

/// A bid's check can be used once, so each bid in a test gets its own.
thread_local! {
    static POSTED: std::cell::Cell<u64> = const { std::cell::Cell::new(1) };
}
fn next_check() -> String {
    POSTED.with(|posted| {
        let n = posted.get();
        posted.set(n + 1);
        format!("{n:064x}")
    })
}

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
            "owner": owner.id(), "outlayer": outlayer.id(), "board": board.id(),
            "verifier_url": "https://example.test/verifier.wasm",
            "verifier_hash": VERIFIER, "secrets_owner": stranger.id(),
            "run_deposit": RUN.to_string(),
            "max_job_amount": (1_000 * ONE_NEAR).to_string(), "max_held": (10_000 * ONE_NEAR).to_string(), "max_held_per_buyer": (10_000 * ONE_NEAR).to_string(),
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

async fn on(
    contract: &Contract,
    who: &Account,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(contract.id(), method)
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
    on(
        &env.board,
        who,
        "register_agent",
        json!({ "prompt_hash": REFERENCE, "knowledge_hash": REFERENCE, "tools_hash": REFERENCE, "model": "test", "owner": null }),
        NearToken::from_millinear(20),
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn now(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp())
}

/// What a buyer attaches to post: the payment plus a generous amount for budget, storage and fees.
/// The escrow returns its excess straight to the buyer.
fn posting(amount: u128) -> NearToken {
    NearToken::from_yoctonear(amount + 300 * MILLI)
}

async fn post_with(
    env: &Env,
    amount: u128,
    attempts: u32,
    workers: Option<Vec<&Account>>,
) -> anyhow::Result<ExecutionFinalResult> {
    let expires_at = now(env).await? + 24 * 3_600 * SEC;
    on(
        &env.board,
        &env.buyer,
        "post_bid",
        json!({
            "description": "Convert these invoices", "amount": amount.to_string(),
            "check_hash": next_check(), "reference_hash": REFERENCE, "verifier_hash": VERIFIER,
            "format": FORMAT, "expires_at": expires_at.to_string(), "reveal_agreed": true,
            "deliver_secs": 3_600, "max_attempts": attempts,
            "allowed_workers": workers.map(|w| w.iter().map(|a| a.id().clone()).collect::<Vec<_>>()),
        }),
        posting(amount),
    )
    .await
}

/// Posts a bid, runs its challenge and the review, and returns (bid, job).
async fn open_bid(env: &Env, attempts: u32) -> anyhow::Result<(u64, u64)> {
    post_with(env, ONE_NEAR, attempts, None)
        .await?
        .into_result()?;
    let bids: Vec<(u64, Value)> = env
        .board
        .view("get_bids")
        .args_json(json!({ "from_id": 0, "limit": 50 }))
        .await?
        .json()?;
    let (id, bid) = bids.last().unwrap().clone();
    let job = bid["job_id"].as_u64().unwrap();
    behave(env, "strong_check").await?;
    run(env, "request_challenge", job).await?;
    review(env, id, true).await?.into_result()?;
    Ok((id, job))
}

async fn review(env: &Env, bid: u64, allow: bool) -> anyhow::Result<ExecutionFinalResult> {
    on(
        &env.board,
        &env.reviewer,
        "record_review",
        json!({ "bid_id": bid, "allow": allow, "review_hash": REFERENCE, "model": "m", "chat_id": "c" }),
        NONE,
    )
    .await
}

async fn claim(env: &Env, who: &Account, bid: u64) -> anyhow::Result<ExecutionFinalResult> {
    on(
        &env.board,
        who,
        "claim",
        json!({ "bid_id": bid }),
        NearToken::from_millinear(5),
    )
    .await
}

async fn sync(env: &Env, bid: u64) -> anyhow::Result<String> {
    Ok(on(
        &env.board,
        &env.stranger,
        "sync",
        json!({ "bid_id": bid }),
        NONE,
    )
    .await?
    .into_result()?
    .json()?)
}

async fn bid_of(env: &Env, bid: u64) -> anyhow::Result<Value> {
    Ok(env
        .board
        .view("get_bid")
        .args_json(json!({ "bid_id": bid }))
        .await?
        .json()?)
}

async fn job_of(env: &Env, job: u64) -> anyhow::Result<Value> {
    Ok(env
        .escrow
        .view("get_job")
        .args_json(json!({ "job_id": job }))
        .await?
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

/// Anyone triggers a run; the job's budget pays for it.
async fn run(env: &Env, method: &str, job: u64) -> anyhow::Result<()> {
    on(
        &env.escrow,
        &env.stranger,
        method,
        json!({ "job_id": job }),
        NONE,
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn deliver(env: &Env, who: &Account, job: u64) -> anyhow::Result<ExecutionFinalResult> {
    on(
        &env.escrow,
        who,
        "deliver",
        json!({ "job_id": job, "deliverable_hash": DELIVERABLE }),
        NONE,
    )
    .await
}

/// Delivers, verifies with `behaviour`, and settles the attempt.
async fn judged(env: &Env, who: &Account, job: u64, behaviour: &str) -> anyhow::Result<()> {
    deliver(env, who, job).await?.into_result()?;
    behave(env, behaviour).await?;
    run(env, "request_verification", job).await?;
    let method = if behaviour == "pass" {
        "release"
    } else {
        "refund"
    };
    on(
        &env.escrow,
        &env.stranger,
        method,
        json!({ "job_id": job }),
        NONE,
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn balance(who: &Account) -> anyhow::Result<u128> {
    Ok(who.view_account().await?.balance.as_yoctonear())
}

#[tokio::test]
async fn one_posting_pays_for_everything_and_a_passing_job_finishes_the_bid() -> anyhow::Result<()>
{
    let env = setup().await?;
    let (bid, job) = open_bid(&env, 1).await?;
    let held = job_of(&env, job).await?;
    assert_eq!(held["state"], "Open");
    assert_eq!(held["buyer"], env.buyer.id().as_str());

    // The agent is given the job at once: the money is already held.
    claim(&env, &env.agent, bid).await?.into_result()?;
    assert_eq!(bid_of(&env, bid).await?["state"], "Claimed");
    assert_eq!(job_of(&env, job).await?["worker"], env.agent.id().as_str());

    let worker_before = balance(&env.agent).await?;
    let buyer_before = balance(&env.buyer).await?;
    judged(&env, &env.agent, job, "pass").await?;
    assert!(balance(&env.agent).await? > worker_before + ONE_NEAR - 10 * MILLI);
    assert_eq!(sync(&env, bid).await?, "Done");
    // The unused attempt fee went back, and the buyer signed nothing after posting.
    let fees: Vec<String> = serde_json::from_value(bid_of(&env, bid).await?["fees"].clone())?;
    assert_eq!(fees, vec!["ReturnedToBuyer"]);
    // The fee, and the unused part of the verification run, which OutLayer returns to the buyer.
    assert_eq!(balance(&env.buyer).await? - buyer_before, FEE + RUN - MILLI);
    Ok(())
}

#[tokio::test]
async fn a_failed_attempt_pays_its_fee_to_the_worker_and_the_next_agent_can_be_paid(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let (bid, job) = open_bid(&env, 2).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    let fee_before = balance(&env.agent).await?;
    judged(&env, &env.agent, job, "fail").await?;
    assert_eq!(job_of(&env, job).await?["state"], "Open");
    assert_eq!(sync(&env, bid).await?, "Open");
    // Well-formed work failed a real rule, so the worker keeps that attempt's fee.
    assert!(balance(&env.agent).await? > fee_before + FEE - 5 * MILLI);
    refused(&claim(&env, &env.agent, bid).await?, "used its attempt");

    claim(&env, &env.second, bid).await?.into_result()?;
    let before = balance(&env.second).await?;
    judged(&env, &env.second, job, "pass").await?;
    assert!(balance(&env.second).await? > before + ONE_NEAR - 10 * MILLI);
    assert_eq!(sync(&env, bid).await?, "Done");
    let bid_now = bid_of(&env, bid).await?;
    assert_eq!(bid_now["funded_attempts"], 2);
    let fees: Vec<String> = serde_json::from_value(bid_now["fees"].clone())?;
    assert_eq!(fees, vec!["PaidToWorker", "ReturnedToBuyer"]);
    Ok(())
}

#[tokio::test]
async fn a_format_failure_returns_the_fee_and_the_last_attempt_refunds_the_buyer(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let (bid, job) = open_bid(&env, 1).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    let buyer_before = balance(&env.buyer).await?;
    judged(&env, &env.agent, job, "fail_format").await?;
    assert_eq!(job_of(&env, job).await?["state"], "Refunded");
    assert_eq!(sync(&env, bid).await?, "Closed");
    let fees: Vec<String> = serde_json::from_value(bid_of(&env, bid).await?["fees"].clone())?;
    assert_eq!(fees, vec!["ReturnedToBuyer"]);
    // The payment, what was left of the budget and the fee all came back.
    assert!(balance(&env.buyer).await? - buyer_before > ONE_NEAR + FEE);
    Ok(())
}

#[tokio::test]
async fn a_refused_posting_returns_everything_and_leaves_no_bid() -> anyhow::Result<()> {
    let env = setup().await?;
    let before = balance(&env.buyer).await?;
    // A verifier build the escrow does not run: the escrow refuses the job.
    let expires_at = now(&env).await? + 3_600 * SEC;
    let result = on(
        &env.board,
        &env.buyer,
        "post_bid",
        json!({
            "description": "x", "amount": ONE_NEAR.to_string(), "check_hash": next_check(),
            "reference_hash": REFERENCE, "verifier_hash": REFERENCE, "format": FORMAT,
            "expires_at": expires_at.to_string(), "reveal_agreed": true,
            "deliver_secs": 3_600, "max_attempts": 1, "allowed_workers": null,
        }),
        posting(ONE_NEAR),
    )
    .await?;
    let returned: bool = result.json().unwrap_or(true);
    assert!(!returned);
    let bids: Vec<Value> = env
        .board
        .view("get_bids")
        .args_json(json!({ "from_id": 0, "limit": 50 }))
        .await?
        .json()?;
    assert!(bids.is_empty());
    // Only gas was spent.
    assert!(before - balance(&env.buyer).await? < 50 * MILLI);
    Ok(())
}

#[tokio::test]
async fn a_claim_before_the_check_is_accepted_is_undone_and_its_deposit_returned(
) -> anyhow::Result<()> {
    let env = setup().await?;
    post_with(&env, ONE_NEAR, 1, None).await?.into_result()?;
    review(&env, 0, true).await?.into_result()?;
    let before = balance(&env.agent).await?;
    let result = claim(&env, &env.agent, 0).await?;
    assert!(!result.json::<bool>().unwrap_or(true));
    let bid = bid_of(&env, 0).await?;
    assert_eq!(bid["state"], "Open");
    assert!(bid["claim"].is_null());
    assert!(before - balance(&env.agent).await? < 5 * MILLI);
    Ok(())
}

#[tokio::test]
async fn nothing_can_claim_without_an_allowing_review() -> anyhow::Result<()> {
    let env = setup().await?;
    post_with(&env, ONE_NEAR, 1, None).await?.into_result()?;
    refused(&claim(&env, &env.agent, 0).await?, "cannot be claimed now");
    refused(
        &on(&env.board, &env.stranger, "record_review", json!({ "bid_id": 0, "allow": true, "review_hash": REFERENCE, "model": "m", "chat_id": "c" }), NONE).await?,
        "only the reviewer",
    );
    review(&env, 0, false).await?.into_result()?;
    refused(&claim(&env, &env.agent, 0).await?, "cannot be claimed now");
    Ok(())
}

#[tokio::test]
async fn the_buyer_closes_an_open_bid_and_gets_everything_back() -> anyhow::Result<()> {
    let env = setup().await?;
    let (bid, job) = open_bid(&env, 3).await?;
    refused(
        &on(
            &env.board,
            &env.stranger,
            "close_bid",
            json!({ "bid_id": bid }),
            NONE,
        )
        .await?,
        "only the buyer can close a bid before it expires",
    );
    let before = balance(&env.buyer).await?;
    on(
        &env.board,
        &env.buyer,
        "close_bid",
        json!({ "bid_id": bid }),
        NONE,
    )
    .await?
    .into_result()?;
    assert_eq!(job_of(&env, job).await?["state"], "Refunded");
    assert_eq!(sync(&env, bid).await?, "Closed");
    let fees: Vec<String> = serde_json::from_value(bid_of(&env, bid).await?["fees"].clone())?;
    assert_eq!(fees, vec!["ReturnedToBuyer"; 3]);
    assert!(balance(&env.buyer).await? - before > ONE_NEAR + 3 * FEE - 10 * MILLI);
    Ok(())
}

#[tokio::test]
async fn a_bid_with_an_agent_on_it_cannot_be_closed() -> anyhow::Result<()> {
    let env = setup().await?;
    let (bid, _) = open_bid(&env, 1).await?;
    claim(&env, &env.agent, bid).await?.into_result()?;
    refused(
        &on(
            &env.board,
            &env.buyer,
            "close_bid",
            json!({ "bid_id": bid }),
            NONE,
        )
        .await?,
        "cannot be closed now",
    );
    Ok(())
}

#[tokio::test]
async fn a_rejected_check_closes_the_bid_and_refunds_the_buyer() -> anyhow::Result<()> {
    let env = setup().await?;
    post_with(&env, ONE_NEAR, 1, None).await?.into_result()?;
    let job = bid_of(&env, 0).await?["job_id"].as_u64().unwrap();
    behave(&env, "weak_check").await?;
    run(&env, "request_challenge", job).await?;
    review(&env, 0, true).await?.into_result()?;
    let before = balance(&env.buyer).await?;
    sync(&env, 0).await?;
    assert_eq!(job_of(&env, job).await?["state"], "Refunded");
    assert_eq!(sync(&env, 0).await?, "Closed");
    assert!(balance(&env.buyer).await? - before > ONE_NEAR);
    Ok(())
}

#[tokio::test]
async fn an_allowlist_set_on_a_bid_limits_who_can_claim() -> anyhow::Result<()> {
    let env = setup().await?;
    post_with(&env, ONE_NEAR, 1, Some(vec![&env.second]))
        .await?
        .into_result()?;
    let job = bid_of(&env, 0).await?["job_id"].as_u64().unwrap();
    behave(&env, "strong_check").await?;
    run(&env, "request_challenge", job).await?;
    review(&env, 0, true).await?.into_result()?;
    refused(
        &claim(&env, &env.agent, 0).await?,
        "does not allow this worker",
    );
    claim(&env, &env.second, 0).await?.into_result()?;
    Ok(())
}

#[tokio::test]
async fn the_buyer_cannot_claim_its_own_bid() -> anyhow::Result<()> {
    let env = setup().await?;
    let (bid, _) = open_bid(&env, 1).await?;
    register(&env, &env.buyer).await?;
    refused(
        &claim(&env, &env.buyer, bid).await?,
        "a buyer cannot claim its own bid",
    );
    Ok(())
}

#[tokio::test]
async fn callbacks_are_private() -> anyhow::Result<()> {
    let env = setup().await?;
    let (bid, _) = open_bid(&env, 1).await?;
    for (method, args) in [
        ("on_job_created", json!({ "bid_id": bid })),
        ("on_assigned", json!({ "bid_id": bid, "claim_number": 1 })),
        ("on_sync", json!({ "bid_id": bid })),
        (
            "on_fee_paid",
            json!({ "bid_id": bid, "index": 0, "to_worker": true }),
        ),
    ] {
        refused(
            &on(&env.board, &env.stranger, method, args, NONE).await?,
            "is private",
        );
    }
    // Only the board can assign on the escrow, so a claim cannot be skipped.
    let job = bid_of(&env, bid).await?["job_id"].as_u64().unwrap();
    refused(
        &on(
            &env.escrow,
            &env.agent,
            "assign",
            json!({ "job_id": job, "worker": env.agent.id() }),
            NONE,
        )
        .await?,
        "only the board can do this",
    );
    Ok(())
}

#[tokio::test]
async fn the_same_check_cannot_be_on_two_bids_and_a_buyer_must_agree_to_the_reveal(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let expires_at = now(&env).await? + 3_600 * SEC;
    let args = |check: &str, agreed: bool| {
        json!({
            "description": "x", "amount": ONE_NEAR.to_string(), "check_hash": check,
            "reference_hash": REFERENCE, "verifier_hash": VERIFIER, "format": FORMAT,
            "expires_at": expires_at.to_string(), "reveal_agreed": agreed,
            "deliver_secs": 3_600, "max_attempts": 1, "allowed_workers": null,
        })
    };
    let check = next_check();
    refused(
        &on(
            &env.board,
            &env.buyer,
            "post_bid",
            args(&check, false),
            posting(ONE_NEAR),
        )
        .await?,
        "must agree",
    );
    on(
        &env.board,
        &env.buyer,
        "post_bid",
        args(&check, true),
        posting(ONE_NEAR),
    )
    .await?
    .into_result()?;
    refused(
        &on(
            &env.board,
            &env.buyer,
            "post_bid",
            args(&check, true),
            posting(ONE_NEAR),
        )
        .await?,
        "already used",
    );
    Ok(())
}

/// Upgrades a copy of the real mainnet board, with its real state, to this code. Needs the fixtures
/// written by reading the chain; skipped without them.
#[tokio::test]
async fn the_deployed_mainnet_board_upgrades_with_its_bid_intact() -> anyhow::Result<()> {
    let Ok(old) = std::fs::read("tests/fixtures/mainnet-board.wasm") else {
        eprintln!("skipped: no mainnet fixture");
        return Ok(());
    };
    let values: Vec<Value> =
        serde_json::from_slice(&std::fs::read("tests/fixtures/mainnet-board-state.json")?)?;
    let sandbox = near_workspaces::sandbox().await?;
    let board = sandbox.dev_deploy(&old).await?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    for entry in &values {
        sandbox
            .patch_state(
                board.id(),
                &b64.decode(entry["key"].as_str().unwrap())?,
                &b64.decode(entry["value"].as_str().unwrap())?,
            )
            .await?;
    }
    let account = board.as_account().clone();
    let upgraded = account
        .deploy(&std::fs::read("target/near/proven_board.wasm")?)
        .await?
        .into_result()?;
    let stranger = sandbox.dev_create_account().await?;
    assert!(stranger
        .call(upgraded.id(), "migrate")
        .max_gas()
        .transact()
        .await?
        .is_failure());
    upgraded
        .call("migrate")
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let bid: Value = upgraded
        .view("get_bid")
        .args_json(json!({ "bid_id": 0 }))
        .await?
        .json()?;
    assert_eq!(bid["state"], "Done");
    assert_eq!(bid["buyer"], "hectormain.near");
    assert_eq!(bid["job_id"], 3);
    let agents: Vec<Value> = upgraded
        .view("get_agents")
        .args_json(json!({ "from_index": 0, "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(agents[0]["wallet"], "proven-ops.near");
    assert!(upgraded
        .call("migrate")
        .max_gas()
        .transact()
        .await?
        .is_failure());
    Ok(())
}
