//! Sandbox tests of the NEP-616 vault settlement prototype. Build the contracts first:
//!
//!   ./build.sh                       (in prototypes/nep616-vault)
//!   cargo test -p proven-proto-harness -- --nocapture --test-threads 1
//!
//! Every fault case prints its receipt trace (predecessor → receiver, actions, result, gas) and
//! the balances that matter, and asserts the facts the report relies on.

use base64::Engine;
use near_global_contracts::{GlobalContractId, StateInit, StateInitV1};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const VAULT_WASM: &str = "../target/proto/proven_proto_vault.wasm";
const ESCROW_WASM: &str = "../target/proto/proven_proto_escrow.wasm";
const ACTOR_WASM: &str = "../target/proto/proven_proto_actor.wasm";
const MILLI: u128 = 1_000_000_000_000_000_000_000;
const NEAR: u128 = 1000 * MILLI;
const RECONCILE_DEPOSIT: u128 = 11 * MILLI;
const PAYOUT: u8 = 0;
const REFUND: u8 = 1;

struct Env {
    sandbox: Worker<Sandbox>,
    root: Account,
    /// The account that deployed the vault code as a global contract.
    globals: Contract,
    escrow: Contract,
    third: Contract,
    contrib: Account,
    maint: Account,
    stranger: Account,
    code_hash: [u8; 32],
    global_cost: u128,
}

fn wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}; run ./build.sh first"))
}

fn b58(hash: &[u8; 32]) -> String {
    bs58::encode(hash).into_string()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Borsh of the vault's state: just its recipient (a borsh string).
fn vault_state(recipient: &str) -> Vec<u8> {
    let mut out = (recipient.len() as u32).to_le_bytes().to_vec();
    out.extend(recipient.as_bytes());
    out
}

/// NEP-616 address for `code` and `entries`, computed off chain.
fn derive(code: [u8; 32], entries: &[(Vec<u8>, Vec<u8>)]) -> AccountId {
    let data: BTreeMap<Vec<u8>, Vec<u8>> = entries.iter().cloned().collect();
    let init = StateInit::V1(StateInitV1 {
        code: GlobalContractId::CodeHash(code),
        data,
    });
    init.derive_account_id().to_string().parse().unwrap()
}

async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let root = sandbox.root_account()?;
    let vault_code = wasm(VAULT_WASM)?;
    let code_hash: [u8; 32] = Sha256::digest(&vault_code).into();
    let sub = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            anyhow::Ok(
                root.create_subaccount(name)
                    .initial_balance(NearToken::from_yoctonear(near))
                    .keys(SecretKey::from_random(KeyType::ED25519))
                    .transact()
                    .await?
                    .into_result()?,
            )
        }
    };
    let globals = sub("globals", 60 * NEAR)
        .await?
        .deploy(&wasm(ACTOR_WASM)?)
        .await?
        .into_result()?;
    let before = balance(&sandbox, globals.id()).await?;
    let deployed = globals
        .call("deploy_global")
        .args_json(json!({"code": b64(&vault_code)}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(deployed.is_success(), "{:?}", deployed.failures());
    let global_cost = before - balance(&sandbox, globals.id()).await?;
    // The escrow gets a small float above its code's storage, so its solvency guard is visible.
    let escrow = sub("escrow", 2_200 * MILLI)
        .await?
        .deploy(&wasm(ESCROW_WASM)?)
        .await?
        .into_result()?;
    escrow
        .call("new")
        .args_json(json!({"owner": escrow.id(), "vault_code": b58(&code_hash)}))
        .transact()
        .await?
        .into_result()?;
    let third = sub("third", 20 * NEAR)
        .await?
        .deploy(&wasm(ACTOR_WASM)?)
        .await?
        .into_result()?;
    let contrib = sub("contrib", 5 * NEAR).await?;
    let maint = sub("maint", 5 * NEAR).await?;
    let stranger = sub("stranger", 5 * NEAR).await?;
    Ok(Env {
        sandbox,
        root,
        globals,
        escrow,
        third,
        contrib,
        maint,
        stranger,
        code_hash,
        global_cost,
    })
}

// ---- Reading the chain ----

async fn rpc(env: &Env, method: &str, params: Value) -> anyhow::Result<Value> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let out: Value = reqwest::Client::new()
        .post(env.sandbox.rpc_addr())
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    Ok(out)
}

/// The raw `view_account` result, or `None` if the account does not exist.
async fn account(env: &Env, id: &AccountId) -> anyhow::Result<Option<Value>> {
    env.sandbox.fast_forward(2).await?;
    let out = rpc(
        env,
        "query",
        json!({"request_type": "view_account", "finality": "final", "account_id": id}),
    )
    .await?;
    Ok(out.get("result").cloned())
}

async fn balance(sandbox: &Worker<Sandbox>, id: &AccountId) -> anyhow::Result<u128> {
    sandbox.fast_forward(2).await?;
    Ok(sandbox.view_account(id).await?.balance.as_yoctonear())
}

async fn bal(env: &Env, id: &AccountId) -> anyhow::Result<u128> {
    Ok(account(env, id)
        .await?
        .map(|a| a["amount"].as_str().unwrap().parse().unwrap())
        .unwrap_or(0))
}

fn near(y: u128) -> String {
    format!("{}.{:024}", y / NEAR, y % NEAR)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn summarize(action: &Value) -> String {
    match action {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            let (kind, body) = map.iter().next().unwrap();
            let amount = ["deposit", "amount"]
                .iter()
                .find_map(|k| body.get(*k).and_then(Value::as_str))
                .map(|a| format!(" {}", near(a.parse().unwrap())))
                .unwrap_or_default();
            let method = body
                .get("method_name")
                .and_then(Value::as_str)
                .map(|m| format!(" {m}"))
                .unwrap_or_default();
            format!("{kind}{method}{amount}")
        }
        other => other.to_string(),
    }
}

fn short(id: &str) -> String {
    let base = id.split('.').next().unwrap_or(id);
    if base.len() > 14 {
        format!("{}…", &base[..12])
    } else {
        base.to_string()
    }
}

/// Every receipt of a transaction: (predecessor, receiver, actions, failure, gas).
async fn trace(
    env: &Env,
    label: &str,
    result: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<Vec<(String, String, String, Option<String>)>> {
    let out = rpc(
        env,
        "EXPERIMENTAL_tx_status",
        json!({"tx_hash": result.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}),
    )
    .await?;
    let tx = &out["result"];
    println!("--- trace: {label}");
    let mut rows = Vec::new();
    let receipts = tx["receipts"].as_array().cloned().unwrap_or_default();
    // The transaction's own receipt is not in `receipts`; rebuild it from the transaction.
    let first = json!({
        "predecessor_id": tx["transaction"]["signer_id"],
        "receiver_id": tx["transaction"]["receiver_id"],
        "receipt": {"Action": {"actions": tx["transaction"]["actions"]}},
    });
    for outcome in tx["receipts_outcome"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let receipt = receipts
            .iter()
            .find(|r| r["receipt_id"] == outcome["id"])
            .cloned()
            .unwrap_or_else(|| first.clone());
        let actions = receipt["receipt"]["Action"]["actions"]
            .as_array()
            .or_else(|| receipt["receipt"]["ActionV2"]["actions"].as_array())
            .map(|a| a.iter().map(summarize).collect::<Vec<_>>().join(" + "))
            .unwrap_or_else(|| "data".to_string());
        let failure = outcome["outcome"]["status"].get("Failure").map(|f| {
            let s = f.to_string();
            s.chars().take(160).collect::<String>()
        });
        let gas = outcome["outcome"]["gas_burnt"].as_u64().unwrap_or(0);
        let from = receipt["predecessor_id"]
            .as_str()
            .unwrap_or("?")
            .to_string();
        let to = receipt["receiver_id"].as_str().unwrap_or("?").to_string();
        println!(
            "  {:>12} → {:<14} {:<60} {} {:.2} Tgas",
            short(&from),
            short(&to),
            actions,
            failure
                .as_deref()
                .map_or("ok".to_string(), |f| format!("FAILED {f}")),
            gas as f64 / 1e12
        );
        rows.push((from, to, actions, failure));
    }
    Ok(rows)
}

fn failed_with(rows: &[(String, String, String, Option<String>)], to: &str, text: &str) -> bool {
    rows.iter()
        .any(|(_, r, _, f)| r == to && f.as_deref().is_some_and(|f| f.contains(text)))
}

fn refund_to(rows: &[(String, String, String, Option<String>)], to: &str, amount: u128) -> bool {
    rows.iter().any(|(from, r, actions, f)| {
        from == "system"
            && r == to
            && f.is_none()
            && actions.contains(&format!("Transfer {}", near(amount)))
    })
}

fn assert_refused(result: &ExecutionFinalResult, text: &str) {
    let failure = format!("{:?}", result.failures());
    assert!(failure.contains(text), "expected {text:?} in {failure}");
}

async fn settlement(env: &Env, bounty: u64, kind: u8) -> anyhow::Result<Value> {
    Ok(env
        .escrow
        .view("get_settlement")
        .args_json(json!({"bounty": bounty, "kind": kind}))
        .await?
        .json()?)
}

async fn held(env: &Env) -> anyhow::Result<u128> {
    let v: Value = env.escrow.view("held").await?.json()?;
    Ok(v.as_str().unwrap().parse()?)
}

async fn vault_of(env: &Env, recipient: &AccountId) -> anyhow::Result<AccountId> {
    let on_chain: AccountId = env
        .escrow
        .view("vault_of")
        .args_json(json!({"recipient": recipient}))
        .await?
        .json()?;
    let off_chain = derive(
        env.code_hash,
        &[(b"STATE".to_vec(), vault_state(recipient.as_str()))],
    );
    assert_eq!(
        on_chain, off_chain,
        "the escrow and the NEP-616 formula agree"
    );
    Ok(on_chain)
}

async fn slot(
    env: &Env,
    vault: &AccountId,
    issuer: &AccountId,
    bounty: u64,
    kind: u8,
) -> anyhow::Result<Value> {
    Ok(env
        .sandbox
        .view(vault, "slot")
        .args_json(json!({"issuer": issuer, "bounty": bounty, "kind": kind}))
        .await?
        .json()?)
}

async fn faults(env: &Env, faults: Value) -> anyhow::Result<()> {
    env.escrow
        .call("set_faults")
        .args_json(json!({"faults": faults}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn reserve(
    env: &Env,
    bounty: u64,
    kind: u8,
    to: &Account,
    amount: u128,
) -> anyhow::Result<()> {
    env.maint
        .call(env.escrow.id(), "reserve")
        .args_json(json!({"bounty": bounty, "kind": kind, "to": to.id()}))
        .deposit(NearToken::from_yoctonear(amount))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn settle(env: &Env, bounty: u64, kind: u8) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .stranger
        .call(env.escrow.id(), "settle")
        .args_json(json!({"bounty": bounty, "kind": kind}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

async fn reconcile(
    env: &Env,
    who: &Account,
    bounty: u64,
    kind: u8,
    attempt: u32,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.escrow.id(), "reconcile")
        .args_json(json!({"bounty": bounty, "kind": kind, "attempt": attempt}))
        .deposit(NearToken::from_yoctonear(RECONCILE_DEPOSIT))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

fn answer(result: &ExecutionFinalResult) -> String {
    result
        .clone()
        .json::<String>()
        .unwrap_or_else(|_| format!("failed: {:?}", result.failures()))
}

async fn state_init(
    env: &Env,
    receiver: &AccountId,
    code: [u8; 32],
    entries: &[(Vec<u8>, Vec<u8>)],
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    let entries: Vec<(String, String)> = entries.iter().map(|(k, v)| (b64(k), b64(v))).collect();
    Ok(env
        .third
        .call("state_init")
        .args_json(json!({"receiver": receiver, "code": b58(&code), "entries": entries, "amount": amount.to_string()}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

fn print_account(label: &str, a: &Option<Value>) {
    match a {
        None => println!("  {label}: does not exist"),
        Some(a) => println!(
            "  {label}: amount {} storage {} bytes code_hash {} global {}",
            near(a["amount"].as_str().unwrap().parse().unwrap()),
            a["storage_usage"],
            a["code_hash"],
            a.get("global_contract_hash")
                .cloned()
                .unwrap_or(Value::Null),
        ),
    }
}

// ---- 1. Vault lifecycle ----

#[tokio::test]
async fn vault_lifecycle_and_what_each_failure_does_with_the_near() -> anyhow::Result<()> {
    let env = setup().await?;
    let status = rpc(&env, "status", json!([])).await?;
    println!(
        "sandbox: {} protocol {}",
        status["result"]["version"], status["result"]["protocol_version"]
    );
    println!("global code deployer: {}", env.globals.id());
    println!(
        "global vault code {} ({} bytes) cost the deployer {} NEAR",
        b58(&env.code_hash),
        wasm(VAULT_WASM)?.len(),
        near(env.global_cost)
    );
    let vault = vault_of(&env, env.contrib.id()).await?;
    let state = vec![(b"STATE".to_vec(), vault_state(env.contrib.id().as_str()))];
    println!("vault of {}: {vault}", env.contrib.id());
    // Another recipient, or other code, gives another address.
    assert_ne!(vault, vault_of(&env, env.maint.id()).await?);
    assert_ne!(vault, derive([7u8; 32], &state));

    // (a) Funding an address that does not exist yet: a plain transfer creates it, uninitialized.
    assert!(account(&env, &vault).await?.is_none());
    let funded = env
        .stranger
        .transfer_near(&vault, NearToken::from_millinear(500))
        .await?;
    trace(
        &env,
        "plain transfer of 0.5 to the absent vault",
        &funded,
        env.stranger.id(),
    )
    .await?;
    assert!(funded.is_success());
    let a = account(&env, &vault).await?;
    print_account("after the transfer", &a);
    assert_eq!(bal(&env, &vault).await?, 500 * MILLI);

    // (b) Wrong initialization data for this address: the runtime refuses to create the receipt,
    // so the sender's whole call fails and the attached NEAR never leaves it.
    let wrong = vec![(b"STATE".to_vec(), vault_state("someone-else.test.near"))];
    let before = bal(&env, env.third.id()).await?;
    let r = state_init(&env, &vault, env.code_hash, &wrong, 10 * MILLI).await?;
    let rows = trace(
        &env,
        "StateInit with another recipient's data",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(rows
        .iter()
        .any(|(_, to, _, f)| to == env.third.id().as_str() && f.is_some()));
    assert!(
        rows.iter().all(|(_, to, _, _)| to != vault.as_str()),
        "no receipt reached the vault"
    );
    let spent = before - bal(&env, env.third.id()).await?;
    println!(
        "  third-party cost of the refused init: {} NEAR (gas only)",
        near(spent)
    );
    assert!(spent < MILLI);
    assert_eq!(bal(&env, &vault).await?, 500 * MILLI);

    // (c) Code that is not deployed as a global contract: refused, NEAR comes back.
    let missing = [9u8; 32];
    let target = derive(missing, &state);
    let r = state_init(&env, &target, missing, &state, 10 * MILLI).await?;
    let rows = trace(
        &env,
        "StateInit with an undeployed code hash",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(rows
        .iter()
        .any(|(_, to, _, f)| to == target.as_str() && f.is_some()));
    assert!(refund_to(&rows, env.third.id().as_str(), 10 * MILLI));
    assert!(account(&env, &target).await?.is_none());

    // (d) Insufficient storage funding: state well above the 770-byte zero-balance allowance.
    let big = vec![
        (b"STATE".to_vec(), vault_state("big.test.near")),
        (b"pad".to_vec(), vec![0u8; 3_000]),
    ];
    let target = derive(env.code_hash, &big);
    let r = state_init(&env, &target, env.code_hash, &big, 0).await?;
    let rows = trace(
        &env,
        "StateInit of 3 KB of state with 0 NEAR",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(rows
        .iter()
        .any(|(_, to, _, f)| to == target.as_str() && f.is_some()));
    assert!(account(&env, &target).await?.is_none());
    let r = state_init(&env, &target, env.code_hash, &big, 10 * MILLI).await?;
    let rows = trace(
        &env,
        "the same with 0.01 NEAR (still short)",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(failed_with(&rows, target.as_str(), "LackBalanceForState"));
    assert!(refund_to(&rows, env.third.id().as_str(), 10 * MILLI));
    let r = state_init(&env, &target, env.code_hash, &big, 50 * MILLI).await?;
    let rows = trace(&env, "the same with 0.05 NEAR", &r, env.third.id()).await?;
    assert!(rows
        .iter()
        .all(|(_, to, _, f)| to != target.as_str() || f.is_none()));
    print_account("3 KB vault", &account(&env, &target).await?);
    let big_balance = bal(&env, &target).await?;
    println!(
        "  it kept {} NEAR for storage; the rest was refunded",
        near(big_balance)
    );

    // (e) Initializing the pre-funded vault, with nothing attached.
    let r = state_init(&env, &vault, env.code_hash, &state, 0).await?;
    let rows = trace(
        &env,
        "StateInit of the pre-funded vault, 0 attached",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(rows.iter().all(|(_, _, _, f)| f.is_none()));
    let a = account(&env, &vault).await?;
    print_account("initialized vault", &a);
    assert_eq!(
        bal(&env, &vault).await?,
        500 * MILLI,
        "a small vault needs no stake (zero-balance)"
    );
    let recipient: String = env.sandbox.view(&vault, "recipient").await?.json()?;
    assert_eq!(recipient, env.contrib.id().as_str());

    // (f) Funding an active vault, and StateInit on an active vault.
    let r = env
        .stranger
        .transfer_near(&vault, NearToken::from_millinear(100))
        .await?;
    assert!(r.is_success());
    let r = state_init(&env, &vault, env.code_hash, &state, 10 * MILLI).await?;
    let rows = trace(
        &env,
        "StateInit of an active vault with 0.01",
        &r,
        env.third.id(),
    )
    .await?;
    assert!(rows.iter().all(|(_, _, _, f)| f.is_none()));
    assert!(refund_to(&rows, env.third.id().as_str(), 10 * MILLI));
    assert_eq!(bal(&env, &vault).await?, 600 * MILLI);

    // (g) Nobody can replace its code, add a key, or delete it.
    let keys = rpc(
        &env,
        "query",
        json!({"request_type": "view_access_key_list", "finality": "final", "account_id": vault}),
    )
    .await?;
    println!("  access keys: {}", keys["result"]["keys"]);
    assert_eq!(keys["result"]["keys"], json!([]));
    for op in ["add_key", "deploy", "delete", "use_global"] {
        let r = env
            .third
            .call("poke")
            .args_json(
                json!({"target": vault, "op": op, "key": env.stranger.secret_key().public_key()}),
            )
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        let rows = trace(
            &env,
            &format!("{op} on the vault from another account"),
            &r,
            env.third.id(),
        )
        .await?;
        assert!(
            failed_with(&rows, vault.as_str(), "ActorNoPermission"),
            "{op}"
        );
    }
    let after = account(&env, &vault).await?.unwrap();
    assert_eq!(after["code_hash"], a.as_ref().unwrap()["code_hash"]);
    assert_eq!(bal(&env, &vault).await?, 600 * MILLI);
    Ok(())
}

// ---- 2. Reconciling an exact settlement after both callbacks fail ----

async fn successful_funding_case(
    env: &Env,
    bounty: u64,
    kind: u8,
    to: &Account,
) -> anyhow::Result<()> {
    let amount = NEAR;
    let vault = vault_of(env, to.id()).await?;
    faults(
        env,
        json!({"callbacks": true, "deposit": false, "reconcile_callback": false, "delay_hops": 0}),
    )
    .await?;
    reserve(env, bounty, kind, to, amount).await?;
    // A third party has already put 0.2 NEAR at the vault's address.
    env.stranger
        .transfer_near(&vault, NearToken::from_millinear(200))
        .await?
        .into_result()?;
    let escrow_before = bal(env, env.escrow.id()).await?;
    let vault_before = bal(env, &vault).await?;
    let sent = settle(env, bounty, kind).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: funding succeeds, both callbacks fail"),
        &sent,
        env.stranger.id(),
    )
    .await?;
    assert!(rows
        .iter()
        .any(|(_, r, a, f)| r == vault.as_str() && a.contains("deposit") && f.is_none()));
    assert!(failed_with(
        &rows,
        env.escrow.id().as_str(),
        "fault: on_settle fails"
    ));
    assert!(failed_with(
        &rows,
        env.escrow.id().as_str(),
        "fault: on_settle_outcome fails"
    ));
    let s = settlement(env, bounty, kind).await?;
    assert_eq!(
        (
            s["state"].as_str(),
            s["attempt"].as_u64(),
            s["outcome"].as_str()
        ),
        (Some("Sending"), Some(1), Some("Unknown"))
    );
    assert_eq!(held(env).await?, amount, "unconfirmed: still reserved");
    assert_refused(&settle(env, bounty, kind).await?, "not due");
    println!(
        "  escrow {} → {} (sent {}), vault {} → {}",
        near(escrow_before),
        near(bal(env, env.escrow.id()).await?),
        near(amount),
        near(vault_before),
        near(bal(env, &vault).await?)
    );
    // The vault's durable record for this escrow: attempt 1, exactly the amount.
    let record = slot(env, &vault, env.escrow.id(), bounty, kind).await?;
    assert_eq!(
        record["deposit"],
        json!({"attempt": 1, "amount": amount.to_string()})
    );

    // Two reconciliations at once: exactly one releases the reservation.
    let (a, b) = tokio::join!(
        reconcile(env, &env.stranger, bounty, kind, 1),
        reconcile(env, env.third.as_account(), bounty, kind, 1),
    );
    let (a, b) = (a?, b?);
    trace(
        env,
        &format!("kind {kind}: reconcile (first of two concurrent)"),
        &a,
        env.stranger.id(),
    )
    .await?;
    let answers = [answer(&a), answer(&b)];
    println!("  concurrent answers: {answers:?}");
    assert_eq!(answers.iter().filter(|x| *x == "deposited").count(), 1);
    assert_eq!(
        answers
            .iter()
            .filter(|x| *x == "ignored:not_in_flight")
            .count(),
        1
    );
    assert_eq!(held(env).await?, 0, "released exactly once");
    let s = settlement(env, bounty, kind).await?;
    assert_eq!(
        (s["state"].as_str(), s["outcome"].as_str()),
        (Some("Done"), Some("Succeeded"))
    );
    // Repeating it changes nothing; the settlement cannot be sent again.
    assert_eq!(
        answer(&reconcile(env, &env.stranger, bounty, kind, 1).await?),
        "ignored:not_in_flight"
    );
    assert_refused(&settle(env, bounty, kind).await?, "not due");
    assert_eq!(held(env).await?, 0);
    let escrow_spent = escrow_before - bal(env, env.escrow.id()).await?;
    println!(
        "  escrow net outflow {} NEAR (amount plus vault init refunds and gas rewards)",
        near(escrow_spent)
    );
    assert!(escrow_spent <= amount + MILLI && escrow_spent + MILLI > amount);
    Ok(())
}

#[tokio::test]
async fn successful_funding_with_both_callbacks_failed_is_released_once() -> anyhow::Result<()> {
    let env = setup().await?;
    successful_funding_case(&env, 1, PAYOUT, &env.contrib).await?;
    successful_funding_case(&env, 2, REFUND, &env.maint).await?;
    Ok(())
}

async fn failed_funding_case(env: &Env, bounty: u64, kind: u8, to: &Account) -> anyhow::Result<()> {
    let amount = NEAR;
    let vault = vault_of(env, to.id()).await?;
    faults(
        env,
        json!({"callbacks": true, "deposit": true, "reconcile_callback": false, "delay_hops": 0}),
    )
    .await?;
    reserve(env, bounty, kind, to, amount).await?;
    let escrow_before = bal(env, env.escrow.id()).await?;
    let vault_before = bal(env, &vault).await?;
    let sent = settle(env, bounty, kind).await?;
    let rows = trace(
        env,
        &format!("kind {kind}: funding fails, both callbacks fail"),
        &sent,
        env.stranger.id(),
    )
    .await?;
    assert!(rows.iter().any(|(_, r, a, f)| r == vault.as_str()
        && a.contains("DeterministicStateInit")
        && f.is_some()));
    assert!(refund_to(
        &rows,
        env.escrow.id().as_str(),
        amount + 10 * MILLI
    ));
    assert_eq!(
        bal(env, &vault).await?,
        vault_before,
        "nothing reached the vault"
    );
    let s = settlement(env, bounty, kind).await?;
    assert_eq!(
        (s["state"].as_str(), s["outcome"].as_str()),
        (Some("Sending"), Some("Unknown"))
    );
    assert_eq!(held(env).await?, amount);
    println!(
        "  escrow {} → {} (the refund has landed)",
        near(escrow_before),
        near(bal(env, env.escrow.id()).await?)
    );

    // A reconcile whose own callback fails seals the vault but records nothing; repeating it
    // gets the same sealed answer.
    faults(
        env,
        json!({"callbacks": true, "deposit": true, "reconcile_callback": true, "delay_hops": 0}),
    )
    .await?;
    let lost = reconcile(env, &env.stranger, bounty, kind, 1).await?;
    trace(
        env,
        &format!("kind {kind}: reconcile whose callback fails"),
        &lost,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(settlement(env, bounty, kind).await?["state"], "Sending");
    assert_eq!(
        slot(env, &vault, env.escrow.id(), bounty, kind).await?,
        json!({"deposit": null, "sealed_through": 1})
    );
    faults(
        env,
        json!({"callbacks": true, "deposit": true, "reconcile_callback": false, "delay_hops": 0}),
    )
    .await?;
    let r = reconcile(env, &env.stranger, bounty, kind, 1).await?;
    trace(
        env,
        &format!("kind {kind}: reconcile again"),
        &r,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    let s = settlement(env, bounty, kind).await?;
    assert_eq!(
        (s["state"].as_str(), s["outcome"].as_str()),
        (Some("Due"), Some("Failed"))
    );
    assert_eq!(
        held(env).await?,
        amount,
        "a confirmed failure stays reserved, once"
    );
    assert_eq!(
        answer(&reconcile(env, &env.stranger, bounty, kind, 1).await?),
        "ignored:not_in_flight"
    );

    // Attempt 2 succeeds at the vault (callbacks still off) and is reconciled.
    faults(
        env,
        json!({"callbacks": true, "deposit": false, "reconcile_callback": false, "delay_hops": 0}),
    )
    .await?;
    let resent = settle(env, bounty, kind).await?;
    trace(
        env,
        &format!("kind {kind}: attempt 2, funding succeeds, callbacks fail"),
        &resent,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(held(env).await?, amount);
    // Stale evidence: reconciling attempt 1 now changes nothing, and does not block attempt 2.
    assert_eq!(
        answer(&reconcile(env, &env.stranger, bounty, kind, 1).await?),
        "ignored:not_in_flight"
    );
    let r = reconcile(env, &env.stranger, bounty, kind, 2).await?;
    assert_eq!(answer(&r), "deposited");
    assert_eq!(
        slot(env, &vault, env.escrow.id(), bounty, kind).await?,
        json!({"deposit": {"attempt": 2, "amount": amount.to_string()}, "sealed_through": 1})
    );
    let s = settlement(env, bounty, kind).await?;
    assert_eq!(
        (
            s["state"].as_str(),
            s["attempt"].as_u64(),
            s["outcome"].as_str()
        ),
        (Some("Done"), Some(2), Some("Succeeded"))
    );
    assert_eq!(held(env).await?, 0);
    // The vault got the amount once (plus the seal storage deposits paid by reconcilers).
    let into_vault = bal(env, &vault).await? - vault_before;
    println!("  vault received {} NEAR", near(into_vault));
    assert!(into_vault >= amount && into_vault < amount + 10 * MILLI);
    let escrow_spent = escrow_before - bal(env, env.escrow.id()).await?;
    assert!(
        escrow_spent <= amount + MILLI && escrow_spent + MILLI > amount,
        "{}",
        near(escrow_spent)
    );
    Ok(())
}

#[tokio::test]
async fn failed_funding_with_both_callbacks_failed_is_sealed_and_resent_once() -> anyhow::Result<()>
{
    let env = setup().await?;
    failed_funding_case(&env, 1, PAYOUT, &env.contrib).await?;
    failed_funding_case(&env, 2, REFUND, &env.maint).await?;
    Ok(())
}

#[tokio::test]
async fn a_seal_that_overtakes_an_in_flight_deposit_makes_that_deposit_fail() -> anyhow::Result<()>
{
    let env = setup().await?;
    let amount = NEAR;
    let vault = vault_of(&env, env.contrib.id()).await?;
    faults(
        &env,
        json!({"callbacks": true, "deposit": false, "reconcile_callback": false, "delay_hops": 40}),
    )
    .await?;
    reserve(&env, 1, PAYOUT, &env.contrib, amount).await?;
    let pending = env
        .stranger
        .call(env.escrow.id(), "settle")
        .args_json(json!({"bounty": 1, "kind": PAYOUT}))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    // Wait until attempt 1 is recorded as sent, then seal it before its deposit arrives.
    let mut waited = 0;
    while settlement(&env, 1, PAYOUT).await?["attempt"] != 1 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        waited += 1;
        assert!(waited < 100);
    }
    let r = reconcile(&env, &env.stranger, 1, PAYOUT, 1).await?;
    trace(
        &env,
        "seal of attempt 1 while its deposit is still held back",
        &r,
        env.stranger.id(),
    )
    .await?;
    assert_eq!(answer(&r), "sealed_without_deposit");
    assert_eq!(settlement(&env, 1, PAYOUT).await?["state"], "Due");
    // The old attempt's NEAR has not come back yet, so a resend would spend other reserves.
    let early = settle(&env, 1, PAYOUT).await?;
    assert_refused(&early, "waiting for an earlier attempt's refund");
    let sent = pending.await?;
    let rows = trace(
        &env,
        "the held-back deposit of attempt 1 arrives after the seal",
        &sent,
        env.stranger.id(),
    )
    .await?;
    assert!(failed_with(&rows, vault.as_str(), "this attempt is sealed"));
    assert!(refund_to(&rows, env.escrow.id().as_str(), amount));
    assert_eq!(
        slot(&env, &vault, env.escrow.id(), 1, PAYOUT).await?,
        json!({"deposit": null, "sealed_through": 1})
    );
    // Once the refund has arrived, attempt 2 goes out and is the only deposit.
    faults(
        &env,
        json!({"callbacks": false, "deposit": false, "reconcile_callback": false, "delay_hops": 0}),
    )
    .await?;
    let resent = settle(&env, 1, PAYOUT).await?;
    trace(
        &env,
        "attempt 2 after the refund, callbacks working",
        &resent,
        env.stranger.id(),
    )
    .await?;
    let s = settlement(&env, 1, PAYOUT).await?;
    assert_eq!(
        (s["state"].as_str(), s["attempt"].as_u64()),
        (Some("Done"), Some(2))
    );
    assert_eq!(held(&env).await?, 0);
    assert_eq!(
        slot(&env, &vault, env.escrow.id(), 1, PAYOUT).await?["deposit"],
        json!({"attempt": 2, "amount": amount.to_string()})
    );
    Ok(())
}

#[tokio::test]
async fn duplicate_foreign_and_forged_records_do_not_count() -> anyhow::Result<()> {
    let env = setup().await?;
    let vault = vault_of(&env, env.contrib.id()).await?;
    let state = vec![(b"STATE".to_vec(), vault_state(env.contrib.id().as_str()))];
    state_init(&env, &vault, env.code_hash, &state, 0)
        .await?
        .into_result()?;
    // Another account deposits under its own name, with the escrow's bounty, kind and amount.
    let deposit = |attempt: u32| {
        let call = env
            .stranger
            .call(&vault, "deposit")
            .args_json(json!({"bounty": 1, "kind": PAYOUT, "attempt": attempt}))
            .deposit(NearToken::from_near(1));
        async move { call.transact().await }
    };
    deposit(1).await?.into_result()?;
    let before = bal(&env, env.stranger.id()).await?;
    let dup = deposit(1).await?;
    let rows = trace(
        &env,
        "a duplicate deposit for the same slot",
        &dup,
        env.stranger.id(),
    )
    .await?;
    assert!(failed_with(&rows, vault.as_str(), "already has a deposit"));
    assert!(refund_to(&rows, env.stranger.id().as_str(), NEAR));
    assert!(
        before - bal(&env, env.stranger.id()).await? < MILLI,
        "refunded but for gas"
    );
    assert_eq!(
        slot(&env, &vault, env.stranger.id(), 1, PAYOUT).await?["deposit"]["attempt"],
        1
    );
    // None of that is the escrow's record.
    assert_eq!(
        slot(&env, &vault, env.escrow.id(), 1, PAYOUT).await?,
        json!({"deposit": null, "sealed_through": 0})
    );

    faults(
        &env,
        json!({"callbacks": true, "deposit": true, "reconcile_callback": false, "delay_hops": 0}),
    )
    .await?;
    reserve(&env, 1, PAYOUT, &env.contrib, NEAR).await?;
    settle(&env, 1, PAYOUT).await?.into_result()?;
    // Forged callbacks are refused.
    for (method, args) in [
        (
            "on_reconcile",
            json!({"bounty": 1, "kind": PAYOUT, "attempt": 1}),
        ),
        (
            "on_settle",
            json!({"bounty": 1, "kind": PAYOUT, "attempt": 1}),
        ),
        (
            "on_settle_outcome",
            json!({"bounty": 1, "kind": PAYOUT, "attempt": 1}),
        ),
    ] {
        let r = env
            .stranger
            .call(env.escrow.id(), method)
            .args_json(args)
            .transact()
            .await?;
        assert_refused(&r, &format!("Method {method} is private"));
    }
    // A reconcile of an attempt that was never sent is refused before anything happens.
    assert_refused(
        &reconcile(&env, &env.stranger, 1, PAYOUT, 2).await?,
        "no such attempt",
    );
    let r = reconcile(&env, &env.stranger, 1, PAYOUT, 1).await?;
    assert_eq!(
        answer(&r),
        "sealed_without_deposit",
        "the stranger's deposit is not the escrow's"
    );
    assert_eq!(held(&env).await?, NEAR);
    Ok(())
}

// ---- 3. Withdrawal safety ----

#[tokio::test]
async fn withdrawals_go_only_to_the_recipient_and_survive_a_missing_account() -> anyhow::Result<()>
{
    let env = setup().await?;
    let vault = vault_of(&env, env.contrib.id()).await?;
    faults(
        &env,
        json!({"callbacks": false, "deposit": false, "reconcile_callback": false, "delay_hops": 0}),
    )
    .await?;
    reserve(&env, 1, PAYOUT, &env.contrib, NEAR).await?;
    env.stranger
        .transfer_near(&vault, NearToken::from_millinear(300))
        .await?
        .into_result()?;
    settle(&env, 1, PAYOUT).await?.into_result()?;
    assert_eq!(settlement(&env, 1, PAYOUT).await?["state"], "Done");
    let usage = account(&env, &vault).await?.unwrap()["storage_usage"]
        .as_u64()
        .unwrap();
    let available: Value = env.sandbox.view(&vault, "available").await?.json()?;
    let available: u128 = available.as_str().unwrap().parse()?;
    println!(
        "  vault holds {} NEAR, {usage} bytes; withdrawable {}",
        near(bal(&env, &vault).await?),
        near(available)
    );

    // Unauthorized.
    let r = env.stranger.call(&vault, "withdraw").transact().await?;
    assert_refused(&r, "only the recipient can withdraw");
    let r = env.maint.call(&vault, "withdraw").transact().await?;
    assert_refused(&r, "only the recipient can withdraw");

    // The recipient's account goes away before it withdraws: the money waits in the vault.
    let root = env.root.clone();
    env.contrib
        .clone()
        .delete_account(root.id())
        .await?
        .into_result()?;
    assert!(account(&env, env.contrib.id()).await?.is_none());
    let r = env
        .stranger
        .transfer_near(&vault, NearToken::from_yoctonear(1))
        .await?;
    assert!(r.is_success(), "the vault still takes deposits");

    // The same name comes back (as a contract) and withdraws while deleting itself in the same
    // step: the transfer arrives at a missing account and is refunded to the vault.
    let first_key = SecretKey::from_random(KeyType::ED25519);
    let back = root
        .create_subaccount("contrib")
        .initial_balance(NearToken::from_near(2))
        .keys(first_key.clone())
        .transact()
        .await?
        .into_result()?
        .deploy(&wasm(ACTOR_WASM)?)
        .await?
        .into_result()?;
    let in_vault = bal(&env, &vault).await?;
    let r = back
        .call("withdraw_then_delete")
        .args_json(json!({"vault": vault, "beneficiary": root.id()}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let rows = trace(
        &env,
        "withdraw while the recipient deletes itself",
        &r,
        back.id(),
    )
    .await?;
    assert!(failed_with(
        &rows,
        back.id().as_str(),
        "AccountDoesNotExist"
    ));
    assert!(rows
        .iter()
        .any(|(from, to, _, f)| from == "system" && to == vault.as_str() && f.is_none()));
    assert!(account(&env, back.id()).await?.is_none());
    let restored = bal(&env, &vault).await?;
    println!(
        "  vault before {} after the refund {}",
        near(in_vault),
        near(restored)
    );
    // Everything came back; the vault also earned its share of the gas its call burnt.
    assert!(restored >= in_vault && restored - in_vault < MILLI);

    // A different key holder registers the same name and withdraws everything.
    let other_key = SecretKey::from_random(KeyType::ED25519);
    let stranger_owned = root
        .create_subaccount("contrib")
        .initial_balance(NearToken::from_near(3))
        .keys(other_key.clone())
        .transact()
        .await?
        .into_result()?
        .deploy(&wasm(ACTOR_WASM)?)
        .await?
        .into_result()?;
    assert_ne!(first_key.public_key(), other_key.public_key());
    // Repeated withdrawals in one step: the second finds nothing.
    let before = bal(&env, stranger_owned.id()).await?;
    let available: Value = env.sandbox.view(&vault, "available").await?.json()?;
    let available: u128 = available.as_str().unwrap().parse()?;
    let r = stranger_owned
        .call("withdraw_twice")
        .args_json(json!({"vault": vault}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let rows = trace(
        &env,
        "the new holder of the name withdraws twice in one step",
        &r,
        stranger_owned.id(),
    )
    .await?;
    // The first withdrawal sends exactly what was withdrawable. The second finds nothing, or
    // only the gas reward the vault earned from the first call.
    let sent: Vec<&String> = rows
        .iter()
        .filter(|(from, to, _, f)| {
            from == vault.as_str() && to == stranger_owned.id().as_str() && f.is_none()
        })
        .map(|(_, _, a, _)| a)
        .collect();
    println!("  transfers from the vault: {sent:?}");
    assert_eq!(
        sent.first().map(|a| a.as_str()),
        Some(format!("Transfer {}", near(available)).as_str())
    );
    assert!(
        sent.len() == 1
            || failed_with(&rows, vault.as_str(), "nothing to withdraw")
            || sent.len() == 2
    );
    let gained = bal(&env, stranger_owned.id()).await? - before;
    println!(
        "  new key holder received {} of {} withdrawable (less its own gas)",
        near(gained),
        near(available)
    );
    assert!(gained + 5 * MILLI > available && gained < available + MILLI);
    let left = bal(&env, &vault).await?;
    println!(
        "  left in the vault as its storage reserve: {} NEAR",
        near(left)
    );
    Ok(())
}
