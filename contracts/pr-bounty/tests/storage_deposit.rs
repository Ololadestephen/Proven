//! The posting storage deposit, measured. Each run is the largest bounty the contract accepts:
//! a 64-byte contract account (the vault's record key holds it), 64-byte maintainer and
//! contributor accounts, the longest repository name, a 255-byte base branch and 64-character
//! gist ids. The contract starts with a spare balance of exactly zero: it holds its storage, the
//! sponsor float and nothing else, and the checks are self-funded so the float is never used.
//! After every step the slack (balance minus storage, principals still in the contract and the
//! float) must be at least zero; a negative slack would mean storage or fees were paid from
//! someone's principal or the float. A run that drains `drain` yoctoNEAR of the deposit right
//! after posting shows the same flow with a smaller deposit, so the smallest working deposit is
//! measured, not computed. The last test writes every measured cost to
//! runs/pr-bounty/simple-flow/measured-costs.json. The OutLayer mock's charge is not a real cost.
//! Build first (see tests/common/mod.rs). Run with
//! `cargo test --offline --test storage_deposit -- --test-threads 1`.

mod common;
use common::*;
use near_workspaces::AccountId;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

/// How the flow treats the link's storage deposit (the tests run one at a time).
/// - false (the contract's design): the wallet's link deposit pays for the link record, so right
///   after the link the surplus it leaves (deposit less the record's storage cost) is taken out of
///   the contract: the rest of the flow then runs on the bounty's storage deposit alone.
/// - true (a check of the old accounting): the whole 0.007 is taken out, as if the link record
///   had no deposit and were paid for from the contract's balance, as in the earlier design.
static LINK_PAID_BY_BOUNTY_DEPOSIT: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Path {
    /// Posted, linked, claimed, submitted, merged on time and paid.
    Payout,
    /// The same up to the submission, then ineligible (merged after the deadline) and refunded.
    Refund,
    /// Posted and cancelled while open.
    Cancel,
}

struct Outcome {
    steps: Vec<Value>,
    /// The lowest slack seen between transactions.
    lowest_step: i128,
    /// The lowest slack when the fee of the settlement send is counted as still out (its excess
    /// has not come back yet): a conservative bound below the observed one.
    lowest: i128,
    peak: i128,
    waiting: bool,
    done: bool,
    /// The new vault's storage fund after its first deposit, and what the fee returned.
    vault_fund: u128,
    returned: u128,
}

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
    assert_eq!(env.repo.len(), 140);
    env.base_ref = "b".repeat(255);
    env.gist_len = 64;
    assert_eq!(free_balance(&env).await?, 0, "no spare balance");
    Ok(env)
}

async fn typical_env(wasm: &'static str) -> anyhow::Result<Env> {
    setup(Opts::new(wasm).free(0)).await
}

/// Measures one step: contract bytes before and after, the slack afterwards, and the burn.
async fn rec(
    env: &Env,
    o: &mut Outcome,
    name: &str,
    before: u64,
    r: &near_workspaces::result::ExecutionFinalResult,
    signer: &AccountId,
    price: u128,
) -> anyhow::Result<u64> {
    let after = storage(env, env.bounty.id()).await?;
    let s = slack(env).await?;
    let float = u(&config(env).await?["sponsor_float"]);
    assert_eq!(float, FLOAT, "{name}: the sponsor float was used");
    let burn = tx_burn(env, r, signer).await?;
    env.note(format!(
        "  [{name}] contract {before} → {after} bytes ({:+}); slack {s} yocto; {:.2} Tgas ({:.2} on the contract)",
        i128::from(after) - i128::from(before),
        burn.tgas(),
        burn.contract_gas as f64 / 1e12
    ));
    o.lowest = o.lowest.min(s);
    o.lowest_step = o.lowest_step.min(s);
    let delta = i128::from(after) - i128::from(before);
    o.steps.push(json!({
        "step": name, "bytes_before": before, "bytes_after": after, "delta_bytes": delta,
        "delta_yocto": (delta * BYTE as i128).to_string(), "delta_near": format!("{:.5}", delta as f64 * BYTE as f64 / NEAR as f64),
        "slack_yocto": s.to_string(), "gas": burn.json(price),
        "parts": burn.parts.iter().map(|(e, w, g)| json!({"executor": e, "action": w, "tgas": (*g as f64 / 1e10).round() / 100.0})).collect::<Vec<_>>(),
    }));
    Ok(after)
}

/// Runs one worst-case flow. `drain` is taken out of the contract's spare balance right after
/// posting (as if the deposit had been that much smaller). `retry` resends a due settlement
/// (for the fault build's failed first deposit).
async fn scenario(
    env: &Env,
    path: Path,
    issue: u64,
    drain: u128,
    retry: bool,
) -> anyhow::Result<Outcome> {
    let price = gas_price(env).await?;
    let mut o = Outcome {
        steps: vec![],
        lowest_step: i128::MAX,
        lowest: i128::MAX,
        peak: i128::MAX,
        waiting: false,
        done: false,
        vault_fund: 0,
        returned: 0,
    };
    let s0 = slack(env).await?;
    assert_eq!(s0, 0, "the contract starts with nothing spare");
    let mut bytes = storage(env, env.bounty.id()).await?;
    let mvault = vault_of(env, &env.maint_key).await?;
    let cvault = vault_of(env, &env.contrib_key).await?;

    let r = post_result(env, issue, Timing::RELEASE, &env.maint_key.clone()).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let id: u64 = r.clone().json()?;
    if drain > 0 {
        let free = free_balance(env).await?;
        set_free(env, free - drain).await?;
        env.note(format!(
            "  deposit reduced by {} NEAR after posting",
            near(drain)
        ));
    }
    bytes = rec(env, &mut o, "post_bounty", bytes, &r, env.maint.id(), price).await?;
    if path == Path::Cancel {
        let r = cancel_bounty(env, id).await?;
        assert!(r.is_success(), "{:?}", r.failures());
        o.waiting |= logged(&r, "settlement_waiting");
        rec(
            env,
            &mut o,
            "cancel (refund)",
            bytes,
            &r,
            env.maint.id(),
            price,
        )
        .await?;
        return finish(env, o, id, &mvault, REWARD, "Refund", retry, price).await;
    }
    let l = link(env, &env.contrib, GH).await?;
    assert_eq!(answer(&l), "linked", "{:?}", l.failures());
    {
        let record = (storage(env, env.bounty.id()).await? - bytes) as u128 * BYTE;
        assert!(
            record <= LINK_STORAGE,
            "the link record fits in its deposit"
        );
        let take = if LINK_PAID_BY_BOUNTY_DEPOSIT.load(Ordering::SeqCst) {
            LINK_STORAGE
        } else {
            LINK_STORAGE - record
        };
        let free = free_balance(env).await?;
        set_free(env, free - take).await?;
        env.note(format!(
            "  link record {record} yocto of the {} NEAR link deposit; {} NEAR taken out of the contract's spare balance",
            near(LINK_STORAGE),
            near(take)
        ));
    }
    bytes = rec(
        env,
        &mut o,
        "link (incl. on_link)",
        bytes,
        &l,
        env.contrib.id(),
        price,
    )
    .await?;
    let c = claim(env, &env.contrib, id, &env.contrib_key.clone()).await?;
    assert!(c.is_success(), "{:?}", c.failures());
    bytes = rec(env, &mut o, "claim", bytes, &c, env.contrib.id(), price).await?;
    let pull = PullSpec::open(env, GH);
    let s = submit(env, &env.contrib, id, &pull).await?;
    assert_eq!(answer(&s), "bound", "{:?}", s.failures());
    bytes = rec(
        env,
        &mut o,
        "submit_pr (incl. on_check)",
        bytes,
        &s,
        env.contrib.id(),
        price,
    )
    .await?;
    let m = get_bounty(env, id).await?["merge_deadline"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    let (kind, vault, principal) = if path == Path::Payout {
        set_pull_reply(env, &pull.clone().merged(m - 1)).await?;
        let r = call(
            &env.stranger,
            env,
            "check_merge",
            json!({"bounty_id": id}),
            RUN,
        )
        .await?;
        assert_eq!(answer(&r), "paid", "{:?}", r.failures());
        o.waiting |= logged(&r, "settlement_waiting");
        rec(
            env,
            &mut o,
            "check_merge pays (incl. on_check, payout send and callbacks)",
            bytes,
            &r,
            env.stranger.id(),
            price,
        )
        .await?;
        ("Payout", cvault, REWARD)
    } else {
        let r = check(env, &env.stranger, id, &pull.clone().merged(m), RUN).await?;
        assert_eq!(answer(&r), "ineligible:merged_after_deadline");
        bytes = rec(
            env,
            &mut o,
            "check_merge finds a late merge (incl. on_check)",
            bytes,
            &r,
            env.stranger.id(),
            price,
        )
        .await?;
        let r = settle_call(env, &env.stranger, id).await?;
        assert!(r.is_success(), "{:?}", r.failures());
        o.waiting |= logged(&r, "settlement_waiting");
        rec(
            env,
            &mut o,
            "settle (refund send and callbacks)",
            bytes,
            &r,
            env.stranger.id(),
            price,
        )
        .await?;
        ("Refund", mvault, REWARD)
    };
    finish(env, o, id, &vault, principal, kind, retry, price).await
}

#[allow(clippy::too_many_arguments)]
async fn finish(
    env: &Env,
    mut o: Outcome,
    id: u64,
    vault: &AccountId,
    principal: u128,
    kind: &str,
    retry: bool,
    price: u128,
) -> anyhow::Result<Outcome> {
    let mut state = settlement(env, id, kind).await?["state"]
        .as_str()
        .unwrap()
        .to_string();
    if state == "Due" && retry {
        let before = storage(env, env.bounty.id()).await?;
        let r = send_due(env, id).await?;
        o.waiting |= logged(&r, "settlement_waiting");
        rec(
            env,
            &mut o,
            "send_due (retry)",
            before,
            &r,
            env.stranger.id(),
            price,
        )
        .await?;
        state = settlement(env, id, kind).await?["state"]
            .as_str()
            .unwrap()
            .to_string();
    }
    o.waiting |= state == "Due";
    o.done = state == "Done";
    if o.done {
        let i = info(env, vault).await?;
        o.vault_fund = i.fund;
        let fee = env.fee;
        assert!(
            i.fund <= fee,
            "the vault's storage ({}) fits in the fee ({fee})",
            i.fund
        );
        o.returned = fee - i.fund;
        // While the deposit's fee is out, the excess is not back yet: a conservative peak.
        let end = slack(env).await?;
        o.peak = end - o.returned as i128;
        o.lowest = o.lowest.min(o.peak);
        assert_eq!(
            i.available, principal,
            "exactly the principal is withdrawable"
        );
        assert_eq!(
            i.fund,
            u128::from(storage(env, vault).await?) * BYTE,
            "the fund is the vault's storage"
        );
        assert_eq!(
            bal(env, vault).await?,
            principal + i.fund,
            "nothing else in the vault"
        );
        assert_eq!(held(env).await?, (0, 0));
    }
    env.note(format!(
        "  result: lowest slack between transactions {} yocto; with the fee counted as out {} (peak {}); vault fund {}, fee returned {}, waiting {}, done {}",
        o.lowest_step, o.lowest, o.peak, o.vault_fund, o.returned, o.waiting, o.done
    ));
    Ok(o)
}

fn assert_fits(o: &Outcome, label: &str) {
    assert!(
        o.lowest >= 0,
        "{label}: the contract used money that is not its own ({} yocto)",
        o.lowest
    );
    assert!(!o.waiting, "{label}: a send waited for balance");
    assert!(o.done, "{label}: the settlement did not complete");
}

#[tokio::test]
async fn a_worst_case_payout_settles_on_its_own_deposit() -> anyhow::Result<()> {
    let env = worst_env(RELEASE_WASM).await?;
    let o = scenario(&env, Path::Payout, 20, 0, false).await?;
    assert_fits(&o, "payout");
    env.note(format!(
        "PAYOUT: deposit {} NEAR; lowest slack {} yocto; vault fund {} yocto",
        near(env.storage),
        o.lowest,
        o.vault_fund
    ));
    withdraw_exact(
        &env,
        &env.contrib_key.clone(),
        &vault_of(&env, &env.contrib_key).await?,
        env.payee.id(),
        REWARD,
        "worst-case payout withdrawn",
    )
    .await?;
    assert!(slack(&env).await? >= 0);
    env.save_trace("deposit-worst-case-payout")?;
    Ok(())
}

#[tokio::test]
async fn a_worst_case_refund_settles_on_its_own_deposit() -> anyhow::Result<()> {
    let env = worst_env(RELEASE_WASM).await?;
    let o = scenario(&env, Path::Refund, 21, 0, false).await?;
    assert_fits(&o, "refund");
    withdraw_exact(
        &env,
        &env.maint_key.clone(),
        &vault_of(&env, &env.maint_key).await?,
        env.maint.id(),
        REWARD,
        "worst-case refund withdrawn",
    )
    .await?;
    env.save_trace("deposit-worst-case-refund")?;
    Ok(())
}

#[tokio::test]
async fn a_worst_case_cancel_settles_on_its_own_deposit() -> anyhow::Result<()> {
    let env = worst_env(RELEASE_WASM).await?;
    let o = scenario(&env, Path::Cancel, 22, 0, false).await?;
    assert_fits(&o, "cancel");
    env.save_trace("deposit-worst-case-cancel")?;
    Ok(())
}

/// Fault build, issue 8500..9000: the first deposit fails and its callbacks run; the retry is
/// paid from the failed deposit's own NEAR.
#[tokio::test]
async fn worst_case_retries_of_a_failed_first_deposit_settle_on_the_same_deposit(
) -> anyhow::Result<()> {
    for (path, issue) in [(Path::Payout, 8_501), (Path::Refund, 8_502)] {
        let env = worst_env(FAULT_WASM).await?;
        let o = scenario(&env, path, issue, 0, true).await?;
        assert_fits(&o, &format!("{path:?} retry"));
        let settlement_kind = if path == Path::Payout {
            "Payout"
        } else {
            "Refund"
        };
        assert_eq!(
            settlement(&env, 0, settlement_kind).await?["attempt"],
            2,
            "{path:?}: settled on the second attempt"
        );
        env.save_trace(&format!("deposit-worst-case-{path:?}-retry").to_lowercase())?;
    }
    Ok(())
}

fn fails(o: &Outcome) -> bool {
    o.lowest_step < 0 || o.waiting || !o.done
}

fn why(o: &Outcome) -> String {
    format!("lowest slack between transactions {} yocto, a send waited for balance: {}, settlement done: {}", o.lowest_step, o.waiting, o.done)
}

/// The smallest deposit, found by running the worst-case flow with the deposit lowered (the
/// difference is moved out of the contract right after posting), one 0.001 NEAR at a time.
/// Two figures per path:
/// - working: the settlement completes and no send waits. Below it the contract's spare balance
///   is under the 0.006 NEAR fee when it should send, so the settlement stays Due.
/// - never borrowing: the slack stays >= 0 even counting the fee as out and its excess not yet back.
#[tokio::test]
async fn the_smallest_working_deposit_is_found_by_running_the_flow_with_less() -> anyhow::Result<()>
{
    let mut rows = Vec::new();
    let (mut d_live, mut d_cons) = (0u128, 0u128);
    let (mut storage, mut fee) = (0, 0);
    for (path, issue) in [(Path::Payout, 30), (Path::Refund, 31), (Path::Cancel, 32)] {
        let env = worst_env(RELEASE_WASM).await?;
        (storage, fee) = (env.storage, env.fee);
        let base = scenario(&env, path, issue, 0, false).await?;
        assert_fits(&base, &format!("{path:?}"));
        let cons = ceil_milli(env.storage as i128 - base.lowest);
        env.note(format!(
            "{path:?}: with {} NEAR the lowest slack is {} (fee counted as out)",
            near(env.storage),
            base.lowest
        ));
        // The never-borrowing deposit completes with slack >= 0 even with the fee out.
        let env = worst_env(RELEASE_WASM).await?;
        let o = scenario(&env, path, issue + 10, storage - cons, false).await?;
        assert_fits(&o, &format!("{path:?} with {} NEAR", near(cons)));
        // Go down one milliNEAR at a time until the flow fails.
        let (mut ok, mut round) = (cons, 0);
        let failing = loop {
            round += 1;
            let try_deposit = ok - MILLI;
            let env = worst_env(RELEASE_WASM).await?;
            let o = scenario(
                &env,
                path,
                issue + 10 * (round + 1),
                storage - try_deposit,
                false,
            )
            .await?;
            env.note(format!(
                "{path:?} with {} NEAR: {}",
                near(try_deposit),
                why(&o)
            ));
            if fails(&o) {
                break (try_deposit, why(&o), o.lowest_step, o.waiting, o.done);
            }
            ok = try_deposit;
        };
        d_live = d_live.max(ok);
        d_cons = d_cons.max(cons);
        rows.push(json!({
            "path": format!("{path:?}"),
            "smallest_working_deposit_near": near(ok),
            "smallest_never_borrowing_deposit_near": near(cons),
            "first_failing_deposit_near": near(failing.0),
            "failing_run": {"why": failing.1, "lowest_slack_yocto": failing.2.to_string(), "send_waited": failing.3, "settlement_done": failing.4},
        }));
    }
    assert!(
        storage - d_live >= MILLI && storage - d_cons >= MILLI,
        "the deposit {} leaves less than 0.001 NEAR over the working ({}) or never-borrowing ({}) figure",
        near(storage),
        near(d_live),
        near(d_cons)
    );
    // The same flow with the link record paid for from the bounty's deposit side (the earlier
    // accounting, the whole 0.007 taken out of the contract after the link): 0.030 must still work.
    LINK_PAID_BY_BOUNTY_DEPOSIT.store(true, Ordering::SeqCst);
    let mut old_rows = Vec::new();
    let mut d_old = 0u128;
    for (path, issue) in [
        (Path::Payout, 530),
        (Path::Refund, 531),
        (Path::Cancel, 532),
    ] {
        let env = worst_env(RELEASE_WASM).await?;
        let o = scenario(&env, path, issue, 0, false).await?;
        LINK_PAID_BY_BOUNTY_DEPOSIT.store(false, Ordering::SeqCst);
        assert_fits(
            &o,
            &format!("{path:?} with the link record paid from the deposit"),
        );
        LINK_PAID_BY_BOUNTY_DEPOSIT.store(true, Ordering::SeqCst);
        let cons = ceil_milli(env.storage as i128 - o.lowest);
        d_old = d_old.max(cons);
        old_rows.push(json!({"path": format!("{path:?}"), "lowest_slack_yocto": o.lowest.to_string(), "smallest_never_borrowing_deposit_near": near(cons)}));
    }
    LINK_PAID_BY_BOUNTY_DEPOSIT.store(false, Ordering::SeqCst);
    assert!(
        storage - d_old >= MILLI,
        "even with the link record paid from the deposit, {} leaves under 0.001 NEAR over {}",
        near(storage),
        near(d_old)
    );

    // The link deposit: the bytes of the worst link records and the smallest whole 0.001 NEAR that
    // covers them.
    let env = worst_env(RELEASE_WASM).await?;
    let mut link_rows = Vec::new();
    let mut worst_bytes = 0u64;
    for (label, who, github_id, expect) in [
        (
            "first link of a wallet (linked)",
            &env.contrib,
            GH,
            "linked",
        ),
        (
            "same GitHub id, new gist (link_refreshed)",
            &env.contrib,
            GH,
            "link_refreshed",
        ),
        (
            "relink of a linked wallet to another GitHub id (link_pending)",
            &env.contrib,
            GH2,
            "link_pending",
        ),
        (
            "first link of a second wallet for a held GitHub id (link_pending)",
            &env.rival,
            GH,
            "link_pending",
        ),
    ] {
        let b0 = common::storage(&env, env.bounty.id()).await?;
        let l = link(&env, who, github_id).await?;
        assert_eq!(answer(&l), expect, "{label}: {:?}", l.failures());
        let bytes = common::storage(&env, env.bounty.id()).await? - b0;
        worst_bytes = worst_bytes.max(bytes);
        let cost = u128::from(bytes) * BYTE;
        assert!(
            cost <= env.link_storage,
            "{label}: {bytes} bytes do not fit in the link deposit"
        );
        env.note(format!(
            "  [{label}] {bytes} bytes = {} NEAR of the {} NEAR link deposit",
            near(cost),
            near(env.link_storage)
        ));
        link_rows.push(json!({"case": label, "outcome": expect, "bytes": bytes, "cost_near": near(cost), "left_over_near": near(env.link_storage - cost)}));
    }
    let worst_cost = u128::from(worst_bytes) * BYTE;
    let smallest_link = ceil_milli(worst_cost as i128);
    assert!(smallest_link <= env.link_storage);
    write_section(
        "smallest_link_deposit",
        json!({
            "note": "worst case: 64-byte contract and wallet accounts, 64-character gist ids. `link` attaches RUN + the link storage deposit; the deposit must pay for the largest record a link can leave: bytes x 10^19 yocto. Smallest = that cost rounded up to 0.001 NEAR.",
            "current_constant_near": near(env.link_storage),
            "cases": link_rows,
            "worst_bytes": worst_bytes, "worst_cost_near": near(worst_cost),
            "smallest_whole_milli_near": near(smallest_link),
            "margin_of_current_over_worst_near": near(env.link_storage - worst_cost),
        }),
    )?;
    write_section(
        "smallest_deposit",
        json!({
            "note": "worst case: 64-byte contract, maintainer and contributor accounts, 140-byte repository, 255-byte base branch, 64-character gist ids, the wallet's first link, new vaults; the contract's spare balance is exactly zero before posting; self-funded checks; the sponsor float untouched. The link record is paid for by the wallet's own 0.007 NEAR link deposit, so right after the link the deposit's surplus (0.007 less the record's storage) is taken out of the contract and the rest of the flow runs on the bounty's storage deposit alone. Each figure was found by running the flow with the deposit lowered by moving the difference out of the contract right after posting.",
            "current_constant_near": near(storage),
            "per_path": rows,
            "smallest_working_deposit_near": near(d_live),
            "smallest_never_borrowing_deposit_near": near(d_cons),
            "margin_of_current_over_working_near": near(storage - d_live),
            "margin_of_current_over_never_borrowing_near": near(storage - d_cons),
            "if_the_link_record_were_paid_from_this_deposit": {
                "note": "the earlier accounting: the whole 0.007 is taken out of the contract after the link, so the 618-byte record is paid from the bounty's deposit.",
                "per_path": old_rows,
                "smallest_never_borrowing_deposit_near": near(d_old),
                "margin_of_current_near": near(storage - d_old),
            },
        }),
    )?;
    let file = std::fs::read_to_string(format!("{RESULTS_DIR}/measured-costs.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or(json!({}));
    let fund = file["vault"]["rows"][1]["first_deposit"]["fund_kept_yocto"]
        .as_str()
        .and_then(|v| v.parse::<u128>().ok())
        .unwrap_or(4_510_000_000_000_000_000_000);
    write_section(
        "recommendation",
        json!({
            "constants_were_not_changed": true,
            "STORAGE_DEPOSIT": {
                "now_near": near(storage),
                "recommended_near": near(storage),
                "evidence": format!(
                    "With the link record paid for by the link deposit, the worst-case bounty needs {} NEAR for the settlement to send at all and {} NEAR to never use money that is not the contract's even while the fee is out; the current {} NEAR leaves {} NEAR over the second. If the link record were paid from this deposit instead, the never-borrowing figure would be {} NEAR and {} NEAR would leave {} NEAR over it.",
                    near(d_live), near(d_cons), near(storage), near(storage - d_cons), near(d_old), near(storage), near(storage - d_old)),
            },
            "LINK_STORAGE_DEPOSIT": {
                "now_near": near(env.link_storage),
                "recommended_near": near(env.link_storage),
                "evidence": format!(
                    "The largest record a link leaves is {} bytes = {} NEAR (first link, 64-byte accounts and gist ids); the smallest whole 0.001 NEAR covering it is {} NEAR. A pending relink and a refresh leave less (see the cases).",
                    worst_bytes, near(worst_cost), near(smallest_link)),
            },
            "DEPOSIT_FEE": {
                "now_near": near(fee),
                "recommended_near": near(fee),
                "evidence": format!(
                    "A first deposit into a new vault makes the vault keep its storage: {} NEAR with a 64-byte contract account ({} NEAR with the 16-byte test account); each byte of the contract account name adds 0.00001 NEAR. The fee must exceed that, so 0.006 leaves {} NEAR spare at the longest name and 0.005 would leave 0.00049. A later deposit into the same vault keeps 0.00139 at most. Keep 0.006 unless the owner prefers a thinner margin: every 0.001 NEAR less in the fee lowers the working deposit by as much, because the send waits for a spare balance equal to the fee.",
                    near(fund), "0.00403", near(fee - fund)),
            },
        }),
    )?;
    Ok(())
}
// ---- Measurement ----

fn compact(o: &Outcome) -> Value {
    let mut m = serde_json::Map::new();
    for s in &o.steps {
        m.insert(
            s["step"].as_str().unwrap().to_string(),
            json!({"bytes": s["delta_bytes"], "near": s["delta_near"], "yocto": s["delta_yocto"], "tgas": s["gas"]["tgas"], "contract_tgas": s["gas"]["contract_tgas"], "gas_near_at_sandbox_price": s["gas"]["near_at_sandbox_gas_price"]}),
        );
    }
    Value::Object(m)
}

/// Bytes and gas of one transaction: (bytes before, bytes after, burn).
async fn measured(
    env: &Env,
    name: &str,
    before: u64,
    r: &near_workspaces::result::ExecutionFinalResult,
    signer: &AccountId,
    price: u128,
) -> anyhow::Result<Value> {
    let after = storage(env, env.bounty.id()).await?;
    let burn = tx_burn(env, r, signer).await?;
    let delta = i128::from(after) - i128::from(before);
    env.note(format!(
        "  [{name}] {delta:+} bytes; {:.2} Tgas",
        burn.tgas()
    ));
    Ok(json!({
        "step": name, "delta_bytes": delta, "delta_near": format!("{:.5}", delta as f64 * BYTE as f64 / NEAR as f64),
        "gas": burn.json(price),
    }))
}

#[tokio::test]
async fn measure_every_cost_and_write_them_to_measured_costs_json() -> anyhow::Result<()> {
    // 1. Contract bytes per step, worst case and typical names, from the same runs that prove the deposit.
    let (mut worst_payout, mut worst_refund, mut worst_cancel) =
        (json!(null), json!(null), json!(null));
    for (path, issue) in [(Path::Payout, 50), (Path::Refund, 51), (Path::Cancel, 52)] {
        let env = worst_env(RELEASE_WASM).await?;
        let o = scenario(&env, path, issue, 0, false).await?;
        assert_fits(&o, &format!("{path:?}"));
        let v = json!({"steps": o.steps, "per_step": compact(&o), "lowest_slack_between_transactions_yocto": o.lowest_step.to_string(), "lowest_slack_with_fee_counted_out_yocto": o.lowest.to_string(), "vault_fund_after_first_deposit_yocto": o.vault_fund.to_string(), "fee_returned_yocto": o.returned.to_string()});
        match path {
            Path::Payout => worst_payout = v,
            Path::Refund => worst_refund = v,
            Path::Cancel => worst_cancel = v,
        }
    }
    let typical = {
        let env = typical_env(RELEASE_WASM).await?;
        let o = scenario(&env, Path::Payout, 53, 0, false).await?;
        assert_fits(&o, "typical payout");
        json!({"steps": o.steps, "per_step": compact(&o), "lowest_slack_between_transactions_yocto": o.lowest_step.to_string(), "lowest_slack_with_fee_counted_out_yocto": o.lowest.to_string(), "vault_fund_after_first_deposit_yocto": o.vault_fund.to_string()})
    };
    write_section(
        "state_bytes_and_gas_per_step",
        json!({
            "note": "bytes are the bounty contract account's storage_usage change over one transaction's whole receipt tree; yocto = bytes x 10^19. Gas is the tree's total (all contracts) and the part executed on the bounty contract; the OutLayer mock executes little, a real OutLayer run is not measured here.",
            "byte_price_yocto": BYTE.to_string(),
            "worst_case_payout": worst_payout, "worst_case_refund_after_late_merge": worst_refund, "worst_case_cancel": worst_cancel,
            "typical_payout": typical,
        }),
    )?;

    // 3. The vault: storage fund and the fee it keeps, first and later deposits (typical and
    // 64-byte contract account), and the other vault costs.
    let mut vault_rows = Vec::new();
    for (label, worst) in [
        ("typical (16-byte contract account)", false),
        ("worst case (64-byte contract account)", true),
    ] {
        let env = if worst {
            worst_env(RELEASE_WASM).await?
        } else {
            setup_with(RELEASE_WASM).await?
        };
        let cvault = vault_of(&env, &env.contrib_key).await?;
        let (id1, pull1) = {
            let id = post(&env, 60, Timing::RELEASE).await?;
            let pull = PullSpec::open(&env, GH);
            claim_and_bind(&env, &env.contrib, &env.contrib_key.clone(), GH, id, &pull).await?;
            (id, pull)
        };
        let id2 = post(&env, 61, Timing::RELEASE).await?;
        let pull2 = PullSpec::open(&env, GH).id(PR_ID + 1);
        claim_and_bind(
            &env,
            &env.contrib,
            &env.contrib_key.clone(),
            GH,
            id2,
            &pull2,
        )
        .await?;
        let paid1 = merged_check(&env, id1, &pull1, false).await?;
        let rows1 = trace(
            &env,
            "first deposit into a new vault",
            &paid1,
            env.stranger.id(),
        )
        .await?;
        let (fund1, bytes1) = (
            info(&env, &cvault).await?.fund,
            storage(&env, &cvault).await?,
        );
        let back1 = rows1
            .iter()
            .find(|(f, t, a, x)| {
                f == cvault.as_str()
                    && t == env.bounty.id().as_str()
                    && x.is_none()
                    && a.starts_with("Transfer")
            })
            .map(|r| r.2.clone());
        let paid2 = merged_check(&env, id2, &pull2, false).await?;
        let rows2 = trace(
            &env,
            "later deposit into the same vault",
            &paid2,
            env.stranger.id(),
        )
        .await?;
        let (fund2, bytes2) = (
            info(&env, &cvault).await?.fund,
            storage(&env, &cvault).await?,
        );
        let back2 = rows2
            .iter()
            .find(|(f, t, a, x)| {
                f == cvault.as_str()
                    && t == env.bounty.id().as_str()
                    && x.is_none()
                    && a.starts_with("Transfer")
            })
            .map(|r| r.2.clone());
        let kept2 = fund2 - fund1;
        assert!(sent(
            &rows1,
            cvault.as_str(),
            env.bounty.id().as_str(),
            env.fee - fund1
        ));
        assert!(sent(
            &rows2,
            cvault.as_str(),
            env.bounty.id().as_str(),
            env.fee - kept2
        ));
        assert_eq!(fund2, u128::from(bytes2) * BYTE);
        vault_rows.push(json!({
            "case": label, "fee_attached_per_deposit_yocto": env.fee.to_string(),
            "first_deposit": {"vault_bytes": bytes1, "fund_kept_yocto": fund1.to_string(), "fund_kept_near": near(fund1), "fee_returned_yocto": (env.fee - fund1).to_string(), "returned_receipt": back1},
            "later_deposit_same_key": {"bytes_added": bytes2 - bytes1, "fund_kept_yocto": kept2.to_string(), "fund_kept_near": near(kept2), "fee_returned_yocto": (env.fee - kept2).to_string(), "returned_receipt": back2},
            "fund_equals_storage_cost": true,
        }));
    }
    // 4. The remaining gas: withdraw (release), claim endings and reconcile (fault build).
    let (withdraw_row, ends) = {
        let env = setup_with(RELEASE_WASM).await?;
        let price = gas_price(&env).await?;
        let id = post(&env, 70, Timing::RELEASE).await?;
        let pull = PullSpec::open(&env, GH);
        claim_and_bind(&env, &env.contrib, &env.contrib_key.clone(), GH, id, &pull).await?;
        let _ = merged_check(&env, id, &pull, false).await?;
        let cvault = vault_of(&env, &env.contrib_key).await?;
        let w = withdraw(
            &env,
            &env.contrib_key.clone(),
            &cvault,
            env.payee.id(),
            REWARD,
        )
        .await?;
        assert!(w.is_success());
        let burn = tx_burn(&env, &w, env.relayer.id()).await?;
        let w_row =
            json!({"step": "withdraw (vault, NEP-413 check, transfer)", "gas": burn.json(price)});
        // Link refresh and a pending relink: unfunded growth of a wallet that links again.
        let b0 = storage(&env, env.bounty.id()).await?;
        let l = link(&env, &env.contrib, GH).await?;
        assert_eq!(answer(&l), "link_refreshed");
        let refresh = measured(
            &env,
            "link again with the same GitHub id (link_refreshed)",
            b0,
            &l,
            env.contrib.id(),
            price,
        )
        .await?;
        let b0 = storage(&env, env.bounty.id()).await?;
        let l = link(&env, &env.contrib, GH2).await?;
        assert_eq!(answer(&l), "link_pending");
        let pending = measured(
            &env,
            "relink to another GitHub id (link_pending)",
            b0,
            &l,
            env.contrib.id(),
            price,
        )
        .await?;
        let b0 = storage(&env, env.bounty.id()).await?;
        let l = link(&env, &env.rival, GH2).await?;
        let second_wallet = measured(
            &env,
            "first link of a second wallet",
            b0,
            &l,
            env.rival.id(),
            price,
        )
        .await?;
        let _ = second_wallet.clone();
        (w_row, vec![refresh, pending, second_wallet])
    };
    let mut ends = ends;
    let fault_rows = {
        let env = setup_with(FAULT_WASM).await?;
        let price = gas_price(&env).await?;
        link_ok(&env, &env.contrib, GH).await?;
        link_ok(&env, &env.rival, GH2).await?;
        let id_a = post(&env, 71, Timing::SHORT_CLAIM).await?;
        let id_b = post(&env, 72, Timing::SHORT_CLAIM).await?;
        let id_c = post(&env, 73, Timing::SHORT_CLAIM).await?;
        let mut rows = Vec::new();
        assert!(claim(&env, &env.contrib, id_a, &env.contrib_key.clone())
            .await?
            .is_success());
        let b0 = storage(&env, env.bounty.id()).await?;
        let r = call(
            &env.contrib,
            &env,
            "release_claim",
            json!({"bounty_id": id_a}),
            0,
        )
        .await?;
        assert!(r.is_success());
        rows.push(
            measured(
                &env,
                "release_claim (claim removed, wallet barred)",
                b0,
                &r,
                env.contrib.id(),
                price,
            )
            .await?,
        );
        assert!(claim(&env, &env.rival, id_b, &env.rival_key.clone())
            .await?
            .is_success());
        let b0 = storage(&env, env.bounty.id()).await?;
        let r = call(
            &env.maint,
            &env,
            "revoke_claim",
            json!({"bounty_id": id_b}),
            0,
        )
        .await?;
        assert!(r.is_success());
        rows.push(
            measured(
                &env,
                "revoke_claim (claim removed, wallet barred)",
                b0,
                &r,
                env.maint.id(),
                price,
            )
            .await?,
        );
        assert!(claim(&env, &env.contrib, id_c, &env.contrib_key.clone())
            .await?
            .is_success());
        let ends_at = get_bounty(&env, id_c).await?["claim"]["ends_at"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        wait_past(&env, ends_at).await?;
        let b0 = storage(&env, env.bounty.id()).await?;
        let r = call(
            &env.stranger,
            &env,
            "expire_claim",
            json!({"bounty_id": id_c}),
            0,
        )
        .await?;
        assert!(r.is_success());
        rows.push(
            measured(
                &env,
                "expire_claim (claim removed, wallet barred)",
                b0,
                &r,
                env.stranger.id(),
                price,
            )
            .await?,
        );
        // reconcile of a lost payout callback
        let (id, pull) = {
            let id = post(&env, 9_001, Timing::FAULT).await?;
            let pull = PullSpec::open(&env, GH);
            claim_and_bind(&env, &env.contrib, &env.contrib_key.clone(), GH, id, &pull).await?;
            (id, pull)
        };
        let _ = merged_check(&env, id, &pull, false).await?;
        let sent_at = sstate(&env, id, "Payout").await?.2;
        sleep_past_ns(&env, sent_at + 3_000_000_000).await?;
        let b0 = storage(&env, env.bounty.id()).await?;
        let r = reconcile(&env, &env.contrib, id, "Payout", 1).await?;
        assert_eq!(answer(&r), "deposited");
        rows.push(
            measured(
                &env,
                "reconcile (seal call, on_reconcile; fault build, same code path)",
                b0,
                &r,
                env.contrib.id(),
                price,
            )
            .await?,
        );
        rows
    };
    ends.extend(fault_rows);
    // 5 and 6. The OutLayer mock and the vault's publication.
    let env = setup_with(RELEASE_WASM).await?;
    let cost = env.publication_cost;
    let bytes = env.vault_bytes as u128;
    // A global contract costs 10 times the ordinary storage price per byte (NEP-591 rate), plus gas.
    let deposit_part = bytes * 10 * BYTE;
    let publication = json!({
        "vault_wasm_bytes": env.vault_bytes, "vault_code_sha256": hex(&env.code_hash),
        "global_contract_storage_yocto": deposit_part.to_string(), "global_contract_storage_near": near(deposit_part),
        "publisher_balance_drop_yocto": cost.to_string(), "publisher_balance_drop_near": near(cost),
        "gas_part_yocto": (cost - deposit_part).to_string(), "gas_part_near": near(cost - deposit_part),
        "how": "the publisher account's balance before and after deploy_global (sandbox, 300 Tgas attached); one-time, paid by the publisher. The storage part is 10 x 10^19 yocto per code byte (the global-contract rate), which matches `./build.sh`'s 'publication storage' line; the rest is gas.",
    });
    write_section(
        "vault",
        json!({"rows": vault_rows, "withdraw": withdraw_row}),
    )?;
    write_section("other_transactions", json!(ends))?;
    write_section(
        "outlayer",
        json!({
            "run_deposit_attached_per_run_near": near(RUN),
            "reconcile_deposit_near": near(RECONCILE),
            "note": "the mock OutLayer keeps a fixed 0.001 NEAR per run and returns the rest; that is NOT a real OutLayer charge. Only the 0.01 NEAR run deposit the contract attaches is a fact about the contract. Real OutLayer charges must be measured on testnet.",
            "mock_charge_yocto_not_a_real_cost": MOCK_CHARGE.to_string(),
        }),
    )?;
    write_section("vault_publication", publication)?;
    Ok(())
}
