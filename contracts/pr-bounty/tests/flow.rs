//! Sandbox tests of the one-key PR bounty flow with real WASM, real receipts and exact balances.
//! Build first (see tests/common/mod.rs). Run with
//! `cargo test --offline --test flow -- --test-threads 1`.
//! Release-build tests use `RELEASE_WASM`; the ones that need short claim, relink or refund-cap
//! times use the `test-faults` build (`FAULT_WASM`: relink delay 6 s, refund cap 30 s, shortest
//! claim 4 s). The OutLayer mock keeps 0.001 NEAR per run; that is not a real OutLayer charge.
mod common;
use common::*;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use serde_json::json;

#[tokio::test]
async fn full_payout_one_wallet_each_with_exact_balances() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    env.note(format!(
        "vault code {} bytes, sha256 {}; global publication cost {} NEAR",
        env.vault_bytes,
        hex(&env.code_hash),
        near(env.publication_cost)
    ));
    let mvault = vault_of(&env, &env.maint_key).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    assert_ne!(mvault, cvault);
    let ledger = Ledger::new(&env, &[mvault.clone(), cvault.clone()]).await?;

    // Post: the contract receives exactly the reward and the storage deposit.
    let contract0 = bal(&env, env.bounty.id()).await?;
    let maint0 = bal(&env, env.maint.id()).await?;
    let posted = post_result(&env, 1, Timing::RELEASE, &env.maint_key.clone()).await?;
    assert!(posted.is_success(), "{:?}", posted.failures());
    let id: u64 = posted.clone().json()?;
    let (_, burnt) = gas_burnt_total(&posted);
    let contract1 = bal(&env, env.bounty.id()).await?;
    let maint1 = bal(&env, env.maint.id()).await?;
    env.note(format!(
        "post: contract +{} yocto (attached {}); maintainer -{} yocto (attached + burnt {})",
        contract1 - contract0,
        REWARD + env.storage,
        maint0 - maint1,
        burnt
    ));
    assert_eq!(
        maint0 - maint1,
        REWARD + env.storage + burnt,
        "the maintainer paid the reward, the storage deposit and gas, nothing else"
    );
    assert_eq!(
        contract1 - contract0,
        REWARD + env.storage,
        "the contract received exactly the reward and the storage deposit"
    );
    let b = get_bounty(&env, id).await?;
    assert_eq!(b["maintainer_vault"].as_str(), Some(mvault.as_str()));
    assert_eq!(
        b["maintainer_key"].as_str(),
        Some(public(&env.maint_key).as_str())
    );
    assert_eq!(b["status"], "Open");
    assert_eq!(held(&env).await?, (REWARD, 0));
    assert!(slack(&env).await? >= 0);

    // Link: the mock OutLayer returns the verifier's own answer for the wallet's gist.
    let contrib0 = bal(&env, env.contrib.id()).await?;
    let contract_before_link = bal(&env, env.bounty.id()).await?;
    let bytes_before_link = storage(&env, env.bounty.id()).await?;
    let l = link(&env, &env.contrib, GH).await?;
    assert_eq!(answer(&l), "linked");
    let (_, burnt) = gas_burnt_total(&l);
    let req = last_request(&env).await?;
    assert_eq!(req["payer_account_id"], env.contrib.id().as_str());
    assert_eq!(req["refund_to"], env.contrib.id().as_str());
    assert_eq!(req["deposit"], RUN.to_string());
    assert_eq!(
        contrib0 - bal(&env, env.contrib.id()).await?,
        MOCK_CHARGE + LINK_STORAGE + burnt,
        "link cost the wallet the mock's charge, the link storage deposit and gas; the rest of the run deposit came back"
    );
    assert_eq!(
        bal(&env, env.bounty.id()).await? - contract_before_link,
        LINK_STORAGE,
        "a recorded link keeps exactly the 0.007 NEAR storage deposit in the contract"
    );
    let link_bytes = u128::from(storage(&env, env.bounty.id()).await? - bytes_before_link);
    assert!(
        link_bytes * BYTE <= LINK_STORAGE,
        "the link record ({link_bytes} bytes) is paid by its deposit"
    );
    let input: serde_json::Value = serde_json::from_str(req["input_data"].as_str().unwrap())?;
    assert_eq!(
        (input["op"].as_str(), input["bounty"].as_u64()),
        (Some("gist"), Some(0))
    );
    assert_eq!(
        github_owner(&env, GH).await?.as_deref(),
        Some(env.contrib.id().as_str())
    );
    let lk = get_link(&env, env.contrib.id()).await?;
    assert_eq!(lk["active"]["github_id"], GH.to_string());
    assert!(lk["pending"].is_null());

    // Claim with the payout key's proof; the vault address is fixed from that key.
    let c = claim(&env, &env.contrib, id, &env.contrib_key.clone()).await?;
    assert!(c.is_success(), "{:?}", c.failures());
    let b = get_bounty(&env, id).await?;
    assert_eq!(b["status"], "Claimed");
    assert_eq!(b["claim"]["vault"].as_str(), Some(cvault.as_str()));
    assert_eq!(
        b["claim"]["key"].as_str(),
        Some(public(&env.contrib_key).as_str())
    );
    assert_eq!(b["claim"]["github_id"], GH.to_string());
    assert_eq!(
        b["claim"]["wallet"].as_str(),
        Some(env.contrib.id().as_str())
    );

    // Submit: one run reads the pull request and the wallet's link gist.
    let pull = PullSpec::open(&env, GH);
    let s = submit(&env, &env.contrib, id, &pull).await?;
    assert_eq!(answer(&s), "bound");
    let req = last_request(&env).await?;
    let input: serde_json::Value = serde_json::from_str(req["input_data"].as_str().unwrap())?;
    assert_eq!(
        (input["op"].as_str(), input["number"].as_u64()),
        (Some("pull"), Some(PR))
    );
    assert_eq!(
        input["gist_id"], lk["active"]["gist_id"],
        "the same run reads the link gist"
    );
    assert_eq!(input["challenge"], lk["active"]["challenge"]);
    let b = get_bounty(&env, id).await?;
    assert_eq!(b["status"], "Bound");
    assert_eq!(b["binding"]["author_id"], GH.to_string());
    assert_eq!(b["binding"]["pr_id"], PR_ID.to_string());
    assert_eq!(
        b["binding"]["wallet"].as_str(),
        Some(env.contrib.id().as_str())
    );
    assert_eq!(
        env.bounty
            .view("bound_pr")
            .args_json(json!({"pr_id": PR_ID.to_string()}))
            .await?
            .json::<Option<u64>>()?,
        Some(id)
    );
    assert_closed(&env, &ledger, "bound").await?;

    // Merged on time: a stranger's check pays. The vault receives exactly the reward.
    let contract2 = bal(&env, env.bounty.id()).await?;
    let stranger0 = bal(&env, env.stranger.id()).await?;
    let paid = merged_check(&env, id, &pull, false).await?;
    let (_, burnt) = gas_burnt_total(&paid);
    let rows = trace(&env, "check_merge pays", &paid, env.stranger.id()).await?;
    let req = last_request(&env).await?;
    assert_eq!(req["payer_account_id"], env.stranger.id().as_str());
    assert_eq!(
        stranger0 - bal(&env, env.stranger.id()).await?,
        MOCK_CHARGE + burnt,
        "the checker paid the mock's charge and gas"
    );
    assert!(rows.iter().any(|(_, to, a, f)| to == cvault.as_str()
        && a.contains("DeterministicStateInit")
        && a.contains("FunctionCall deposit")
        && f.is_none()));
    let b = get_bounty(&env, id).await?;
    assert_eq!(b["status"], "Paid");
    assert_eq!(
        b["merge"]["merged_at"],
        (b["merge_deadline"].as_str().unwrap().parse::<u64>()? - 1).to_string()
    );
    let s = settlement(&env, id, "Payout").await?;
    assert_eq!(
        (
            s["state"].as_str(),
            s["attempt"].as_u64(),
            s["done_by"].as_str(),
            s["principal"].as_str()
        ),
        (
            Some("Done"),
            Some(1),
            Some("callback"),
            Some(REWARD.to_string().as_str())
        )
    );
    assert!(
        settlement(&env, id, "Refund").await?.is_null(),
        "no refund of a paid bounty"
    );
    assert_eq!(
        held(&env).await?,
        (0, 0),
        "the vault receipt released the reward from held"
    );
    let i = info(&env, &cvault).await?;
    let bytes = storage(&env, &cvault).await?;
    assert_eq!(i.available, REWARD, "the vault holds exactly the reward");
    assert_eq!(
        i.fund,
        u128::from(bytes) * BYTE,
        "the fund is the vault's storage"
    );
    assert_eq!(
        bal(&env, &cvault).await?,
        REWARD + i.fund,
        "nothing else in the vault"
    );
    assert_eq!(
        (i.n, i.key),
        (0, {
            let mut k = vec![0u8];
            k.extend(env.contrib_key.verifying_key().to_bytes());
            k
        })
    );
    let rec = record(&env, &cvault, id, 0).await?;
    assert_eq!((rec.deposited, rec.attempt, rec.amount), (true, 1, REWARD));
    assert_eq!(
        bal(&env, &mvault).await?,
        0,
        "the maintainer vault is untouched"
    );
    // The contract kept only the storage deposit less the vault fund and its own bytes.
    let contract3 = bal(&env, env.bounty.id()).await?;
    env.note(format!(
        "contract balance: after post {contract1}; after binding {contract2}; after payout {contract3} (reward left {}, vault fund kept {})",
        near(REWARD), near(i.fund)
    ));
    assert_eq!(
        contract2 - contract3,
        REWARD + i.fund,
        "the contract sent out exactly the reward plus the vault's storage fund"
    );
    assert_closed(&env, &ledger, "paid").await?;
    assert!(
        slack(&env).await? >= 0,
        "no principal or float paid for storage"
    );

    // The contributor withdraws with a NEP-413 signature by the payout key, to a destination of
    // their choice. The relayer pays the gas.
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "withdraw to payee",
    )
    .await?;
    let i = info(&env, &cvault).await?;
    assert_eq!((i.available, i.n), (0, 1));
    assert_eq!(
        bal(&env, &cvault).await?,
        i.fund,
        "only the storage fund is left"
    );
    assert_closed(&env, &ledger, "withdrawn").await?;
    env.save_trace("flow-full-payout")?;
    Ok(())
}

// ---- Helpers ----

fn secs(v: &serde_json::Value) -> u64 {
    v.as_str().expect("a U64 string").parse().expect("a number")
}

async fn merge_deadline(env: &Env, id: u64) -> anyhow::Result<u64> {
    Ok(secs(&get_bounty(env, id).await?["merge_deadline"]))
}

/// Posts a bounty, links the contributor (once), claims with the contributor's own key and
/// binds `pull` (the open pull request authored by GH).
async fn bind(env: &Env, issue: u64, t: Timing) -> anyhow::Result<(u64, PullSpec)> {
    let id = post(env, issue, t).await?;
    let pull = PullSpec::open(env, GH);
    claim_and_bind(env, &env.contrib, &env.contrib_key.clone(), GH, id, &pull).await?;
    Ok((id, pull))
}

fn status(b: &serde_json::Value) -> &str {
    b["status"].as_str().unwrap_or("?")
}

/// The settlement is Done in the contract and the vault's record agrees.
async fn assert_settled(
    env: &Env,
    id: u64,
    kind: &str,
    vault: &near_workspaces::AccountId,
    principal: u128,
) -> anyhow::Result<()> {
    let s = settlement(env, id, kind).await?;
    assert_eq!(s["state"], "Done", "{kind}: {s}");
    assert_eq!(s["principal"], principal.to_string());
    let rec = record(env, vault, id, if kind == "Payout" { 0 } else { 1 }).await?;
    assert!(
        rec.deposited && rec.amount == principal,
        "{kind}: the vault's own record shows the deposit"
    );
    Ok(())
}

// ---- The refund path ----

#[tokio::test]
async fn no_merge_refunds_the_maintainer_vault_after_the_window_and_a_definite_look(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let ledger = Ledger::new(&env, &[mvault.clone(), cvault.clone()]).await?;
    let (id, pull) = bind(&env, 1, Timing::FAULT).await?;
    let m = merge_deadline(&env, id).await?;
    // Too early: the claim is bound and the window is open.
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    // The deadline passes and GitHub still shows the pull request open: a definite look taken
    // at least a minute after the deadline (an earlier one does not count).
    wait_past(&env, m + 60).await?;
    let r = check(&env, &env.stranger, id, &pull, RUN).await?;
    assert_eq!(answer(&r), "pending", "{:?}", r.failures());
    let b = get_bounty(&env, id).await?;
    assert!(secs(&b["definite_look"]["requested_at"]) >= (m + 60) * 1_000_000_000);
    assert_eq!(status(&b), "Bound");
    // Still inside the checking window (deadline + 10 minutes grace): no refund.
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    assert_eq!(held(&env).await?, (REWARD, 0));
    wait_past(&env, m + 599).await?;
    let r = settle_call(&env, &env.stranger, id).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let at = exec_ns(&env, &r).await?;
    let hard = (m + 600 + cap_secs(&env).await?) * 1_000_000_000;
    env.note(format!(
        "  refund opened {} ms before the cap would have",
        (hard - at.min(hard)) / 1_000_000
    ));
    assert!(
        at < hard,
        "settled before the cap: it was the definite look that opened the refund"
    );
    let rows = trace(
        &env,
        "settle refunds into the maintainer vault",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert!(rows.iter().any(|(_, to, a, f)| to == mvault.as_str()
        && a.contains("DeterministicStateInit")
        && f.is_none()));
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Refunded");
    assert!(b["payout"].is_null());
    assert_settled(&env, id, "Refund", &mvault, REWARD).await?;
    assert_eq!(held(&env).await?, (0, 0));
    let i = info(&env, &mvault).await?;
    assert_eq!(i.available, REWARD, "the vault holds exactly the reward");
    assert_eq!(i.fund, u128::from(storage(&env, &mvault).await?) * BYTE);
    assert_eq!(bal(&env, &cvault).await?, 0, "no payout vault was created");
    assert_closed(&env, &ledger, "refunded").await?;
    // The refund is final: a merge check is refused, and so is a second refund.
    assert_refused(
        &check(&env, &env.stranger, id, &pull.clone().merged(m - 1), RUN).await?,
        "no submitted pull request",
    );
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    // The maintainer withdraws to their own account; the relayer pays gas, so the delta is exact.
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "maintainer withdraws the refund",
    )
    .await?;
    assert_closed(&env, &ledger, "withdrawn").await?;
    env.save_trace("flow-refund-after-definite-look")?;
    Ok(())
}

#[tokio::test]
async fn a_cancelled_open_bounty_refunds_at_once_and_the_maintainer_withdraws() -> anyhow::Result<()>
{
    let env = setup_with(RELEASE_WASM).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[mvault.clone()]).await?;
    let id = post(&env, 2, Timing::RELEASE).await?;
    assert_refused(
        &cancel_by(&env, &env.stranger, id).await?,
        "only the maintainer can cancel",
    );
    let r = cancel_bounty(&env, id).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    trace(&env, "cancel refunds the open bounty", &r, env.maint.id()).await?;
    assert_eq!(status(&get_bounty(&env, id).await?), "Cancelled");
    assert_settled(&env, id, "Refund", &mvault, REWARD).await?;
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(info(&env, &mvault).await?.available, REWARD);
    assert_refused(
        &cancel_bounty(&env, id).await?,
        "only a bounty with no claim can be cancelled",
    );
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "withdraw the cancelled bounty",
    )
    .await?;
    assert_closed(&env, &ledger, "cancelled and withdrawn").await?;
    env.save_trace("flow-cancel-refund")?;
    Ok(())
}

async fn cancel_by(
    env: &Env,
    who: &near_workspaces::Account,
    id: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    call(who, env, "cancel", json!({"bounty_id": id}), 0).await
}

// ---- A wallet whose transaction key is not its withdrawal key ----

#[tokio::test]
async fn the_withdrawal_key_may_differ_from_the_key_that_signs_transactions() -> anyhow::Result<()>
{
    let env = setup_with(RELEASE_WASM).await?;
    // Each wallet gets a second full-access key for its transactions; the withdrawal keys are
    // fresh keys that are not access keys of any account.
    let (maint_tx_key, contrib_tx_key) = (signing(12), signing(22));
    let (maint_w, contrib_w) = (signing(13), signing(23));
    env.add_access_key(&env.maint, &maint_tx_key).await?;
    env.add_access_key(&env.contrib, &contrib_tx_key).await?;
    let maint_tx = env.signing_as(&env.maint, &maint_tx_key);
    let contrib_tx = env.signing_as(&env.contrib, &contrib_tx_key);
    let mvault = vault_of(&env, &maint_w).await?;
    let cvault = vault_of(&env, &contrib_w).await?;
    assert_ne!(mvault, vault_of(&env, &env.maint_key).await?);
    assert_ne!(cvault, vault_of(&env, &env.contrib_key).await?);
    let ledger = Ledger::new(&env, &[mvault.clone(), cvault.clone()]).await?;

    // A posting whose proof is signed by the account's own key, not the named withdrawal key,
    // is refused with nothing locked.
    let now = now_secs(&env).await?;
    let t = terms(&env, 1, now, Timing::RELEASE);
    let wrong = posting_proof(
        &env,
        &t,
        &env.maint_key,
        env.maint.id(),
        &env.next_nonce(),
        now + 1800,
    )
    .await?;
    let before = bal(&env, env.bounty.id()).await?;
    let r = try_post_as(&env, &maint_tx, t.clone(), &maint_w, wrong, None).await?;
    assert_refused(&r, "the withdrawal key's proof does not match");
    assert_eq!(
        bal(&env, env.bounty.id()).await?,
        before,
        "nothing was locked"
    );
    assert_eq!(held(&env).await?, (0, 0));
    // The right proof, sent through the second access key, is accepted.
    let proof = posting_proof(
        &env,
        &t,
        &maint_w,
        env.maint.id(),
        &env.next_nonce(),
        now + 1800,
    )
    .await?;
    let r = try_post_as(&env, &maint_tx, t, &maint_w, proof, None).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let id: u64 = r.json()?;
    let b = get_bounty(&env, id).await?;
    assert_eq!(b["buyer"].as_str(), Some(env.maint.id().as_str()));
    assert_eq!(
        b["maintainer_key"].as_str(),
        Some(public(&maint_w).as_str())
    );
    assert_eq!(b["maintainer_vault"].as_str(), Some(mvault.as_str()));

    // Linking and claiming through the second access key. A claim proof signed by another key
    // than the one passed is refused; so is one naming a different payout key.
    let l = link(&env, &contrib_tx, GH).await?;
    assert_eq!(answer(&l), "linked", "{:?}", l.failures());
    let r = claim_as(&env, &contrib_tx, id, &contrib_w, &env.contrib_key).await?;
    assert_refused(&r, "the withdrawal key's proof does not match");
    let r = claim_as(&env, &contrib_tx, id, &contrib_w, &contrib_tx_key).await?;
    assert_refused(&r, "the withdrawal key's proof does not match");
    let r = claim_as(&env, &contrib_tx, id, &env.contrib_key, &contrib_w).await?;
    assert_refused(&r, "the withdrawal key's proof does not match");
    assert_eq!(status(&get_bounty(&env, id).await?), "Open");
    let r = claim_as(&env, &contrib_tx, id, &contrib_w, &contrib_w).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let b = get_bounty(&env, id).await?;
    assert_eq!(b["claim"]["vault"].as_str(), Some(cvault.as_str()));
    assert_eq!(
        b["claim"]["key"].as_str(),
        Some(public(&contrib_w).as_str())
    );
    let pull = PullSpec::open(&env, GH);
    let s = submit(&env, &contrib_tx, id, &pull).await?;
    assert_eq!(answer(&s), "bound", "{:?}", s.failures());
    let paid = merged_check(&env, id, &pull, false).await?;
    trace(
        &env,
        "payout to the vault of a key that signs no transaction",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(info(&env, &cvault).await?.available, REWARD);
    assert_eq!(
        bal(&env, &vault_of(&env, &env.contrib_key).await?).await?,
        0
    );

    // Only the withdrawal key moves the money: the account's own keys cannot.
    let now = now_secs(&env).await?;
    for (label, key) in [
        ("the account's first key", &env.contrib_key),
        ("the second access key", &contrib_tx_key),
    ] {
        let args = withdrawal(
            key,
            &env.chain,
            cvault.as_str(),
            env.payee.id().as_str(),
            REWARD,
            0,
            now + 600,
        );
        let r = submit_withdrawal(&env, &env.contrib, &cvault, args).await?;
        assert_refused(&r, "bad signature");
        assert_eq!(info(&env, &cvault).await?.available, REWARD, "{label}");
    }
    withdraw_exact(
        &env,
        &contrib_w,
        &cvault,
        env.payee.id(),
        REWARD,
        "withdrawal by the payout key",
    )
    .await?;

    // A refund goes to the maintainer's withdrawal key too.
    let id2 = post_with_tx(&env, &maint_tx, &maint_w, 2).await?;
    let r = call(&maint_tx, &env, "cancel", json!({"bounty_id": id2}), 0).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(info(&env, &mvault).await?.available, REWARD);
    let r = withdraw(&env, &env.maint_key, &mvault, env.maint.id(), REWARD).await?;
    assert_refused(&r, "bad signature");
    withdraw_exact(
        &env,
        &maint_w,
        &mvault,
        env.maint.id(),
        REWARD,
        "refund withdrawn by the maintainer's withdrawal key",
    )
    .await?;
    assert_closed(&env, &ledger, "two-key wallets").await?;
    env.save_trace("flow-transaction-key-differs")?;
    Ok(())
}

async fn post_with_tx(
    env: &Env,
    tx: &near_workspaces::Account,
    key: &ed25519_dalek::SigningKey,
    issue: u64,
) -> anyhow::Result<u64> {
    let now = now_secs(env).await?;
    let t = terms(env, issue, now, Timing::RELEASE);
    let proof = posting_proof(env, &t, key, tx.id(), &env.next_nonce(), now + 1800).await?;
    let r = try_post_as(env, tx, t, key, proof, None).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    Ok(r.json()?)
}

// ---- A recipient account that is deleted and registered again ----

#[tokio::test]
async fn a_recreated_recipient_account_cannot_touch_the_payout_vault() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let (id, pull) = bind(&env, 3, Timing::RELEASE).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    // The contributor's wallet is deleted and its name registered again by a stranger.
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
    let paid = merged_check(&env, id, &pull, false).await?;
    let rows = trace(
        &env,
        "payout after the contributor's name was registered again",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert!(rows.iter().all(|(_, to, _, _)| to != usurper.id().as_str()));
    assert_eq!(
        bal(&env, usurper.id()).await?,
        before,
        "the name received nothing"
    );
    assert_eq!(info(&env, &cvault).await?.available, REWARD);
    assert_eq!(bal(&env, &mvault).await?, 0);
    // The new owner's keys and a guessed key cannot withdraw; the old key's holder can, anywhere.
    for seed in [99u8, 1] {
        let fake = signing(seed);
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
            &submit_withdrawal(&env, &usurper, &cvault, args).await?,
            "bad signature",
        );
    }
    // The refused attempts cost the usurper only gas; the holder chooses the payee.
    let before = bal(&env, usurper.id()).await?;
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "the real key holder withdraws elsewhere",
    )
    .await?;
    assert_eq!(bal(&env, usurper.id()).await?, before);
    env.save_trace("flow-recreated-recipient")?;
    Ok(())
}

// ---- Withdrawals: faults, a failed transfer, overlapping numbers ----

#[tokio::test]
async fn withdrawal_faults_a_failed_transfer_and_overlapping_numbers() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let (id, pull) = bind(&env, 4, Timing::RELEASE).await?;
    let paid = merged_check(&env, id, &pull, false).await?;
    assert!(paid.is_success());
    let vault = vault_of(&env, &env.contrib_key).await?;
    let ledger = Ledger::new(&env, &[vault.clone()]).await?;
    let i = info(&env, &vault).await?;
    assert_eq!((i.available, i.n), (REWARD, 0));
    let (k, other) = (&env.contrib_key, &env.maint_key);
    let (to, v) = (env.payee.id().as_str(), vault.as_str());
    let now = now_secs(&env).await?;
    let mut faults: Vec<(&str, String, &str)> = vec![
        (
            "another key",
            withdrawal(other, &env.chain, v, to, REWARD, 0, now + 600),
            "bad signature",
        ),
        (
            "another chain",
            withdrawal(k, "mainnet", v, to, REWARD, 0, now + 600),
            "bad signature",
        ),
        (
            "another vault",
            withdrawal(
                k,
                &env.chain,
                "0s0000000000000000000000000000000000000000",
                to,
                REWARD,
                0,
                now + 600,
            ),
            "bad signature",
        ),
        (
            "future number",
            withdrawal(k, &env.chain, v, to, REWARD, 1, now + 600),
            "wrong withdrawal number",
        ),
        (
            "expired",
            withdrawal(k, &env.chain, v, to, REWARD, 0, now - 1),
            "withdrawal deadline passed",
        ),
        (
            "too far ahead",
            withdrawal(k, &env.chain, v, to, REWARD, 0, now + 3_600),
            "deadline too far ahead",
        ),
        (
            "zero amount",
            withdrawal(k, &env.chain, v, to, 0, 0, now + 600),
            "more than the vault can pay",
        ),
        (
            "above balance",
            withdrawal(k, &env.chain, v, to, REWARD + 1, 0, now + 600),
            "more than the vault can pay",
        ),
        (
            "to the vault itself",
            withdrawal(k, &env.chain, v, v, REWARD, 0, now + 600),
            "bad destination",
        ),
        (
            "malformed",
            r#"{"to":"payee.test.near"}"#.to_string(),
            "bad arguments",
        ),
    ];
    let signed = withdrawal(k, &env.chain, v, to, REWARD, 0, now + 600);
    faults.push((
        "destination substituted",
        signed.replace(to, env.stranger.id().as_str()),
        "bad signature",
    ));
    faults.push((
        "amount substituted",
        signed.replace(
            &format!(r#""amount":"{REWARD}""#),
            &format!(r#""amount":"{}""#, REWARD / 2),
        ),
        "bad signature",
    ));
    for (label, args, expected) in faults {
        let r = submit_withdrawal(&env, &env.stranger, &vault, args).await?;
        assert_refused(&r, expected);
        let after = info(&env, &vault).await?;
        assert_eq!(
            (after.available, after.n, after.fund),
            (i.available, 0, i.fund),
            "{label}"
        );
        env.note(format!("  refused: {label} ({expected})"));
    }

    // A destination that does not exist: the transfer fails, the amount returns to the vault in
    // full, and the number is used.
    let ghost: near_workspaces::AccountId = format!("ghost.{}", env.root.id()).parse()?;
    let w = withdraw(&env, k, &vault, &ghost, REWARD).await?;
    let rows = trace(
        &env,
        "withdrawal to a missing account",
        &w,
        env.relayer.id(),
    )
    .await?;
    assert!(failed_with(&rows, ghost.as_str(), "AccountDoesNotExist"));
    assert!(
        sent(&rows, "system", vault.as_str(), REWARD),
        "the whole amount came back to the vault"
    );
    let again = info(&env, &vault).await?;
    assert_eq!(
        (again.available, again.n, again.fund),
        (REWARD, 1, i.fund),
        "everything is withdrawable again; number 0 is used"
    );
    assert_eq!(bal(&env, &ghost).await?, 0);
    let replay = withdrawal(k, &env.chain, v, to, REWARD, 0, now_secs(&env).await? + 600);
    assert_refused(
        &submit_withdrawal(&env, &env.stranger, &vault, replay).await?,
        "wrong withdrawal number",
    );
    assert_closed(&env, &ledger, "failed transfer").await?;

    // Two withdrawals signed for the same number, submitted together: one pays, the other is
    // refused, and the vault is down by exactly one amount.
    let half = REWARD / 2;
    let deadline = now_secs(&env).await? + 600;
    let a = withdrawal(k, &env.chain, v, to, half, 1, deadline);
    let b = withdrawal(
        k,
        &env.chain,
        v,
        env.stranger.id().as_str(),
        half,
        1,
        deadline,
    );
    let submit_async = |who: &near_workspaces::Account, args: String| {
        who.call(&vault, "withdraw")
            .args(args.into_bytes())
            .gas(Gas::from_tgas(30))
            .transact_async()
    };
    let (payee0, stranger0) = (
        bal(&env, env.payee.id()).await?,
        bal(&env, env.stranger.id()).await?,
    );
    let (ta, tb) = (
        submit_async(&env.relayer, a).await?,
        submit_async(&env.rival, b).await?,
    );
    let (ra, rb) = (ta.await?, tb.await?);
    env.tally(&ra);
    env.tally(&rb);
    trace(
        &env,
        "overlapping withdrawal A (to payee)",
        &ra,
        env.relayer.id(),
    )
    .await?;
    trace(
        &env,
        "overlapping withdrawal B (to stranger)",
        &rb,
        env.rival.id(),
    )
    .await?;
    let wins = [ra.is_success(), rb.is_success()];
    assert_eq!(
        wins.iter().filter(|w| **w).count(),
        1,
        "exactly one pays: {wins:?}"
    );
    let loser = if ra.is_success() { &rb } else { &ra };
    assert_refused(loser, "wrong withdrawal number");
    let end = info(&env, &vault).await?;
    assert_eq!((end.available, end.n), (REWARD - half, 2));
    let gained = (bal(&env, env.payee.id()).await? - payee0)
        + (bal(&env, env.stranger.id()).await? - stranger0);
    // The stranger paid no gas in this step, so the two recipients together gained one half.
    assert_eq!(gained, half, "exactly one half was delivered in total");
    // The rest goes out at number 2.
    withdraw_exact(
        &env,
        k,
        &vault,
        env.payee.id(),
        REWARD - half,
        "the rest at number 2",
    )
    .await?;
    assert_closed(&env, &ledger, "overlap").await?;
    env.save_trace("flow-withdrawal-faults")?;
    Ok(())
}

// ---- Claims: a race, expiry, release, revoke, barred wallets ----

#[tokio::test]
async fn two_wallets_claim_in_one_block_and_exactly_one_wins_then_expiry_and_the_bar(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let id = post(&env, 5, Timing::SHORT_CLAIM).await?;
    link_ok(&env, &env.contrib, GH).await?;
    link_ok(&env, &env.rival, GH2).await?;
    // A wallet without a link, and a claim after nobody holds it: refused first.
    let args = claim_args(
        &env,
        env.contrib.id(),
        id,
        &env.contrib_key,
        &env.contrib_key,
    )
    .await?;
    let stranger_args =
        json!({"bounty_id": id, "key": public(&env.contrib_key), "proof": args["proof"]});
    assert_refused(
        &call(&env.stranger, &env, "claim", stranger_args, CLAIM_FEE).await?,
        "connect a GitHub account to this wallet first",
    );
    // The race.
    let a = claim_args(
        &env,
        env.contrib.id(),
        id,
        &env.contrib_key,
        &env.contrib_key,
    )
    .await?;
    let b = claim_args(&env, env.rival.id(), id, &env.rival_key, &env.rival_key).await?;
    let go = |who: &near_workspaces::Account, args: serde_json::Value| {
        who.call(env.bounty.id(), "claim")
            .args_json(args)
            .deposit(NearToken::from_yoctonear(CLAIM_FEE))
            .gas(Gas::from_tgas(300))
            .transact_async()
    };
    let (ta, tb) = (go(&env.contrib, a).await?, go(&env.rival, b).await?);
    let (ra, rb) = (ta.await?, tb.await?);
    env.tally(&ra);
    env.tally(&rb);
    env.note(format!(
        "  claim race executed at blocks {} and {}",
        exec_height(&env, &ra).await?,
        exec_height(&env, &rb).await?
    ));
    let wins = [ra.is_success(), rb.is_success()];
    assert_eq!(
        wins.iter().filter(|w| **w).count(),
        1,
        "exactly one claim wins: {wins:?}"
    );
    let (winner, loser, loser_key, loser_result) = if ra.is_success() {
        (&env.contrib, &env.rival, &env.rival_key, &rb)
    } else {
        (&env.rival, &env.contrib, &env.contrib_key, &ra)
    };
    assert_refused(loser_result, "this bounty is not open to claims");
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Claimed");
    assert_eq!(b["claim"]["wallet"].as_str(), Some(winner.id().as_str()));
    env.note(format!(
        "  claim race: {} won, {} lost",
        winner.id(),
        loser.id()
    ));
    assert!(
        !is_barred(&env, id, loser.id()).await?,
        "losing a race bars nobody"
    );
    // Nobody can end a live claim early except its parties.
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "expire_claim",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "the claim has not ended yet",
    );
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "release_claim",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "only the claimant can release the claim",
    );
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "revoke_claim",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "only the maintainer can revoke a claim",
    );
    // Expiry: after the claim's time anyone ends it; the bounty is open and the wallet barred.
    let ends = secs(&b["claim"]["ends_at"]);
    wait_past(&env, ends).await?;
    let r = call(
        &env.stranger,
        &env,
        "expire_claim",
        json!({"bounty_id": id}),
        0,
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let b = get_bounty(&env, id).await?;
    assert_eq!((status(&b), b["claim"].is_null()), ("Open", true));
    assert!(is_barred(&env, id, winner.id()).await?);
    let winner_key = if winner.id() == env.contrib.id() {
        &env.contrib_key
    } else {
        &env.rival_key
    };
    let r = claim(&env, winner, id, winner_key).await?;
    assert_refused(&r, "it cannot claim again");
    assert_refused(
        &submit(&env, winner, id, &PullSpec::open(&env, GH)).await?,
        "this bounty has no claim",
    );
    // The other wallet claims it now; the maintainer revokes it; that wallet is barred as well.
    let r = claim(&env, loser, id, loser_key).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(
        get_bounty(&env, id).await?["claim"]["wallet"].as_str(),
        Some(loser.id().as_str())
    );
    let r = call(
        &env.maint,
        &env,
        "revoke_claim",
        json!({"bounty_id": id}),
        0,
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(is_barred(&env, id, loser.id()).await?);
    assert_refused(
        &claim(&env, loser, id, loser_key).await?,
        "it cannot claim again",
    );
    // With both wallets barred nobody claims, and the maintainer can still cancel the open bounty.
    let r = cancel_bounty(&env, id).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(held(&env).await?, (0, 0));
    // A claimant may also give the bounty back by itself.
    let id2 = post(&env, 6, Timing::SHORT_CLAIM).await?;
    assert!(claim(&env, winner, id2, winner_key).await?.is_success());
    let r = call(winner, &env, "release_claim", json!({"bounty_id": id2}), 0).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(is_barred(&env, id2, winner.id()).await?);
    assert_eq!(status(&get_bounty(&env, id2).await?), "Open");
    env.save_trace("flow-claim-race-expiry-bar")?;
    Ok(())
}

// ---- A relink does not change an accepted submission or an existing claim ----

#[tokio::test]
async fn a_relink_that_activates_later_changes_neither_a_submission_nor_a_claim(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone()]).await?;
    // Bounty 0: the contributor submitted, so author GH, the pull request and the payout key are
    // pinned. Bounty 1: the rival only claimed, with GH2.
    let (id0, pull) = bind(&env, 7, Timing::FAULT).await?;
    let id1 = post(&env, 8, Timing::FAULT).await?;
    link_ok(&env, &env.rival, GH2).await?;
    assert!(claim(&env, &env.rival, id1, &env.rival_key.clone())
        .await?
        .is_success());

    // The contributor relinks to GH3: it waits the (test) delay of 6 s and applies later.
    let l = link(&env, &env.contrib, GH3).await?;
    assert_eq!(answer(&l), "link_pending", "{:?}", l.failures());
    let lk = get_link(&env, env.contrib.id()).await?;
    assert_eq!(lk["active"]["github_id"], GH.to_string());
    assert_eq!(lk["pending"]["link"]["github_id"], GH3.to_string());
    let due = secs(&lk["pending"]["activates_at"]);
    assert_eq!(
        github_owner(&env, GH).await?.as_deref(),
        Some(env.contrib.id().as_str())
    );
    assert_eq!(
        github_owner(&env, GH3).await?,
        None,
        "the new id has no holder until activation"
    );
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "activate_link",
            json!({"wallet": env.contrib.id()}),
            0,
        )
        .await?,
        "no link change of this wallet is due",
    );
    // The rival relinks to GH too (taken by the contributor today): also pending.
    let l = link(&env, &env.rival, GH).await?;
    assert_eq!(answer(&l), "link_pending");
    wait_past(
        &env,
        due.max(secs(
            &get_link(&env, env.rival.id()).await?["pending"]["activates_at"],
        )),
    )
    .await?;
    // Anyone applies the contributor's change; after it the contributor holds GH3 and not GH.
    let r = call(
        &env.stranger,
        &env,
        "activate_link",
        json!({"wallet": env.contrib.id()}),
        0,
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let lk = get_link(&env, env.contrib.id()).await?;
    assert_eq!(lk["active"]["github_id"], GH3.to_string());
    assert!(lk["pending"].is_null());
    assert_eq!(
        github_owner(&env, GH3).await?.as_deref(),
        Some(env.contrib.id().as_str())
    );
    assert_eq!(github_owner(&env, GH).await?, None);
    // The pinned submission is untouched.
    let b = get_bounty(&env, id0).await?;
    assert_eq!(status(&b), "Bound");
    assert_eq!(b["claim"]["github_id"], GH.to_string());
    assert_eq!(b["binding"]["author_id"], GH.to_string());
    assert_eq!(b["claim"]["vault"].as_str(), Some(cvault.as_str()));
    // A pull request by the new id is not the pinned one; the pinned author's merge pays.
    let deadline = merge_deadline(&env, id0).await?;
    let other_author = PullSpec::open(&env, GH3).merged(deadline - 1);
    let r = check(&env, &env.stranger, id0, &other_author, RUN).await?;
    assert_eq!(answer(&r), "no_result:inconsistent");
    assert_eq!(status(&get_bounty(&env, id0).await?), "Bound");
    let paid = merged_check(&env, id0, &pull, false).await?;
    trace(
        &env,
        "the pinned submission is paid after the relink activated",
        &paid,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(status(&get_bounty(&env, id0).await?), "Paid");
    assert_eq!(
        info(&env, &cvault).await?.available,
        REWARD,
        "paid into the vault chosen at the claim"
    );

    // The rival's change applies too (the incumbent's wallet no longer holds GH). The rival's
    // claim keeps GH2 and its payout key, but the wallet cannot submit under a changed link.
    let r = call(
        &env.stranger,
        &env,
        "activate_link",
        json!({"wallet": env.rival.id()}),
        0,
    )
    .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(
        get_link(&env, env.rival.id()).await?["active"]["github_id"],
        GH.to_string()
    );
    let b = get_bounty(&env, id1).await?;
    assert_eq!(
        b["claim"]["github_id"],
        GH2.to_string(),
        "the claim keeps the id it pinned"
    );
    assert_eq!(
        b["claim"]["key"].as_str(),
        Some(public(&env.rival_key).as_str())
    );
    let r = submit(
        &env,
        &env.rival,
        id1,
        &PullSpec::open(&env, GH).id(PR_ID + 1),
    )
    .await?;
    assert_refused(&r, "this wallet's GitHub link changed after it claimed");
    assert_eq!(status(&get_bounty(&env, id1).await?), "Claimed");
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "payout withdrawn after the relink",
    )
    .await?;
    assert_closed(&env, &ledger, "relink").await?;
    env.save_trace("flow-relink-delay")?;
    Ok(())
}

// ---- Submissions: what the contract refuses ----

#[tokio::test]
async fn a_submission_with_the_wrong_author_branch_link_or_an_already_bound_pull_request_is_refused(
) -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let id0 = post(&env, 9, Timing::RELEASE).await?;
    let id1 = post(&env, 10, Timing::RELEASE).await?;
    link_ok(&env, &env.contrib, GH).await?;
    link_ok(&env, &env.rival, GH2).await?;
    // Before any claim: a submission is refused; a non-claimant is refused.
    assert_refused(
        &submit(&env, &env.contrib, id0, &PullSpec::open(&env, GH)).await?,
        "this bounty has no claim",
    );
    assert!(claim(&env, &env.contrib, id0, &env.contrib_key.clone())
        .await?
        .is_success());
    assert_refused(
        &submit(&env, &env.rival, id0, &PullSpec::open(&env, GH2)).await?,
        "only the claimant can submit",
    );
    let ledger = Ledger::new(&env, &[]).await?;

    let good = PullSpec::open(&env, GH);
    let cases: Vec<(&str, PullSpec, Option<GistSpec>, &str)> = vec![
        (
            "wrong GitHub author",
            PullSpec::open(&env, GH2),
            None,
            "mismatch:author_id",
        ),
        (
            "wrong branch",
            good.clone().base("release"),
            None,
            "mismatch:base_ref",
        ),
        (
            "wrong repository id",
            PullSpec {
                repo_id: REPO_ID + 1,
                ..good.clone()
            },
            None,
            "mismatch:repo_id",
        ),
        (
            "already merged",
            good.clone().merged(1_700_000_000),
            None,
            "mismatch:not_open",
        ),
        (
            "link gist owned by someone else",
            good.clone(),
            Some(GistSpec::good(GH2)),
            "mismatch:link_owner",
        ),
        (
            "link gist with two files",
            good.clone(),
            Some(GistSpec {
                files: 2,
                ..GistSpec::good(GH)
            }),
            "mismatch:link_ambiguous",
        ),
        (
            "link gist with another challenge",
            good.clone(),
            Some(GistSpec {
                challenge_matches: false,
                ..GistSpec::good(GH)
            }),
            "mismatch:link_challenge",
        ),
    ];
    for (label, pull, gist, expected) in cases {
        let s = submit_gist(&env, &env.contrib, id0, &pull, gist).await?;
        assert_eq!(answer(&s), expected, "{label}: {:?}", s.failures());
        let b = get_bounty(&env, id0).await?;
        assert_eq!(status(&b), "Claimed", "{label}");
        assert!(
            b["live"].is_null() && b["binding"].is_null(),
            "{label}: nothing pinned"
        );
        assert_eq!(b["last_check"]["outcome"], expected);
        assert!(
            env.bounty
                .view("bound_pr")
                .args_json(json!({"pr_id": PR_ID.to_string()}))
                .await?
                .json::<Option<u64>>()?
                .is_none(),
            "{label}"
        );
        env.note(format!("  refused submission: {label} ({expected})"));
    }
    // An answer for another pull request number than the one asked is not an answer.
    let other_number = PullSpec {
        number: PR + 1,
        ..good.clone()
    };
    let lk = get_link(&env, env.contrib.id()).await?;
    set_submit_reply(
        &env,
        &other_number,
        lk["active"]["gist_id"].as_str().unwrap(),
        lk["active"]["challenge"].as_str().unwrap(),
        GistSpec::good(GH),
    )
    .await?;
    let r = call(
        &env.contrib,
        &env,
        "submit_pr",
        json!({"bounty_id": id0, "pr_number": PR}),
        RUN,
    )
    .await?;
    assert_eq!(answer(&r), "no_result:wrong_binding");
    // Wrong deposit, too little gas, a number out of range.
    assert_refused(
        &call(
            &env.contrib,
            &env,
            "submit_pr",
            json!({"bounty_id": id0, "pr_number": PR}),
            RUN - 1,
        )
        .await?,
        "attach exactly 0.01 NEAR",
    );
    assert_refused(
        &call(
            &env.contrib,
            &env,
            "submit_pr",
            json!({"bounty_id": id0, "pr_number": 0}),
            RUN,
        )
        .await?,
        "pr_number must be a pull request number",
    );
    let low = env
        .contrib
        .call(env.bounty.id(), "submit_pr")
        .args_json(json!({"bounty_id": id0, "pr_number": PR}))
        .deposit(NearToken::from_yoctonear(RUN))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    env.tally(&low);
    assert_refused(&low, "attach at least 260 Tgas");
    // The right submission binds.
    let s = submit(&env, &env.contrib, id0, &good).await?;
    assert_eq!(answer(&s), "bound");
    assert_eq!(
        env.bounty
            .view("bound_pr")
            .args_json(json!({"pr_id": PR_ID.to_string()}))
            .await?
            .json::<Option<u64>>()?,
        Some(id0)
    );
    // An unrelated pull request that is already bound to another bounty cannot be bound again;
    // a different pull request (another id) can.
    assert!(claim(&env, &env.rival, id1, &env.rival_key.clone())
        .await?
        .is_success());
    let same_pr = PullSpec::open(&env, GH2);
    let s = submit(&env, &env.rival, id1, &same_pr).await?;
    assert_eq!(answer(&s), "mismatch:pr_already_bound");
    assert_eq!(status(&get_bounty(&env, id1).await?), "Claimed");
    let s = submit(&env, &env.rival, id1, &same_pr.clone().id(PR_ID + 1)).await?;
    assert_eq!(answer(&s), "bound");
    assert_eq!(
        env.bounty
            .view("bound_pr")
            .args_json(json!({"pr_id": (PR_ID + 1).to_string()}))
            .await?
            .json::<Option<u64>>()?,
        Some(id1)
    );
    // A bound bounty accepts no second submission.
    assert_refused(
        &submit(&env, &env.contrib, id0, &good).await?,
        "only the claimant can submit, and only while the bounty is claimed",
    );
    assert_closed(&env, &ledger, "submissions").await?;
    env.save_trace("flow-submission-refusals")?;
    Ok(())
}

#[tokio::test]
async fn a_submission_check_in_flight_blocks_a_second_submit_and_ending_the_claim(
) -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let id = post(&env, 11, Timing::RELEASE).await?;
    link_ok(&env, &env.contrib, GH).await?;
    assert!(claim(&env, &env.contrib, id, &env.contrib_key.clone())
        .await?
        .is_success());
    let pull = PullSpec::open(&env, GH);
    let lk = get_link(&env, env.contrib.id()).await?;
    let (gist_id, challenge) = (
        lk["active"]["gist_id"].as_str().unwrap().to_string(),
        lk["active"]["challenge"].as_str().unwrap().to_string(),
    );
    set_submit_reply(&env, &pull, &gist_id, &challenge, GistSpec::good(GH)).await?;
    reply_delay(&env, 12).await?;
    let first = env
        .contrib
        .call(env.bounty.id(), "submit_pr")
        .args_json(json!({"bounty_id": id, "pr_number": PR}))
        .deposit(NearToken::from_yoctonear(RUN))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    let mut n = 0;
    while get_bounty(&env, id).await?["live"].is_null() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        n += 1;
        assert!(n < 200, "the submission never started");
    }
    let b = get_bounty(&env, id).await?;
    assert_eq!(b["live"]["kind"], "Submit");
    // While it is live: no second submission, and nobody ends the claim.
    assert_refused(
        &call(
            &env.contrib,
            &env,
            "submit_pr",
            json!({"bounty_id": id, "pr_number": PR}),
            RUN,
        )
        .await?,
        "a check is already running for this bounty",
    );
    assert_refused(
        &call(
            &env.contrib,
            &env,
            "release_claim",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "a submission is being checked",
    );
    assert_refused(
        &call(
            &env.maint,
            &env,
            "revoke_claim",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "a submission is being checked",
    );
    assert_refused(
        &call(&env.maint, &env, "cancel", json!({"bounty_id": id}), 0).await?,
        "only a bounty with no claim can be cancelled",
    );
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    let done = first.await?;
    env.tally(&done);
    assert_eq!(answer(&done), "bound", "{:?}", done.failures());
    reply_delay(&env, 0).await?;
    let b = get_bounty(&env, id).await?;
    assert_eq!((status(&b), b["live"].is_null()), ("Bound", true));
    env.save_trace("flow-duplicate-submit")?;
    Ok(())
}

// ---- Merge checks: outside the window, upstream failures, the refund cap ----

#[tokio::test]
async fn a_merge_outside_the_window_or_into_another_branch_is_not_paid() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let ledger = Ledger::new(&env, &[mvault.clone(), cvault.clone()]).await?;
    // Merged at the deadline itself: too late. The bounty is ineligible and refundable at once.
    let (id, pull) = bind(&env, 12, Timing::RELEASE).await?;
    let m = merge_deadline(&env, id).await?;
    let r = check(&env, &env.stranger, id, &pull.clone().merged(m), RUN).await?;
    assert_eq!(answer(&r), "ineligible:merged_after_deadline");
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Ineligible");
    assert!(b["payout"].is_null());
    assert_eq!(
        held(&env).await?,
        (REWARD, 0),
        "the reward is still held, not paid"
    );
    assert_eq!(bal(&env, &cvault).await?, 0);
    let r = settle_call(&env, &env.stranger, id).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    trace(
        &env,
        "an ineligible bounty is refunded without waiting",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(status(&get_bounty(&env, id).await?), "Refunded");
    assert_settled(&env, id, "Refund", &mvault, REWARD).await?;
    assert_eq!(
        bal(&env, &cvault).await?,
        0,
        "no money went to the contributor's vault"
    );
    assert_eq!(held(&env).await?, (0, 0));
    // Merged into another branch before the deadline: also ineligible.
    let (id2, pull2) = bind_second(&env, 13, 1).await?;
    let m2 = merge_deadline(&env, id2).await?;
    let wrong_branch = pull2.clone().id(PR_ID + 1).merged(m2 - 1).base("release");
    let r = check(&env, &env.stranger, id2, &wrong_branch, RUN).await?;
    assert_eq!(answer(&r), "ineligible:base_ref");
    assert_eq!(status(&get_bounty(&env, id2).await?), "Ineligible");
    let r = settle_call(&env, &env.stranger, id2).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(info(&env, &mvault).await?.available, 2 * REWARD);
    assert_eq!(bal(&env, &cvault).await?, 0);
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        2 * REWARD,
        "maintainer withdraws both refunds",
    )
    .await?;
    assert_closed(&env, &ledger, "ineligible").await?;
    env.save_trace("flow-merge-outside-window")?;
    Ok(())
}

/// A second bounty for the same contributor, bound to a pull request with its own id.
async fn bind_second(env: &Env, issue: u64, n: u64) -> anyhow::Result<(u64, PullSpec)> {
    let id = post(env, issue, Timing::RELEASE).await?;
    let pull = PullSpec::open(env, GH).id(PR_ID + n);
    claim_and_bind(env, &env.contrib, &env.contrib_key.clone(), GH, id, &pull).await?;
    Ok((id, pull))
}

#[tokio::test]
async fn an_upstream_failure_leaves_the_bounty_bound_and_a_retry_pays() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone()]).await?;
    let (id, pull) = bind(&env, 14, Timing::RELEASE).await?;
    let m = merge_deadline(&env, id).await?;
    let before = get_bounty(&env, id).await?;
    // Every kind of failed look leaves the bounty as it was; the contract records the outcome.
    use proven_pr_bounty_verifier::Reason;
    for (label, reason) in [
        ("unreachable", Reason::Unreachable),
        ("rate limited", Reason::RateLimited),
        ("timeout", Reason::Timeout),
        ("not found", Reason::NotFound),
    ] {
        set_no_result(&env, pull.number, reason).await?;
        let r = call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN,
        )
        .await?;
        let outcome = answer(&r);
        assert!(outcome.starts_with("no_result:"), "{label}: {outcome}");
        let b = get_bounty(&env, id).await?;
        assert_eq!(status(&b), "Bound", "{label}");
        assert_eq!(b["last_check"]["outcome"], outcome);
        assert!(
            b["definite_look"].is_null(),
            "{label}: a failed look is not a definite look"
        );
        assert_eq!(b["binding"], before["binding"]);
        env.note(format!("  upstream failure: {label} -> {outcome}"));
    }
    reply(&env, "null", None).await?;
    let r = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert_eq!(answer(&r), "no_result:no_output");
    reply(&env, "panic", None).await?;
    let r = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    let rows = trace(&env, "OutLayer refuses at admission", &r, env.stranger.id()).await?;
    assert!(
        logged(&r, "outcome=no_result:promise_failed"),
        "{:?}",
        r.logs()
    );
    assert!(
        sent(&rows, "system", env.stranger.id().as_str(), RUN),
        "the refused deposit came back to the caller"
    );
    assert_eq!(status(&get_bounty(&env, id).await?), "Bound");
    assert_eq!(held(&env).await?, (REWARD, 0));
    // A pull request merged before it was bound is not a payment; a different pull request or
    // author is not the pinned one. All leave the bounty bound.
    let bound_secs = secs(&before["binding"]["bound_at"]) / 1_000_000_000;
    for (label, p, expected) in [
        (
            "merged long before binding",
            pull.clone().merged(bound_secs - 3_600),
            "no_result:merged_before_binding",
        ),
        (
            "another pull request id",
            pull.clone().id(PR_ID + 9).merged(m - 1),
            "no_result:inconsistent",
        ),
        (
            "another author",
            PullSpec::open(&env, GH2).merged(m - 1),
            "no_result:inconsistent",
        ),
        (
            "open on another base branch",
            pull.clone().base("release"),
            "pending:base_ref",
        ),
        ("still open", pull.clone(), "pending"),
    ] {
        let r = check(&env, &env.stranger, id, &p, RUN).await?;
        assert_eq!(answer(&r), expected, "{label}");
        assert_eq!(status(&get_bounty(&env, id).await?), "Bound", "{label}");
    }
    // The retry that reads the merge pays, and a paid bounty takes no more checks.
    let paid = merged_check(&env, id, &pull, false).await?;
    trace(&env, "the retry pays", &paid, env.stranger.id()).await?;
    assert_eq!(status(&get_bounty(&env, id).await?), "Paid");
    assert_eq!(info(&env, &cvault).await?.available, REWARD);
    assert_refused(
        &check(&env, &env.stranger, id, &pull, RUN).await?,
        "no submitted pull request",
    );
    assert_closed(&env, &ledger, "retry").await?;
    env.save_trace("flow-upstream-failure-retry")?;
    Ok(())
}

#[tokio::test]
async fn refund_cap_an_on_time_merge_can_go_unpaid_when_verification_stays_unavailable(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let ledger = Ledger::new(&env, &[mvault.clone(), cvault.clone()]).await?;
    let (id, pull) = bind(&env, 15, Timing::FAULT).await?;
    let m = merge_deadline(&env, id).await?;
    // Before the deadline GitHub answers once (a definite look, but too early to count), then
    // every look fails: from the contract's side the merge on time is never read.
    let r = check(&env, &env.stranger, id, &pull, RUN).await?;
    assert_eq!(answer(&r), "pending");
    let look = get_bounty(&env, id).await?["definite_look"].clone();
    assert!(
        secs(&look["requested_at"]) < m * 1_000_000_000,
        "this look was requested before the deadline"
    );
    wait_past(&env, m).await?;
    set_no_result(
        &env,
        pull.number,
        proven_pr_bounty_verifier::Reason::Unreachable,
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
    assert_eq!(answer(&r), "no_result:unreachable");
    assert_eq!(
        get_bounty(&env, id).await?["definite_look"],
        look,
        "a failed look changes nothing"
    );
    // The grace (deadline + 10 minutes) ends. Until the hard cutoff a refund still needs a
    // definitive negative look, and there is none; checks are still accepted, and they keep
    // failing.
    let cutoff = m + 600 + cap_secs(&env).await?;
    wait_past(&env, m + 599).await?;
    let r = settle_call(&env, &env.stranger, id).await?;
    let at = exec_ns(&env, &r).await?;
    env.note(format!(
        "  settle without a definite look ran {} ms past the grace's end",
        at.saturating_sub((m + 600) * 1_000_000_000) / 1_000_000
    ));
    assert!(at < cutoff * 1_000_000_000, "the try ran before the cutoff");
    assert_refused(&r, "cannot be refunded yet");
    let r = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(
        exec_ns(&env, &r).await? < cutoff * 1_000_000_000,
        "the check ran before the cutoff"
    );
    assert_eq!(
        answer(&r),
        "no_result:unreachable",
        "a check after the grace is accepted"
    );
    assert_eq!(held(&env).await?, (REWARD, 0));
    assert_eq!(status(&get_bounty(&env, id).await?), "Bound");
    // At the hard cutoff checks are refused and the refund opens although the pull request was
    // merged on time: the contributor is not paid. This is the stated rule, shown to both parties
    // before they commit.
    wait_past(&env, cutoff).await?;
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN,
        )
        .await?,
        "merge checks ended at the hard refund cutoff",
    );
    let r = settle_call(&env, &env.stranger, id).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(exec_ns(&env, &r).await? >= cutoff * 1_000_000_000);
    assert_eq!(status(&get_bounty(&env, id).await?), "Refunded");
    assert_settled(&env, id, "Refund", &mvault, REWARD).await?;
    assert_eq!(
        bal(&env, &cvault).await?,
        0,
        "nothing reached the contributor although the merge was on time"
    );
    assert_refused(
        &check(&env, &env.contrib, id, &pull.clone().merged(m - 1), 0).await?,
        "no submitted pull request",
    );
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "maintainer withdraws after the cap",
    )
    .await?;
    assert_closed(&env, &ledger, "cap").await?;
    env.save_trace("flow-refund-cap-on-time-merge-unpaid")?;
    Ok(())
}

#[tokio::test]
async fn an_on_time_merge_checked_after_the_deadline_within_the_grace_still_pays(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone()]).await?;
    let (id, pull) = bind(&env, 16, Timing::FAULT).await?;
    let m = merge_deadline(&env, id).await?;
    wait_past(&env, m + 5).await?;
    // The contributor's wallet asks for a sponsored check after the deadline; GitHub says the
    // pull request was merged one second before it.
    let r = check(&env, &env.contrib, id, &pull.clone().merged(m - 1), 0).await?;
    assert_eq!(answer(&r), "paid", "{:?} {:?}", r.logs(), r.failures());
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Paid");
    assert!(
        b["definite_look"].is_null(),
        "a merged pull request is not a negative look"
    );
    assert!(
        secs(&b["merge"]["checked_at"]) >= m * 1_000_000_000,
        "read after the deadline"
    );
    assert_eq!(info(&env, &cvault).await?.available, REWARD);
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "paid after the deadline, within grace",
    )
    .await?;
    assert_closed(&env, &ledger, "late check").await?;
    env.save_trace("flow-late-check-within-grace")?;
    Ok(())
}

/// The fault build's refund cap, from the contract's own config.
async fn cap_secs(env: &Env) -> anyhow::Result<u64> {
    Ok(config(env).await?["refund_cap_secs"].as_u64().unwrap())
}

#[tokio::test]
async fn an_on_time_merge_verified_after_the_grace_is_paid_before_the_cutoff() -> anyhow::Result<()>
{
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let (id, pull) = bind(&env, 17, Timing::FAULT).await?;
    let m = merge_deadline(&env, id).await?;
    let cutoff = m + 600 + cap_secs(&env).await?;
    // After the deadline GitHub cannot be read: a failed look, not a negative.
    wait_past(&env, m).await?;
    set_no_result(
        &env,
        pull.number,
        proven_pr_bounty_verifier::Reason::Timeout,
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
    assert_eq!(answer(&r), "no_result:timeout");
    assert!(get_bounty(&env, id).await?["definite_look"].is_null());
    // The grace ends with nothing read. The refund is still closed.
    wait_past(&env, m + 600).await?;
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    // After the grace, GitHub answers: merged one second before the deadline. It is paid.
    let r = check(&env, &env.stranger, id, &pull.clone().merged(m - 1), RUN).await?;
    let at = exec_ns(&env, &r).await?;
    assert!(
        at >= (m + 600) * 1_000_000_000 && at < cutoff * 1_000_000_000,
        "the check ran after the grace and before the cutoff"
    );
    assert_eq!(answer(&r), "paid", "{:?}", r.failures());
    env.note(format!(
        "  an on-time merge read {} s after the grace was paid",
        (at / 1_000_000_000).saturating_sub(m + 600)
    ));
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Paid");
    assert!(b["refund"].is_null());
    assert_settled(&env, id, "Payout", &cvault, REWARD).await?;
    assert_eq!(bal(&env, &mvault).await?, 0, "no refund vault exists");
    // Past the cutoff nothing reverses it.
    wait_past(&env, cutoff).await?;
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "paid after the grace",
    )
    .await?;
    assert_closed(&env, &ledger, "paid after the grace").await?;
    env.save_trace("flow-on-time-merge-after-grace")?;
    Ok(())
}

#[tokio::test]
async fn a_late_merge_checked_after_the_grace_is_still_not_paid() -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let (id, pull) = bind(&env, 18, Timing::FAULT).await?;
    let m = merge_deadline(&env, id).await?;
    wait_past(&env, m + 600).await?;
    // Merged exactly at the deadline, read after the grace: the deadline decides, not the check.
    let r = check(&env, &env.stranger, id, &pull.clone().merged(m), RUN).await?;
    assert_eq!(answer(&r), "ineligible:merged_after_deadline");
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Ineligible");
    assert!(b["payout"].is_null());
    let r = settle_call(&env, &env.stranger, id).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_settled(&env, id, "Refund", &mvault, REWARD).await?;
    assert_eq!(
        bal(&env, &cvault).await?,
        0,
        "nothing reached the contributor"
    );
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &mvault,
        env.maint.id(),
        REWARD,
        "late merge refunded",
    )
    .await?;
    assert_closed(&env, &ledger, "late merge").await?;
    env.save_trace("flow-late-merge-after-grace")?;
    Ok(())
}

#[tokio::test]
async fn a_check_in_flight_at_the_cutoff_blocks_the_refund_and_its_valid_result_pays(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let (id, pull) = bind(&env, 19, Timing::FAULT).await?;
    let m = merge_deadline(&env, id).await?;
    let cutoff = m + 600 + cap_secs(&env).await?;
    // The answer, "merged one second before the deadline", is held back for 40 blocks.
    set_pull_reply(&env, &pull.clone().merged(m - 1)).await?;
    reply_delay(&env, 40).await?;
    wait_past(&env, cutoff - 4).await?;
    let first = env
        .stranger
        .call(env.bounty.id(), "check_merge")
        .args_json(json!({"bounty_id": id}))
        .deposit(NearToken::from_yoctonear(RUN))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    let mut n = 0;
    while get_bounty(&env, id).await?["live"].is_null() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        n += 1;
        assert!(n < 200, "the check never started");
    }
    let requested = secs(&get_bounty(&env, id).await?["live"]["requested_at"]);
    assert!(
        requested < cutoff * 1_000_000_000,
        "the check was requested before the cutoff"
    );
    // The cutoff passes while the check is in flight: the refund is refused, and so is a new check.
    sleep_past_ns(&env, cutoff * 1_000_000_000).await?;
    let r = settle_call(&env, &env.stranger, id).await?;
    let at = exec_ns(&env, &r).await?;
    assert!(at >= cutoff * 1_000_000_000, "settle ran after the cutoff");
    assert_refused(&r, "cannot be refunded yet");
    let b = get_bounty(&env, id).await?;
    assert_eq!(
        status(&b),
        "Bound",
        "the check was still in flight when settle ran (requested {} ms before the cutoff, settle {} ms after it)",
        (cutoff * 1_000_000_000).saturating_sub(requested) / 1_000_000,
        at.saturating_sub(cutoff * 1_000_000_000) / 1_000_000
    );
    assert!(!b["live"].is_null());
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN,
        )
        .await?,
        "merge checks ended at the hard refund cutoff",
    );
    env.note(format!(
        "  check requested {} ms before the cutoff; settle refused {} ms after it",
        (cutoff * 1_000_000_000 - requested) / 1_000_000,
        (at - cutoff * 1_000_000_000) / 1_000_000
    ));
    // Its answer lands after the cutoff, within the run's time: it pays, and no refund follows.
    let done = first.await?;
    reply_delay(&env, 0).await?;
    assert_eq!(answer(&done), "paid", "{:?}", done.failures());
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Paid");
    assert!(b["refund"].is_null());
    // The payout is sent by a detached self-call; wait for its receipts, which the awaited
    // transaction outcome does not include.
    let mut n = 0;
    while settlement(&env, id, "Payout").await?["state"] != "Done" {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        n += 1;
        assert!(n < 150, "the payout's receipts never finished");
    }
    // The node's own record of every receipt's burn, the 40 hops and the detached payout too.
    tally_exact(&env, &done, env.stranger.id()).await?;
    assert_settled(&env, id, "Payout", &cvault, REWARD).await?;
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    assert_eq!(bal(&env, &mvault).await?, 0, "no refund vault exists");
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "paid by the check in flight at the cutoff",
    )
    .await?;
    assert_closed(&env, &ledger, "in flight at the cutoff").await?;
    env.save_trace("flow-check-in-flight-at-cutoff")?;
    Ok(())
}

/// The release build: an answer "not merged" read in the first minute after the deadline is not
/// a negative (GitHub may not have reported the merge yet), so it cannot open the refund at the
/// end of the grace; a later check that reads the merge before the deadline pays it.
#[tokio::test]
async fn an_early_not_merged_answer_cannot_open_the_refund_and_a_later_check_pays_the_on_time_merge(
) -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let cvault = vault_of(&env, &env.contrib_key).await?;
    let mvault = vault_of(&env, &env.maint_key).await?;
    let ledger = Ledger::new(&env, &[cvault.clone(), mvault.clone()]).await?;
    let (id, pull) = bind(&env, 21, Timing::RELEASE).await?;
    let m = merge_deadline(&env, id).await?;
    let grace = secs(&get_bounty(&env, id).await?["grace_secs"]);
    // Just after the deadline GitHub still reports the pull request open.
    wait_past(&env, m).await?;
    let r = check(&env, &env.stranger, id, &pull, RUN).await?;
    assert_eq!(answer(&r), "pending", "{:?}", r.failures());
    let requested = secs(&get_bounty(&env, id).await?["definite_look"]["requested_at"]);
    assert!(
        requested >= m * 1_000_000_000 && requested < (m + 60) * 1_000_000_000,
        "the early answer was requested within a minute after the deadline"
    );
    env.note(format!(
        "  \"not merged\" requested {} ms after the deadline",
        (requested - m * 1_000_000_000) / 1_000_000
    ));
    // The grace ends. That early answer does not open the refund.
    wait_past(&env, m + grace).await?;
    let r = settle_call(&env, &env.stranger, id).await?;
    assert!(
        exec_ns(&env, &r).await? >= (m + grace) * 1_000_000_000,
        "settle ran after the grace"
    );
    assert_refused(&r, "cannot be refunded yet");
    assert_eq!(status(&get_bounty(&env, id).await?), "Bound");
    assert_eq!(held(&env).await?, (REWARD, 0));
    // A later check reads the merge, one second before the deadline: it is paid.
    let r = check(&env, &env.stranger, id, &pull.clone().merged(m - 1), RUN).await?;
    assert_eq!(answer(&r), "paid", "{:?}", r.failures());
    let b = get_bounty(&env, id).await?;
    assert_eq!(status(&b), "Paid");
    assert!(b["refund"].is_null());
    assert_settled(&env, id, "Payout", &cvault, REWARD).await?;
    assert_eq!(bal(&env, &mvault).await?, 0, "no refund vault exists");
    assert_refused(
        &settle_call(&env, &env.stranger, id).await?,
        "cannot be refunded yet",
    );
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &cvault,
        env.payee.id(),
        REWARD,
        "on-time merge paid after an early not-merged answer",
    )
    .await?;
    assert_closed(&env, &ledger, "early not-merged answer").await?;
    env.save_trace("flow-early-not-merged-then-paid")?;
    Ok(())
}

// ---- Link rules ----

#[tokio::test]
async fn link_rules_refresh_pending_changes_and_the_incumbents_say() -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    link_ok(&env, &env.contrib, GH).await?;
    let first = get_link(&env, env.contrib.id()).await?["active"]["gist_id"]
        .as_str()
        .unwrap()
        .to_string();
    // The same id again with a new gist: refreshed at once. A used gist is refused.
    let l = link(&env, &env.contrib, GH).await?;
    assert_eq!(answer(&l), "link_refreshed");
    let second = get_link(&env, env.contrib.id()).await?["active"]["gist_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(first, second);
    let l = link_with(&env, &env.contrib, &first, GistSpec::good(GH)).await?;
    assert_refused(&l, "this gist has already been used for a link");
    // Facts that do not hold change nothing.
    let g = env.next_gist();
    let l = link_with(
        &env,
        &env.contrib,
        &g,
        GistSpec {
            challenge_matches: false,
            ..GistSpec::good(GH)
        },
    )
    .await?;
    assert_eq!(answer(&l), "mismatch:challenge");
    let g = env.next_gist();
    let l = link_with(
        &env,
        &env.contrib,
        &g,
        GistSpec {
            files: 2,
            ..GistSpec::good(GH)
        },
    )
    .await?;
    assert_eq!(answer(&l), "mismatch:ambiguous");
    reply(&env, "null", None).await?;
    let expires = now_secs(&env).await? + 1800;
    let l = call(
        &env.contrib,
        &env,
        "link",
        json!({"gist_id": env.next_gist(), "expires_at": expires.to_string()}),
        RUN + LINK_STORAGE,
    )
    .await?;
    assert_eq!(answer(&l), "no_result:no_output");
    let l = call(
        &env.contrib,
        &env,
        "link",
        json!({"gist_id": env.next_gist(), "expires_at": (expires - 4_000).to_string()}),
        RUN + LINK_STORAGE,
    )
    .await?;
    assert_refused(&l, "expires_at must be in the future");
    let l = call(
        &env.contrib,
        &env,
        "link",
        json!({"gist_id": "NOT-HEX", "expires_at": expires.to_string()}),
        RUN + LINK_STORAGE,
    )
    .await?;
    assert_refused(&l, "lowercase hex id");
    let lk = get_link(&env, env.contrib.id()).await?;
    assert_eq!(lk["active"]["gist_id"].as_str(), Some(second.as_str()));
    assert!(lk["pending"].is_null());

    // A second wallet linking to the same GitHub id waits; only the incumbent can confirm or cancel.
    let l = link(&env, &env.rival, GH).await?;
    assert_eq!(answer(&l), "link_pending");
    assert_eq!(
        github_owner(&env, GH).await?.as_deref(),
        Some(env.contrib.id().as_str())
    );
    let due = secs(&get_link(&env, env.rival.id()).await?["pending"]["activates_at"]);
    assert!(
        due > now_secs(&env).await? + 60 * 60,
        "the release delay is long"
    );
    let wallet = json!({"wallet": env.rival.id()});
    assert_refused(
        &call(&env.stranger, &env, "activate_link", wallet.clone(), 0).await?,
        "no link change of this wallet is due",
    );
    assert_refused(
        &call(&env.rival, &env, "confirm_link_change", wallet.clone(), 0).await?,
        "only the wallet that holds this GitHub account today can confirm early",
    );
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "confirm_link_change",
            wallet.clone(),
            0,
        )
        .await?,
        "only the wallet that holds this GitHub account today",
    );
    assert_refused(
        &call(&env.stranger, &env, "cancel_link_change", wallet.clone(), 0).await?,
        "only the wallet itself or the wallet that holds this GitHub account can cancel",
    );
    let r = call(&env.contrib, &env, "cancel_link_change", wallet.clone(), 0).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert!(get_link(&env, env.rival.id()).await?["pending"].is_null());
    let l = link(&env, &env.rival, GH).await?;
    assert_eq!(answer(&l), "link_pending");
    let r = call(&env.contrib, &env, "confirm_link_change", wallet, 0).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(
        github_owner(&env, GH).await?.as_deref(),
        Some(env.rival.id().as_str())
    );
    assert_eq!(
        get_link(&env, env.rival.id()).await?["active"]["github_id"],
        GH.to_string()
    );
    assert!(
        get_link(&env, env.contrib.id()).await?["active"].is_null(),
        "the displaced wallet has no active link"
    );
    let id = post(&env, 17, Timing::RELEASE).await?;
    assert_refused(
        &claim_args_call(&env, id).await?,
        "connect a GitHub account to this wallet first",
    );
    env.save_trace("flow-link-rules")?;
    Ok(())
}

/// The displaced contributor wallet tries to claim with a proof for GH.
async fn claim_args_call(
    env: &Env,
    id: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let expires = now_secs(env).await? + 1800;
    let proof = claim_proof(
        env,
        id,
        env.contrib.id(),
        GH,
        &env.contrib_key,
        &env.contrib_key,
        expires,
    )
    .await?;
    call(
        &env.contrib,
        env,
        "claim",
        json!({"bounty_id": id, "key": public(&env.contrib_key), "proof": proof}),
        CLAIM_FEE,
    )
    .await
}

// ---- Sponsored checks ----

#[tokio::test]
async fn sponsored_checks_are_limited_and_their_change_reaches_only_the_sponsor(
) -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let (id, pull) = bind(&env, 18, Timing::RELEASE).await?;
    let held0 = held(&env).await?;
    // Only the bound wallet may use a sponsored check.
    set_pull_reply(&env, &pull).await?;
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "only the contributor's wallet can use a sponsored check",
    );
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN - 1,
        )
        .await?,
        "attach exactly 0.01 NEAR, or nothing for a sponsored check",
    );
    // Change delayed, held, and never returned: liabilities do not move and only the sponsor gains.
    for (n, (mode, hops)) in [("delayed", 5u32), ("held", 0), ("none", 0)]
        .into_iter()
        .enumerate()
    {
        change_mode(&env, mode, hops).await?;
        let s0 = bal(&env, env.sponsor.id()).await?;
        let r = check(&env, &env.contrib, id, &pull, 0).await?;
        assert_eq!(answer(&r), "pending", "{mode}: {:?}", r.failures());
        let req = last_request(&env).await?;
        assert_eq!(req["payer_account_id"], env.sponsor.id().as_str());
        assert_eq!(req["refund_to"], env.sponsor.id().as_str());
        let expect = if mode == "delayed" {
            RUN - MOCK_CHARGE
        } else {
            0
        };
        assert_eq!(bal(&env, env.sponsor.id()).await? - s0, expect, "{mode}");
        assert_eq!(held(&env).await?, held0, "{mode}: liabilities unchanged");
        assert_eq!(get_bounty(&env, id).await?["sponsored_runs"], n as u64 + 1);
    }
    assert_refused(
        &check(&env, &env.contrib, id, &pull, 0).await?,
        "used its three sponsored checks",
    );
    let c = config(&env).await?;
    assert_eq!(
        (u(&c["sponsor_float"]), u(&c["sponsor_spent"])),
        (FLOAT - 3 * RUN, 3 * RUN)
    );
    // A self-funded check still works and pays; the held change, released late, reaches the sponsor.
    change_mode(&env, "immediate", 0).await?;
    let paid = merged_check(&env, id, &pull, false).await?;
    trace(
        &env,
        "a self-funded check pays after three sponsored checks",
        &paid,
        env.stranger.id(),
    )
    .await?;
    let s0 = bal(&env, env.sponsor.id()).await?;
    env.outlayer
        .call("release_change")
        .transact()
        .await?
        .into_result()?;
    assert_eq!(bal(&env, env.sponsor.id()).await? - s0, RUN - MOCK_CHARGE);
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(
        info(&env, &vault_of(&env, &env.contrib_key).await?)
            .await?
            .available,
        REWARD
    );

    // A run refused at admission: its deposit goes back to the sponsor account.
    let (id2, _) = bind_second(&env, 19, 1).await?;
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
    assert!(sent(&rows, "system", env.sponsor.id().as_str(), RUN));
    assert_eq!(bal(&env, env.sponsor.id()).await? - s0, RUN);
    let c = config(&env).await?;
    assert_eq!(
        (u(&c["sponsor_float"]), u(&c["sponsor_spent"])),
        (FLOAT - 4 * RUN, 4 * RUN)
    );
    // The float cap and the aggregate cap hold; the owner or sponsor alone may fund.
    let room = 100 * MILLI - (FLOAT - 4 * RUN);
    let fund = |who: &near_workspaces::Account, amount: u128| {
        who.call(env.bounty.id(), "fund_sponsor")
            .deposit(NearToken::from_yoctonear(amount))
            .transact()
    };
    assert_refused(&fund(&env.sponsor, room + 1).await?, "exceed its cap");
    assert_refused(
        &fund(&env.stranger, 1).await?,
        "only the owner or the sponsor account",
    );
    assert!(fund(&env.sponsor, room).await?.is_success());
    env.owner.call(env.bounty.id(), "set_sponsor_limits").args_json(json!({"max_sponsor_float": (100 * MILLI).to_string(), "max_sponsor_spent": (4 * RUN).to_string()})).transact().await?.into_result()?;
    set_pull_reply(&env, &PullSpec::open(&env, GH).id(PR_ID + 1)).await?;
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
    env.save_trace("flow-sponsored-checks")?;
    Ok(())
}

// ---- Proofs and permissions that must hold ----

#[tokio::test]
async fn key_proofs_posting_rules_and_private_callbacks_are_enforced_with_nothing_locked(
) -> anyhow::Result<()> {
    let env = setup_with(RELEASE_WASM).await?;
    let ledger = Ledger::new(&env, &[]).await?;
    let now = now_secs(&env).await?;
    let t = terms(&env, 20, now, Timing::RELEASE);
    let nonce = env.next_nonce();
    let good = posting_proof(&env, &t, &env.maint_key, env.maint.id(), &nonce, now + 1800).await?;
    let contract0 = bal(&env, env.bounty.id()).await?;
    let mut other_terms = t.clone();
    other_terms["issue"] = json!(21);
    let other_actor = posting_proof(
        &env,
        &t,
        &env.maint_key,
        env.stranger.id(),
        &nonce,
        now + 1800,
    )
    .await?;
    let by_other_key = posting_proof(
        &env,
        &t,
        &env.rival_key,
        env.maint.id(),
        &env.next_nonce(),
        now + 1800,
    )
    .await?;
    let expired = posting_proof(
        &env,
        &t,
        &env.maint_key,
        env.maint.id(),
        &env.next_nonce(),
        now - 1,
    )
    .await?;
    let too_far = posting_proof(
        &env,
        &t,
        &env.maint_key,
        env.maint.id(),
        &env.next_nonce(),
        now + 3_700,
    )
    .await?;
    for (label, terms, proof, expected) in [
        (
            "copied proof, other terms",
            other_terms,
            good.clone(),
            "the withdrawal key's proof does not match",
        ),
        (
            "another actor",
            t.clone(),
            other_actor,
            "the withdrawal key's proof does not match",
        ),
        (
            "signed by another key than the one passed",
            t.clone(),
            by_other_key,
            "the withdrawal key's proof does not match",
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
        assert_refused(&try_post(&env, terms, proof).await?, expected);
        env.note(format!("  refused posting: {label}"));
    }
    // Posting rules, each with a valid proof for the changed terms.
    let mut cases: Vec<(&str, serde_json::Value, &str)> = Vec::new();
    let mut c = t.clone();
    c["reward"] = json!((3 * NEAR).to_string());
    cases.push(("reward over the cap", c, "reward is over the cap"));
    let mut c = t.clone();
    c["reward"] = json!((MIN_REWARD - 1).to_string());
    cases.push(("reward under the minimum", c, "reward is under the minimum"));
    let mut c = t.clone();
    c["repo"] = json!("not-a-repository");
    cases.push(("malformed repository", c, "repo must be owner/name"));
    let mut c = t.clone();
    c["repo_id"] = json!("0");
    cases.push(("no repository id", c, "repo_id is required"));
    let mut c = t.clone();
    c["base_ref"] = json!("");
    cases.push(("empty branch", c, "base_ref must be a branch name"));
    let mut c = t.clone();
    c["base_ref"] = json!("b".repeat(256));
    cases.push(("256-byte branch", c, "base_ref must be a branch name"));
    let mut c = t.clone();
    c["claim_by"] = json!((now - 5).to_string());
    cases.push((
        "claim window already over",
        c,
        "times must satisfy now < claim_by <= merge_deadline",
    ));
    let mut c = t.clone();
    c["claim_by"] = json!((now + 8_000).to_string());
    cases.push((
        "claim window after the deadline",
        c,
        "times must satisfy now < claim_by <= merge_deadline",
    ));
    let mut c = t.clone();
    c["grace_secs"] = json!("599");
    cases.push((
        "grace under 10 minutes",
        c,
        "grace must be 10 minutes to 1 day",
    ));
    let mut c = t.clone();
    c["claim_secs"] = json!("3599");
    cases.push((
        "claim under an hour",
        c,
        "a claim must last at least the minimum",
    ));
    let mut c = t.clone();
    c["issue"] = json!(0);
    cases.push(("issue zero", c, "the issue number is required"));
    let mut c = t.clone();
    c["merge_deadline"] = json!((now + 40 * 24 * 3600).to_string());
    cases.push(("deadline over 30 days", c, "more than 30 days away"));
    for (label, terms, expected) in cases {
        let proof = posting_proof(
            &env,
            &terms,
            &env.maint_key,
            env.maint.id(),
            &env.next_nonce(),
            now + 1800,
        )
        .await?;
        assert_refused(
            &try_post_with(&env, terms, &env.maint_key.clone(), proof, None).await?,
            expected,
        );
        env.note(format!("  refused posting: {label}"));
    }
    // Wrong deposit; not an approved poster.
    let proof = posting_proof(
        &env,
        &t,
        &env.maint_key,
        env.maint.id(),
        &env.next_nonce(),
        now + 1800,
    )
    .await?;
    assert_refused(
        &try_post_with(
            &env,
            t.clone(),
            &env.maint_key.clone(),
            proof.clone(),
            Some(env.storage - 1),
        )
        .await?,
        "attach exactly the reward plus the storage deposit",
    );
    assert_refused(
        &try_post_with(
            &env,
            t.clone(),
            &env.maint_key.clone(),
            proof.clone(),
            Some(env.storage + 1),
        )
        .await?,
        "attach exactly the reward plus the storage deposit",
    );
    // Posting is open at init; once the owner closes it, only the allowlist may post.
    let set_open = |open: bool| {
        env.owner
            .call(env.bounty.id(), "set_open_posting")
            .args_json(json!({"open": open}))
            .transact()
    };
    let r = set_open(false).await?;
    env.tally(&r);
    r.into_result()?;
    let r = try_post_as(
        &env,
        &env.stranger,
        t.clone(),
        &env.maint_key.clone(),
        proof,
        None,
    )
    .await?;
    assert_refused(&r, "posting is limited to approved maintainers right now");
    let r = set_open(true).await?;
    env.tally(&r);
    r.into_result()?;
    assert_eq!(config(&env).await?["bounty_count"], 0);
    assert_eq!(held(&env).await?, (0, 0));
    assert_eq!(
        bal(&env, env.bounty.id()).await?,
        contract0,
        "every refusal locked nothing"
    );
    // The good proof works once; a replay with the same nonce is refused.
    assert!(try_post(&env, t.clone(), good.clone()).await?.is_success());
    assert_refused(
        &try_post(&env, t, good).await?,
        "this posting nonce has already been used",
    );
    assert!(env
        .bounty
        .view("is_nonce_used")
        .args_json(json!({"maintainer": env.maint.id(), "nonce": nonce}))
        .await?
        .json::<bool>()?);

    // Claim proofs: for another wallet, expired, or too far ahead.
    let id = 0;
    link_ok(&env, &env.contrib, GH).await?;
    let expires = now_secs(&env).await? + 1800;
    let for_other = claim_proof(
        &env,
        id,
        env.stranger.id(),
        GH,
        &env.contrib_key,
        &env.contrib_key,
        expires,
    )
    .await?;
    let r = call(
        &env.contrib,
        &env,
        "claim",
        json!({"bounty_id": id, "key": public(&env.contrib_key), "proof": for_other}),
        CLAIM_FEE,
    )
    .await?;
    assert_refused(&r, "the withdrawal key's proof does not match");
    let other_github = claim_proof(
        &env,
        id,
        env.contrib.id(),
        GH2,
        &env.contrib_key,
        &env.contrib_key,
        expires,
    )
    .await?;
    let r = call(
        &env.contrib,
        &env,
        "claim",
        json!({"bounty_id": id, "key": public(&env.contrib_key), "proof": other_github}),
        CLAIM_FEE,
    )
    .await?;
    assert_refused(&r, "the withdrawal key's proof does not match");
    let old = claim_proof(
        &env,
        id,
        env.contrib.id(),
        GH,
        &env.contrib_key,
        &env.contrib_key,
        now_secs(&env).await? - 1,
    )
    .await?;
    let r = call(
        &env.contrib,
        &env,
        "claim",
        json!({"bounty_id": id, "key": public(&env.contrib_key), "proof": old}),
        CLAIM_FEE,
    )
    .await?;
    assert_refused(&r, "expires_at must be in the future");
    assert_eq!(status(&get_bounty(&env, id).await?), "Open");
    // Owner-only and private methods.
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "add_poster",
            json!({"account": env.stranger.id()}),
            0,
        )
        .await?,
        "only the owner",
    );
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "set_paused",
            json!({"paused": true}),
            0,
        )
        .await?,
        "only the owner",
    );
    for method in [
        "on_link",
        "on_check",
        "on_settle",
        "on_settle_outcome",
        "on_reconcile",
        "send_due_after_check",
    ] {
        let r = call(&env.stranger, &env, method, json!({}), 0).await?;
        assert_refused(&r, &format!("Method {method} is private"));
    }
    // Pause stops only new bounties.
    let r = env
        .owner
        .call(env.bounty.id(), "set_paused")
        .args_json(json!({"paused": true}))
        .transact()
        .await?;
    env.tally(&r);
    r.into_result()?;
    let now = now_secs(&env).await?;
    let t = terms(&env, 22, now, Timing::RELEASE);
    let proof = posting_proof(
        &env,
        &t,
        &env.maint_key,
        env.maint.id(),
        &env.next_nonce(),
        now + 1800,
    )
    .await?;
    assert_refused(&try_post(&env, t, proof).await?, "new bounties are paused");
    assert!(
        claim(&env, &env.contrib, id, &env.contrib_key.clone())
            .await?
            .is_success(),
        "claims still work while paused"
    );
    assert_closed(&env, &ledger, "refusals").await?;
    env.save_trace("flow-proofs-and-permissions")?;
    Ok(())
}
