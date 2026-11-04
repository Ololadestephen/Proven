//! Shared setup and helpers for the sandbox tests.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

pub const SPEC: &str = "1111111111111111111111111111111111111111111111111111111111111111";
pub const FAKES: &str = "2222222222222222222222222222222222222222222222222222222222222222";
pub const DELIVERABLE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
pub const REPORT: &str = "4444444444444444444444444444444444444444444444444444444444444444";
pub const ATTESTATION: &str = "5555555555555555555555555555555555555555555555555555555555555555";
pub const ESCROW_WASM: &str = "target/near/proven_escrow.wasm";
pub const TOKEN_WASM: &str = "../test-token/target/near/proven_test_token.wasm";
pub const SEC: u64 = 1_000_000_000;
/// One pUSD has 6 decimals.
pub const TOKEN_AMOUNT: u128 = 25_000_000;

pub struct Env {
    pub sandbox: Worker<Sandbox>,
    pub escrow: Contract,
    pub token: Contract,
    pub relay: Account,
    pub buyer: Account,
    pub worker: Account,
    pub stranger: Account,
}

pub fn read_wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}; build it with `cargo near build non-reproducible-wasm`"))
}

pub async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let escrow = sandbox.dev_deploy(&read_wasm(ESCROW_WASM)?).await?;
    let token = sandbox.dev_deploy(&read_wasm(TOKEN_WASM)?).await?;
    let owner = sandbox.dev_create_account().await?;
    let relay = sandbox.dev_create_account().await?;
    let buyer = sandbox.dev_create_account().await?;
    let worker = sandbox.dev_create_account().await?;
    let stranger = sandbox.dev_create_account().await?;

    escrow.call("new").args_json(json!({ "owner": owner.id(), "relay": relay.id() })).transact().await?.into_result()?;
    owner.call(escrow.id(), "add_token").args_json(json!({ "token": token.id() })).transact().await?.into_result()?;
    token
        .call("new")
        .args_json(json!({ "owner_id": buyer.id(), "total_supply": (1_000 * TOKEN_AMOUNT).to_string() }))
        .transact()
        .await?
        .into_result()?;
    // The escrow must be registered with the token to receive it. The worker is registered per test.
    register(&token, &buyer, escrow.id()).await?;

    Ok(Env { sandbox, escrow, token, relay, buyer, worker, stranger })
}

pub async fn register(token: &Contract, payer: &Account, account: &near_workspaces::AccountId) -> anyhow::Result<()> {
    payer
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": account }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn now(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp())
}

/// Produces blocks until the chain's clock is past `target` nanoseconds.
pub async fn advance_past(env: &Env, target: u64) -> anyhow::Result<()> {
    for _ in 0..100 {
        if now(env).await? > target {
            return Ok(());
        }
        env.sandbox.fast_forward(200).await?;
    }
    anyhow::bail!("sandbox clock did not pass {target}")
}

pub async fn call(env: &Env, who: &Account, method: &str, args: Value, deposit: NearToken) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who.call(env.escrow.id(), method).args_json(args).deposit(deposit).max_gas().transact().await?)
}

pub async fn create_job(env: &Env, token: bool, deadline_secs: u64, window_secs: u32, amount: u128) -> anyhow::Result<u64> {
    let deadline = now(env).await? + deadline_secs * SEC;
    let args = json!({
        "worker": env.worker.id(), "spec_hash": SPEC, "fakes_hash": FAKES,
        "amount": amount.to_string(), "token": if token { Some(env.token.id()) } else { None },
        "deadline": deadline.to_string(), "verdict_window_secs": window_secs,
    });
    Ok(call(env, &env.buyer, "create_job", args, NearToken::from_millinear(50)).await?.into_result()?.json()?)
}

pub async fn challenge(env: &Env, id: u64, total: u32, caught: u32) -> anyhow::Result<ExecutionFinalResult> {
    let args = json!({
        "job_id": id, "spec_hash": SPEC, "fakes_hash": FAKES, "reference_passed": true, "fakes_total": total, "fakes_caught": caught,
        "report_hash": REPORT, "attestation_hash": ATTESTATION,
    });
    call(env, &env.relay, "record_challenge", args, NearToken::from_yoctonear(0)).await
}

pub async fn fund_near(env: &Env, id: u64, amount: NearToken) -> anyhow::Result<ExecutionFinalResult> {
    call(env, &env.buyer, "fund", json!({ "job_id": id }), amount).await
}

pub async fn fund_token(env: &Env, id: u64, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .buyer
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": env.escrow.id(), "amount": amount.to_string(), "msg": id.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

pub async fn deliver(env: &Env, who: &Account, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(env, who, "deliver", json!({ "job_id": id, "deliverable_hash": DELIVERABLE }), NearToken::from_yoctonear(0)).await
}

pub async fn verdict(env: &Env, who: &Account, id: u64, pass: bool, deliverable: &str) -> anyhow::Result<ExecutionFinalResult> {
    let args = json!({
        "job_id": id, "pass": pass, "spec_hash": SPEC, "deliverable_hash": deliverable,
        "report_hash": REPORT, "attestation_hash": ATTESTATION,
    });
    call(env, who, "record_verdict", args, NearToken::from_yoctonear(0)).await
}

/// A payout called by the stranger, so the receiver's balance changes by exactly the amount.
pub async fn payout(env: &Env, method: &str, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(env, &env.stranger, method, json!({ "job_id": id }), NearToken::from_yoctonear(0)).await
}

pub async fn job(env: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(env.escrow.view("get_job").args_json(json!({ "job_id": id })).await?.json()?)
}

pub async fn state(env: &Env, id: u64) -> anyhow::Result<String> {
    Ok(job(env, id).await?["state"].as_str().unwrap_or("none").to_string())
}

pub async fn near_balance(account: &Account) -> anyhow::Result<u128> {
    Ok(account.view_account().await?.balance.as_yoctonear())
}

pub async fn token_balance(env: &Env, account: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    let balance: String = env.token.view("ft_balance_of").args_json(json!({ "account_id": account })).await?.json()?;
    Ok(balance.parse()?)
}

pub fn assert_refused(result: &ExecutionFinalResult, reason: &str) {
    assert!(result.is_failure(), "expected a refusal containing {reason:?}");
    let failure = format!("{:?}", result.clone().into_result().unwrap_err());
    assert!(failure.contains(reason), "expected {reason:?}, got {failure}");
}

pub async fn funded_near_job(env: &Env, deadline_secs: u64, window_secs: u32) -> anyhow::Result<u64> {
    let id = create_job(env, false, deadline_secs, window_secs, NearToken::from_near(1).as_yoctonear()).await?;
    challenge(env, id, 6, 6).await?.into_result()?;
    fund_near(env, id, NearToken::from_near(1)).await?.into_result()?;
    Ok(id)
}
