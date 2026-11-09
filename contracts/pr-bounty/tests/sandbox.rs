//! Sandbox tests of the bounty contract's full callback and transfer paths, against a mock
//! OutLayer that returns answers made by the bounty verifier's own `render`. Transfers are checked
//! from the transaction's receipts (recipient, amount, outcome) as well as from balances, the
//! contract's reserved total (`held`) and its state. Build first:
//!
//!   cargo near build non-reproducible-wasm                        (in contracts/pr-bounty)
//!   cargo near build non-reproducible-wasm                        (in contracts/mock-outlayer-reply)
//!   cargo near build non-reproducible-wasm --features fault-transfer-callback --out-dir target/fault
//!   cargo near build non-reproducible-wasm --features fault-transfer-callback,fault-outcome-callback \
//!     --out-dir target/fault-both                                 (both in contracts/pr-bounty)
//!
//! In the `fault` build every bookkeeping callback (`on_transfer`) fails, so every transfer is
//! finished by `recover_transfer` from the outcome its second callback recorded. In the
//! `fault-both` build that second callback fails as well.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use proven_pr_bounty_verifier as verifier;
use serde_json::{json, Value};
use verifier::{GistFacts as VGist, PullFacts as VPull, RunContext};

const BOUNTY_WASM: &str = "target/near/proven_pr_bounty.wasm";
const FAULT_WASM: &str = "target/fault/proven_pr_bounty.wasm";
const FAULT_BOTH_WASM: &str = "target/fault-both/proven_pr_bounty.wasm";
const MOCK_WASM: &str = "../mock-outlayer-reply/target/near/proven_mock_outlayer_reply.wasm";
const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
const HASH: &str = "6df5a630107bef075bdd09203d64bbd26ec072e6edfd329b2f946a534c4e32fa";
/// Fixtures only. The real pilot repository is the owner's to approve.
const REPO: &str = "proven-test/bounty-pilot";
const REPO_ID: u64 = 800_000_001;
const ISSUE: u64 = 3;
const GH: u64 = 900_000_001;
const OTHER_GH: u64 = 900_000_002;
const GIST: &str = "0123456789abcdef0123456789abcdef";
const OTHER_GIST: &str = "fedcba9876543210fedcba9876543210";
const PR: u64 = 12;
const PR_ID: u64 = 5_000_000_012;
const REWARD: u128 = 1_000_000_000_000_000_000_000_000;
const BUDGET: u128 = 30_000_000_000_000_000_000_000;
const STORAGE: u128 = 20_000_000_000_000_000_000_000;
const RUN: u128 = 10_000_000_000_000_000_000_000;
const MOCK_CHARGE: u128 = 1_000_000_000_000_000_000_000;
const MILLINEAR: u128 = 1_000_000_000_000_000_000_000;
const TGAS: u64 = 1_000_000_000_000;

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
            "pilot_repo": REPO, "pilot_repo_id": REPO_ID.to_string(),
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

/// Moves the sandbox clock past Unix second `secs`.
async fn wait_past(env: &Env, secs: u64) -> anyhow::Result<()> {
    let mut waited = 0;
    while now_secs(env).await? <= secs {
        env.sandbox.fast_forward(200).await?;
        waited += 1;
        assert!(waited < 80, "the sandbox clock did not move");
    }
    Ok(())
}

/// Tries to post a bounty for `repo`/`repo_id` whose deadlines are `claim`, `bind` and `merge`
/// seconds from now.
async fn try_post(
    env: &Env,
    repo: &str,
    repo_id: u64,
    (claim, bind, merge, grace): (u64, u64, u64, u64),
) -> anyhow::Result<ExecutionFinalResult> {
    let now = now_secs(env).await?;
    Ok(env
        .buyer
        .call(env.bounty.id(), "post_bounty")
        .args_json(json!({
            "reward": REWARD.to_string(), "repo": repo, "repo_id": repo_id.to_string(),
            "issue": ISSUE, "base_ref": "main", "contributor_github_id": GH.to_string(),
            "claim_by": (now + claim).to_string(), "bind_by": (now + bind).to_string(),
            "merge_deadline": (now + merge).to_string(), "grace_secs": grace.to_string(),
        }))
        .deposit(NearToken::from_yoctonear(REWARD + BUDGET + STORAGE))
        .transact()
        .await?)
}

/// Posts a bounty for the pilot repository; returns its id and merge deadline.
async fn post(
    env: &Env,
    claim: u64,
    bind: u64,
    merge: u64,
    grace: u64,
) -> anyhow::Result<(u64, u64)> {
    let result = try_post(env, REPO, REPO_ID, (claim, bind, merge, grace)).await?;
    let id: u64 = result.json()?;
    let state = bounty(env, id).await?;
    Ok((id, secs(&state["merge_deadline"])))
}

fn secs(value: &Value) -> u64 {
    value
        .as_str()
        .expect("a U64 string")
        .parse()
        .expect("a number")
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

fn good_gist() -> VGist {
    VGist {
        owner_id: GH,
        files: 1,
        challenge_matches: true,
    }
}

/// The verifier's answer about gist `gist_id`, for bounty `bounty` and run `seq`.
fn gist_reply(env: &Env, bounty: u64, seq: u64, gist_id: &str, facts: VGist) -> String {
    let op = verifier::Op::Gist {
        gist_id: gist_id.into(),
        challenge: format!("proven-claim:{}", "0".repeat(64)),
    };
    verifier::render(
        Some(&request(env, bounty, seq, op)),
        &ctx(env, 20_000 + seq),
        Ok(verifier::Answer::Gist(facts)),
    )
}

fn pull_facts(merged_at: Option<u64>) -> VPull {
    VPull {
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
    }
}

fn pull_reply_with(env: &Env, bounty: u64, seq: u64, facts: VPull) -> String {
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

fn pull_reply(env: &Env, bounty: u64, seq: u64, merged_at: Option<u64>) -> String {
    pull_reply_with(env, bounty, seq, pull_facts(merged_at))
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

async fn prove(
    env: &Env,
    who: &Account,
    id: u64,
    gist_id: &str,
    expires_at: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    call(
        who,
        env,
        "prove_claim",
        json!({"bounty_id": id, "gist_id": gist_id, "expires_at": expires_at.to_string()}),
        RUN,
    )
    .await
}

async fn check(env: &Env, who: &Account, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(who, env, "check_merge", json!({"bounty_id": id}), RUN).await
}

async fn recover(
    env: &Env,
    who: &Account,
    id: u64,
    kind: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    call(
        who,
        env,
        "recover_transfer",
        json!({"bounty_id": id, "kind": kind}),
        0,
    )
    .await
}

async fn send_due(env: &Env, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(&env.stranger, env, "send_due", json!({"bounty_id": id}), 0).await
}

async fn settle(env: &Env, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(&env.stranger, env, "settle", json!({"bounty_id": id}), 0).await
}

async fn bounty(env: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(env
        .bounty
        .view("get_bounty")
        .args_json(json!({"bounty_id": id}))
        .await?
        .json()?)
}

/// The contract's reserved total: rewards and budgets owed and not yet confirmed paid out.
async fn held(env: &Env) -> anyhow::Result<u128> {
    let config: Value = env.bounty.view("get_config").await?.json()?;
    Ok(config["held"].as_str().unwrap().parse()?)
}

/// An account's balance once the gas refunds of its own earlier transactions have landed.
async fn balance_of(env: &Env, account: &Account) -> anyhow::Result<u128> {
    env.sandbox.fast_forward(3).await?;
    Ok(account.view_account().await?.balance.as_yoctonear())
}

/// The contract's balance once refunds of failed transfers have landed.
async fn contract_balance(env: &Env) -> anyhow::Result<u128> {
    env.sandbox.fast_forward(3).await?;
    Ok(env.bounty.view_account().await?.balance.as_yoctonear())
}

async fn delete(env: &Env, account: &Account) -> anyhow::Result<()> {
    let root = env.sandbox.root_account()?;
    account
        .clone()
        .delete_account(root.id())
        .await?
        .into_result()?;
    Ok(())
}

async fn recreate(env: &Env, name: &str) -> anyhow::Result<Account> {
    Ok(env
        .sandbox
        .root_account()?
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?)
}

/// The full receipt record of transaction `result`.
async fn tx_status(
    env: &Env,
    result: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<Value> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "EXPERIMENTAL_tx_status", "params": {
        "tx_hash": result.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}});
    let tx: Value = reqwest::Client::new()
        .post(env.sandbox.rpc_addr())
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    Ok(tx["result"].clone())
}

fn receipt_outcome<'a>(tx: &'a Value, receipt: &Value) -> &'a Value {
    tx["receipts_outcome"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["id"] == receipt["receipt_id"])
        .expect("the receipt's outcome")
}

/// Every NEAR transfer the contract sent in transaction `result`: (recipient, amount, succeeded).
async fn contract_transfers(
    env: &Env,
    result: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<Vec<(String, u128, bool)>> {
    let tx = tx_status(env, result, signer).await?;
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
                let succeeded = receipt_outcome(&tx, &receipt)["outcome"]["status"]
                    .get("Failure")
                    .is_none();
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

/// For each call of the contract's own `method` in transaction `result`: (gas burnt, attached
/// gas, succeeded).
async fn self_calls(
    env: &Env,
    result: &ExecutionFinalResult,
    signer: &AccountId,
    method: &str,
) -> anyhow::Result<Vec<(u64, u64, bool)>> {
    let tx = tx_status(env, result, signer).await?;
    let mut out = Vec::new();
    for receipt in tx["receipts"].as_array().cloned().unwrap_or_default() {
        if receipt["receiver_id"] != env.bounty.id().as_str() {
            continue;
        }
        for action in receipt["receipt"]["Action"]["actions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            let call = &action["FunctionCall"];
            if call["method_name"] == method {
                let outcome = &receipt_outcome(&tx, &receipt)["outcome"];
                out.push((
                    outcome["gas_burnt"].as_u64().unwrap(),
                    call["gas"].as_u64().unwrap(),
                    outcome["status"].get("Failure").is_none(),
                ));
            }
        }
    }
    Ok(out)
}

/// Claims bounty `id` with claim seq `seq` and binds the pull request with seq `seq + 1`.
async fn claim_and_bind(env: &Env, id: u64, seq: u64) -> anyhow::Result<()> {
    let now = now_secs(env).await?;
    reply(
        env,
        "reply",
        Some(gist_reply(env, id, seq, GIST, good_gist())),
    )
    .await?;
    let claimed = prove(env, &env.contributor, id, GIST, now + 1800).await?;
    assert!(logged(&claimed, "outcome=claimed"), "{:?}", claimed.logs());
    reply(env, "reply", Some(pull_reply(env, id, seq + 1, None))).await?;
    let bound = call(
        &env.buyer,
        env,
        "nominate",
        json!({"bounty_id": id, "pr_number": PR}),
        RUN,
    )
    .await?;
    assert!(logged(&bound, "outcome=bound"), "{:?}", bound.logs());
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

fn recovered(result: &ExecutionFinalResult) -> bool {
    result.is_success() && result.clone().json::<bool>().unwrap_or(false)
}

fn transfer(state: &Value, kind: &str) -> Value {
    let key = match kind {
        "Reward" => "reward_transfer",
        _ => "budget_transfer",
    };
    state[key].clone()
}

fn assert_transfer(state: &Value, kind: &str, to: &AccountId, step: (&str, u32, &str)) {
    let t = transfer(state, kind);
    assert_eq!(t["to"], to.as_str(), "{kind} keeps its recorded recipient");
    assert_eq!(t["state"], step.0, "{kind}: {t}");
    assert_eq!(t["attempt"], step.1, "{kind}: {t}");
    assert_eq!(t["outcome"], step.2, "{kind}: {t}");
}

/// Runs a merge check that finds the pull request merged a second before the deadline.
async fn merge_before_deadline(
    env: &Env,
    id: u64,
    seq: u64,
    deadline: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    reply(
        env,
        "reply",
        Some(pull_reply(env, id, seq, Some(deadline - 1))),
    )
    .await?;
    let result = check(env, &env.stranger, id).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert!(logged(&result, "outcome=paid"), "{:?}", result.logs());
    Ok(result)
}

// ---- Normal build ----

#[tokio::test]
async fn an_eligible_contributor_is_paid_the_exact_reward_once() -> anyhow::Result<()> {
    let env = setup().await?;
    let storage_before = env.bounty.view_account().await?.storage_usage;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    claim_and_bind(&env, id, 1).await?;
    let state = bounty(&env, id).await?;
    assert_eq!(state["claim"]["wallet"], env.contributor.id().as_str());
    assert_eq!(state["claim"]["gist_id"], GIST);
    assert_eq!(state["claim"]["github_id"], GH.to_string());
    assert_eq!(state["claim"]["request_id"], "20001");
    assert_eq!(state["binding"]["pr_id"], PR_ID.to_string());
    assert_eq!(state["binding"]["request_id"], "20002");

    let (contributor_before, buyer_before) = (
        balance_of(&env, &env.contributor).await?,
        balance_of(&env, &env.buyer).await?,
    );
    let paid = merge_before_deadline(&env, id, 3, deadline).await?;
    assert!(logged(&paid, "outcome=paid request_id=20003"));
    // From the receipts: exactly the reward to the recorded wallet and the unused budget to the
    // maintainer, both succeeded, and nothing else left the contract.
    let sent = contract_transfers(&env, &paid, env.stranger.id()).await?;
    assert_eq!(
        sent,
        vec![
            (env.contributor.id().to_string(), REWARD, true),
            (env.buyer.id().to_string(), BUDGET, true),
        ]
    );
    assert_eq!(
        balance_of(&env, &env.contributor).await? - contributor_before,
        REWARD
    );
    assert_eq!(balance_of(&env, &env.buyer).await? - buyer_before, BUDGET);
    let state = bounty(&env, id).await?;
    assert_eq!(state["status"], "Paid");
    assert_transfer(
        &state,
        "Reward",
        env.contributor.id(),
        ("Done", 1, "Succeeded"),
    );
    assert_transfer(&state, "Budget", env.buyer.id(), ("Done", 1, "Succeeded"));
    assert_eq!(state["merge"]["merged_at"], (deadline - 1).to_string());
    assert_eq!(held(&env).await?, 0, "released once each, on confirmation");

    // Each transfer has both callbacks, and each fits its static gas with room to spare.
    for (method, limit) in [("on_transfer", 10), ("on_transfer_outcome", 5)] {
        let calls = self_calls(&env, &paid, env.stranger.id(), method).await?;
        assert_eq!(calls.len(), 2, "{method}: {calls:?}");
        for (burnt, attached, ok) in calls {
            println!("{method}: burnt {burnt} of {attached}");
            assert!(ok && attached == limit * TGAS, "{method}");
            assert!(
                burnt * 10 < attached * 8,
                "{method} burnt {burnt} of {attached}"
            );
        }
    }
    let on_check = self_calls(&env, &paid, env.stranger.id(), "on_check").await?;
    println!("on_check: {on_check:?}");
    assert!(on_check.len() == 1 && on_check[0].2 && on_check[0].0 < on_check[0].1);

    // The record at its largest fits the 0.02 NEAR storage deposit (2,000 bytes).
    let grown = env.bounty.view_account().await?.storage_usage - storage_before;
    println!("bounty record and its entries: {grown} bytes");
    assert!(grown <= 2_000, "{grown} bytes");

    // Paid once: no second check, no refund, nothing due, nothing to recover.
    assert_refused(
        &check(&env, &env.stranger, id).await?,
        "no bound pull request",
    );
    assert_refused(&settle(&env, id).await?, "cannot be refunded yet");
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    for kind in ["Reward", "Budget"] {
        assert_refused(
            &recover(&env, &env.stranger, id, kind).await?,
            "not waiting for its outcome",
        );
    }
    assert_eq!(
        balance_of(&env, &env.contributor).await? - contributor_before,
        REWARD
    );
    Ok(())
}

#[tokio::test]
async fn a_claim_needs_the_contributors_own_gist_with_this_exact_challenge() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _) = post(&env, 600, 900, 3_600, 600).await?;
    let (other, _) = post(&env, 600, 900, 3_600, 600).await?;
    let now = now_secs(&env).await?;
    let expires = now + 1800;

    // Expired, too far ahead, and malformed gist ids are refused before any run.
    assert_refused(
        &prove(&env, &env.contributor, id, GIST, now - 1).await?,
        "expires_at must be in the future",
    );
    assert_refused(
        &prove(&env, &env.contributor, id, GIST, now + 3_700).await?,
        "at most one hour ahead",
    );
    let long = "a".repeat(65);
    for bad in ["0123ABCD", "../gists", "", long.as_str()] {
        assert_refused(
            &prove(&env, &env.contributor, id, bad, expires).await?,
            "gist_id must be",
        );
    }

    // The run asks the verifier for the challenge of this caller, bounty and expiry.
    let challenge = |bounty: u64, wallet: &AccountId, expires_at: u64| {
        let view = env.bounty.view("claim_challenge").args_json(
            json!({"bounty_id": bounty, "wallet": wallet, "expires_at": expires_at.to_string()}),
        );
        async move { anyhow::Ok(view.await?.json::<String>()?) }
    };
    let mine = challenge(id, env.contributor.id(), expires).await?;
    let cases: Vec<(&Account, VGist, &str)> = vec![
        (
            &env.contributor,
            VGist {
                owner_id: OTHER_GH,
                ..good_gist()
            },
            "mismatch:owner_id",
        ),
        (
            &env.contributor,
            VGist {
                files: 2,
                challenge_matches: false,
                ..good_gist()
            },
            "mismatch:ambiguous",
        ),
        // Another wallet presenting the contributor's gist: its own challenge is not in it.
        (
            &env.stranger,
            VGist {
                challenge_matches: false,
                ..good_gist()
            },
            "mismatch:challenge",
        ),
    ];
    for (seq, (who, facts, outcome)) in (1u64..).zip(cases) {
        reply(&env, "reply", Some(gist_reply(&env, id, seq, GIST, facts))).await?;
        let run = prove(&env, who, id, GIST, expires).await?;
        assert!(
            logged(&run, &format!("outcome={outcome}")),
            "{:?}",
            run.logs()
        );
        let sent: Value = serde_json::from_str(
            &env.outlayer
                .view("get_last_request")
                .await?
                .json::<Option<String>>()?
                .unwrap(),
        )?;
        let input: Value = serde_json::from_str(sent["input_data"].as_str().unwrap())?;
        assert_eq!(input["op"], "gist");
        assert_eq!(input["gist_id"], GIST);
        assert_eq!(input["repo"], REPO);
        assert_eq!(input["challenge"], challenge(id, who.id(), expires).await?);
    }
    assert_ne!(challenge(id, env.stranger.id(), expires).await?, mine);
    assert_ne!(challenge(other, env.contributor.id(), expires).await?, mine);
    assert_ne!(
        challenge(id, env.contributor.id(), expires + 1).await?,
        mine
    );

    // An answer about another gist, and a valid answer for one bounty replayed for another.
    reply(
        &env,
        "reply",
        Some(gist_reply(&env, id, 4, OTHER_GIST, good_gist())),
    )
    .await?;
    let wrong_gist = prove(&env, &env.contributor, id, GIST, expires).await?;
    assert!(logged(&wrong_gist, "outcome=no_result:wrong_binding"));
    reply(
        &env,
        "reply",
        Some(gist_reply(&env, id, 5, GIST, good_gist())),
    )
    .await?;
    let replay = prove(&env, &env.contributor, other, GIST, expires).await?;
    assert!(logged(&replay, "outcome=no_result:wrong_binding"));
    assert_eq!(bounty(&env, id).await?["status"], "Open");
    assert_eq!(bounty(&env, other).await?["status"], "Open");

    // The contributor's own gist with the exact challenge fixes the claim, once.
    reply(
        &env,
        "reply",
        Some(gist_reply(&env, id, 6, GIST, good_gist())),
    )
    .await?;
    let claimed = prove(&env, &env.contributor, id, GIST, expires).await?;
    assert!(logged(&claimed, "outcome=claimed"), "{:?}", claimed.logs());
    let state = bounty(&env, id).await?;
    assert_eq!(state["status"], "Claimed");
    assert_eq!(state["claim"]["wallet"], env.contributor.id().as_str());
    assert_refused(
        &prove(&env, &env.stranger, id, GIST, expires).await?,
        "not open to claims",
    );

    // The nominated pull request must still be by the same GitHub account.
    let foreign = VPull {
        author_id: OTHER_GH,
        ..pull_facts(None)
    };
    reply(&env, "reply", Some(pull_reply_with(&env, id, 7, foreign))).await?;
    let nominate = json!({"bounty_id": id, "pr_number": PR});
    let refused = call(&env.buyer, &env, "nominate", nominate.clone(), RUN).await?;
    assert!(logged(&refused, "outcome=mismatch:author_id"));
    reply(&env, "reply", Some(pull_reply(&env, id, 8, None))).await?;
    let bound = call(&env.buyer, &env, "nominate", nominate, RUN).await?;
    assert!(logged(&bound, "outcome=bound"));
    Ok(())
}

#[tokio::test]
async fn only_the_approved_repository_can_be_posted() -> anyhow::Result<()> {
    let env = setup().await?;
    let config: Value = env.bounty.view("get_config").await?.json()?;
    assert_eq!(config["pilot_repo"], REPO);
    assert_eq!(config["pilot_repo_id"], REPO_ID.to_string());
    let times = (300, 600, 3_600, 600);
    for (repo, repo_id) in [
        // Another repository, by its own name and id.
        ("proven-test/other-repo", 800_000_002),
        // The approved id paired with another name, or the approved name with another id.
        ("proven-test/other-repo", REPO_ID),
        ("Proven-Test/Bounty-Pilot", REPO_ID),
        (REPO, 800_000_002),
    ] {
        assert_refused(
            &try_post(&env, repo, repo_id, times).await?,
            "only pays for its approved repository",
        );
    }
    assert_eq!(held(&env).await?, 0);
    assert!(try_post(&env, REPO, REPO_ID, times).await?.is_success());
    Ok(())
}

#[tokio::test]
async fn a_late_merge_is_ineligible_and_the_maintainer_is_refunded() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    reply(&env, "reply", Some(pull_reply(&env, id, 3, Some(deadline)))).await?;
    let late = check(&env, &env.stranger, id).await?;
    assert!(logged(&late, "outcome=ineligible:merged_after_deadline"));
    assert!(contract_transfers(&env, &late, env.stranger.id())
        .await?
        .is_empty());
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    let buyer_before = balance_of(&env, &env.buyer).await?;
    let refund = settle(&env, id).await?;
    assert!(refund.is_success());
    assert_eq!(
        contract_transfers(&env, &refund, env.stranger.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, true)]
    );
    assert_eq!(
        balance_of(&env, &env.buyer).await? - buyer_before,
        REWARD + BUDGET
    );
    let state = bounty(&env, id).await?;
    assert_eq!(state["status"], "Refunded");
    assert_transfer(&state, "Reward", env.buyer.id(), ("Done", 1, "Succeeded"));
    assert_eq!(held(&env).await?, 0);
    assert_refused(
        &check(&env, &env.stranger, id).await?,
        "no bound pull request",
    );
    Ok(())
}

#[tokio::test]
async fn an_unmerged_bounty_refunds_after_its_window_and_not_before() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, deadline) = post(&env, 60, 120, 180, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    reply(&env, "reply", Some(pull_reply(&env, id, 3, None))).await?;
    let pending = check(&env, &env.stranger, id).await?;
    assert!(logged(&pending, "outcome=pending"));
    assert_refused(&settle(&env, id).await?, "cannot be refunded yet");
    wait_past(&env, deadline + 600).await?;
    assert_refused(
        &check(&env, &env.stranger, id).await?,
        "verification window has ended",
    );
    let buyer_before = balance_of(&env, &env.buyer).await?;
    let refund = settle(&env, id).await?;
    assert_eq!(
        contract_transfers(&env, &refund, env.stranger.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, true)]
    );
    assert_eq!(
        balance_of(&env, &env.buyer).await? - buyer_before,
        REWARD + BUDGET
    );
    assert_eq!(held(&env).await?, 0);
    Ok(())
}

#[tokio::test]
async fn a_failed_payout_is_resent_only_to_the_same_wallet() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    // The contributor's wallet is deleted after the claim: the payout transfer will fail.
    delete(&env, &env.contributor).await?;
    let contract_before = contract_balance(&env).await?;
    let paid = merge_before_deadline(&env, id, 3, deadline).await?;
    let sent = contract_transfers(&env, &paid, env.stranger.id()).await?;
    assert_eq!(
        sent,
        vec![
            (env.contributor.id().to_string(), REWARD, false),
            (env.buyer.id().to_string(), BUDGET, true),
        ]
    );
    let state = bounty(&env, id).await?;
    assert_transfer(&state, "Reward", env.contributor.id(), ("Due", 1, "Failed"));
    assert_transfer(&state, "Budget", env.buyer.id(), ("Done", 1, "Succeeded"));
    assert_eq!(
        held(&env).await?,
        REWARD,
        "the failed reward stays reserved, once"
    );
    // Recovery has nothing to do: the bookkeeping callback ran.
    assert_refused(
        &recover(&env, &env.stranger, id, "Reward").await?,
        "not waiting for its outcome",
    );
    // The failed amount came back: only the budget (and no more) left the contract.
    let spent = contract_before - contract_balance(&env).await?;
    assert!(
        spent <= BUDGET && BUDGET - spent < 10 * MILLINEAR,
        "{spent}"
    );
    // The same wallet comes back; anyone resends; it receives exactly the reward.
    let back = recreate(&env, "contrib").await?;
    let before = balance_of(&env, &back).await?;
    let resend = send_due(&env, id).await?;
    assert_eq!(
        contract_transfers(&env, &resend, env.stranger.id()).await?,
        vec![(back.id().to_string(), REWARD, true)]
    );
    assert_eq!(balance_of(&env, &back).await? - before, REWARD);
    let state = bounty(&env, id).await?;
    assert_transfer(&state, "Reward", back.id(), ("Done", 2, "Succeeded"));
    assert_eq!(held(&env).await?, 0);
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    Ok(())
}

#[tokio::test]
async fn a_failed_refund_is_resent_only_to_the_maintainer() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    delete(&env, &env.buyer).await?;
    // Nobody can cancel for the deleted maintainer, but the bounty expires unclaimed.
    let claim_by = secs(&bounty(&env, id).await?["claim_by"]);
    wait_past(&env, claim_by + 15 * 60).await?;
    let refund = settle(&env, id).await?;
    assert_eq!(
        contract_transfers(&env, &refund, env.stranger.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, false)]
    );
    let state = bounty(&env, id).await?;
    assert_transfer(&state, "Reward", env.buyer.id(), ("Due", 1, "Failed"));
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    let back = recreate(&env, "maint").await?;
    let before = balance_of(&env, &back).await?;
    let resend = send_due(&env, id).await?;
    assert_eq!(
        contract_transfers(&env, &resend, env.stranger.id()).await?,
        vec![(back.id().to_string(), REWARD + BUDGET, true)]
    );
    assert_eq!(balance_of(&env, &back).await? - before, REWARD + BUDGET);
    assert_eq!(held(&env).await?, 0);
    Ok(())
}

#[tokio::test]
async fn forged_and_bad_answers_change_nothing() -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    let expires = now_secs(&env).await? + 1800;
    // Forged callbacks from an outside account.
    for (method, args) in [
        (
            "on_claim",
            json!({"bounty_id": id, "seq": "1", "wallet": env.stranger.id(), "gist_id": GIST, "requested_at": "0"}),
        ),
        ("on_check", json!({"bounty_id": id, "seq": "1"})),
        (
            "on_transfer",
            json!({"bounty_id": id, "kind": "Reward", "attempt": 1}),
        ),
        (
            "on_transfer_outcome",
            json!({"bounty_id": id, "kind": "Reward", "attempt": 1}),
        ),
    ] {
        assert_refused(
            &call(&env.stranger, &env, method, args, 0).await?,
            &format!("Method {method} is private"),
        );
    }
    // Timeouts, oversized replies and refused admissions.
    for (mode, body, outcome) in [
        ("null", None, "no_result:no_output"),
        ("reply", Some(" ".repeat(1025)), "no_result:oversized"),
        ("panic", None, "no_result:promise_failed"),
    ] {
        reply(&env, mode, body).await?;
        let run = prove(&env, &env.contributor, id, GIST, expires).await?;
        assert!(
            logged(&run, &format!("outcome={outcome}")),
            "{mode}: {:?}",
            run.logs()
        );
    }
    let state = bounty(&env, id).await?;
    assert_eq!(state["status"], "Open");
    assert!(state["claim"].is_null());
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    Ok(())
}

#[tokio::test]
async fn the_contributor_budget_is_bounded_and_refunds_unused_compute_to_the_maintainer(
) -> anyhow::Result<()> {
    let env = setup().await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    for (n, seq) in (1u128..).zip(3..6) {
        reply(&env, "reply", Some(pull_reply(&env, id, seq, None))).await?;
        let buyer_before = balance_of(&env, &env.buyer).await?;
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
        assert_eq!(
            balance_of(&env, &env.buyer).await? - buyer_before,
            RUN - MOCK_CHARGE
        );
        // A budget run's deposit leaves the contract, so it leaves the reserve.
        assert_eq!(held(&env).await?, REWARD + BUDGET - n * RUN);
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
    let paid_self = check(&env, &env.stranger, id).await?;
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
    assert_refused(
        &try_post(&env, REPO, REPO_ID, (300, 600, 3_600, 600)).await?,
        "new bounties are paused",
    );
    let _paid = merge_before_deadline(&env, id, 3, deadline).await?;
    assert_eq!(bounty(&env, id).await?["reward_transfer"]["state"], "Done");
    assert_eq!(held(&env).await?, 0);
    Ok(())
}

// ---- Fault build: every bookkeeping callback fails ----

#[tokio::test]
async fn a_payout_whose_bookkeeping_fails_is_finished_once_from_its_recorded_success(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    let (contributor_before, buyer_before) = (
        balance_of(&env, &env.contributor).await?,
        balance_of(&env, &env.buyer).await?,
    );
    let paid = merge_before_deadline(&env, id, 3, deadline).await?;
    // Both transfers went through; both bookkeeping callbacks failed; both outcomes were recorded.
    assert_eq!(
        contract_transfers(&env, &paid, env.stranger.id()).await?,
        vec![
            (env.contributor.id().to_string(), REWARD, true),
            (env.buyer.id().to_string(), BUDGET, true),
        ]
    );
    assert!(format!("{:?}", paid.failures()).contains("fault injection"));
    let state = bounty(&env, id).await?;
    assert_transfer(
        &state,
        "Reward",
        env.contributor.id(),
        ("Sending", 1, "Succeeded"),
    );
    assert_transfer(
        &state,
        "Budget",
        env.buyer.id(),
        ("Sending", 1, "Succeeded"),
    );
    assert_eq!(
        held(&env).await?,
        REWARD + BUDGET,
        "unconfirmed, still reserved"
    );
    // Nothing can send it again.
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    assert_refused(&settle(&env, id).await?, "cannot be refunded yet");

    // Recovery releases the reward once and sends nothing.
    let first = recover(&env, &env.stranger, id, "Reward").await?;
    assert!(recovered(&first), "{:?}", first.failures());
    assert!(contract_transfers(&env, &first, env.stranger.id())
        .await?
        .is_empty());
    assert_eq!(held(&env).await?, BUDGET);
    assert_refused(
        &recover(&env, &env.owner, id, "Reward").await?,
        "not waiting for its outcome",
    );
    assert_eq!(held(&env).await?, BUDGET);

    // Two recoveries of the budget at once: exactly one finishes it.
    let (a, b) = tokio::join!(
        recover(&env, &env.stranger, id, "Budget"),
        recover(&env, &env.owner, id, "Budget"),
    );
    let (a, b) = (a?, b?);
    assert_eq!(
        [recovered(&a), recovered(&b)]
            .iter()
            .filter(|r| **r)
            .count(),
        1
    );
    let loser = if recovered(&a) { &b } else { &a };
    assert_refused(loser, "not waiting for its outcome");
    assert_eq!(held(&env).await?, 0);
    let state = bounty(&env, id).await?;
    assert_transfer(
        &state,
        "Reward",
        env.contributor.id(),
        ("Done", 1, "Succeeded"),
    );
    assert_transfer(&state, "Budget", env.buyer.id(), ("Done", 1, "Succeeded"));
    assert_eq!(
        balance_of(&env, &env.contributor).await? - contributor_before,
        REWARD
    );
    assert_eq!(balance_of(&env, &env.buyer).await? - buyer_before, BUDGET);
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    Ok(())
}

#[tokio::test]
async fn a_failed_payout_whose_bookkeeping_fails_is_resent_once_to_the_same_wallet(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    delete(&env, &env.contributor).await?;
    let contract_before = contract_balance(&env).await?;
    let paid = merge_before_deadline(&env, id, 3, deadline).await?;
    assert_eq!(
        contract_transfers(&env, &paid, env.stranger.id()).await?,
        vec![
            (env.contributor.id().to_string(), REWARD, false),
            (env.buyer.id().to_string(), BUDGET, true),
        ]
    );
    let state = bounty(&env, id).await?;
    assert_transfer(
        &state,
        "Reward",
        env.contributor.id(),
        ("Sending", 1, "Failed"),
    );
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    // A failure recorded but not yet recovered is not resent.
    assert_refused(&send_due(&env, id).await?, "no transfer is due");

    // Recovering the failure makes it due again, still reserved, and sends nothing.
    let failed = recover(&env, &env.stranger, id, "Reward").await?;
    assert!(recovered(&failed));
    assert!(contract_transfers(&env, &failed, env.stranger.id())
        .await?
        .is_empty());
    assert!(recovered(
        &recover(&env, &env.stranger, id, "Budget").await?
    ));
    let state = bounty(&env, id).await?;
    assert_transfer(&state, "Reward", env.contributor.id(), ("Due", 1, "Failed"));
    assert_eq!(held(&env).await?, REWARD, "kept once, not added back");
    assert_refused(
        &recover(&env, &env.stranger, id, "Reward").await?,
        "not waiting for its outcome",
    );
    let spent = contract_before - contract_balance(&env).await?;
    assert!(
        spent <= BUDGET && BUDGET - spent < 10 * MILLINEAR,
        "{spent}"
    );

    // The same wallet comes back; the resend is attempt 2, to the same account, for the same amount.
    let back = recreate(&env, "contrib").await?;
    let before = balance_of(&env, &back).await?;
    let resend = send_due(&env, id).await?;
    assert_eq!(
        contract_transfers(&env, &resend, env.stranger.id()).await?,
        vec![(back.id().to_string(), REWARD, true)]
    );
    assert_transfer(
        &bounty(&env, id).await?,
        "Reward",
        back.id(),
        ("Sending", 2, "Succeeded"),
    );
    assert_eq!(held(&env).await?, REWARD);
    let (a, b) = tokio::join!(
        recover(&env, &env.stranger, id, "Reward"),
        recover(&env, &env.owner, id, "Reward"),
    );
    assert_eq!(
        [recovered(&a?), recovered(&b?)]
            .iter()
            .filter(|r| **r)
            .count(),
        1
    );
    assert_transfer(
        &bounty(&env, id).await?,
        "Reward",
        back.id(),
        ("Done", 2, "Succeeded"),
    );
    assert_eq!(held(&env).await?, 0);
    assert_eq!(
        balance_of(&env, &back).await? - before,
        REWARD,
        "paid exactly once"
    );
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    let spent = contract_before - contract_balance(&env).await?;
    assert!(
        spent <= REWARD + BUDGET && REWARD + BUDGET - spent < 10 * MILLINEAR,
        "{spent}"
    );
    Ok(())
}

#[tokio::test]
async fn a_refund_whose_bookkeeping_fails_is_finished_once_from_its_recorded_success(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    let before = balance_of(&env, &env.buyer).await?;
    let cancel = call(&env.buyer, &env, "cancel", json!({"bounty_id": id}), 0).await?;
    assert!(cancel.is_success(), "{:?}", cancel.failures());
    assert_eq!(
        contract_transfers(&env, &cancel, env.buyer.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, true)]
    );
    let state = bounty(&env, id).await?;
    assert_eq!(state["status"], "Cancelled");
    assert_transfer(
        &state,
        "Reward",
        env.buyer.id(),
        ("Sending", 1, "Succeeded"),
    );
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    let (a, b) = tokio::join!(
        recover(&env, &env.stranger, id, "Reward"),
        recover(&env, &env.owner, id, "Reward"),
    );
    assert_eq!(
        [recovered(&a?), recovered(&b?)]
            .iter()
            .filter(|r| **r)
            .count(),
        1
    );
    assert_eq!(held(&env).await?, 0);
    assert_transfer(
        &bounty(&env, id).await?,
        "Reward",
        env.buyer.id(),
        ("Done", 1, "Succeeded"),
    );
    // The maintainer got the refund once (less the gas of the cancel call itself).
    let gained = balance_of(&env, &env.buyer).await? - before;
    assert!(
        gained <= REWARD + BUDGET && REWARD + BUDGET - gained < 5 * MILLINEAR,
        "{gained}"
    );
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    Ok(())
}

#[tokio::test]
async fn a_failed_refund_whose_bookkeeping_fails_is_resent_once_to_the_maintainer(
) -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    let (id, _) = post(&env, 300, 600, 3_600, 600).await?;
    delete(&env, &env.buyer).await?;
    let claim_by = secs(&bounty(&env, id).await?["claim_by"]);
    wait_past(&env, claim_by + 15 * 60).await?;
    let contract_before = contract_balance(&env).await?;
    let refund = settle(&env, id).await?;
    assert_eq!(
        contract_transfers(&env, &refund, env.stranger.id()).await?,
        vec![(env.buyer.id().to_string(), REWARD + BUDGET, false)]
    );
    assert_transfer(
        &bounty(&env, id).await?,
        "Reward",
        env.buyer.id(),
        ("Sending", 1, "Failed"),
    );
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    assert!(recovered(
        &recover(&env, &env.stranger, id, "Reward").await?
    ));
    assert_transfer(
        &bounty(&env, id).await?,
        "Reward",
        env.buyer.id(),
        ("Due", 1, "Failed"),
    );
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    // Nothing left the contract: the failed refund came back and is still owed.
    assert!(contract_before <= contract_balance(&env).await?);

    let back = recreate(&env, "maint").await?;
    let before = balance_of(&env, &back).await?;
    let resend = send_due(&env, id).await?;
    assert_eq!(
        contract_transfers(&env, &resend, env.stranger.id()).await?,
        vec![(back.id().to_string(), REWARD + BUDGET, true)]
    );
    assert!(recovered(
        &recover(&env, &env.stranger, id, "Reward").await?
    ));
    assert_refused(
        &recover(&env, &env.owner, id, "Reward").await?,
        "not waiting for its outcome",
    );
    assert_transfer(
        &bounty(&env, id).await?,
        "Reward",
        back.id(),
        ("Done", 2, "Succeeded"),
    );
    assert_eq!(held(&env).await?, 0);
    assert_eq!(balance_of(&env, &back).await? - before, REWARD + BUDGET);
    assert_refused(&send_due(&env, id).await?, "no transfer is due");
    Ok(())
}

#[tokio::test]
async fn the_total_cap_holds_while_a_transfer_is_unconfirmed() -> anyhow::Result<()> {
    let env = setup_with(FAULT_WASM).await?;
    // Room for exactly one bounty.
    env.owner
        .call(env.bounty.id(), "set_caps")
        .args_json(json!({
            "max_reward": REWARD.to_string(), "max_held": (REWARD + BUDGET).to_string(),
            "max_open_per_buyer": 3,
        }))
        .transact()
        .await?
        .into_result()?;
    let times = (300, 600, 3_600, 600);
    let (id, deadline) = post(&env, 300, 600, 3_600, 600).await?;
    assert_refused(
        &try_post(&env, REPO, REPO_ID, times).await?,
        "total cap is reached",
    );
    claim_and_bind(&env, id, 1).await?;
    delete(&env, &env.contributor).await?;
    // The payout leaves: the reward fails, the budget succeeds, neither is confirmed yet.
    let paid = merge_before_deadline(&env, id, 3, deadline).await?;
    assert_eq!(
        contract_transfers(&env, &paid, env.stranger.id()).await?,
        vec![
            (env.contributor.id().to_string(), REWARD, false),
            (env.buyer.id().to_string(), BUDGET, true),
        ]
    );
    let blocked = |label: &'static str| {
        let env = &env;
        async move {
            assert_refused(
                &try_post(env, REPO, REPO_ID, times).await?,
                "total cap is reached",
            );
            println!("posting refused while {label}");
            anyhow::Ok(())
        }
    };
    // Posting into the headroom the transfers seem to have freed is refused.
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    blocked("both transfers are in flight").await?;
    assert!(recovered(
        &recover(&env, &env.stranger, id, "Reward").await?
    ));
    assert_eq!(
        held(&env).await?,
        REWARD + BUDGET,
        "a failure stays reserved"
    );
    blocked("the reward is due again").await?;
    assert!(recovered(
        &recover(&env, &env.stranger, id, "Budget").await?
    ));
    assert_eq!(held(&env).await?, REWARD, "the budget released once");
    blocked("the reward is due again and the budget is done").await?;
    let back = recreate(&env, "contrib").await?;
    let before = balance_of(&env, &back).await?;
    assert!(send_due(&env, id).await?.is_success());
    assert_eq!(held(&env).await?, REWARD, "a resend is not counted twice");
    blocked("the resend is in flight").await?;
    assert!(recovered(
        &recover(&env, &env.stranger, id, "Reward").await?
    ));
    assert_eq!(held(&env).await?, 0, "the reward released once");
    assert_eq!(balance_of(&env, &back).await? - before, REWARD);
    // Exactly one bounty's capacity came back.
    assert!(try_post(&env, REPO, REPO_ID, times).await?.is_success());
    assert_eq!(held(&env).await?, REWARD + BUDGET);
    blocked("the new bounty fills the cap").await?;
    Ok(())
}

// ---- Fault-both build: both callbacks fail ----

#[tokio::test]
async fn without_a_recorded_outcome_nothing_is_resent_or_released() -> anyhow::Result<()> {
    let env = setup_with(FAULT_BOTH_WASM).await?;
    let (id, deadline) = post(&env, 60, 120, 180, 600).await?;
    claim_and_bind(&env, id, 1).await?;
    let before = balance_of(&env, &env.contributor).await?;
    let paid = merge_before_deadline(&env, id, 3, deadline).await?;
    assert!(contract_transfers(&env, &paid, env.stranger.id())
        .await?
        .contains(&(env.contributor.id().to_string(), REWARD, true)));
    assert_eq!(balance_of(&env, &env.contributor).await? - before, REWARD);
    let state = bounty(&env, id).await?;
    assert_transfer(
        &state,
        "Reward",
        env.contributor.id(),
        ("Sending", 1, "Unknown"),
    );
    // However long it waits, with no outcome nothing resends, refunds or releases the reserve.
    for _ in 0..2 {
        for kind in ["Reward", "Budget"] {
            assert_refused(
                &recover(&env, &env.stranger, id, kind).await?,
                "no outcome is recorded",
            );
        }
        assert_refused(&send_due(&env, id).await?, "no transfer is due");
        assert_refused(&settle(&env, id).await?, "cannot be refunded yet");
        assert_eq!(held(&env).await?, REWARD + BUDGET, "stranded, not released");
        wait_past(&env, deadline + 1_200).await?;
    }
    assert_eq!(
        balance_of(&env, &env.contributor).await? - before,
        REWARD,
        "paid exactly once"
    );
    Ok(())
}
