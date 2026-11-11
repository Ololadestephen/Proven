//! Shared sandbox harness for the one-key PR bounty tests: setup with a published vault, a mock
//! OutLayer and the bounty contract; NEP-413 signing of key proofs and withdrawals; verifier
//! answers made by the verifier's own `render`; receipt traces; exact balance reads.
//!
//! Build first:
//!   (cd ../vault && ./build.sh)
//!   zsh /tmp/build_all.sh        (bounty release and test-faults builds, mock OutLayer, actor)
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
use std::cell::{Cell, RefCell};
use std::io::Write;
use std::str::FromStr;

pub const RELEASE_WASM: &str = "target/near/proven_pr_bounty.wasm";
pub const FAULT_WASM: &str = "target/test-faults/proven_pr_bounty.wasm";
pub const VAULT_WASM: &str = "../vault/out/proven_vault.wasm";
pub const MOCK_WASM: &str = "../mock-outlayer-reply/target/near/proven_mock_outlayer_reply.wasm";
pub const ACTOR_WASM: &str = "../vault-test-actor/target/near/proven_vault_test_actor.wasm";
pub const RESULTS_DIR: &str = "/Users/apple/Desktop/Proven/runs/pr-bounty/simple-flow";
pub const TRACE_DIR: &str = "/Users/apple/Desktop/Proven/runs/pr-bounty/simple-flow/traces";
pub const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
pub const HASH: &str = "6df5a630107bef075bdd09203d64bbd26ec072e6edfd329b2f946a534c4e32fa";
pub const REPO: &str = "proven-test/bounty-pilot";
pub const REPO_ID: u64 = 800_000_001;
/// GitHub account ids of the three contributor wallets' owners.
pub const GH: u64 = 900_000_001;
pub const GH2: u64 = 900_000_002;
pub const GH3: u64 = 900_000_003;
pub const PR: u64 = 12;
pub const PR_ID: u64 = 5_000_000_012;
pub const MILLI: u128 = 1_000_000_000_000_000_000_000;
pub const NEAR: u128 = 1000 * MILLI;
/// Attached to every claim and kept by the contract (0.0001 NEAR).
pub const CLAIM_FEE: u128 = MILLI / 10;
/// The contract's minimum reward in these tests (0.01 NEAR).
pub const MIN_REWARD: u128 = 10 * MILLI;
/// The proposed pilot reward.
pub const REWARD: u128 = 50 * MILLI;
pub const RUN: u128 = 10 * MILLI;
/// What a link call attaches above the run: the link record's storage, returned unless recorded.
pub const LINK_STORAGE: u128 = 7 * MILLI;
pub const RECONCILE: u128 = 10 * MILLI;
/// Storage byte price.
pub const BYTE: u128 = 10_000_000_000_000_000_000;
/// What the OutLayer mock keeps per run. It is not a real OutLayer cost.
pub const MOCK_CHARGE: u128 = MILLI;
pub const FLOAT: u128 = 50 * MILLI;

pub type Rows = Vec<(String, String, String, Option<String>)>;

pub struct Env {
    pub sandbox: Worker<Sandbox>,
    pub chain: String,
    pub root: Account,
    pub globals: Account,
    pub bounty: Contract,
    pub outlayer: Contract,
    pub owner: Account,
    pub sponsor: Account,
    pub maint: Account,
    pub contrib: Account,
    pub rival: Account,
    pub stranger: Account,
    pub relayer: Account,
    pub payee: Account,
    pub fault_stranger: Account,
    /// Each wallet's account key is also the withdrawal key it proves, unless a test says otherwise.
    pub maint_key: SigningKey,
    pub contrib_key: SigningKey,
    pub rival_key: SigningKey,
    pub code_hash: [u8; 32],
    pub publication_cost: u128,
    pub vault_bytes: usize,
    pub trace: RefCell<Vec<String>>,
    /// The base branch posted in terms and reported in pull answers.
    pub base_ref: String,
    /// The pilot repository the contract was deployed with.
    pub repo: String,
    /// Length of the gists ids the helpers invent (1 to 64 lowercase hex characters).
    pub gist_len: usize,
    /// The contract's storage deposit and deposit fee, as it reports them.
    pub storage: u128,
    pub fee: u128,
    /// The deposit a link call attaches above the run's, as the contract reports it.
    pub link_storage: u128,
    /// Tokens burnt by every transaction a helper ran (see `Ledger`).
    pub burnt: Cell<u128>,
    gist_n: Cell<u64>,
    nonce_n: Cell<u64>,
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

pub fn signing(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

pub fn public(k: &SigningKey) -> String {
    format!("ed25519:{}", b58(k.verifying_key().as_bytes()))
}

/// The workspaces secret key for an ed25519 signing key.
pub fn secret(k: &SigningKey) -> SecretKey {
    let mut both = k.to_bytes().to_vec();
    both.extend(k.verifying_key().to_bytes());
    SecretKey::from_str(&format!("ed25519:{}", b58(&both))).expect("a secret key")
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

/// A sub-account of the root holding `near` yoctoNEAR, with `key` (or a random one) as its only
/// full-access key.
pub async fn sub(
    root: &Account,
    name: &str,
    near: u128,
    key: Option<&SigningKey>,
) -> anyhow::Result<Account> {
    let secret_key = key
        .map(secret)
        .unwrap_or_else(|| SecretKey::from_random(KeyType::ED25519));
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_yoctonear(near))
        .keys(secret_key)
        .transact()
        .await?
        .into_result()?)
}

/// What a test chooses about its setup.
#[derive(Clone)]
pub struct Opts {
    pub wasm: &'static str,
    pub maint_name: String,
    pub contrib_name: String,
    pub contract_name: String,
    /// The contract holds only this much beyond its storage and the float, when given.
    pub free: Option<u128>,
    pub float: u128,
    /// The pilot repository fixed at deployment (the longest allowed is 39 + 1 + 100 bytes).
    pub repo: String,
}

impl Opts {
    pub fn new(wasm: &'static str) -> Self {
        Opts {
            wasm,
            maint_name: "maint".into(),
            contrib_name: "contrib".into(),
            contract_name: "bounty".into(),
            free: None,
            float: FLOAT,
            repo: REPO.into(),
        }
    }
    pub fn repo(mut self, repo: &str) -> Self {
        self.repo = repo.into();
        self
    }
    pub fn names(mut self, maint: &str, contrib: &str) -> Self {
        self.maint_name = maint.into();
        self.contrib_name = contrib.into();
        self
    }
    pub fn contract(mut self, name: &str) -> Self {
        self.contract_name = name.into();
        self
    }
    pub fn free(mut self, free: u128) -> Self {
        self.free = Some(free);
        self
    }
    pub fn float(mut self, float: u128) -> Self {
        self.float = float;
        self
    }
}

pub async fn setup_with(contract_wasm: &'static str) -> anyhow::Result<Env> {
    setup(Opts::new(contract_wasm)).await
}

pub async fn setup(o: Opts) -> anyhow::Result<Env> {
    let sandbox = near_workspaces::sandbox().await?;
    let root = sandbox.root_account()?;
    let vault_code = wasm(VAULT_WASM)?;
    let code_hash: [u8; 32] = Sha256::digest(&vault_code).into();
    // Publish the vault as a global contract, by hash, from a helper account.
    let globals = sub(&root, "globals", 10 * NEAR, None)
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
    let (maint_key, contrib_key, rival_key) = (signing(11), signing(21), signing(31));
    let owner = sub(&root, "owner", 5 * NEAR, None).await?;
    let sponsor = sub(&root, "sponsor", 5 * NEAR, None).await?;
    let maint = sub(&root, &o.maint_name, 10 * NEAR, Some(&maint_key)).await?;
    let contrib = sub(&root, &o.contrib_name, 5 * NEAR, Some(&contrib_key)).await?;
    let rival = sub(&root, "rival", 5 * NEAR, Some(&rival_key)).await?;
    let stranger = sub(&root, "stranger", 5 * NEAR, None).await?;
    let relayer = sub(&root, "relayer", 5 * NEAR, None).await?;
    let payee = sub(&root, "payee", NEAR, None).await?;
    let fault_stranger = sub(&root, "fault-stranger", 5 * NEAR, None).await?;
    let code = wasm(o.wasm)?;
    let init = json!({
        "owner": owner.id(), "outlayer": outlayer.id(), "network": "testnet",
        "verifier_url": URL, "verifier_hash": HASH,
        "vault_code_hash": b58(&code_hash), "sponsor": sponsor.id(), "min_reward": MIN_REWARD.to_string(),
        "max_reward": (2 * NEAR).to_string(), "max_held": (5 * NEAR).to_string(), "max_open_per_buyer": 5,
        "max_sponsor_float": (100 * MILLI).to_string(), "max_sponsor_spent": (200 * MILLI).to_string(),
    });
    // With `free`, the contract account holds exactly its storage plus `free` (plus the float): a
    // probe account whose name has the same length measures the storage after init and the
    // allowlist entry, and the root account pays every gas cost of creating the real one.
    let start = match o.free {
        None => 6 * NEAR,
        Some(target) => {
            let mut probe_name = o.contract_name.clone();
            probe_name.replace_range(
                0..1,
                if probe_name.starts_with('p') {
                    "q"
                } else {
                    "p"
                },
            );
            let probe =
                create_with_code(&sandbox, &root, &probe_name, 6 * NEAR, &code, &init).await?;
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
    let bounty = create_with_code(&sandbox, &root, &o.contract_name, start, &code, &init).await?;
    owner
        .call(bounty.id(), "add_poster")
        .args_json(json!({"account": maint.id()}))
        .transact()
        .await?
        .into_result()?;
    sponsor
        .call(bounty.id(), "fund_sponsor")
        .deposit(NearToken::from_yoctonear(o.float))
        .transact()
        .await?
        .into_result()?;
    if let Some(target) = o.free {
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
    let config: Value = bounty.view("get_config").await?.json()?;
    Ok(Env {
        sandbox,
        chain,
        root,
        globals: globals.as_account().clone(),
        bounty,
        outlayer,
        owner,
        sponsor,
        maint,
        contrib,
        rival,
        stranger,
        relayer,
        payee,
        fault_stranger,
        maint_key,
        contrib_key,
        rival_key,
        code_hash,
        publication_cost,
        vault_bytes: vault_code.len(),
        trace: Default::default(),
        base_ref: "main".into(),
        repo: o.repo.clone(),
        gist_len: 32,
        storage: u(&config["storage_deposit"]),
        fee: u(&config["deposit_fee"]),
        link_storage: u(&config["link_storage_deposit"]),
        burnt: Cell::new(0),
        gist_n: Cell::new(0),
        nonce_n: Cell::new(0),
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
    loop {
        let now = now_secs(env).await?;
        if now > secs {
            return Ok(());
        }
        // About 0.3 s of block time per block: jump most of the way, then creep up on it.
        let blocks = ((secs - now) * 3).clamp(2, 3_000);
        env.sandbox.fast_forward(blocks).await?;
        n += 1;
        assert!(n < 20_000, "the sandbox clock did not move");
    }
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

    /// Adds the tokens a transaction burnt (all its receipts) to the running total.
    pub fn tally(&self, r: &ExecutionFinalResult) {
        let burnt: u128 = r
            .outcomes()
            .iter()
            .map(|o| o.tokens_burnt.as_yoctonear())
            .sum();
        self.burnt.set(self.burnt.get() + burnt);
    }

    /// A gist id nobody used yet.
    pub fn next_gist(&self) -> String {
        self.gist_n.set(self.gist_n.get() + 1);
        format!(
            "{:0width$x}",
            0xabc_0000 + self.gist_n.get(),
            width = self.gist_len
        )
    }

    pub fn next_nonce(&self) -> String {
        self.nonce_n.set(self.nonce_n.get() + 1);
        nonce(self.nonce_n.get())
    }

    /// The wallet's account signing with `key`, which must be one of the account's access keys.
    pub fn signing_as(&self, account: &Account, key: &SigningKey) -> Account {
        Account::from_secret_key(account.id().clone(), secret(key), &self.sandbox)
    }

    /// Adds `key` to the account as a second full-access key.
    pub async fn add_access_key(&self, account: &Account, key: &SigningKey) -> anyhow::Result<()> {
        let pk = secret(key).public_key();
        let r = account
            .batch(account.id())
            .add_key(pk, near_workspaces::types::AccessKey::full_access())
            .transact()
            .await?;
        self.tally(&r);
        r.into_result()?;
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

pub async fn get_link(env: &Env, wallet: &AccountId) -> anyhow::Result<Value> {
    Ok(env
        .bounty
        .view("get_link")
        .args_json(json!({"wallet": wallet}))
        .await?
        .json()?)
}

pub async fn github_owner(env: &Env, github_id: u64) -> anyhow::Result<Option<String>> {
    Ok(env
        .bounty
        .view("github_owner_of")
        .args_json(json!({"github_id": github_id.to_string()}))
        .await?
        .json()?)
}

pub async fn is_barred(env: &Env, id: u64, wallet: &AccountId) -> anyhow::Result<bool> {
    Ok(env
        .bounty
        .view("is_barred")
        .args_json(json!({"bounty_id": id, "wallet": wallet}))
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
    let r = who
        .call(env.bounty.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    env.tally(&r);
    Ok(r)
}

pub fn nonce(n: u64) -> String {
    format!("{n:064x}")
}

/// When a bounty's deadlines fall, in seconds from now.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub claim_by: u64,
    pub claim_secs: u64,
    pub merge: u64,
    pub grace: u64,
}

impl Timing {
    /// Claims for an hour, merge within two hours, ten minutes of grace.
    pub const RELEASE: Timing = Timing {
        claim_by: 3_600,
        claim_secs: 3_600,
        merge: 7_200,
        grace: 600,
    };
    /// For the `test-faults` build: a 200 s claim, claims for 5 minutes, merge within 400 s.
    pub const FAULT: Timing = Timing {
        claim_by: 300,
        claim_secs: 200,
        merge: 400,
        grace: 600,
    };
    /// A claim that ends 5 s after it starts (the fault build's shortest is 4 s).
    pub const SHORT_CLAIM: Timing = Timing {
        claim_by: 600,
        claim_secs: 5,
        merge: 900,
        grace: 600,
    };
}

pub fn terms(env: &Env, issue: u64, now: u64, t: Timing) -> Value {
    json!({
        "reward": REWARD.to_string(), "repo": env.repo, "repo_id": REPO_ID.to_string(), "issue": issue,
        "base_ref": env.base_ref, "claim_by": (now + t.claim_by).to_string(),
        "claim_secs": t.claim_secs.to_string(), "merge_deadline": (now + t.merge).to_string(),
        "grace_secs": t.grace.to_string(),
    })
}

/// The posting proof for `terms`: `key` signs the text the contract's own view returns.
pub async fn posting_proof(
    env: &Env,
    terms: &Value,
    key: &SigningKey,
    maintainer: &AccountId,
    nonce: &str,
    expires: u64,
) -> anyhow::Result<Value> {
    let msg: String = env
        .bounty
        .view("posting_key_message")
        .args_json(json!({"terms": terms, "key": public(key), "maintainer": maintainer, "nonce": nonce, "expires_at": expires.to_string()}))
        .await?
        .json()?;
    Ok(json!({
        "nonce": nonce, "expires_at": expires.to_string(),
        "signature": key_proof(key, &msg, env.bounty.id().as_str()),
    }))
}

/// Posts as the maintainer with `key` as the withdrawal key, attaching the reward and `deposit`
/// above it (the contract's storage deposit when `None`).
pub async fn try_post_with(
    env: &Env,
    terms: Value,
    key: &SigningKey,
    proof: Value,
    deposit: Option<u128>,
) -> anyhow::Result<ExecutionFinalResult> {
    try_post_as(env, &env.maint, terms, key, proof, deposit).await
}

/// Like `try_post_with`, with the transaction signed through `account` (which may use another
/// access key than the withdrawal key).
pub async fn try_post_as(
    env: &Env,
    account: &Account,
    terms: Value,
    key: &SigningKey,
    proof: Value,
    deposit: Option<u128>,
) -> anyhow::Result<ExecutionFinalResult> {
    let reward = u(&terms["reward"]);
    let r = account
        .call(env.bounty.id(), "post_bounty")
        .args_json(json!({"terms": terms, "key": public(key), "proof": proof}))
        .deposit(NearToken::from_yoctonear(
            reward + deposit.unwrap_or(env.storage),
        ))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    env.tally(&r);
    Ok(r)
}

pub async fn try_post(
    env: &Env,
    terms: Value,
    proof: Value,
) -> anyhow::Result<ExecutionFinalResult> {
    try_post_with(env, terms, &env.maint_key, proof, None).await
}

/// Posts a bounty for `issue` with the maintainer's own key as the withdrawal key.
pub async fn post(env: &Env, issue: u64, t: Timing) -> anyhow::Result<u64> {
    let r = post_result(env, issue, t, &env.maint_key.clone()).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    Ok(r.json()?)
}

pub async fn post_result(
    env: &Env,
    issue: u64,
    t: Timing,
    key: &SigningKey,
) -> anyhow::Result<ExecutionFinalResult> {
    let now = now_secs(env).await?;
    let terms = terms(env, issue, now, t);
    let proof = posting_proof(
        env,
        &terms,
        key,
        env.maint.id(),
        &env.next_nonce(),
        now + 1800,
    )
    .await?;
    try_post_with(env, terms, key, proof, None).await
}

// ---- Verifier answers ----

pub fn request(env: &Env, op: verifier::Op) -> verifier::Request {
    verifier::Request {
        network: "testnet".into(),
        contract: env.bounty.id().to_string(),
        bounty: 0,
        seq: 0,
        // A link run names no repository; the contract sends this placeholder.
        repo: if matches!(op, verifier::Op::Gist { .. }) {
            "proven/link".into()
        } else {
            env.repo.clone()
        },
        op,
    }
}

pub fn ctx(env: &Env) -> verifier::RunContext {
    verifier::RunContext::from_vars(Some(env.bounty.id().to_string()), Some("20000".to_string()))
}

/// What a link gist looks like to the verifier.
#[derive(Clone, Copy, Debug)]
pub struct GistSpec {
    pub owner_id: u64,
    pub files: u32,
    pub challenge_matches: bool,
}

impl GistSpec {
    pub fn good(owner_id: u64) -> Self {
        GistSpec {
            owner_id,
            files: 1,
            challenge_matches: true,
        }
    }
    fn facts(&self) -> verifier::GistFacts {
        verifier::GistFacts {
            owner_id: self.owner_id,
            files: self.files,
            challenge_matches: self.challenge_matches,
        }
    }
}

/// A pull request as GitHub reports it.
#[derive(Clone, Debug)]
pub struct PullSpec {
    pub repo_id: u64,
    pub number: u64,
    pub pr_id: u64,
    pub author: u64,
    pub base_ref: String,
    pub merged_at: Option<u64>,
}

impl PullSpec {
    pub fn open(env: &Env, author: u64) -> Self {
        PullSpec {
            repo_id: REPO_ID,
            number: PR,
            pr_id: PR_ID,
            author,
            base_ref: env.base_ref.clone(),
            merged_at: None,
        }
    }
    pub fn merged(mut self, at: u64) -> Self {
        self.merged_at = Some(at);
        self
    }
    pub fn id(mut self, pr_id: u64) -> Self {
        self.pr_id = pr_id;
        self
    }
    pub fn base(mut self, base_ref: &str) -> Self {
        self.base_ref = base_ref.into();
        self
    }
    fn facts(&self) -> verifier::PullFacts {
        verifier::PullFacts {
            repo_id: self.repo_id,
            pr_id: self.pr_id,
            pr_number: self.number,
            author_id: self.author,
            base_ref: self.base_ref.clone(),
            state: if self.merged_at.is_some() {
                "closed"
            } else {
                "open"
            }
            .into(),
            merged: self.merged_at.is_some(),
            merged_at: self.merged_at,
        }
    }
}

pub async fn reply(env: &Env, mode: &str, body: Option<String>) -> anyhow::Result<()> {
    let r = env
        .outlayer
        .call("set_reply")
        .args_json(json!({"mode": mode, "reply": body}))
        .transact()
        .await?;
    env.tally(&r);
    r.into_result()?;
    Ok(())
}

/// The next OutLayer run answers with `body`; its bounty and seq are copied from the request.
pub async fn echo(env: &Env, body: String) -> anyhow::Result<()> {
    reply(env, "reply_echo", Some(body)).await
}

pub async fn set_gist_reply(
    env: &Env,
    gist_id: &str,
    challenge: &str,
    spec: GistSpec,
) -> anyhow::Result<()> {
    let op = verifier::Op::Gist {
        gist_id: gist_id.into(),
        challenge: challenge.into(),
    };
    let body = verifier::render(
        Some(&request(env, op)),
        &ctx(env),
        Ok(verifier::Answer::Gist(spec.facts())),
    );
    echo(env, body).await
}

pub async fn set_pull_reply(env: &Env, pull: &PullSpec) -> anyhow::Result<()> {
    let op = verifier::Op::Pull {
        number: pull.number,
    };
    let body = verifier::render(
        Some(&request(env, op)),
        &ctx(env),
        Ok(verifier::Answer::Pull(pull.facts())),
    );
    echo(env, body).await
}

pub async fn set_submit_reply(
    env: &Env,
    pull: &PullSpec,
    gist_id: &str,
    challenge: &str,
    gist: GistSpec,
) -> anyhow::Result<()> {
    let op = verifier::Op::PullGist {
        number: pull.number,
        gist_id: gist_id.into(),
        challenge: challenge.into(),
    };
    let body = verifier::render(
        Some(&request(env, op)),
        &ctx(env),
        Ok(verifier::Answer::PullGist(pull.facts(), gist.facts())),
    );
    echo(env, body).await
}

/// The verifier's own "no result" answer for a pull request look.
pub async fn set_no_result(env: &Env, number: u64, reason: verifier::Reason) -> anyhow::Result<()> {
    let op = verifier::Op::Pull { number };
    let body = verifier::render(Some(&request(env, op)), &ctx(env), Err(reason));
    echo(env, body).await
}

pub async fn change_mode(env: &Env, mode: &str, hops: u32) -> anyhow::Result<()> {
    let r = env
        .outlayer
        .call("set_change")
        .args_json(json!({"mode": mode, "hops": hops}))
        .transact()
        .await?;
    env.tally(&r);
    r.into_result()?;
    Ok(())
}

pub async fn reply_delay(env: &Env, hops: u32) -> anyhow::Result<()> {
    let r = env
        .outlayer
        .call("set_reply_delay")
        .args_json(json!({"hops": hops}))
        .transact()
        .await?;
    env.tally(&r);
    r.into_result()?;
    Ok(())
}

pub async fn last_request(env: &Env) -> anyhow::Result<Value> {
    let s: Option<String> = env.outlayer.view("get_last_request").await?.json()?;
    Ok(serde_json::from_str(&s.unwrap())?)
}

pub fn logged(r: &ExecutionFinalResult, text: &str) -> bool {
    r.logs().iter().any(|l| l.contains(text))
}

pub fn answer(r: &ExecutionFinalResult) -> String {
    r.clone()
        .json::<String>()
        .unwrap_or_else(|_| format!("failed: {:?}", r.failures()))
}

// ---- The contributor's steps ----

/// Links `who` to GitHub account `github_id` with a fresh gist; the result's answer is the outcome.
pub async fn link(
    env: &Env,
    who: &Account,
    github_id: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    let gist = env.next_gist();
    link_with(env, who, &gist, GistSpec::good(github_id)).await
}

pub async fn link_with(
    env: &Env,
    who: &Account,
    gist: &str,
    spec: GistSpec,
) -> anyhow::Result<ExecutionFinalResult> {
    let expires = now_secs(env).await? + 1800;
    let challenge: String = env
        .bounty
        .view("link_challenge")
        .args_json(json!({"wallet": who.id(), "expires_at": expires.to_string()}))
        .await?
        .json()?;
    set_gist_reply(env, gist, &challenge, spec).await?;
    call(
        who,
        env,
        "link",
        json!({"gist_id": gist, "expires_at": expires.to_string()}),
        RUN + LINK_STORAGE,
    )
    .await
}

/// The signature of `key` over the claim message for `wallet`, naming `key` as the payout key.
pub async fn claim_proof(
    env: &Env,
    id: u64,
    wallet: &AccountId,
    github_id: u64,
    key: &SigningKey,
    signer: &SigningKey,
    expires: u64,
) -> anyhow::Result<Value> {
    let msg: String = env
        .bounty
        .view("claim_key_message")
        .args_json(json!({"bounty_id": id, "wallet": wallet, "github_id": github_id.to_string(), "key": public(key), "expires_at": expires.to_string()}))
        .await?
        .json()?;
    Ok(json!({
        "expires_at": expires.to_string(),
        "signature": key_proof(signer, &msg, env.bounty.id().as_str()),
    }))
}

/// The GitHub id of the wallet's active link.
pub async fn active_github_id(env: &Env, wallet: &AccountId) -> anyhow::Result<u64> {
    let link = get_link(env, wallet).await?;
    Ok(link["active"]["github_id"]
        .as_str()
        .expect("an active link")
        .parse()?)
}

/// Claims bounty `id` as `who`, naming `key` as the payout key and proving it.
pub async fn claim(
    env: &Env,
    who: &Account,
    id: u64,
    key: &SigningKey,
) -> anyhow::Result<ExecutionFinalResult> {
    let gh = active_github_id(env, who.id()).await?;
    let expires = now_secs(env).await? + 1800;
    let proof = claim_proof(env, id, who.id(), gh, key, key, expires).await?;
    call(
        who,
        env,
        "claim",
        json!({"bounty_id": id, "key": public(key), "proof": proof}),
        CLAIM_FEE,
    )
    .await
}

/// Submits `pull` for bounty `id`; the verifier reads the wallet's link gist in the same run.
pub async fn submit(
    env: &Env,
    who: &Account,
    id: u64,
    pull: &PullSpec,
) -> anyhow::Result<ExecutionFinalResult> {
    submit_gist(env, who, id, pull, None).await
}

pub async fn submit_gist(
    env: &Env,
    who: &Account,
    id: u64,
    pull: &PullSpec,
    gist: Option<GistSpec>,
) -> anyhow::Result<ExecutionFinalResult> {
    let link = get_link(env, who.id()).await?;
    let active = &link["active"];
    let gist_id = active["gist_id"].as_str().expect("an active link");
    let challenge = active["challenge"].as_str().unwrap();
    let gh: u64 = active["github_id"].as_str().unwrap().parse()?;
    let gist = gist.unwrap_or_else(|| GistSpec::good(gh));
    set_submit_reply(env, pull, gist_id, challenge, gist).await?;
    call(
        who,
        env,
        "submit_pr",
        json!({"bounty_id": id, "pr_number": pull.number}),
        RUN,
    )
    .await
}

/// Links `who` (if not linked), claims bounty `id` with `key` and submits `pull`; asserts each step.
pub async fn claim_and_bind(
    env: &Env,
    who: &Account,
    key: &SigningKey,
    github_id: u64,
    id: u64,
    pull: &PullSpec,
) -> anyhow::Result<()> {
    if get_link(env, who.id()).await?.is_null() {
        let l = link(env, who, github_id).await?;
        assert_eq!(answer(&l), "linked", "{:?}", l.failures());
    }
    let c = claim(env, who, id, key).await?;
    assert!(c.is_success(), "{:?}", c.failures());
    let s = submit(env, who, id, pull).await?;
    assert_eq!(answer(&s), "bound", "{:?}", s.failures());
    Ok(())
}

/// A merge check by `who` attaching `deposit`, after setting the pull request's reply.
pub async fn check(
    env: &Env,
    who: &Account,
    id: u64,
    pull: &PullSpec,
    deposit: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    set_pull_reply(env, pull).await?;
    call(who, env, "check_merge", json!({"bounty_id": id}), deposit).await
}

/// A self-funded check that finds `pull` merged one second before the bounty's deadline.
pub async fn merged_check(
    env: &Env,
    id: u64,
    pull: &PullSpec,
    sponsored: bool,
) -> anyhow::Result<ExecutionFinalResult> {
    let deadline: u64 = get_bounty(env, id).await?["merge_deadline"]
        .as_str()
        .unwrap()
        .parse()?;
    let merged = pull.clone().merged(deadline - 1);
    let (who, deposit) = if sponsored {
        (&env.contrib, 0)
    } else {
        (&env.stranger, RUN)
    };
    let r = check(env, who, id, &merged, deposit).await?;
    assert_eq!(answer(&r), "paid", "{:?} {:?}", r.logs(), r.failures());
    Ok(r)
}

pub async fn reconcile(
    env: &Env,
    who: &Account,
    id: u64,
    kind: &str,
    attempt: u32,
) -> anyhow::Result<ExecutionFinalResult> {
    let r = who
        .call(env.bounty.id(), "reconcile")
        .args_json(json!({"bounty_id": id, "kind": kind, "attempt": attempt}))
        .deposit(NearToken::from_yoctonear(RECONCILE))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    env.tally(&r);
    Ok(r)
}

// ---- Vaults ----

pub struct Info {
    pub key: Vec<u8>,
    pub n: u64,
    pub fund: u128,
    pub available: u128,
}

pub fn parse_info(r: &[u8]) -> Info {
    assert_eq!(r.len(), logic::INFO_LEN);
    Info {
        key: r[0..33].to_vec(),
        n: logic::le_u64(&r[33..41]),
        fund: logic::le_u128(&r[41..57]),
        available: logic::le_u128(&r[57..73]),
    }
}

pub async fn info(env: &Env, vault: &AccountId) -> anyhow::Result<Info> {
    env.sandbox.fast_forward(2).await?;
    let r = env.sandbox.view(vault, "info").args(vec![]).await?.result;
    Ok(parse_info(&r))
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

pub async fn vault_of(env: &Env, key: &SigningKey) -> anyhow::Result<AccountId> {
    let v: AccountId = env
        .bounty
        .view("vault_of")
        .args_json(json!({"key": public(key)}))
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
    env: &Env,
    who: &Account,
    vault: &AccountId,
    args: String,
) -> anyhow::Result<ExecutionFinalResult> {
    let r = who
        .call(vault, "withdraw")
        .args(args.into_bytes())
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    env.tally(&r);
    Ok(r)
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
    submit_withdrawal(env, &env.relayer, vault, args).await
}

// ---- Money accounting ----

/// A set of accounts whose total, plus every token the helpers saw burnt, must stay constant:
/// a stray or lost yoctoNEAR shows as a difference.
pub struct Ledger {
    ids: Vec<AccountId>,
    start: u128,
    burnt0: u128,
}

impl Ledger {
    /// Tracks the test accounts, the contract, OutLayer and `extra` (vaults, new accounts).
    pub async fn new(env: &Env, extra: &[AccountId]) -> anyhow::Result<Self> {
        let mut ids: Vec<AccountId> = [
            &env.owner,
            &env.sponsor,
            &env.maint,
            &env.contrib,
            &env.rival,
            &env.stranger,
            &env.relayer,
            &env.payee,
            &env.fault_stranger,
            &env.globals,
        ]
        .iter()
        .map(|a| a.id().clone())
        .collect();
        ids.push(env.bounty.id().clone());
        ids.push(env.outlayer.id().clone());
        ids.extend(extra.iter().cloned());
        let mut ledger = Ledger {
            ids,
            start: 0,
            burnt0: env.burnt.get(),
        };
        ledger.start = ledger.total(env).await?;
        Ok(ledger)
    }

    pub async fn total(&self, env: &Env) -> anyhow::Result<u128> {
        let mut sum = 0;
        for id in &self.ids {
            sum += bal(env, id).await?;
        }
        Ok(sum)
    }

    /// Adds an account to the tracked set (its current balance counts as already present).
    pub async fn track(&mut self, env: &Env, id: &AccountId) -> anyhow::Result<()> {
        self.start += bal(env, id).await?;
        self.ids.push(id.clone());
        Ok(())
    }

    /// Total now plus burnt tokens, minus the start: zero when no NEAR appeared or vanished.
    pub async fn drift(&self, env: &Env) -> anyhow::Result<i128> {
        let now = self.total(env).await?;
        let burnt = env.burnt.get() - self.burnt0;
        Ok((now + burnt) as i128 - self.start as i128)
    }
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
        Some(r) if r.len() == logic::INFO_LEN => {
            let i = parse_info(&r);
            (i.available, i.fund, i.n)
        }
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

/// Burnt gas of a transaction's receipts whose executor is `account` and that called `method`
/// (by log-free matching on the receipt order is not possible, so callers pass a filter).
pub fn gas_burnt_total(r: &ExecutionFinalResult) -> (u64, u128) {
    let gas: u64 = r.outcomes().iter().map(|o| o.gas_burnt.as_gas()).sum();
    let tokens: u128 = r
        .outcomes()
        .iter()
        .map(|o| o.tokens_burnt.as_yoctonear())
        .sum();
    (gas, tokens)
}

// ---- Small calls ----

pub async fn settle_call(
    env: &Env,
    who: &Account,
    id: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    call(who, env, "settle", json!({"bounty_id": id}), 0).await
}

pub async fn send_due(env: &Env, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(&env.stranger, env, "send_due", json!({"bounty_id": id}), 0).await
}

pub async fn cancel_bounty(env: &Env, id: u64) -> anyhow::Result<ExecutionFinalResult> {
    call(&env.maint, env, "cancel", json!({"bounty_id": id}), 0).await
}

/// The arguments of `claim` for `wallet`, naming `key` as the payout key, signed by `signer`.
pub async fn claim_args(
    env: &Env,
    wallet: &AccountId,
    id: u64,
    key: &SigningKey,
    signer: &SigningKey,
) -> anyhow::Result<Value> {
    let gh = active_github_id(env, wallet).await?;
    let expires = now_secs(env).await? + 1800;
    let proof = claim_proof(env, id, wallet, gh, key, signer, expires).await?;
    Ok(json!({"bounty_id": id, "key": public(key), "proof": proof}))
}

/// Claims through `tx_account` (which may sign with another access key than `key`).
pub async fn claim_as(
    env: &Env,
    tx_account: &Account,
    id: u64,
    key: &SigningKey,
    signer: &SigningKey,
) -> anyhow::Result<ExecutionFinalResult> {
    let args = claim_args(env, tx_account.id(), id, key, signer).await?;
    call(tx_account, env, "claim", args, CLAIM_FEE).await
}

/// Links `who` and asserts the outcome.
pub async fn link_ok(env: &Env, who: &Account, github_id: u64) -> anyhow::Result<()> {
    let l = link(env, who, github_id).await?;
    assert_eq!(answer(&l), "linked", "{:?}", l.failures());
    Ok(())
}

/// The contract's spare balance (as `get_free_balance` reports it) after the latest blocks.
pub async fn free_balance(env: &Env) -> anyhow::Result<u128> {
    env.sandbox.fast_forward(2).await?;
    Ok(u(&env.bounty.view("get_free_balance").await?.json()?))
}

/// Test setup only: lowers the contract's spare balance to exactly `target` by sending the excess
/// to the stranger, signed with the contract account's own key (the sandbox keeps it). One
/// 1-yocto transfer first measures what a transfer's gas costs the contract.
pub async fn set_free(env: &Env, target: u128) -> anyhow::Result<()> {
    let acct = env.bounty.as_account();
    let sink = env.stranger.id();
    let free0 = free_balance(env).await?;
    assert!(
        free0 >= target + MILLI / 10,
        "free {free0} is not a tenth of a milliNEAR above {target}"
    );
    let r = acct
        .transfer_near(sink, NearToken::from_yoctonear(1))
        .await?;
    env.tally(&r);
    let free1 = free_balance(env).await?;
    let cost = free0 - free1 - 1;
    let amount = free1 - target - cost;
    let r = acct
        .transfer_near(sink, NearToken::from_yoctonear(amount))
        .await?;
    env.tally(&r);
    let free2 = free_balance(env).await?;
    assert_eq!(free2, target, "the contract's spare balance is now exact");
    Ok(())
}

/// How many yoctoNEAR a wallet's withdrawal by `key` from `vault` to `to` delivers; asserts it
/// is exactly `amount` and that the transfer receipt exists.
pub async fn withdraw_exact(
    env: &Env,
    key: &SigningKey,
    vault: &AccountId,
    to: &AccountId,
    amount: u128,
    label: &str,
) -> anyhow::Result<()> {
    let before = bal(env, to).await?;
    let i0 = info(env, vault).await?;
    let w = withdraw(env, key, vault, to, amount).await?;
    assert!(w.is_success(), "{label}: {:?}", w.failures());
    let rows = trace(env, label, &w, env.relayer.id()).await?;
    assert!(sent(&rows, vault.as_str(), to.as_str(), amount), "{label}");
    assert_eq!(
        bal(env, to).await? - before,
        amount,
        "{label}: exactly the amount"
    );
    let i1 = info(env, vault).await?;
    assert_eq!(
        (i1.available, i1.n, i1.fund),
        (i0.available - amount, i0.n + 1, i0.fund),
        "{label}: the vault paid exactly the amount, used one number and kept its fund"
    );
    assert!(
        logged(&w, &format!("vault_withdraw key=withdrawal n={}", i0.n)),
        "{label}"
    );
    Ok(())
}

/// The ledger of the whole flow must close: nothing appeared or vanished.
pub async fn assert_closed(env: &Env, ledger: &Ledger, label: &str) -> anyhow::Result<()> {
    let d = ledger.drift(env).await?;
    env.note(format!("  [{label}] ledger drift {d} yocto"));
    assert_eq!(d, 0, "{label}: NEAR appeared or vanished");
    Ok(())
}

/// Adds the tokens burnt by every receipt of a transaction, from the node's own record, to the
/// running total. The workspaces result lists only part of a long receipt tree (for instance the
/// gas-refund receipts at its end); use this instead of `tally` for such transactions.
pub async fn tally_exact(
    env: &Env,
    r: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<()> {
    let out = rpc(
        env,
        "EXPERIMENTAL_tx_status",
        json!({"tx_hash": r.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}),
    )
    .await?;
    let res = &out["result"];
    let mut sum: u128 = res["transaction_outcome"]["outcome"]["tokens_burnt"]
        .as_str()
        .unwrap()
        .parse()?;
    for o in res["receipts_outcome"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        sum += o["outcome"]["tokens_burnt"]
            .as_str()
            .unwrap()
            .parse::<u128>()?;
    }
    env.burnt.set(env.burnt.get() + sum);
    Ok(())
}

// ---- Measurement ----

/// What a transaction's whole receipt tree burnt, from the node's own record.
#[derive(Clone, Debug, Default)]
pub struct Burn {
    pub gas: u64,
    pub tokens: u128,
    /// Gas burnt by receipts executed on the bounty contract.
    pub contract_gas: u64,
    pub receipts: usize,
    /// (executor, method or action, gas) of every receipt, in the node's order.
    pub parts: Vec<(String, String, u64)>,
}

impl Burn {
    pub fn tgas(&self) -> f64 {
        self.gas as f64 / 1e12
    }
    pub fn json(&self, price: u128) -> Value {
        json!({
            "gas": self.gas, "tgas": (self.tgas() * 100.0).round() / 100.0,
            "contract_tgas": ((self.contract_gas as f64 / 1e12) * 100.0).round() / 100.0,
            "near_at_sandbox_gas_price": near(u128::from(self.gas) * price),
            "yocto_at_sandbox_gas_price": (u128::from(self.gas) * price).to_string(),
            "tokens_burnt_incl_refund_penalty_yocto": self.tokens.to_string(),
            "receipts": self.receipts,
        })
    }
}

pub async fn gas_price(env: &Env) -> anyhow::Result<u128> {
    let out = rpc(env, "gas_price", json!([null])).await?;
    Ok(out["result"]["gas_price"].as_str().unwrap().parse()?)
}

pub async fn tx_burn(
    env: &Env,
    r: &ExecutionFinalResult,
    signer: &AccountId,
) -> anyhow::Result<Burn> {
    env.sandbox.fast_forward(2).await?;
    let out = rpc(
        env,
        "EXPERIMENTAL_tx_status",
        json!({"tx_hash": r.outcome().transaction_hash.to_string(), "sender_account_id": signer, "wait_until": "FINAL"}),
    )
    .await?;
    let res = &out["result"];
    let mut b = Burn::default();
    let t = &res["transaction_outcome"]["outcome"];
    b.gas += t["gas_burnt"].as_u64().unwrap_or(0);
    b.tokens += t["tokens_burnt"].as_str().unwrap().parse::<u128>()?;
    let receipts = res["receipts"].as_array().cloned().unwrap_or_default();
    for o in res["receipts_outcome"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let gas = o["outcome"]["gas_burnt"].as_u64().unwrap_or(0);
        b.gas += gas;
        b.tokens += o["outcome"]["tokens_burnt"]
            .as_str()
            .unwrap()
            .parse::<u128>()?;
        b.receipts += 1;
        let executor = o["outcome"]["executor_id"]
            .as_str()
            .unwrap_or("?")
            .to_string();
        if executor == env.bounty.id().as_str() {
            b.contract_gas += gas;
        }
        let what = receipts
            .iter()
            .find(|x| x["receipt_id"] == o["id"])
            .and_then(|x| {
                x["receipt"]["Action"]["actions"]
                    .as_array()
                    .or_else(|| x["receipt"]["ActionV2"]["actions"].as_array())
            })
            .map(|a| a.iter().map(summarize).collect::<Vec<_>>().join(" + "))
            .unwrap_or_else(|| "data".to_string());
        b.parts.push((executor, what, gas));
    }
    Ok(b)
}

/// Sets `key` to `value` in the measured-costs file (creating it), keeping the other sections.
pub fn write_section(key: &str, value: Value) -> anyhow::Result<()> {
    let path = format!("{RESULTS_DIR}/measured-costs.json");
    std::fs::create_dir_all(RESULTS_DIR)?;
    let mut all: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    all[key] = value;
    std::fs::write(&path, serde_json::to_string_pretty(&all)? + "\n")?;
    Ok(())
}

/// Rounds a positive yoctoNEAR amount up to a whole 0.001 NEAR.
pub fn ceil_milli(y: i128) -> u128 {
    if y <= 0 {
        0
    } else {
        (y as u128).div_ceil(MILLI) * MILLI
    }
}
