//! Sandbox tests of the bounty contract's full callback and transfer paths, against a mock
//! OutLayer that returns answers made by the bounty verifier's own `render`. Transfers are checked
//! from the transaction's receipts (recipient, amount, outcome) as well as from balances and
//! contract state. Build first, in this order:
//!
//!   cargo near build non-reproducible-wasm                        (in contracts/pr-bounty)
//!   cargo near build non-reproducible-wasm                        (in contracts/mock-outlayer-reply)
//!   cargo near build non-reproducible-wasm --features fault-transfer-callback --out-dir target/fault
//!                                                                 (in contracts/pr-bounty)

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use proven_pr_bounty_verifier as verifier;
use serde_json::{json, Value};
use verifier::{PullFacts as VPull, RunContext};

const BOUNTY_WASM: &str = "target/near/proven_pr_bounty.wasm";
const FAULT_WASM: &str = "target/fault/proven_pr_bounty.wasm";
const MOCK_WASM: &str = "../mock-outlayer-reply/target/near/proven_mock_outlayer_reply.wasm";
const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
const HASH: &str = "75a43fb03170017304f2bf53eb21d7d77bd630741ea568f649a4de1efac3948d";
const REPO: &str = "proven-test/bounty-pilot";
const REPO_ID: u64 = 800_000_001;
const ISSUE: u64 = 3;
const GH: u64 = 900_000_001;
const PR: u64 = 12;
const PR_ID: u64 = 5_000_000_012;
const REWARD: u128 = 1_000_000_000_000_000_000_000_000;
const BUDGET: u128 = 30_000_000_000_000_000_000_000;
const STORAGE: u128 = 20_000_000_000_000_000_000_000;
const RUN: u128 = 10_000_000_000_000_000_000_000;
const MOCK_CHARGE: u128 = 1_000_000_000_000_000_000_000;

struct Env {
    sandbox: Worker<Sandbox>,
    bounty: Contract,
    outlayer: Contract,
    owner: Account,
    buyer: Account,
    contributor: Account,
    stranger: Account,
}

fn read_wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}; build it first (see the header)"))
}

async fn setup_with(wasm: &str) -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let root = sandbox.root_account()?;
    let bounty = sandbox.dev_deploy(&read_wasm(wasm)?).await?;
    let outlayer = sandbox.dev_deploy(&read_wasm(MOCK_WASM)?).await?;
    let owner = sandbox.dev_create_account().await?;
    let stranger = sandbox.dev_create_account().await?;
    // Named subaccounts, so a test can delete one and create it again.
    let buyer = root
        .create_subaccount("maint")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let contributor = root
        .create_subaccount("contrib")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    outlayer.call("new").transact().await?.into_result()?;
    bounty
        .call("new")
        .args_json(json!({
            "owner": owner.id(), "outlayer": outlayer.id(), "network": "testnet",
            "verifier_url": URL, "verifier_hash": HASH,
            "max_reward": "2000000000000000000000000", "max_held": "5000000000000000000000000",
            "max_open_per_buyer": 3,
        }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(bounty.id(), "add_poster")
        .args_json(json!({"account": buyer.id()}))
        .transact()
        .await?
        .into_result()?;
    Ok(Env {
        sandbox,
        bounty,
        outlayer,
        owner,
        buyer,
        contributor,
        stranger,
    })
}

async fn setup() -> anyhow::Result<Env> {
    setup_with(BOUNTY_WASM).await
}

async fn now_secs(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp() / 1_000_000_000)
}

/// Posts a bounty whose deadlines are `claim`, `bind` and `merge` seconds from now.
async fn post(
    env: &Env,
    claim: u64,
    bind: u64,
    merge: u64,
    grace: u64,
) -> anyhow::Result<(u64, u64)> {
    let now = now_secs(env).await?;
    let id: u64 = env
        .buyer
        .call(env.bounty.id(), "post_bounty")
        .args_json(json!({
            "reward": REWARD.to_string(), "repo": REPO, "repo_id": REPO_ID.to_string(), "issue": ISSUE,
            "base_ref": "main", "contributor_github_id": GH.to_string(),
            "claim_by": (now + claim).to_string(), "bind_by": (now + bind).to_string(),
            "merge_deadline": (now + merge).to_string(), "grace_secs": grace.to_string(),
        }))
        .deposit(NearToken::from_yoctonear(REWARD + BUDGET + STORAGE))
        .transact()
        .await?
        .json()?;
    Ok((id, now + merge))
}

fn ctx(env: &Env, request_id: u64) -> RunContext {
    RunContext::from_vars(
        Some(env.bounty.id().to_string()),
        Some(request_id.to_string()),
    )
}

fn request(env: &Env, bounty: u64, seq: u64, op: verifier::Op) -> verifier::Request {
    verifier::Request {
        network: "testnet".into(),
        contract: env.bounty.id().to_string(),
        bounty,
        seq,
        repo: REPO.into(),
        op,
    }
}

fn comment_reply(env: &Env, bounty: u64, seq: u64, created_at: u64) -> String {
    let op = verifier::Op::Comment {
        comment_id: 77,
        challenge: format!("proven-claim:{}", "0".repeat(64)),
    };
    let facts = verifier::CommentFacts {
        repo_id: REPO_ID,
        comment_id: 77,
        author_id: GH,
        issue_number: ISSUE,
        created_at,
        updated_at: created_at,
        challenge_matches: true,
    };
    verifier::render(
        Some(&request(env, bounty, seq, op)),
        &ctx(env, 20_000 + seq),
        Ok(verifier::Answer::Comment(facts)),
    )
}

fn pull_reply(env: &Env, bounty: u64, seq: u64, merged_at: Option<u64>) -> String {
    let facts = VPull {
        repo_id: REPO_ID,
        pr_id: PR_ID,
        pr_number: PR,
        author_id: GH,
        base_ref: "main".into(),
        state: if merged_at.is_some() {
            "closed"
        } else {
            "open"
        }
        .into(),
        merged: merged_at.is_some(),
        merged_at,
    };
    verifier::render(
        Some(&request(
            env,
            bounty,
            seq,
            verifier::Op::Pull { number: PR },
        )),
        &ctx(env, 20_000 + seq),
        Ok(verifier::Answer::Pull(facts)),
    )
}

async fn reply(env: &Env, mode: &str, body: Option<String>) -> anyhow::Result<()> {
    env.outlayer
        .call("set_reply")
        .args_json(json!({"mode": mode, "reply": body}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn call(
    who: &Account,
    env: &Env,
    method: &str,
    args: Value,
    deposit: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.bounty.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

async fn bounty(env: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(env
        .bounty
        .view("get_bounty")
        .args_json(json!({"bounty_id": id}))
        .await?
        .json()?)
}

async fn balance(account: &Account) -> anyhow::Result<u128> {
    Ok(account.view_account().await?.balance.as_yoctonear())
}

/// Every NEAR transfer the contract sent in transaction `result`: (recipient, amount, succeeded).
async fn contract_transfers(
    env: &Env,
    result: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<Vec<(String, u128, bool)>> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "EXPERIMENTAL_tx_status", "params": {
        "tx_hash": result.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}});
    let tx: Value = reqwest::Client::new()
        .post(env.sandbox.rpc_addr())
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    let tx = &tx["result"];
    let mut out = Vec::new();
    for receipt in tx["receipts"].as_array().cloned().unwrap_or_default() {
        if receipt["predecessor_id"] != env.bounty.id().as_str() {
            continue;
        }
        for action in receipt["receipt"]["Action"]["actions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            if let Some(deposit) = action["Transfer"]["deposit"].as_str() {
                let outcome = tx["receipts_outcome"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|o| o["id"] == receipt["receipt_id"])
                    .expect("outcome of the transfer receipt");
                let succeeded = outcome["outcome"]["status"].get("Failure").is_none();
                out.push((
                    receipt["receiver_id"].as_str().unwrap().to_string(),
                    deposit.parse()?,
                    succeeded,
                ));
            }
        }
    }
    Ok(out)
}

/// Claims bounty `id` (claim seq `seq`) and binds the pull request (seq `seq + 1`).
async fn claim_and_bind(env: &Env, id: u64, seq: u64) -> anyhow::Result<()> {
    let now = now_secs(env).await?;
    reply(env, "reply", Some(comment_reply(env, id, seq, now))).await?;
    let claimed = call(
        &env.contributor,
        env,
        "prove_claim",
        json!({"bounty_id": id, "comment_id": "77", "expires_at": (now + 1800).to_string()}),
        RUN,
    )
    .await?;
    assert!(
        claimed.logs().iter().any(|l| l.contains("outcome=claimed")),
        "{:?}",
        claimed.logs()
    );
    reply(env, "reply", Some(pull_reply(env, id, seq + 1, None))).await?;
    let bound = call(
        &env.buyer,
        env,
        "nominate",
        json!({"bounty_id": id, "pr_number": PR}),
        RUN,
    )
    .await?;
    assert!(
        bound.logs().iter().any(|l| l.contains("outcome=bound")),
        "{:?}",
        bound.logs()
    );
    Ok(())
}

fn assert_refused(result: &ExecutionFinalResult, message: &str) {
    let failure = format!("{:?}", result.clone().into_result().expect_err("refused"));
    assert!(
        failure.contains(message),
        "expected {message:?} in {failure}"
    );
}

fn logged(result: &ExecutionFinalResult, text: &str) -> bool {
    result.logs().iter().any(|l| l.contains(text))
}

#[tokio::test]
async fn an_eligible_contributor_is_paid_the_exact_reward_once() -> anyhow::Result<()> {
    let env = setup().await?;
    let storage_before = env.bounty.view_account().await?.storage_usage;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    let state = bounty(&env, id).await?;
    assert_eq!(state["claim"]["wallet"], env.contributor.id().as_str());
    assert_eq!(state["claim"]["request_id"], "20001");
    assert_eq!(state["binding"]["pr_id"], PR_ID.to_string());
    assert_eq!(state["binding"]["request_id"], "20002");

    reply(
        &env,
        "reply",
        Some(pull_reply(&env, id, 3, Some(deadline - 1))),
    )
    .await?;
    let (contributor_before, buyer_before) =
        (balance(&env.contributor).await?, balance(&env.buyer).await?);
    let check = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(check.is_success(), "{:?}", check.failures());
    assert!(logged(&check, "outcome=paid request_id=20003"));
    // From the receipts: exactly the reward to the recorded wallet and the unused budget to the
    // maintainer, both succeeded, and nothing else left the contract.
    let sent = contract_transfers(&env, &check, env.stranger.id()).await?;
    assert_eq!(
        sent,
        vec![
            (env.contributor.id().to_string(), REWARD, true),
            (env.buyer.id().to_string(), BUDGET, true),
        ]
    );
    assert_eq!(
        balance(&env.contributor).await? - contributor_before,
        REWARD
    );
    assert_eq!(balance(&env.buyer).await? - buyer_before, BUDGET);
    let state = bounty(&env, id).await?;
    assert_eq!(state["status"], "Paid");
    assert_eq!(state["reward_transfer"]["state"], "Done");
    assert_eq!(state["budget_transfer"]["state"], "Done");
    assert_eq!(state["merge"]["merged_at"], (deadline - 1).to_string());
    let config: Value = env.bounty.view("get_config").await?.json()?;
    assert_eq!(config["held"], "0");
    // The transfer callback stays well inside its 10 Tgas.
    let callback_gas = check
        .receipt_outcomes()
        .iter()
        .filter(|o| {
            o.executor_id == *env.bounty.id()
                && o.logs.iter().any(|l| l.starts_with("transfer_resolved"))
        })
        .map(|o| o.gas_burnt.as_gas())
        .max()
        .unwrap();
    assert!(
        callback_gas < 5_000_000_000_000,
        "callback burnt {callback_gas}"
    );

    // The record at its largest fits the 0.02 NEAR storage deposit (2,000 bytes).
    let grown = env.bounty.view_account().await?.storage_usage - storage_before;
    println!("bounty record and its entries: {grown} bytes");
    assert!(grown <= 2_000, "{grown} bytes");

    // Paid once: no second check, no refund, nothing due.
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN,
        )
        .await?,
        "no bound pull request",
    );
    assert_refused(
        &call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?,
        "cannot be refunded yet",
    );
    assert_refused(
        &call(&env.stranger, &env, "send_due", json!({"bounty_id": id}), 0).await?,
        "no transfer is due",
    );
    Ok(())
}

#[tokio::test]
async fn a_late_merge_is_ineligible_and_the_maintainer_is_refunded() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    reply(&env, "reply", Some(pull_reply(&env, id, 3, Some(deadline)))).await?;
    let check = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&check, "outcome=ineligible:merged_after_deadline"));
    assert!(contract_transfers(&env, &check, env.stranger.id())
        .await?
        .is_empty());
    let buyer_before = balance(&env.buyer).await?;
    let settle = call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?;
    assert!(settle.is_success());
    assert_eq!(
        contract_transfers(&env, &settle, env.stranger.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, true)]
    );
    assert_eq!(balance(&env.buyer).await? - buyer_before, REWARD + BUDGET);
    assert_eq!(bounty(&env, id).await?["status"], "Refunded");
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN,
        )
        .await?,
        "no bound pull request",
    );
    Ok(())
}

#[tokio::test]
async fn an_unmerged_bounty_refunds_after_its_window_and_not_before() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _deadline) = post(&env, 60, 120, 180, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    reply(&env, "reply", Some(pull_reply(&env, id, 3, None))).await?;
    let pending = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&pending, "outcome=pending"));
    assert_refused(
        &call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?,
        "cannot be refunded yet",
    );
    let mut waited = 0;
    while now_secs(&env).await?
        < bounty(&env, id).await?["merge_deadline"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 600
    {
        env.sandbox.fast_forward(200).await?;
        waited += 1;
        assert!(waited < 50, "the sandbox clock did not move");
    }
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN,
        )
        .await?,
        "verification window has ended",
    );
    let buyer_before = balance(&env.buyer).await?;
    let settle = call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?;
    assert_eq!(
        contract_transfers(&env, &settle, env.stranger.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, true)]
    );
    assert_eq!(balance(&env.buyer).await? - buyer_before, REWARD + BUDGET);
    Ok(())
}

#[tokio::test]
async fn a_failed_payout_is_recoverable_only_to_the_same_wallet() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    // The contributor's wallet is deleted after the claim: the payout transfer will fail.
    let root = env.sandbox.root_account()?;
    env.contributor
        .clone()
        .delete_account(root.id())
        .await?
        .into_result()?;
    reply(
        &env,
        "reply",
        Some(pull_reply(&env, id, 3, Some(deadline - 1))),
    )
    .await?;
    let check = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&check, "outcome=paid"));
    let sent = contract_transfers(&env, &check, env.stranger.id()).await?;
    assert!(
        sent.contains(&(env.contributor.id().to_string(), REWARD, false)),
        "{sent:?}"
    );
    let state = bounty(&env, id).await?;
    assert_eq!(state["reward_transfer"]["state"], "Due");
    assert_eq!(
        state["reward_transfer"]["to"],
        env.contributor.id().as_str()
    );
    let config: Value = env.bounty.view("get_config").await?.json()?;
    assert_eq!(
        config["held"],
        REWARD.to_string(),
        "the failed reward is held again"
    );
    // The same wallet comes back; anyone resends; it receives exactly the reward.
    let back = root
        .create_subaccount("contrib")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let before = balance(&back).await?;
    let resend = call(&env.stranger, &env, "send_due", json!({"bounty_id": id}), 0).await?;
    assert_eq!(
        contract_transfers(&env, &resend, env.stranger.id()).await?,
        vec![(back.id().to_string(), REWARD, true)]
    );
    assert_eq!(balance(&back).await? - before, REWARD);
    assert_eq!(bounty(&env, id).await?["reward_transfer"]["state"], "Done");
    assert_refused(
        &call(&env.stranger, &env, "send_due", json!({"bounty_id": id}), 0).await?,
        "no transfer is due",
    );
    Ok(())
}

#[tokio::test]
async fn a_failed_refund_is_recoverable_only_to_the_maintainer() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    let root = env.sandbox.root_account()?;
    env.buyer
        .clone()
        .delete_account(root.id())
        .await?
        .into_result()?;
    // Nobody can cancel for the deleted maintainer, but the bounty expires unclaimed.
    let mut waited = 0;
    while now_secs(&env).await?
        < bounty(&env, id).await?["claim_by"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 15 * 60
    {
        env.sandbox.fast_forward(200).await?;
        waited += 1;
        assert!(waited < 50);
    }
    let settle = call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?;
    assert_eq!(
        contract_transfers(&env, &settle, env.stranger.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, false)]
    );
    assert_eq!(bounty(&env, id).await?["reward_transfer"]["state"], "Due");
    let back = root
        .create_subaccount("maint")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let before = balance(&back).await?;
    let resend = call(&env.stranger, &env, "send_due", json!({"bounty_id": id}), 0).await?;
    assert_eq!(
        contract_transfers(&env, &resend, env.stranger.id()).await?,
        vec![(back.id().to_string(), REWARD + BUDGET, true)]
    );
    assert_eq!(balance(&back).await? - before, REWARD + BUDGET);
    Ok(())
}

#[tokio::test]
async fn a_sent_transfer_whose_callback_fails_is_never_repeated() -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    reply(
        &env,
        "reply",
        Some(pull_reply(&env, id, 3, Some(deadline - 1))),
    )
    .await?;
    let before = balance(&env.contributor).await?;
    let check = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&check, "outcome=paid"));
    // The transfer went through; its bookkeeping callback failed.
    assert!(contract_transfers(&env, &check, env.stranger.id())
        .await?
        .contains(&(env.contributor.id().to_string(), REWARD, true)));
    assert!(format!("{:?}", check.failures()).contains("fault injection"));
    assert_eq!(balance(&env.contributor).await? - before, REWARD);
    let state = bounty(&env, id).await?;
    assert_eq!(
        state["reward_transfer"]["state"], "Sending",
        "recorded as sent, outcome unconfirmed"
    );
    // Nobody can send it again.
    assert_refused(
        &call(&env.stranger, &env, "send_due", json!({"bounty_id": id}), 0).await?,
        "no transfer is due",
    );
    assert_refused(
        &call(&env.stranger, &env, "settle", json!({"bounty_id": id}), 0).await?,
        "cannot be refunded yet",
    );
    assert_eq!(
        balance(&env.contributor).await? - before,
        REWARD,
        "paid exactly once"
    );
    Ok(())
}

#[tokio::test]
async fn forged_replayed_and_bad_answers_change_nothing() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    let (other, _) = post(&env, 300, 600, 3_600, 600).await?;
    let now = now_secs(&env).await?;
    let expires = (now + 1800).to_string();
    // Forged callbacks from an outside account.
    for (method, args) in [
        (
            "on_claim",
            json!({"bounty_id": id, "seq": "1", "wallet": env.stranger.id(), "comment_id": "77", "expires_at": expires, "requested_at": "0"}),
        ),
        ("on_check", json!({"bounty_id": id, "seq": "1"})),
        ("on_transfer", json!({"bounty_id": id, "kind": "Reward"})),
    ] {
        assert_refused(
            &call(&env.stranger, &env, method, args, 0).await?,
            &format!("Method {method} is private"),
        );
    }
    // A valid answer for one bounty replayed for another, and for the right bounty with the wrong seq.
    reply(&env, "reply", Some(comment_reply(&env, id, 1, now))).await?;
    let replay = call(
        &env.contributor,
        &env,
        "prove_claim",
        json!({"bounty_id": other, "comment_id": "77", "expires_at": expires}),
        RUN,
    )
    .await?;
    assert!(logged(&replay, "outcome=no_result:wrong_binding"));
    let stale_seq = call(
        &env.contributor,
        &env,
        "prove_claim",
        json!({"bounty_id": id, "comment_id": "77", "expires_at": expires}),
        RUN,
    )
    .await?;
    assert!(
        logged(&stale_seq, "outcome=no_result:wrong_binding"),
        "seq 1 was used by the replay; this run is seq 2"
    );
    // Timeouts, oversized replies and refused admissions.
    for (mode, body, outcome) in [
        ("null", None, "no_result:no_output"),
        ("reply", Some(" ".repeat(1025)), "no_result:oversized"),
        ("panic", None, "no_result:promise_failed"),
    ] {
        reply(&env, mode, body).await?;
        let run = call(
            &env.contributor,
            &env,
            "prove_claim",
            json!({"bounty_id": id, "comment_id": "77", "expires_at": expires}),
            RUN,
        )
        .await?;
        assert!(
            logged(&run, &format!("outcome={outcome}")),
            "{mode}: {:?}",
            run.logs()
        );
    }
    assert_eq!(bounty(&env, id).await?["status"], "Open");
    // An outside wallet's proof carries its own challenge, which the contributor's comment is not.
    let mut copied: Value = serde_json::from_str(&comment_reply(&env, id, 6, now))?;
    copied["comment"]["challenge_matches"] = json!(false);
    reply(&env, "reply", Some(copied.to_string())).await?;
    let grab = call(
        &env.stranger,
        &env,
        "prove_claim",
        json!({"bounty_id": id, "comment_id": "77", "expires_at": expires}),
        RUN,
    )
    .await?;
    assert!(logged(&grab, "outcome=mismatch:challenge"));
    assert_eq!(bounty(&env, id).await?["status"], "Open");
    Ok(())
}

#[tokio::test]
async fn the_contributor_budget_is_bounded_and_refunds_unused_compute_to_the_maintainer(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    for seq in 3..6 {
        reply(&env, "reply", Some(pull_reply(&env, id, seq, None))).await?;
        let buyer_before = balance(&env.buyer).await?;
        let run = call(
            &env.contributor,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            0,
        )
        .await?;
        assert!(logged(&run, "outcome=pending"), "{:?}", run.logs());
        // OutLayer (the mock) returns the unused deposit to the maintainer, who funded the budget.
        assert_eq!(balance(&env.buyer).await? - buyer_before, RUN - MOCK_CHARGE);
    }
    assert_refused(
        &call(
            &env.contributor,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "budget is used up",
    );
    assert_refused(
        &call(
            &env.stranger,
            &env,
            "check_merge",
            json!({"bounty_id": id}),
            0,
        )
        .await?,
        "only the contributor's wallet",
    );
    // Anyone can still check at their own cost, and the unused part comes back to them.
    reply(&env, "reply", Some(pull_reply(&env, id, 6, None))).await?;
    let paid_self = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&paid_self, "outcome=pending"));
    let last: Value = serde_json::from_str(
        &env.outlayer
            .view("get_last_request")
            .await?
            .json::<Option<String>>()?
            .unwrap(),
    )?;
    assert_eq!(last["payer_account_id"], env.stranger.id().as_str());
    assert_eq!(last["source"]["WasmUrl"]["hash"], HASH);
    assert!(last["secrets_ref"].is_null());
    Ok(())
}

#[tokio::test]
async fn the_pause_blocks_posting_but_not_checking_or_payout() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    env.owner
        .call(env.bounty.id(), "set_paused")
        .args_json(json!({"paused": true}))
        .transact()
        .await?
        .into_result()?;
    let blocked = env
        .buyer
        .call(env.bounty.id(), "post_bounty")
        .args_json(json!({
            "reward": REWARD.to_string(), "repo": REPO, "repo_id": REPO_ID.to_string(), "issue": ISSUE,
            "base_ref": "main", "contributor_github_id": GH.to_string(), "claim_by": (deadline - 3000).to_string(),
            "bind_by": (deadline - 2000).to_string(), "merge_deadline": deadline.to_string(), "grace_secs": "600",
        }))
        .deposit(NearToken::from_yoctonear(REWARD + BUDGET + STORAGE))
        .transact()
        .await?;
    assert_refused(&blocked, "new bounties are paused");
    reply(
        &env,
        "reply",
        Some(pull_reply(&env, id, 3, Some(deadline - 1))),
    )
    .await?;
    let check = call(
        &env.stranger,
        &env,
        "check_merge",
        json!({"bounty_id": id}),
        RUN,
    )
    .await?;
    assert!(logged(&check, "outcome=paid"));
    assert_eq!(bounty(&env, id).await?["reward_transfer"]["state"], "Done");
    Ok(())
}
