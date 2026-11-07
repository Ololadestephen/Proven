//! Sandbox tests against the compiled contracts and a mock of the OutLayer contract. Build all
//! three first: `cargo near build non-reproducible-wasm` in `contracts/escrow`,
//! `contracts/mock-outlayer`.

mod common;

use common::*;
use near_workspaces::types::NearToken;
use serde_json::json;

#[tokio::test]
async fn near_job_passes_through_outlayer_and_pays_the_worker() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    let recorded = job(&env, id).await?;
    assert_eq!(recorded["state"], "Passed");
    assert_eq!(recorded["verdict_request_id"], "4242");
    assert!(recorded["report_hash"].is_string());

    let before = near_balance(&env.worker).await?;
    let paid: bool = payout(&env, "release", id).await?.into_result()?.json()?;
    assert!(paid);
    assert_eq!(
        near_balance(&env.worker).await? - before,
        NearToken::from_near(1).as_yoctonear()
    );
    assert_eq!(state(&env, id).await?, "Released");
    assert_refused(&payout(&env, "release", id).await?, "job has not passed");
    Ok(())
}

#[tokio::test]
async fn near_job_fails_through_outlayer_and_refunds_the_buyer() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "fail").await?;
    verify(&env, id).await?.into_result()?;
    let recorded = job(&env, id).await?;
    assert_eq!(recorded["state"], "Failed");
    assert_eq!(recorded["failed_rule"], "grand_total");

    let left = budget_left(&env, id).await?;
    let before = near_balance(&env.buyer).await?;
    payout(&env, "refund", id).await?.into_result()?;
    assert_eq!(
        near_balance(&env.buyer).await? - before,
        NearToken::from_near(1).as_yoctonear() + left
    );
    assert_eq!(state(&env, id).await?, "Refunded");
    Ok(())
}

#[tokio::test]
async fn no_account_can_set_a_result() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "hold").await?;
    verify(&env, id).await?.into_result().ok();
    let held = state(&env, id).await?;

    let attempt = job(&env, id).await?["attempt"].as_u64().unwrap();
    let callback = json!({ "job_id": id, "attempt": attempt, "kind": "Verify" });
    for who in [
        &env.stranger,
        &env.owner,
        &env.secrets_owner,
        &env.worker,
        &env.buyer,
    ] {
        assert_refused(
            &call(&env, who, "on_run_result", callback.clone(), NO_DEPOSIT).await?,
            "is private",
        );
    }
    // The methods a relay used to post results with no longer exist.
    let verdict = json!({ "job_id": id, "pass": true, "spec_hash": SPEC, "deliverable_hash": DELIVERABLE, "report_hash": FAKES, "attestation_hash": FAKES });
    for who in [&env.owner, &env.secrets_owner] {
        assert_refused(
            &call(&env, who, "record_verdict", verdict.clone(), NO_DEPOSIT).await?,
            "MethodNotFound",
        );
        assert_refused(
            &call(
                &env,
                who,
                "record_challenge",
                json!({ "job_id": id }),
                NO_DEPOSIT,
            )
            .await?,
            "MethodNotFound",
        );
        assert_refused(
            &call(
                &env,
                who,
                "set_relay",
                json!({ "relay": who.id() }),
                NO_DEPOSIT,
            )
            .await?,
            "MethodNotFound",
        );
    }
    assert_eq!(state(&env, id).await?, held);
    Ok(())
}

#[tokio::test]
async fn every_outlayer_failure_is_no_verdict_and_a_retry_still_works() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    // Each failed run uses some of the budget, like a real one.
    top_up(&env, id, 12).await?;
    for failure in [
        "null",
        "malformed",
        "too_large",
        "panic",
        "wrong_job",
        "wrong_spec",
        "wrong_deliverable",
        "wrong_escrow",
        "wrong_mode",
        "error_field",
        "no_request_id",
    ] {
        behave(&env, failure).await?;
        let _ = verify(&env, id).await?;
        let recorded = job(&env, id).await?;
        assert_eq!(recorded["state"], "Delivered", "{failure}");
        assert!(
            recorded["report_hash"].is_null() && recorded["verdict_request_id"].is_null(),
            "{failure}"
        );
        assert_refused(&payout(&env, "release", id).await?, "job has not passed");
        assert_refused(&payout(&env, "refund", id).await?, "job has not failed");
    }
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "Passed");
    Ok(())
}

#[tokio::test]
async fn every_outlayer_failure_in_a_challenge_is_no_result() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = create_job(&env, 3_600, NearToken::from_near(1).as_yoctonear()).await?;
    // Each failed run uses some of the budget, like a real one.
    top_up(&env, id, 12).await?;
    for failure in [
        "null",
        "malformed",
        "too_large",
        "panic",
        "wrong_job",
        "wrong_spec",
        "wrong_escrow",
        "wrong_mode",
        "error_field",
        "no_request_id",
    ] {
        behave(&env, failure).await?;
        let _ = challenge(&env, id).await?;
        assert_eq!(state(&env, id).await?, "Draft", "{failure}");
        assert_refused(&assign(&env, id).await?, "job is not open");
    }
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    let recorded = job(&env, id).await?;
    assert_eq!(
        (
            recorded["state"].as_str(),
            recorded["fakes_caught"].as_u64()
        ),
        (Some("Open"), Some(13))
    );
    assert_eq!(recorded["challenge_request_id"], "4242");
    Ok(())
}

#[tokio::test]
async fn weak_check_is_rejected_cannot_be_assigned_and_is_refunded_on_close() -> anyhow::Result<()>
{
    let env = setup().await?;
    let id = create_job(&env, 3_600, NearToken::from_near(1).as_yoctonear()).await?;
    behave(&env, "weak_check").await?;
    challenge(&env, id).await?.into_result()?;
    let recorded = job(&env, id).await?;
    assert_eq!(
        (
            recorded["state"].as_str(),
            recorded["fakes_caught"].as_u64()
        ),
        (Some("CheckRejected"), Some(4))
    );
    assert_refused(&assign(&env, id).await?, "job is not open");
    assert_refused(
        &challenge(&env, id).await?,
        "job is not awaiting a challenge",
    );

    call(
        &env,
        &env.buyer,
        "close",
        json!({ "job_id": id }),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    assert_eq!(state(&env, id).await?, "Refunded");
    Ok(())
}

#[tokio::test]
async fn the_run_uses_exactly_what_the_job_fixed() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    // A later change of settings must not reach a job that already exists.
    let other = "6666666666666666666666666666666666666666666666666666666666666666";
    call(
        &env,
        &env.owner,
        "set_verifier",
        json!({ "verifier_url": "https://example.test/other.wasm", "verifier_hash": other }),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    call(
        &env,
        &env.owner,
        "set_secrets_owner",
        json!({ "secrets_owner": env.owner.id() }),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;

    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    let request = last_request(&env).await?;
    assert_eq!(
        request["source"],
        json!({ "WasmUrl": { "url": VERIFIER_URL, "hash": VERIFIER, "build_target": "wasm32-wasip1" } })
    );
    let input: serde_json::Value = serde_json::from_str(request["input_data"].as_str().unwrap())?;
    assert_eq!(
        input,
        json!({ "mode": "verify", "escrow": env.escrow.id(), "job": id, "format_hash": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", "check_hash": SPEC, "deliverable_hash": DELIVERABLE })
    );
    assert_eq!(
        request["secrets_ref"],
        json!({ "profile": format!("v{id}-{}", &DELIVERABLE[..12]), "account_id": env.secrets_owner.id() })
    );
    assert_eq!(request["response_format"], "Json");
    assert_eq!(request["predecessor"], env.escrow.id().as_str());
    assert_eq!(request["signer"], env.secrets_owner.id().as_str());
    // OutLayer returns the unused deposit to the buyer, who paid for it through the budget.
    assert_eq!(request["payer_account_id"], env.buyer.id().as_str());
    Ok(())
}

#[tokio::test]
async fn a_run_is_paid_from_the_budget_and_its_unused_part_goes_to_the_buyer() -> anyhow::Result<()>
{
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    let budget_before: u128 = job(&env, id).await?["compute_budget"]
        .as_str()
        .unwrap()
        .parse()?;
    let buyer_before = near_balance(&env.buyer).await?;
    let stranger_before = near_balance(&env.stranger).await?;
    behave(&env, "null").await?;
    verify(&env, id).await?.into_result()?;
    let budget_after: u128 = job(&env, id).await?["compute_budget"]
        .as_str()
        .unwrap()
        .parse()?;
    assert_eq!(budget_before - budget_after, RUN_DEPOSIT.as_yoctonear());
    // The mock keeps 0.001 NEAR and returns the rest to the payer: the buyer, who signs nothing here.
    assert_eq!(
        near_balance(&env.buyer).await? - buyer_before,
        RUN_DEPOSIT.as_yoctonear() - NearToken::from_millinear(1).as_yoctonear()
    );
    // The caller pays only gas.
    let spent = stranger_before - near_balance(&env.stranger).await?;
    assert!(
        spent < NearToken::from_millinear(40).as_yoctonear(),
        "the caller spent {spent} yoctoNEAR"
    );

    // Admission refunds use NEAR's refund_to, which also names the buyer.
    let buyer_before = near_balance(&env.buyer).await?;
    behave(&env, "panic").await?;
    let _ = verify(&env, id).await?;
    assert_eq!(state(&env, id).await?, "Delivered");
    assert_eq!(
        near_balance(&env.buyer).await? - buyer_before,
        RUN_DEPOSIT.as_yoctonear()
    );
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    let before = near_balance(&env.worker).await?;
    payout(&env, "release", id).await?.into_result()?;
    assert_eq!(
        near_balance(&env.worker).await? - before,
        NearToken::from_near(1).as_yoctonear()
    );
    Ok(())
}

#[tokio::test]
async fn a_run_needs_enough_gas_and_a_budget() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "pass").await?;
    let args = json!({ "job_id": id });
    let low = env
        .secrets_owner
        .call(env.escrow.id(), "request_verification")
        .args_json(args)
        .deposit(NO_DEPOSIT)
        .gas(too_little_gas())
        .transact()
        .await?;
    assert_refused(&low, "attach at least 150 Tgas");
    assert_eq!(state(&env, id).await?, "Delivered");
    Ok(())
}

#[tokio::test]
async fn a_second_trigger_is_refused_while_a_run_is_in_flight_and_one_verdict_is_recorded(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "hold").await?;
    // The call stays open until the held run resolves, so send it without waiting.
    let pending = env
        .secrets_owner
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(NO_DEPOSIT)
        .max_gas()
        .transact_async()
        .await?;
    let mut in_flight = false;
    for _ in 0..30 {
        if state(&env, id).await? == "Verifying" && last_request(&env).await.is_ok() {
            in_flight = true;
            break;
        }
        env.sandbox.fast_forward(1).await?;
    }
    assert!(in_flight);
    assert_refused(&verify(&env, id).await?, "job is not awaiting verification");
    assert_refused(&payout(&env, "expire", id).await?, "job has not expired");

    env.sandbox.fast_forward(3).await?;
    env.outlayer
        .call("resume")
        .args_json(json!({ "behaviour": "fail" }))
        .transact()
        .await?
        .into_result()?;
    let _ = pending.await?;
    assert_eq!(state(&env, id).await?, "Failed");
    assert_refused(&verify(&env, id).await?, "job is not awaiting verification");
    Ok(())
}

#[tokio::test]
async fn a_run_that_times_out_is_no_verdict_and_the_job_then_expires_to_the_buyer(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "hold").await?;
    let pending = env
        .secrets_owner
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(NO_DEPOSIT)
        .max_gas()
        .transact_async()
        .await?;
    env.sandbox.fast_forward(5).await?;
    // Nobody resumes it: the yield times out, and the callback sees `null`.
    env.sandbox.fast_forward(250).await?;
    let _ = pending.await?;
    assert_eq!(state(&env, id).await?, "Delivered");

    let delivered_at: u64 = job(&env, id).await?["delivered_at"]
        .as_str()
        .unwrap()
        .parse()?;
    advance_past(&env, delivered_at + WINDOW_SECS * SEC).await?;
    behave(&env, "pass").await?;
    assert_refused(&verify(&env, id).await?, "the verdict window has closed");

    let left = budget_left(&env, id).await?;
    let before = near_balance(&env.buyer).await?;
    payout(&env, "expire", id).await?.into_result()?;
    assert_eq!(
        near_balance(&env.buyer).await? - before,
        NearToken::from_near(1).as_yoctonear() + left
    );
    assert_eq!(state(&env, id).await?, "Refunded");
    assert_refused(&verify(&env, id).await?, "job is not awaiting verification");
    Ok(())
}

#[tokio::test]
async fn missed_deadline_refuses_delivery_and_expires_to_the_buyer() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = create_job(&env, 1_830, NearToken::from_near(1).as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    assign(&env, id).await?.into_result()?;
    assert_refused(&payout(&env, "expire", id).await?, "job has not expired");

    let deadline: u64 = job(&env, id).await?["deadline"].as_str().unwrap().parse()?;
    advance_past(&env, deadline).await?;
    assert_refused(
        &deliver(&env, &env.worker, id).await?,
        "the delivery deadline has passed",
    );

    let left = budget_left(&env, id).await?;
    let before = near_balance(&env.buyer).await?;
    payout(&env, "expire", id).await?.into_result()?;
    assert_eq!(
        near_balance(&env.buyer).await? - before,
        NearToken::from_near(1).as_yoctonear() + left
    );
    assert_eq!(state(&env, id).await?, "Refunded");
    Ok(())
}

#[tokio::test]
async fn outsiders_cannot_deliver() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = create_job(&env, 3_600, NearToken::from_near(1).as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    assign(&env, id).await?.into_result()?;
    assert_refused(
        &deliver(&env, &env.stranger, id).await?,
        "only the job's worker can deliver",
    );
    assert_eq!(state(&env, id).await?, "Funded");
    Ok(())
}

#[tokio::test]
async fn payouts_at_the_minimum_gas_settle_and_a_failed_transfer_still_reverts(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let floor = near_workspaces::types::Gas::from_tgas(50);

    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    let release = env
        .stranger
        .call(env.escrow.id(), "release")
        .args_json(json!({ "job_id": id }))
        .gas(floor)
        .transact()
        .await?;
    assert!(release.into_result()?.json::<bool>()?);
    assert_eq!(state(&env, id).await?, "Released");

    // A transfer to an account that no longer exists fails, and the callback reverts the job.
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    env.worker
        .clone()
        .delete_account(env.stranger.id())
        .await?
        .into_result()?;
    let release = env
        .stranger
        .call(env.escrow.id(), "release")
        .args_json(json!({ "job_id": id }))
        .gas(floor)
        .transact()
        .await?;
    assert!(!release.json::<bool>()?);
    assert_eq!(state(&env, id).await?, "Passed");
    assert_eq!(
        near_cap(&env).await?["held"],
        NearToken::from_near(1).as_yoctonear().to_string()
    );

    let low = env
        .stranger
        .call(env.escrow.id(), "release")
        .args_json(json!({ "job_id": id }))
        .gas(near_workspaces::types::Gas::from_tgas(49))
        .transact()
        .await?;
    assert_refused(&low, "attach at least 50 Tgas");
    Ok(())
}

#[tokio::test]
async fn settlement_failure_never_reimburses_from_job_money_and_anyone_can_recover_its_refund(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "settlement_panic").await?;
    let budget = |job: serde_json::Value| -> u128 {
        job["compute_budget"].as_str().unwrap().parse().unwrap()
    };
    let before = budget(job(&env, id).await?);
    verify(&env, id).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "Delivered");
    // The run's deposit came from the budget, and only that much.
    assert_eq!(
        before - budget(job(&env, id).await?),
        RUN_DEPOSIT.as_yoctonear()
    );
    let args = json!({ "request_id": "4242" });
    let early = call(
        &env,
        &env.buyer,
        "cancel_stale_outlayer_execution",
        args.clone(),
        NO_DEPOSIT,
    )
    .await?;
    assert_refused(&early, "not yet stale");
    advance_past(&env, now(&env).await? + 600 * SEC).await?;
    // The recovered refund goes to the buyer, who paid for the run, whoever asks for it.
    let before = near_balance(&env.buyer).await?;
    call(
        &env,
        &env.stranger,
        "cancel_stale_outlayer_execution",
        args.clone(),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    assert_eq!(
        near_balance(&env.buyer).await? - before,
        RUN_DEPOSIT.as_yoctonear() - NearToken::from_millinear(1).as_yoctonear()
    );
    assert!(call(
        &env,
        &env.buyer,
        "cancel_stale_outlayer_execution",
        args,
        NO_DEPOSIT
    )
    .await?
    .is_failure());
    assert_eq!(state(&env, id).await?, "Delivered");
    Ok(())
}

#[tokio::test]
async fn an_exhausted_callback_keeps_the_job_retriable_then_expirable() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "hold").await?;
    let pending = env
        .secrets_owner
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(NO_DEPOSIT)
        .max_gas()
        .transact_async()
        .await?;
    for _ in 0..30 {
        if state(&env, id).await? == "Verifying" {
            break;
        }
        env.sandbox.fast_forward(1).await?;
    }
    assert_eq!(state(&env, id).await?, "Verifying");
    // Replace only the callback code with an infinite host-call loop to force actual gas
    // exhaustion. The original persistent job bytes remain untouched throughout.
    env.escrow
        .as_account()
        .deploy(&read_wasm(MOCK_WASM)?)
        .await?
        .into_result()?;
    env.outlayer
        .call("resume")
        .args_json(json!({ "behaviour": "pass" }))
        .transact()
        .await?
        .into_result()?;
    let exhausted = pending.await?;
    assert_refused(&exhausted, "Exceeded the prepaid gas");
    env.escrow
        .as_account()
        .deploy(&read_wasm(ESCROW_WASM)?)
        .await?
        .into_result()?;
    let recorded = job(&env, id).await?;
    assert_eq!(recorded["state"], "Verifying");
    assert!(recorded["report_hash"].is_null());
    advance_past(
        &env,
        recorded["run_started_at"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 900 * SEC,
    )
    .await?;
    behave(&env, "null").await?;
    verify(&env, id).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "Delivered");
    advance_past(
        &env,
        recorded["delivered_at"].as_str().unwrap().parse::<u64>()? + WINDOW_SECS * SEC,
    )
    .await?;
    payout(&env, "expire", id).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "Refunded");
    Ok(())
}

#[tokio::test]
async fn the_minimum_trigger_gas_runs_a_bounded_callback() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "max_size").await?;
    let result = env
        .secrets_owner
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(NO_DEPOSIT)
        .gas(near_workspaces::types::Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(result.into_result()?.json::<bool>()?);
    assert_eq!(state(&env, id).await?, "Passed");
    Ok(())
}

#[tokio::test]
async fn a_delivery_cannot_be_changed_once_delivered() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    let changed = call(
        &env,
        &env.worker,
        "deliver",
        json!({ "job_id": id, "deliverable_hash": FAKES }),
        NO_DEPOSIT,
    )
    .await?;
    assert!(changed.is_failure());
    assert_eq!(job(&env, id).await?["deliverable_hash"], DELIVERABLE);
    Ok(())
}

async fn owner_call(env: &Env, method: &str, args: serde_json::Value) -> anyhow::Result<()> {
    call(env, &env.owner, method, args, NO_DEPOSIT)
        .await?
        .into_result()?;
    Ok(())
}

async fn near_cap(env: &Env) -> anyhow::Result<serde_json::Value> {
    let config: serde_json::Value = env.escrow.view("get_config").await?.json()?;
    Ok(config["caps"][0].clone())
}

#[tokio::test]
async fn the_pause_stops_only_new_jobs_and_new_assignments() -> anyhow::Result<()> {
    let env = setup().await?;
    let one = NearToken::from_near(1);
    let unassigned = create_job(&env, 3_600, one.as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, unassigned).await?.into_result()?;
    let to_pay = delivered_near_job(&env, 3_600).await?;
    let to_refund = delivered_near_job(&env, 3_600).await?;
    let to_finish = create_job(&env, 3_600, one.as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, to_finish).await?.into_result()?;
    assign(&env, to_finish).await?.into_result()?;
    let to_expire = create_job(&env, 1_810, one.as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, to_expire).await?.into_result()?;
    assign(&env, to_expire).await?.into_result()?;

    assert_refused(
        &call(
            &env,
            &env.stranger,
            "set_paused",
            json!({ "paused": true }),
            NO_DEPOSIT,
        )
        .await?,
        "only the owner",
    );
    owner_call(&env, "set_paused", json!({ "paused": true })).await?;

    // Nothing new starts.
    let refused = create_job(&env, 3_600, one.as_yoctonear()).await;
    assert!(format!("{refused:?}").contains("new jobs are paused"));
    assert_refused(
        &assign(&env, unassigned).await?,
        "new assignments are paused",
    );

    // Everything already under way can still finish, in every direction.
    behave(&env, "pass").await?;
    verify(&env, to_pay).await?.into_result()?;
    payout(&env, "release", to_pay).await?.into_result()?;
    assert_eq!(state(&env, to_pay).await?, "Released");
    behave(&env, "fail").await?;
    verify(&env, to_refund).await?.into_result()?;
    payout(&env, "refund", to_refund).await?.into_result()?;
    assert_eq!(state(&env, to_refund).await?, "Refunded");
    deliver(&env, &env.worker, to_finish).await?.into_result()?;
    behave(&env, "pass").await?;
    verify(&env, to_finish).await?.into_result()?;
    payout(&env, "release", to_finish).await?.into_result()?;
    advance_past(
        &env,
        job(&env, to_expire).await?["deadline"]
            .as_str()
            .unwrap()
            .parse()?,
    )
    .await?;
    payout(&env, "expire", to_expire).await?.into_result()?;
    assert_eq!(state(&env, to_expire).await?, "Refunded");
    call(
        &env,
        &env.buyer,
        "close",
        json!({ "job_id": unassigned }),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    assert_eq!(state(&env, unassigned).await?, "Refunded");
    assert_eq!(near_cap(&env).await?["held"], "0");

    owner_call(&env, "set_paused", json!({ "paused": false })).await?;
    create_job(&env, 3_600, one.as_yoctonear()).await?;
    Ok(())
}

#[tokio::test]
async fn caps_refuse_money_coming_in_and_never_trap_money_going_out() -> anyhow::Result<()> {
    let env = setup().await?;
    let one = NearToken::from_near(1).as_yoctonear();
    let caps = |job: u128, held: u128| json!({ "max_job": job.to_string(), "max_held": held.to_string(), "max_held_per_buyer": held.to_string() });
    assert_refused(
        &call(
            &env,
            &env.stranger,
            "set_caps",
            caps(100 * one, 100 * one),
            NO_DEPOSIT,
        )
        .await?,
        "only the owner",
    );
    owner_call(&env, "set_caps", caps(one, one + one / 2)).await?;

    // Over the per-job cap. The board's deposit comes back with the refusal.
    let board_before = near_balance(&env.board).await?;
    let over = create_job(&env, 3_600, 2 * one).await;
    assert!(format!("{over:?}").contains("per-job cap"));
    assert!(board_before - near_balance(&env.board).await? < one / 100);

    // Money is held from posting, so the second job would pass the cap on money held.
    let first = delivered_near_job(&env, 3_600).await?;
    assert_eq!(near_cap(&env).await?["held"], one.to_string());
    let second = create_job(&env, 3_600, one).await;
    assert!(format!("{second:?}").contains("cap on money held"));

    // Lowering a cap below what is held traps nothing, and a payout frees room exactly once.
    owner_call(&env, "set_caps", caps(1, 1)).await?;
    behave(&env, "pass").await?;
    verify(&env, first).await?.into_result()?;
    payout(&env, "release", first).await?.into_result()?;
    assert_eq!(state(&env, first).await?, "Released");
    assert_eq!(near_cap(&env).await?["held"], "0");
    assert_refused(&payout(&env, "release", first).await?, "job has not passed");
    assert_eq!(near_cap(&env).await?["held"], "0");

    owner_call(&env, "set_caps", caps(one, one + one / 2)).await?;
    create_job(&env, 3_600, one).await?;
    assert_eq!(near_cap(&env).await?["held"], one.to_string());
    Ok(())
}

/// Upgrades a copy of the real mainnet escrow, with its real state, to this code. Needs the fixtures
/// written by reading the chain; skipped without them.
#[tokio::test]
async fn the_deployed_mainnet_escrow_upgrades_with_its_jobs_intact() -> anyhow::Result<()> {
    let Ok(old) = std::fs::read("tests/fixtures/mainnet-escrow-v5.wasm") else {
        eprintln!("skipped: no mainnet fixture");
        return Ok(());
    };
    let values: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read("tests/fixtures/mainnet-state-v5.json")?)?;
    let sandbox = near_workspaces::sandbox().await?;
    let escrow = sandbox.dev_deploy(&old).await?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    for entry in &values {
        sandbox
            .patch_state(
                escrow.id(),
                &b64.decode(entry["key"].as_str().unwrap())?,
                &b64.decode(entry["value"].as_str().unwrap())?,
            )
            .await?;
    }
    let before: serde_json::Value = escrow
        .view("get_job")
        .args_json(json!({ "job_id": 3 }))
        .await?
        .json()?;
    assert_eq!(before["state"], "Released");
    let new = std::fs::read("target/near/proven_escrow.wasm")?;
    let account = escrow.as_account().clone();
    let upgraded = account.deploy(&new).await?.into_result()?;
    // The new code cannot read the old state until the migration has run.
    assert!(upgraded.view("get_config").await.is_err());
    let args = json!({ "board": "proven-board.near", "run_deposit": RUN_DEPOSIT.as_yoctonear().to_string() });
    // Nobody else can run it.
    let stranger = sandbox.dev_create_account().await?;
    let refused = stranger
        .call(upgraded.id(), "migrate")
        .args_json(args.clone())
        .max_gas()
        .transact()
        .await?;
    assert!(refused.is_failure());
    upgraded
        .call("migrate")
        .args_json(args.clone())
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let config: serde_json::Value = upgraded.view("get_config").await?.json()?;
    assert_eq!(config["owner"], "proven-ops.near");
    assert_eq!(config["board"], "proven-board.near");
    assert_eq!(config["next_job_id"], 4);
    assert_eq!(
        config["caps"][0]["max_job"],
        NearToken::from_millinear(100).as_yoctonear().to_string()
    );
    assert_eq!(
        config["caps"][0]["max_held"],
        NearToken::from_near(1).as_yoctonear().to_string()
    );
    assert_eq!(config["caps"][0]["held"], "0");
    assert_eq!(
        config["caps"][0]["max_held_per_buyer"],
        NearToken::from_millinear(200).as_yoctonear().to_string()
    );
    for (id, state) in [(0, "Released"), (1, "Refunded"), (3, "Released")] {
        let job: serde_json::Value = upgraded
            .view("get_job")
            .args_json(json!({ "job_id": id }))
            .await?
            .json()?;
        assert_eq!(job["state"], state);
        assert_eq!(job["max_attempts"], 1);
        assert!(job["worker"].is_string());
        assert_eq!(job["compute_budget"], "0");
    }
    let three: serde_json::Value = upgraded
        .view("get_job")
        .args_json(json!({ "job_id": 3 }))
        .await?
        .json()?;
    assert_eq!(three["verdict_request_id"], "2861");
    assert_eq!(
        three["deliverable_hash"],
        "d45d7caed7e6f5359ba40a44dd85ae8bfd43662b23e2bc9718a8df16b8032f51"
    );
    // A second run of the migration cannot work: the state is already in the new layout.
    let again = upgraded
        .call("migrate")
        .args_json(args)
        .max_gas()
        .transact()
        .await?;
    assert!(again.is_failure());
    Ok(())
}

#[tokio::test]
async fn only_the_board_creates_and_assigns() -> anyhow::Result<()> {
    let env = setup().await?;
    let expires_at = now(&env).await? + 24 * 3_600 * SEC;
    let args = json!({
        "buyer": env.buyer.id(), "spec_hash": SPEC, "fakes_hash": FAKES, "format_hash": FORMAT,
        "amount": NearToken::from_near(1).as_yoctonear().to_string(), "verifier_hash": VERIFIER,
        "expires_at": expires_at.to_string(), "deliver_secs": 3_600, "verdict_window_secs": WINDOW_SECS,
        "max_attempts": 1,
    });
    assert_refused(
        &call(
            &env,
            &env.buyer,
            "create_open_job",
            args,
            NearToken::from_near(2),
        )
        .await?,
        "only the board can do this",
    );
    let id = create_job(&env, 3_600, NearToken::from_near(1).as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    for who in [&env.buyer, &env.worker, &env.owner, &env.stranger] {
        assert_refused(
            &call(
                &env,
                who,
                "assign",
                json!({ "job_id": id, "worker": who.id() }),
                NO_DEPOSIT,
            )
            .await?,
            "only the board can do this",
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_failed_worker_is_followed_by_the_next_and_the_buyer_pays_once() -> anyhow::Result<()> {
    let env = setup().await?;
    let one = NearToken::from_near(1).as_yoctonear();
    let id = create_job_with(&env, 3_600, one, 2).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    assign(&env, id).await?.into_result()?;
    deliver(&env, &env.worker, id).await?.into_result()?;
    behave(&env, "fail").await?;
    verify(&env, id).await?.into_result()?;
    payout(&env, "refund", id).await?.into_result()?;
    let reopened = job(&env, id).await?;
    assert_eq!(reopened["state"], "Open");
    assert!(reopened["worker"].is_null());
    assert_eq!(reopened["history"][0]["outcome"], "Failed");
    assert_eq!(reopened["history"][0]["worker"], env.worker.id().as_str());
    assert_eq!(near_cap(&env).await?["held"], one.to_string());

    // A second worker takes it and passes. The first cannot deliver again.
    let second = env.sandbox.dev_create_account().await?;
    call(
        &env,
        &env.board,
        "assign",
        json!({ "job_id": id, "worker": second.id() }),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    assert_refused(
        &deliver(&env, &env.worker, id).await?,
        "only the job's worker can deliver",
    );
    deliver(&env, &second, id).await?.into_result()?;
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    let before = near_balance(&second).await?;
    payout(&env, "release", id).await?.into_result()?;
    assert_eq!(near_balance(&second).await? - before, one);
    let paid = job(&env, id).await?;
    assert_eq!(paid["state"], "Released");
    assert_eq!(paid["history"][1]["outcome"], "Paid");
    assert_eq!(near_cap(&env).await?["held"], "0");

    // What is left of the budget goes back to the buyer, once.
    let left: u128 = paid["compute_budget"].as_str().unwrap().parse()?;
    assert_eq!(left, budget(2) - 3 * RUN_DEPOSIT.as_yoctonear());
    let buyer_before = near_balance(&env.buyer).await?;
    payout(&env, "return_budget", id).await?.into_result()?;
    assert_eq!(near_balance(&env.buyer).await? - buyer_before, left);
    assert_refused(
        &payout(&env, "return_budget", id).await?,
        "nothing is left to return",
    );
    Ok(())
}

#[tokio::test]
async fn closing_an_open_job_returns_the_payment_and_the_rest_of_the_budget() -> anyhow::Result<()>
{
    let env = setup().await?;
    let one = NearToken::from_near(1).as_yoctonear();
    let id = create_job(&env, 3_600, one).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    assert_refused(
        &call(
            &env,
            &env.stranger,
            "close",
            json!({ "job_id": id }),
            NO_DEPOSIT,
        )
        .await?,
        "only the buyer can close this job before it ends",
    );
    let left: u128 = job(&env, id).await?["compute_budget"]
        .as_str()
        .unwrap()
        .parse()?;
    // The board closes it for the buyer, so the buyer's balance changes by exactly the refund.
    let before = near_balance(&env.buyer).await?;
    call(
        &env,
        &env.board,
        "close",
        json!({ "job_id": id }),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    assert_eq!(near_balance(&env.buyer).await? - before, one + left);
    assert_eq!(state(&env, id).await?, "Refunded");
    assert_eq!(near_cap(&env).await?["held"], "0");
    Ok(())
}

#[tokio::test]
async fn the_payout_and_budget_callbacks_are_private() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    for (method, args) in [
        ("on_payout", json!({ "job_id": id, "to_worker": true })),
        ("on_budget_returned", json!({ "job_id": id, "amount": "1" })),
    ] {
        assert_refused(
            &call(&env, &env.worker, method, args, NO_DEPOSIT).await?,
            "is private",
        );
    }
    Ok(())
}
