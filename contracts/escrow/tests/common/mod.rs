//! Shared setup and helpers for the sandbox tests.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub const SPEC: &str = "1111111111111111111111111111111111111111111111111111111111111111";
pub const FAKES: &str = "2222222222222222222222222222222222222222222222222222222222222222";
pub const DELIVERABLE: &str = "3333333333333333333333333333333333333333333333333333333333333333";
pub const VERIFIER_URL: &str = "https://example.test/verifier.wasm";
pub const VERIFIER: &str = "5555555555555555555555555555555555555555555555555555555555555555";
pub const ESCROW_WASM: &str = "target/near/proven_escrow.wasm";
pub const MOCK_WASM: &str = "../mock-outlayer/target/near/proven_mock_outlayer.wasm";
pub const SEC: u64 = 1_000_000_000;
pub const WINDOW_SECS: u64 = 1_800;
/// What the escrow attaches for each run, from the job's compute budget.
pub const RUN_DEPOSIT: NearToken = NearToken::from_millinear(10);
pub const FORMAT: &str = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

pub struct Env {
    pub sandbox: Worker<Sandbox>,
    pub escrow: Contract,
    /// Stands in for the board: the only account that can create jobs and assign workers.
    pub board: Account,
    pub outlayer: Contract,
    pub owner: Account,
    pub secrets_owner: Account,
    pub buyer: Account,
    pub worker: Account,
    pub stranger: Account,
}

pub fn read_wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| {
        anyhow::anyhow!("{path}: {e}; build it with `cargo near build non-reproducible-wasm`")
    })
}

pub async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let escrow = sandbox.dev_deploy(&read_wasm(ESCROW_WASM)?).await?;
    let outlayer = sandbox.dev_deploy(&read_wasm(MOCK_WASM)?).await?;
    let owner = sandbox.dev_create_account().await?;
    let secrets_owner = sandbox.dev_create_account().await?;
    let buyer = sandbox.dev_create_account().await?;
    let worker = sandbox.dev_create_account().await?;
    let stranger = sandbox.dev_create_account().await?;
    let board = sandbox.dev_create_account().await?;

    outlayer.call("new").transact().await?.into_result()?;
    escrow
        .call("new")
        .args_json(json!({
            "owner": owner.id(), "outlayer": outlayer.id(), "board": board.id(), "verifier_url": VERIFIER_URL,
            "verifier_hash": VERIFIER, "secrets_owner": secrets_owner.id(),
            "run_deposit": RUN_DEPOSIT.as_yoctonear().to_string(),
            "max_job_amount": (1_000 * NearToken::from_near(1).as_yoctonear()).to_string(),
            "max_held": (10_000 * NearToken::from_near(1).as_yoctonear()).to_string(),
            "max_held_per_buyer": (10_000 * NearToken::from_near(1).as_yoctonear()).to_string(),
        }))
        .transact()
        .await?
        .into_result()?;

    Ok(Env {
        sandbox,
        escrow,
        board,
        outlayer,
        owner,
        secrets_owner,
        buyer,
        worker,
        stranger,
    })
}

pub async fn now(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp())
}

/// Produces blocks until the chain's clock is past `target` nanoseconds.
pub async fn advance_past(env: &Env, target: u64) -> anyhow::Result<()> {
    for _ in 0..200 {
        if now(env).await? > target {
            return Ok(());
        }
        env.sandbox.fast_forward(2_000).await?;
    }
    anyhow::bail!("sandbox clock did not pass {target}")
}

pub async fn behave(env: &Env, behaviour: &str) -> anyhow::Result<()> {
    env.outlayer
        .call("set_behaviour")
        .args_json(json!({ "behaviour": behaviour }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn call(
    env: &Env,
    who: &Account,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.escrow.id(), method)
        .args_json(args)
        .deposit(deposit)
        .max_gas()
        .transact()
        .await?)
}

/// The compute budget a job with this many attempts brings.
pub fn budget(attempts: u32) -> u128 {
    RUN_DEPOSIT.as_yoctonear() * u128::from(2 + 2 * attempts)
}

/// The board posts a job for the buyer, with one attempt. `deliver_secs` is each worker's time.
pub async fn create_job(env: &Env, deliver_secs: u64, amount: u128) -> anyhow::Result<u64> {
    create_job_with(env, deliver_secs, amount, 1).await
}

pub async fn create_job_with(
    env: &Env,
    deliver_secs: u64,
    amount: u128,
    attempts: u32,
) -> anyhow::Result<u64> {
    let expires_at = now(env).await? + 2 * 24 * 3_600 * SEC;
    let args = json!({
        "buyer": env.buyer.id(), "spec_hash": SPEC, "fakes_hash": FAKES, "format_hash": FORMAT,
        "amount": amount.to_string(), "verifier_hash": VERIFIER, "expires_at": expires_at.to_string(),
        "deliver_secs": deliver_secs, "verdict_window_secs": WINDOW_SECS, "max_attempts": attempts,
    });
    let deposit = NearToken::from_yoctonear(amount + budget(attempts))
        .saturating_add(NearToken::from_millinear(50));
    Ok(call(env, &env.board, "create_open_job", args, deposit)
        .await?
        .into_result()?
        .json()?)
}

/// Triggers a run as the relay, the account that holds the job's texts.
pub async fn run(env: &Env, method: &str, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        &env.secrets_owner,
        method,
        json!({ "job_id": id }),
        NO_DEPOSIT,
    )
    .await
}

pub async fn challenge(env: &Env, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    run(env, "request_challenge", id).await
}

pub async fn verify(env: &Env, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    run(env, "request_verification", id).await
}

/// The board gives the job to the worker. The money is already held.
pub async fn assign(env: &Env, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        &env.board,
        "assign",
        json!({ "job_id": id, "worker": env.worker.id() }),
        NO_DEPOSIT,
    )
    .await
}

pub async fn deliver(env: &Env, who: &Account, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        who,
        "deliver",
        json!({ "job_id": id, "deliverable_hash": DELIVERABLE }),
        NO_DEPOSIT,
    )
    .await
}

/// A payout called by the stranger, so the receiver's balance changes by exactly the amount.
pub async fn payout(env: &Env, method: &str, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(
        env,
        &env.stranger,
        method,
        json!({ "job_id": id }),
        NO_DEPOSIT,
    )
    .await
}

pub async fn job(env: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(env
        .escrow
        .view("get_job")
        .args_json(json!({ "job_id": id }))
        .await?
        .json()?)
}

pub async fn state(env: &Env, id: u64) -> anyhow::Result<String> {
    Ok(job(env, id).await?["state"]
        .as_str()
        .unwrap_or("none")
        .to_string())
}

pub async fn last_request(env: &Env) -> anyhow::Result<Value> {
    let text: String = env.outlayer.view("get_last_request").await?.json()?;
    Ok(serde_json::from_str(&text)?)
}

pub async fn near_balance(account: &Account) -> anyhow::Result<u128> {
    Ok(account.view_account().await?.balance.as_yoctonear())
}

pub fn assert_refused(result: &ExecutionFinalResult, reason: &str) {
    assert!(
        result.is_failure(),
        "expected a refusal containing {reason:?}"
    );
    let failure = format!("{:?}", result.clone().into_result().unwrap_err());
    assert!(
        failure.contains(reason),
        "expected {reason:?}, got {failure}"
    );
}

/// A job through a passing challenge and into `Delivered`, paid in NEAR.
pub async fn delivered_near_job(env: &Env, deadline_secs: u64) -> anyhow::Result<u64> {
    let id = create_job(env, deadline_secs, NearToken::from_near(1).as_yoctonear()).await?;
    behave(env, "strong_check").await?;
    challenge(env, id).await?.into_result()?;
    assign(env, id).await?.into_result()?;
    deliver(env, &env.worker, id).await?.into_result()?;
    Ok(id)
}

/// Gas just under what a run requires.
pub fn too_little_gas() -> Gas {
    Gas::from_tgas(149)
}

/// The buyer pays for `runs` more runs.
pub async fn top_up(env: &Env, id: u64, runs: u128) -> anyhow::Result<()> {
    call(
        env,
        &env.buyer,
        "top_up",
        json!({ "job_id": id }),
        NearToken::from_yoctonear(RUN_DEPOSIT.as_yoctonear() * runs),
    )
    .await?
    .into_result()?;
    Ok(())
}

/// What is left of a job's compute budget.
pub async fn budget_left(env: &Env, id: u64) -> anyhow::Result<u128> {
    Ok(job(env, id).await?["compute_budget"]
        .as_str()
        .unwrap_or("0")
        .parse()?)
}
