//! Fault-build sandbox tests (`--features test-faults`): lost settlement callbacks for a payout
//! and for a refund, a failed first deposit, a deposit delayed past its seal, a failed reconcile
//! callback, the reconcile caller and timing rules, concurrent reconciles, the total cap while a
//! settlement is unconfirmed, the pause and an empty sponsor float. The faults are keyed by issue
//! number (see `faults` in src/lib.rs):
//!   9000..9499  the deposit succeeds, both settlement callbacks fail
//!   9500..9899  the first deposit fails, both callbacks fail
//!   9900        the first deposit is delayed by 60 self-calls, both callbacks fail
//! and a reconcile signed by an account whose name starts with `fault-` has its callback fail.
//! The fault build's delays: a party may reconcile 3 s after a send, anyone 9 s after, and a
//! reconcile marker blocks others for 4 s. Build first (see tests/common/mod.rs). Run with
//! `cargo test --offline --test recovery -- --test-threads 1`.
//! Whenever an attempt's result is unknown, the principal stays in `held`; it leaves `held`
//! only on the vault's own record of a deposit, exactly once. A payout is never refunded.

mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::json;

const PARTY_DELAY_NS: u64 = 3_000_000_000;
const OPEN_DELAY_NS: u64 = 9_000_000_000;
const MARKER_NS: u64 = 4_000_000_000;

fn secs(v: &serde_json::Value) -> u64 {
    v.as_str().expect("a U64 string").parse().expect("a number")
}

/// Posts, claims and binds the contributor's pull request on bounty `issue` (fault timing).
async fn bind(env: &Env, issue: u64) -> anyhow::Result<(u64, PullSpec)> {
    let id = post(env, issue, Timing::FAULT).await?;
    let pull = PullSpec::open(env, GH);
    claim_and_bind(env, &env.contrib, &env.contrib_key.clone(), GH, id, &pull).await?;
    Ok((id, pull))
}

/// A second posting by the maintainer, to test the total cap.
async fn post_next(
    env: &Env,
    issue: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let now = now_secs(env).await?;
    let t = terms(env, issue, now, Timing::FAULT);
    let proof = posting_proof(
        env,
        &t,
        &env.maint_key,
        env.maint.id(),
        &env.next_nonce(),
        now + 1800,
    )
    .await?;
    try_post(env, t, proof).await
}

/// Reconciles from `who` once the party delay has passed; returns the call's result.
async fn reconcile_when_due(
    env: &Env,
    who: &Account,
    id: u64,
    kind: &str,
    attempt: u32,
    delay_ns: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let sent_at = sstate(env, id, kind).await?.2;
    sleep_past_ns(env, sent_at + delay_ns).await?;
    reconcile(env, who, id, kind, attempt).await
}

#[tokio::test]
async fn a_lost_payout_callback_is_reconciled_exactly_once_and_the_payout_is_never_refunded(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let (id, pull) = bind(&env, 9_001).await?;
    let paid = merged_check(&env, id, &pull, false).await?;
    let rows = trace(
        &env,
        "paid; the deposit succeeds, both settlement callbacks fail",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(
        rows.iter()
            .filter(|(_, _, a, f)| a.contains("FunctionCall deposit") && f.is_none())
            .count(),
        1
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
        (REWARD, REWARD),
        "the principal is still held and in flight"
    );
    let s0 = snapshot(&env, "after the lost callbacks", id, "Payout", &cvault).await?;
    assert_eq!(
        s0["withdrawable"],
        REWARD.to_string(),
        "the payout is in the vault"
    );

    // The party delay: the contributor's own try straight after the send is too early.
    let early = reconcile(&env, &env.contrib, id, "Payout", 1).await?;
    let early_at = exec_ns(&env, &early).await?;
    assert_refused(&early, "too early to reconcile");
    assert!(
        early_at < sent_at + PARTY_DELAY_NS,
        "the early try ran inside the delay ({} ms after the send)",
        (early_at - sent_at) / 1_000_000
    );
    assert!(same_state(
        &s0,
        &snapshot(&env, "refused: too early", id, "Payout", &cvault).await?
    ));

    // An unknown payout is never refunded: nothing refunds, cancels or resends it.
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    assert_refused(
        &cancel_bounty(&env, id).await?,
        "only a bounty with no claim can be cancelled",
    );
    assert_refused(
        &send_due(&env, id).await?,
        "no settlement of this bounty could be sent now",
    );
    let r = call(
        &env.stranger,
        &env,
        "recover_settlement",
        json!({"bounty_id": id, "kind": "Payout"}),
        0,
    )
    .await?;
    assert_refused(
        &r,
        "no outcome is recorded for this attempt; reconcile instead",
    );
    let b = get_bounty(&env, id).await?;
    assert!(b["refund"].is_null(), "no refund exists");
    assert_eq!(
        bal(&env, &mvault).await?,
        0,
        "the maintainer vault was never created"
    );
    assert!(same_state(
        &s0,
        &snapshot(&env, "after the refused calls", id, "Payout", &cvault).await?
    ));

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
    // The party delay boundary: every refused try ran before sent_at + delay, the accepted one after.
    let mut last_refused = early_at;
    let (r, at) = loop {
        let before = bal(&env, env.contrib.id()).await?;
        let r = reconcile(&env, &env.contrib, id, "Payout", 1).await?;
        let at = exec_ns(&env, &r).await?;
        if r.is_success() {
            // The seal of a deposited record writes nothing: the whole 0.01 NEAR came back, so the
            // caller paid gas only.
            let (_, burnt) = gas_burnt_total(&r);
            assert_eq!(
                before - bal(&env, env.contrib.id()).await?,
                burnt,
                "a reconcile that changes no vault storage costs gas only"
            );
            break (r, at);
        }
        assert_refused(&r, "too early to reconcile");
        assert!(same_state(
            &s0,
            &snapshot(&env, "refused: too early", id, "Payout", &cvault).await?
        ));
        last_refused = at;
    };
    env.note(format!(
        "  party delay boundary: sent_at {sent_at}, last refused at {last_refused} (+{} ms), accepted at {at} (+{} ms)",
        last_refused.saturating_sub(sent_at) / 1_000_000,
        (at - sent_at) / 1_000_000
    ));
    assert!(last_refused < sent_at + PARTY_DELAY_NS && at >= sent_at + PARTY_DELAY_NS);
    let rows = trace(
        &env,
        "the contributor reconciles the payout",
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
        (0, 0),
        "the payout left held exactly once"
    );
    assert_eq!(
        s1["withdrawable"], s0["withdrawable"],
        "a seal of a deposited record changes nothing in the vault"
    );
    let rec = record(&env, &cvault, id, 0).await?;
    assert_eq!(
        (rec.deposited, rec.attempt, rec.amount, rec.sealed_through),
        (true, 1, REWARD, 0)
    );
    assert_refused(
        &reconcile(&env, &env.contrib, id, "Payout", 1).await?,
        "not in flight",
    );
    assert_refused(
        &send_due(&env, id).await?,
        "no settlement of this bounty could be sent now",
    );
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    assert_eq!(held(&env).await?, (0, 0), "nothing counted twice");
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "withdrawal of the reconciled payout",
    )
    .await?;
    assert_closed(&env, &ledger, "payout reconciled").await?;
    env.save_trace("recovery-lost-payout-callback")?;
    Ok(())
}

#[tokio::test]
async fn a_lost_refund_callback_is_reconciled_by_anyone_and_concurrent_reconciles_apply_once(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[mvault.clone()]).await?;
    let id = post(&env, 9_002, Timing::FAULT).await?;
    let r = cancel_bounty(&env, id).await?;
    trace(
        &env,
        "cancel: the refund deposit succeeds, both callbacks fail",
        &r,
        env.maint.id(),
    )
    .await?;
    let (state, attempt, sent_at, outcome, _) = sstate(&env, id, "Refund").await?;
    assert_eq!(
        (state.as_str(), attempt, outcome.as_str()),
        ("InFlight", 1, "Unknown")
    );
    assert_eq!(held(&env).await?, (REWARD, REWARD));
    assert_eq!(info(&env, &mvault).await?.available, REWARD);
    // A stranger is refused until the open delay; two reconciles submitted together apply once.
    assert_refused(
        &reconcile(&env, &env.stranger, id, "Refund", 1).await?,
        "too early to reconcile",
    );
    sleep_past_ns(&env, sent_at + OPEN_DELAY_NS).await?;
    let before = snapshot(
        &env,
        "before the concurrent reconciles",
        id,
        "Refund",
        &mvault,
    )
    .await?;
    let tx = |who: &Account| {
        who.call(env.bounty.id(), "reconcile")
            .args_json(json!({"bounty_id": id, "kind": "Refund", "attempt": 1}))
            .deposit(NearToken::from_yoctonear(RECONCILE))
            .gas(Gas::from_tgas(100))
            .transact_async()
    };
    let (a, b) = (tx(&env.maint).await?, tx(&env.stranger).await?);
    let (a, b) = (a.await?, b.await?);
    env.tally(&a);
    env.tally(&b);
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
        "concurrent reconcile 2 (stranger)",
        &b,
        env.stranger.id(),
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
        "Refund",
        &mvault,
    )
    .await?;
    assert_eq!(after["state"], "Done");
    assert_eq!(
        u(&before["held"]) - u(&after["held"]),
        REWARD,
        "the principal left held exactly once"
    );
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(
        info(&env, &mvault).await?.available,
        REWARD,
        "one principal in the vault"
    );
    assert_eq!(status_of(&env, id).await?, "Cancelled");
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "withdrawal of the reconciled refund",
    )
    .await?;
    assert_closed(&env, &ledger, "refund reconciled").await?;
    env.save_trace("recovery-lost-refund-callback")?;
    Ok(())
}

async fn status_of(env: &Env, id: u64) -> anyhow::Result<String> {
    Ok(get_bounty(env, id).await?["status"]
        .as_str()
        .unwrap_or("?")
        .to_string())
}

#[tokio::test]
async fn a_failed_first_deposit_is_sealed_due_and_resent_once_while_the_cap_holds(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    env.owner
        .call(env.bounty.id(), "set_caps")
        .args_json(json!({"max_reward": REWARD.to_string(), "max_held": REWARD.to_string(), "max_open_per_buyer": 5}))
        .transact()
        .await?
        .into_result()?;
    let id = post(&env, 9_501, Timing::FAULT).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[mvault.clone()]).await?;
    let r = cancel_bounty(&env, id).await?;
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
        sent(&rows, "system", env.bounty.id().as_str(), REWARD + env.fee),
        "the failed deposit's NEAR returned in full"
    );
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

    // The maintainer's reconcile creates the vault and seals attempt 1 with no deposit: the
    // refund is due again, still held; a seal costs the caller exactly the vault's new storage.
    let caller0 = bal(&env, env.maint.id()).await?;
    let r = reconcile_when_due(&env, &env.maint, id, "Refund", 1, PARTY_DELAY_NS).await?;
    let rows = trace(
        &env,
        "the maintainer reconciles: the vault seals attempt 1 with no deposit",
        &r,
        env.maint.id(),
    )
    .await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    assert!(rows.iter().any(|(_, to, a, f)| to == mvault.as_str()
        && a.contains("DeterministicStateInit")
        && a.contains("FunctionCall seal")
        && f.is_none()));
    let fund = info(&env, &mvault).await?.fund;
    assert_eq!(
        fund,
        u128::from(storage(&env, &mvault).await?) * BYTE,
        "the fund is the vault's storage"
    );
    let (_, burnt) = gas_burnt_total(&r);
    assert_eq!(
        caller0 - bal(&env, env.maint.id()).await?,
        fund + burnt,
        "the caller paid the new vault's storage and gas; the rest of 0.01 NEAR came back"
    );
    let s1 = snapshot(&env, "after the seal", id, "Refund", &mvault).await?;
    assert_eq!(
        (s1["state"].as_str(), s1["attempt"].as_u64()),
        (Some("Due"), Some(1))
    );
    assert_eq!(held(&env).await?, (REWARD, 0), "the principal stays held");
    let rec = record(&env, &mvault, id, 1).await?;
    assert_eq!((rec.deposited, rec.sealed_through), (false, 1));
    assert_eq!(s1["withdrawable"], "0");
    assert_refused(&post_next(&env, 2).await?, "total cap is reached");

    // A stranger resends; the fresh attempt restarts the reconcile clock.
    let r = send_due(&env, id).await?;
    let rows = trace(
        &env,
        "a stranger resends as attempt 2; its callbacks fail again",
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
        REWARD.to_string(),
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
    assert_refused(
        &send_due(&env, id).await?,
        "no settlement of this bounty could be sent now",
    );
    let r = reconcile_when_due(&env, &env.maint, id, "Refund", 2, PARTY_DELAY_NS).await?;
    trace(
        &env,
        "the maintainer reconciles attempt 2",
        &r,
        env.maint.id(),
    )
    .await?;
    assert_eq!(answer(&r), "deposited");
    let s3 = snapshot(&env, "refund done", id, "Refund", &mvault).await?;
    assert_eq!(s3["state"], "Done");
    assert_eq!(held(&env).await?, (0, 0));
    let rec = record(&env, &mvault, id, 1).await?;
    assert_eq!(
        (rec.deposited, rec.attempt, rec.amount, rec.sealed_through),
        (true, 2, REWARD, 1)
    );
    assert_eq!(
        info(&env, &mvault).await?.available,
        REWARD,
        "exactly one principal in the vault"
    );
    let r = post_next(&env, 2).await?;
    assert!(
        r.is_success(),
        "posting is accepted once the deposit is confirmed: {:?}",
        r.failures()
    );
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "withdrawal of the resent refund",
    )
    .await?;
    assert_closed(&env, &ledger, "failed first deposit").await?;
    env.save_trace("recovery-failed-deposit-and-cap")?;
    Ok(())
}

#[tokio::test]
async fn a_failed_first_payout_deposit_is_sealed_and_resent_once_and_never_refunded(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let (id, pull) = bind(&env, 9_503).await?;
    let paid = merged_check(&env, id, &pull, false).await?;
    let rows = trace(
        &env,
        "paid; the first payout deposit fails and the callbacks fail",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert!(
        failed_with(&rows, cvault.as_str(), "no_such_method")
            || failed_with(&rows, cvault.as_str(), "MethodNotFound")
    );
    assert_eq!(held(&env).await?, (REWARD, REWARD));
    assert_eq!(bal(&env, &cvault).await?, 0);
    // The contributor reconciles: sealed, due. Nobody can turn the payout into a refund.
    let r = reconcile_when_due(&env, &env.contrib, id, "Payout", 1, PARTY_DELAY_NS).await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    assert_eq!(held(&env).await?, (REWARD, 0));
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    assert!(get_bounty(&env, id).await?["refund"].is_null());
    // A late deposit of attempt 1 would be refused by the vault; the resend (attempt 2) lands once.
    let r = send_due(&env, id).await?;
    assert_eq!(answer_u32(&r), 1);
    // The maintainer is the bounty's buyer, so it is a party and may reconcile after 3 s.
    let r = reconcile_when_due(&env, &env.maint, id, "Payout", 2, PARTY_DELAY_NS).await?;
    assert_eq!(answer(&r), "deposited");
    let rec = record(&env, &cvault, id, 0).await?;
    assert_eq!(
        (rec.deposited, rec.attempt, rec.amount, rec.sealed_through),
        (true, 2, REWARD, 1)
    );
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(info(&env, &cvault).await?.available, REWARD);
    assert_eq!(
        bal(&env, &mvault).await?,
        0,
        "the maintainer vault never existed"
    );
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "withdrawal of the resent payout",
    )
    .await?;
    assert_closed(&env, &ledger, "failed first payout deposit").await?;
    env.save_trace("recovery-failed-payout-deposit")?;
    Ok(())
}

fn answer_u32(r: &near_workspaces::result::ExecutionFinalResult) -> u32 {
    r.clone()
        .json::<u32>()
        .unwrap_or_else(|_| panic!("not a count: {:?}", r.failures()))
}

#[tokio::test]
async fn a_failed_reconcile_callback_is_retried_after_its_marker_expires() -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let id = post(&env, 9_004, Timing::FAULT).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let r = cancel_bounty(&env, id).await?;
    trace(
        &env,
        "cancel: refund deposited, callbacks fail",
        &r,
        env.maint.id(),
    )
    .await?;
    let sent_at = sstate(&env, id, "Refund").await?.2;
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
    assert_eq!(held(&env).await?, (REWARD, REWARD));
    // While the marker lives, even a party is refused; after it expires a retry applies.
    let r = reconcile(&env, &env.maint, id, "Refund", 1).await?;
    assert!(
        exec_ns(&env, &r).await? < started + MARKER_NS,
        "the marker expired before the check; raise the fault build's marker time"
    );
    assert_refused(&r, "in progress");
    assert!(same_state(
        &s0,
        &snapshot(&env, "refused: marker", id, "Refund", &mvault).await?
    ));
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
    assert_eq!(info(&env, &mvault).await?.available, REWARD);
    env.save_trace("recovery-failed-reconcile-callback")?;
    Ok(())
}

#[tokio::test]
async fn a_seal_overtakes_a_delayed_deposit_and_the_resend_waits_for_its_refund(
) -> anyhow::Result<()> {
    // The contract's spare balance is set to one deposit fee plus 4 milliNEAR (room for the
    // cancel's own storage growth) after posting, so after the first attempt's fee is out a
    // resend can only be paid with the failed deposit's own NEAR.
    let env = setup_with(FAULT_WASM).await?;
    let id = post(&env, 9_900, Timing::FAULT).await?;
    // The cancel itself grows the contract's storage, so allow for that growth as well.
    set_free(&env, env.fee + 4 * MILLI).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[mvault.clone()]).await?;
    env.note(format!(
        "  free balance before the refund: {}",
        near(free_balance(&env).await?)
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
    // Before the failed deposit's NEAR is back the contract cannot pay for a resend.
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
    // A long receipt tree: the workspaces result lists only part of it, so count the burnt
    // tokens from the node's own record of every receipt.
    tally_exact(&env, &done, env.maint.id()).await?;
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
        sent(&rows, "system", env.bounty.id().as_str(), REWARD + env.fee),
        "its full NEAR returned"
    );
    let back_at = transfer_height(
        &env,
        &done,
        env.maint.id(),
        "system",
        env.bounty.id().as_str(),
        REWARD + env.fee,
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
    let r = reconcile_when_due(&env, &env.maint, id, "Refund", 2, PARTY_DELAY_NS).await?;
    assert_eq!(answer(&r), "deposited");
    snapshot(&env, "refund done", id, "Refund", &mvault).await?;
    assert_eq!(held(&env).await?, (0, 0));
    let rec = record(&env, &mvault, id, 1).await?;
    assert_eq!(
        (rec.deposited, rec.attempt, rec.amount, rec.sealed_through),
        (true, 2, REWARD, 1)
    );
    assert_eq!(
        info(&env, &mvault).await?.available,
        REWARD,
        "no double deposit"
    );
    assert!(slack(&env).await? >= 0, "no principal paid for fees");
    assert_closed(&env, &ledger, "delayed deposit").await?;
    env.save_trace("recovery-late-deposit")?;
    Ok(())
}

#[tokio::test]
async fn while_paused_every_exit_still_works_and_only_posting_stops() -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let id = post(&env, 9_505, Timing::FAULT).await?;
    let expiring = post(
        &env,
        2,
        Timing {
            claim_by: 20,
            claim_secs: 10,
            merge: 30,
            grace: 600,
        },
    )
    .await?;
    let r = env
        .owner
        .call(env.bounty.id(), "set_paused")
        .args_json(json!({"paused": true}))
        .transact()
        .await?;
    env.tally(&r);
    r.into_result()?;
    let r = post_next(&env, 3).await?;
    assert_refused(&r, "new bounties are paused");
    // Link, claim, submit and the sponsored merge check all still work.
    let pull = PullSpec::open(&env, GH);
    claim_and_bind(&env, &env.contrib, &env.contrib_key.clone(), GH, id, &pull).await?;
    let paid = merged_check(&env, id, &pull, true).await?;
    trace(
        &env,
        "paused: a sponsored check pays out; the first deposit fails",
        &paid,
        env.contrib.id(),
    )
    .await?;
    // Reconcile (sealed, due), resend, reconcile (deposited), withdraw.
    let r = reconcile_when_due(&env, &env.contrib, id, "Payout", 1, PARTY_DELAY_NS).await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    assert_eq!(answer_u32(&send_due(&env, id).await?), 1);
    let r = reconcile_when_due(&env, &env.maint, id, "Payout", 2, PARTY_DELAY_NS).await?;
    assert_eq!(answer(&r), "deposited");
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "paused: payout withdrawn",
    )
    .await?;
    // The expiring bounty's refund after its claim window.
    let claim_by = secs(&get_bounty(&env, expiring).await?["claim_by"]);
    wait_past(&env, claim_by).await?;
    let r = settle_call(&env, &env.stranger, expiring).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(settlement(&env, expiring, "Refund").await?["state"], "Done");
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(
        info(&env, &mvault).await?.available,
        REWARD,
        "the refund joined the maintainer's vault"
    );
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "paused: refund withdrawn",
    )
    .await?;
    assert_closed(&env, &ledger, "paused").await?;
    env.save_trace("recovery-paused")?;
    Ok(())
}

#[tokio::test]
async fn an_empty_sponsor_float_leaves_checks_refunds_recovery_and_withdrawals_working(
) -> anyhow::Result<()> {
    // The float holds exactly one sponsored run.
    let env = setup(Opts::new(FAULT_WASM).float(RUN)).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let (id, pull) = bind(&env, 9_006).await?;
    let expiring = post(
        &env,
        4,
        Timing {
            claim_by: 20,
            claim_secs: 10,
            merge: 30,
            grace: 600,
        },
    )
    .await?;
    let r = check(&env, &env.contrib, id, &pull, 0).await?;
    assert_eq!(answer(&r), "pending");
    let c = config(&env).await?;
    assert_eq!(
        (u(&c["sponsor_float"]), u(&c["sponsor_spent"])),
        (0, RUN),
        "the float is empty"
    );
    let before = (held(&env).await?, get_bounty(&env, id).await?);
    let r = call(
        &env.contrib,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        0,
    )
    .await?;
    assert_refused(&r, "the sponsor float cannot pay for this check");
    assert_eq!(
        (held(&env).await?, get_bounty(&env, id).await?),
        before,
        "the refusal changed nothing"
    );
    // A self-funded check pays; the callbacks are lost; reconcile recovers the payout.
    let paid = merged_check(&env, id, &pull, false).await?;
    trace(
        &env,
        "empty float: a self-funded check pays out, callbacks lost",
        &paid,
        env.stranger.id(),
    )
    .await?;
    let r = reconcile_when_due(&env, &env.contrib, id, "Payout", 1, PARTY_DELAY_NS).await?;
    assert_eq!(answer(&r), "deposited");
    assert_eq!(
        held(&env).await?,
        (REWARD, 0),
        "only the expiring bounty is still held"
    );
    // The expiry refund works with an empty float, and every vault withdraws exactly.
    let claim_by = secs(&get_bounty(&env, expiring).await?["claim_by"]);
    wait_past(&env, claim_by).await?;
    let r = settle_call(&env, &env.stranger, expiring).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(settlement(&env, expiring, "Refund").await?["state"], "Done");
    assert_eq!(held(&env).await?, (0, 0));
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "empty float: payout withdrawn",
    )
    .await?;
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "empty float: refund withdrawn",
    )
    .await?;
    assert_eq!(u(&config(&env).await?["sponsor_float"]), 0);
    assert_closed(&env, &ledger, "empty float").await?;
    env.save_trace("recovery-empty-float")?;
    Ok(())
}
