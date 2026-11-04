//! Sandbox tests against the compiled contracts. Build both first:
//! `cargo near build non-reproducible-wasm` in `contracts/escrow` and in `contracts/test-token`.

mod common;

use common::*;
use near_workspaces::types::NearToken;
use serde_json::json;

#[tokio::test]
async fn near_job_passes_and_pays_the_worker() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = funded_near_job(&env, 600, 600).await?;
    deliver(&env, &env.worker, id).await?.into_result()?;
    verdict(&env, &env.relay, id, true, DELIVERABLE).await?.into_result()?;

    let before = near_balance(&env.worker).await?;
    let paid: bool = payout(&env, "release", id).await?.into_result()?.json()?;
    assert!(paid);
    assert_eq!(near_balance(&env.worker).await? - before, NearToken::from_near(1).as_yoctonear());
    assert_eq!(state(&env, id).await?, "Released");

    assert_refused(&payout(&env, "release", id).await?, "job has not passed");
    Ok(())
}

#[tokio::test]
async fn near_job_fails_and_refunds_the_buyer() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = funded_near_job(&env, 600, 600).await?;
    deliver(&env, &env.worker, id).await?.into_result()?;
    verdict(&env, &env.relay, id, false, DELIVERABLE).await?.into_result()?;

    let before = near_balance(&env.buyer).await?;
    payout(&env, "refund", id).await?.into_result()?;
    assert_eq!(near_balance(&env.buyer).await? - before, NearToken::from_near(1).as_yoctonear());
    assert_eq!(state(&env, id).await?, "Refunded");
    Ok(())
}

#[tokio::test]
async fn weak_check_is_rejected_cannot_be_funded_and_can_be_cancelled() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = create_job(&env, false, 600, 600, NearToken::from_near(1).as_yoctonear()).await?;
    challenge(&env, id, 6, 5).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "CheckRejected");
    assert_refused(&fund_near(&env, id, NearToken::from_near(1)).await?, "the check must pass its challenge first");

    call(&env, &env.buyer, "cancel", json!({ "job_id": id }), NearToken::from_yoctonear(0)).await?.into_result()?;
    assert!(job(&env, id).await?.is_null());
    Ok(())
}

#[tokio::test]
async fn outsiders_cannot_deliver_or_rule_and_bad_verdicts_are_refused() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = funded_near_job(&env, 600, 600).await?;

    assert_refused(&deliver(&env, &env.stranger, id).await?, "only the job's worker can deliver");
    deliver(&env, &env.worker, id).await?.into_result()?;

    assert_refused(&verdict(&env, &env.worker, id, true, DELIVERABLE).await?, "only the verifier relay");
    assert_refused(&verdict(&env, &env.relay, id, true, REPORT).await?, "deliverable_hash does not match");
    verdict(&env, &env.relay, id, false, DELIVERABLE).await?.into_result()?;
    assert_refused(&verdict(&env, &env.relay, id, true, DELIVERABLE).await?, "job is not awaiting a verdict");
    assert_eq!(state(&env, id).await?, "Failed");
    Ok(())
}

#[tokio::test]
async fn missed_deadline_refuses_delivery_and_expires_to_the_buyer() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = funded_near_job(&env, 60, 600).await?;
    assert_refused(&payout(&env, "expire", id).await?, "job has not expired");

    let deadline: u64 = job(&env, id).await?["deadline"].as_str().unwrap().parse()?;
    advance_past(&env, deadline).await?;
    assert_refused(&deliver(&env, &env.worker, id).await?, "the delivery deadline has passed");

    let before = near_balance(&env.buyer).await?;
    payout(&env, "expire", id).await?.into_result()?;
    assert_eq!(near_balance(&env.buyer).await? - before, NearToken::from_near(1).as_yoctonear());
    assert_eq!(state(&env, id).await?, "Expired");
    Ok(())
}

#[tokio::test]
async fn missed_verdict_window_refuses_the_verdict_and_expires_to_the_buyer() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = funded_near_job(&env, 600, 60).await?;
    deliver(&env, &env.worker, id).await?.into_result()?;

    let delivered_at: u64 = job(&env, id).await?["delivered_at"].as_str().unwrap().parse()?;
    advance_past(&env, delivered_at + 60 * SEC).await?;
    assert_refused(&verdict(&env, &env.relay, id, true, DELIVERABLE).await?, "the verdict window has closed");

    let before = near_balance(&env.buyer).await?;
    payout(&env, "expire", id).await?.into_result()?;
    assert_eq!(near_balance(&env.buyer).await? - before, NearToken::from_near(1).as_yoctonear());
    assert_eq!(state(&env, id).await?, "Expired");
    Ok(())
}

#[tokio::test]
async fn token_job_passes_and_pays_the_worker_in_tokens() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env.token, &env.buyer, env.worker.id()).await?;
    let id = create_job(&env, true, 600, 600, TOKEN_AMOUNT).await?;
    challenge(&env, id, 6, 6).await?.into_result()?;

    // A wrong amount is refused by the escrow and the token contract returns it.
    let buyer_before = token_balance(&env, env.buyer.id()).await?;
    fund_token(&env, id, TOKEN_AMOUNT - 1).await?.into_result()?;
    assert_eq!(token_balance(&env, env.buyer.id()).await?, buyer_before);
    assert_eq!(state(&env, id).await?, "Challenged");

    fund_token(&env, id, TOKEN_AMOUNT).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "Funded");
    assert_eq!(token_balance(&env, env.escrow.id()).await?, TOKEN_AMOUNT);

    deliver(&env, &env.worker, id).await?.into_result()?;
    verdict(&env, &env.relay, id, true, DELIVERABLE).await?.into_result()?;
    let paid: bool = payout(&env, "release", id).await?.into_result()?.json()?;
    assert!(paid);
    assert_eq!(token_balance(&env, env.worker.id()).await?, TOKEN_AMOUNT);
    assert_eq!(token_balance(&env, env.escrow.id()).await?, 0);
    assert_eq!(state(&env, id).await?, "Released");
    Ok(())
}

#[tokio::test]
async fn failed_token_payout_keeps_the_money_and_can_be_retried() -> anyhow::Result<()> {
    let env = setup().await?;
    // The worker is not registered with the token, so the first payout transfer fails.
    let id = create_job(&env, true, 600, 600, TOKEN_AMOUNT).await?;
    challenge(&env, id, 6, 6).await?.into_result()?;
    fund_token(&env, id, TOKEN_AMOUNT).await?.into_result()?;
    deliver(&env, &env.worker, id).await?.into_result()?;
    verdict(&env, &env.relay, id, true, DELIVERABLE).await?.into_result()?;

    let paid: bool = payout(&env, "release", id).await?.json()?;
    assert!(!paid);
    assert_eq!(state(&env, id).await?, "Passed");
    assert_eq!(token_balance(&env, env.escrow.id()).await?, TOKEN_AMOUNT);

    register(&env.token, &env.worker, env.worker.id()).await?;
    let paid: bool = payout(&env, "release", id).await?.into_result()?.json()?;
    assert!(paid);
    assert_eq!(token_balance(&env, env.worker.id()).await?, TOKEN_AMOUNT);
    assert_eq!(state(&env, id).await?, "Released");
    Ok(())
}
