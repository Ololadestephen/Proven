//! Fault-build sandbox tests (`--features test-faults`): lost settlement callbacks, a failed
//! first deposit, a deposit delayed past its seal, a failed reconcile callback, the reconcile
//! caller and timing rules, concurrent reconciles, the total cap while a settlement is pending,
//! and the pause. The faults are keyed by issue number (see `faults` in src/lib.rs):
//!   9000..  both settlement callbacks fail
//!   9500..9899  also the first deposit fails
//!   9900  also the first deposit is delayed by 60 self-calls
//! and a reconcile signed by an account whose name starts with `fault-` has its callback fail.
//! The fault build's delays: a party may reconcile 3 s after a send, anyone 9 s after, and a
//! reconcile marker blocks others for 4 s. Build first (see tests/common/mod.rs).

mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

const PARTY_DELAY_NS: u64 = 3_000_000_000;
const OPEN_DELAY_NS: u64 = 9_000_000_000;
const MARKER_NS: u64 = 4_000_000_000;

async fn cancel(
    env: &Env,
    id: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    call(&env.maint, env, "cancel", json!({"bounty_id": id}), 0).await
}

/// A second posting by the maintainer, with nonce `n`, to test the total cap.
async fn post_next(
    env: &Env,
    n: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let now = now_secs(env).await?;
    let t = terms(1, now, 600, 900, 3_600);
    let proof = posting_proof(
        env,
        &t,
        &env.maint_keys,
        env.maint.id(),
        &nonce(n),
        now + 1800,
    )
    .await?;
    try_post(env, t, proof).await
}

async fn send_due(
    env: &Env,
    id: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    call(&env.stranger, env, "send_due", json!({"bounty_id": id}), 0).await
}

#[tokio::test]
async fn lost_callbacks_after_successful_deposits_are_reconciled_exactly_once() -> anyhow::Result<()>
{
    let env = setup_with(FAULT_WASM).await?;
    let id = post(&env, 9_001, 1, 600, 900, 3_600).await?;
    claim_and_bind(&env, id, 1).await?;
    let cvault = vault_of(&env, &env.contrib_keys).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    let paid = merged_check(&env, id, 3, false).await?;
    let rows = trace(
        &env,
        "paid; both deposits succeed, all four settlement callbacks fail",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(
        rows.iter()
            .filter(|(_, _, a, f)| a.contains("FunctionCall deposit") && f.is_none())
            .count(),
        2
    );
    assert!(failed_with(
        &rows,
        env.bounty.id().as_str(),
        "fault injection: on_settle fails"
    ));
    assert!(failed_with(
        &rows,
        env.bounty.id().as_str(),
        "fault injection: on_settle_outcome fails"
    ));
    let (state, attempt, sent_at, outcome, _) = sstate(&env, id, "Payout").await?;
    assert_eq!(
        (state.as_str(), attempt, outcome.as_str()),
        ("InFlight", 1, "Unknown")
    );
    assert_eq!(
        held(&env).await?,
        (REWARD + BUDGET, REWARD + BUDGET),
        "both principals still held and in flight"
    );
    let s0 = snapshot(&env, "after the lost callbacks", id, "Payout", &cvault).await?;
    assert_eq!(
        s0["withdrawable"],
        REWARD.to_string(),
        "the payout is in the vault"
    );

    // Wrong attempts are refused at any time; a stranger is refused before the open delay.
    for (who, attempt, text) in [
        (&env.contrib, 0u32, "only the current attempt"),
        (&env.contrib, 2, "only the current attempt"),
        (&env.stranger, 1, "too early to reconcile"),
    ] {
        let r = reconcile(&env, who, id, "Payout", attempt).await?;
        assert_refused(&r, text);
        assert!(same_state(
            &s0,
            &snapshot(&env, &format!("refused: {text}"), id, "Payout", &cvault).await?
        ));
    }
    // The party delay boundary: the contributor's wallet tries until it is accepted. Every
    // refused try ran before sent_at + delay, the accepted one at or after it.
    let mut last_refused = 0;
    let accepted = loop {
        let r = reconcile(&env, &env.contrib, id, "Payout", 1).await?;
        let at = exec_ns(&env, &r).await?;
        if r.is_success() {
            break (r, at);
        }
        assert_refused(&r, "too early to reconcile");
        assert!(same_state(
            &s0,
            &snapshot(&env, "refused: too early", id, "Payout", &cvault).await?
        ));
        last_refused = at;
    };
    let (r, at) = accepted;
    env.note(format!(
        "  party delay boundary: sent_at {sent_at}, last refused at {last_refused} (+{} ms), accepted at {at} (+{} ms)",
        last_refused.saturating_sub(sent_at) / 1_000_000,
        (at - sent_at) / 1_000_000
    ));
    assert!(last_refused > 0, "at least one early try was refused");
    assert!(last_refused < sent_at + PARTY_DELAY_NS && at >= sent_at + PARTY_DELAY_NS);
    let rows = trace(
        &env,
        "contributor reconciles the payout",
        &r,
        env.contrib.id(),
    )
    .await?;
    assert_eq!(answer(&r), "deposited");
    assert!(rows.iter().any(|(_, to, a, f)| to == cvault.as_str()
        && a.contains("FunctionCall seal 0.01")
        && f.is_none()));
    let s1 = snapshot(&env, "after the payout reconcile", id, "Payout", &cvault).await?;
    assert_eq!(
        (s1["state"].as_str(), s1["attempt"].as_u64()),
        (Some("Done"), Some(1))
    );
    assert_eq!(
        settlement(&env, id, "Payout").await?["done_by"],
        "reconcile"
    );
    assert_eq!(
        held(&env).await?,
        (BUDGET, BUDGET),
        "the payout left held exactly once"
    );
    assert_eq!(
        s1["withdrawable"], s0["withdrawable"],
        "a seal of a deposited record changes nothing in the vault"
    );
    assert_refused(
        &reconcile(&env, &env.contrib, id, "Payout", 1).await?,
        "not in flight",
    );

    // Two reconciles of the budget return submitted together: at most one applies.
    sleep_past_ns(
        &env,
        sstate(&env, id, "BudgetReturn").await?.2 + PARTY_DELAY_NS,
    )
    .await?;
    let before = snapshot(
        &env,
        "before the concurrent reconciles",
        id,
        "BudgetReturn",
        &mvault,
    )
    .await?;
    let tx = |who: &near_workspaces::Account| {
        who.call(env.bounty.id(), "reconcile")
            .args_json(json!({"bounty_id": id, "kind": "BudgetReturn", "attempt": 1}))
            .deposit(NearToken::from_yoctonear(RECONCILE))
            .gas(Gas::from_tgas(100))
            .transact_async()
    };
    let (a, b) = (tx(&env.maint).await?, tx(&env.contrib).await?);
    let (a, b) = (a.await?, b.await?);
    let answers = [answer(&a), answer(&b)];
    env.note(format!("  concurrent reconciles answered: {answers:?}"));
    trace(
        &env,
        "concurrent reconcile 1 (maintainer)",
        &a,
        env.maint.id(),
    )
    .await?;
    trace(
        &env,
        "concurrent reconcile 2 (contributor)",
        &b,
        env.contrib.id(),
    )
    .await?;
    assert_eq!(
        answers.iter().filter(|x| x.as_str() == "deposited").count(),
        1,
        "{answers:?}"
    );
    assert!(
        answers.iter().any(|x| x.contains("in progress")
            || x.contains("not in flight")
            || x.contains("ignored")),
        "{answers:?}"
    );
    let after = snapshot(
        &env,
        "after the concurrent reconciles",
        id,
        "BudgetReturn",
        &mvault,
    )
    .await?;
    assert_eq!(after["state"], "Done");
    assert_eq!(
        u(&before["held"]) - u(&after["held"]),
        BUDGET,
        "the budget left held exactly once"
    );
    assert_eq!(held(&env).await?, (0, 0));

    // Both vaults pay exactly.
    for (keys, vault, amount) in [
        (&env.contrib_keys, &cvault, REWARD),
        (&env.maint_keys, &mvault, BUDGET),
    ] {
        let p0 = bal(&env, env.payee.id()).await?;
        let w = withdraw(&env, &keys.primary, vault, env.payee.id(), amount).await?;
        assert!(w.is_success(), "{:?}", w.failures());
        assert_eq!(bal(&env, env.payee.id()).await? - p0, amount);
    }
    env.save_trace("recovery-lost-callbacks-success")?;
    Ok(())
}

#[tokio::test]
async fn a_failed_deposit_is_sealed_due_and_resent_once_while_the_cap_holds() -> anyhow::Result<()>
{
    let env = setup_with(FAULT_WASM).await?;
    let p = REWARD + BUDGET;
    env.owner
        .call(env.bounty.id(), "set_caps")
        .args_json(json!({"max_reward": REWARD.to_string(), "max_held": p.to_string(), "max_open_per_buyer": 5}))
        .transact()
        .await?
        .into_result()?;
    let id = post(&env, 9_501, 1, 600, 900, 3_600).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    let r = cancel(&env, id).await?;
    let rows = trace(
        &env,
        "cancel: the refund deposit fails and both callbacks fail",
        &r,
        env.maint.id(),
    )
    .await?;
    assert!(
        failed_with(&rows, mvault.as_str(), "no_such_method")
            || failed_with(&rows, mvault.as_str(), "MethodNotFound")
    );
    assert!(
        sent(&rows, "system", env.bounty.id().as_str(), p + DEPOSIT_FEE),
        "the failed deposit's NEAR returned in full"
    );
    save_fixture(
        "settlement-in-flight",
        &settlement(&env, id, "Refund").await?,
    )?;
    let s0 = snapshot(
        &env,
        "refund in flight, its deposit failed",
        id,
        "Refund",
        &mvault,
    )
    .await?;
    assert_eq!(
        (s0["state"].as_str(), s0["attempt"].as_u64()),
        (Some("InFlight"), Some(1))
    );
    assert_eq!(
        bal(&env, &mvault).await?,
        0,
        "the failed batch created no vault"
    );
    // A stranger is refused before the open delay; posting is refused while the cap is in flight.
    assert_refused(
        &reconcile(&env, &env.stranger, id, "Refund", 1).await?,
        "too early to reconcile",
    );
    assert_refused(&post_next(&env, 2).await?, "total cap is reached");
    assert!(same_state(
        &s0,
        &snapshot(
            &env,
            "refused: stranger early, posting at the cap",
            id,
            "Refund",
            &mvault
        )
        .await?
    ));

    sleep_past_ns(&env, sstate(&env, id, "Refund").await?.2 + PARTY_DELAY_NS).await?;
    let r = reconcile(&env, &env.maint, id, "Refund", 1).await?;
    trace(
        &env,
        "maintainer reconciles: the vault seals attempt 1 with no deposit",
        &r,
        env.maint.id(),
    )
    .await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    save_fixture("settlement-due", &settlement(&env, id, "Refund").await?)?;
    let s1 = snapshot(&env, "after the seal", id, "Refund", &mvault).await?;
    assert_eq!(
        (s1["state"].as_str(), s1["attempt"].as_u64()),
        (Some("Due"), Some(1))
    );
    assert_eq!(held(&env).await?, (p, 0), "the principal stays held");
    let rec = record(&env, &mvault, id, 2).await?;
    assert_eq!((rec.deposited, rec.sealed_through), (false, 1));
    assert_refused(&post_next(&env, 2).await?, "total cap is reached");

    // A stranger resends; the fresh attempt restarts the reconcile clock, so the stranger
    // cannot interrupt it at once.
    let r = send_due(&env, id).await?;
    let rows = trace(
        &env,
        "stranger resends as attempt 2; its callbacks fail again",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(rows.iter().any(|(_, to, a, f)| to == mvault.as_str()
        && a.contains("FunctionCall deposit")
        && f.is_none()));
    let s2 = snapshot(&env, "attempt 2 in flight", id, "Refund", &mvault).await?;
    assert_eq!(
        (s2["state"].as_str(), s2["attempt"].as_u64()),
        (Some("InFlight"), Some(2))
    );
    assert_eq!(
        s2["withdrawable"],
        p.to_string(),
        "attempt 2 deposited exactly the principal"
    );
    assert_refused(
        &reconcile(&env, &env.stranger, id, "Refund", 2).await?,
        "too early to reconcile",
    );
    assert_refused(&post_next(&env, 2).await?, "total cap is reached");
    assert_refused(
        &reconcile(&env, &env.maint, id, "Refund", 1).await?,
        "only the current attempt",
    );
    sleep_past_ns(&env, sstate(&env, id, "Refund").await?.2 + PARTY_DELAY_NS).await?;
    let r = reconcile(&env, &env.maint, id, "Refund", 2).await?;
    trace(&env, "maintainer reconciles attempt 2", &r, env.maint.id()).await?;
    assert_eq!(answer(&r), "deposited");
    save_fixture("settlement-done", &settlement(&env, id, "Refund").await?)?;
    save_fixture("bounty-refunded", &get_bounty(&env, id).await?)?;
    let s3 = snapshot(&env, "refund done", id, "Refund", &mvault).await?;
    assert_eq!(s3["state"], "Done");
    assert_eq!(held(&env).await?, (0, 0));
    let rec = record(&env, &mvault, id, 2).await?;
    assert_eq!(
        (rec.deposited, rec.attempt, rec.amount, rec.sealed_through),
        (true, 2, p, 1)
    );
    assert_eq!(
        info(&env, &mvault).await?.available,
        p,
        "exactly one principal in the vault"
    );
    let r = post_next(&env, 2).await?;
    assert!(
        r.is_success(),
        "posting is accepted once the deposit is confirmed: {:?}",
        r.failures()
    );
    let p0 = bal(&env, env.maint.id()).await?;
    withdraw(&env, &env.maint_keys.backup, &mvault, env.maint.id(), p)
        .await?
        .into_result()?;
    assert_eq!(bal(&env, env.maint.id()).await? - p0, p);
    env.save_trace("recovery-failed-deposit-and-cap")?;
    Ok(())
}

#[tokio::test]
async fn a_failed_reconcile_callback_is_retried_after_its_marker_expires() -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let id = post(&env, 9_002, 1, 600, 900, 3_600).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    let r = cancel(&env, id).await?;
    trace(
        &env,
        "cancel: refund deposited, callbacks fail",
        &r,
        env.maint.id(),
    )
    .await?;
    let sent_at = sstate(&env, id, "Refund").await?.2;
    // After the open delay anyone may reconcile; this one's callback fails, leaving its marker.
    sleep_past_ns(&env, sent_at + OPEN_DELAY_NS).await?;
    let r = reconcile(&env, &env.fault_stranger, id, "Refund", 1).await?;
    let rows = trace(
        &env,
        "a stranger's reconcile whose callback fails",
        &r,
        env.fault_stranger.id(),
    )
    .await?;
    assert!(failed_with(
        &rows,
        env.bounty.id().as_str(),
        "fault injection: on_reconcile fails"
    ));
    let started = exec_ns(&env, &r).await?;
    let s0 = snapshot(
        &env,
        "after the failed reconcile callback",
        id,
        "Refund",
        &mvault,
    )
    .await?;
    assert_eq!(
        (s0["state"].as_str(), s0["marker"].as_bool()),
        (Some("InFlight"), Some(true))
    );
    assert_eq!(held(&env).await?, (REWARD + BUDGET, REWARD + BUDGET));
    // While the marker lives, even a party is refused; after it expires a retry applies.
    let r = reconcile(&env, &env.maint, id, "Refund", 1).await?;
    if exec_ns(&env, &r).await? < started + MARKER_NS {
        assert_refused(&r, "in progress");
        assert!(same_state(
            &s0,
            &snapshot(&env, "refused: marker", id, "Refund", &mvault).await?
        ));
    } else {
        panic!("the marker expired before the check; raise the fault build's marker time");
    }
    sleep_past_ns(&env, started + MARKER_NS).await?;
    let r = reconcile(&env, &env.stranger, id, "Refund", 1).await?;
    trace(
        &env,
        "a stranger retries after the marker expired",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(answer(&r), "deposited");
    let s1 = snapshot(&env, "refund done", id, "Refund", &mvault).await?;
    assert_eq!(
        (s1["state"].as_str(), s1["marker"].as_bool()),
        (Some("Done"), Some(false))
    );
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(info(&env, &mvault).await?.available, REWARD + BUDGET);
    env.save_trace("recovery-failed-reconcile-callback")?;
    Ok(())
}

#[tokio::test]
async fn a_seal_overtakes_a_delayed_deposit_and_the_resend_waits_for_its_refund(
) -> anyhow::Result<()> {
    // The owner funded only 0.03 NEAR beyond storage and the float, so a resend can only be
    // paid with the failed deposit's own NEAR.
    let env = setup_opts(FAULT_WASM, "maint", "contrib", Some(30 * MILLI)).await?;
    let p = REWARD + BUDGET;
    let id = post(&env, 9_900, 1, 600, 900, 3_600).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    env.note(format!(
        "  free balance after posting: {}",
        near(u(&env.bounty.view("get_free_balance").await?.json()?))
    ));
    let pending = env
        .maint
        .call(env.bounty.id(), "cancel")
        .args_json(json!({"bounty_id": id}))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    let mut n = 0;
    while sstate(&env, id, "Refund").await?.0 != "InFlight" {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        n += 1;
        assert!(n < 100, "the refund was not sent");
    }
    let sent_at = sstate(&env, id, "Refund").await?.2;
    sleep_past_ns(&env, sent_at + PARTY_DELAY_NS).await?;
    assert_eq!(
        peek_balance(&env, &mvault).await?,
        0,
        "the delayed deposit has not arrived"
    );
    let r = reconcile(&env, &env.maint, id, "Refund", 1).await?;
    trace(
        &env,
        "the seal reaches the new vault before the delayed deposit",
        &r,
        env.maint.id(),
    )
    .await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    let s0 = snapshot(
        &env,
        "sealed; the deposit is still on its way",
        id,
        "Refund",
        &mvault,
    )
    .await?;
    assert_eq!(
        (s0["state"].as_str(), s0["attempt"].as_u64()),
        (Some("Due"), Some(1))
    );
    // Before the failed deposit's NEAR is back, a resend is refused with no state change.
    let r = send_due(&env, id).await?;
    assert_refused(&r, "no settlement of this bounty could be sent now");
    let refused_at = exec_height(&env, &r).await?;
    assert!(same_state(
        &s0,
        &snapshot(
            &env,
            "refused: resend before the refund",
            id,
            "Refund",
            &mvault
        )
        .await?
    ));

    let done = pending.await?;
    let rows = trace(
        &env,
        "cancel, finished: the delayed deposit is refused by the sealed vault",
        &done,
        env.maint.id(),
    )
    .await?;
    assert!(failed_with(
        &rows,
        mvault.as_str(),
        "this attempt is sealed"
    ));
    assert!(
        sent(&rows, "system", env.bounty.id().as_str(), p + DEPOSIT_FEE),
        "its full NEAR returned"
    );
    let back_at = transfer_height(
        &env,
        &done,
        env.maint.id(),
        "system",
        env.bounty.id().as_str(),
        p + DEPOSIT_FEE,
    )
    .await?
    .unwrap();
    env.note(format!("  resend refused at block {refused_at}; the failed deposit's NEAR returned at block {back_at}"));
    assert!(
        refused_at < back_at,
        "the refusal happened before the NEAR was back"
    );
    let s1 = snapshot(
        &env,
        "the failed deposit's NEAR is back",
        id,
        "Refund",
        &mvault,
    )
    .await?;
    assert!(same_state(&s0, &s1), "the late failure changed no ledger");
    let r = send_due(&env, id).await?;
    trace(
        &env,
        "the resend is accepted after the refund",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    sleep_past_ns(&env, sstate(&env, id, "Refund").await?.2 + PARTY_DELAY_NS).await?;
    let r = reconcile(&env, &env.maint, id, "Refund", 2).await?;
    assert_eq!(answer(&r), "deposited");
    snapshot(&env, "refund done", id, "Refund", &mvault).await?;
    assert_eq!(held(&env).await?, (0, 0));
    let rec = record(&env, &mvault, id, 2).await?;
    assert_eq!(
        (rec.deposited, rec.attempt, rec.amount, rec.sealed_through),
        (true, 2, p, 1)
    );
    assert_eq!(info(&env, &mvault).await?.available, p);
    env.save_trace("recovery-late-deposit")?;
    Ok(())
}

#[tokio::test]
async fn while_paused_every_exit_still_works_and_only_posting_stops() -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let id = post(&env, 9_503, 1, 600, 900, 3_600).await?;
    let expiring = post(&env, 2, 2, 30, 60, 120).await?;
    env.owner
        .call(env.bounty.id(), "set_paused")
        .args_json(json!({"paused": true}))
        .transact()
        .await?
        .into_result()?;
    let now = now_secs(&env).await?;
    let t = terms(3, now, 600, 900, 3_600);
    let proof = posting_proof(
        &env,
        &t,
        &env.maint_keys,
        env.maint.id(),
        &nonce(3),
        now + 1800,
    )
    .await?;
    assert_refused(&try_post(&env, t, proof).await?, "new bounties are paused");
    assert!(!env
        .bounty
        .view("is_nonce_used")
        .args_json(json!({"maintainer": env.maint.id(), "nonce": nonce(3)}))
        .await?
        .json::<bool>()?);
    // Claim proof, nomination and merge check.
    claim_and_bind(&env, id, 1).await?;
    let paid = merged_check(&env, id, 3, true).await?;
    trace(
        &env,
        "paused: a sponsored check pays out; both first deposits fail",
        &paid,
        env.contrib.id(),
    )
    .await?;
    let cvault = vault_of(&env, &env.contrib_keys).await?;
    let mvault = vault_of(&env, &env.maint_keys).await?;
    // Reconcile both (sealed, due), resend both, reconcile both (deposited).
    for (kind, vault) in [("Payout", &cvault), ("BudgetReturn", &mvault)] {
        sleep_past_ns(&env, sstate(&env, id, kind).await?.2 + PARTY_DELAY_NS).await?;
        assert_eq!(
            answer(&reconcile(&env, &env.contrib, id, kind, 1).await?),
            "sealed_without_deposit",
            "{kind}"
        );
        snapshot(&env, "paused: sealed", id, kind, vault).await?;
    }
    let r = send_due(&env, id).await?;
    assert_eq!(r.json::<u32>()?, 2, "both resent");
    for (kind, vault) in [("Payout", &cvault), ("BudgetReturn", &mvault)] {
        sleep_past_ns(&env, sstate(&env, id, kind).await?.2 + PARTY_DELAY_NS).await?;
        assert_eq!(
            answer(&reconcile(&env, &env.maint, id, kind, 2).await?),
            "deposited",
            "{kind}"
        );
        snapshot(&env, "paused: done", id, kind, vault).await?;
    }
    // Withdrawals.
    let p0 = bal(&env, env.payee.id()).await?;
    withdraw(
        &env,
        &env.contrib_keys.primary,
        &cvault,
        env.payee.id(),
        REWARD,
    )
    .await?
    .into_result()?;
    withdraw(
        &env,
        &env.maint_keys.primary,
        &mvault,
        env.payee.id(),
        BUDGET,
    )
    .await?
    .into_result()?;
    assert_eq!(bal(&env, env.payee.id()).await? - p0, REWARD + BUDGET);
    // Settlement after expiry.
    let claim_by: u64 = get_bounty(&env, expiring).await?["claim_by"]
        .as_str()
        .unwrap()
        .parse()?;
    wait_past(&env, claim_by + 15 * 60).await?;
    let r = call(
        &env.stranger,
        &env,
        "settle",
        json!({"bounty_id": expiring}),
        0,
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(settlement(&env, expiring, "Refund").await?["state"], "Done");
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(
        info(&env, &mvault).await?.available,
        REWARD + BUDGET,
        "the refund joined the maintainer's vault"
    );
    env.save_trace("recovery-paused")?;
    Ok(())
}
