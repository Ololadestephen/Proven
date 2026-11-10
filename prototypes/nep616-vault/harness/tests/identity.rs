//! Recipient identity: the vault belongs to a key, bound with a signed proof before any money is
//! committed, for the contributor's payout and the maintainer's refund. Re-registering the
//! contributor's account name under another key gains nothing. Signed withdrawals are bound to
//! the chain, vault, destination, amount and a sequence number.

mod common;
use common::*;
use near_workspaces::types::{KeyType, NearToken, SecretKey};

#[tokio::test]
async fn binding_needs_the_keys_own_proof() -> anyhow::Result<()> {
    let env = setup().await?;
    let other = signing_key(7);
    // Signed by another key, or for another bounty or kind: refused before any money moves.
    let by_other = bind_proof(&env, &other, 1, PAYOUT);
    let r = reserve_with(&env, 1, PAYOUT, &env.contrib_key, &by_other, NEAR).await?;
    assert_refused(&r, "the key did not sign this settlement");
    let other_bounty = bind_proof(&env, &env.contrib_key, 2, PAYOUT);
    let r = reserve_with(&env, 1, PAYOUT, &env.contrib_key, &other_bounty, NEAR).await?;
    assert_refused(&r, "the key did not sign this settlement");
    let other_kind = bind_proof(&env, &env.contrib_key, 1, REFUND);
    let r = reserve_with(&env, 1, PAYOUT, &env.contrib_key, &other_kind, NEAR).await?;
    assert_refused(&r, "the key did not sign this settlement");
    assert_eq!(held(&env).await?, 0);
    // Below the smallest supported settlement.
    let r = reserve(&env, 1, PAYOUT, &env.contrib_key, 10 * MILLI - 1).await?;
    assert_refused(&r, "attach at least 0.01 NEAR");
    Ok(())
}

#[tokio::test]
async fn a_reregistered_name_cannot_withdraw_or_intercept_and_signatures_cannot_be_reused(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let (ck, mk) = (&env.contrib_key, &env.maint_key);
    let cvault = vault_of(&env, ck).await?;
    let mvault = vault_of(&env, mk).await?;
    faults(&env, false, false, false, 0).await?;
    reserve(&env, 1, PAYOUT, ck, NEAR).await?.into_result()?;
    reserve(&env, 2, REFUND, mk, NEAR).await?.into_result()?;
    let r = settle(&env, 1, PAYOUT).await?;
    trace(
        &env,
        "payout of 1 into the contributor key's vault",
        &r,
        env.stranger.id(),
    )
    .await?;
    settle(&env, 2, REFUND).await?.into_result()?;
    assert_eq!(held(&env).await?, 0);
    let contributor_vault = info(&env, &cvault).await?;
    println!(
        "  contributor vault {cvault}: fund {} withdrawable {}",
        near(contributor_vault.fund),
        near(contributor_vault.available)
    );

    // The contributor's account is deleted and its name registered by someone else.
    let root = env.root.clone();
    env.contrib
        .clone()
        .delete_account(root.id())
        .await?
        .into_result()?;
    let usurper = root
        .create_subaccount("contrib")
        .initial_balance(NearToken::from_near(3))
        .keys(SecretKey::from_random(KeyType::ED25519))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(usurper.id(), env.contrib.id());
    let usurper_key = signing_key(9);
    // (a) Signing with its own key gets nothing.
    let sig = withdraw_sig(
        &usurper_key,
        &env.chain,
        cvault.as_str(),
        usurper.id().as_str(),
        NEAR,
        0,
    );
    let r = withdraw(
        &env,
        &usurper,
        &cvault,
        usurper.id().as_str(),
        NEAR,
        0,
        &sig,
    )
    .await?;
    assert_refused(&r, "bad signature");
    // (b) A new payout for the contributor still goes to the key's vault, not to the name.
    reserve(&env, 3, PAYOUT, ck, NEAR).await?.into_result()?;
    let usurper_before = bal(&env, usurper.id()).await?;
    let r = settle(&env, 3, PAYOUT).await?;
    let rows = trace(
        &env,
        "payout after the name was re-registered",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(rows.iter().all(|(_, to, _, _)| to != usurper.id().as_str()));
    assert_eq!(
        bal(&env, usurper.id()).await?,
        usurper_before,
        "the name received nothing"
    );

    // The real contributor, holding the key, withdraws to an account of its choosing. A relayer
    // submits and pays the gas, so the destination receives exactly the amount.
    let payee = root
        .create_subaccount("payee")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let before = bal(&env, payee.id()).await?;
    let sig0 = withdraw_sig(
        ck,
        &env.chain,
        cvault.as_str(),
        payee.id().as_str(),
        NEAR,
        0,
    );
    let r = withdraw(
        &env,
        &env.relayer,
        &cvault,
        payee.id().as_str(),
        NEAR,
        0,
        &sig0,
    )
    .await?;
    let rows = trace(
        &env,
        "signed withdrawal of 1 to payee, relayed",
        &r,
        env.relayer.id(),
    )
    .await?;
    assert!(sent(&rows, cvault.as_str(), payee.id().as_str(), NEAR));
    assert_eq!(
        bal(&env, payee.id()).await? - before,
        NEAR,
        "exactly the amount"
    );
    assert_eq!(info(&env, &cvault).await?.next, 1);

    // Replay of the same signed withdrawal.
    let r = withdraw(&env, &usurper, &cvault, payee.id().as_str(), NEAR, 0, &sig0).await?;
    assert_refused(&r, "wrong withdrawal number");
    // Destination substitution and amount substitution of a valid signature for number 1.
    let sig1 = withdraw_sig(
        ck,
        &env.chain,
        cvault.as_str(),
        payee.id().as_str(),
        NEAR,
        1,
    );
    let r = withdraw(
        &env,
        &usurper,
        &cvault,
        usurper.id().as_str(),
        NEAR,
        1,
        &sig1,
    )
    .await?;
    assert_refused(&r, "bad signature");
    let r = withdraw(
        &env,
        &usurper,
        &cvault,
        payee.id().as_str(),
        NEAR / 2,
        1,
        &sig1,
    )
    .await?;
    assert_refused(&r, "bad signature");
    // Another chain's signature, and another vault's signature.
    let mainnet = withdraw_sig(ck, "mainnet", cvault.as_str(), payee.id().as_str(), NEAR, 1);
    let r = withdraw(
        &env,
        &env.relayer,
        &cvault,
        payee.id().as_str(),
        NEAR,
        1,
        &mainnet,
    )
    .await?;
    assert_refused(&r, "bad signature");
    let elsewhere = withdraw_sig(
        mk,
        &env.chain,
        mvault.as_str(),
        payee.id().as_str(),
        NEAR,
        1,
    );
    let r = withdraw(
        &env,
        &env.relayer,
        &cvault,
        payee.id().as_str(),
        NEAR,
        1,
        &elsewhere,
    )
    .await?;
    assert_refused(&r, "bad signature");
    // A number from the future.
    let ahead = withdraw_sig(
        ck,
        &env.chain,
        cvault.as_str(),
        payee.id().as_str(),
        NEAR,
        5,
    );
    let r = withdraw(
        &env,
        &env.relayer,
        &cvault,
        payee.id().as_str(),
        NEAR,
        5,
        &ahead,
    )
    .await?;
    assert_refused(&r, "wrong withdrawal number");
    // The valid number-1 signature still works, once.
    let r = withdraw(
        &env,
        &env.relayer,
        &cvault,
        payee.id().as_str(),
        NEAR,
        1,
        &sig1,
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(bal(&env, payee.id()).await? - before, 2 * NEAR);
    assert!(
        bal(&env, usurper.id()).await? <= usurper_before,
        "the name never received anything; it only paid gas for refused attempts"
    );

    // The maintainer withdraws its refund to its own account, relayed: exactly the amount.
    let maint_before = bal(&env, env.maint.id()).await?;
    let r = signed_withdraw(&env, mk, &mvault, env.maint.id(), NEAR, 0).await?;
    let rows = trace(
        &env,
        "maintainer's signed refund withdrawal, relayed",
        &r,
        env.relayer.id(),
    )
    .await?;
    assert!(sent(&rows, mvault.as_str(), env.maint.id().as_str(), NEAR));
    assert_eq!(bal(&env, env.maint.id()).await? - maint_before, NEAR);
    // The usurper also cannot touch the maintainer's vault.
    let sig = withdraw_sig(
        &usurper_key,
        &env.chain,
        mvault.as_str(),
        usurper.id().as_str(),
        1,
        1,
    );
    assert_refused(
        &withdraw(&env, &usurper, &mvault, usurper.id().as_str(), 1, 1, &sig).await?,
        "bad signature",
    );
    Ok(())
}
