//! Sandbox tests of the probe's promise and callback path against a mock OutLayer that returns
//! answers made by the verifier's own `render` from a real GitHub answer. Build both first:
//! `cargo near build non-reproducible-wasm` in `contracts/pr-verify-probe` and in
//! `contracts/mock-outlayer-reply`.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use proven_pr_verifier as verifier;
use serde_json::{json, Value};

const PROBE_WASM: &str = "target/near/proven_pr_verify_probe.wasm";
const MOCK_WASM: &str = "../mock-outlayer-reply/target/near/proven_mock_outlayer_reply.wasm";
const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
const HASH: &str = "bb6c733f65ea2682bf96c54b6b4f58468a9b328e511c96b8560dc2fb54b1c90c";
const REPO: &str = "near/near-sdk-rs";
const MERGED_PR: &str =
    include_str!("../../../pr-verifier/tests/fixtures/near-sdk-rs-pr-1669.json");
const MERGED_AT: u64 = 1_793_821_703;

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
            "verifier_url": URL, "verifier_hash": HASH,
            "repo": REPO, "repo_id": "190815700",
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

/// The verifier's answer to `reading`, as a run requested by the probe would print it.
fn answer(env: &Env, reading: u32) -> String {
    let request = verifier::Request {
        v: 1,
        probe: env.probe.id().to_string(),
        reading,
        repo: REPO.to_string(),
        number: 1669,
    };
    let context =
        verifier::RunContext::from_vars(Some(env.probe.id().to_string()), Some("8812".to_string()));
    verifier::render(
        Some(&request),
        &context,
        verifier::parse_pull(MERGED_PR.as_bytes()),
    )
}

fn expect(merged_by: u64) -> Value {
    json!({
        "pr_id": "5125170190", "author_id": "163825889", "base_ref": "master",
        "merged_after": "1793577600", "merged_by": merged_by.to_string(),
    })
}

async fn reply(env: &Env, mode: &str, reply: Option<String>) -> anyhow::Result<()> {
    env.outlayer
        .call("set_reply")
        .args_json(json!({ "mode": mode, "reply": reply }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn read_pr(env: &Env, who: &Account, merged_by: u64) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.probe.id(), "read_pr")
        .args_json(json!({ "number": 1669, "expect": expect(merged_by) }))
        .deposit(NearToken::from_millinear(10))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

async fn reading(env: &Env, index: u32) -> anyhow::Result<Value> {
    Ok(env
        .probe
        .view("get_reading")
        .args_json(json!({ "reading": index }))
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
async fn an_in_window_merge_is_confirmed_and_a_late_one_is_a_mismatch() -> anyhow::Result<()> {
    let env = setup().await?;
    reply(&env, "reply", Some(answer(&env, 0))).await?;
    let before = env.owner.view_account().await?.balance;
    let result = read_pr(&env, &env.owner, 1_793_836_800)
        .await?
        .into_result()?;
    // Let the gas refund receipts land before reading the balance.
    env._sandbox.fast_forward(5).await?;
    let spent = before.saturating_sub(env.owner.view_account().await?.balance);
    let first = reading(&env, 0).await?;
    assert_eq!(
        first["outcome"]["Confirmed"]["facts"]["merged_at"],
        MERGED_AT.to_string()
    );
    assert_eq!(
        first["outcome"]["Confirmed"]["facts"]["author_id"],
        "163825889"
    );
    assert_eq!(first["request_id"], "8812");
    assert!(result
        .logs()
        .iter()
        .any(|l| l.contains("read_resolved reading=0 outcome=confirmed request_id=8812")));
    // The mock keeps 0.001 NEAR of the 0.01 attached and refunds the rest to the owner, who
    // also pays the gas burnt.
    assert!(spent < NearToken::from_millinear(9), "spent {spent}");
    println!("owner spent {spent} on one read");

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
        json!({"WasmUrl": {"url": URL, "hash": HASH, "build_target": "wasm32-wasip2"}})
    );
    assert!(request["secrets_ref"].is_null() && request["params"].is_null());

    reply(&env, "reply", Some(answer(&env, 1))).await?;
    read_pr(&env, &env.owner, MERGED_AT - 1)
        .await?
        .into_result()?;
    assert_eq!(
        reading(&env, 1).await?["outcome"]["Mismatch"]["field"],
        "merged_after_window"
    );
    Ok(())
}

/// The exact line the built verifier WASM printed under wasmtime 28 (`-S http`, the worker's
/// runtime version) when it read pull request 1669 from api.github.com for `pr-verify.test.near`
/// on November 9, 2026, with `NEAR_PREDECESSOR_ID` and `NEAR_REQUEST_ID=4242` set as a worker
/// would set them.
const VERIFIER_RUN: &str = include_str!("fixtures/verifier-run-1669.json");

#[tokio::test]
async fn the_built_verifiers_real_answer_is_confirmed() -> anyhow::Result<()> {
    let sandbox = near_workspaces::sandbox().await?;
    let root = sandbox.root_account()?;
    let host = root
        .create_subaccount("pr-verify")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(host.id().as_str(), "pr-verify.test.near");
    let probe = host.deploy(&read_wasm(PROBE_WASM)?).await?.into_result()?;
    let outlayer = sandbox.dev_deploy(&read_wasm(MOCK_WASM)?).await?;
    let owner = sandbox.dev_create_account().await?;
    outlayer.call("new").transact().await?.into_result()?;
    probe
        .call("new")
        .args_json(json!({
            "owner": owner.id(), "outlayer": outlayer.id(),
            "verifier_url": URL, "verifier_hash": HASH,
            "repo": REPO, "repo_id": "190815700",
        }))
        .transact()
        .await?
        .into_result()?;
    outlayer
        .call("set_reply")
        .args_json(json!({ "mode": "reply", "reply": VERIFIER_RUN.trim_end() }))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(probe.id(), "read_pr")
        .args_json(json!({ "number": 1669, "expect": expect(1_793_836_800) }))
        .deposit(NearToken::from_millinear(10))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()?;
    let recorded: Value = probe
        .view("get_reading")
        .args_json(json!({ "reading": 0 }))
        .await?
        .json()?;
    assert_eq!(recorded["request_id"], "4242");
    assert_eq!(
        recorded["outcome"]["Confirmed"]["facts"],
        json!({
            "repo_id": "190815700", "pr_id": "5125170190", "pr_number": 1669,
            "author_id": "163825889", "base_ref": "master", "state": "closed",
            "merged": true, "merged_at": MERGED_AT.to_string(),
        })
    );
    Ok(())
}

#[tokio::test]
async fn failures_are_no_result_through_the_private_callback() -> anyhow::Result<()> {
    let env = setup().await?;
    let cases: [(&str, Option<String>, &str); 5] = [
        ("null", None, "no_output"),
        ("panic", None, "promise_failed"),
        ("reply", Some(" ".repeat(1025)), "oversized"),
        ("reply", Some("{\"v\":1,\"kind\":".to_string()), "malformed"),
        // An answer bound to reading 0, delivered for reading 4.
        ("reply", Some(answer(&env, 0)), "wrong_binding"),
    ];
    for (index, (mode, body, expected)) in cases.into_iter().enumerate() {
        reply(&env, mode, body).await?;
        read_pr(&env, &env.owner, 1_793_836_800)
            .await?
            .into_result()?;
        assert_eq!(
            reading(&env, index as u32).await?["outcome"],
            json!({"NoResult": {"reason": expected}}),
            "{mode}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn only_the_probe_delivers_results_and_only_the_owner_reads() -> anyhow::Result<()> {
    let env = setup().await?;
    reply(&env, "null", None).await?;
    read_pr(&env, &env.owner, 1_793_836_800)
        .await?
        .into_result()?;
    let forged = env
        .stranger
        .call(env.probe.id(), "on_pr_read")
        .args_json(json!({ "reading": 0 }))
        .transact()
        .await?;
    assert_refused(&forged, "Method on_pr_read is private");
    assert_refused(
        &read_pr(&env, &env.stranger, 1_793_836_800).await?,
        "only the owner",
    );
    Ok(())
}
