//! Reconciling one exact settlement after both callbacks fail, for a payout and a refund:
//! successful funding, failed funding, a seal that overtakes a deposit still in flight,
//! duplicate and foreign records, and forged callbacks.

mod common;
use common::*;
use ed25519_dalek::SigningKey;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

async fn successful_funding(
    env: &Env,
    bounty: u64,
    kind: u8,
    key: &SigningKey,
) -> anyhow::Result<()> {
    let vault = vault_of(env, key).await?;
    faults(env, true, false, false, 0).await?;
    reserve(env, bounty, kind, key, NEAR).await?.into_result()?;
    env.stranger
        .transfer_near(&vault, NearToken::from_millinear(200))
        .await?
        .into_result()?;
    let r = settle(env, bounty, kind).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: funding succeeds, both callbacks fail"),
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(failed_with(
        &rows,
        env.escrow.id().as_str(),
        "fault: on_settle fails"
    ));
    assert!(failed_with(
        &rows,
        env.escrow.id().as_str(),
        "fault: on_settle_outcome fails"
    ));
    let s = settlement(env, bounty, kind).await?;
    assert_eq!(
        (s["state"].as_str(), s["outcome"].as_str()),
        (Some("Sending"), Some("Unknown"))
    );
    assert_eq!(held(env).await?, NEAR);
    assert_refused(&settle(env, bounty, kind).await?, "not due");
    assert_eq!(
        slot(env, &vault, env.escrow.id(), bounty, kind).await?,
        (true, 1, NEAR, 0)
    );
    let (a, b) = tokio::join!(
        reconcile(env, &env.stranger, bounty, kind, 1),
        reconcile(env, env.third.as_account(), bounty, kind, 1),
    );
    let answers = [answer(&a?), answer(&b?)];
    println!("  concurrent reconciles: {answers:?}");
    assert_eq!(answers.iter().filter(|x| *x == "deposited").count(), 1);
    assert_eq!(
        answers
            .iter()
            .filter(|x| *x == "ignored:not_in_flight")
            .count(),
        1
    );
    assert_eq!(held(env).await?, 0, "released exactly once");
    assert_refused(&settle(env, bounty, kind).await?, "not due");
    Ok(())
}

#[tokio::test]
async fn successful_funding_with_both_callbacks_failed_is_released_once() -> anyhow::Result<()> {
    let env = setup().await?;
    successful_funding(&env, 1, PAYOUT, &env.contrib_key.clone()).await?;
    successful_funding(&env, 2, REFUND, &env.maint_key.clone()).await?;
    Ok(())
}

async fn failed_funding(env: &Env, bounty: u64, kind: u8, key: &SigningKey) -> anyhow::Result<()> {
    let vault = vault_of(env, key).await?;
    faults(env, true, true, false, 0).await?;
    reserve(env, bounty, kind, key, NEAR).await?.into_result()?;
    let vault_before = bal(env, &vault).await?;
    let r = settle(env, bounty, kind).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: funding fails, both callbacks fail"),
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(refund_to(
        &rows,
        env.escrow.id().as_str(),
        NEAR + STORAGE_FEE + INIT_DEPOSIT
    ));
    assert_eq!(bal(env, &vault).await?, vault_before);
    // A reconcile whose own callback fails seals but records nothing; the retry records it.
    faults(env, true, true, true, 0).await?;
    let lost = reconcile(env, &env.stranger, bounty, kind, 1).await?;
    assert!(answer(&lost).starts_with("failed"), "its callback failed");
    assert_eq!(settlement(env, bounty, kind).await?["state"], "Sending");
    assert_eq!(
        slot(env, &vault, env.escrow.id(), bounty, kind).await?,
        (false, 0, 0, 1)
    );
    faults(env, true, true, false, 0).await?;
    assert_eq!(
        answer(&reconcile(env, &env.stranger, bounty, kind, 1).await?),
        "sealed_without_deposit"
    );
    let s = settlement(env, bounty, kind).await?;
    assert_eq!(
        (s["state"].as_str(), s["outcome"].as_str()),
        (Some("Due"), Some("Failed"))
    );
    assert_eq!(
        held(env).await?,
        NEAR,
        "a confirmed failure stays reserved, once"
    );
    faults(env, true, false, false, 0).await?;
    settle(env, bounty, kind).await?.into_result()?;
    assert_eq!(
        answer(&reconcile(env, &env.stranger, bounty, kind, 1).await?),
        "ignored:not_in_flight",
        "stale attempt"
    );
    assert_eq!(
        answer(&reconcile(env, &env.stranger, bounty, kind, 2).await?),
        "deposited"
    );
    assert_eq!(
        slot(env, &vault, env.escrow.id(), bounty, kind).await?,
        (true, 2, NEAR, 1)
    );
    assert_eq!(held(env).await?, 0);
    Ok(())
}

#[tokio::test]
async fn failed_funding_with_both_callbacks_failed_is_sealed_and_resent_once() -> anyhow::Result<()>
{
    let env = setup().await?;
    failed_funding(&env, 1, PAYOUT, &env.contrib_key.clone()).await?;
    failed_funding(&env, 2, REFUND, &env.maint_key.clone()).await?;
    Ok(())
}

#[tokio::test]
async fn a_seal_that_overtakes_an_in_flight_deposit_makes_that_deposit_fail() -> anyhow::Result<()>
{
    let env = setup().await?;
    let key = env.contrib_key.clone();
    let vault = vault_of(&env, &key).await?;
    faults(&env, true, false, false, 40).await?;
    reserve(&env, 1, PAYOUT, &key, NEAR).await?.into_result()?;
    let pending = env
        .stranger
        .call(env.escrow.id(), "settle")
        .args_json(json!({"bounty": 1, "kind": PAYOUT}))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    let mut waited = 0;
    while settlement(&env, 1, PAYOUT).await?["attempt"] != 1 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        waited += 1;
        assert!(waited < 100);
    }
    let r = reconcile(&env, &env.stranger, 1, PAYOUT, 1).await?;
    trace(
        &env,
        "seal of attempt 1 while its deposit is held back",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    assert_refused(
        &settle(&env, 1, PAYOUT).await?,
        "waiting for an earlier attempt's refund",
    );
    let sent = pending.await?;
    let rows = trace(
        &env,
        "the held-back deposit arrives after the seal",
        &sent,
        env.stranger.id(),
    )
    .await?;
    assert!(failed_with(&rows, vault.as_str(), "this attempt is sealed"));
    assert!(refund_to(
        &rows,
        env.escrow.id().as_str(),
        NEAR + STORAGE_FEE + INIT_DEPOSIT
    ));
    faults(&env, false, false, false, 0).await?;
    settle(&env, 1, PAYOUT).await?.into_result()?;
    let s = settlement(&env, 1, PAYOUT).await?;
    assert_eq!(
        (s["state"].as_str(), s["attempt"].as_u64()),
        (Some("Done"), Some(2))
    );
    assert_eq!(
        slot(&env, &vault, env.escrow.id(), 1, PAYOUT).await?,
        (true, 2, NEAR, 1)
    );
    assert_eq!(held(&env).await?, 0);
    Ok(())
}

#[tokio::test]
async fn duplicate_foreign_and_forged_records_do_not_count() -> anyhow::Result<()> {
    let env = setup().await?;
    let key = env.contrib_key.clone();
    let vault = vault_of(&env, &key).await?;
    state_init(&env, &vault, env.code_hash, &vault_entries(&pk33(&key)), 0)
        .await?
        .into_result()?;
    let mut args = 1u64.to_le_bytes().to_vec();
    args.push(PAYOUT);
    args.extend(1u32.to_le_bytes());
    args.extend(NEAR.to_le_bytes());
    let deposit = || {
        let call = env
            .stranger
            .call(&vault, "deposit")
            .args(args.clone())
            .deposit(NearToken::from_yoctonear(NEAR + STORAGE_FEE))
            .gas(Gas::from_tgas(20));
        async move { call.transact().await }
    };
    deposit().await?.into_result()?;
    let r = deposit().await?;
    let rows = trace(
        &env,
        "a duplicate deposit for the same slot",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(failed_with(&rows, vault.as_str(), "already has a deposit"));
    assert!(refund_to(
        &rows,
        env.stranger.id().as_str(),
        NEAR + STORAGE_FEE
    ));
    // A storage fee below what the record needs is refused, and refunded.
    let mut args2 = 2u64.to_le_bytes().to_vec();
    args2.push(PAYOUT);
    args2.extend(1u32.to_le_bytes());
    args2.extend(NEAR.to_le_bytes());
    let r = env
        .stranger
        .call(&vault, "deposit")
        .args(args2)
        .deposit(NearToken::from_yoctonear(NEAR + 1))
        .gas(Gas::from_tgas(20))
        .transact()
        .await?;
    let rows = trace(
        &env,
        "a deposit without its storage fee",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(failed_with(&rows, vault.as_str(), "attach the storage fee"));
    assert!(refund_to(&rows, env.stranger.id().as_str(), NEAR + 1));
    assert_eq!(
        slot(&env, &vault, env.escrow.id(), 1, PAYOUT).await?,
        (false, 0, 0, 0)
    );

    faults(&env, true, true, false, 0).await?;
    reserve(&env, 1, PAYOUT, &key, NEAR).await?.into_result()?;
    settle(&env, 1, PAYOUT).await?.into_result()?;
    for method in ["on_reconcile", "on_settle", "on_settle_outcome"] {
        let r = env
            .stranger
            .call(env.escrow.id(), method)
            .args_json(json!({"bounty": 1, "kind": PAYOUT, "attempt": 1}))
            .transact()
            .await?;
        assert_refused(&r, &format!("Method {method} is private"));
    }
    assert_refused(
        &reconcile(&env, &env.stranger, 1, PAYOUT, 2).await?,
        "no such attempt",
    );
    let r = reconcile(&env, &env.stranger, 1, PAYOUT, 1).await?;
    assert_eq!(
        answer(&r),
        "sealed_without_deposit",
        "the stranger's deposit is not the escrow's"
    );
    assert_eq!(held(&env).await?, NEAR);
    Ok(())
}
