//! Release-build sandbox tests: payout and refund through withdrawal with exact yoctoNEAR
//! accounting, the backup key, a re-registered account name, withdrawal and key-proof faults, a
//! failed withdrawal and its retry, sponsored checks and their limits, and the storage measured
//! for the worst-case bounty. Build first (see tests/common/mod.rs).

mod common;
use common::*;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use serde_json::json;

#[tokio::test]
async fn payout_and_budget_return_reach_the_vaults_and_withdraw_exactly() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    env.note(format!(
        "vault code {} bytes, sha256 {}; global publication cost {} NEAR",
        env.vault_bytes,
        hex(&env.code_hash),
        near(env.publication_cost)
    ));
    let contract_storage_before = storage(&env, env.bounty.id()).await?;
    let id = post(&env, 1, 1, 600, 900, 3_600).await?;
    let b = get_bounty(&env, id).await?;
    let mvault: near_workspaces::AccountId = b["maintainer_vault"].as_str().unwrap().parse()?;
    assert_eq!(mvault, vault_of(&env, &env.maint_keys).await?);
    assert_eq!(held(&env).await?, (REWARD + BUDGET, 0));
    claim_and_bind(&env, id, 1).await?;
    let cvault: near_workspaces::AccountId = get_bounty(&env, id).await?["claim"]["vault"]
        .as_str()
        .unwrap()
        .parse()?;
    assert_eq!(cvault, vault_of(&env, &env.contrib_keys).await?);
    assert!(
        bal(&env, &cvault).await? == 0 && bal(&env, &mvault).await? == 0,
        "both vaults are new"
    );

    // A sponsored merge check by the contributor's wallet pays out.
    let (sponsor0, maint0, contract0) = (
        bal(&env, env.sponsor.id()).await?,
        bal(&env, env.maint.id()).await?,
        bal(&env, env.bounty.id()).await?,
    );
    let paid = merged_check(&env, id, 3, true).await?;
    let rows = trace(
        &env,
        "sponsored check finds the merge; payout and budget return sent",
        &paid,
        env.contrib.id(),
    )
    .await?;
    let req = last_request(&env).await?;
    assert_eq!(req["payer_account_id"], env.sponsor.id().as_str());
    assert_eq!(req["refund_to"], env.sponsor.id().as_str());
    assert!(sent(
        &rows,
        env.outlayer.id().as_str(),
        env.sponsor.id().as_str(),
        RUN - MOCK_CHARGE
    ));
    assert_eq!(
        bal(&env, env.sponsor.id()).await? - sponsor0,
        RUN - MOCK_CHARGE,
        "the change went to the sponsor"
    );
    assert_eq!(
        bal(&env, env.maint.id()).await?,
        maint0,
        "nothing from OutLayer to the maintainer"
    );
    let c = config(&env).await?;
    assert_eq!(
        (u(&c["sponsor_float"]), u(&c["sponsor_spent"])),
        (FLOAT - RUN, RUN)
    );
    assert_eq!(
        held(&env).await?,
        (0, 0),
        "both settlements confirmed by their callbacks"
    );
    for kind in ["Payout", "BudgetReturn"] {
        let s = settlement(&env, id, kind).await?;
        assert_eq!(
            (
                s["state"].as_str(),
                s["attempt"].as_u64(),
                s["done_by"].as_str()
            ),
            (Some("Done"), Some(1), Some("callback")),
            "{kind}"
        );
    }
    // Vault ledgers: withdrawable is exactly the principal; the fund is exactly the storage.
    for (vault, principal, kind) in [(&cvault, REWARD, 0u8), (&mvault, BUDGET, 1u8)] {
        let i = info(&env, vault).await?;
        let bytes = storage(&env, vault).await?;
        env.note(format!(
            "  vault {vault}: withdrawable {} fund {} ({bytes} bytes)",
            near(i.available),
            near(i.fund)
        ));
        assert_eq!(i.available, principal);
        assert_eq!(i.fund, u128::from(bytes) * BYTE);
        assert_eq!(bal(&env, vault).await?, principal + i.fund);
        let r = record(&env, vault, id, kind).await?;
        assert_eq!((r.deposited, r.attempt, r.amount), (true, 1, principal));
    }
    // The contract paid exactly the two principals and the two vaults' storage; everything else
    // it attached came back. Its balance also moved by its own storage and gas rewards, which
    // the ledger separates.
    let fund_c = info(&env, &cvault).await?.fund;
    let fund_m = info(&env, &mvault).await?.fund;
    let contract1 = bal(&env, env.bounty.id()).await?;
    env.note(format!(
        "  contract {} → {}: principals {} + vault storage {} + sponsored run {} ; other {} yocto (gas rewards)",
        near(contract0), near(contract1), near(REWARD + BUDGET), near(fund_c + fund_m), near(RUN),
        (contract0 as i128) - (contract1 as i128) - (REWARD + BUDGET + fund_c + fund_m + RUN) as i128
    ));
    let spent = contract0 - contract1;
    assert!(spent <= REWARD + BUDGET + fund_c + fund_m + RUN, "{spent}");
    assert!(
        REWARD + BUDGET + fund_c + fund_m + RUN - spent < MILLI,
        "only gas rewards differ"
    );

    // Withdraw: the primary key sends the payout to a chosen destination; the backup key alone
    // sends the budget to the maintainer's account. The relayer pays the gas.
    let before = bal(&env, env.payee.id()).await?;
    let w = withdraw(
        &env,
        &env.contrib_keys.primary,
        &cvault,
        env.payee.id(),
        REWARD,
    )
    .await?;
    let rows = trace(
        &env,
        "primary-key withdrawal of the payout to payee",
        &w,
        env.relayer.id(),
    )
    .await?;
    assert!(sent(
        &rows,
        cvault.as_str(),
        env.payee.id().as_str(),
        REWARD
    ));
    assert_eq!(
        bal(&env, env.payee.id()).await? - before,
        REWARD,
        "exactly the reward"
    );
    assert!(logged(&w, "vault_withdraw key=primary n=0"));
    let before = bal(&env, env.maint.id()).await?;
    let w = withdraw(
        &env,
        &env.maint_keys.backup,
        &mvault,
        env.maint.id(),
        BUDGET,
    )
    .await?;
    let rows = trace(
        &env,
        "backup-key withdrawal of the budget return to maint",
        &w,
        env.relayer.id(),
    )
    .await?;
    assert!(sent(
        &rows,
        mvault.as_str(),
        env.maint.id().as_str(),
        BUDGET
    ));
    assert!(logged(&w, "vault_withdraw key=backup n=0"));
    assert_eq!(
        bal(&env, env.maint.id()).await? - before,
        BUDGET,
        "exactly the budget"
    );
    for vault in [&cvault, &mvault] {
        let i = info(&env, vault).await?;
        assert_eq!((i.available, i.n), (0, 1));
        assert_eq!(
            bal(&env, vault).await?,
            i.fund,
            "only the storage fund is left"
        );
    }

    // Storage of the worst-case bounty (paid, both vaults new, both settlements sent at once).
    let grown = storage(&env, env.bounty.id()).await? - contract_storage_before;
    let contract_cost = u128::from(grown) * BYTE;
    let vault_kept = fund_c + fund_m;
    let peak_fees = 2 * DEPOSIT_FEE;
    env.note(format!(
        "STORAGE (short names): contract grew {grown} bytes ({} NEAR); vaults kept {} NEAR ({} + {}); kept total {} NEAR; peak with both fees ({} NEAR) in flight {} NEAR; deposit 0.02 NEAR",
        near(contract_cost), near(vault_kept), near(fund_c), near(fund_m), near(contract_cost + vault_kept), near(peak_fees), near(contract_cost + peak_fees)
    ));
    env.save_trace("payout-and-budget-return")?;
    Ok(())
}

/// The largest bounty the contract accepts: 64-character maintainer and contributor accounts,
/// a 255-byte base branch, the buyer's first bounty, both vaults new and both deposits in flight
/// at once. Measures what the 0.02 NEAR storage deposit has to cover.
#[tokio::test]
async fn worst_case_storage_with_two_new_vaults_and_overlapping_fees() -> anyhow::Result<()> {
    let long_maint = "m".repeat(54);
    let long_contrib = "c".repeat(54);
    let mut env = setup_named(RELEASE_WASM, &long_maint, &long_contrib).await?;
    assert_eq!((env.maint.id().len(), env.contrib.id().len()), (64, 64));
    env.base_ref = "b".repeat(255);
    let base = storage(&env, env.bounty.id()).await?;
    let id = post(&env, 10, 1, 600, 900, 3_600).await?;
    let posted = storage(&env, env.bounty.id()).await?;
    claim_and_bind(&env, id, 1).await?;
    let bound = storage(&env, env.bounty.id()).await?;
    let cvault = vault_of(&env, &env.contrib_keys).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    assert!(
        bal(&env, &cvault).await? == 0 && bal(&env, &mvault).await? == 0,
        "both vaults are new"
    );
    let paid = merged_check(&env, id, 3, false).await?;
    let rows = trace(
        &env,
        "worst-case bounty pays out into two new vaults",
        &paid,
        env.stranger.id(),
    )
    .await?;
    // Both deposits leave in the same receipt batch, so both fees are out at once.
    let deposits = rows
        .iter()
        .filter(|(_, _, a, _)| a.contains("FunctionCall deposit"))
        .count();
    assert_eq!(deposits, 2);
    assert_eq!(held(&env).await?, (0, 0));
    let done = storage(&env, env.bounty.id()).await?;
    let (fund_c, fund_m) = (
        info(&env, &cvault).await?.fund,
        info(&env, &mvault).await?.fund,
    );
    // The in-flight state differs from the final one only by the two `done_by` strings, so
    // the final byte count bounds it from above.
    let contract_bytes = u128::from(done - base);
    let peak = contract_bytes * BYTE + 2 * DEPOSIT_FEE;
    let kept = contract_bytes * BYTE + fund_c + fund_m;
    env.note(format!(
        "WORST-CASE STORAGE: contract bytes posted +{} bound +{} done +{} ({} NEAR); vault funds {} + {}; \
         peak with both fees in flight {} NEAR; kept after settlement {} NEAR; deposit {} NEAR",
        posted - base, bound - base, done - base, near(contract_bytes * BYTE), near(fund_c), near(fund_m),
        near(peak), near(kept), near(STORAGE)
    ));
    env.save_trace("worst-case-storage")?;
    Ok(())
}

#[tokio::test]
async fn an_expired_bounty_refunds_into_the_maintainer_vault_and_withdrawals_are_safe(
) -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let id = post(&env, 2, 1, 60, 120, 600).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    let claim_by: u64 = get_bounty(&env, id).await?["claim_by"]
        .as_str()
        .unwrap()
        .parse()?;
    wait_past(&env, claim_by + 15 * 60).await?;
    let r = call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?;
    let rows = trace(
        &env,
        "settle refunds reward + budget into the maintainer vault",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(rows.iter().any(|(_, to, a, f)| to == mvault.as_str()
        && a.contains("DeterministicStateInit")
        && f.is_none()));
    assert_eq!(held(&env).await?, (0, 0));
    let i = info(&env, &mvault).await?;
    assert_eq!(
        i.available,
        REWARD + BUDGET,
        "reward plus the full 0.03 budget"
    );

    // Withdrawal faults: each refused with nothing changed.
    let now = now_secs(&env).await?;
    let (k, other) = (&env.maint_keys.primary, &env.contrib_keys.primary);
    let (to, v) = (env.maint.id().as_str(), mvault.as_str());
    let p = REWARD + BUDGET;
    let faults: Vec<(&str, String, &str)> = vec![
        (
            "another key",
            withdrawal(other, &env.chain, v, to, p, 0, now + 600),
            "bad signature",
        ),
        (
            "another chain",
            withdrawal(k, "mainnet", v, to, p, 0, now + 600),
            "bad signature",
        ),
        (
            "another vault",
            withdrawal(
                k,
                &env.chain,
                "0s0000000000000000000000000000000000000000",
                to,
                p,
                0,
                now + 600,
            ),
            "bad signature",
        ),
        (
            "future number",
            withdrawal(k, &env.chain, v, to, p, 1, now + 600),
            "wrong withdrawal number",
        ),
        (
            "expired",
            withdrawal(k, &env.chain, v, to, p, 0, now - 1),
            "withdrawal deadline passed",
        ),
        (
            "too far ahead",
            withdrawal(k, &env.chain, v, to, p, 0, now + 3_600),
            "deadline too far ahead",
        ),
        (
            "zero amount",
            withdrawal(k, &env.chain, v, to, 0, 0, now + 600),
            "more than the vault can pay",
        ),
        (
            "above balance",
            withdrawal(k, &env.chain, v, to, p + 1, 0, now + 600),
            "more than the vault can pay",
        ),
        (
            "to the vault itself",
            withdrawal(k, &env.chain, v, v, p, 0, now + 600),
            "bad destination",
        ),
        (
            "malformed",
            r#"{"to":"maint.test.near"}"#.to_string(),
            "bad arguments",
        ),
    ];
    let signed_for_payee = withdrawal(k, &env.chain, v, env.payee.id().as_str(), p, 0, now + 600);
    let substituted = signed_for_payee.replace(env.payee.id().as_str(), env.stranger.id().as_str());
    let half = signed_for_payee.replace(
        &format!(r#""amount":"{p}""#),
        &format!(r#""amount":"{}""#, p / 2),
    );
    let mut faults = faults;
    faults.push(("destination substituted", substituted, "bad signature"));
    faults.push(("amount substituted", half, "bad signature"));
    for (label, args, expected) in faults {
        let r = submit_withdrawal(&env.stranger, &mvault, args).await?;
        assert_refused(&r, expected);
        if label == "another key" {
            let status = tx_status(&env, &r, env.stranger.id()).await?;
            save_fixture(
                "withdrawal-refused",
                &json!({"vault": mvault, "to": to, "amount": p.to_string(), "n": "0", "status": status}),
            )?;
        }
        let after = info(&env, &mvault).await?;
        assert_eq!(
            (after.available, after.n, after.fund),
            (i.available, 0, i.fund),
            "{label}"
        );
        env.note(format!("  refused: {label} ({expected})"));
    }

    // A withdrawal to an account that does not exist: the transfer fails and returns in full.
    let ghost: near_workspaces::AccountId = format!("ghost.{}", env.root.id()).parse()?;
    let w = withdraw(&env, &env.maint_keys.primary, &mvault, &ghost, p).await?;
    let rows = trace(
        &env,
        "withdrawal to a missing account",
        &w,
        env.relayer.id(),
    )
    .await?;
    let status = tx_status(&env, &w, env.relayer.id()).await?;
    save_fixture(
        "withdrawal-returned",
        &json!({"vault": mvault, "to": ghost, "amount": p.to_string(), "n": "0", "status": status}),
    )?;
    assert!(failed_with(&rows, ghost.as_str(), "AccountDoesNotExist"));
    assert!(sent(&rows, "system", mvault.as_str(), p));
    let again = info(&env, &mvault).await?;
    assert_eq!(
        (again.available, again.n, again.fund),
        (p, 1, i.fund),
        "everything is withdrawable again; number 0 is used"
    );
    // Replaying number 0 is refused; number 1 delivers exactly.
    let replay = withdrawal(k, &env.chain, v, to, p, 0, now_secs(&env).await? + 600);
    assert_refused(
        &submit_withdrawal(&env.stranger, &mvault, replay).await?,
        "wrong withdrawal number",
    );
    let before = bal(&env, env.payee.id()).await?;
    let w = withdraw(&env, &env.maint_keys.primary, &mvault, env.payee.id(), p).await?;
    let rows = trace(&env, "retry at number 1 to payee", &w, env.relayer.id()).await?;
    let status = tx_status(&env, &w, env.relayer.id()).await?;
    let raw = env.sandbox.view(&mvault, "info").args(vec![]).await?.result;
    save_fixture(
        "withdrawal-delivered",
        &json!({"vault": mvault, "to": env.payee.id(), "amount": p.to_string(), "n": "1", "status": status, "info_after_hex": hex(&raw)}),
    )?;
    assert!(sent(&rows, mvault.as_str(), env.payee.id().as_str(), p));
    assert_eq!(bal(&env, env.payee.id()).await? - before, p);
    env.save_trace("refund-withdraw-retry")?;
    Ok(())
}

#[tokio::test]
async fn two_settlements_into_one_vault_keep_only_the_new_records_storage() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let p = REWARD + BUDGET;
    let first = post(&env, 11, 1, 600, 900, 3_600).await?;
    let second = post(&env, 12, 2, 600, 900, 3_600).await?;
    let vault = vault_of(&env, &env.maint_keys).await?;
    let r = call(&env.maint, &env, "cancel", json!({"bounty_id": first}), 0).await?;
    let rows = trace(
        &env,
        "first refund creates the maintainer vault",
        &r,
        env.maint.id(),
    )
    .await?;
    let (bytes1, fund1) = (storage(&env, &vault).await?, info(&env, &vault).await?.fund);
    assert!(
        sent(
            &rows,
            vault.as_str(),
            env.bounty.id().as_str(),
            DEPOSIT_FEE - fund1
        ),
        "the first fee returns all but the new vault's storage"
    );
    let r = call(&env.maint, &env, "cancel", json!({"bounty_id": second}), 0).await?;
    let rows = trace(
        &env,
        "second refund into the same vault",
        &r,
        env.maint.id(),
    )
    .await?;
    let bytes2 = storage(&env, &vault).await?;
    let i = info(&env, &vault).await?;
    let shortfall = u128::from(bytes2 - bytes1) * BYTE;
    env.note(format!(
        "  vault {bytes1} → {bytes2} bytes; second deposit kept {} NEAR and returned {} NEAR of its fee",
        near(shortfall),
        near(DEPOSIT_FEE - shortfall)
    ));
    assert!(
        sent(
            &rows,
            vault.as_str(),
            env.bounty.id().as_str(),
            DEPOSIT_FEE - shortfall
        ),
        "only the new record's storage is kept"
    );
    assert_eq!(
        i.available,
        2 * p,
        "withdrawable is exactly both principals"
    );
    assert_eq!(
        i.fund,
        u128::from(bytes2) * BYTE,
        "the fund equals the vault's storage"
    );
    assert_eq!(i.fund - fund1, shortfall);
    assert_eq!(bal(&env, &vault).await?, 2 * p + i.fund);
    assert_eq!(held(&env).await?, (0, 0));
    env.save_trace("two-settlements-one-vault")?;
    Ok(())
}

#[tokio::test]
async fn a_reregistered_name_cannot_withdraw_or_intercept_the_payout() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let id = post(&env, 3, 1, 600, 900, 3_600).await?;
    claim_and_bind(&env, id, 1).await?;
    let cvault = vault_of(&env, &env.contrib_keys).await?;
    // The contributor's account is deleted and its name registered by someone else.
    env.contrib
        .clone()
        .delete_account(env.root.id())
        .await?
        .into_result()?;
    let usurper = env
        .root
        .create_subaccount("contrib")
        .initial_balance(NearToken::from_near(2))
        .keys(SecretKey::from_random(KeyType::ED25519))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(usurper.id(), env.contrib.id());
    let before = bal(&env, usurper.id()).await?;
    let paid = merged_check(&env, id, 3, false).await?;
    let rows = trace(
        &env,
        "payout after the contributor name was re-registered",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert!(rows.iter().all(|(_, to, _, _)| to != usurper.id().as_str()));
    assert_eq!(info(&env, &cvault).await?.available, REWARD);
    assert_eq!(
        bal(&env, usurper.id()).await?,
        before,
        "the name received nothing"
    );
    // Its own key cannot withdraw; the real key holder can, to anywhere.
    let fake = ed25519_dalek::SigningKey::from_bytes(&[99; 32]);
    let args = withdrawal(
        &fake,
        &env.chain,
        cvault.as_str(),
        usurper.id().as_str(),
        REWARD,
        0,
        now_secs(&env).await? + 600,
    );
    assert_refused(
        &submit_withdrawal(&usurper, &cvault, args).await?,
        "bad signature",
    );
    let p0 = bal(&env, env.payee.id()).await?;
    withdraw(
        &env,
        &env.contrib_keys.backup,
        &cvault,
        env.payee.id(),
        REWARD,
    )
    .await?
    .into_result()?;
    assert_eq!(bal(&env, env.payee.id()).await? - p0, REWARD);
    Ok(())
}

#[tokio::test]
async fn key_proofs_that_do_not_hold_are_refused_with_nothing_held() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let now = now_secs(&env).await?;
    let t = terms(4, now, 600, 900, 3_600);
    let good = posting_proof(
        &env,
        &t,
        &env.maint_keys,
        env.maint.id(),
        &nonce(7),
        now + 1800,
    )
    .await?;
    let contract0 = bal(&env, env.bounty.id()).await?;
    let mut other_terms = t.clone();
    other_terms["issue"] = json!(5);
    let swapped = {
        let mut p = good.clone();
        p["primary_signature"] = good["backup_signature"].clone();
        p["backup_signature"] = good["primary_signature"].clone();
        p
    };
    let other_actor = posting_proof(
        &env,
        &t,
        &env.maint_keys,
        env.stranger.id(),
        &nonce(7),
        now + 1800,
    )
    .await?;
    let expired = posting_proof(
        &env,
        &t,
        &env.maint_keys,
        env.maint.id(),
        &nonce(8),
        now - 1,
    )
    .await?;
    let too_far = posting_proof(
        &env,
        &t,
        &env.maint_keys,
        env.maint.id(),
        &nonce(9),
        now + 3_700,
    )
    .await?;
    for (label, terms, proof, expected) in [
        (
            "copied proof, other terms",
            other_terms,
            good.clone(),
            "proof does not match",
        ),
        (
            "swapped signatures",
            t.clone(),
            swapped,
            "proof does not match",
        ),
        (
            "another actor",
            t.clone(),
            other_actor,
            "proof does not match",
        ),
        (
            "expired",
            t.clone(),
            expired,
            "expires_at must be in the future",
        ),
        (
            "too far ahead",
            t.clone(),
            too_far,
            "at most one hour ahead",
        ),
    ] {
        let r = try_post(&env, terms, proof).await?;
        assert_refused(&r, expected);
        env.note(format!("  refused: {label}"));
    }
    // Equal keys.
    let r = env
        .maint
        .call(env.bounty.id(), "post_bounty")
        .args_json(json!({"terms": t, "keys": {"primary": public(&env.maint_keys.primary), "backup": public(&env.maint_keys.primary)}, "proof": good}))
        .deposit(NearToken::from_yoctonear(REWARD + BUDGET + STORAGE))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert_refused(&r, "backup key must differ");
    assert_eq!(config(&env).await?["bounty_count"], 0);
    assert_eq!(held(&env).await?, (0, 0));
    assert!(
        contract0 - bal(&env, env.bounty.id()).await? < MILLI
            || bal(&env, env.bounty.id()).await? >= contract0
    );
    // The good proof works once; a replay is refused.
    assert!(try_post(&env, t.clone(), good.clone()).await?.is_success());
    assert_refused(
        &try_post(&env, t, good).await?,
        "nonce has already been used",
    );
    // A claim signed for another wallet.
    let id = 0;
    let expires = now_secs(&env).await? + 1800;
    let mut sigs = Vec::new();
    for (signing, key) in [
        ("primary", &env.contrib_keys.primary),
        ("backup", &env.contrib_keys.backup),
    ] {
        let msg: String = env
            .bounty
            .view("claim_key_message")
            .args_json(json!({"bounty_id": id, "wallet": env.stranger.id(), "expires_at": expires.to_string(), "keys": env.contrib_keys.json(), "signing": signing}))
            .await?
            .json()?;
        sigs.push(key_proof(key, &msg, env.bounty.id().as_str()));
    }
    let r = call(&env.contrib, &env, "prove_claim", json!({"bounty_id": id, "gist_id": GIST, "expires_at": expires.to_string(), "keys": env.contrib_keys.json(), "primary_signature": sigs[0], "backup_signature": sigs[1]}), RUN).await?;
    assert_refused(&r, "proof does not match");
    // Forged callbacks are private.
    for method in [
        "on_claim",
        "on_check",
        "on_settle",
        "on_settle_outcome",
        "on_reconcile",
        "send_due_after_check",
    ] {
        let r = call(&env.stranger, &env, method, json!({}), 0).await?;
        assert_refused(&r, &format!("Method {method} is private"));
    }
    Ok(())
}

#[tokio::test]
async fn sponsored_checks_are_limited_and_their_change_reaches_only_the_sponsor(
) -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let id = post(&env, 6, 1, 600, 900, 3_600).await?;
    claim_and_bind(&env, id, 1).await?;
    let held0 = held(&env).await?;
    // Change delayed, held then released after payout, and never: liabilities do not move and
    // only the sponsor account gains.
    let mut seq = 3;
    for (mode, hops) in [("delayed", 5u32), ("held", 0), ("none", 0)] {
        change_mode(&env, mode, hops).await?;
        let s0 = bal(&env, env.sponsor.id()).await?;
        reply(&env, "reply", Some(pull_reply(&env, id, seq, None))).await?;
        let r = call(
            &env.contrib,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            0,
        )
        .await?;
        assert!(logged(&r, "outcome=pending"), "{:?}", r.logs());
        let gained = bal(&env, env.sponsor.id()).await? - s0;
        let expect = if mode == "delayed" {
            RUN - MOCK_CHARGE
        } else {
            0
        };
        assert_eq!(gained, expect, "{mode}");
        assert_eq!(held(&env).await?, held0, "{mode}: liabilities unchanged");
        assert_eq!(get_bounty(&env, id).await?["budget"], BUDGET.to_string());
        seq += 1;
    }
    // A fourth sponsored check is refused; a self-funded check still works.
    let r = call(
        &env.contrib,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        0,
    )
    .await?;
    assert_refused(&r, "used its three sponsored checks");
    // Pay out, then release the held change: it goes to the sponsor, nothing else moves.
    let paid = merged_check(&env, id, seq, false).await?;
    trace(
        &env,
        "self-funded check pays out after three sponsored checks",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(held(&env).await?, (0, 0));
    let s0 = bal(&env, env.sponsor.id()).await?;
    env.outlayer
        .call("release_change")
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        bal(&env, env.sponsor.id()).await? - s0,
        RUN - MOCK_CHARGE,
        "held change, released out of order"
    );
    assert_eq!(held(&env).await?, (0, 0));
    let c = config(&env).await?;
    assert_eq!(
        (u(&c["sponsor_float"]), u(&c["sponsor_spent"])),
        (FLOAT - 3 * RUN, 3 * RUN)
    );
    let cvault = vault_of(&env, &env.contrib_keys).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    assert_eq!(info(&env, &cvault).await?.available, REWARD);
    assert_eq!(
        info(&env, &mvault).await?.available,
        BUDGET,
        "the full budget returns after three sponsored checks"
    );

    // A refused admission's deposit goes to the sponsor; the float cap and aggregate cap hold.
    let id2 = post(&env, 7, 2, 600, 900, 3_600).await?;
    claim_and_bind(&env, id2, seq + 1).await?;
    change_mode(&env, "immediate", 0).await?;
    reply(&env, "panic", None).await?;
    let s0 = bal(&env, env.sponsor.id()).await?;
    let r = call(
        &env.contrib,
        &env,
        "check_merge",
        json!({"bounty_id": id2}),
        0,
    )
    .await?;
    let rows = trace(
        &env,
        "a sponsored check refused at admission",
        &r,
        env.contrib.id(),
    )
    .await?;
    assert!(
        logged(&r, "outcome=no_result:promise_failed"),
        "{:?}",
        r.logs()
    );
    assert!(
        sent(&rows, "system", env.sponsor.id().as_str(), RUN),
        "the refused deposit returns to the sponsor"
    );
    assert_eq!(bal(&env, env.sponsor.id()).await? - s0, RUN);
    // The refused run was still debited from the float: its deposit went to the sponsor account.
    let c = config(&env).await?;
    assert_eq!(
        (u(&c["sponsor_float"]), u(&c["sponsor_spent"])),
        (FLOAT - 4 * RUN, 4 * RUN)
    );
    let room = 100 * MILLI - (FLOAT - 4 * RUN);
    let r = env
        .sponsor
        .call(env.bounty.id(), "fund_sponsor")
        .deposit(NearToken::from_yoctonear(room + 1))
        .transact()
        .await?;
    assert_refused(&r, "exceed its cap");
    let r = env
        .sponsor
        .call(env.bounty.id(), "fund_sponsor")
        .deposit(NearToken::from_yoctonear(room))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    env.owner
        .call(env.bounty.id(), "set_sponsor_limits")
        .args_json(json!({"max_sponsor_float": (100 * MILLI).to_string(), "max_sponsor_spent": (4 * RUN).to_string()}))
        .transact()
        .await?
        .into_result()?;
    assert_refused(
        &call(
            &env.contrib,
            &env,
            "check_merge",
            json!({"bounty_id": id2}),
            0,
        )
        .await?,
        "total spending cap",
    );
    env.save_trace("sponsored-checks")?;
    Ok(())
}

#[tokio::test]
async fn an_empty_float_stops_only_sponsored_checks() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    env.owner
        .call(env.bounty.id(), "set_sponsor_limits")
        .args_json(json!({"max_sponsor_float": (100 * MILLI).to_string(), "max_sponsor_spent": RUN.to_string()}))
        .transact()
        .await?
        .into_result()?;
    let id = post(&env, 8, 1, 60, 120, 300).await?;
    claim_and_bind(&env, id, 1).await?;
    // One sponsored run uses the whole aggregate cap; the next is refused.
    reply(&env, "reply", Some(pull_reply(&env, id, 3, None))).await?;
    assert!(logged(
        &call(
            &env.contrib,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            0
        )
        .await?,
        "outcome=pending"
    ));
    assert_refused(
        &call(
            &env.contrib,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "total spending cap",
    );
    // A self-funded check still works, and the expiry refund still works.
    reply(&env, "reply", Some(pull_reply(&env, id, 4, None))).await?;
    assert!(logged(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN
        )
        .await?,
        "outcome=pending"
    ));
    let deadline: u64 = get_bounty(&env, id).await?["merge_deadline"]
        .as_str()
        .unwrap()
        .parse()?;
    wait_past(&env, deadline + 600).await?;
    let r = call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let mvault = vault_of(&env, &env.maint_keys).await?;
    assert_eq!(info(&env, &mvault).await?.available, REWARD + BUDGET);
    withdraw(
        &env,
        &env.maint_keys.primary,
        &mvault,
        env.maint.id(),
        REWARD + BUDGET,
    )
    .await?
    .into_result()?;
    Ok(())
}
