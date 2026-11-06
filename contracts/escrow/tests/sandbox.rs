//! Sandbox tests against the compiled contracts and a mock of the OutLayer contract. Build all
//! three first: `cargo near build non-reproducible-wasm` in `contracts/escrow`,
//! `contracts/test-token` and `contracts/mock-outlayer`.

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

    let before = near_balance(&env.buyer).await?;
    payout(&env, "refund", id).await?.into_result()?;
    assert_eq!(
        near_balance(&env.buyer).await? - before,
        NearToken::from_near(1).as_yoctonear()
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
    let id = create_job(&env, false, 3_600, NearToken::from_near(1).as_yoctonear()).await?;
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
        assert_refused(
            &fund_near(&env, id, NearToken::from_near(1)).await?,
            "the check must pass its challenge first",
        );
    }
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    let recorded = job(&env, id).await?;
    assert_eq!(
        (
            recorded["state"].as_str(),
            recorded["fakes_caught"].as_u64()
        ),
        (Some("Challenged"), Some(13))
    );
    assert_eq!(recorded["challenge_request_id"], "4242");
    Ok(())
}

#[tokio::test]
async fn weak_check_is_rejected_cannot_be_funded_and_can_be_cancelled() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = create_job(&env, false, 3_600, NearToken::from_near(1).as_yoctonear()).await?;
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
    assert_refused(
        &fund_near(&env, id, NearToken::from_near(1)).await?,
        "the check must pass its challenge first",
    );
    assert_refused(
        &challenge(&env, id).await?,
        "job is not awaiting a challenge",
    );

    call(
        &env,
        &env.buyer,
        "cancel",
        json!({ "job_id": id }),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    assert!(job(&env, id).await?.is_null());
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
        json!({ "mode": "verify", "escrow": env.escrow.id(), "job": id, "check_hash": SPEC, "deliverable_hash": DELIVERABLE })
    );
    assert_eq!(
        request["secrets_ref"],
        json!({ "profile": format!("v{id}-{}", &DELIVERABLE[..12]), "account_id": env.secrets_owner.id() })
    );
    assert_eq!(request["response_format"], "Json");
    assert_eq!(request["predecessor"], env.escrow.id().as_str());
    assert_eq!(request["signer"], env.stranger.id().as_str());
    assert_eq!(request["payer_account_id"], env.stranger.id().as_str());
    Ok(())
}

#[tokio::test]
async fn unused_deposit_goes_back_to_the_caller_and_job_money_is_never_touched(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    let escrow_before = near_balance(env.escrow.as_account()).await?;
    let stranger_before = near_balance(&env.stranger).await?;
    behave(&env, "null").await?;
    verify(&env, id).await?.into_result()?;
    // A failed run: OutLayer keeps its charge (the mock's 0.001 NEAR) and returns the rest. The caller
    // also pays gas, at most 0.03 NEAR for 300 Tgas, so anything well under the 0.1 NEAR deposit shows
    // the deposit came back.
    let spent = stranger_before - near_balance(&env.stranger).await?;
    assert!(
        spent < NearToken::from_millinear(50).as_yoctonear(),
        "the caller spent {spent} yoctoNEAR"
    );
    let escrow_after = near_balance(env.escrow.as_account()).await?;
    assert!(
        escrow_after >= escrow_before,
        "the escrow's balance fell by {} yoctoNEAR",
        escrow_before - escrow_after
    );

    // Admission refunds use NEAR's refund_to, independently of OutLayer's payer_account_id.
    let escrow_before = near_balance(env.escrow.as_account()).await?;
    let stranger_before = near_balance(&env.stranger).await?;
    behave(&env, "panic").await?;
    let _ = verify(&env, id).await?;
    assert_eq!(state(&env, id).await?, "Delivered");
    let spent = stranger_before - near_balance(&env.stranger).await?;
    assert!(
        spent < NearToken::from_millinear(50).as_yoctonear(),
        "the admission deposit did not return: {spent}"
    );
    assert!(near_balance(env.escrow.as_account()).await? >= escrow_before);
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
async fn a_run_needs_its_deposit_and_enough_gas() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "pass").await?;
    let args = json!({ "job_id": id });
    assert_refused(
        &call(
            &env,
            &env.stranger,
            "request_verification",
            args.clone(),
            NearToken::from_millinear(99),
        )
        .await?,
        "attach between",
    );
    assert_refused(
        &call(
            &env,
            &env.stranger,
            "request_verification",
            args.clone(),
            NearToken::from_millinear(1_001),
        )
        .await?,
        "attach between",
    );
    let low = env
        .stranger
        .call(env.escrow.id(), "request_verification")
        .args_json(args)
        .deposit(RUN_DEPOSIT)
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
        .stranger
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(RUN_DEPOSIT)
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
        .stranger
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(RUN_DEPOSIT)
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

    let before = near_balance(&env.buyer).await?;
    payout(&env, "expire", id).await?.into_result()?;
    assert_eq!(
        near_balance(&env.buyer).await? - before,
        NearToken::from_near(1).as_yoctonear()
    );
    assert_eq!(state(&env, id).await?, "Expired");
    assert_refused(&verify(&env, id).await?, "job is not awaiting verification");
    Ok(())
}

#[tokio::test]
async fn missed_deadline_refuses_delivery_and_expires_to_the_buyer() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = create_job(&env, false, 60, NearToken::from_near(1).as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    fund_near(&env, id, NearToken::from_near(1))
        .await?
        .into_result()?;
    assert_refused(&payout(&env, "expire", id).await?, "job has not expired");

    let deadline: u64 = job(&env, id).await?["deadline"].as_str().unwrap().parse()?;
    advance_past(&env, deadline).await?;
    assert_refused(
        &deliver(&env, &env.worker, id).await?,
        "the delivery deadline has passed",
    );

    let before = near_balance(&env.buyer).await?;
    payout(&env, "expire", id).await?.into_result()?;
    assert_eq!(
        near_balance(&env.buyer).await? - before,
        NearToken::from_near(1).as_yoctonear()
    );
    assert_eq!(state(&env, id).await?, "Expired");
    Ok(())
}

#[tokio::test]
async fn outsiders_cannot_deliver() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = create_job(&env, false, 3_600, NearToken::from_near(1).as_yoctonear()).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    fund_near(&env, id, NearToken::from_near(1))
        .await?
        .into_result()?;
    assert_refused(
        &deliver(&env, &env.stranger, id).await?,
        "only the job's worker can deliver",
    );
    assert_eq!(state(&env, id).await?, "Funded");
    Ok(())
}

#[tokio::test]
async fn token_job_passes_and_pays_the_worker_in_tokens() -> anyhow::Result<()> {
    let env = setup().await?;
    register(&env.token, &env.buyer, env.worker.id()).await?;
    let id = create_job(&env, true, 3_600, TOKEN_AMOUNT).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;

    // A wrong amount is refused by the escrow and the token contract returns it.
    let buyer_before = token_balance(&env, env.buyer.id()).await?;
    fund_token(&env, id, TOKEN_AMOUNT - 1)
        .await?
        .into_result()?;
    assert_eq!(token_balance(&env, env.buyer.id()).await?, buyer_before);
    assert_eq!(state(&env, id).await?, "Challenged");

    fund_token(&env, id, TOKEN_AMOUNT).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "Funded");
    assert_eq!(token_balance(&env, env.escrow.id()).await?, TOKEN_AMOUNT);

    deliver(&env, &env.worker, id).await?.into_result()?;
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
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
    let id = create_job(&env, true, 3_600, TOKEN_AMOUNT).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    fund_token(&env, id, TOKEN_AMOUNT).await?.into_result()?;
    deliver(&env, &env.worker, id).await?.into_result()?;
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;

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

#[tokio::test]
async fn payouts_at_the_minimum_gas_settle_and_a_failed_token_transfer_still_reverts(
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

    // The worker is not registered with the token, so this transfer fails and the callback reverts.
    let id = create_job(&env, true, 3_600, TOKEN_AMOUNT).await?;
    behave(&env, "strong_check").await?;
    challenge(&env, id).await?.into_result()?;
    fund_token(&env, id, TOKEN_AMOUNT).await?.into_result()?;
    deliver(&env, &env.worker, id).await?.into_result()?;
    behave(&env, "pass").await?;
    verify(&env, id).await?.into_result()?;
    let release = env
        .stranger
        .call(env.escrow.id(), "release")
        .args_json(json!({ "job_id": id }))
        .gas(floor)
        .transact()
        .await?;
    assert!(!release.json::<bool>()?);
    assert_eq!(state(&env, id).await?, "Passed");
    assert_eq!(token_balance(&env, env.escrow.id()).await?, TOKEN_AMOUNT);

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
    let escrow_before = near_balance(env.escrow.as_account()).await?;
    let caller_before = near_balance(&env.stranger).await?;
    verify(&env, id).await?.into_result()?;
    assert_eq!(state(&env, id).await?, "Delivered");
    assert!(near_balance(env.escrow.as_account()).await? >= escrow_before);
    assert!(caller_before - near_balance(&env.stranger).await? >= RUN_DEPOSIT.as_yoctonear());
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
    let before = near_balance(&env.stranger).await?;
    call(
        &env,
        &env.buyer,
        "cancel_stale_outlayer_execution",
        args.clone(),
        NO_DEPOSIT,
    )
    .await?
    .into_result()?;
    assert_eq!(
        near_balance(&env.stranger).await? - before,
        NearToken::from_millinear(99).as_yoctonear()
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
        .stranger
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(RUN_DEPOSIT)
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
    assert_eq!(state(&env, id).await?, "Expired");
    Ok(())
}

#[tokio::test]
async fn the_minimum_trigger_gas_runs_a_bounded_callback() -> anyhow::Result<()> {
    let env = setup().await?;
    let id = delivered_near_job(&env, 3_600).await?;
    behave(&env, "max_size").await?;
    let result = env
        .stranger
        .call(env.escrow.id(), "request_verification")
        .args_json(json!({ "job_id": id }))
        .deposit(RUN_DEPOSIT)
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
