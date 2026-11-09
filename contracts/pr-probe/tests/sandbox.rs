//! Sandbox tests of the probe against Proven's mock OutLayer contract. They cover the promise and
//! callback path the unit tests cannot: the private callback guard, a refused admission, a failed
//! run and a malformed answer. Build both first: `cargo near build non-reproducible-wasm` in
//! `contracts/pr-probe` and in `contracts/mock-outlayer`.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const PROBE_WASM: &str = "target/near/proven_pr_probe.wasm";
const MOCK_WASM: &str = "../mock-outlayer/target/near/proven_mock_outlayer.wasm";
const VERSION: &str = "b8ae4fd3a60ef8f8fb9eab77f2f9a65f6bbfdd4b1ff6024e086f1fdd72e8379b";
const REPO: &str = "proven-test/pr-bounty-pilot";

struct Env {
    _sandbox: Worker<Sandbox>,
    probe: Contract,
    outlayer: Contract,
    owner: Account,
    stranger: Account,
}

fn read_wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| {
        anyhow::anyhow!("{path}: {e}; build it with `cargo near build non-reproducible-wasm`")
    })
}

async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let probe = sandbox.dev_deploy(&read_wasm(PROBE_WASM)?).await?;
    let outlayer = sandbox.dev_deploy(&read_wasm(MOCK_WASM)?).await?;
    let owner = sandbox.dev_create_account().await?;
    let stranger = sandbox.dev_create_account().await?;
    outlayer.call("new").transact().await?.into_result()?;
    probe
        .call("new")
        .args_json(json!({
            "owner": owner.id(), "outlayer": outlayer.id(),
            "project_id": "connectors.outlayer.testnet/github", "version_key": VERSION,
            "secrets_owner": owner.id(), "secrets_profile": "github",
            "repo": REPO, "price_usd": "1000",
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Env {
        _sandbox: sandbox,
        probe,
        outlayer,
        owner,
        stranger,
    })
}

async fn behave(env: &Env, behaviour: &str) -> anyhow::Result<()> {
    env.outlayer
        .call("set_behaviour")
        .args_json(json!({ "behaviour": behaviour }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn read_pr(env: &Env, who: &Account, number: u64) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.probe.id(), "read_pr")
        .args_json(json!({ "number": number }))
        .deposit(NearToken::from_millinear(10))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

async fn reading(env: &Env, index: u32) -> anyhow::Result<Value> {
    Ok(env
        .probe
        .view("get_reading")
        .args_json(json!({ "index": index }))
        .await?
        .json()?)
}

fn assert_refused(result: &ExecutionFinalResult, message: &str) {
    let failure = format!("{:?}", result.clone().into_result().expect_err("refused"));
    assert!(
        failure.contains(message),
        "expected {message:?} in {failure}"
    );
}

#[tokio::test]
async fn a_failed_run_is_recorded_as_no_result_through_the_private_callback() -> anyhow::Result<()>
{
    let env = setup().await?;
    behave(&env, "null").await?;
    read_pr(&env, &env.owner, 7).await?.into_result()?;
    assert_eq!(
        reading(&env, 0).await?["outcome"],
        json!({"NoResult": {"reason": "no_output"}})
    );
    let request: Value = serde_json::from_str(
        &env.outlayer
            .view("get_last_request")
            .await?
            .json::<Option<String>>()?
            .expect("a request"),
    )?;
    assert_eq!(request["predecessor"], env.probe.id().to_string());
    assert_eq!(
        request["source"],
        json!({"Project": {"project_id": "connectors.outlayer.testnet/github", "version_key": VERSION}})
    );
    let input: Value = serde_json::from_str(request["input_data"].as_str().expect("input"))?;
    assert_eq!(
        input,
        json!({"operation": "pr_get", "repo": REPO, "number": 7})
    );
    Ok(())
}

#[tokio::test]
async fn a_refused_admission_and_a_malformed_answer_are_no_result() -> anyhow::Result<()> {
    let env = setup().await?;
    behave(&env, "panic").await?;
    // The transaction succeeds: the callback records the failed admission.
    read_pr(&env, &env.owner, 7).await?.into_result()?;
    assert_eq!(
        reading(&env, 0).await?["outcome"],
        json!({"NoResult": {"reason": "promise_failed"}})
    );
    behave(&env, "malformed").await?;
    read_pr(&env, &env.owner, 7).await?.into_result()?;
    assert_eq!(
        reading(&env, 1).await?["outcome"],
        json!({"NoResult": {"reason": "malformed"}})
    );
    Ok(())
}

#[tokio::test]
async fn only_the_probe_delivers_results_and_only_the_owner_reads() -> anyhow::Result<()> {
    let env = setup().await?;
    read_pr(&env, &env.owner, 7).await?.into_result()?;
    let forged = env
        .stranger
        .call(env.probe.id(), "on_pr_read")
        .args_json(json!({ "index": 0 }))
        .transact()
        .await?;
    assert_refused(&forged, "Method on_pr_read is private");
    assert_refused(&read_pr(&env, &env.stranger, 7).await?, "only the owner");
    Ok(())
}
