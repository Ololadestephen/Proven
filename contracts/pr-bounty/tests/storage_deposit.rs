//! Proof that the 0.029 NEAR posting storage deposit is enough on its own. Each test runs the
//! largest bounty the contract accepts (64-character maintainer and contributor accounts, a
//! 255-byte base branch, the maintainer's first bounty, new vaults) on a contract whose spare
//! balance is exactly zero: it holds its storage, the float and nothing else. The checks are
//! self-funded, so the sponsor float is never asked for anything. After every step the contract's
//! balance must still cover its storage, every principal it holds and the untouched float; a
//! negative slack would mean storage or fees were paid from someone's principal or the float.
//! Build first (see tests/common/mod.rs).

mod common;
use common::*;
use near_workspaces::AccountId;
use serde_json::json;

const LONG_MAINT: usize = 54;
const LONG_CONTRIB: usize = 54;

async fn worst_case_env(wasm: &str) -> anyhow::Result<Env> {
    let mut env = setup_full(
        wasm,
        &"m".repeat(LONG_MAINT),
        &"c".repeat(LONG_CONTRIB),
        Some(0),
        FLOAT,
    )
    .await?;
    assert_eq!((env.maint.id().len(), env.contrib.id().len()), (64, 64));
    env.base_ref = "b".repeat(255);
    assert_eq!(
        u(&env.bounty.view("get_free_balance").await?.json()?),
        0,
        "no spare balance"
    );
    Ok(env)
}

/// Records the slack after a step and checks it is never negative and the float is untouched.
async fn step(env: &Env, label: &str, lowest: &mut i128) -> anyhow::Result<i128> {
    let s = slack(env).await?;
    let float = u(&config(env).await?["sponsor_float"]);
    env.note(format!(
        "  [{label}] slack {} yocto, float {}",
        s,
        near(float)
    ));
    assert!(
        s >= 0,
        "{label}: the contract used money that is not its own ({s} yocto)"
    );
    assert_eq!(float, FLOAT, "{label}: the float was used");
    *lowest = (*lowest).min(s);
    Ok(s)
}

/// The vault holds exactly `principal` as withdrawable, and its fund is exactly its storage.
async fn exact_vault(
    env: &Env,
    vault: &AccountId,
    id: u64,
    kind: u8,
    principal: u128,
    attempt: u32,
) -> anyhow::Result<u128> {
    let i = info(env, vault).await?;
    let bytes = storage(env, vault).await?;
    assert_eq!(
        i.available, principal,
        "{vault}: exactly the principal is withdrawable"
    );
    assert_eq!(
        i.fund,
        u128::from(bytes) * BYTE,
        "{vault}: the fund is its storage"
    );
    assert_eq!(
        bal(env, vault).await?,
        principal + i.fund,
        "{vault}: nothing else in the vault"
    );
    let r = record(env, vault, id, kind).await?;
    assert_eq!(
        (r.deposited, r.attempt, r.amount),
        (true, attempt, principal)
    );
    Ok(i.fund)
}

fn no_waiting(r: &near_workspaces::result::ExecutionFinalResult) {
    assert!(
        !r.logs().iter().any(|l| l.contains("settlement_waiting")),
        "a send waited for balance: {:?}",
        r.logs()
    );
}

#[tokio::test]
async fn a_worst_case_payout_settles_on_its_own_deposit_with_both_fees_in_flight(
) -> anyhow::Result<()> {
    let env = worst_case_env(RELEASE_WASM).await?;
    save_fixture("config", &config(&env).await?)?;
    let mut lowest = i128::MAX;
    step(&env, "before posting", &mut lowest).await?;
    let id = post(&env, 20, 1, 600, 900, 3_600).await?;
    step(&env, "posted", &mut lowest).await?;
    claim_and_bind(&env, id, 1).await?;
    step(&env, "claimed and bound", &mut lowest).await?;
    let paid = merged_check(&env, id, 3, false).await?;
    let rows = trace(
        &env,
        "worst-case payout, no spare balance",
        &paid,
        env.stranger.id(),
    )
    .await?;
    no_waiting(&paid);
    let deposits = rows
        .iter()
        .filter(|(_, _, a, f)| a.contains("FunctionCall deposit") && f.is_none())
        .count();
    assert_eq!(
        deposits, 2,
        "both deposits were sent in the same batch, both fees out at once"
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
    assert_eq!(held(&env).await?, (0, 0));
    let end = step(&env, "settled", &mut lowest).await?;
    let cvault = vault_of(&env, &env.contrib_keys).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    let fc = exact_vault(&env, &cvault, id, 0, REWARD, 1).await?;
    let fm = exact_vault(&env, &mvault, id, 1, BUDGET, 1).await?;
    env.note(format!(
        "PAYOUT: deposit {} NEAR; left over {} NEAR after contract storage and vault funds {} + {}; lowest slack {} yocto",
        near(STORAGE), near(end as u128), near(fc), near(fm), lowest
    ));
    for (keys, vault, amount) in [
        (&env.contrib_keys, &cvault, REWARD),
        (&env.maint_keys, &mvault, BUDGET),
    ] {
        let p0 = bal(&env, env.payee.id()).await?;
        withdraw(&env, &keys.primary, vault, env.payee.id(), amount)
            .await?
            .into_result()?;
        assert_eq!(bal(&env, env.payee.id()).await? - p0, amount);
    }
    step(&env, "withdrawn", &mut lowest).await?;
    env.save_trace("deposit-worst-case-payout")?;
    Ok(())
}

#[tokio::test]
async fn a_worst_case_refund_settles_on_its_own_deposit() -> anyhow::Result<()> {
    let env = worst_case_env(RELEASE_WASM).await?;
    let mut lowest = i128::MAX;
    let id = post(&env, 21, 1, 600, 900, 3_600).await?;
    claim_and_bind(&env, id, 1).await?;
    step(&env, "claimed and bound", &mut lowest).await?;
    // The pull request is merged into another branch: ineligible, refundable at once.
    let deadline: u64 = get_bounty(&env, id).await?["merge_deadline"]
        .as_str()
        .unwrap()
        .parse()?;
    reply(
        &env,
        "reply",
        Some(pull_reply_into(&env, id, 3, Some(deadline - 1), "other")),
    )
    .await?;
    let r = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&r, "outcome=ineligible:base_ref"), "{:?}", r.logs());
    step(&env, "ineligible", &mut lowest).await?;
    let r = call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?;
    trace(
        &env,
        "worst-case refund, no spare balance",
        &r,
        env.stranger.id(),
    )
    .await?;
    no_waiting(&r);
    let s = settlement(&env, id, "Refund").await?;
    assert_eq!(
        (s["state"].as_str(), s["attempt"].as_u64()),
        (Some("Done"), Some(1))
    );
    assert_eq!(held(&env).await?, (0, 0));
    let end = step(&env, "refunded", &mut lowest).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    let fm = exact_vault(&env, &mvault, id, 2, REWARD + BUDGET, 1).await?;
    env.note(format!(
        "REFUND: deposit {} NEAR; left over {} NEAR after contract storage and the vault fund {}; lowest slack {} yocto",
        near(STORAGE), near(end as u128), near(fm), lowest
    ));
    let p0 = bal(&env, env.payee.id()).await?;
    withdraw(
        &env,
        &env.maint_keys.backup,
        &mvault,
        env.payee.id(),
        REWARD + BUDGET,
    )
    .await?
    .into_result()?;
    assert_eq!(bal(&env, env.payee.id()).await? - p0, REWARD + BUDGET);
    env.save_trace("deposit-worst-case-refund")?;
    Ok(())
}

/// Fault build, issue 8500..9000: each settlement's first deposit fails and its callbacks run.
#[tokio::test]
async fn a_worst_case_payout_retries_failed_sends_on_its_own_deposit() -> anyhow::Result<()> {
    let env = worst_case_env(FAULT_WASM).await?;
    let mut lowest = i128::MAX;
    let id = post(&env, 8_501, 1, 600, 900, 3_600).await?;
    claim_and_bind(&env, id, 1).await?;
    let paid = merged_check(&env, id, 3, false).await?;
    let rows = trace(
        &env,
        "worst-case payout: both first deposits fail",
        &paid,
        env.stranger.id(),
    )
    .await?;
    no_waiting(&paid);
    assert_eq!(
        rows.iter()
            .filter(|(_, _, a, f)| a.contains("no_such_method") && f.is_some())
            .count(),
        2
    );
    for kind in ["Payout", "BudgetReturn"] {
        let s = settlement(&env, id, kind).await?;
        assert_eq!(
            (s["state"].as_str(), s["attempt"].as_u64()),
            (Some("Due"), Some(1)),
            "{kind}"
        );
    }
    assert_eq!(
        held(&env).await?,
        (REWARD + BUDGET, 0),
        "both principals still reserved"
    );
    step(&env, "both sends failed, refunds back", &mut lowest).await?;
    let r = call(&env.stranger, &env, "send_due", json!({"bounty_id": id}), 0).await?;
    trace(&env, "retry: both resent together", &r, env.stranger.id()).await?;
    no_waiting(&r);
    assert_eq!(
        r.json::<u32>()?,
        2,
        "both resent at once, both fees out again"
    );
    for kind in ["Payout", "BudgetReturn"] {
        let s = settlement(&env, id, kind).await?;
        assert_eq!(
            (
                s["state"].as_str(),
                s["attempt"].as_u64(),
                s["done_by"].as_str()
            ),
            (Some("Done"), Some(2), Some("callback")),
            "{kind}"
        );
    }
    assert_eq!(held(&env).await?, (0, 0));
    let end = step(&env, "settled on the retry", &mut lowest).await?;
    let cvault = vault_of(&env, &env.contrib_keys).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    exact_vault(&env, &cvault, id, 0, REWARD, 2).await?;
    exact_vault(&env, &mvault, id, 1, BUDGET, 2).await?;
    env.note(format!(
        "PAYOUT RETRY: left over {} NEAR; lowest slack {lowest} yocto",
        near(end as u128)
    ));
    env.save_trace("deposit-worst-case-payout-retry")?;
    Ok(())
}

#[tokio::test]
async fn a_worst_case_refund_retries_a_failed_send_on_its_own_deposit() -> anyhow::Result<()> {
    let env = worst_case_env(FAULT_WASM).await?;
    let mut lowest = i128::MAX;
    let id = post(&env, 8_502, 1, 600, 900, 3_600).await?;
    claim_and_bind(&env, id, 1).await?;
    let deadline: u64 = get_bounty(&env, id).await?["merge_deadline"]
        .as_str()
        .unwrap()
        .parse()?;
    reply(
        &env,
        "reply",
        Some(pull_reply_into(&env, id, 3, Some(deadline - 1), "other")),
    )
    .await?;
    let r = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&r, "outcome=ineligible:base_ref"), "{:?}", r.logs());
    let r = call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?;
    trace(
        &env,
        "worst-case refund: the first deposit fails",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(settlement(&env, id, "Refund").await?["state"], "Due");
    step(&env, "send failed, refund back", &mut lowest).await?;
    let r = call(&env.stranger, &env, "send_due", json!({"bounty_id": id}), 0).await?;
    trace(&env, "retry of the refund", &r, env.stranger.id()).await?;
    no_waiting(&r);
    let s = settlement(&env, id, "Refund").await?;
    assert_eq!(
        (s["state"].as_str(), s["attempt"].as_u64()),
        (Some("Done"), Some(2))
    );
    assert_eq!(held(&env).await?, (0, 0));
    let end = step(&env, "refunded on the retry", &mut lowest).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    exact_vault(&env, &mvault, id, 2, REWARD + BUDGET, 2).await?;
    env.note(format!(
        "REFUND RETRY: left over {} NEAR; lowest slack {lowest} yocto",
        near(end as u128)
    ));
    env.save_trace("deposit-worst-case-refund-retry")?;
    Ok(())
}
