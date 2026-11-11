//! The link storage deposit, in the sandbox with real WASM and exact balances.
//!
//! `link` attaches exactly 0.017 NEAR: 0.01 for the OutLayer run and 0.007 for the link record's
//! storage. `on_link` sends the 0.007 back to the wallet for every outcome other than `linked`,
//! `link_pending` and `link_refreshed`; on those three it stays and pays for the record. These tests
//! show, with the contract starting at a spare balance of exactly zero and the longest account
//! names and gist ids the contract accepts:
//! - a failed link returns exactly 0.007 and costs the wallet only gas and the run's charge;
//! - a successful link keeps 0.007, and the contract's storage cost grows by no more than that;
//! - a wrong deposit is refused with nothing charged beyond gas;
//! - many wallets linking never lower the contract's spare balance (the drain check);
//! - repeated claim/expire cycles by different linked wallets on one bounty: the growth per cycle
//!   (the `barred` entry) is measured and set against what the bounty's deposit and the links cover.
//!
//! The OutLayer mock keeps 0.001 NEAR per run (`MOCK_CHARGE`); that is not a real OutLayer charge.
//! Build first (see tests/common/mod.rs). Run with
//! `cargo test --offline --test link_storage -- --test-threads 1`.
//! Measurements go to runs/pr-bounty/simple-flow/measured-costs.json (section `link_storage`).

mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// The largest bounty-contract inputs: a 64-byte contract account, 64-byte wallet accounts and
/// 64-character gist ids, with a spare balance of exactly zero.
async fn worst_env(wasm: &'static str) -> anyhow::Result<Env> {
    let repo = format!("{}/{}", "o".repeat(39), "r".repeat(100));
    let mut env = setup(
        Opts::new(wasm)
            .names(&"m".repeat(54), &"c".repeat(54))
            .contract(&"x".repeat(54))
            .free(0)
            .repo(&repo),
    )
    .await?;
    assert_eq!(
        (
            env.maint.id().len(),
            env.contrib.id().len(),
            env.bounty.id().len()
        ),
        (64, 64, 64)
    );
    env.base_ref = "b".repeat(255);
    env.gist_len = 64;
    assert_eq!(free_balance(&env).await?, 0, "no spare balance");
    Ok(env)
}

/// A wallet with a 64-byte account name.
async fn wallet(env: &Env, i: usize) -> anyhow::Result<Account> {
    let w = sub(&env.root, &format!("w{i:053}"), 3 * NEAR, None).await?;
    assert_eq!(w.id().len(), 64);
    Ok(w)
}

#[derive(Clone, Copy, Debug)]
struct Snap {
    wallet: u128,
    contract: u128,
    outlayer: u128,
    bytes: u64,
    /// `get_free_balance`, which saturates at zero.
    free: u128,
    /// Balance minus storage, principals and float, without saturating.
    slack: i128,
}

async fn snap(env: &Env, wallet: &AccountId) -> anyhow::Result<Snap> {
    env.sandbox.fast_forward(3).await?;
    Ok(Snap {
        wallet: bal(env, wallet).await?,
        contract: bal(env, env.bounty.id()).await?,
        outlayer: bal(env, env.outlayer.id()).await?,
        bytes: storage(env, env.bounty.id()).await?,
        free: free_balance(env).await?,
        slack: slack(env).await?,
    })
}

/// What one link call did, measured against the snapshots around it.
struct Linked {
    wallet: String,
    outcome: String,
    before: Snap,
    after: Snap,
    burnt: u128,
    rows: Rows,
}

impl Linked {
    fn wallet_cost(&self) -> u128 {
        self.before.wallet - self.after.wallet
    }
    fn contract_gain(&self) -> i128 {
        self.after.contract as i128 - self.before.contract as i128
    }
    fn bytes(&self) -> i128 {
        i128::from(self.after.bytes) - i128::from(self.before.bytes)
    }
    fn storage_cost(&self) -> i128 {
        self.bytes() * BYTE as i128
    }
    fn free_change(&self) -> i128 {
        self.after.free as i128 - self.before.free as i128
    }
    fn slack_change(&self) -> i128 {
        self.after.slack - self.before.slack
    }
}

async fn link_measured(
    env: &Env,
    who: &Account,
    label: &str,
    gist: &str,
    spec: GistSpec,
) -> anyhow::Result<Linked> {
    let before = snap(env, who.id()).await?;
    let result = link_with(env, who, gist, spec).await?;
    finish_linked(env, who, label, before, result).await
}

/// A link call whose reply the test already set, with `expires` and the right deposit.
async fn link_custom(
    env: &Env,
    who: &Account,
    label: &str,
    gist: &str,
    expires: u64,
) -> anyhow::Result<Linked> {
    let before = snap(env, who.id()).await?;
    let result = call(
        who,
        env,
        "link",
        json!({"gist_id": gist, "expires_at": expires.to_string()}),
        RUN + LINK_STORAGE,
    )
    .await?;
    finish_linked(env, who, label, before, result).await
}

async fn finish_linked(
    env: &Env,
    who: &Account,
    label: &str,
    before: Snap,
    result: ExecutionFinalResult,
) -> anyhow::Result<Linked> {
    let burn = tx_burn(env, &result, who.id()).await?;
    let rows = trace(env, label, &result, who.id()).await?;
    let after = snap(env, who.id()).await?;
    let l = Linked {
        wallet: who.id().to_string(),
        outcome: answer(&result),
        before,
        after,
        burnt: burn.tokens,
        rows,
    };
    env.note(format!(
        "  [{label}] outcome {}; wallet cost {}; contract balance {:+}; storage {:+} bytes ({:+} yocto); \
         spare balance {:+} (slack {:+}); burnt {}",
        l.outcome,
        near(l.wallet_cost()),
        l.contract_gain(),
        l.bytes(),
        l.storage_cost(),
        l.free_change(),
        l.slack_change(),
        near(l.burnt)
    ));
    Ok(l)
}

/// The wallet paid the run's charge, gas, and nothing else: the 0.007 came back in full.
fn assert_returned(env: &Env, l: &Linked, label: &str) {
    assert!(
        sent(&l.rows, env.bounty.id().as_str(), &l.wallet, LINK_STORAGE),
        "{label}: the contract sent exactly 0.007 NEAR to the wallet"
    );
    assert_eq!(l.bytes(), 0, "{label}: nothing is stored");
    // The mock keeps its charge and pays the gas of its own receipts out of it.
    assert!(
        l.after.outlayer > l.before.outlayer && l.after.outlayer - l.before.outlayer <= MOCK_CHARGE,
        "{label}: OutLayer kept its run charge less its gas"
    );
    // Gas the wallet paid: everything above the run's charge. The contract's own gas reward, if
    // the sandbox pays one, is part of what it gained.
    let gas_paid = l.wallet_cost() - MOCK_CHARGE;
    assert_eq!(
        gas_paid as i128,
        l.burnt as i128 + l.contract_gain(),
        "{label}: the wallet's net cost is the run's charge plus gas"
    );
    assert!(
        l.contract_gain() >= 0 && (l.contract_gain() as u128) < LINK_STORAGE,
        "{label}: the contract kept none of the deposit (gained {})",
        l.contract_gain()
    );
    assert!(
        l.free_change() >= 0 && l.slack_change() >= 0,
        "{label}: spare balance did not fall"
    );
    assert!(
        gas_paid < 5 * MILLI,
        "{label}: gas {} is small beside the deposit",
        near(gas_paid)
    );
}

// ---- (a) failed and successful links ----

#[tokio::test]
async fn a_failed_link_returns_the_whole_storage_deposit_and_a_successful_one_keeps_it(
) -> anyhow::Result<()> {
    let env = worst_env(RELEASE_WASM).await?;
    let who = env.contrib.clone();
    assert_eq!(env.link_storage, LINK_STORAGE);
    let mut rows = Vec::new();

    // Failed: the challenge does not match.
    let g = env.next_gist();
    let l = link_measured(
        &env,
        &who,
        "link: challenge mismatch",
        &g,
        GistSpec {
            challenge_matches: false,
            ..GistSpec::good(GH)
        },
    )
    .await?;
    assert_eq!(l.outcome, "mismatch:challenge");
    assert_returned(&env, &l, "challenge mismatch");
    rows.push(json!({"case": "mismatch:challenge", "wallet_cost_yocto": l.wallet_cost().to_string(), "burnt_yocto": l.burnt.to_string(), "returned_yocto": LINK_STORAGE.to_string(), "contract_balance_change_yocto": l.contract_gain().to_string(), "bytes": l.bytes()}));

    // Failed: more than one file in the gist.
    let g = env.next_gist();
    let l = link_measured(
        &env,
        &who,
        "link: ambiguous gist",
        &g,
        GistSpec {
            files: 2,
            ..GistSpec::good(GH)
        },
    )
    .await?;
    assert_eq!(l.outcome, "mismatch:ambiguous");
    assert_returned(&env, &l, "ambiguous gist");

    // Failed: OutLayer's run returned nothing.
    reply(&env, "null", None).await?;
    let expires = now_secs(&env).await? + 1800;
    let g = env.next_gist();
    let l = link_custom(&env, &who, "link: the run returns nothing", &g, expires).await?;
    assert_eq!(l.outcome, "no_result:no_output");
    assert_returned(&env, &l, "no_output");
    rows.push(json!({"case": "no_result:no_output", "wallet_cost_yocto": l.wallet_cost().to_string(), "burnt_yocto": l.burnt.to_string(), "returned_yocto": LINK_STORAGE.to_string(), "contract_balance_change_yocto": l.contract_gain().to_string(), "bytes": l.bytes()}));

    // Failed: the verifier's own "no result" answer (GitHub unreachable) for the gist look.
    let g = env.next_gist();
    let expires = now_secs(&env).await? + 1800;
    let challenge: String = env
        .bounty
        .view("link_challenge")
        .args_json(json!({"wallet": who.id(), "expires_at": expires.to_string()}))
        .await?
        .json()?;
    let op = proven_pr_bounty_verifier::Op::Gist {
        gist_id: g.clone(),
        challenge,
    };
    let body = proven_pr_bounty_verifier::render(
        Some(&request(&env, op)),
        &ctx(&env),
        Err(proven_pr_bounty_verifier::Reason::Unreachable),
    );
    echo(&env, body).await?;
    let l = link_custom(
        &env,
        &who,
        "link: the verifier reports GitHub unreachable",
        &g,
        expires,
    )
    .await?;
    assert!(l.outcome.starts_with("no_result:"), "{}", l.outcome);
    assert_returned(&env, &l, "verifier no_result");
    assert!(
        get_link(&env, who.id()).await?.is_null(),
        "nothing was linked"
    );

    // Successful: the first link keeps the 0.007, pays the record's storage from it, and the
    // surplus stays as spare balance.
    let g = env.next_gist();
    let l = link_measured(
        &env,
        &who,
        "link: first link (worst-case names)",
        &g,
        GistSpec::good(GH),
    )
    .await?;
    assert_eq!(l.outcome, "linked");
    let first = successful(&env, &l, "first link");
    rows.push(first);

    // Successful: a refresh with a new gist (the same GitHub id).
    let g = env.next_gist();
    let l = link_measured(
        &env,
        &who,
        "link: refresh with a new gist",
        &g,
        GistSpec::good(GH),
    )
    .await?;
    assert_eq!(l.outcome, "link_refreshed");
    rows.push(successful(&env, &l, "refresh"));

    // Successful: a relink to another GitHub id waits (pending) and keeps the deposit.
    let g = env.next_gist();
    let l = link_measured(
        &env,
        &who,
        "link: relink to another GitHub id",
        &g,
        GistSpec::good(GH2),
    )
    .await?;
    assert_eq!(l.outcome, "link_pending");
    rows.push(successful(&env, &l, "pending relink with an active link"));

    // Successful: a second wallet asking for a GitHub id that is held waits (pending) as its first
    // link and keeps the deposit.
    let other = wallet(&env, 1).await?;
    let g = env.next_gist();
    let l = link_measured(
        &env,
        &other,
        "link: first link of a wallet for a held GitHub id",
        &g,
        GistSpec::good(GH),
    )
    .await?;
    assert_eq!(l.outcome, "link_pending");
    rows.push(successful(&env, &l, "first link that is pending"));

    write_section(
        "link_storage",
        json!({
            "note": "Sandbox, release build, spare balance exactly zero before each case, 64-byte contract and wallet accounts, 64-character gist ids. `link` attaches RUN (0.01) + LINK_STORAGE_DEPOSIT (0.007). Failed outcomes return 0.007 in full; the wallet's net cost is OutLayer's run charge (the mock keeps 0.001, not a real charge) plus gas. Successful outcomes keep 0.007; the storage the record uses is paid from it and the rest stays as spare balance.",
            "link_storage_deposit_near": near(LINK_STORAGE),
            "byte_price_yocto": BYTE.to_string(),
            "cases": rows,
        }),
    )?;
    env.save_trace("link-storage-failed-and-successful")?;
    Ok(())
}

/// A successful link: the contract kept the deposit and its storage cost grew by no more than it.
fn successful(env: &Env, l: &Linked, label: &str) -> Value {
    let storage_cost = l.storage_cost();
    assert!(l.bytes() > 0, "{label}: a record was stored");
    assert!(
        !sent(&l.rows, env.bounty.id().as_str(), &l.wallet, LINK_STORAGE),
        "{label}: the deposit was not sent back"
    );
    assert!(
        storage_cost <= LINK_STORAGE as i128,
        "{label}: the record's storage ({} bytes = {} yocto) fits in the deposit",
        l.bytes(),
        storage_cost
    );
    // The contract's balance grew by exactly the deposit (plus any gas reward, which only adds).
    assert!(
        l.contract_gain() >= LINK_STORAGE as i128,
        "{label}: the contract kept the whole deposit"
    );
    assert!(
        l.free_change() >= 0 && l.slack_change() >= 0,
        "{label}: spare balance did not fall (spare {:+}, slack {:+})",
        l.free_change(),
        l.slack_change()
    );
    assert_eq!(
        l.slack_change(),
        l.contract_gain() - storage_cost,
        "{label}: spare balance grew by the balance gained less the storage cost"
    );
    // The mock keeps its charge and pays the gas of its own receipts out of it.
    assert!(
        l.after.outlayer > l.before.outlayer && l.after.outlayer - l.before.outlayer <= MOCK_CHARGE,
        "{label}: OutLayer kept its run charge less its gas"
    );
    let gas_paid = l.wallet_cost() as i128 - MOCK_CHARGE as i128 - LINK_STORAGE as i128;
    assert_eq!(
        gas_paid,
        l.burnt as i128 + (l.contract_gain() - LINK_STORAGE as i128),
        "{label}: the wallet paid the run, the deposit and gas"
    );
    json!({
        "case": label, "outcome": l.outcome, "bytes": l.bytes(), "storage_cost_yocto": storage_cost.to_string(),
        "deposit_yocto": LINK_STORAGE.to_string(),
        "surplus_after_storage_yocto": (LINK_STORAGE as i128 - storage_cost).to_string(),
        "contract_balance_change_yocto": l.contract_gain().to_string(),
        "spare_balance_change_yocto": l.free_change().to_string(),
        "wallet_cost_yocto": l.wallet_cost().to_string(), "burnt_yocto": l.burnt.to_string(),
    })
}

// ---- (b) a wrong deposit ----

#[tokio::test]
async fn a_link_with_any_deposit_other_than_exactly_0_017_near_is_refused() -> anyhow::Result<()> {
    let env = worst_env(RELEASE_WASM).await?;
    let who = env.contrib.clone();
    let expires = now_secs(&env).await? + 1800;
    let right = RUN + LINK_STORAGE;
    assert_eq!(right, 17 * MILLI);
    let wrong = [
        ("nothing", 0),
        ("the old 0.01", RUN),
        ("only the storage part, 0.007", LINK_STORAGE),
        ("one yocto short", right - 1),
        ("one yocto over", right + 1),
        ("0.018", right + MILLI),
        ("twice the run, plus storage", 2 * RUN + LINK_STORAGE),
        ("0.03", 30 * MILLI),
        ("a whole NEAR", NEAR),
    ];
    for (name, deposit) in wrong {
        let gist = env.next_gist();
        let before = snap(&env, who.id()).await?;
        let r = call(
            &who,
            &env,
            "link",
            json!({"gist_id": gist, "expires_at": expires.to_string()}),
            deposit,
        )
        .await?;
        assert_refused(&r, "attach exactly 0.017 NEAR");
        let burn = tx_burn(&env, &r, who.id()).await?;
        let after = snap(&env, who.id()).await?;
        env.note(format!(
            "  [wrong deposit: {name}] refused; wallet cost {} (gas only)",
            near(before.wallet - after.wallet)
        ));
        assert_eq!(
            before.wallet - after.wallet,
            burn.tokens,
            "{name}: the deposit came back; the wallet paid gas only"
        );
        assert_eq!(
            after.contract, before.contract,
            "{name}: the contract gained nothing"
        );
        assert_eq!(after.bytes, before.bytes, "{name}: nothing stored");
        assert_eq!(
            after.outlayer, before.outlayer,
            "{name}: no run was started"
        );
    }
    // Nothing was left running: the right deposit links at once.
    let gist = env.next_gist();
    let l = link_measured(
        &env,
        &who,
        "link: right deposit after the refusals",
        &gist,
        GistSpec::good(GH),
    )
    .await?;
    assert_eq!(l.outcome, "linked");
    let cfg = config(&env).await?;
    assert_eq!(u(&cfg["link_storage_deposit"]), LINK_STORAGE);
    assert_eq!(u(&cfg["run_deposit"]), RUN);
    env.save_trace("link-storage-wrong-deposit")?;
    Ok(())
}

// ---- (c) many wallets linking cannot drain the contract ----

#[tokio::test]
async fn many_wallets_linking_never_lower_the_contracts_spare_balance() -> anyhow::Result<()> {
    let env = worst_env(RELEASE_WASM).await?;
    const N: usize = 10;
    let mut wallets = Vec::new();
    for i in 0..N {
        wallets.push(wallet(&env, i + 1).await?);
    }
    let start = snap(&env, env.contrib.id()).await?;
    assert_eq!((start.free, start.slack), (0, 0));
    let mut last_free = start.free;
    let mut last_slack = start.slack;
    let mut per_outcome: std::collections::BTreeMap<String, (u32, i128, i128)> = Default::default();
    let mut steps = 0;
    let mut one = |label: String, l: &Linked, last_free: &mut u128, last_slack: &mut i128| {
        assert!(
            l.after.free >= *last_free,
            "{label}: spare balance fell from {} to {}",
            *last_free,
            l.after.free
        );
        assert!(
            l.after.slack >= *last_slack && l.after.slack >= 0,
            "{label}: slack fell from {} to {}",
            *last_slack,
            l.after.slack
        );
        let e = per_outcome
            .entry(l.outcome.clone())
            .or_insert((0, i128::MAX, 0));
        e.0 += 1;
        e.1 = e.1.min(l.slack_change());
        e.2 += l.slack_change();
        *last_free = l.after.free;
        *last_slack = l.after.slack;
    };
    // Pass 1: every wallet links its own GitHub id (linked).
    for (i, w) in wallets.iter().enumerate() {
        let g = env.next_gist();
        let l = link_measured(
            &env,
            w,
            &format!("pass 1, wallet {i}: first link"),
            &g,
            GistSpec::good(GH + 100 + i as u64),
        )
        .await?;
        assert_eq!(l.outcome, "linked");
        one(
            format!("pass 1 wallet {i}"),
            &l,
            &mut last_free,
            &mut last_slack,
        );
        steps += 1;
    }
    let after_links = last_free;
    // Pass 2: each wallet refreshes with a new gist (link_refreshed).
    for (i, w) in wallets.iter().enumerate() {
        let g = env.next_gist();
        let l = link_measured(
            &env,
            w,
            &format!("pass 2, wallet {i}: refresh"),
            &g,
            GistSpec::good(GH + 100 + i as u64),
        )
        .await?;
        assert_eq!(l.outcome, "link_refreshed");
        one(
            format!("pass 2 wallet {i}"),
            &l,
            &mut last_free,
            &mut last_slack,
        );
        steps += 1;
    }
    // Pass 3: each wallet asks for the next wallet's GitHub id (link_pending).
    for (i, w) in wallets.iter().enumerate() {
        let g = env.next_gist();
        let other = GH + 100 + ((i + 1) % N) as u64;
        let l = link_measured(
            &env,
            w,
            &format!("pass 3, wallet {i}: relink"),
            &g,
            GistSpec::good(other),
        )
        .await?;
        assert_eq!(l.outcome, "link_pending");
        one(
            format!("pass 3 wallet {i}"),
            &l,
            &mut last_free,
            &mut last_slack,
        );
        steps += 1;
    }
    // Pass 4: the same wallets ask again (a pending change replaced) and fail with a mismatch.
    for (i, w) in wallets.iter().enumerate() {
        let g = env.next_gist();
        let other = GH + 100 + ((i + 2) % N) as u64;
        let l = link_measured(
            &env,
            w,
            &format!("pass 4, wallet {i}: replace the pending change"),
            &g,
            GistSpec::good(other),
        )
        .await?;
        assert_eq!(l.outcome, "link_pending");
        one(
            format!("pass 4 wallet {i}"),
            &l,
            &mut last_free,
            &mut last_slack,
        );
        let g = env.next_gist();
        let l = link_measured(
            &env,
            w,
            &format!("pass 4, wallet {i}: mismatch"),
            &g,
            GistSpec {
                challenge_matches: false,
                ..GistSpec::good(other)
            },
        )
        .await?;
        assert_eq!(l.outcome, "mismatch:challenge");
        one(
            format!("pass 4 mismatch {i}"),
            &l,
            &mut last_free,
            &mut last_slack,
        );
        steps += 2;
    }
    env.note(format!(
        "  {steps} links by {N} wallets: spare balance 0 → {last_free} yocto ({} NEAR); after the first links alone {after_links}",
        near(last_free)
    ));
    assert!(
        last_free > 0,
        "the surplus of the 0.007 deposits stays as spare balance"
    );
    let summary: Vec<Value> = per_outcome
        .iter()
        .map(|(k, (n, min, sum))| json!({"outcome": k, "links": n, "smallest_slack_change_yocto": min.to_string(), "total_slack_change_yocto": sum.to_string()}))
        .collect();
    write_section(
        "link_storage_drain_check",
        json!({
            "note": "10 wallets with 64-byte names, 64-byte contract account, 64-character gists, spare balance exactly zero at the start. After every link the spare balance (get_free_balance) and the unsaturated slack were at least what they were before the link.",
            "wallets": N, "links": steps,
            "spare_balance_after_all_yocto": last_free.to_string(), "spare_balance_after_first_links_yocto": after_links.to_string(),
            "per_outcome": summary,
        }),
    )?;
    env.save_trace("link-storage-drain-check")?;
    Ok(())
}

// ---- (d) claim/expire cycles by different linked wallets ----

#[tokio::test]
async fn repeated_claim_and_expire_cycles_by_different_wallets_are_measured_against_what_covers_them(
) -> anyhow::Result<()> {
    // The fault build: claims can be 4 s short.
    let env = worst_env(FAULT_WASM).await?;
    const K: usize = 12;
    let free_before_post = free_balance(&env).await?;
    assert_eq!(free_before_post, 0);
    let bytes_before_post = storage(&env, env.bounty.id()).await?;
    let id = post(&env, 9_100, Timing::SHORT_CLAIM).await?;
    let free_after_post = free_balance(&env).await?;
    let post_bytes = storage(&env, env.bounty.id()).await? - bytes_before_post;
    env.note(format!(
        "  post: {post_bytes} bytes; spare balance after posting {free_after_post} yocto (deposit {} less storage and gas)",
        near(env.storage)
    ));
    assert!(free_after_post > 0);
    // K wallets, each linked to its own GitHub id.
    let mut wallets = Vec::new();
    let mut link_surplus: Vec<i128> = Vec::new();
    for i in 0..K {
        let w = wallet(&env, i + 1).await?;
        let g = env.next_gist();
        let l = link_measured(
            &env,
            &w,
            &format!("link wallet {i}"),
            &g,
            GistSpec::good(GH + 100 + i as u64),
        )
        .await?;
        assert_eq!(l.outcome, "linked");
        link_surplus.push(l.slack_change());
        wallets.push(w);
    }
    let free_after_links = free_balance(&env).await?;
    // The cycles: wallet i claims, lets the claim run out, anyone expires it; the wallet is barred.
    let mut cycle_growth = Vec::new();
    let mut claim_bytes = Vec::new();
    let mut free_trace = vec![free_after_links];
    let mut cycle_slack = Vec::new();
    for (i, w) in wallets.iter().enumerate() {
        let key = signing(100 + i as u8);
        let b0 = storage(&env, env.bounty.id()).await?;
        let c = claim(&env, w, id, &key).await?;
        assert!(c.is_success(), "{:?}", c.failures());
        let b1 = storage(&env, env.bounty.id()).await?;
        let ends_at = get_bounty(&env, id).await?["claim"]["ends_at"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        wait_past(&env, ends_at).await?;
        let e = call(
            &env.stranger,
            &env,
            "expire_claim",
            json!({"bounty_id": id}),
            0,
        )
        .await?;
        assert!(e.is_success(), "{:?}", e.failures());
        let b2 = storage(&env, env.bounty.id()).await?;
        assert!(is_barred(&env, id, w.id()).await?);
        let s = slack(&env).await?;
        let f = free_balance(&env).await?;
        env.note(format!(
            "  [cycle {i}] claim {:+} bytes, expire {:+} bytes, cycle {:+} bytes ({:+} yocto); spare balance {f}; slack {s}",
            b1 as i64 - b0 as i64,
            b2 as i64 - b1 as i64,
            b2 as i64 - b0 as i64,
            (b2 as i64 - b0 as i64) as i128 * BYTE as i128
        ));
        assert!(
            s >= 0,
            "cycle {i}: the contract used money that is not its own"
        );
        cycle_growth.push(b2 as i64 - b0 as i64);
        claim_bytes.push(b1 as i64 - b0 as i64);
        free_trace.push(f);
        cycle_slack.push(s);
    }
    let per_cycle = cycle_growth[0];
    assert!(per_cycle > 0, "a cycle leaves a barred entry behind");
    assert!(
        cycle_growth.iter().all(|g| *g == per_cycle),
        "every cycle grows the contract by the same bytes: {cycle_growth:?}"
    );
    let bar_cost = per_cycle as u128 * BYTE;
    let free_final = *free_trace.last().unwrap();
    // The cycles lowered the spare balance by the barred entries, less any gas reward.
    assert!(
        free_after_links as i128 - free_final as i128 <= K as i128 * bar_cost as i128,
        "the spare balance fell by more than {K} barred entries"
    );
    // What covers them: the bounty's own surplus after posting (the part of the 0.030 deposit not
    // used by its record), and the surplus each link left behind.
    let link_total: i128 = link_surplus.iter().sum();
    let covered_by_post_alone = free_after_post / bar_cost;
    let mean_link_surplus = link_total / K as i128;
    let drop_from_post = free_after_post as i128 - free_final as i128;
    env.note(format!(
        "  barred entry: {per_cycle} bytes = {} NEAR per cycle. After posting the spare balance was {free_after_post}; the {K} links added {link_total} (mean {mean_link_surplus} each); after {K} cycles it is {free_final}. \
         The post's surplus alone covers {covered_by_post_alone} cycles; the bar costs {} per wallet against a link surplus of about {}",
        near(bar_cost),
        near(bar_cost),
        near(mean_link_surplus.max(0) as u128)
    ));
    // The drain check proper: the spare balance after the cycles is not below its value before the
    // bounty was posted (the bounty's deposit plus the links' surplus cover the bars), and it fell
    // from its value just after posting by no more than the post's own surplus.
    assert!(
        free_final >= free_before_post,
        "{K} cycles by distinct linked wallets used money that was not theirs: spare {free_final}"
    );
    assert!(
        drop_from_post <= free_after_post as i128,
        "the spare balance fell by more than the post's surplus"
    );
    write_section(
        "claim_expire_cycles",
        json!({
            "note": "One bounty, worst-case names, fault build (4 s claims). K distinct linked wallets each claim, the claim runs out, anyone calls expire_claim; each wallet ends barred from the bounty. A cycle's only lasting growth is the `barred` entry. The spare balance is `get_free_balance`; it was exactly 0 before the bounty was posted.",
            "cycles": K,
            "claim_bytes_while_claimed": claim_bytes,
            "growth_per_cycle_bytes": per_cycle, "growth_per_cycle_yocto": bar_cost.to_string(), "growth_per_cycle_near": near(bar_cost),
            "spare_balance_before_post_yocto": free_before_post.to_string(),
            "spare_balance_just_after_post_yocto": free_after_post.to_string(),
            "link_surplus_per_wallet_yocto": link_surplus.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            "spare_balance_after_links_yocto": free_after_links.to_string(),
            "spare_balance_after_cycles_yocto": free_final.to_string(),
            "cycles_the_posts_own_surplus_covers_alone": covered_by_post_alone.to_string(),
            "net_per_wallet_link_surplus_less_bar_yocto": (mean_link_surplus - bar_cost as i128).to_string(),
            "spare_balance_by_cycle_yocto": free_trace.iter().map(|f| f.to_string()).collect::<Vec<_>>(),
        }),
    )?;
    env.save_trace("link-storage-claim-expire-cycles")?;
    Ok(())
}
