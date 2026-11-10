//! Shared helpers for the vault prototype's sandbox tests: setup, NEP-413 signing, the vault's
//! borsh interface, receipt traces and balances.
#![allow(dead_code)]

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use near_global_contracts::{GlobalContractId, StateInit, StateInitV1};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const VAULT_WASM: &str = "../target/proto/proven_proto_vault.wasm";
pub const ESCROW_WASM: &str = "../target/proto/proven_proto_escrow.wasm";
pub const ACTOR_WASM: &str = "../target/proto/proven_proto_actor.wasm";
pub const MILLI: u128 = 1_000_000_000_000_000_000_000;
pub const NEAR: u128 = 1000 * MILLI;
pub const BYTE_COST: u128 = 10_000_000_000_000_000_000;
pub const RECONCILE_DEPOSIT: u128 = 10 * MILLI;
pub const STORAGE_FEE: u128 = 5 * MILLI;
pub const INIT_DEPOSIT: u128 = 5 * MILLI;
pub const PAYOUT: u8 = 0;
pub const REFUND: u8 = 1;
const NEP413_TAG: u32 = 2_147_484_061;

pub type Rows = Vec<(String, String, String, Option<String>)>;

pub struct Env {
    pub sandbox: Worker<Sandbox>,
    pub chain: String,
    pub root: Account,
    pub globals: Contract,
    pub escrow: Contract,
    pub third: Contract,
    /// The contributor's wallet. Its full-access key is `contrib_key`.
    pub contrib: Account,
    pub contrib_key: SigningKey,
    /// The maintainer's wallet. Its full-access key is `maint_key`.
    pub maint: Account,
    pub maint_key: SigningKey,
    /// Submits signed withdrawals and pays their gas.
    pub relayer: Account,
    pub stranger: Account,
    pub code_hash: [u8; 32],
    pub global_cost: u128,
}

pub fn wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}; run ./build.sh first"))
}

pub fn b58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

/// The NEAR form of an ed25519 key: `ed25519:<base58>`.
pub fn public(key: &SigningKey) -> String {
    format!("ed25519:{}", b58(key.verifying_key().as_bytes()))
}

pub fn secret(key: &SigningKey) -> SecretKey {
    let mut bytes = key.to_bytes().to_vec();
    bytes.extend(key.verifying_key().as_bytes());
    format!("ed25519:{}", b58(&bytes)).parse().unwrap()
}

/// The 33-byte borsh public key the vault stores: curve 0, then the key.
pub fn pk33(key: &SigningKey) -> Vec<u8> {
    let mut out = vec![0u8];
    out.extend(key.verifying_key().as_bytes());
    out
}

fn borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend((s.len() as u32).to_le_bytes());
    out.extend(s.as_bytes());
}

/// A NEP-413 signature: SHA-256 of tag + borsh(message, nonce, recipient, no callback URL).
pub fn nep413(key: &SigningKey, message: &str, nonce: [u8; 32], recipient: &str) -> [u8; 64] {
    let mut payload = NEP413_TAG.to_le_bytes().to_vec();
    borsh_str(&mut payload, message);
    payload.extend(nonce);
    borsh_str(&mut payload, recipient);
    payload.push(0);
    let hash: [u8; 32] = Sha256::digest(&payload).into();
    key.sign(&hash).to_bytes()
}

pub fn bind_proof(env: &Env, key: &SigningKey, bounty: u64, kind: u8) -> String {
    let escrow = env.escrow.id().as_str();
    let message = format!(
        "proven-vault-bind:v1|chain={}|escrow={escrow}|bounty={bounty}|kind={kind}",
        env.chain
    );
    b64(&nep413(key, &message, [0u8; 32], escrow))
}

/// What a withdrawal signs, for a given chain.
pub fn withdraw_sig(
    key: &SigningKey,
    chain: &str,
    vault: &str,
    to: &str,
    amount: u128,
    seq: u64,
) -> [u8; 64] {
    let message = format!(
        "proven-vault-withdraw:v1|chain={chain}|vault={vault}|to={to}|amount={amount}|seq={seq}"
    );
    let mut nonce = [0u8; 32];
    nonce[24..].copy_from_slice(&seq.to_be_bytes());
    nep413(key, &message, nonce, vault)
}

pub fn withdraw_args(to: &str, amount: u128, seq: u64, sig: &[u8; 64]) -> Vec<u8> {
    let mut out = Vec::new();
    borsh_str(&mut out, to);
    out.extend(amount.to_le_bytes());
    out.extend(seq.to_le_bytes());
    out.extend(sig);
    out
}

pub fn vault_entries(key: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    vec![
        (b"k".to_vec(), key.to_vec()),
        (b"n".to_vec(), 0u64.to_le_bytes().to_vec()),
        (b"f".to_vec(), 0u128.to_le_bytes().to_vec()),
    ]
}

/// NEP-616 address for `code` and `entries`, computed off chain.
pub fn derive(code: [u8; 32], entries: &[(Vec<u8>, Vec<u8>)]) -> AccountId {
    let data: BTreeMap<Vec<u8>, Vec<u8>> = entries.iter().cloned().collect();
    StateInit::V1(StateInitV1 {
        code: GlobalContractId::CodeHash(code),
        data,
    })
    .derive_account_id()
    .to_string()
    .parse()
    .unwrap()
}

pub async fn setup() -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let root = sandbox.root_account()?;
    let vault_code = wasm(VAULT_WASM)?;
    let code_hash: [u8; 32] = Sha256::digest(&vault_code).into();
    let sub = |name: &'static str, near: u128, key: SecretKey| {
        let root = root.clone();
        async move {
            anyhow::Ok(
                root.create_subaccount(name)
                    .initial_balance(NearToken::from_yoctonear(near))
                    .keys(key)
                    .transact()
                    .await?
                    .into_result()?,
            )
        }
    };
    let random = || SecretKey::from_random(KeyType::ED25519);
    let globals = sub("globals", 20 * NEAR, random())
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
    let escrow = sub("escrow", 2_400 * MILLI, random())
        .await?
        .deploy(&wasm(ESCROW_WASM)?)
        .await?
        .into_result()?;
    escrow
        .call("new")
        .args_json(json!({"vault_code": b58(&code_hash)}))
        .transact()
        .await?
        .into_result()?;
    let third = sub("third", 20 * NEAR, random())
        .await?
        .deploy(&wasm(ACTOR_WASM)?)
        .await?
        .into_result()?;
    let contrib_key = signing_key(1);
    let maint_key = signing_key(2);
    let contrib = sub("contrib", 5 * NEAR, secret(&contrib_key)).await?;
    let maint = sub("maint", 20 * NEAR, secret(&maint_key)).await?;
    let relayer = sub("relayer", 5 * NEAR, random()).await?;
    let stranger = sub("stranger", 5 * NEAR, random()).await?;
    let status = rpc_at(&sandbox, "status", json!([])).await?;
    let chain = status["result"]["chain_id"].as_str().unwrap().to_string();
    Ok(Env {
        sandbox,
        chain,
        root,
        globals,
        escrow,
        third,
        contrib,
        contrib_key,
        maint,
        maint_key,
        relayer,
        stranger,
        code_hash,
        global_cost,
    })
}

// ---- Chain reads ----

pub async fn rpc_at(
    sandbox: &Worker<Sandbox>,
    method: &str,
    params: Value,
) -> anyhow::Result<Value> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    Ok(reqwest::Client::new()
        .post(sandbox.rpc_addr())
        .json(&body)
        .send()
        .await?
        .json()
        .await?)
}

pub async fn rpc(env: &Env, method: &str, params: Value) -> anyhow::Result<Value> {
    rpc_at(&env.sandbox, method, params).await
}

/// The raw `view_account` result, or `None` if the account does not exist. Waits two blocks so
/// pending refunds have landed.
pub async fn account(env: &Env, id: &AccountId) -> anyhow::Result<Option<Value>> {
    env.sandbox.fast_forward(2).await?;
    let out = rpc(
        env,
        "query",
        json!({"request_type": "view_account", "finality": "final", "account_id": id}),
    )
    .await?;
    Ok(out.get("result").cloned())
}

pub async fn balance(sandbox: &Worker<Sandbox>, id: &AccountId) -> anyhow::Result<u128> {
    sandbox.fast_forward(2).await?;
    Ok(sandbox.view_account(id).await?.balance.as_yoctonear())
}

pub async fn bal(env: &Env, id: &AccountId) -> anyhow::Result<u128> {
    Ok(account(env, id)
        .await?
        .map(|a| a["amount"].as_str().unwrap().parse().unwrap())
        .unwrap_or(0))
}

pub async fn usage(env: &Env, id: &AccountId) -> anyhow::Result<u64> {
    Ok(account(env, id)
        .await?
        .map(|a| a["storage_usage"].as_u64().unwrap())
        .unwrap_or(0))
}

pub fn near(y: u128) -> String {
    let s = format!("{}.{:024}", y / NEAR, y % NEAR);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
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

/// Every receipt of a transaction: (predecessor, receiver, actions, failure).
pub async fn trace(
    env: &Env,
    label: &str,
    result: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<Rows> {
    let out = rpc(
        env,
        "EXPERIMENTAL_tx_status",
        json!({"tx_hash": result.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}),
    )
    .await?;
    let tx = &out["result"];
    println!("--- trace: {label}");
    let receipts = tx["receipts"].as_array().cloned().unwrap_or_default();
    let first = json!({
        "predecessor_id": tx["transaction"]["signer_id"],
        "receiver_id": tx["transaction"]["receiver_id"],
        "receipt": {"Action": {"actions": tx["transaction"]["actions"]}},
    });
    let mut rows = Vec::new();
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
        let failure = outcome["outcome"]["status"]
            .get("Failure")
            .map(|f| f.to_string().chars().take(150).collect::<String>());
        let gas = outcome["outcome"]["gas_burnt"].as_u64().unwrap_or(0);
        let from = receipt["predecessor_id"]
            .as_str()
            .unwrap_or("?")
            .to_string();
        let to = receipt["receiver_id"].as_str().unwrap_or("?").to_string();
        println!(
            "  {:>12} → {:<14} {:<56} {} {:.2} Tgas",
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

pub fn failed_with(rows: &Rows, to: &str, text: &str) -> bool {
    rows.iter()
        .any(|(_, r, _, f)| r == to && f.as_deref().is_some_and(|f| f.contains(text)))
}

/// A transfer `from` → `to` of exactly `amount` that succeeded.
pub fn sent(rows: &Rows, from: &str, to: &str, amount: u128) -> bool {
    rows.iter().any(|(f, r, a, fail)| {
        f == from && r == to && fail.is_none() && a == &format!("Transfer {}", near(amount))
    })
}

/// The amount of each successful plain transfer `from` → `to`.
pub fn transfers(rows: &Rows, from: &str, to: &str) -> Vec<u128> {
    rows.iter()
        .filter(|(f, r, a, fail)| {
            f == from && r == to && fail.is_none() && a.starts_with("Transfer ")
        })
        .map(|(_, _, a, _)| parse_near(a.trim_start_matches("Transfer ")))
        .collect()
}

pub fn parse_near(s: &str) -> u128 {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    let frac = format!("{frac:0<24}");
    whole.parse::<u128>().unwrap() * NEAR + frac.parse::<u128>().unwrap()
}

pub fn assert_refused(result: &ExecutionFinalResult, text: &str) {
    let failure = format!("{:?}", result.failures());
    assert!(failure.contains(text), "expected {text:?} in {failure}");
}

// ---- Escrow ----

pub async fn settlement(env: &Env, bounty: u64, kind: u8) -> anyhow::Result<Value> {
    Ok(env
        .escrow
        .view("get_settlement")
        .args_json(json!({"bounty": bounty, "kind": kind}))
        .await?
        .json()?)
}

pub async fn held(env: &Env) -> anyhow::Result<u128> {
    let v: Value = env.escrow.view("held").await?.json()?;
    Ok(v.as_str().unwrap().parse()?)
}

pub async fn vault_of(env: &Env, key: &SigningKey) -> anyhow::Result<AccountId> {
    let on_chain: AccountId = env
        .escrow
        .view("vault_of")
        .args_json(json!({"key": public(key)}))
        .await?
        .json()?;
    assert_eq!(on_chain, derive(env.code_hash, &vault_entries(&pk33(key))));
    Ok(on_chain)
}

pub async fn faults(
    env: &Env,
    callbacks: bool,
    deposit: bool,
    reconcile_callback: bool,
    delay_hops: u8,
) -> anyhow::Result<()> {
    env.escrow
        .call("set_faults")
        .args_json(json!({"faults": {"callbacks": callbacks, "deposit": deposit, "reconcile_callback": reconcile_callback, "delay_hops": delay_hops}}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// The maintainer locks `amount` for the holder of `key`, with that key's bind proof.
pub async fn reserve(
    env: &Env,
    bounty: u64,
    kind: u8,
    key: &SigningKey,
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    let proof = bind_proof(env, key, bounty, kind);
    reserve_with(env, bounty, kind, key, &proof, amount).await
}

pub async fn reserve_with(
    env: &Env,
    bounty: u64,
    kind: u8,
    key: &SigningKey,
    proof: &str,
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .maint
        .call(env.escrow.id(), "reserve")
        .args_json(json!({"bounty": bounty, "kind": kind, "key": public(key), "proof": proof}))
        .deposit(NearToken::from_yoctonear(amount))
        .transact()
        .await?)
}

pub async fn settle(env: &Env, bounty: u64, kind: u8) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .stranger
        .call(env.escrow.id(), "settle")
        .args_json(json!({"bounty": bounty, "kind": kind}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

pub async fn reconcile(
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

pub fn answer(result: &ExecutionFinalResult) -> String {
    result
        .clone()
        .json::<String>()
        .unwrap_or_else(|_| format!("failed: {:?}", result.failures()))
}

// ---- Vault ----

pub struct Info {
    pub next: u64,
    pub fund: u128,
    pub available: u128,
}

pub async fn info(env: &Env, vault: &AccountId) -> anyhow::Result<Info> {
    env.sandbox.fast_forward(2).await?;
    let r = env.sandbox.view(vault, "info").args(vec![]).await?.result;
    assert_eq!(r.len(), 73);
    Ok(Info {
        next: u64::from_le_bytes(r[33..41].try_into()?),
        fund: u128::from_le_bytes(r[41..57].try_into()?),
        available: u128::from_le_bytes(r[57..73].try_into()?),
    })
}

/// (deposited, attempt, amount, sealed through)
pub async fn slot(
    env: &Env,
    vault: &AccountId,
    issuer: &AccountId,
    bounty: u64,
    kind: u8,
) -> anyhow::Result<(bool, u32, u128, u32)> {
    let mut args = Vec::new();
    borsh_str(&mut args, issuer.as_str());
    args.extend(bounty.to_le_bytes());
    args.push(kind);
    let r = env.sandbox.view(vault, "slot").args(args).await?.result;
    Ok((
        r[0] == 1,
        u32::from_le_bytes(r[1..5].try_into()?),
        u128::from_le_bytes(r[5..21].try_into()?),
        u32::from_le_bytes(r[21..25].try_into()?),
    ))
}

/// Submits a signed withdrawal from `who` (the relayer, normally), who pays the gas.
pub async fn withdraw(
    _env: &Env,
    who: &Account,
    vault: &AccountId,
    to: &str,
    amount: u128,
    seq: u64,
    sig: &[u8; 64],
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(vault, "withdraw")
        .args(withdraw_args(to, amount, seq, sig))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?)
}

/// Signs with `key` for this chain and submits through the relayer.
pub async fn signed_withdraw(
    env: &Env,
    key: &SigningKey,
    vault: &AccountId,
    to: &AccountId,
    amount: u128,
    seq: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    let sig = withdraw_sig(key, &env.chain, vault.as_str(), to.as_str(), amount, seq);
    withdraw(env, &env.relayer, vault, to.as_str(), amount, seq, &sig).await
}

pub async fn state_init(
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

pub fn refund_to(rows: &Rows, to: &str, amount: u128) -> bool {
    sent(rows, "system", to, amount)
}
