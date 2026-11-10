//! Shared sandbox harness for the PR bounty vault tests: setup with a published vault, a mock
//! OutLayer and the bounty contract; NEP-413 signing of key proofs and withdrawals; verifier
//! answers made by the verifier's own `render`; receipt traces; exact balance reads.
//!
//! Build first:
//!   (cd ../vault && ./build.sh)
//!   cargo near build non-reproducible-wasm --no-abi --out-dir target/near
//!   cargo near build non-reproducible-wasm --no-abi --features test-faults --out-dir target/test-faults
//!   (cd ../mock-outlayer-reply && cargo near build non-reproducible-wasm --no-abi --out-dir target/near)
//!   (cd ../vault-test-actor && cargo near build non-reproducible-wasm --no-abi --out-dir target/near)
#![allow(dead_code)]

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use proven_pr_bounty_verifier as verifier;
use proven_vault::logic;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;

pub const RELEASE_WASM: &str = "target/near/proven_pr_bounty.wasm";
pub const FAULT_WASM: &str = "target/test-faults/proven_pr_bounty.wasm";
pub const VAULT_WASM: &str = "../vault/out/proven_vault.wasm";
pub const MOCK_WASM: &str = "../mock-outlayer-reply/target/near/proven_mock_outlayer_reply.wasm";
pub const ACTOR_WASM: &str = "../vault-test-actor/target/near/proven_vault_test_actor.wasm";
pub const TRACE_DIR: &str = "/Users/apple/Desktop/Proven/runs/pr-bounty/vault-settlement/traces";
pub const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
pub const HASH: &str = "6df5a630107bef075bdd09203d64bbd26ec072e6edfd329b2f946a534c4e32fa";
pub const REPO: &str = "proven-test/bounty-pilot";
pub const REPO_ID: u64 = 800_000_001;
pub const GH: u64 = 900_000_001;
pub const PR: u64 = 12;
pub const PR_ID: u64 = 5_000_000_012;
pub const GIST: &str = "0123456789abcdef0123456789abcdef";
pub const MILLI: u128 = 1_000_000_000_000_000_000_000;
pub const NEAR: u128 = 1000 * MILLI;
/// The proposed pilot reward.
pub const REWARD: u128 = 50 * MILLI;
pub const BUDGET: u128 = 30 * MILLI;
pub const STORAGE: u128 = 29 * MILLI;
pub const RUN: u128 = 10 * MILLI;
pub const RECONCILE: u128 = 10 * MILLI;
pub const DEPOSIT_FEE: u128 = 6 * MILLI;
pub const BYTE: u128 = 10_000_000_000_000_000_000;
pub const MOCK_CHARGE: u128 = MILLI;
pub const FLOAT: u128 = 50 * MILLI;

pub type Rows = Vec<(String, String, String, Option<String>)>;

pub struct Keys {
    pub primary: SigningKey,
    pub backup: SigningKey,
}

impl Keys {
    pub fn new(a: u8, b: u8) -> Self {
        Keys {
            primary: SigningKey::from_bytes(&[a; 32]),
            backup: SigningKey::from_bytes(&[b; 32]),
        }
    }
    pub fn json(&self) -> Value {
        json!({"primary": public(&self.primary), "backup": public(&self.backup)})
    }
}

pub struct Env {
    pub sandbox: Worker<Sandbox>,
    pub chain: String,
    pub root: Account,
    pub bounty: Contract,
    pub outlayer: Contract,
    pub owner: Account,
    pub sponsor: Account,
    pub maint: Account,
    pub contrib: Account,
    pub stranger: Account,
    pub relayer: Account,
    pub payee: Account,
    pub fault_stranger: Account,
    pub maint_keys: Keys,
    pub contrib_keys: Keys,
    pub code_hash: [u8; 32],
    pub publication_cost: u128,
    pub vault_bytes: usize,
    pub trace: std::cell::RefCell<Vec<String>>,
    /// The base branch posted in terms and reported in pull answers.
    pub base_ref: String,
}

pub fn wasm(path: &str) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| anyhow::anyhow!("{path}: {e}; build first (see the header)"))
}

pub fn b58(b: &[u8]) -> String {
    bs58::encode(b).into_string()
}

pub fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn public(k: &SigningKey) -> String {
    format!("ed25519:{}", b58(k.verifying_key().as_bytes()))
}

/// NEP-413: SHA-256 of tag + borsh(message, nonce, recipient, no URL), signed.
pub fn nep413(key: &SigningKey, message: &str, nonce: [u8; 32], recipient: &str) -> [u8; 64] {
    let mut p = 2_147_484_061u32.to_le_bytes().to_vec();
    p.extend((message.len() as u32).to_le_bytes());
    p.extend(message.as_bytes());
    p.extend(nonce);
    p.extend((recipient.len() as u32).to_le_bytes());
    p.extend(recipient.as_bytes());
    p.push(0);
    let hash: [u8; 32] = Sha256::digest(&p).into();
    key.sign(&hash).to_bytes()
}

/// A key proof over `message`: its nonce is SHA-256 of the message, its recipient the contract.
pub fn key_proof(key: &SigningKey, message: &str, contract: &str) -> String {
    b64(&nep413(
        key,
        message,
        Sha256::digest(message.as_bytes()).into(),
        contract,
    ))
}

/// Creates `name` under the root with exactly `balance`, deploys `code` and calls `new`, all in
/// one transaction the root signs and pays for.
async fn create_with_code(
    sandbox: &Worker<Sandbox>,
    root: &Account,
    name: &str,
    balance: u128,
    code: &[u8],
    init: &Value,
) -> anyhow::Result<Contract> {
    let id: AccountId = format!("{name}.{}", root.id()).parse()?;
    let key = SecretKey::from_random(KeyType::ED25519);
    root.batch(&id)
        .create_account()
        .transfer(NearToken::from_yoctonear(balance))
        .add_key(
            key.public_key(),
            near_workspaces::types::AccessKey::full_access(),
        )
        .deploy(code)
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(init.clone())
                .gas(Gas::from_tgas(100)),
        )
        .transact()
        .await?
        .into_result()?;
    Ok(Contract::from_secret_key(id, key, sandbox))
}

async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_yoctonear(near))
        .keys(SecretKey::from_random(KeyType::ED25519))
        .transact()
        .await?
        .into_result()?)
}

pub async fn setup_with(contract_wasm: &str) -> anyhow::Result<Env> {
    setup_named(contract_wasm, "maint", "contrib").await
}

/// Setup with chosen sub-account names for the maintainer and the contributor wallet.
pub async fn setup_named(
    contract_wasm: &str,
    maint_name: &str,
    contrib_name: &str,
) -> anyhow::Result<Env> {
    setup_opts(contract_wasm, maint_name, contrib_name, None).await
}

/// Setup whose contract holds only `free` yoctoNEAR beyond its storage and the float, when given,
/// as an owner who funds just what the pilot needs would run it.
pub async fn setup_opts(
    contract_wasm: &str,
    maint_name: &str,
    contrib_name: &str,
    free: Option<u128>,
) -> anyhow::Result<Env> {
    setup_full(contract_wasm, maint_name, contrib_name, free, FLOAT).await
}

/// Setup with a chosen sponsor float as well.
pub async fn setup_full(
    contract_wasm: &str,
    maint_name: &str,
    contrib_name: &str,
    free: Option<u128>,
    float: u128,
) -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let root = sandbox.root_account()?;
    let vault_code = wasm(VAULT_WASM)?;
    let code_hash: [u8; 32] = Sha256::digest(&vault_code).into();
    // Publish the vault as a global contract, by hash, from a helper account.
    let globals = sub(&root, "globals", 10 * NEAR)
        .await?
        .deploy(&wasm(ACTOR_WASM)?)
        .await?
        .into_result()?;
    let before = balance(&sandbox, globals.id()).await?;
    let r = globals
        .call("deploy_global")
        .args_json(json!({"code": b64(&vault_code)}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let publication_cost = before - balance(&sandbox, globals.id()).await?;
    let outlayer = sandbox.dev_deploy(&wasm(MOCK_WASM)?).await?;
    outlayer.call("new").transact().await?.into_result()?;
    let owner = sub(&root, "owner", 5 * NEAR).await?;
    let sponsor = sub(&root, "sponsor", 5 * NEAR).await?;
    let maint = sub(&root, maint_name, 10 * NEAR).await?;
    let contrib = sub(&root, contrib_name, 5 * NEAR).await?;
    let stranger = sub(&root, "stranger", 5 * NEAR).await?;
    let relayer = sub(&root, "relayer", 5 * NEAR).await?;
    let payee = sub(&root, "payee", NEAR).await?;
    let fault_stranger = sub(&root, "fault-stranger", 5 * NEAR).await?;
    let code = wasm(contract_wasm)?;
    let init = json!({
        "owner": owner.id(), "outlayer": outlayer.id(), "network": "testnet",
        "verifier_url": URL, "verifier_hash": HASH, "pilot_repo": REPO, "pilot_repo_id": REPO_ID.to_string(),
        "vault_code_hash": b58(&code_hash), "sponsor": sponsor.id(),
        "max_reward": (2 * NEAR).to_string(), "max_held": (5 * NEAR).to_string(), "max_open_per_buyer": 5,
        "max_sponsor_float": (100 * MILLI).to_string(), "max_sponsor_spent": (200 * MILLI).to_string(),
    });
    // With `free`, the contract account holds exactly its storage plus `free` (plus the float): a
    // probe account of the same name length measures the storage after init and the allowlist
    // entry, and the root account pays every gas cost of creating the real one.
    let start = match free {
        None => 6 * NEAR,
        Some(target) => {
            let probe = create_with_code(&sandbox, &root, "bprobe", 6 * NEAR, &code, &init).await?;
            owner
                .call(probe.id(), "add_poster")
                .args_json(json!({"account": maint.id()}))
                .transact()
                .await?
                .into_result()?;
            sandbox.fast_forward(2).await?;
            u128::from(sandbox.view_account(probe.id()).await?.storage_usage) * BYTE + target
        }
    };
    let bounty = create_with_code(&sandbox, &root, "bounty", start, &code, &init).await?;
    owner
        .call(bounty.id(), "add_poster")
        .args_json(json!({"account": maint.id()}))
        .transact()
        .await?
        .into_result()?;
    sponsor
        .call(bounty.id(), "fund_sponsor")
        .deposit(NearToken::from_yoctonear(float))
        .transact()
        .await?
        .into_result()?;
    if let Some(target) = free {
        let now: u128 = u(&bounty.view("get_free_balance").await?.json()?);
        assert_eq!(
            now, target,
            "the contract's spare balance is exactly the target"
        );
    }
    let status: Value = reqwest::Client::new()
        .post(sandbox.rpc_addr())
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "status", "params": []}))
        .send()
        .await?
        .json()
        .await?;
    let chain = status["result"]["chain_id"].as_str().unwrap().to_string();
    Ok(Env {
        sandbox,
        chain,
        root,
        bounty,
        outlayer,
        owner,
        sponsor,
        maint,
        contrib,
        stranger,
        relayer,
        payee,
        fault_stranger,
        maint_keys: Keys::new(11, 12),
        contrib_keys: Keys::new(21, 22),
        code_hash,
        publication_cost,
        vault_bytes: vault_code.len(),
        trace: Default::default(),
        base_ref: "main".into(),
    })
}

// ---- Reading the chain ----

pub async fn rpc(env: &Env, method: &str, params: Value) -> anyhow::Result<Value> {
    Ok(reqwest::Client::new()
        .post(env.sandbox.rpc_addr())
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        .send()
        .await?
        .json()
        .await?)
}

pub async fn balance(sandbox: &Worker<Sandbox>, id: &AccountId) -> anyhow::Result<u128> {
    sandbox.fast_forward(2).await?;
    Ok(sandbox.view_account(id).await?.balance.as_yoctonear())
}

/// An account's balance after pending refunds landed, or 0 if it does not exist.
pub async fn bal(env: &Env, id: &AccountId) -> anyhow::Result<u128> {
    env.sandbox.fast_forward(2).await?;
    let out = rpc(
        env,
        "query",
        json!({"request_type": "view_account", "finality": "final", "account_id": id}),
    )
    .await?;
    Ok(out["result"]["amount"]
        .as_str()
        .map(|a| a.parse().unwrap())
        .unwrap_or(0))
}

pub async fn storage(env: &Env, id: &AccountId) -> anyhow::Result<u64> {
    env.sandbox.fast_forward(2).await?;
    let out = rpc(
        env,
        "query",
        json!({"request_type": "view_account", "finality": "final", "account_id": id}),
    )
    .await?;
    Ok(out["result"]["storage_usage"].as_u64().unwrap_or(0))
}

pub async fn now_secs(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp() / 1_000_000_000)
}

/// Moves the sandbox clock past Unix second `secs`.
pub async fn wait_past(env: &Env, secs: u64) -> anyhow::Result<()> {
    let mut n = 0;
    while now_secs(env).await? <= secs {
        env.sandbox.fast_forward(20).await?;
        n += 1;
        assert!(n < 2000, "the sandbox clock did not move");
    }
    Ok(())
}

pub fn near(y: u128) -> String {
    let s = format!("{}.{:024}", y / NEAR, y % NEAR);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
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

impl Env {
    pub fn note(&self, line: impl Into<String>) {
        let line = line.into();
        println!("{line}");
        self.trace.borrow_mut().push(line);
    }

    /// Writes the collected trace to the private evidence folder.
    pub fn save_trace(&self, name: &str) -> anyhow::Result<()> {
        std::fs::create_dir_all(TRACE_DIR)?;
        let mut f = std::fs::File::create(format!("{TRACE_DIR}/{name}.txt"))?;
        for l in self.trace.borrow().iter() {
            writeln!(f, "{l}")?;
        }
        Ok(())
    }
}

/// Every receipt of a transaction, printed and recorded: (predecessor, receiver, actions, failure).
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
    env.note(format!(
        "--- {label} (tx {})",
        result.outcome().transaction_hash
    ));
    let receipts = tx["receipts"].as_array().cloned().unwrap_or_default();
    let first = json!({
        "predecessor_id": tx["transaction"]["signer_id"], "receiver_id": tx["transaction"]["receiver_id"],
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
            .map(|f| f.to_string().chars().take(140).collect::<String>());
        let gas = outcome["outcome"]["gas_burnt"].as_u64().unwrap_or(0);
        let from = receipt["predecessor_id"]
            .as_str()
            .unwrap_or("?")
            .to_string();
        let to = receipt["receiver_id"].as_str().unwrap_or("?").to_string();
        env.note(format!(
            "  {} {:>12} → {:<14} {:<52} {} {:.2} Tgas",
            &outcome["id"].as_str().unwrap_or("?")[..8],
            short(&from),
            short(&to),
            actions,
            failure
                .as_deref()
                .map_or("ok".to_string(), |f| format!("FAILED {f}")),
            gas as f64 / 1e12
        ));
        rows.push((from, to, actions, failure));
    }
    Ok(rows)
}

pub fn failed_with(rows: &Rows, to: &str, text: &str) -> bool {
    rows.iter()
        .any(|(_, r, _, f)| r == to && f.as_deref().is_some_and(|f| f.contains(text)))
}

/// A successful plain transfer `from` → `to` of exactly `amount`.
pub fn sent(rows: &Rows, from: &str, to: &str, amount: u128) -> bool {
    rows.iter().any(|(f, r, a, fail)| {
        f == from && r == to && fail.is_none() && a == &format!("Transfer {}", near(amount))
    })
}

pub fn assert_refused(result: &ExecutionFinalResult, text: &str) {
    let failure = format!("{:?}", result.failures());
    assert!(failure.contains(text), "expected {text:?} in {failure}");
}

// ---- Bounty contract ----

pub async fn config(env: &Env) -> anyhow::Result<Value> {
    Ok(env.bounty.view("get_config").await?.json()?)
}

pub fn u(v: &Value) -> u128 {
    v.as_str()
        .expect("a U128 string")
        .parse()
        .expect("a number")
}

pub async fn held(env: &Env) -> anyhow::Result<(u128, u128)> {
    let c = config(env).await?;
    Ok((u(&c["held"]), u(&c["in_flight"])))
}

pub async fn get_bounty(env: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(env
        .bounty
        .view("get_bounty")
        .args_json(json!({"bounty_id": id}))
        .await?
        .json()?)
}

pub async fn settlement(env: &Env, id: u64, kind: &str) -> anyhow::Result<Value> {
    Ok(env
        .bounty
        .view("get_settlement")
        .args_json(json!({"bounty_id": id, "kind": kind}))
        .await?
        .json()?)
}

pub async fn call(
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

pub fn terms(issue: u64, now: u64, claim: u64, bind: u64, merge: u64) -> Value {
    json!({
        "reward": REWARD.to_string(), "repo": REPO, "repo_id": REPO_ID.to_string(), "issue": issue,
        "base_ref": "main", "contributor_github_id": GH.to_string(),
        "claim_by": (now + claim).to_string(), "bind_by": (now + bind).to_string(),
        "merge_deadline": (now + merge).to_string(), "grace_secs": "600",
    })
}

/// The posting proof for `terms`: both maintainer keys sign the texts the contract's own view
/// returns for them.
pub async fn posting_proof(
    env: &Env,
    terms: &Value,
    keys: &Keys,
    maintainer: &AccountId,
    nonce: &str,
    expires: u64,
) -> anyhow::Result<Value> {
    let mut sigs = Vec::new();
    for (signing, key) in [("primary", &keys.primary), ("backup", &keys.backup)] {
        let msg: String = env
            .bounty
            .view("posting_key_message")
            .args_json(json!({"terms": terms, "keys": keys.json(), "maintainer": maintainer, "nonce": nonce, "expires_at": expires.to_string(), "signing": signing}))
            .await?
            .json()?;
        sigs.push(key_proof(key, &msg, env.bounty.id().as_str()));
    }
    Ok(
        json!({"nonce": nonce, "expires_at": expires.to_string(), "primary_signature": sigs[0], "backup_signature": sigs[1]}),
    )
}

pub fn nonce(n: u64) -> String {
    format!("{n:064x}")
}

pub async fn try_post(
    env: &Env,
    terms: Value,
    proof: Value,
) -> anyhow::Result<ExecutionFinalResult> {
    let reward = u(&terms["reward"]);
    Ok(env
        .maint
        .call(env.bounty.id(), "post_bounty")
        .args_json(json!({"terms": terms, "keys": env.maint_keys.json(), "proof": proof}))
        .deposit(NearToken::from_yoctonear(reward + BUDGET + STORAGE))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

/// Posts a bounty for `issue` with deadlines `claim`, `bind`, `merge` seconds from now.
pub async fn post(
    env: &Env,
    issue: u64,
    n: u64,
    claim: u64,
    bind: u64,
    merge: u64,
) -> anyhow::Result<u64> {
    let now = now_secs(env).await?;
    let mut t = terms(issue, now, claim, bind, merge);
    t["base_ref"] = json!(env.base_ref);
    let proof = posting_proof(
        env,
        &t,
        &env.maint_keys,
        env.maint.id(),
        &nonce(n),
        now + 1800,
    )
    .await?;
    let r = try_post(env, t, proof).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    Ok(r.json()?)
}

pub fn request(env: &Env, bounty: u64, seq: u64, op: verifier::Op) -> verifier::Request {
    verifier::Request {
        network: "testnet".into(),
        contract: env.bounty.id().to_string(),
        bounty,
        seq,
        repo: REPO.into(),
        op,
    }
}

pub fn ctx(env: &Env, request_id: u64) -> verifier::RunContext {
    verifier::RunContext::from_vars(
        Some(env.bounty.id().to_string()),
        Some(request_id.to_string()),
    )
}

pub fn gist_reply(env: &Env, bounty: u64, seq: u64) -> String {
    let op = verifier::Op::Gist {
        gist_id: GIST.into(),
        challenge: format!("proven-claim:{}", "0".repeat(64)),
    };
    let facts = verifier::GistFacts {
        owner_id: GH,
        files: 1,
        challenge_matches: true,
    };
    verifier::render(
        Some(&request(env, bounty, seq, op)),
        &ctx(env, 20_000 + seq),
        Ok(verifier::Answer::Gist(facts)),
    )
}

pub fn pull_reply(env: &Env, bounty: u64, seq: u64, merged_at: Option<u64>) -> String {
    pull_reply_into(env, bounty, seq, merged_at, &env.base_ref)
}

/// A pull answer reporting the pull request against `base_ref`.
pub fn pull_reply_into(
    env: &Env,
    bounty: u64,
    seq: u64,
    merged_at: Option<u64>,
    base_ref: &str,
) -> String {
    let facts = verifier::PullFacts {
        repo_id: REPO_ID,
        pr_id: PR_ID + bounty,
        pr_number: PR,
        author_id: GH,
        base_ref: base_ref.to_string(),
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

pub async fn reply(env: &Env, mode: &str, body: Option<String>) -> anyhow::Result<()> {
    env.outlayer
        .call("set_reply")
        .args_json(json!({"mode": mode, "reply": body}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn change_mode(env: &Env, mode: &str, hops: u32) -> anyhow::Result<()> {
    env.outlayer
        .call("set_change")
        .args_json(json!({"mode": mode, "hops": hops}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn last_request(env: &Env) -> anyhow::Result<Value> {
    let s: Option<String> = env.outlayer.view("get_last_request").await?.json()?;
    Ok(serde_json::from_str(&s.unwrap())?)
}

pub async fn next_seq(env: &Env, id: u64) -> anyhow::Result<u64> {
    // Sequence numbers are global; the last check record or live run tells the latest.
    let b = get_bounty(env, id).await?;
    let from_live = b["live"]["seq"].as_str().map(|s| s.parse::<u64>().unwrap());
    let from_last = b["last_check"]["seq"]
        .as_str()
        .map(|s| s.parse::<u64>().unwrap());
    Ok(from_live.or(from_last).unwrap_or(0) + 1)
}

/// Claims bounty `id` as the contributor wallet with the contributor's key pair. `seq` is the
/// global sequence number the claim run will get.
pub async fn claim(env: &Env, id: u64, seq: u64) -> anyhow::Result<ExecutionFinalResult> {
    let now = now_secs(env).await?;
    let expires = now + 1800;
    let mut sigs = Vec::new();
    for (signing, key) in [
        ("primary", &env.contrib_keys.primary),
        ("backup", &env.contrib_keys.backup),
    ] {
        let msg: String = env
            .bounty
            .view("claim_key_message")
            .args_json(json!({"bounty_id": id, "wallet": env.contrib.id(), "expires_at": expires.to_string(), "keys": env.contrib_keys.json(), "signing": signing}))
            .await?
            .json()?;
        sigs.push(key_proof(key, &msg, env.bounty.id().as_str()));
    }
    reply(env, "reply", Some(gist_reply(env, id, seq))).await?;
    call(
        &env.contrib,
        env,
        "prove_claim",
        json!({"bounty_id": id, "gist_id": GIST, "expires_at": expires.to_string(), "keys": env.contrib_keys.json(), "primary_signature": sigs[0], "backup_signature": sigs[1]}),
        RUN,
    )
    .await
}

pub fn logged(r: &ExecutionFinalResult, text: &str) -> bool {
    r.logs().iter().any(|l| l.contains(text))
}

/// Claim (seq), nominate (seq + 1).
pub async fn claim_and_bind(env: &Env, id: u64, seq: u64) -> anyhow::Result<()> {
    let c = claim(env, id, seq).await?;
    assert!(
        logged(&c, "outcome=claimed"),
        "{:?} {:?}",
        c.logs(),
        c.failures()
    );
    reply(env, "reply", Some(pull_reply(env, id, seq + 1, None))).await?;
    let n = call(
        &env.maint,
        env,
        "nominate",
        json!({"bounty_id": id, "pr_number": PR}),
        RUN,
    )
    .await?;
    assert!(logged(&n, "outcome=bound"), "{:?}", n.logs());
    Ok(())
}

/// A merge check (seq) that finds the PR merged a second before the deadline, sponsored when
/// `sponsored`.
pub async fn merged_check(
    env: &Env,
    id: u64,
    seq: u64,
    sponsored: bool,
) -> anyhow::Result<ExecutionFinalResult> {
    let deadline: u64 = get_bounty(env, id).await?["merge_deadline"]
        .as_str()
        .unwrap()
        .parse()?;
    reply(
        env,
        "reply",
        Some(pull_reply(env, id, seq, Some(deadline - 1))),
    )
    .await?;
    let (who, deposit) = if sponsored {
        (&env.contrib, 0)
    } else {
        (&env.stranger, RUN)
    };
    let r = call(who, env, "check_merge", json!({"bounty_id": id}), deposit).await?;
    assert!(
        logged(&r, "outcome=paid"),
        "{:?} {:?}",
        r.logs(),
        r.failures()
    );
    Ok(r)
}

pub async fn reconcile(
    env: &Env,
    who: &Account,
    id: u64,
    kind: &str,
    attempt: u32,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.bounty.id(), "reconcile")
        .args_json(json!({"bounty_id": id, "kind": kind, "attempt": attempt}))
        .deposit(NearToken::from_yoctonear(RECONCILE))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

pub fn answer(r: &ExecutionFinalResult) -> String {
    r.clone()
        .json::<String>()
        .unwrap_or_else(|_| format!("failed: {:?}", r.failures()))
}

// ---- Vaults ----

pub struct Info {
    pub primary: Vec<u8>,
    pub backup: Vec<u8>,
    pub n: u64,
    pub fund: u128,
    pub available: u128,
}

pub async fn info(env: &Env, vault: &AccountId) -> anyhow::Result<Info> {
    env.sandbox.fast_forward(2).await?;
    let r = env.sandbox.view(vault, "info").args(vec![]).await?.result;
    assert_eq!(r.len(), logic::INFO_LEN);
    Ok(Info {
        primary: r[0..33].to_vec(),
        backup: r[33..66].to_vec(),
        n: logic::le_u64(&r[66..74]),
        fund: logic::le_u128(&r[74..90]),
        available: logic::le_u128(&r[90..106]),
    })
}

pub async fn record(
    env: &Env,
    vault: &AccountId,
    id: u64,
    kind: u8,
) -> anyhow::Result<logic::Record> {
    let issuer = env.bounty.id().as_str();
    let mut args = (issuer.len() as u32).to_le_bytes().to_vec();
    args.extend(issuer.as_bytes());
    args.extend(id.to_le_bytes());
    args.push(kind);
    let r = env.sandbox.view(vault, "slot").args(args).await?.result;
    Ok(logic::Record::decode(&r).unwrap())
}

pub async fn vault_of(env: &Env, keys: &Keys) -> anyhow::Result<AccountId> {
    let v: AccountId = env
        .bounty
        .view("vault_of")
        .args_json(json!({"primary": public(&keys.primary), "backup": public(&keys.backup)}))
        .await?
        .json()?;
    Ok(v)
}

/// The JSON arguments of a withdrawal signed by `key` for `chain`.
pub fn withdrawal(
    key: &SigningKey,
    chain: &str,
    vault: &str,
    to: &str,
    amount: u128,
    n: u64,
    deadline: u64,
) -> String {
    let message = format!("proven-vault-withdraw:v2|chain={chain}|vault={vault}|to={to}|amount={amount}|n={n}|deadline={deadline}");
    let sig = nep413(key, &message, logic::withdraw_nonce(n), vault);
    format!(
        r#"{{"to":"{to}","amount":"{amount}","n":"{n}","deadline":"{deadline}","signature":"{}"}}"#,
        hex(&sig)
    )
}

pub async fn submit_withdrawal(
    who: &Account,
    vault: &AccountId,
    args: String,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(vault, "withdraw")
        .args(args.into_bytes())
        .gas(Gas::from_tgas(30))
        .transact()
        .await?)
}

/// Signs with `key` for this chain and submits from the relayer.
pub async fn withdraw(
    env: &Env,
    key: &SigningKey,
    vault: &AccountId,
    to: &AccountId,
    amount: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    let i = info(env, vault).await?;
    let deadline = now_secs(env).await? + 600;
    let args = withdrawal(
        key,
        &env.chain,
        vault.as_str(),
        to.as_str(),
        amount,
        i.n,
        deadline,
    );
    submit_withdrawal(&env.relayer, vault, args).await
}

// ---- Recovery helpers ----

/// Block time (ns) of the block that ran the transaction's first receipt, where the contract
/// checked its rules.
pub async fn exec_ns(env: &Env, r: &ExecutionFinalResult) -> anyhow::Result<u64> {
    let first = r
        .receipt_outcomes()
        .first()
        .map(|o| o.block_hash)
        .unwrap_or(r.outcome().block_hash);
    Ok(env
        .sandbox
        .view_block()
        .block_hash(first)
        .await?
        .timestamp())
}

pub async fn block_ns(env: &Env) -> anyhow::Result<u64> {
    Ok(env.sandbox.view_block().await?.timestamp())
}

/// Waits, in real time, until the head block's time passes `ns`.
pub async fn sleep_past_ns(env: &Env, ns: u64) -> anyhow::Result<()> {
    let mut n = 0;
    while block_ns(env).await? <= ns {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        n += 1;
        assert!(n < 600, "the sandbox clock did not move");
    }
    Ok(())
}

/// (state, attempt, sent_at ns, outcome, marker present) of one settlement.
pub async fn sstate(
    env: &Env,
    id: u64,
    kind: &str,
) -> anyhow::Result<(String, u64, u64, String, bool)> {
    let s = settlement(env, id, kind).await?;
    Ok((
        s["state"].as_str().unwrap_or("?").to_string(),
        s["attempt"].as_u64().unwrap_or(0),
        s["sent_at"]
            .as_str()
            .map(|v| v.parse().unwrap())
            .unwrap_or(0),
        s["outcome"].as_str().unwrap_or("?").to_string(),
        !s["reconcile"].is_null(),
    ))
}

async fn peek_call(
    env: &Env,
    account: &AccountId,
    method: &str,
    args: &[u8],
) -> anyhow::Result<Option<Vec<u8>>> {
    let out = rpc(
        env,
        "query",
        json!({"request_type": "call_function", "finality": "optimistic", "account_id": account, "method_name": method, "args_base64": b64(args)}),
    )
    .await?;
    Ok(out["result"]["result"]
        .as_array()
        .map(|a| a.iter().map(|b| b.as_u64().unwrap() as u8).collect()))
}

pub async fn peek_balance(env: &Env, id: &AccountId) -> anyhow::Result<u128> {
    let out = rpc(
        env,
        "query",
        json!({"request_type": "view_account", "finality": "optimistic", "account_id": id}),
    )
    .await?;
    Ok(out["result"]["amount"]
        .as_str()
        .map(|a| a.parse().unwrap())
        .unwrap_or(0))
}

/// Writes the money state around one action into the trace and returns it for comparison:
/// held, in flight, the settlement, and the vault's balance, withdrawable amount, fund and
/// withdrawal number (zeros while the vault does not exist). Reads the latest executed state
/// and produces no blocks, so it never moves the clock.
pub async fn snapshot(
    env: &Env,
    label: &str,
    id: u64,
    kind: &str,
    vault: &AccountId,
) -> anyhow::Result<Value> {
    let cfg: Value = serde_json::from_slice(
        &peek_call(env, env.bounty.id(), "get_config", b"{}")
            .await?
            .unwrap(),
    )?;
    let (held, in_flight) = (u(&cfg["held"]), u(&cfg["in_flight"]));
    let args = serde_json::to_vec(&json!({"bounty_id": id, "kind": kind}))?;
    let s: Value = serde_json::from_slice(
        &peek_call(env, env.bounty.id(), "get_settlement", &args)
            .await?
            .unwrap(),
    )?;
    let vault_balance = peek_balance(env, vault).await?;
    let (available, fund, n) = match peek_call(env, vault, "info", b"").await? {
        Some(r) if r.len() == logic::INFO_LEN => (
            logic::le_u128(&r[90..106]),
            logic::le_u128(&r[74..90]),
            logic::le_u64(&r[66..74]),
        ),
        _ => (0, 0, 0),
    };
    let contract = peek_balance(env, env.bounty.id()).await?;
    let snap = json!({
        "held": held.to_string(), "in_flight": in_flight.to_string(),
        "state": s["state"], "attempt": s["attempt"], "outcome": s["outcome"], "marker": !s["reconcile"].is_null(),
        "vault_balance": vault_balance.to_string(), "withdrawable": available.to_string(), "fund": fund.to_string(), "n": n,
        "contract_balance": contract.to_string(),
    });
    env.note(format!(
        "  [{label}] {kind} {} attempt {} outcome {} marker {} | held {} in_flight {} | vault {} (withdrawable {} fund {} n {}) | contract {}",
        s["state"].as_str().unwrap_or("?"), s["attempt"], s["outcome"].as_str().unwrap_or("?"), !s["reconcile"].is_null(),
        held, in_flight, vault_balance, available, fund, n, contract
    ));
    Ok(snap)
}

/// The fields of a snapshot that a refused call must leave unchanged (the contract balance may
/// still move by gas rewards).
pub fn same_state(a: &Value, b: &Value) -> bool {
    [
        "held",
        "in_flight",
        "state",
        "attempt",
        "outcome",
        "marker",
        "vault_balance",
        "withdrawable",
        "fund",
        "n",
    ]
    .iter()
    .all(|k| a[k] == b[k])
}

/// Block height of the first successful receipt `from` → `to` transferring exactly `amount` in a
/// transaction's tree.
pub async fn transfer_height(
    env: &Env,
    r: &ExecutionFinalResult,
    signer: &AccountId,
    from: &str,
    to: &str,
    amount: u128,
) -> anyhow::Result<Option<u64>> {
    let out = rpc(
        env,
        "EXPERIMENTAL_tx_status",
        json!({"tx_hash": r.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}),
    )
    .await?;
    let tx = &out["result"];
    let receipts = tx["receipts"].as_array().cloned().unwrap_or_default();
    for outcome in tx["receipts_outcome"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let Some(receipt) = receipts.iter().find(|x| x["receipt_id"] == outcome["id"]) else {
            continue;
        };
        let actions = receipt["receipt"]["Action"]["actions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let is = receipt["predecessor_id"] == from
            && receipt["receiver_id"] == to
            && outcome["outcome"]["status"].get("Failure").is_none()
            && actions.len() == 1
            && actions[0]["Transfer"]["deposit"].as_str() == Some(&amount.to_string());
        if is {
            let hash = outcome["block_hash"].as_str().unwrap().parse()?;
            return Ok(Some(
                env.sandbox.view_block().block_hash(hash).await?.height(),
            ));
        }
    }
    Ok(None)
}

pub async fn exec_height(env: &Env, r: &ExecutionFinalResult) -> anyhow::Result<u64> {
    let first = r
        .receipt_outcomes()
        .first()
        .map(|o| o.block_hash)
        .unwrap_or(r.outcome().block_hash);
    Ok(env.sandbox.view_block().block_hash(first).await?.height())
}

// ---- Recorded fixtures for the web tests ----

pub const WEB_FIXTURES: &str = "../../web/test-fixtures/sandbox";

/// The final `EXPERIMENTAL_tx_status` answer of a transaction.
pub async fn tx_status(
    env: &Env,
    r: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<Value> {
    let out = rpc(
        env,
        "EXPERIMENTAL_tx_status",
        json!({"tx_hash": r.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}),
    )
    .await?;
    Ok(out["result"].clone())
}

/// Writes a recorded answer for the web tests (only when RECORD_WEB_FIXTURES=1).
pub fn save_fixture(name: &str, value: &Value) -> anyhow::Result<()> {
    if std::env::var("RECORD_WEB_FIXTURES").as_deref() != Ok("1") {
        return Ok(());
    }
    std::fs::create_dir_all(WEB_FIXTURES)?;
    std::fs::write(
        format!("{WEB_FIXTURES}/{name}.json"),
        serde_json::to_string_pretty(value)? + "\n",
    )?;
    Ok(())
}

/// The contract's balance beyond its storage, the principals still in it and the float, without
/// saturating: negative means storage or fees were paid from money that belongs to someone.
pub async fn slack(env: &Env) -> anyhow::Result<i128> {
    let balance = bal(env, env.bounty.id()).await? as i128;
    let used = i128::from(storage(env, env.bounty.id()).await?) * BYTE as i128;
    let c = config(env).await?;
    let reserved = (u(&c["held"]) - u(&c["in_flight"])) as i128 + u(&c["sponsor_float"]) as i128;
    Ok(balance - used - reserved)
}
