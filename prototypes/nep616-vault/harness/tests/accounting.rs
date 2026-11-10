//! Every yoctoNEAR of the smallest supported payout and refund (0.01 NEAR): the promised amount
//! is kept apart from the vault's storage fund; each write's storage is paid by whoever made it;
//! repeated reconciliation costs only gas; a failed withdrawal leaves everything withdrawable
//! again; the recipient's destination receives exactly the amount.

mod common;
use common::*;
use ed25519_dalek::SigningKey;
use near_workspaces::AccountId;

const AMOUNT: u128 = 10 * MILLI;

/// Runs `call` and adds the escrow's balance change across it to `out`.
async fn tracked(
    env: &Env,
    out: &mut i128,
    call: impl std::future::Future<
        Output = anyhow::Result<near_workspaces::result::ExecutionFinalResult>,
    >,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let before = bal(env, env.escrow.id()).await?;
    let r = call.await?;
    *out += before as i128 - bal(env, env.escrow.id()).await? as i128;
    Ok(r)
}

struct Step {
    label: String,
    fund_delta: u128,
    usage_delta: u64,
    paid_by: &'static str,
}

async fn fund_and_usage(env: &Env, vault: &AccountId) -> anyhow::Result<(u128, u64)> {
    if account(env, vault).await?.is_none() {
        return Ok((0, 0));
    }
    let i = info(env, vault).await?;
    Ok((i.fund, usage(env, vault).await?))
}

async fn case(
    env: &Env,
    key: &SigningKey,
    kind: u8,
    base: u64,
    dest: &AccountId,
) -> anyhow::Result<()> {
    let vault = vault_of(env, key).await?;
    let escrow = env.escrow.id().as_str();
    let mut steps: Vec<Step> = Vec::new();
    let escrow_start = bal(env, env.escrow.id()).await?;
    let mut out: i128 = 0;
    for b in 0..3 {
        reserve(env, base + b, kind, key, AMOUNT)
            .await?
            .into_result()?;
    }
    let escrow_reserved = bal(env, env.escrow.id()).await?;

    // Settlement 1: callbacks working.
    faults(env, false, false, false, 0).await?;
    let (f0, u0) = fund_and_usage(env, &vault).await?;
    let r = tracked(env, &mut out, settle(env, base, kind)).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: settlement 1 of 0.01, callbacks working"),
        &r,
        env.stranger.id(),
    )
    .await?;
    let (f1, u1) = fund_and_usage(env, &vault).await?;
    let excess: u128 = transfers(&rows, vault.as_str(), escrow).iter().sum();
    assert_eq!(
        STORAGE_FEE - excess,
        f1 - f0,
        "the vault kept exactly the fee it needed"
    );
    assert!(
        refund_to(&rows, escrow, INIT_DEPOSIT),
        "StateInit deposit refunded in full"
    );
    steps.push(Step {
        label: "settlement 1 (first record + vault base)".into(),
        fund_delta: f1 - f0,
        usage_delta: u1 - u0,
        paid_by: "escrow",
    });

    // Settlement 2: both callbacks fail; reconciled three times.
    faults(env, true, false, false, 0).await?;
    let r = tracked(env, &mut out, settle(env, base + 1, kind)).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: settlement 2, both callbacks fail"),
        &r,
        env.stranger.id(),
    )
    .await?;
    let (f2, u2) = fund_and_usage(env, &vault).await?;
    let excess: u128 = transfers(&rows, vault.as_str(), escrow).iter().sum();
    assert_eq!(STORAGE_FEE - excess, f2 - f1);
    steps.push(Step {
        label: "settlement 2 (record)".into(),
        fund_delta: f2 - f1,
        usage_delta: u2 - u1,
        paid_by: "escrow",
    });
    for n in 0..3 {
        let r = tracked(
            env,
            &mut out,
            reconcile(env, env.third.as_account(), base + 1, kind, 1),
        )
        .await?;
        let rows = trace(
            env,
            &format!("kind {kind}: reconcile {} of settlement 2", n + 1),
            &r,
            env.third.id(),
        )
        .await?;
        let expected = if n == 0 {
            "deposited"
        } else {
            "ignored:not_in_flight"
        };
        assert_eq!(answer(&r), expected);
        // The seal found the record: nothing grew, the whole fee and the StateInit deposit
        // went back to the reconciler.
        assert!(sent(
            &rows,
            vault.as_str(),
            env.third.id().as_str(),
            STORAGE_FEE
        ));
        assert!(refund_to(&rows, env.third.id().as_str(), INIT_DEPOSIT));
    }
    let (f3, u3) = fund_and_usage(env, &vault).await?;
    assert_eq!((f3, u3), (f2, u2), "repeated reconciliation stores nothing");

    // Settlement 3: funding fails with both callbacks off; the seal creates the record, paid by
    // the reconciler; a second reconcile is free; attempt 2 updates the record in place.
    faults(env, true, true, false, 0).await?;
    let r = tracked(env, &mut out, settle(env, base + 2, kind)).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: settlement 3 attempt 1, funding fails"),
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(refund_to(
        &rows,
        escrow,
        AMOUNT + STORAGE_FEE + INIT_DEPOSIT
    ));
    let r = tracked(
        env,
        &mut out,
        reconcile(env, env.third.as_account(), base + 2, kind, 1),
    )
    .await?;
    let rows = trace(
        env,
        &format!("kind {kind}: reconcile seals settlement 3 attempt 1"),
        &r,
        env.third.id(),
    )
    .await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    let (f4, u4) = fund_and_usage(env, &vault).await?;
    let back: u128 = transfers(&rows, vault.as_str(), env.third.id().as_str())
        .iter()
        .sum();
    assert_eq!(STORAGE_FEE - back, f4 - f3);
    steps.push(Step {
        label: "seal of settlement 3 (record)".into(),
        fund_delta: f4 - f3,
        usage_delta: u4 - u3,
        paid_by: "reconciler",
    });
    let r = tracked(
        env,
        &mut out,
        reconcile(env, env.third.as_account(), base + 2, kind, 1),
    )
    .await?;
    assert_eq!(answer(&r), "ignored:not_in_flight");
    faults(env, true, false, false, 0).await?;
    let r = tracked(env, &mut out, settle(env, base + 2, kind)).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: settlement 3 attempt 2"),
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(
        sent(&rows, vault.as_str(), escrow, STORAGE_FEE),
        "record updated in place: whole fee back"
    );
    let r = tracked(
        env,
        &mut out,
        reconcile(env, env.third.as_account(), base + 2, kind, 2),
    )
    .await?;
    assert_eq!(answer(&r), "deposited");
    let (f5, u5) = fund_and_usage(env, &vault).await?;
    assert_eq!((f5, u5), (f4, u4));
    assert_eq!(held(env).await?, 0);

    // The vault's ledger.
    let mut principal = 0;
    for b in 0..3 {
        let (deposited, _, amount, _) = slot(env, &vault, env.escrow.id(), base + b, kind).await?;
        assert!(deposited);
        principal += amount;
    }
    assert_eq!(principal, 3 * AMOUNT);
    let balance = bal(env, &vault).await?;
    let i = info(env, &vault).await?;
    assert_eq!(
        i.fund,
        u128::from(u5) * BYTE_COST,
        "the fund is exactly the storage cost"
    );
    assert_eq!(i.available, balance - i.fund);
    let rewards = i.available - principal;
    println!("  kind {kind} vault ledger: balance {} = principal {} + storage fund {} ({} bytes) + gas rewards {}", near(balance), near(principal), near(i.fund), u5, near(rewards));
    assert!(rewards < MILLI);
    for s in &steps {
        println!(
            "    {:<44} +{} bytes  +{} NEAR fund, paid by {}",
            s.label,
            s.usage_delta,
            near(s.fund_delta),
            s.paid_by
        );
    }
    let escrow_cost = out as u128;
    let escrow_fees = steps
        .iter()
        .filter(|s| s.paid_by == "escrow")
        .map(|s| s.fund_delta)
        .sum::<u128>();
    let other = escrow_cost as i128 - (principal + escrow_fees) as i128;
    println!(
        "  escrow: reserved +{}, paid out {} = amounts {} + record storage {} + other {other} yocto",
        near(escrow_reserved - escrow_start),
        near(escrow_cost),
        near(principal),
        near(escrow_fees),
    );
    assert_eq!(
        other, 0,
        "the escrow paid exactly the amounts and its records' storage"
    );

    // A withdrawal to an account that does not exist fails; everything comes back.
    let ghost: AccountId = format!("ghost{kind}.{}", env.root.id()).parse()?;
    let r = signed_withdraw(env, key, &vault, &ghost, principal, i.next).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: withdrawal of 0.03 to a missing account"),
        &r,
        env.relayer.id(),
    )
    .await?;
    assert!(failed_with(&rows, ghost.as_str(), "AccountDoesNotExist"));
    assert!(refund_to(&rows, vault.as_str(), principal));
    let again = info(env, &vault).await?;
    assert!(again.available >= i.available && again.available - i.available < MILLI);
    assert_eq!((again.fund, again.next), (i.fund, i.next + 1));
    println!(
        "  withdrawable before {} after the failed withdrawal {} (its gas reward added)",
        near(i.available),
        near(again.available)
    );

    // The exact amount reaches the destination; the relayer paid the gas.
    let before = bal(env, dest).await?;
    let relayer_before = bal(env, env.relayer.id()).await?;
    let r = signed_withdraw(env, key, &vault, dest, principal, again.next).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: withdrawal of exactly 0.03 to {dest}"),
        &r,
        env.relayer.id(),
    )
    .await?;
    assert!(sent(&rows, vault.as_str(), dest.as_str(), principal));
    let received = bal(env, dest).await? - before;
    assert_eq!(
        received, principal,
        "exactly the promised amount, to the yoctoNEAR"
    );
    let after = info(env, &vault).await?;
    assert_eq!(after.fund, i.fund);
    assert_eq!(bal(env, &vault).await?, after.fund + after.available);
    println!(
        "  {dest} received {} exactly; relayer paid {} gas; vault keeps fund {} + rewards {}",
        near(received),
        near(relayer_before - bal(env, env.relayer.id()).await?),
        near(after.fund),
        near(after.available)
    );
    Ok(())
}

#[tokio::test]
async fn the_smallest_payout_and_refund_arrive_exactly_after_many_records_and_reconciles(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let payee: AccountId = env.contrib.id().clone();
    case(&env, &env.contrib_key, PAYOUT, 10, &payee).await?;
    let maint = env.maint.id().clone();
    case(&env, &env.maint_key, REFUND, 20, &maint).await?;
    Ok(())
}
