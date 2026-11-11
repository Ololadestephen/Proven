//! Host unit tests on the mocked chain. Every verifier answer is produced by the bounty verifier's
//! own `render`, so the tests read the real wire format. Every key proof is a real ed25519
//! signature over the NEP-413 hash the contract itself verifies, over the text the contract's own
//! message functions produce. Times that depend on the build (`RELINK_DELAY_SECS`,
//! `REFUND_CAP_SECS`, `MIN_CLAIM_SECS`, the reconcile delays) are always taken from the constants.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, CurveType, PromiseResult, RuntimeFeesConfig};
use proven_pr_bounty_verifier as verifier;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use verifier::{Answer as VAnswer, GistFacts as VGist, Op, PullFacts as VPull, Reason, Request};

const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
const HASH: &str = "6df5a630107bef075bdd09203d64bbd26ec072e6edfd329b2f946a534c4e32fa";
const VAULT_CODE: [u8; 32] = [7; 32];
const REPO: &str = "proven-test/bounty-pilot";
const REPO_ID: u64 = 800_000_001;
const ISSUE: u64 = 3;
const GH: u64 = 900_000_001;
const OTHER_GH: u64 = 900_000_002;
const THIRD_GH: u64 = 900_000_003;
const PR: u64 = 12;
const PR_ID: u64 = 5_000_000_012;
const SEC: u64 = 1_000_000_000;
const START_S: u64 = 1_794_300_000;
const START: u64 = START_S * SEC;
const CLAIM_BY: u64 = START_S + 3_600;
const CLAIM_SECS: u64 = 7_200;
const DEADLINE: u64 = START_S + 86_400;
const GRACE: u64 = 3_600;
const REWARD: u128 = 1_000_000_000_000_000_000_000_000;
const NONCE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const POST_EXPIRES: u64 = START_S + 1_800;
const T_LINK: u64 = START + 100 * SEC;
const T_CLAIM: u64 = START + 600 * SEC;
const T_SUBMIT: u64 = START + 1_200 * SEC;
const T_CHECK: u64 = START + 2_000 * SEC;
/// The default claim at `T_CLAIM` ends here (Unix seconds).
const CLAIM_ENDS: u64 = START_S + 600 + CLAIM_SECS;
/// The checking window ends here (nanoseconds).
const VERIFY_UNTIL: u64 = (DEADLINE + GRACE) * SEC;

fn owner() -> AccountId {
    accounts(0)
}
fn buyer() -> AccountId {
    accounts(1)
}
fn wallet() -> AccountId {
    accounts(2)
}
fn stranger() -> AccountId {
    accounts(3)
}
fn sponsor() -> AccountId {
    accounts(4)
}
fn this() -> AccountId {
    accounts(5)
}
fn wallet2() -> AccountId {
    "wallet-two.testnet".parse().unwrap()
}
fn wallet3() -> AccountId {
    "wallet-three.testnet".parse().unwrap()
}
fn outlayer() -> AccountId {
    "outlayer.testnet".parse().unwrap()
}
fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}
fn storage() -> u128 {
    STORAGE_DEPOSIT.as_yoctonear()
}
fn run_deposit() -> u128 {
    RUN_DEPOSIT.as_yoctonear()
}
/// What `link` must be given: the run's compute plus the link record's storage.
const LINK_ATTACH: NearToken =
    NearToken::from_yoctonear(RUN_DEPOSIT.as_yoctonear() + LINK_STORAGE_DEPOSIT.as_yoctonear());
fn gist_n(n: u64) -> String {
    format!("{n:032x}")
}
fn hash_hex(n: u64) -> String {
    format!("{n:064x}")
}

// ---- Keys and proofs ----

fn sk(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn pk(key: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, key.verifying_key().to_bytes().to_vec()).unwrap()
}
fn maint_sk() -> SigningKey {
    sk(1)
}
/// The withdrawal key each contributor wallet uses; unrelated to any transaction key.
fn withdrawal_sk(who: &AccountId) -> SigningKey {
    if *who == wallet2() {
        sk(5)
    } else if *who == wallet3() {
        sk(6)
    } else {
        sk(3)
    }
}

/// A key proof: the ed25519 signature over the NEP-413 hash the contract verifies.
fn sign(key: &SigningKey, message: &str, contract: &str) -> Base64VecU8 {
    Base64VecU8(
        key.sign(&keys::key_proof_hash(message, contract))
            .to_bytes()
            .to_vec(),
    )
}

fn posting_message(
    t: &PostTerms,
    key: &PublicKey,
    actor: &AccountId,
    nonce: &str,
    expires: u64,
) -> String {
    keys::posting_message(
        "testnet",
        this().as_str(),
        actor.as_str(),
        &keys::parse_nonce(nonce),
        t,
        key,
        expires,
    )
}

/// A posting proof signed by `signer` for `key`, naming `actor`.
fn posting_proof(
    t: &PostTerms,
    signer: &SigningKey,
    key: &PublicKey,
    actor: &AccountId,
    nonce: &str,
    expires: u64,
) -> PostingProof {
    PostingProof {
        nonce: nonce.into(),
        expires_at: U64(expires),
        signature: sign(
            signer,
            &posting_message(t, key, actor, nonce, expires),
            this().as_str(),
        ),
    }
}

fn claim_message(
    id: BountyId,
    who: &AccountId,
    github_id: u64,
    key: &PublicKey,
    expires: u64,
) -> String {
    keys::claim_message(
        "testnet",
        this().as_str(),
        who.as_str(),
        id,
        github_id,
        key,
        expires,
    )
}

fn claim_proof(
    signer: &SigningKey,
    id: BountyId,
    who: &AccountId,
    github_id: u64,
    key: &PublicKey,
    expires: u64,
) -> ClaimProof {
    ClaimProof {
        expires_at: U64(expires),
        signature: sign(
            signer,
            &claim_message(id, who, github_id, key, expires),
            this().as_str(),
        ),
    }
}

// ---- Environment ----

fn context(who: AccountId, deposit: NearToken, at: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(this())
        .predecessor_account_id(who.clone())
        .signer_account_id(who)
        .attached_deposit(deposit)
        .block_timestamp(at)
        .account_balance(NearToken::from_near(20))
        .prepaid_gas(Gas::from_tgas(300));
    builder
}

fn act(who: AccountId, deposit: NearToken, at: u64) {
    testing_env!(context(who, deposit, at).build());
}

fn act_with_gas(who: AccountId, deposit: NearToken, at: u64, gas: Gas) {
    let mut builder = context(who, deposit, at);
    builder.prepaid_gas(gas);
    testing_env!(builder.build());
}

fn callback(at: u64, result: PromiseResult) {
    testing_env!(
        context(this(), zero(), at).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn contract() -> PrBounty {
    act(owner(), zero(), START);
    let mut c = PrBounty::new(
        owner(),
        outlayer(),
        "testnet".into(),
        URL.into(),
        HASH.into(),
        REPO.into(),
        U64(REPO_ID),
        Base58CryptoHash::from(VAULT_CODE),
        sponsor(),
        U128(2 * REWARD),
        U128(5 * REWARD),
        3,
        U128(NearToken::from_millinear(100).as_yoctonear()),
        U128(NearToken::from_millinear(200).as_yoctonear()),
    );
    c.add_poster(buyer());
    act(sponsor(), NearToken::from_millinear(50), START);
    c.fund_sponsor();
    c
}

/// Runs `case` on its own thread, so it gets its own mocked chain and storage.
fn isolated(case: impl FnOnce() + Send + 'static) {
    std::thread::spawn(case).join().expect("case passed");
}

fn panic_text(err: Box<dyn std::any::Any + Send>) -> String {
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

/// The panic message of a call that must be refused.
fn refusal<T>(c: &mut PrBounty, call: impl FnOnce(&mut PrBounty) -> T) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(c))) {
        Ok(_) => panic!("the call was accepted but must be refused"),
        Err(err) => panic_text(err),
    }
}

fn assert_refused<T>(c: &mut PrBounty, needle: &str, call: impl FnOnce(&mut PrBounty) -> T) {
    let msg = refusal(c, call);
    assert!(msg.contains(needle), "expected {needle:?}, got {msg:?}");
}

/// Everything a refused or ignored call must leave as it was.
fn snap(c: &PrBounty) -> String {
    format!("{} next_seq={}", snap_state(c), c.next_seq)
}

/// Like `snap` without the run counter. A host test does not roll back the state a refused call
/// wrote before it panicked, and `start_check` takes its sequence number before it refuses a
/// second live run; on the chain the whole transaction reverts. Use this where a refusal comes
/// from `start_check`.
fn snap_state(c: &PrBounty) -> String {
    let cfg = c.get_config();
    format!(
        "{:?}",
        (
            cfg.held.0,
            cfg.in_flight.0,
            cfg.sponsor_float.0,
            cfg.sponsor_spent.0,
            cfg.bounty_count,
            c.get_bounties(0, 50),
            [wallet(), wallet2(), wallet3()].map(|w| c.get_link(w.clone())),
            [GH, OTHER_GH, THIRD_GH].map(|g| c.github_owner_of(U64(g))),
            [wallet(), wallet2(), wallet3()].map(|w| c.link_numbers.get(&w).copied()),
            c.bound_pr(U64(PR_ID)),
            c.open_by_buyer.get(&buyer()).copied(),
        )
    )
}

/// What the contract holds must equal the sum of the principals not yet confirmed in a vault, and
/// what is in flight the sum of the attempts without a recorded result.
fn assert_accounting(c: &PrBounty) {
    let (mut owed, mut flying) = (0u128, 0u128);
    for (_, b) in c.get_bounties(0, 50) {
        let settlements: Vec<&Settlement> = b.payout.iter().chain(b.refund.iter()).collect();
        if settlements.is_empty()
            && matches!(
                b.status,
                Status::Open | Status::Claimed | Status::Bound | Status::Ineligible
            )
        {
            owed += b.reward.0;
        }
        for s in settlements {
            if s.state != SettlementState::Done {
                owed += s.principal.0;
            }
            if s.state == SettlementState::InFlight {
                flying += s.principal.0;
            }
        }
    }
    let cfg = c.get_config();
    assert_eq!(
        (cfg.held.0, cfg.in_flight.0),
        (owed, flying),
        "held and in_flight must equal the unsettled principals"
    );
}

// ---- Posting ----

fn terms() -> PostTerms {
    PostTerms {
        reward: U128(REWARD),
        repo: REPO.into(),
        repo_id: U64(REPO_ID),
        issue: ISSUE,
        base_ref: "main".into(),
        claim_by: U64(CLAIM_BY),
        claim_secs: U64(CLAIM_SECS),
        merge_deadline: U64(DEADLINE),
        grace_secs: U64(GRACE),
    }
}

fn deposit_for(t: &PostTerms) -> NearToken {
    NearToken::from_yoctonear(t.reward.0 + storage())
}

fn post_with(c: &mut PrBounty, t: PostTerms, nonce: &str) -> BountyId {
    let key = pk(&maint_sk());
    act(buyer(), deposit_for(&t), START);
    let proof = posting_proof(&t, &maint_sk(), &key, &buyer(), nonce, POST_EXPIRES);
    c.post_bounty(t, key, proof)
}

fn post(c: &mut PrBounty) -> BountyId {
    let nonce = hash_hex(c.get_config().bounty_count + 1);
    post_with(c, terms(), &nonce)
}

fn post_terms(c: &mut PrBounty, edit: impl FnOnce(&mut PostTerms)) -> BountyId {
    let mut t = terms();
    edit(&mut t);
    let nonce = hash_hex(c.get_config().bounty_count + 1);
    post_with(c, t, &nonce)
}

/// Everything one `post_bounty` call takes; edit a valid one to make each refusal.
#[derive(Clone)]
struct Posting {
    who: AccountId,
    terms: PostTerms,
    key: PublicKey,
    proof: PostingProof,
    deposit: u128,
}

impl Posting {
    fn valid() -> Self {
        let key = pk(&maint_sk());
        let t = terms();
        let proof = posting_proof(&t, &maint_sk(), &key, &buyer(), NONCE, POST_EXPIRES);
        Posting {
            who: buyer(),
            deposit: t.reward.0 + storage(),
            terms: t,
            key,
            proof,
        }
    }

    fn signed(&mut self, signer: &SigningKey, actor: &AccountId, expires: u64) {
        self.proof = posting_proof(&self.terms, signer, &self.key, actor, NONCE, expires);
    }

    fn call(self, c: &mut PrBounty, at: u64) -> BountyId {
        act(self.who, NearToken::from_yoctonear(self.deposit), at);
        c.post_bounty(self.terms, self.key, self.proof)
    }
}

/// What a refused posting must leave untouched.
fn posting_state(c: &PrBounty, nonce: &str) -> (String, bool) {
    (snap(c), nonce_used(c, nonce))
}

/// Whether the maintainer's nonce is consumed; a malformed nonce can never be.
fn nonce_used(c: &PrBounty, nonce: &str) -> bool {
    let well_formed = nonce.len() == 64
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    well_formed && c.is_nonce_used(buyer(), nonce.into())
}

/// Applies `edit` to a valid posting and expects exactly this refusal, with no state change.
fn assert_posting_refused(needle: &'static str, edit: impl FnOnce(&mut Posting) + Send + 'static) {
    isolated(move || {
        let mut c = contract();
        let mut posting = Posting::valid();
        edit(&mut posting);
        let nonce = posting.proof.nonce.clone();
        let before = posting_state(&c, &nonce);
        let (held, count) = (c.get_config().held.0, c.get_config().bounty_count);
        let msg = refusal(&mut c, |c| posting.call(c, START));
        assert!(msg.contains(needle), "expected {needle:?}, got {msg:?}");
        assert_eq!(posting_state(&c, &nonce), before, "state changed: {msg}");
        assert_eq!(
            (held, count, false),
            (
                c.get_config().held.0,
                c.get_config().bounty_count,
                nonce_used(&c, &nonce)
            ),
            "nothing may be locked, recorded or consumed"
        );
        assert_accounting(&c);
    });
}

// ---- Links ----

/// One link check in progress: what `link` sent and what its callback was given.
struct LinkStart {
    seq: u64,
    gist: String,
    challenge: String,
    args: Json,
}

fn callback_args(method: &str) -> Json {
    for receipt in get_created_receipts() {
        for action in &receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name, args, ..
            } = action
            {
                if method_name == method.as_bytes() {
                    return serde_json::from_slice(args).unwrap();
                }
            }
        }
    }
    panic!("no receipt calls {method}");
}

fn start_link(c: &mut PrBounty, who: &AccountId, gist: &str, at: u64) -> LinkStart {
    start_link_expiring(c, who, gist, at, at / SEC + 1_800)
}

fn start_link_expiring(
    c: &mut PrBounty,
    who: &AccountId,
    gist: &str,
    at: u64,
    expires: u64,
) -> LinkStart {
    let challenge = c.link_challenge(who.clone(), U64(expires));
    act(who.clone(), LINK_ATTACH, at);
    let _ = c.link(gist.into(), U64(expires));
    let args = callback_args("on_link");
    assert_eq!(args["pending"]["challenge"], challenge.as_str());
    LinkStart {
        seq: c.next_seq,
        gist: gist.into(),
        challenge,
        args,
    }
}

fn gist_request(s: &LinkStart) -> Request {
    Request {
        network: "testnet".into(),
        contract: this().to_string(),
        bounty: 0,
        seq: s.seq,
        repo: REPO.into(),
        op: Op::Gist {
            gist_id: s.gist.clone(),
            challenge: s.challenge.clone(),
        },
    }
}

fn run_context(request_id: u64) -> verifier::RunContext {
    verifier::RunContext::from_vars(Some(this().to_string()), Some(request_id.to_string()))
}

fn render_with(request: &Request, answer: Result<VAnswer, Reason>) -> PromiseResult {
    render_as(request, &run_context(15_100 + request.seq), answer)
}

fn render_as(
    request: &Request,
    context: &verifier::RunContext,
    answer: Result<VAnswer, Reason>,
) -> PromiseResult {
    PromiseResult::Successful(verifier::render(Some(request), context, answer).into_bytes())
}

fn gist_facts(owner_id: u64) -> VGist {
    VGist {
        owner_id,
        files: 1,
        challenge_matches: true,
    }
}

fn finish_link(
    c: &mut PrBounty,
    who: &AccountId,
    s: &LinkStart,
    at: u64,
    r: PromiseResult,
) -> String {
    callback(at, r);
    let pending = serde_json::from_value(s.args["pending"].clone()).unwrap();
    c.on_link(who.clone(), pending)
}

/// A whole link with a verifier answer that finds the wallet's challenge in `github`'s gist.
fn link_wallet(c: &mut PrBounty, who: &AccountId, gist: &str, github: u64, at: u64) -> String {
    let s = start_link(c, who, gist, at);
    let answer = render_with(&gist_request(&s), Ok(VAnswer::Gist(gist_facts(github))));
    finish_link(c, who, &s, at + 10 * SEC, answer)
}

fn linked() -> PrBounty {
    let mut c = contract();
    assert_eq!(
        link_wallet(&mut c, &wallet(), &gist_n(1), GH, T_LINK),
        "linked"
    );
    c
}

fn link_of(c: &PrBounty, who: &AccountId) -> WalletLink {
    c.get_link(who.clone()).unwrap_or_default()
}

fn active_github(c: &PrBounty, who: &AccountId) -> Option<u64> {
    link_of(c, who).active.map(|l| l.github_id.0)
}

// ---- Claims ----

fn claim_as(c: &mut PrBounty, id: BountyId, who: &AccountId, github_id: u64, at: u64) {
    let signer = withdrawal_sk(who);
    let key = pk(&signer);
    act(who.clone(), zero(), at);
    let proof = claim_proof(&signer, id, who, github_id, &key, at / SEC + 1_800);
    c.claim(id, key, proof);
}

fn claim_at(c: &mut PrBounty, id: BountyId, who: &AccountId, at: u64) {
    let github_id = active_github(c, who).expect("the wallet has an active link");
    claim_as(c, id, who, github_id, at);
}

fn claimed() -> (PrBounty, BountyId) {
    let mut c = linked();
    let id = post(&mut c);
    claim_at(&mut c, id, &wallet(), T_CLAIM);
    (c, id)
}

/// Two linked wallets and one bounty (claims accepted until its deadline) claimed by the first.
fn claimed_with_second_wallet() -> (PrBounty, BountyId) {
    let mut c = linked();
    assert_eq!(
        link_wallet(&mut c, &wallet2(), &gist_n(2), OTHER_GH, T_LINK),
        "linked"
    );
    let id = post_terms(&mut c, |t| t.claim_by = U64(DEADLINE));
    claim_at(&mut c, id, &wallet(), T_CLAIM);
    (c, id)
}

// ---- Submissions and merge checks ----

struct Submit {
    seq: u64,
    pr: u64,
    gist: String,
    challenge: String,
}

fn start_submit(c: &mut PrBounty, id: BountyId, who: &AccountId, pr: u64, at: u64) -> Submit {
    act(who.clone(), RUN_DEPOSIT, at);
    let _ = c.submit_pr(id, pr);
    let live = c.get_bounty(id).unwrap().live.expect("a live run");
    let link = link_of(c, who)
        .active
        .expect("the wallet has an active link");
    assert_eq!(live.gist_id.as_deref(), Some(link.gist_id.as_str()));
    Submit {
        seq: live.seq.0,
        pr,
        gist: link.gist_id,
        challenge: link.challenge,
    }
}

fn submit_request(id: BountyId, s: &Submit) -> Request {
    Request {
        network: "testnet".into(),
        contract: this().to_string(),
        bounty: id,
        seq: s.seq,
        repo: REPO.into(),
        op: Op::PullGist {
            number: s.pr,
            gist_id: s.gist.clone(),
            challenge: s.challenge.clone(),
        },
    }
}

fn pull(state: &str, merged_at: Option<u64>) -> VPull {
    VPull {
        repo_id: REPO_ID,
        pr_id: PR_ID,
        pr_number: PR,
        author_id: GH,
        base_ref: "main".into(),
        state: state.into(),
        merged: merged_at.is_some(),
        merged_at,
    }
}

fn open_pull() -> VPull {
    pull("open", None)
}

fn on_check_with(c: &mut PrBounty, id: BountyId, seq: u64, at: u64, r: PromiseResult) -> String {
    callback(at, r);
    c.on_check(id, U64(seq))
}

fn submit_with(
    c: &mut PrBounty,
    id: BountyId,
    who: &AccountId,
    facts: VPull,
    gist: VGist,
    at: u64,
) -> String {
    let s = start_submit(c, id, who, PR, at);
    let answer = render_with(&submit_request(id, &s), Ok(VAnswer::PullGist(facts, gist)));
    on_check_with(c, id, s.seq, at + 10 * SEC, answer)
}

fn submit_ok(c: &mut PrBounty, id: BountyId, who: &AccountId, at: u64) -> String {
    submit_with(c, id, who, open_pull(), gist_facts(GH), at)
}

fn bound() -> (PrBounty, BountyId) {
    let (mut c, id) = claimed();
    assert_eq!(submit_ok(&mut c, id, &wallet(), T_SUBMIT), "bound");
    (c, id)
}

fn merge_request(id: BountyId, seq: u64, number: u64) -> Request {
    Request {
        network: "testnet".into(),
        contract: this().to_string(),
        bounty: id,
        seq,
        repo: REPO.into(),
        op: Op::Pull { number },
    }
}

/// Starts a merge check and returns its sequence number.
fn start_check(
    c: &mut PrBounty,
    id: BountyId,
    who: &AccountId,
    deposit: NearToken,
    at: u64,
) -> u64 {
    act(who.clone(), deposit, at);
    let _ = c.check_merge(id);
    c.get_bounty(id).unwrap().live.expect("a live run").seq.0
}

fn check_with(
    c: &mut PrBounty,
    id: BountyId,
    who: &AccountId,
    deposit: NearToken,
    at: u64,
    answer: Result<VAnswer, Reason>,
) -> String {
    let seq = start_check(c, id, who, deposit, at);
    let number = c.get_bounty(id).unwrap().binding.unwrap().pr_number;
    let result = render_with(&merge_request(id, seq, number), answer);
    on_check_with(c, id, seq, at + 10 * SEC, result)
}

/// A paid look by a stranger at `at`: the pull request as GitHub reports it.
fn look(c: &mut PrBounty, id: BountyId, at: u64, facts: VPull) -> String {
    check_with(
        c,
        id,
        &stranger(),
        RUN_DEPOSIT,
        at,
        Ok(VAnswer::Pull(facts)),
    )
}

fn paid() -> (PrBounty, BountyId) {
    let (mut c, id) = bound();
    let outcome = look(&mut c, id, T_CHECK, pull("closed", Some(DEADLINE - 1)));
    assert_eq!(outcome, "paid");
    (c, id)
}

fn outlayer_call() -> (Json, NearToken) {
    let call = get_created_receipts()
        .into_iter()
        .find(|r| r.receiver_id == outlayer())
        .expect("a call to OutLayer");
    call.actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } if method_name == b"request_execution" => {
                Some((serde_json::from_slice(args).unwrap(), *attached_deposit))
            }
            _ => None,
        })
        .expect("request_execution")
}

/// The verifier input the contract sent to OutLayer, read by the verifier's own parser.
fn verifier_request() -> Request {
    let (args, _) = outlayer_call();
    let input = args["input_data"].as_str().expect("input_data");
    verifier::parse_request(input.as_bytes()).expect("the verifier accepts the contract's input")
}

// ---- Settlement ----

/// The deposit calls in the created receipts: (vault, attached, borsh args).
fn deposits() -> Vec<(String, u128, Vec<u8>)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } if method_name == b"deposit" => {
                    Some((to.clone(), attached_deposit.as_yoctonear(), args))
                }
                _ => None,
            })
        })
        .collect()
}

fn transfers_to_accounts() -> usize {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter(|a| matches!(a, MockAction::Transfer { .. }))
        .count()
}

fn payout_of(c: &PrBounty, id: BountyId) -> Settlement {
    c.get_settlement(id, SettlementKind::Payout).unwrap()
}

fn refund_of(c: &PrBounty, id: BountyId) -> Settlement {
    c.get_settlement(id, SettlementKind::Refund).unwrap()
}

/// A paid bounty whose payout was sent once (attempt 1, in flight) at the returned time.
fn payout_in_flight() -> (PrBounty, BountyId, u64) {
    let (mut c, id) = paid();
    let sent_at = T_CHECK + 20 * SEC;
    act(this(), zero(), sent_at);
    assert_eq!(c.send_due_after_check(id), 1);
    (c, id, sent_at)
}

/// A cancelled bounty whose refund was sent once (attempt 1, in flight) at the returned time.
fn refund_in_flight() -> (PrBounty, BountyId, u64) {
    let mut c = contract();
    let id = post(&mut c);
    let sent_at = START + SEC;
    act(buyer(), zero(), sent_at);
    c.cancel(id);
    (c, id, sent_at)
}

fn try_reconcile(
    c: &mut PrBounty,
    id: BountyId,
    kind: SettlementKind,
    who: AccountId,
    at: u64,
    attempt: u32,
) -> Result<(), String> {
    act(who, RECONCILE_DEPOSIT, at);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.reconcile(id, kind, attempt)
    }))
    .map_err(panic_text)
}

/// The vault's 25-byte answer to a seal: deposited flag, deposit attempt, amount, sealed through.
fn slot(deposited: bool, attempt: u32, amount: u128, sealed: u32) -> PromiseResult {
    let mut out = vec![u8::from(deposited)];
    out.extend(attempt.to_le_bytes());
    out.extend(amount.to_le_bytes());
    out.extend(sealed.to_le_bytes());
    PromiseResult::Successful(out)
}

fn settle_at(c: &mut PrBounty, id: BountyId, at: u64) {
    act(stranger(), zero(), at);
    c.settle(id);
}

fn assert_cannot_settle(c: &mut PrBounty, id: BountyId, at: u64) {
    let before = snap(c);
    act(stranger(), zero(), at);
    assert_refused(c, "cannot be refunded yet", |c| c.settle(id));
    assert_eq!(snap(c), before);
}

// ---- 1. The withdrawal-key proof at post ----

#[test]
fn a_valid_posting_proof_is_accepted_and_locks_exactly_the_reward_plus_the_storage_deposit() {
    let mut c = contract();
    let key = pk(&maint_sk());
    let id = Posting::valid().call(&mut c, START);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(id, 0);
    assert_eq!(b.status, Status::Open);
    assert_eq!((b.buyer.clone(), b.reward.0), (buyer(), REWARD));
    assert_eq!(b.maintainer_key, key);
    assert_eq!(b.maintainer_vault, keys::vault_of(VAULT_CODE, &key));
    assert_eq!(b.maintainer_vault, c.vault_of(key.clone()));
    assert!(b.maintainer_vault.as_str().starts_with("0s"));
    assert_eq!(b.posting_nonce, NONCE);
    assert_eq!(b.posted_at.0, START);
    assert_eq!(
        (b.claim, b.binding, b.payout, b.refund),
        (None, None, None, None)
    );
    let cfg = c.get_config();
    assert_eq!(cfg.held.0, REWARD, "the reward is reserved");
    assert_eq!(cfg.in_flight.0, 0);
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(1));
    assert!(c.is_nonce_used(buyer(), NONCE.into()));
    assert!(
        !c.is_nonce_used(stranger(), NONCE.into()),
        "nonces are per maintainer"
    );
    assert_accounting(&c);
}

#[test]
fn the_posting_deposit_is_exactly_the_reward_plus_the_storage_deposit_and_nothing_else() {
    for deposit in [
        REWARD,
        REWARD + storage() - 1,
        REWARD + storage() + 1,
        REWARD + storage() + 30 * 10u128.pow(21),
        REWARD + storage() + run_deposit(),
        0,
    ] {
        assert_posting_refused(
            "attach exactly the reward plus the storage deposit",
            move |p| {
                p.deposit = deposit;
            },
        );
    }
}

#[test]
fn a_proof_signed_by_a_different_key_is_refused_before_any_state_change() {
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        let actor = p.who.clone();
        p.signed(&sk(9), &actor, POST_EXPIRES);
        assert_ne!(p.key, pk(&sk(9)));
    });
}

#[test]
fn a_proof_for_a_different_withdrawal_key_than_the_one_given_is_refused() {
    // The proof is a valid signature by sk(9) for sk(9)'s message, but the call names sk(1)'s key.
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        let other = pk(&sk(9));
        let mut copy = p.clone();
        copy.key = other;
        let actor = p.who.clone();
        copy.signed(&sk(9), &actor, POST_EXPIRES);
        p.proof = copy.proof;
    });
}

#[test]
fn a_proof_signed_over_different_terms_is_refused_before_any_state_change() {
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        p.terms.issue = ISSUE + 1;
    });
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        p.terms.claim_secs = U64(CLAIM_SECS + 1);
    });
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        p.terms.base_ref = "dev".into();
    });
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        // A lower reward, paid for exactly, still is not what the key signed.
        p.terms.reward = U128(REWARD / 2);
        p.deposit = REWARD / 2 + storage();
    });
}

#[test]
fn a_proof_naming_a_different_maintainer_is_refused_before_any_state_change() {
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        p.signed(&maint_sk(), &stranger(), POST_EXPIRES);
    });
    // The same valid proof replayed by another approved maintainer.
    isolated(|| {
        let mut c = contract();
        act(owner(), zero(), START);
        c.add_poster(stranger());
        let before = snap(&c);
        let mut posting = Posting::valid();
        posting.who = stranger();
        assert_refused(&mut c, "the withdrawal key's proof does not match", |c| {
            posting.call(c, START)
        });
        assert_eq!(snap(&c), before);
        assert!(!c.is_nonce_used(stranger(), NONCE.into()));
    });
}

#[test]
fn a_proof_signed_for_another_contract_or_network_is_refused() {
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        let message = keys::posting_message(
            "testnet",
            "other.testnet",
            p.who.as_str(),
            &keys::parse_nonce(NONCE),
            &p.terms,
            &p.key,
            POST_EXPIRES,
        );
        p.proof.signature = sign(&maint_sk(), &message, "other.testnet");
    });
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        let message = keys::posting_message(
            "mainnet",
            this().as_str(),
            p.who.as_str(),
            &keys::parse_nonce(NONCE),
            &p.terms,
            &p.key,
            POST_EXPIRES,
        );
        p.proof.signature = sign(&maint_sk(), &message, this().as_str());
    });
    // Signed over the right text but for another NEP-413 recipient.
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        let message = posting_message(&p.terms, &p.key, &p.who, NONCE, POST_EXPIRES);
        p.proof.signature = sign(&maint_sk(), &message, "other.testnet");
    });
}

#[test]
fn an_expired_posting_proof_is_refused_before_any_state_change() {
    for expires in [START_S, START_S - 1, 0] {
        assert_posting_refused("expires_at must be in the future", move |p| {
            let actor = p.who.clone();
            p.signed(&maint_sk(), &actor, expires);
        });
    }
}

#[test]
fn a_posting_proof_that_expires_more_than_one_hour_ahead_is_refused() {
    for expires in [START_S + 3_601, START_S + 86_400] {
        assert_posting_refused("at most one hour ahead", move |p| {
            let actor = p.who.clone();
            p.signed(&maint_sk(), &actor, expires);
        });
    }
}

#[test]
fn a_posting_proof_that_expires_exactly_one_hour_ahead_is_accepted() {
    let mut c = contract();
    let mut posting = Posting::valid();
    let actor = posting.who.clone();
    posting.signed(&maint_sk(), &actor, START_S + 3_600);
    posting.call(&mut c, START);
    assert_eq!(c.get_config().held.0, REWARD);
}

#[test]
fn a_reused_posting_nonce_is_refused_and_the_first_bounty_stays_as_it_was() {
    let mut c = contract();
    post_with(&mut c, terms(), NONCE);
    let before = snap(&c);
    let mut t = terms();
    t.issue = ISSUE + 1;
    let key = pk(&maint_sk());
    let proof = posting_proof(&t, &maint_sk(), &key, &buyer(), NONCE, POST_EXPIRES);
    act(buyer(), deposit_for(&t), START);
    assert_refused(&mut c, "this posting nonce has already been used", |c| {
        c.post_bounty(t, key, proof)
    });
    assert_eq!(snap(&c), before);
    assert_eq!(c.get_config().bounty_count, 1);
    assert_accounting(&c);
}

#[test]
fn a_key_that_is_not_ed25519_is_refused_before_any_state_change() {
    assert_posting_refused("keys must be ed25519 public keys", |p| {
        p.key = PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap();
    });
}

#[test]
fn malformed_proof_parts_are_refused_before_any_state_change() {
    assert_posting_refused("signatures must be 64 bytes", |p| {
        p.proof.signature.0.pop();
    });
    assert_posting_refused("signatures must be 64 bytes", |p| {
        p.proof.signature.0.push(0);
    });
    assert_posting_refused("nonce must be 64 lowercase hex characters", |p| {
        p.proof.nonce = "A".repeat(64);
    });
    assert_posting_refused("nonce must be 64 lowercase hex characters", |p| {
        p.proof.nonce = "1".repeat(63);
    });
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        p.proof.nonce = "2".repeat(64);
    });
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        p.proof.expires_at = U64(POST_EXPIRES + 1);
    });
    assert_posting_refused("the withdrawal key's proof does not match", |p| {
        p.proof.signature = Base64VecU8(vec![0; 64]);
    });
}

#[test]
fn a_wallet_whose_transaction_key_differs_from_the_withdrawal_key_still_posts() {
    let mut c = contract();
    let withdrawal = pk(&maint_sk());
    let tx_key = pk(&sk(9));
    assert_ne!(withdrawal, tx_key);
    let mut builder = context(buyer(), deposit_for(&terms()), START);
    builder.signer_account_pk(tx_key.clone());
    testing_env!(builder.build());
    let proof = posting_proof(
        &terms(),
        &maint_sk(),
        &withdrawal,
        &buyer(),
        NONCE,
        POST_EXPIRES,
    );
    let id = c.post_bounty(terms(), withdrawal.clone(), proof);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.maintainer_key, withdrawal);
    assert_eq!(b.maintainer_vault, keys::vault_of(VAULT_CODE, &withdrawal));
    assert_ne!(b.maintainer_vault, keys::vault_of(VAULT_CODE, &tx_key));
    assert_eq!(c.get_config().held.0, REWARD);
}

#[test]
fn a_proof_signed_by_the_transaction_key_instead_of_the_named_withdrawal_key_is_refused() {
    isolated(|| {
        let mut c = contract();
        let withdrawal = pk(&maint_sk());
        let tx = sk(9);
        let mut builder = context(buyer(), deposit_for(&terms()), START);
        builder.signer_account_pk(pk(&tx));
        testing_env!(builder.build());
        let before = snap(&c);
        let proof = posting_proof(&terms(), &tx, &withdrawal, &buyer(), NONCE, POST_EXPIRES);
        assert_refused(&mut c, "the withdrawal key's proof does not match", |c| {
            c.post_bounty(terms(), withdrawal, proof)
        });
        assert_eq!(snap(&c), before);
    });
}

#[test]
fn the_posting_views_return_the_exact_text_and_digest_the_contract_verifies() {
    let c = contract();
    let key = pk(&maint_sk());
    act(buyer(), zero(), START);
    let message = c.posting_key_message(
        terms(),
        key.clone(),
        buyer(),
        NONCE.into(),
        U64(POST_EXPIRES),
    );
    assert_eq!(
        message,
        posting_message(&terms(), &key, &buyer(), NONCE, POST_EXPIRES)
    );
    let digest = c.posting_terms_digest(terms(), key.clone(), buyer(), NONCE.into());
    assert_eq!(digest.len(), 64);
    assert!(message.contains(&format!("terms: {digest}")));
    let lines: Vec<&str> = message.lines().collect();
    assert_eq!(lines[0], "Proven PR bounty withdrawal-key proof v2");
    assert_eq!(lines[1], "role: maintainer (refund)");
    assert!(lines.contains(&"network: testnet"));
    assert!(lines.contains(&format!("contract: {}", this()).as_str()));
    assert!(lines.contains(&format!("actor: {}", buyer()).as_str()));
    assert!(lines.contains(&format!("withdrawal_key: {}", String::from(&key)).as_str()));
    assert!(lines.contains(&format!("reward_yocto: {REWARD}").as_str()));
    assert!(lines.contains(&format!("issue: {REPO}#{ISSUE}").as_str()));
    let claim = c.claim_key_message(7, wallet(), U64(GH), key.clone(), U64(POST_EXPIRES));
    assert_eq!(claim, claim_message(7, &wallet(), GH, &key, POST_EXPIRES));
    assert!(
        claim.starts_with("Proven PR bounty withdrawal-key proof v2\nrole: contributor (payout)")
    );
}

#[test]
fn the_key_proof_hash_is_the_nep413_hash_built_independently() {
    let _c = contract();
    let message = "any message";
    let nonce: [u8; 32] = Sha256::digest(message.as_bytes()).into();
    let mut payload = 2_147_484_061u32.to_le_bytes().to_vec();
    payload.extend((message.len() as u32).to_le_bytes());
    payload.extend(message.as_bytes());
    payload.extend(nonce);
    payload.extend((this().as_str().len() as u32).to_le_bytes());
    payload.extend(this().as_str().as_bytes());
    payload.push(0);
    let expected: [u8; 32] = Sha256::digest(&payload).into();
    assert_eq!(keys::key_proof_hash(message, this().as_str()), expected);
}

// ---- 2. Linking a GitHub account ----

#[test]
fn the_first_link_is_immediate_and_pins_the_gist_and_challenge() {
    let mut c = contract();
    let number_before = c.link_numbers.get(&wallet()).copied().unwrap_or(0);
    let challenge_before = c.link_challenge(wallet(), U64(T_LINK / SEC + 1_800));
    let s = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
    assert_eq!(s.challenge, challenge_before);
    assert!(s.challenge.starts_with(verifier::CHALLENGE_PREFIX));
    // The request the contract sent is one the verifier's own parser reads.
    let asked = verifier_request();
    assert_eq!(asked, gist_request(&s));
    let (_, deposit) = outlayer_call();
    assert_eq!(deposit, RUN_DEPOSIT);
    let answer = render_with(&gist_request(&s), Ok(VAnswer::Gist(gist_facts(GH))));
    let outcome = finish_link(&mut c, &wallet(), &s, T_LINK + 10 * SEC, answer);
    assert_eq!(outcome, "linked");
    let link = link_of(&c, &wallet());
    let active = link.active.expect("active");
    assert_eq!(link.pending, None);
    assert_eq!(active.github_id.0, GH);
    assert_eq!(active.gist_id, gist_n(1));
    assert_eq!(active.challenge, s.challenge);
    assert_eq!(active.linked_at.0, T_LINK + 10 * SEC);
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet()));
    assert_eq!(
        c.link_numbers.get(&wallet()).copied(),
        Some(number_before + 1)
    );
    assert!(c.used_gists.contains(&gist_n(1)));
    assert!(c.link_runs.get(&wallet()).is_none(), "the run is finished");
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("link_resolved") && l.contains("outcome=linked")));
}

#[test]
fn each_completed_link_increments_the_link_number_and_changes_the_next_challenge() {
    let mut c = linked();
    let expires = U64(T_LINK / SEC + 1_800);
    let first = link_of(&c, &wallet()).active.unwrap().challenge;
    let next = c.link_challenge(wallet(), expires);
    assert_ne!(first, next);
    assert_eq!(c.link_numbers.get(&wallet()).copied(), Some(1));
    // A same-id relink increments again.
    assert_eq!(
        link_wallet(&mut c, &wallet(), &gist_n(2), GH, T_LINK + 100 * SEC),
        "link_refreshed"
    );
    assert_eq!(c.link_numbers.get(&wallet()).copied(), Some(2));
    assert_ne!(c.link_challenge(wallet(), expires), next);
    // Another wallet's numbering is independent.
    assert_eq!(c.link_numbers.get(&wallet2()).copied(), None);
}

#[test]
fn the_link_challenge_names_the_wallet_the_expiry_and_the_contract() {
    let c = contract();
    let e = U64(T_LINK / SEC + 1_800);
    let one = c.link_challenge(wallet(), e);
    assert_eq!(
        one,
        keys::link_challenge("testnet", this().as_str(), wallet().as_str(), 0, e.0)
    );
    assert_ne!(one, c.link_challenge(wallet2(), e));
    assert_ne!(one, c.link_challenge(wallet(), U64(e.0 + 1)));
    assert_eq!(one.len(), verifier::CHALLENGE_PREFIX.len() + 64);
}

/// One link check whose verifier answer or callback timing is wrong, and what it must leave.
fn assert_link_outcome_changes_nothing(
    expected: &'static str,
    answer: impl FnOnce(&LinkStart) -> PromiseResult + Send + 'static,
    callback_delay_secs: u64,
    expires_in_secs: u64,
) {
    isolated(move || {
        let mut c = contract();
        let at = T_LINK;
        let expires = at / SEC + expires_in_secs;
        let s = start_link_expiring(&mut c, &wallet(), &gist_n(1), at, expires);
        let before = snap(&c);
        let result = answer(&s);
        let delay = callback_delay_secs * SEC;
        let outcome = finish_link(&mut c, &wallet(), &s, at + delay, result);
        assert_eq!(outcome, expected);
        assert_eq!(snap(&c), before, "{expected} must change nothing");
        assert_eq!(c.get_link(wallet()), None);
        assert!(!c.used_gists.contains(&gist_n(1)), "the gist stays unused");
        assert!(c.link_runs.get(&wallet()).is_none());
        let logs = get_logs();
        assert!(
            logs.iter().any(|l| l.contains("link_resolved")
                && l.contains(&format!("outcome={expected}"))
                && l.contains(&format!("seq={}", s.seq))),
            "the outcome is recorded: {logs:?}"
        );
    });
}

#[test]
fn a_link_gist_holding_another_wallets_challenge_is_a_challenge_mismatch() {
    assert_link_outcome_changes_nothing(
        "mismatch:challenge",
        |s| {
            let facts = VGist {
                owner_id: GH,
                files: 1,
                challenge_matches: false,
            };
            render_with(&gist_request(s), Ok(VAnswer::Gist(facts)))
        },
        10,
        1_800,
    );
}

#[test]
fn a_link_gist_that_is_not_the_only_file_or_has_two_files_is_ambiguous() {
    for files in [0u32, 2, 3] {
        for matches in [false, true] {
            assert_link_outcome_changes_nothing(
                "mismatch:ambiguous",
                move |s| {
                    let facts = VGist {
                        owner_id: GH,
                        files,
                        challenge_matches: matches,
                    };
                    render_with(&gist_request(s), Ok(VAnswer::Gist(facts)))
                },
                10,
                1_800,
            );
        }
    }
}

#[test]
fn a_gist_that_was_linked_in_the_meantime_is_a_replay_at_callback_time() {
    isolated(|| {
        let mut c = contract();
        let first = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
        let second = start_link(&mut c, &wallet2(), &gist_n(1), T_LINK);
        let answer = |s: &LinkStart, owner| {
            render_with(&gist_request(s), Ok(VAnswer::Gist(gist_facts(owner))))
        };
        let a = answer(&first, GH);
        let done = finish_link(&mut c, &wallet(), &first, T_LINK + 5 * SEC, a);
        assert_eq!(done, "linked");
        let before = snap(&c);
        let b = answer(&second, OTHER_GH);
        let outcome = finish_link(&mut c, &wallet2(), &second, T_LINK + 6 * SEC, b);
        assert_eq!(outcome, "mismatch:gist_used");
        assert_eq!(snap(&c), before);
        assert_eq!(c.get_link(wallet2()), None);
        assert_eq!(c.github_owner_of(U64(OTHER_GH)), None);
    });
}

#[test]
fn a_gist_that_was_already_used_for_a_link_is_refused_when_the_link_starts() {
    let mut c = linked();
    let before = snap(&c);
    for who in [wallet(), wallet2()] {
        act(who, LINK_ATTACH, T_LINK + 50 * SEC);
        assert_refused(&mut c, "this gist has already been used for a link", |c| {
            c.link(gist_n(1), U64(T_LINK / SEC + 1_800))
        });
    }
    assert_eq!(snap(&c), before);
}

#[test]
fn an_expired_link_challenge_is_recorded_and_changes_nothing() {
    // Expires 60 s ahead; the verifier's answer lands 61 s later, inside the run timeout.
    assert_link_outcome_changes_nothing(
        "no_result:expired",
        |s| render_with(&gist_request(s), Ok(VAnswer::Gist(gist_facts(GH)))),
        61,
        60,
    );
}

#[test]
fn a_stale_link_result_is_recorded_and_changes_nothing() {
    isolated(|| {
        let mut c = contract();
        let s = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
        let before = snap(&c);
        let answer = render_with(&gist_request(&s), Ok(VAnswer::Gist(gist_facts(GH))));
        let late = T_LINK + RUN_TIMEOUT_NANOS + 1;
        let outcome = finish_link(&mut c, &wallet(), &s, late, answer);
        assert_eq!(outcome, "no_result:stale");
        assert_eq!(snap(&c), before);
        assert_eq!(c.get_link(wallet()), None);
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("outcome=no_result:stale")));
    });
}

#[test]
fn a_link_answer_bound_to_another_bounty_seq_gist_or_contract_is_wrong_binding() {
    let mutations: Vec<fn(&mut Request)> = vec![
        |r| r.bounty = 1,
        |r| r.seq += 1,
        |r| {
            let challenge = match &r.op {
                Op::Gist { challenge, .. } => challenge.clone(),
                _ => unreachable!(),
            };
            r.op = Op::Gist {
                gist_id: gist_n(9),
                challenge,
            };
        },
        |r| r.contract = "other.testnet".into(),
        |r| r.network = "mainnet".into(),
        |r| r.repo = "proven-test/other".into(),
    ];
    for mutate in mutations {
        assert_link_outcome_changes_nothing(
            "no_result:wrong_binding",
            move |s| {
                let mut request = gist_request(s);
                mutate(&mut request);
                render_as(
                    &request,
                    &run_context(15_100 + s.seq),
                    Ok(VAnswer::Gist(gist_facts(GH))),
                )
            },
            10,
            1_800,
        );
    }
    // An answer from a different caller of the verifier.
    assert_link_outcome_changes_nothing(
        "no_result:wrong_binding",
        |s| {
            let other =
                verifier::RunContext::from_vars(Some("other.testnet".into()), Some("5".into()));
            render_as(&gist_request(s), &other, Ok(VAnswer::Gist(gist_facts(GH))))
        },
        10,
        1_800,
    );
    // An answer to a pull request request.
    assert_link_outcome_changes_nothing(
        "no_result:wrong_binding",
        |s| {
            let mut request = gist_request(s);
            request.op = Op::Pull { number: PR };
            render_as(&request, &run_context(1), Ok(VAnswer::Pull(open_pull())))
        },
        10,
        1_800,
    );
}

const ALL_REASONS: [Reason; 12] = [
    Reason::BadRequest,
    Reason::Timeout,
    Reason::Unreachable,
    Reason::RateLimited,
    Reason::Forbidden,
    Reason::NotFound,
    Reason::Redirect,
    Reason::UpstreamUnavailable,
    Reason::UpstreamStatus,
    Reason::Oversized,
    Reason::Malformed,
    Reason::Incomplete,
];

fn no_result_text(reason: Reason) -> &'static str {
    Box::leak(format!("no_result:{}", reason.code()).into_boxed_str())
}

#[test]
fn every_verifier_no_result_reason_is_recorded_for_a_link_and_changes_nothing() {
    for reason in ALL_REASONS {
        assert_link_outcome_changes_nothing(
            no_result_text(reason),
            move |s| render_with(&gist_request(s), Err(reason)),
            10,
            1_800,
        );
    }
}

fn tampered(result: PromiseResult, from: &str, to: &str) -> PromiseResult {
    match result {
        PromiseResult::Successful(bytes) => {
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.contains(from), "{text} lacks {from}");
            PromiseResult::Successful(text.replace(from, to).into_bytes())
        }
        other => other,
    }
}

#[test]
fn a_failed_null_malformed_or_oversized_link_answer_changes_nothing() {
    let cases: Vec<(&'static str, fn(&LinkStart) -> PromiseResult)> = vec![
        ("no_result:promise_failed", |_| PromiseResult::Failed),
        ("no_result:no_output", |_| {
            PromiseResult::Successful(b"null".to_vec())
        }),
        ("no_result:malformed", |_| {
            PromiseResult::Successful(b"{not json".to_vec())
        }),
        ("no_result:malformed", |s| {
            let ok = render_with(&gist_request(s), Ok(VAnswer::Gist(gist_facts(GH))));
            tampered(ok, "\"v\":4", "\"v\":3")
        }),
        ("no_result:malformed", |s| {
            // A reason code this contract does not know.
            let no = render_with(&gist_request(s), Err(Reason::Timeout));
            tampered(no, "timeout", "made_up")
        }),
        ("no_result:oversized", |_| {
            PromiseResult::Successful(vec![b' '; answer::MAX_OUTPUT_BYTES + 1])
        }),
    ];
    for (expected, make) in cases {
        assert_link_outcome_changes_nothing(expected, make, 10, 1_800);
    }
}

#[test]
fn a_late_result_for_a_replaced_or_finished_link_run_is_ignored() {
    isolated(|| {
        let mut c = contract();
        let first = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
        // After the first run's timeout a second may start, and it replaces the first.
        let later = T_LINK + RUN_TIMEOUT_NANOS + SEC;
        let second = start_link(&mut c, &wallet(), &gist_n(2), later);
        assert_ne!(first.seq, second.seq);
        let before = snap(&c);
        let answer = render_with(&gist_request(&first), Ok(VAnswer::Gist(gist_facts(GH))));
        let outcome = finish_link(&mut c, &wallet(), &first, later + SEC, answer);
        assert_eq!(outcome, "ignored:not_live");
        assert_eq!(snap(&c), before);
        // The live one still counts, and afterwards the finished one is ignored.
        let answer = render_with(&gist_request(&second), Ok(VAnswer::Gist(gist_facts(GH))));
        let done = finish_link(&mut c, &wallet(), &second, later + 2 * SEC, answer);
        assert_eq!(done, "linked");
        let answer = render_with(&gist_request(&second), Ok(VAnswer::Gist(gist_facts(GH))));
        let again = finish_link(&mut c, &wallet(), &second, later + 3 * SEC, answer);
        assert_eq!(again, "ignored:not_live");
    });
}

#[test]
fn a_second_link_while_one_is_live_is_refused_until_it_goes_stale() {
    let mut c = contract();
    let s = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
    let before = snap(&c);
    act(wallet(), LINK_ATTACH, T_LINK + 60 * SEC);
    assert_refused(
        &mut c,
        "a link check is already running for this wallet",
        |c| c.link(gist_n(2), U64(T_LINK / SEC + 1_800)),
    );
    assert_eq!(snap(&c), before);
    // Another wallet is not blocked by it.
    let other = start_link(&mut c, &wallet2(), &gist_n(3), T_LINK + 60 * SEC);
    assert_ne!(other.seq, s.seq);
    // A run exactly at the timeout is still live; one nanosecond later it is stale.
    let edge = T_LINK + RUN_TIMEOUT_NANOS;
    act(wallet(), LINK_ATTACH, edge);
    assert_refused(&mut c, "a link check is already running", |c| {
        c.link(gist_n(2), U64(edge / SEC + 1_800))
    });
    start_link(&mut c, &wallet(), &gist_n(2), edge + 1);
}

#[test]
fn a_link_call_needs_the_exact_deposit_the_gas_a_gist_id_and_a_live_expiry() {
    let mut c = contract();
    let before = snap(&c);
    let e = U64(T_LINK / SEC + 1_800);
    act(wallet(), NearToken::from_millinear(16), T_LINK);
    assert_refused(&mut c, "attach exactly 0.017 NEAR", |c| {
        c.link(gist_n(1), e)
    });
    act(wallet(), NearToken::from_millinear(18), T_LINK);
    assert_refused(&mut c, "attach exactly 0.017 NEAR", |c| {
        c.link(gist_n(1), e)
    });
    act_with_gas(wallet(), LINK_ATTACH, T_LINK, Gas::from_tgas(259));
    assert_refused(&mut c, "attach at least 260 Tgas", |c| c.link(gist_n(1), e));
    act(wallet(), LINK_ATTACH, T_LINK);
    for bad in ["", "ABC123", "xyz", &"a".repeat(65)] {
        assert_refused(&mut c, "gist_id must be the gist's lowercase hex id", |c| {
            c.link(bad.to_string(), e)
        });
    }
    assert_refused(&mut c, "expires_at must be in the future", |c| {
        c.link(gist_n(1), U64(T_LINK / SEC))
    });
    assert_refused(&mut c, "at most one hour ahead", |c| {
        c.link(gist_n(1), U64(T_LINK / SEC + 3_601))
    });
    assert_eq!(snap(&c), before);
}

#[test]
fn the_link_deposit_is_the_run_deposit_plus_the_link_storage_deposit_of_0_017_near() {
    assert_eq!(LINK_STORAGE_DEPOSIT, NearToken::from_millinear(7));
    assert_eq!(STORAGE_DEPOSIT, NearToken::from_millinear(30));
    assert_eq!(LINK_ATTACH, NearToken::from_millinear(17));
    assert_eq!(
        LINK_ATTACH.as_yoctonear(),
        run_deposit() + LINK_STORAGE_DEPOSIT.as_yoctonear()
    );
}

#[test]
fn a_link_with_any_deposit_but_exactly_0_017_near_is_refused_and_changes_nothing() {
    let mut c = contract();
    let before = snap(&c);
    let e = U64(T_LINK / SEC + 1_800);
    let exact = LINK_ATTACH.as_yoctonear();
    let wrong = [
        ("0.01 (the run only)", RUN_DEPOSIT.as_yoctonear()),
        (
            "0.007 (the storage only)",
            LINK_STORAGE_DEPOSIT.as_yoctonear(),
        ),
        ("0.0171", 17_100_000_000_000_000_000_000),
        ("0.017 less one yocto", exact - 1),
        ("0.017 plus one yocto", exact + 1),
        ("0.027", 27_000_000_000_000_000_000_000),
        ("nothing", 0),
    ];
    for (name, yocto) in wrong {
        act(wallet(), NearToken::from_yoctonear(yocto), T_LINK);
        assert_refused(&mut c, "attach exactly 0.017 NEAR", |c| {
            c.link(gist_n(1), e)
        });
        assert_eq!(snap(&c), before, "{name} must change nothing");
        assert!(c.link_runs.get(&wallet()).is_none(), "{name}: no run");
        assert!(!c.used_gists.contains(&gist_n(1)), "{name}: gist unused");
        assert!(get_created_receipts().is_empty(), "{name}: no receipt");
    }
    // The exact amount starts the check, and the contract keeps it all until the callback.
    let s = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
    assert!(c.link_runs.get(&wallet()).is_some());
    assert_eq!(s.seq, c.next_seq);
}

/// The transfers in the created receipts: (receiver, amount in yocto).
fn transfers() -> Vec<(AccountId, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

/// The only receipt a failed link callback may create: the storage deposit back to the wallet.
fn assert_only_the_link_storage_deposit_went_back(who: &AccountId, context: &str) {
    assert_eq!(
        transfers(),
        vec![(who.clone(), LINK_STORAGE_DEPOSIT.as_yoctonear())],
        "{context}: exactly the link storage deposit goes to the wallet"
    );
    assert_eq!(
        get_created_receipts().len(),
        1,
        "{context}: nothing else is sent"
    );
}

/// One link check that ends with `expected` and stores nothing.
fn assert_link_returns_storage_deposit(
    expected: &'static str,
    answer: impl FnOnce(&LinkStart) -> PromiseResult + Send + 'static,
    callback_delay_secs: u64,
    expires_in_secs: u64,
) {
    isolated(move || {
        let mut c = contract();
        let at = T_LINK;
        let expires = at / SEC + expires_in_secs;
        let s = start_link_expiring(&mut c, &wallet(), &gist_n(1), at, expires);
        let result = answer(&s);
        let outcome = finish_link(
            &mut c,
            &wallet(),
            &s,
            at + callback_delay_secs * SEC,
            result,
        );
        assert_eq!(outcome, expected);
        assert_only_the_link_storage_deposit_went_back(&wallet(), expected);
    });
}

fn facts_answer(
    owner_id: u64,
    files: u32,
    challenge_matches: bool,
) -> impl Fn(&LinkStart) -> PromiseResult {
    move |s| {
        let facts = VGist {
            owner_id,
            files,
            challenge_matches,
        };
        render_with(&gist_request(s), Ok(VAnswer::Gist(facts)))
    }
}

#[test]
fn a_link_check_that_stores_nothing_returns_the_link_storage_deposit_to_the_wallet() {
    // mismatch:challenge and mismatch:ambiguous
    assert_link_returns_storage_deposit(
        "mismatch:challenge",
        facts_answer(GH, 1, false),
        10,
        1_800,
    );
    for files in [0u32, 2] {
        assert_link_returns_storage_deposit(
            "mismatch:ambiguous",
            facts_answer(GH, files, true),
            10,
            1_800,
        );
    }
    // no_result:<reason> for every verifier reason
    for reason in ALL_REASONS {
        assert_link_returns_storage_deposit(
            no_result_text(reason),
            move |s| render_with(&gist_request(s), Err(reason)),
            10,
            1_800,
        );
    }
    // A failed promise, an empty answer and an answer bound to another run.
    assert_link_returns_storage_deposit(
        "no_result:promise_failed",
        |_| PromiseResult::Failed,
        10,
        1_800,
    );
    assert_link_returns_storage_deposit(
        "no_result:no_output",
        |_| PromiseResult::Successful(b"null".to_vec()),
        10,
        1_800,
    );
    assert_link_returns_storage_deposit(
        "no_result:wrong_binding",
        |s| {
            let mut request = gist_request(s);
            request.seq += 1;
            render_as(
                &request,
                &run_context(15_100 + s.seq),
                Ok(VAnswer::Gist(gist_facts(GH))),
            )
        },
        10,
        1_800,
    );
    // no_result:expired: the challenge expires 60 s ahead and the answer lands 61 s later.
    assert_link_returns_storage_deposit("no_result:expired", facts_answer(GH, 1, true), 61, 60);
}

#[test]
fn a_gist_used_in_the_meantime_returns_the_link_storage_deposit_to_the_second_wallet() {
    isolated(|| {
        let mut c = contract();
        let first = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
        let second = start_link(&mut c, &wallet2(), &gist_n(1), T_LINK);
        let a = facts_answer(GH, 1, true)(&first);
        assert_eq!(
            finish_link(&mut c, &wallet(), &first, T_LINK + 5 * SEC, a),
            "linked"
        );
        // The success keeps the deposit: no receipt.
        assert!(get_created_receipts().is_empty());
        let b = facts_answer(OTHER_GH, 1, true)(&second);
        let outcome = finish_link(&mut c, &wallet2(), &second, T_LINK + 6 * SEC, b);
        assert_eq!(outcome, "mismatch:gist_used");
        assert_only_the_link_storage_deposit_went_back(&wallet2(), "mismatch:gist_used");
    });
}

#[test]
fn a_stale_link_result_returns_the_link_storage_deposit_to_the_wallet() {
    isolated(|| {
        let mut c = contract();
        let s = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
        let answer = facts_answer(GH, 1, true)(&s);
        let late = T_LINK + RUN_TIMEOUT_NANOS + 1;
        let outcome = finish_link(&mut c, &wallet(), &s, late, answer);
        assert_eq!(outcome, "no_result:stale");
        assert_only_the_link_storage_deposit_went_back(&wallet(), "no_result:stale");
    });
}

#[test]
fn a_link_result_for_a_changed_link_number_returns_the_link_storage_deposit() {
    // Nothing but the callback of a live run moves a wallet's link number, so the run is made to
    // carry a number the wallet no longer has.
    isolated(|| {
        let mut c = contract();
        let mut s = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
        s.args["pending"]["link_number"] = Json::String("5".into());
        let answer = facts_answer(GH, 1, true)(&s);
        let before = snap(&c);
        let outcome = finish_link(&mut c, &wallet(), &s, T_LINK + 10 * SEC, answer);
        assert_eq!(outcome, "ignored:link_changed");
        assert_only_the_link_storage_deposit_went_back(&wallet(), "ignored:link_changed");
        assert_eq!(c.get_link(wallet()), None);
        assert!(!c.used_gists.contains(&gist_n(1)));
        assert_eq!(snap(&c), before);
        assert!(c.link_runs.get(&wallet()).is_none());
    });
}

#[test]
fn a_link_result_that_is_not_live_returns_the_link_storage_deposit_and_leaves_the_live_run() {
    isolated(|| {
        let mut c = contract();
        let first = start_link(&mut c, &wallet(), &gist_n(1), T_LINK);
        let later = T_LINK + RUN_TIMEOUT_NANOS + SEC;
        let second = start_link(&mut c, &wallet(), &gist_n(2), later);
        // The replaced run's result.
        let answer = facts_answer(GH, 1, true)(&first);
        let outcome = finish_link(&mut c, &wallet(), &first, later + SEC, answer);
        assert_eq!(outcome, "ignored:not_live");
        assert_only_the_link_storage_deposit_went_back(&wallet(), "ignored:not_live (replaced)");
        assert!(c.link_runs.get(&wallet()).is_some(), "the live run stays");
        // The live run finishes and keeps its deposit.
        let answer = facts_answer(GH, 1, true)(&second);
        assert_eq!(
            finish_link(&mut c, &wallet(), &second, later + 2 * SEC, answer),
            "linked"
        );
        assert!(get_created_receipts().is_empty());
        // The finished run's result again.
        let answer = facts_answer(GH, 1, true)(&second);
        let again = finish_link(&mut c, &wallet(), &second, later + 3 * SEC, answer);
        assert_eq!(again, "ignored:not_live");
        assert_only_the_link_storage_deposit_went_back(&wallet(), "ignored:not_live (finished)");
    });
}

#[test]
fn linked_link_pending_and_link_refreshed_keep_the_link_storage_deposit_and_send_nothing() {
    isolated(|| {
        let mut c = contract();
        let mut at = T_LINK;
        let cases = [
            (wallet(), gist_n(1), GH, "linked"),
            (wallet(), gist_n(2), GH, "link_refreshed"),
            (wallet(), gist_n(3), OTHER_GH, "link_pending"),
            (wallet2(), gist_n(4), GH, "link_pending"),
            (wallet3(), gist_n(5), THIRD_GH, "linked"),
        ];
        for (who, gist, github, expected) in cases {
            at += 100 * SEC;
            assert_eq!(link_wallet(&mut c, &who, &gist, github, at), expected);
            assert!(
                get_created_receipts().is_empty(),
                "{expected} keeps the deposit for the link record's storage"
            );
            assert!(transfers().is_empty());
        }
    });
}

#[test]
fn a_same_id_relink_with_a_new_gist_is_immediate() {
    let mut c = linked();
    let old = link_of(&c, &wallet()).active.unwrap();
    let outcome = link_wallet(&mut c, &wallet(), &gist_n(2), GH, T_LINK + 100 * SEC);
    assert_eq!(outcome, "link_refreshed");
    let link = link_of(&c, &wallet());
    let active = link.active.unwrap();
    assert_eq!(link.pending, None);
    assert_eq!(active.github_id.0, GH);
    assert_eq!(active.gist_id, gist_n(2));
    assert_ne!(active.challenge, old.challenge);
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet()));
    assert!(c.used_gists.contains(&gist_n(1)) && c.used_gists.contains(&gist_n(2)));
    // The first gist stays spent.
    act(wallet(), LINK_ATTACH, T_LINK + 200 * SEC);
    assert_refused(&mut c, "already been used", |c| {
        c.link(gist_n(1), U64(T_LINK / SEC + 1_900))
    });
}

#[test]
fn a_different_github_id_for_the_wallet_is_pending_and_does_not_change_the_active_link() {
    let mut c = linked();
    let active_before = link_of(&c, &wallet()).active.unwrap();
    let at = T_LINK + 100 * SEC;
    let outcome = link_wallet(&mut c, &wallet(), &gist_n(2), OTHER_GH, at);
    assert_eq!(outcome, "link_pending");
    let link = link_of(&c, &wallet());
    assert_eq!(link.active, Some(active_before));
    let pending = link.pending.expect("a change is waiting");
    assert_eq!(pending.link.github_id.0, OTHER_GH);
    assert_eq!(pending.link.gist_id, gist_n(2));
    let applied_at = (at + 10 * SEC) / SEC;
    assert_eq!(pending.activates_at.0, applied_at + RELINK_DELAY_SECS);
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet()));
    assert_eq!(c.github_owner_of(U64(OTHER_GH)), None);
    assert_eq!(c.link_numbers.get(&wallet()).copied(), Some(2));
    assert!(c.used_gists.contains(&gist_n(2)));
}

#[test]
fn a_second_wallet_for_a_held_github_id_is_pending_and_does_not_change_either_active_link() {
    let mut c = linked();
    let holder_before = link_of(&c, &wallet());
    let at = T_LINK + 100 * SEC;
    let outcome = link_wallet(&mut c, &wallet2(), &gist_n(2), GH, at);
    assert_eq!(outcome, "link_pending");
    let second = link_of(&c, &wallet2());
    assert_eq!(second.active, None);
    let pending = second.pending.unwrap();
    assert_eq!(pending.link.github_id.0, GH);
    assert_eq!(
        pending.activates_at.0,
        (at + 10 * SEC) / SEC + RELINK_DELAY_SECS
    );
    assert_eq!(link_of(&c, &wallet()), holder_before);
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet()));
}

#[test]
fn a_first_link_for_a_github_id_nobody_holds_is_immediate_even_after_another_wallet_linked() {
    let mut c = linked();
    let outcome = link_wallet(&mut c, &wallet2(), &gist_n(2), OTHER_GH, T_LINK + 100 * SEC);
    assert_eq!(outcome, "linked");
    assert_eq!(c.github_owner_of(U64(OTHER_GH)), Some(wallet2()));
    assert_eq!(active_github(&c, &wallet()), Some(GH));
}

/// Wallet 1 holds `GH`; wallet 2 has asked for `GH` too. Returns the activation second.
fn with_pending_change() -> (PrBounty, u64) {
    let mut c = linked();
    let at = T_LINK + 100 * SEC;
    assert_eq!(
        link_wallet(&mut c, &wallet2(), &gist_n(2), GH, at),
        "link_pending"
    );
    let due = link_of(&c, &wallet2()).pending.unwrap().activates_at.0;
    (c, due)
}

#[test]
fn activate_link_is_refused_before_the_delay_and_allowed_after() {
    let (mut c, due) = with_pending_change();
    let before = snap(&c);
    act(stranger(), zero(), due * SEC - 1);
    assert_refused(&mut c, "no link change of this wallet is due", |c| {
        c.activate_link(wallet2())
    });
    assert_eq!(snap(&c), before);
    act(stranger(), zero(), due * SEC);
    assert!(c.activate_link(wallet2()));
    assert_eq!(active_github(&c, &wallet2()), Some(GH));
    assert_eq!(link_of(&c, &wallet2()).pending, None);
    // Nothing is left to apply.
    assert_refused(&mut c, "no link change of this wallet is due", |c| {
        c.activate_link(wallet2())
    });
    // A wallet with no change at all.
    assert_refused(&mut c, "no link change of this wallet is due", |c| {
        c.activate_link(wallet3())
    });
}

#[test]
fn activating_a_second_wallets_link_displaces_the_previous_holder() {
    let (mut c, due) = with_pending_change();
    act(stranger(), zero(), due * SEC);
    c.activate_link(wallet2());
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet2()));
    assert_eq!(active_github(&c, &wallet2()), Some(GH));
    assert_eq!(
        link_of(&c, &wallet()).active,
        None,
        "the holder loses the id"
    );
    assert!(get_logs().iter().any(|l| l.contains("link_activated")));
}

#[test]
fn activating_a_wallets_change_to_another_id_releases_its_previous_id() {
    let mut c = linked();
    link_wallet(&mut c, &wallet(), &gist_n(2), OTHER_GH, T_LINK + 100 * SEC);
    let due = link_of(&c, &wallet()).pending.unwrap().activates_at.0;
    act(stranger(), zero(), due * SEC);
    assert!(c.activate_link(wallet()));
    assert_eq!(active_github(&c, &wallet()), Some(OTHER_GH));
    assert_eq!(c.github_owner_of(U64(OTHER_GH)), Some(wallet()));
    assert_eq!(c.github_owner_of(U64(GH)), None, "the old id is free again");
    assert_eq!(link_of(&c, &wallet()).pending, None);
}

const CONFIRM_REFUSAL: &str =
    "only the wallet that holds this GitHub account today can confirm early";
const CANCEL_REFUSAL: &str =
    "only the wallet itself or the wallet that holds this GitHub account can cancel";

#[test]
fn only_the_incumbent_holder_can_confirm_a_link_change_early() {
    let (mut c, due) = with_pending_change();
    let before = snap(&c);
    for who in [wallet2(), stranger(), buyer(), owner(), wallet3()] {
        act(who, zero(), due * SEC - 100 * SEC);
        assert_refused(&mut c, CONFIRM_REFUSAL, |c| {
            c.confirm_link_change(wallet2())
        });
    }
    assert_eq!(snap(&c), before);
    // No change waiting.
    act(wallet(), zero(), T_LINK + 200 * SEC);
    assert_refused(&mut c, "no link change is waiting for this wallet", |c| {
        c.confirm_link_change(wallet3())
    });
    // The holder confirms, well before the delay.
    act(wallet(), zero(), due * SEC - 100 * SEC);
    assert!(c.confirm_link_change(wallet2()));
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet2()));
    assert_eq!(link_of(&c, &wallet()).active, None);
}

#[test]
fn a_wallet_changing_to_a_free_id_confirms_its_own_change_and_nobody_else_can() {
    let mut c = linked();
    link_wallet(&mut c, &wallet(), &gist_n(2), OTHER_GH, T_LINK + 100 * SEC);
    act(stranger(), zero(), T_LINK + 200 * SEC);
    assert_refused(&mut c, CONFIRM_REFUSAL, |c| c.confirm_link_change(wallet()));
    act(wallet(), zero(), T_LINK + 200 * SEC);
    assert!(c.confirm_link_change(wallet()));
    assert_eq!(active_github(&c, &wallet()), Some(OTHER_GH));
}

#[test]
fn only_the_wallet_or_the_incumbent_can_cancel_a_link_change() {
    let (mut c, due) = with_pending_change();
    let before = snap(&c);
    for who in [stranger(), buyer(), owner(), wallet3()] {
        act(who, zero(), due * SEC - 100 * SEC);
        assert_refused(&mut c, CANCEL_REFUSAL, |c| c.cancel_link_change(wallet2()));
    }
    assert_eq!(snap(&c), before);
    act(wallet(), zero(), T_LINK);
    assert_refused(&mut c, "no link change is waiting for this wallet", |c| {
        c.cancel_link_change(wallet())
    });
    assert_refused(&mut c, "no link change is waiting for this wallet", |c| {
        c.cancel_link_change(wallet3())
    });
    // The incumbent cancels the other wallet's change.
    act(wallet(), zero(), due * SEC - 100 * SEC);
    c.cancel_link_change(wallet2());
    assert_eq!(link_of(&c, &wallet2()).pending, None);
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet()));
    act(stranger(), zero(), due * SEC);
    assert_refused(&mut c, "no link change of this wallet is due", |c| {
        c.activate_link(wallet2())
    });
}

#[test]
fn the_wallet_itself_can_cancel_its_waiting_change() {
    let (mut c, due) = with_pending_change();
    act(wallet2(), zero(), due * SEC - 100 * SEC);
    c.cancel_link_change(wallet2());
    assert_eq!(link_of(&c, &wallet2()).pending, None);
    assert_eq!(active_github(&c, &wallet()), Some(GH));
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("link_change_cancelled")));
}

// A relink that activates later must never rewrite what a claim or a submission pinned.

/// Terms with a claim and a deadline long enough to outlast the production relink delay.
fn long_claim(t: &mut PostTerms) {
    t.claim_by = U64(START_S + 5 * 86_400);
    t.claim_secs = U64(9 * 86_400);
    t.merge_deadline = U64(LONG_DEADLINE);
}

const LONG_DEADLINE: u64 = START_S + 10 * 86_400;

fn bound_long() -> (PrBounty, BountyId) {
    let (mut c, id) = claimed_long();
    assert_eq!(submit_ok(&mut c, id, &wallet(), T_SUBMIT), "bound");
    (c, id)
}

fn claimed_long() -> (PrBounty, BountyId) {
    let mut c = linked();
    let id = post_terms(&mut c, long_claim);
    claim_at(&mut c, id, &wallet(), T_CLAIM);
    (c, id)
}

#[test]
fn a_link_change_that_activates_after_a_claim_does_not_change_the_claim() {
    let (mut c, id) = claimed_with_second_wallet();
    let claim_before = c.get_bounty(id).unwrap().claim.unwrap();
    assert_eq!(claim_before.github_id.0, GH);
    // A third wallet asks for the claimant's id, and the claimant moves to another id.
    link_wallet(&mut c, &wallet3(), &gist_n(6), GH, T_CLAIM + 90 * SEC);
    link_wallet(&mut c, &wallet(), &gist_n(5), THIRD_GH, T_CLAIM + 100 * SEC);
    let due = link_of(&c, &wallet()).pending.unwrap().activates_at.0;
    let due3 = link_of(&c, &wallet3()).pending.unwrap().activates_at.0;
    act(stranger(), zero(), due.max(due3) * SEC);
    assert!(c.activate_link(wallet()));
    assert!(c.activate_link(wallet3()));
    assert_eq!(active_github(&c, &wallet()), Some(THIRD_GH));
    assert_eq!(c.github_owner_of(U64(GH)), Some(wallet3()));
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.status, Status::Claimed);
    assert_eq!(
        b.claim.unwrap(),
        claim_before,
        "github id, key and vault stay as claimed"
    );
    assert_eq!(claim_before.key, pk(&withdrawal_sk(&wallet())));
    assert_eq!(
        claim_before.vault,
        keys::vault_of(VAULT_CODE, &claim_before.key)
    );
}

#[test]
fn a_link_change_that_activates_after_an_accepted_submission_does_not_change_the_binding() {
    let (mut c, id) = bound_long();
    let b0 = c.get_bounty(id).unwrap();
    let (claim0, binding0) = (b0.claim.clone().unwrap(), b0.binding.clone().unwrap());
    // The wallet moves to another id and a second wallet asks for the old one.
    link_wallet(&mut c, &wallet2(), &gist_n(6), GH, T_SUBMIT + 100 * SEC);
    link_wallet(
        &mut c,
        &wallet(),
        &gist_n(5),
        THIRD_GH,
        T_SUBMIT + 110 * SEC,
    );
    let t = T_SUBMIT + 120 * SEC + RELINK_DELAY_SECS * SEC;
    act(stranger(), zero(), t);
    assert!(c.activate_link(wallet()));
    assert!(c.activate_link(wallet2()));
    assert_eq!(active_github(&c, &wallet()), Some(THIRD_GH));
    assert_eq!(active_github(&c, &wallet2()), Some(GH));
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.claim.clone().unwrap(), claim0);
    assert_eq!(b.binding.clone().unwrap(), binding0);
    assert_eq!(binding0.author_id.0, GH);
    assert_eq!(binding0.pr_id.0, PR_ID);
    assert_eq!(binding0.pr_number, PR);
    assert_eq!(binding0.wallet, wallet());
    assert_eq!(binding0.bound_at.0, T_SUBMIT);
    assert_eq!(b.status, Status::Bound);
    // The merge check still matches the pinned author and pays the pinned vault.
    let outcome = look(
        &mut c,
        id,
        t + 100 * SEC,
        pull("closed", Some(LONG_DEADLINE - 5)),
    );
    assert_eq!(outcome, "paid");
    let payout = payout_of(&c, id);
    assert_eq!((payout.key, payout.vault), (claim0.key, claim0.vault));
    assert_accounting(&c);
}

#[test]
fn a_link_change_after_a_claim_makes_a_new_submission_refused_with_the_documented_message() {
    let (mut c, id) = claimed_long();
    link_wallet(&mut c, &wallet(), &gist_n(5), OTHER_GH, T_CLAIM + 100 * SEC);
    let due = link_of(&c, &wallet()).pending.unwrap().activates_at.0;
    let claim = c.get_bounty(id).unwrap().claim.unwrap();
    // The change is due but nobody called activate_link: submit_pr applies it first, then refuses.
    let before = snap(&c);
    act(wallet(), RUN_DEPOSIT, due * SEC);
    assert_refused(
        &mut c,
        "this wallet's GitHub link changed after it claimed, so this claim cannot be submitted; a released or ended claim cannot be made again by this wallet",
        |c| c.submit_pr(id, PR),
    );
    let b = c.get_bounty(id).unwrap();
    assert_eq!(
        (b.status, b.live, b.claim.unwrap()),
        (Status::Claimed, None, claim)
    );
    assert_eq!(active_github(&c, &wallet()), Some(OTHER_GH));
    assert_ne!(snap(&c), before, "only the due link change was applied");
    assert_eq!(link_of(&c, &wallet()).pending, None);
}

#[test]
fn a_claimant_who_lost_the_github_id_to_another_wallet_cannot_submit() {
    let (mut c, id) = claimed_long();
    link_wallet(&mut c, &wallet2(), &gist_n(6), GH, T_CLAIM + 100 * SEC);
    let due = link_of(&c, &wallet2()).pending.unwrap().activates_at.0;
    act(stranger(), zero(), due * SEC);
    c.activate_link(wallet2());
    assert_eq!(link_of(&c, &wallet()).active, None);
    act(wallet(), RUN_DEPOSIT, due * SEC + SEC);
    assert_refused(
        &mut c,
        "connect a GitHub account to this wallet first",
        |c| c.submit_pr(id, PR),
    );
    assert_eq!(c.get_bounty(id).unwrap().live, None);
}

#[test]
fn a_due_link_change_is_applied_at_the_next_claim_and_pinned_into_it() {
    let mut c = linked();
    let first = post_terms(&mut c, long_claim);
    let second = post_terms(&mut c, long_claim);
    link_wallet(&mut c, &wallet(), &gist_n(5), OTHER_GH, T_LINK + 100 * SEC);
    let due = link_of(&c, &wallet()).pending.unwrap().activates_at.0;
    // Claim the bounty after the change is due: the claim names and pins the new id.
    let at = due * SEC;
    let key = pk(&withdrawal_sk(&wallet()));
    act(wallet(), zero(), at);
    let stale = claim_proof(
        &withdrawal_sk(&wallet()),
        first,
        &wallet(),
        GH,
        &key,
        at / SEC + 600,
    );
    assert_refused(&mut c, "the withdrawal key's proof does not match", |c| {
        c.claim(first, key.clone(), stale)
    });
    claim_as(&mut c, second, &wallet(), OTHER_GH, at);
    assert_eq!(
        c.get_bounty(second).unwrap().claim.unwrap().github_id.0,
        OTHER_GH
    );
    assert_eq!(active_github(&c, &wallet()), Some(OTHER_GH));
}

#[test]
fn a_new_submission_after_a_relink_activates_sends_the_new_gist() {
    let mut c = linked();
    let id = post_terms(&mut c, long_claim);
    link_wallet(&mut c, &wallet(), &gist_n(5), GH, T_LINK + 100 * SEC);
    claim_at(&mut c, id, &wallet(), T_CLAIM);
    let s = start_submit(&mut c, id, &wallet(), PR, T_SUBMIT);
    assert_eq!(
        s.gist,
        gist_n(5),
        "the refreshed link is the one that is read"
    );
    let asked = verifier_request();
    assert_eq!(asked, submit_request(id, &s));
}

// ---- 3. Claims ----

#[test]
fn an_accepted_claim_pins_the_wallet_github_id_key_vault_and_end_time() {
    let (c, id) = claimed();
    let b = c.get_bounty(id).unwrap();
    let key = pk(&withdrawal_sk(&wallet()));
    assert_eq!(b.status, Status::Claimed);
    assert_eq!(
        b.claim.unwrap(),
        Claim {
            wallet: wallet(),
            github_id: U64(GH),
            key: key.clone(),
            vault: keys::vault_of(VAULT_CODE, &key),
            claimed_at: U64(T_CLAIM),
            ends_at: U64(T_CLAIM / SEC + CLAIM_SECS),
        }
    );
    assert_eq!(c.vault_of(key.clone()), keys::vault_of(VAULT_CODE, &key));
    assert_eq!((b.binding, b.live), (None, None));
    assert!(!c.is_barred(id, wallet()));
    assert_accounting(&c);
}

#[test]
fn a_wallet_whose_transaction_key_differs_from_the_withdrawal_key_still_claims() {
    let mut c = linked();
    let id = post(&mut c);
    let (signer, tx_key) = (withdrawal_sk(&wallet()), pk(&sk(9)));
    let key = pk(&signer);
    assert_ne!(key, tx_key);
    let mut builder = context(wallet(), zero(), T_CLAIM);
    builder.signer_account_pk(tx_key.clone());
    testing_env!(builder.build());
    let proof = claim_proof(&signer, id, &wallet(), GH, &key, T_CLAIM / SEC + 600);
    c.claim(id, key.clone(), proof);
    let claim = c.get_bounty(id).unwrap().claim.unwrap();
    assert_eq!(claim.key, key);
    assert_eq!(claim.vault, keys::vault_of(VAULT_CODE, &key));
    assert_ne!(claim.vault, keys::vault_of(VAULT_CODE, &tx_key));
}

#[test]
fn a_claim_needs_an_active_github_link() {
    let mut c = linked();
    let id = post(&mut c);
    // No link at all.
    let key = pk(&withdrawal_sk(&wallet2()));
    act(wallet2(), zero(), T_CLAIM);
    let proof = claim_proof(
        &withdrawal_sk(&wallet2()),
        id,
        &wallet2(),
        OTHER_GH,
        &key,
        T_CLAIM / SEC + 600,
    );
    assert_refused(
        &mut c,
        "connect a GitHub account to this wallet first",
        |c| c.claim(id, key.clone(), proof.clone()),
    );
    // A link that is only pending is not active.
    link_wallet(&mut c, &wallet2(), &gist_n(2), GH, T_LINK + 50 * SEC);
    assert_eq!(link_of(&c, &wallet2()).active, None);
    // One second after the link was recorded, well inside the relink delay of every build.
    assert!(RELINK_DELAY_SECS > 1);
    let soon = T_LINK + 61 * SEC;
    act(wallet2(), zero(), soon);
    let proof = claim_proof(
        &withdrawal_sk(&wallet2()),
        id,
        &wallet2(),
        GH,
        &key,
        soon / SEC + 600,
    );
    assert_refused(
        &mut c,
        "connect a GitHub account to this wallet first",
        |c| c.claim(id, key.clone(), proof.clone()),
    );
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.claim), (Status::Open, None));
}

/// Applies `edit` to a valid claim call and expects exactly this refusal and no state change.
fn assert_claim_refused(
    needle: &'static str,
    edit: impl FnOnce(&mut BountyId, &mut PublicKey, &mut ClaimProof) + Send + 'static,
) {
    isolated(move || {
        let mut c = linked();
        let mut id = post(&mut c);
        let signer = withdrawal_sk(&wallet());
        let mut key = pk(&signer);
        act(wallet(), zero(), T_CLAIM);
        let mut proof = claim_proof(&signer, id, &wallet(), GH, &key, T_CLAIM / SEC + 1_800);
        let real = id;
        edit(&mut id, &mut key, &mut proof);
        let before = snap(&c);
        let msg = refusal(&mut c, |c| c.claim(id, key, proof));
        assert!(msg.contains(needle), "expected {needle:?}, got {msg:?}");
        assert_eq!(snap(&c), before, "{msg}");
        let b = c.get_bounty(real).unwrap();
        assert_eq!((b.status, b.claim), (Status::Open, None));
        assert!(!c.is_barred(real, wallet()));
    });
}

const PROOF_MISMATCH: &str = "the withdrawal key's proof does not match";

#[test]
fn a_claim_signed_by_a_different_key_is_refused() {
    assert_claim_refused(PROOF_MISMATCH, |id, key, proof| {
        *proof = claim_proof(&sk(9), *id, &wallet(), GH, key, T_CLAIM / SEC + 1_800);
    });
    assert_claim_refused(PROOF_MISMATCH, |_, key, _| *key = pk(&sk(9)));
    assert_claim_refused(PROOF_MISMATCH, |_, _, proof| {
        proof.signature = Base64VecU8(vec![1; 64]);
    });
}

#[test]
fn a_claim_proof_for_another_bounty_wallet_github_id_or_expiry_is_refused() {
    assert_claim_refused(PROOF_MISMATCH, |id, key, proof| {
        *proof = claim_proof(
            &withdrawal_sk(&wallet()),
            *id + 1,
            &wallet(),
            GH,
            key,
            T_CLAIM / SEC + 1_800,
        );
    });
    assert_claim_refused(PROOF_MISMATCH, |id, key, proof| {
        *proof = claim_proof(
            &withdrawal_sk(&wallet()),
            *id,
            &wallet2(),
            GH,
            key,
            T_CLAIM / SEC + 1_800,
        );
    });
    assert_claim_refused(PROOF_MISMATCH, |id, key, proof| {
        *proof = claim_proof(
            &withdrawal_sk(&wallet()),
            *id,
            &wallet(),
            OTHER_GH,
            key,
            T_CLAIM / SEC + 1_800,
        );
    });
    assert_claim_refused(PROOF_MISMATCH, |_, _, proof| {
        proof.expires_at = U64(proof.expires_at.0 + 1);
    });
}

#[test]
fn a_claim_proof_for_another_contract_or_network_is_refused() {
    assert_claim_refused(PROOF_MISMATCH, |id, key, proof| {
        let message = keys::claim_message(
            "testnet",
            "other.testnet",
            wallet().as_str(),
            *id,
            GH,
            key,
            proof.expires_at.0,
        );
        proof.signature = sign(&withdrawal_sk(&wallet()), &message, "other.testnet");
    });
    assert_claim_refused(PROOF_MISMATCH, |id, key, proof| {
        let message = keys::claim_message(
            "mainnet",
            this().as_str(),
            wallet().as_str(),
            *id,
            GH,
            key,
            proof.expires_at.0,
        );
        proof.signature = sign(&withdrawal_sk(&wallet()), &message, this().as_str());
    });
}

#[test]
fn an_expired_claim_proof_or_one_too_far_ahead_is_refused() {
    assert_claim_refused("expires_at must be in the future", |_, _, proof| {
        proof.expires_at = U64(T_CLAIM / SEC);
    });
    assert_claim_refused("expires_at must be in the future", |_, _, proof| {
        proof.expires_at = U64(T_CLAIM / SEC - 1);
    });
    assert_claim_refused("at most one hour ahead", |_, _, proof| {
        proof.expires_at = U64(T_CLAIM / SEC + 3_601);
    });
}

#[test]
fn a_claim_with_a_non_ed25519_key_or_a_short_signature_is_refused() {
    assert_claim_refused("keys must be ed25519 public keys", |_, key, _| {
        *key = PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap();
    });
    assert_claim_refused("signatures must be 64 bytes", |_, _, proof| {
        proof.signature.0.pop();
    });
}

#[test]
fn a_second_claim_by_another_wallet_in_the_same_block_is_refused_as_not_open() {
    let (mut c, id) = claimed_with_second_wallet();
    let before = snap(&c);
    let signer = withdrawal_sk(&wallet2());
    let key = pk(&signer);
    act(wallet2(), zero(), T_CLAIM);
    let proof = claim_proof(&signer, id, &wallet2(), OTHER_GH, &key, T_CLAIM / SEC + 600);
    assert_refused(&mut c, "this bounty is not open to claims", |c| {
        c.claim(id, key, proof)
    });
    assert_eq!(snap(&c), before);
    assert_eq!(c.get_bounty(id).unwrap().claim.unwrap().wallet, wallet());
}

#[test]
fn the_same_wallet_cannot_claim_twice_even_with_a_new_key() {
    let (mut c, id) = claimed();
    let before = snap(&c);
    let signer = sk(11);
    let key = pk(&signer);
    act(wallet(), zero(), T_CLAIM + SEC);
    let proof = claim_proof(&signer, id, &wallet(), GH, &key, T_CLAIM / SEC + 600);
    assert_refused(&mut c, "this bounty is not open to claims", |c| {
        c.claim(id, key, proof)
    });
    assert_eq!(snap(&c), before);
}

#[test]
fn a_claim_at_or_after_claim_by_is_refused_and_one_just_before_it_is_accepted() {
    for at in [
        CLAIM_BY * SEC,
        CLAIM_BY * SEC + 1,
        CLAIM_BY * SEC + 600 * SEC,
    ] {
        isolated(move || {
            let mut c = linked();
            let id = post(&mut c);
            let before = snap(&c);
            let key = pk(&withdrawal_sk(&wallet()));
            act(wallet(), zero(), at);
            let proof = claim_proof(
                &withdrawal_sk(&wallet()),
                id,
                &wallet(),
                GH,
                &key,
                at / SEC + 600,
            );
            assert_refused(&mut c, "the claim window has ended", |c| {
                c.claim(id, key, proof)
            });
            assert_eq!(snap(&c), before);
        });
    }
    let mut c = linked();
    let id = post(&mut c);
    claim_at(&mut c, id, &wallet(), CLAIM_BY * SEC - 1);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Claimed);
}

#[test]
fn a_claim_ends_at_the_claim_time_or_the_merge_deadline_whichever_is_first() {
    // Claim time first.
    let (c, id) = claimed();
    assert_eq!(
        c.get_bounty(id).unwrap().claim.unwrap().ends_at.0,
        T_CLAIM / SEC + CLAIM_SECS
    );
    // The merge deadline first.
    isolated(|| {
        let mut c = linked();
        let id = post_terms(&mut c, |t| t.claim_by = U64(DEADLINE));
        let at = (DEADLINE - 100) * SEC;
        claim_at(&mut c, id, &wallet(), at);
        let claim = c.get_bounty(id).unwrap().claim.unwrap();
        assert_eq!(claim.ends_at.0, DEADLINE);
        assert!(DEADLINE < at / SEC + CLAIM_SECS);
    });
    // Exactly equal.
    isolated(|| {
        let mut c = linked();
        let id = post_terms(&mut c, |t| t.claim_by = U64(DEADLINE));
        let at = (DEADLINE - CLAIM_SECS) * SEC;
        claim_at(&mut c, id, &wallet(), at);
        assert_eq!(c.get_bounty(id).unwrap().claim.unwrap().ends_at.0, DEADLINE);
    });
}

#[test]
fn a_claim_on_a_bound_or_missing_bounty_is_refused() {
    let (mut c, id) = bound();
    let signer = withdrawal_sk(&wallet2());
    let key = pk(&signer);
    link_wallet(
        &mut c,
        &wallet2(),
        &gist_n(2),
        OTHER_GH,
        T_SUBMIT + 50 * SEC,
    );
    act(wallet2(), zero(), T_SUBMIT + 100 * SEC);
    let proof = claim_proof(
        &signer,
        id,
        &wallet2(),
        OTHER_GH,
        &key,
        T_SUBMIT / SEC + 600,
    );
    assert_refused(&mut c, "this bounty is not open to claims", |c| {
        c.claim(id, key.clone(), proof.clone())
    });
    assert_refused(&mut c, "no such bounty", |c| c.claim(id + 5, key, proof));
}

/// How a claim ends, who may end it, and the log word it leaves.
#[derive(Clone, Copy, Debug)]
enum End {
    Release,
    Revoke,
    Expire,
}

const ENDS: [End; 3] = [End::Release, End::Revoke, End::Expire];

impl End {
    fn word(self) -> &'static str {
        match self {
            End::Release => "released",
            End::Revoke => "revoked",
            End::Expire => "expired",
        }
    }

    fn actor(self) -> AccountId {
        match self {
            End::Release => wallet(),
            End::Revoke => buyer(),
            End::Expire => stranger(),
        }
    }

    fn call(self, c: &mut PrBounty, id: BountyId) {
        match self {
            End::Release => c.release_claim(id),
            End::Revoke => c.revoke_claim(id),
            End::Expire => c.expire_claim(id),
        }
    }

    /// Ends the claim of `id` at `at` (nanoseconds) as its proper actor.
    fn at(self, c: &mut PrBounty, id: BountyId, at: u64) {
        act(self.actor(), zero(), at);
        self.call(c, id);
    }
}

#[test]
fn releasing_revoking_or_expiring_a_claim_reopens_the_bounty_and_bars_the_wallet() {
    for how in ENDS {
        isolated(move || {
            let (mut c, id) = claimed_with_second_wallet();
            let held = c.get_config().held.0;
            how.at(&mut c, id, CLAIM_ENDS * SEC);
            let b = c.get_bounty(id).unwrap();
            assert_eq!(
                (b.status, b.claim.is_none(), b.live),
                (Status::Open, true, None),
                "{how:?}"
            );
            assert!(c.is_barred(id, wallet()), "{how:?}");
            assert!(!c.is_barred(id, wallet2()));
            assert_eq!(c.get_config().held.0, held, "no money moves");
            assert!(get_logs()
                .iter()
                .any(|l| l.contains("claim_ended") && l.contains(&format!("how={}", how.word()))));
            // The barred wallet cannot claim again, even with a new key.
            let signer = sk(12);
            let key = pk(&signer);
            let at = CLAIM_ENDS * SEC + SEC;
            act(wallet(), zero(), at);
            let proof = claim_proof(&signer, id, &wallet(), GH, &key, at / SEC + 600);
            let before = snap(&c);
            let again = refusal(&mut c, |c| c.claim(id, key, proof));
            assert!(
                again.contains("earlier claim on the bounty ended; it cannot claim again"),
                "{again}"
            );
            assert_eq!(snap(&c), before);
            assert_accounting(&c);
        });
    }
}

#[test]
fn after_a_claim_ends_another_wallet_can_claim_the_reopened_bounty() {
    for how in ENDS {
        isolated(move || {
            let mut c = linked();
            link_wallet(&mut c, &wallet2(), &gist_n(2), OTHER_GH, T_LINK);
            // claim_by far ahead so the bounty can be claimed again after the first claim ends.
            let id = post_terms(&mut c, |t| t.claim_by = U64(DEADLINE));
            claim_at(&mut c, id, &wallet(), T_CLAIM);
            how.at(&mut c, id, CLAIM_ENDS * SEC);
            let at = CLAIM_ENDS * SEC + 10 * SEC;
            claim_at(&mut c, id, &wallet2(), at);
            let b = c.get_bounty(id).unwrap();
            assert_eq!(b.status, Status::Claimed);
            let claim = b.claim.unwrap();
            assert_eq!((claim.wallet, claim.github_id.0), (wallet2(), OTHER_GH));
            assert_eq!(claim.ends_at.0, at / SEC + CLAIM_SECS);
            assert!(c.is_barred(id, wallet()));
        });
    }
}

#[test]
fn only_the_right_account_can_release_revoke_or_expire_a_claim() {
    let (mut c, id) = claimed();
    let before = snap(&c);
    for who in [buyer(), stranger(), wallet2(), owner()] {
        act(who, zero(), CLAIM_ENDS * SEC);
        assert_refused(&mut c, "only the claimant can release the claim", |c| {
            c.release_claim(id)
        });
    }
    for who in [wallet(), stranger(), wallet2(), owner()] {
        act(who, zero(), CLAIM_ENDS * SEC);
        assert_refused(&mut c, "only the maintainer can revoke a claim", |c| {
            c.revoke_claim(id)
        });
    }
    assert_eq!(snap(&c), before);
    // A bounty with no claim.
    let open = post(&mut c);
    act(wallet(), zero(), CLAIM_ENDS * SEC);
    assert_refused(&mut c, "only the claimant can release the claim", |c| {
        c.release_claim(open)
    });
    act(buyer(), zero(), CLAIM_ENDS * SEC);
    assert_refused(&mut c, "this bounty has no claim to end", |c| {
        c.revoke_claim(open)
    });
    act(stranger(), zero(), CLAIM_ENDS * SEC);
    assert_refused(&mut c, "the claim has not ended yet", |c| {
        c.expire_claim(open)
    });
}

#[test]
fn a_claim_cannot_be_expired_before_it_is_due_and_can_at_the_moment_it_is() {
    let (mut c, id) = claimed();
    let before = snap(&c);
    act(stranger(), zero(), CLAIM_ENDS * SEC - 1);
    assert_refused(&mut c, "the claim has not ended yet", |c| {
        c.expire_claim(id)
    });
    assert_eq!(snap(&c), before);
    End::Expire.at(&mut c, id, CLAIM_ENDS * SEC);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Open);
}

#[test]
fn a_claim_ended_by_the_wallet_or_maintainer_early_does_not_wait_for_ends_at() {
    for how in [End::Release, End::Revoke] {
        isolated(move || {
            let (mut c, id) = claimed();
            how.at(&mut c, id, T_CLAIM + SEC);
            assert_eq!(c.get_bounty(id).unwrap().status, Status::Open);
        });
    }
}

#[test]
fn a_claim_cannot_be_ended_while_a_submission_check_is_live_but_can_once_it_is_stale() {
    for how in ENDS {
        isolated(move || {
            let (mut c, id) = claimed();
            // The submission is requested just before the claim ends, so every ending is "due".
            let requested = CLAIM_ENDS * SEC - SEC;
            let s = start_submit(&mut c, id, &wallet(), PR, requested);
            let before = snap(&c);
            for at in [requested + 2 * SEC, requested + RUN_TIMEOUT_NANOS] {
                act(how.actor(), zero(), at.max(CLAIM_ENDS * SEC));
                let msg = refusal(&mut c, |c| how.call(c, id));
                assert!(
                    msg.contains("a submission is being checked; wait for its result"),
                    "{how:?}: {msg}"
                );
                assert_eq!(snap(&c), before, "{how:?}");
            }
            // One nanosecond past the timeout the run is stale and the claim can end.
            how.at(&mut c, id, requested + RUN_TIMEOUT_NANOS + 1);
            let b = c.get_bounty(id).unwrap();
            assert_eq!(
                (b.status, b.live, b.claim.is_none()),
                (Status::Open, None, true),
                "{how:?}"
            );
            assert!(c.is_barred(id, wallet()));
            // The late result of the abandoned run changes nothing.
            let after = snap(&c);
            let answer = render_with(
                &submit_request(id, &s),
                Ok(VAnswer::PullGist(open_pull(), gist_facts(GH))),
            );
            let outcome = on_check_with(
                &mut c,
                id,
                s.seq,
                requested + RUN_TIMEOUT_NANOS + 5 * SEC,
                answer,
            );
            assert_eq!(outcome, "ignored:not_live");
            assert_eq!(snap(&c), after);
            assert_eq!(c.bound_pr(U64(PR_ID)), None);
        });
    }
}

#[test]
fn a_bound_bounty_cannot_be_released_revoked_or_expired() {
    for how in ENDS {
        isolated(move || {
            let (mut c, id) = bound();
            let before = snap(&c);
            act(how.actor(), zero(), CLAIM_ENDS * SEC + SEC);
            assert_refused(&mut c, "this bounty has no claim to end", |c| {
                how.call(c, id)
            });
            assert_eq!(snap(&c), before);
        });
    }
}

// ---- 4. Submitting a pull request ----

#[test]
fn an_accepted_submission_pins_the_author_pull_request_wallet_and_time_and_sets_bound() {
    let (mut c, id) = claimed();
    let claim = c.get_bounty(id).unwrap().claim.unwrap();
    let s = start_submit(&mut c, id, &wallet(), PR, T_SUBMIT);
    // What the contract asked the verifier, read by the verifier's own parser.
    assert_eq!(verifier_request(), submit_request(id, &s));
    let (_, deposit) = outlayer_call();
    assert_eq!(deposit, RUN_DEPOSIT);
    let live = c.get_bounty(id).unwrap().live.unwrap();
    assert_eq!(
        live,
        LiveRun {
            seq: U64(s.seq),
            kind: RunKind::Submit,
            requested_at: U64(T_SUBMIT),
            pr_number: PR,
            payer: wallet(),
            sponsored: false,
            gist_id: Some(gist_n(1)),
        }
    );
    let answer = render_with(
        &submit_request(id, &s),
        Ok(VAnswer::PullGist(open_pull(), gist_facts(GH))),
    );
    let at = T_SUBMIT + 10 * SEC;
    assert_eq!(on_check_with(&mut c, id, s.seq, at, answer), "bound");
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.status, Status::Bound);
    assert_eq!(
        b.binding.unwrap(),
        Binding {
            pr_number: PR,
            pr_id: U64(PR_ID),
            author_id: U64(GH),
            wallet: wallet(),
            bound_at: U64(T_SUBMIT),
            request_id: U64(15_100 + s.seq),
        }
    );
    assert_eq!(b.claim.unwrap(), claim, "the claim is untouched");
    assert_eq!(b.live, None);
    assert_eq!(
        b.last_check.unwrap(),
        CheckRecord {
            seq: U64(s.seq),
            kind: "submit".into(),
            request_id: Some(U64(15_100 + s.seq)),
            resolved_at: U64(at),
            outcome: "bound".into(),
        }
    );
    assert_eq!(
        (b.merge, b.definite_look, b.payout, b.refund),
        (None, None, None, None)
    );
    assert_eq!(c.bound_pr(U64(PR_ID)), Some(id));
    assert_accounting(&c);
}

/// A submission whose answer is wrong or unusable: the outcome is recorded, the bounty stays
/// claimed with nothing pinned, and the wallet can submit again.
fn assert_submit_outcome(
    expected: &'static str,
    answer: impl FnOnce(BountyId, &Submit) -> PromiseResult + Send + 'static,
) {
    isolated(move || {
        let (mut c, id) = claimed();
        let before = c.get_bounty(id).unwrap();
        let s = start_submit(&mut c, id, &wallet(), PR, T_SUBMIT);
        let result = answer(id, &s);
        let at = T_SUBMIT + 10 * SEC;
        assert_eq!(on_check_with(&mut c, id, s.seq, at, result), expected);
        let after = c.get_bounty(id).unwrap();
        let recorded = after.last_check.clone().expect("the outcome is recorded");
        assert_eq!(
            (
                recorded.seq.0,
                recorded.kind.as_str(),
                recorded.outcome.as_str()
            ),
            (s.seq, "submit", expected)
        );
        assert_eq!(recorded.resolved_at.0, at);
        let mut expect = before;
        expect.last_check = after.last_check.clone();
        assert_eq!(after, expect, "{expected} must only record the outcome");
        assert_eq!(
            (after.status, after.binding.clone()),
            (Status::Claimed, None)
        );
        assert_eq!(c.bound_pr(U64(PR_ID)), None);
        assert!(get_logs()
            .iter()
            .any(|l| l.contains("check_resolved") && l.contains(&format!("outcome={expected}"))));
        assert_accounting(&c);
        // The claimant can try again, and a good answer then binds.
        let again = submit_ok(&mut c, id, &wallet(), T_SUBMIT + 100 * SEC);
        assert_eq!(
            again, "bound",
            "{expected} must leave the submission retriable"
        );
    });
}

fn good_submission(id: BountyId, s: &Submit, pull: VPull, gist: VGist) -> PromiseResult {
    render_with(&submit_request(id, s), Ok(VAnswer::PullGist(pull, gist)))
}

#[test]
fn a_pull_request_by_another_author_is_not_bound() {
    assert_submit_outcome("mismatch:author_id", |id, s| {
        let mut p = open_pull();
        p.author_id = OTHER_GH;
        good_submission(id, s, p, gist_facts(GH))
    });
}

#[test]
fn a_pull_request_against_another_base_branch_is_not_bound() {
    assert_submit_outcome("mismatch:base_ref", |id, s| {
        let mut p = open_pull();
        p.base_ref = "dev".into();
        good_submission(id, s, p, gist_facts(GH))
    });
}

#[test]
fn a_pull_request_of_another_repository_is_not_bound() {
    assert_submit_outcome("mismatch:repo_id", |id, s| {
        let mut p = open_pull();
        p.repo_id = REPO_ID + 1;
        good_submission(id, s, p, gist_facts(GH))
    });
}

#[test]
fn an_answer_whose_facts_name_a_different_pull_request_number_is_not_bound() {
    assert_submit_outcome("mismatch:pr_number", |id, s| {
        let mut p = open_pull();
        p.pr_number = PR + 1;
        good_submission(id, s, p, gist_facts(GH))
    });
}

#[test]
fn a_closed_or_merged_pull_request_is_not_bound() {
    assert_submit_outcome("mismatch:not_open", |id, s| {
        good_submission(id, s, pull("closed", None), gist_facts(GH))
    });
    assert_submit_outcome("mismatch:not_open", |id, s| {
        good_submission(id, s, pull("closed", Some(START_S + 300)), gist_facts(GH))
    });
}

#[test]
fn a_link_gist_owned_by_another_account_is_not_bound() {
    assert_submit_outcome("mismatch:link_owner", |id, s| {
        good_submission(id, s, open_pull(), gist_facts(OTHER_GH))
    });
}

#[test]
fn a_link_gist_with_two_files_is_not_bound() {
    for files in [0u32, 2] {
        assert_submit_outcome("mismatch:link_ambiguous", move |id, s| {
            let gist = VGist {
                owner_id: GH,
                files,
                challenge_matches: false,
            };
            good_submission(id, s, open_pull(), gist)
        });
    }
}

#[test]
fn a_link_gist_whose_challenge_does_not_match_is_not_bound() {
    assert_submit_outcome("mismatch:link_challenge", |id, s| {
        let gist = VGist {
            owner_id: GH,
            files: 1,
            challenge_matches: false,
        };
        good_submission(id, s, open_pull(), gist)
    });
}

#[test]
fn an_answer_bound_to_another_bounty_seq_gist_number_or_caller_is_wrong_binding() {
    let mutations: Vec<fn(&mut Request, BountyId)> = vec![
        |r, id| r.bounty = id + 1,
        |r, _| r.seq += 1,
        |r, _| r.contract = "other.testnet".into(),
        |r, _| r.network = "mainnet".into(),
        |r, _| r.repo = "proven-test/other".into(),
        |r, _| {
            if let Op::PullGist { gist_id, .. } = &mut r.op {
                *gist_id = gist_n(9);
            }
        },
        |r, _| {
            if let Op::PullGist { number, .. } = &mut r.op {
                *number += 1;
            }
        },
        |r, _| {
            if let Op::PullGist { number, .. } = r.op.clone() {
                r.op = Op::Pull { number };
            }
        },
    ];
    for mutate in mutations {
        assert_submit_outcome("no_result:wrong_binding", move |id, s| {
            let mut request = submit_request(id, s);
            mutate(&mut request, id);
            let answer = match request.op {
                Op::Pull { .. } => VAnswer::Pull(open_pull()),
                _ => VAnswer::PullGist(open_pull(), gist_facts(GH)),
            };
            render_with_seq(&request, s.seq, Ok(answer))
        });
    }
    assert_submit_outcome("no_result:wrong_binding", |id, s| {
        let other = verifier::RunContext::from_vars(Some("other.testnet".into()), Some("5".into()));
        let answer = VAnswer::PullGist(open_pull(), gist_facts(GH));
        render_as(&submit_request(id, s), &other, Ok(answer))
    });
}

/// Like `render_with` but with the request id taken from the real run, not the edited request.
fn render_with_seq(request: &Request, seq: u64, answer: Result<VAnswer, Reason>) -> PromiseResult {
    render_as(request, &run_context(15_100 + seq), answer)
}

#[test]
fn every_verifier_no_result_reason_leaves_a_submission_claimed_and_retriable() {
    for reason in ALL_REASONS {
        assert_submit_outcome(no_result_text(reason), move |id, s| {
            render_with(&submit_request(id, s), Err(reason))
        });
    }
}

#[test]
fn a_failed_null_malformed_or_oversized_submission_answer_leaves_it_claimed_and_retriable() {
    assert_submit_outcome("no_result:promise_failed", |_, _| PromiseResult::Failed);
    assert_submit_outcome("no_result:no_output", |_, _| {
        PromiseResult::Successful(b"null".to_vec())
    });
    assert_submit_outcome("no_result:malformed", |_, _| {
        PromiseResult::Successful(b"[]".to_vec())
    });
    assert_submit_outcome("no_result:oversized", |_, _| {
        PromiseResult::Successful(vec![b' '; answer::MAX_OUTPUT_BYTES + 1])
    });
    // A pull answer without the gist facts the submission asked for.
    assert_submit_outcome("no_result:malformed", |id, s| {
        let mut request = submit_request(id, s);
        request.op = Op::PullGist {
            number: s.pr,
            gist_id: s.gist.clone(),
            challenge: s.challenge.clone(),
        };
        render_with(&request, Ok(VAnswer::Pull(open_pull())))
    });
    // Facts that contradict each other (merged but open).
    assert_submit_outcome("no_result:malformed", |id, s| {
        let mut p = open_pull();
        p.merged = true;
        p.merged_at = Some(START_S);
        good_submission(id, s, p, gist_facts(GH))
    });
}

#[test]
fn a_pull_request_already_bound_to_another_bounty_is_not_bound_again() {
    let (mut c, first) = bound();
    let second = post(&mut c);
    claim_at(&mut c, second, &wallet(), T_CLAIM + 30 * SEC);
    let before = c.get_bounty(first).unwrap();
    let outcome = submit_with(
        &mut c,
        second,
        &wallet(),
        open_pull(),
        gist_facts(GH),
        T_SUBMIT + 100 * SEC,
    );
    assert_eq!(outcome, "mismatch:pr_already_bound");
    assert_eq!(c.get_bounty(second).unwrap().status, Status::Claimed);
    assert_eq!(c.get_bounty(second).unwrap().binding, None);
    assert_eq!(c.get_bounty(first).unwrap(), before);
    assert_eq!(c.bound_pr(U64(PR_ID)), Some(first));
    assert_accounting(&c);
}

#[test]
fn a_second_submission_while_one_is_live_is_refused_until_it_goes_stale() {
    let (mut c, id) = claimed();
    let s = start_submit(&mut c, id, &wallet(), PR, T_SUBMIT);
    let before = snap_state(&c);
    for at in [T_SUBMIT + SEC, T_SUBMIT + RUN_TIMEOUT_NANOS] {
        act(wallet(), RUN_DEPOSIT, at);
        assert_refused(&mut c, "a check is already running for this bounty", |c| {
            c.submit_pr(id, PR + 1)
        });
        assert_eq!(snap_state(&c), before);
    }
    // One nanosecond later the first run is stale and is replaced.
    let later = T_SUBMIT + RUN_TIMEOUT_NANOS + 1;
    let second = start_submit(&mut c, id, &wallet(), PR, later);
    assert_ne!(second.seq, s.seq);
    let old = good_submission(id, &s, open_pull(), gist_facts(GH));
    let outcome = on_check_with(&mut c, id, s.seq, later + SEC, old);
    assert_eq!(outcome, "ignored:not_live");
    assert_eq!(c.get_bounty(id).unwrap().live.unwrap().seq.0, second.seq);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Claimed);
}

#[test]
fn a_stale_late_submission_result_changes_nothing_even_if_it_would_bind() {
    let (mut c, id) = claimed();
    let s = start_submit(&mut c, id, &wallet(), PR, T_SUBMIT);
    let answer = good_submission(id, &s, open_pull(), gist_facts(GH));
    let late = T_SUBMIT + RUN_TIMEOUT_NANOS + 1;
    assert_eq!(
        on_check_with(&mut c, id, s.seq, late, answer),
        "no_result:stale"
    );
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.binding, b.live), (Status::Claimed, None, None));
    assert_eq!(b.last_check.unwrap().outcome, "no_result:stale");
    assert_eq!(c.bound_pr(U64(PR_ID)), None);
    // Exactly at the timeout the result still counts.
    let (mut c, id) = (c, id);
    let s = start_submit(&mut c, id, &wallet(), PR, late + SEC);
    let answer = good_submission(id, &s, open_pull(), gist_facts(GH));
    let edge = late + SEC + RUN_TIMEOUT_NANOS;
    assert_eq!(on_check_with(&mut c, id, s.seq, edge, answer), "bound");
}

#[test]
fn a_result_for_an_unknown_bounty_or_run_is_ignored() {
    let (mut c, id) = claimed();
    let before = snap(&c);
    let null = || PromiseResult::Successful(b"null".to_vec());
    let missing = on_check_with(&mut c, id + 9, 1, T_SUBMIT, null());
    assert_eq!(missing, "ignored:no_bounty");
    assert_eq!(
        on_check_with(&mut c, id, 1, T_SUBMIT, null()),
        "ignored:not_live"
    );
    assert_eq!(snap(&c), before);
}

#[test]
fn only_the_claimant_can_submit() {
    let (mut c, id) = claimed_with_second_wallet();
    let before = snap(&c);
    for who in [wallet2(), stranger(), buyer(), owner()] {
        act(who, RUN_DEPOSIT, T_SUBMIT);
        assert_refused(
            &mut c,
            "only the claimant can submit, and only while the bounty is claimed",
            |c| c.submit_pr(id, PR),
        );
    }
    assert_eq!(snap(&c), before);
    // No claim at all.
    let open = post(&mut c);
    act(wallet(), RUN_DEPOSIT, T_SUBMIT);
    assert_refused(&mut c, "this bounty has no claim", |c| {
        c.submit_pr(open, PR)
    });
}

#[test]
fn a_bound_bounty_cannot_be_submitted_again() {
    let (mut c, id) = bound();
    let before = snap(&c);
    act(wallet(), RUN_DEPOSIT, T_SUBMIT + 100 * SEC);
    assert_refused(
        &mut c,
        "only the claimant can submit, and only while the bounty is claimed",
        |c| c.submit_pr(id, PR),
    );
    assert_eq!(snap(&c), before);
}

#[test]
fn a_submission_after_the_claim_ended_is_refused() {
    let (mut c, id) = claimed();
    let before = snap(&c);
    for at in [
        CLAIM_ENDS * SEC,
        CLAIM_ENDS * SEC + 1,
        CLAIM_ENDS * SEC + 3_600 * SEC,
    ] {
        act(wallet(), RUN_DEPOSIT, at);
        assert_refused(&mut c, "your claim has ended", |c| c.submit_pr(id, PR));
    }
    assert_eq!(snap(&c), before);
    // The last nanosecond of the claim still accepts a submission.
    start_submit(&mut c, id, &wallet(), PR, CLAIM_ENDS * SEC - 1);
}

#[test]
fn a_submission_after_the_claim_was_released_is_refused() {
    let (mut c, id) = claimed();
    End::Release.at(&mut c, id, T_CLAIM + SEC);
    act(wallet(), RUN_DEPOSIT, T_SUBMIT);
    assert_refused(&mut c, "this bounty has no claim", |c| c.submit_pr(id, PR));
}

#[test]
fn a_submission_call_needs_the_exact_deposit_the_gas_and_a_pull_request_number() {
    let (mut c, id) = claimed();
    let before = snap(&c);
    act(wallet(), NearToken::from_millinear(9), T_SUBMIT);
    assert_refused(&mut c, "attach exactly 0.01 NEAR", |c| c.submit_pr(id, PR));
    act(wallet(), zero(), T_SUBMIT);
    assert_refused(&mut c, "attach exactly 0.01 NEAR", |c| c.submit_pr(id, PR));
    act_with_gas(wallet(), RUN_DEPOSIT, T_SUBMIT, Gas::from_tgas(259));
    assert_refused(&mut c, "attach at least 260 Tgas", |c| c.submit_pr(id, PR));
    act(wallet(), RUN_DEPOSIT, T_SUBMIT);
    for bad in [0, u64::from(u32::MAX) + 1] {
        assert_refused(&mut c, "pr_number must be a pull request number", |c| {
            c.submit_pr(id, bad)
        });
    }
    assert_eq!(snap(&c), before);
}

// ---- 5. Checking the merge ----

fn bound_secs() -> u64 {
    T_SUBMIT / SEC
}

#[test]
fn a_pull_request_merged_strictly_before_the_deadline_is_paid_to_the_pinned_vault() {
    let (mut c, id) = bound();
    let claim = c.get_bounty(id).unwrap().claim.unwrap();
    let held = c.get_config().held.0;
    let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, T_CHECK);
    assert_eq!(verifier_request(), merge_request(id, seq, PR));
    let facts = pull("closed", Some(DEADLINE - 1));
    let answer = render_with(&merge_request(id, seq, PR), Ok(VAnswer::Pull(facts)));
    let at = T_CHECK + 10 * SEC;
    assert_eq!(on_check_with(&mut c, id, seq, at, answer), "paid");
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.status, Status::Paid);
    assert_eq!(
        b.payout.unwrap(),
        Settlement {
            kind: SettlementKind::Payout,
            key: claim.key,
            vault: claim.vault,
            principal: U128(REWARD),
            state: SettlementState::Due,
            attempt: 0,
            sent_at: U64(0),
            outcome: AttemptOutcome::Unknown,
            reconcile: None,
            done_by: None,
        }
    );
    assert_eq!(b.refund, None);
    assert_eq!(
        b.merge.unwrap(),
        MergeRecord {
            merged_at: U64(DEADLINE - 1),
            request_id: U64(15_100 + seq),
            checked_at: U64(at),
        }
    );
    assert_eq!(
        b.definite_look, None,
        "a merged pull request is not a negative look"
    );
    let last = b.last_check.unwrap();
    assert_eq!(
        (last.kind.as_str(), last.outcome.as_str()),
        ("merge", "paid")
    );
    assert_eq!(
        c.get_config().held.0,
        held,
        "the reward is held until the vault confirms it"
    );
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(0));
    assert_eq!(callback_args("send_due_after_check")["bounty_id"], id);
    assert_accounting(&c);
}

#[test]
fn merge_times_at_the_binding_skew_edge_are_paid_and_just_before_it_are_not() {
    for (merged_at, expected) in [
        (bound_secs() - MAX_CLOCK_SKEW_SECS, "paid"),
        (bound_secs(), "paid"),
        (bound_secs() + 1, "paid"),
        (
            bound_secs() - MAX_CLOCK_SKEW_SECS - 1,
            "no_result:merged_before_binding",
        ),
        (bound_secs() - 3_600, "no_result:merged_before_binding"),
    ] {
        isolated(move || {
            let (mut c, id) = bound();
            let out = look(&mut c, id, T_CHECK, pull("closed", Some(merged_at)));
            assert_eq!(out, expected, "merged_at {merged_at}");
            let b = c.get_bounty(id).unwrap();
            if expected == "paid" {
                assert_eq!(b.status, Status::Paid);
            } else {
                assert_eq!((b.status, b.payout, b.merge), (Status::Bound, None, None));
                assert_eq!(
                    b.definite_look, None,
                    "a no_result is never a negative look"
                );
                assert_eq!(b.last_check.unwrap().outcome, expected);
            }
        });
    }
}

#[test]
fn a_pull_request_merged_exactly_at_the_deadline_or_after_it_is_not_paid() {
    for merged_at in [DEADLINE, DEADLINE + 1, DEADLINE + 3_600] {
        isolated(move || {
            let (mut c, id) = bound();
            let out = look(&mut c, id, T_CHECK, pull("closed", Some(merged_at)));
            assert_eq!(out, "ineligible:merged_after_deadline");
            let b = c.get_bounty(id).unwrap();
            assert_eq!((b.status, b.payout.is_none()), (Status::Ineligible, true));
            assert_eq!(b.merge.unwrap().merged_at.0, merged_at);
            assert_eq!(
                b.definite_look, None,
                "a merged pull request is not a negative look"
            );
            assert_accounting(&c);
            // Nothing more to check; the maintainer's refund opens at once.
            let again = refusal(&mut c, |c| {
                act(stranger(), RUN_DEPOSIT, T_CHECK + 100 * SEC);
                c.check_merge(id)
            });
            assert!(
                again.contains("no submitted pull request to check"),
                "{again}"
            );
        });
    }
}

#[test]
fn a_merge_answer_for_another_pull_request_id_number_author_or_repository_is_inconsistent() {
    let edits: Vec<fn(&mut VPull)> = vec![
        |p| p.pr_id += 1,
        |p| p.pr_number += 1,
        |p| p.author_id = OTHER_GH,
        |p| p.repo_id += 1,
    ];
    for edit in edits {
        isolated(move || {
            let (mut c, id) = bound();
            let before = c.get_bounty(id).unwrap();
            let mut facts = pull("closed", Some(DEADLINE - 1));
            edit(&mut facts);
            let out = look(&mut c, id, T_CHECK, facts);
            assert_eq!(out, "no_result:inconsistent");
            let after = c.get_bounty(id).unwrap();
            assert_eq!(
                after.definite_look, None,
                "an inconsistent look is not definite"
            );
            assert_eq!(
                (after.status, after.merge.clone(), after.payout.clone()),
                (Status::Bound, None, None)
            );
            let mut expect = before;
            expect.last_check = after.last_check.clone();
            assert_eq!(after, expect);
            assert_eq!(after.last_check.unwrap().outcome, "no_result:inconsistent");
            assert_accounting(&c);
        });
    }
}

#[test]
fn a_merge_into_another_base_branch_is_ineligible_and_an_open_one_is_pending() {
    let (mut c, id) = bound();
    let mut facts = pull("closed", Some(DEADLINE - 10));
    facts.base_ref = "dev".into();
    assert_eq!(look(&mut c, id, T_CHECK, facts), "ineligible:base_ref");
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.payout), (Status::Ineligible, None));
    assert_eq!(
        b.definite_look, None,
        "a merged pull request is not a negative look"
    );
    isolated(|| {
        let (mut c, id) = bound();
        let mut facts = open_pull();
        facts.base_ref = "dev".into();
        assert_eq!(look(&mut c, id, T_CHECK, facts), "pending:base_ref");
        let b = c.get_bounty(id).unwrap();
        assert_eq!(b.status, Status::Bound);
        assert_eq!(
            b.definite_look.unwrap().requested_at.0,
            T_CHECK,
            "not merged anywhere: a negative look"
        );
    });
}

#[test]
fn an_open_or_unmerged_pull_request_is_pending_and_the_look_is_definite() {
    let (mut c, id) = bound();
    assert_eq!(look(&mut c, id, T_CHECK, open_pull()), "pending");
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.status, Status::Bound);
    assert_eq!(b.definite_look.unwrap().requested_at.0, T_CHECK);
    // A later look replaces the recorded one; a closed, unmerged pull request is pending too.
    let later = T_CHECK + 100 * SEC;
    assert_eq!(look(&mut c, id, later, pull("closed", None)), "pending");
    assert_eq!(
        c.get_bounty(id).unwrap().definite_look.unwrap(),
        Look {
            requested_at: U64(later),
            resolved_at: U64(later + 10 * SEC)
        }
    );
    assert_accounting(&c);
}

#[test]
fn a_failed_look_leaves_the_bounty_bound_and_can_be_repeated() {
    for reason in ALL_REASONS {
        isolated(move || {
            let (mut c, id) = bound();
            let before = c.get_bounty(id).unwrap();
            let out = check_with(&mut c, id, &stranger(), RUN_DEPOSIT, T_CHECK, Err(reason));
            assert_eq!(out, no_result_text(reason));
            let after = c.get_bounty(id).unwrap();
            assert_eq!((after.status, after.definite_look), (Status::Bound, None));
            let mut expect = before;
            expect.last_check = after.last_check.clone();
            assert_eq!(after, expect);
            assert_accounting(&c);
            // The same click again, now answered.
            let pay = look(
                &mut c,
                id,
                T_CHECK + 100 * SEC,
                pull("closed", Some(DEADLINE - 1)),
            );
            assert_eq!(pay, "paid");
        });
    }
}

#[test]
fn a_failed_null_malformed_or_oversized_merge_answer_changes_nothing() {
    let cases: Vec<(&str, PromiseResult)> = vec![
        ("no_result:promise_failed", PromiseResult::Failed),
        (
            "no_result:no_output",
            PromiseResult::Successful(b"null".to_vec()),
        ),
        (
            "no_result:malformed",
            PromiseResult::Successful(b"{".to_vec()),
        ),
        (
            "no_result:oversized",
            PromiseResult::Successful(vec![b' '; answer::MAX_OUTPUT_BYTES + 1]),
        ),
    ];
    for (expected, result) in cases {
        isolated(move || {
            let (mut c, id) = bound();
            let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, T_CHECK);
            let out = on_check_with(&mut c, id, seq, T_CHECK + 10 * SEC, result);
            assert_eq!(out, expected);
            let b = c.get_bounty(id).unwrap();
            assert_eq!(
                (b.status, b.definite_look, b.payout),
                (Status::Bound, None, None)
            );
        });
    }
}

#[test]
fn a_merge_answer_bound_to_another_bounty_seq_or_number_is_wrong_binding() {
    let edits: Vec<fn(&mut Request, BountyId)> = vec![
        |r, id| r.bounty = id + 1,
        |r, _| r.seq += 1,
        |r, _| r.op = Op::Pull { number: PR + 1 },
        |r, _| {
            r.op = Op::PullGist {
                number: PR,
                gist_id: gist_n(1),
                challenge: format!("proven-link:{}", hash_hex(1)),
            }
        },
    ];
    for edit in edits {
        isolated(move || {
            let (mut c, id) = bound();
            let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, T_CHECK);
            let mut request = merge_request(id, seq, PR);
            edit(&mut request, id);
            let facts = pull("closed", Some(DEADLINE - 1));
            let answer = match request.op {
                Op::PullGist { .. } => VAnswer::PullGist(facts, gist_facts(GH)),
                _ => VAnswer::Pull(facts),
            };
            let result = render_with_seq(&request, seq, Ok(answer));
            let out = on_check_with(&mut c, id, seq, T_CHECK + 10 * SEC, result);
            assert_eq!(out, "no_result:wrong_binding");
            let b = c.get_bounty(id).unwrap();
            assert_eq!(
                (b.status, b.definite_look, b.payout),
                (Status::Bound, None, None)
            );
        });
    }
}

#[test]
fn a_stale_merge_result_changes_nothing() {
    let (mut c, id) = bound();
    let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, T_CHECK);
    let facts = pull("closed", Some(DEADLINE - 1));
    let answer = render_with(&merge_request(id, seq, PR), Ok(VAnswer::Pull(facts)));
    let out = on_check_with(&mut c, id, seq, T_CHECK + RUN_TIMEOUT_NANOS + 1, answer);
    assert_eq!(out, "no_result:stale");
    let b = c.get_bounty(id).unwrap();
    assert_eq!(
        (b.status, b.definite_look, b.payout, b.live),
        (Status::Bound, None, None, None)
    );
}

#[test]
fn merge_checks_are_accepted_after_the_grace_until_the_hard_cutoff_and_refused_from_then_on() {
    // After the grace: still accepted, at every point up to one nanosecond before the cutoff.
    for at in [VERIFY_UNTIL, AFTER_GRACE, REFUND_CAP_AT - 1] {
        isolated(move || {
            let (mut c, id) = bound();
            let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, at);
            assert!(seq > 0, "a check at {at} is accepted");
        });
    }
    // At and after the cutoff: refused, and nothing changes.
    let (mut c, id) = bound();
    let before = snap(&c);
    for at in [
        REFUND_CAP_AT,
        REFUND_CAP_AT + 1,
        REFUND_CAP_AT + 3_600 * SEC,
    ] {
        act(stranger(), RUN_DEPOSIT, at);
        assert_refused(
            &mut c,
            "merge checks ended at the hard refund cutoff",
            |c| c.check_merge(id),
        );
    }
    assert_eq!(snap(&c), before);
}

#[test]
fn an_on_time_merge_verified_after_the_grace_is_paid_up_to_the_cutoff() {
    // Every look failed until the grace ended; the merge (one second before the deadline) is
    // read after it and paid. The merge deadline, not the time of the check, decides.
    for at in [VERIFY_UNTIL, AFTER_GRACE, REFUND_CAP_AT - 1] {
        isolated(move || {
            let (mut c, id) = bound();
            let out = check_with(
                &mut c,
                id,
                &stranger(),
                RUN_DEPOSIT,
                DEADLINE * SEC,
                Err(Reason::Unreachable),
            );
            assert_eq!(out, "no_result:unreachable");
            assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
            let out = look(&mut c, id, at, pull("closed", Some(DEADLINE - 1)));
            assert_eq!(out, "paid", "checked at {at}");
            let b = c.get_bounty(id).unwrap();
            assert_eq!(b.status, Status::Paid);
            assert_eq!(b.merge.unwrap().merged_at.0, DEADLINE - 1);
            assert_eq!(b.payout.unwrap().vault, b.claim.unwrap().vault);
            assert_eq!(b.refund, None);
            assert_accounting(&c);
            assert_refused(&mut c, "cannot be refunded yet", |c| {
                act(stranger(), zero(), REFUND_CAP_AT + SEC);
                c.settle(id)
            });
        });
    }
}

#[test]
fn a_late_merge_checked_after_the_grace_is_still_not_paid() {
    for merged_at in [DEADLINE, DEADLINE + GRACE + 60] {
        isolated(move || {
            let (mut c, id) = bound();
            let out = look(&mut c, id, AFTER_GRACE, pull("closed", Some(merged_at)));
            assert_eq!(
                out, "ineligible:merged_after_deadline",
                "merged at {merged_at}"
            );
            let b = c.get_bounty(id).unwrap();
            assert_eq!((b.status, b.payout), (Status::Ineligible, None));
            settle_at(&mut c, id, AFTER_GRACE + SEC);
            let b = c.get_bounty(id).unwrap();
            assert_eq!((b.status, b.payout.is_none()), (Status::Refunded, true));
            assert_eq!(b.refund.unwrap().vault, b.maintainer_vault);
            assert_accounting(&c);
        });
    }
}

#[test]
fn a_check_in_flight_at_the_cutoff_blocks_the_refund_and_its_valid_result_pays() {
    let (mut c, id) = bound();
    let requested = REFUND_CAP_AT - SEC;
    let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, requested);
    // The cutoff passes while the check runs: no refund, no new check.
    assert_cannot_settle(&mut c, id, REFUND_CAP_AT);
    assert_cannot_settle(&mut c, id, requested + RUN_TIMEOUT_NANOS);
    // Its answer lands within the run's time and says the merge was on time: it is paid.
    let facts = pull("closed", Some(DEADLINE - 1));
    let answer = render_with(&merge_request(id, seq, PR), Ok(VAnswer::Pull(facts)));
    let out = on_check_with(&mut c, id, seq, requested + RUN_TIMEOUT_NANOS, answer);
    assert_eq!(out, "paid");
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.refund), (Status::Paid, None));
    assert_accounting(&c);
    assert_refused(&mut c, "cannot be refunded yet", |c| {
        act(stranger(), zero(), requested + RUN_TIMEOUT_NANOS + SEC);
        c.settle(id)
    });
}

#[test]
fn a_check_in_flight_at_the_cutoff_that_fails_or_goes_stale_leaves_the_refund_for_after_it() {
    // A no_result answer at the cutoff: not a negative, but the cutoff has passed, so the refund
    // opens once the run is no longer live.
    isolated(|| {
        let (mut c, id) = bound();
        let requested = REFUND_CAP_AT - SEC;
        let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, requested);
        let failed = render_with(&merge_request(id, seq, PR), Err(Reason::Timeout));
        let out = on_check_with(&mut c, id, seq, REFUND_CAP_AT + 10 * SEC, failed);
        assert_eq!(out, "no_result:timeout");
        assert_eq!(c.get_bounty(id).unwrap().definite_look, None);
        settle_at(&mut c, id, REFUND_CAP_AT + 11 * SEC);
        assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
        assert_accounting(&c);
    });
    // No answer at all: the refund waits until the run goes stale, and a late "merged on time"
    // answer after the refund is ignored.
    let (mut c, id) = bound();
    let requested = REFUND_CAP_AT - SEC;
    let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, requested);
    assert_cannot_settle(&mut c, id, requested + RUN_TIMEOUT_NANOS);
    settle_at(&mut c, id, requested + RUN_TIMEOUT_NANOS + 1);
    let facts = pull("closed", Some(DEADLINE - 1));
    let late = render_with(&merge_request(id, seq, PR), Ok(VAnswer::Pull(facts)));
    let out = on_check_with(
        &mut c,
        id,
        seq,
        requested + RUN_TIMEOUT_NANOS + 5 * SEC,
        late,
    );
    assert_eq!(out, "ignored:not_live");
    let b = c.get_bounty(id).unwrap();
    assert_eq!(
        (b.status, b.payout, b.merge),
        (Status::Refunded, None, None)
    );
    assert_accounting(&c);
}

#[test]
fn a_timeout_or_no_result_after_the_deadline_never_opens_the_refund_before_the_cutoff() {
    let failures: Vec<Result<VAnswer, Reason>> = ALL_REASONS.iter().map(|r| Err(*r)).collect();
    for answer in failures {
        isolated(move || {
            let (mut c, id) = bound();
            let out = check_with(&mut c, id, &stranger(), RUN_DEPOSIT, DEADLINE * SEC, answer);
            assert!(out.starts_with("no_result:"), "{out}");
            assert_eq!(c.get_bounty(id).unwrap().definite_look, None);
            assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
            assert_cannot_settle(&mut c, id, REFUND_CAP_AT - 1);
        });
    }
    // A merge before binding (beyond the clock skew) is a no_result too.
    let (mut c, id) = bound();
    let early = pull("closed", Some(bound_secs() - 3_600));
    assert_eq!(
        look(&mut c, id, DEADLINE * SEC, early),
        "no_result:merged_before_binding"
    );
    assert_eq!(c.get_bounty(id).unwrap().definite_look, None);
    assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
}

#[test]
fn a_look_needs_a_bound_bounty_the_exact_deposit_and_enough_gas() {
    let mut c = linked();
    let id = post(&mut c);
    act(stranger(), RUN_DEPOSIT, T_CHECK);
    assert_refused(&mut c, "no submitted pull request to check", |c| {
        c.check_merge(id)
    });
    claim_at(&mut c, id, &wallet(), T_CLAIM);
    act(stranger(), RUN_DEPOSIT, T_CHECK);
    assert_refused(&mut c, "no submitted pull request to check", |c| {
        c.check_merge(id)
    });
    submit_ok(&mut c, id, &wallet(), T_SUBMIT);
    let before = snap(&c);
    act(stranger(), NearToken::from_millinear(5), T_CHECK);
    assert_refused(
        &mut c,
        "attach exactly 0.01 NEAR, or nothing for a sponsored check",
        |c| c.check_merge(id),
    );
    act(stranger(), NearToken::from_millinear(11), T_CHECK);
    assert_refused(
        &mut c,
        "attach exactly 0.01 NEAR, or nothing for a sponsored check",
        |c| c.check_merge(id),
    );
    act_with_gas(stranger(), RUN_DEPOSIT, T_CHECK, Gas::from_tgas(259));
    assert_refused(&mut c, "attach at least 260 Tgas", |c| c.check_merge(id));
    assert_eq!(snap(&c), before);
}

#[test]
fn a_duplicate_click_while_a_check_is_live_is_refused_until_it_goes_stale() {
    let (mut c, id) = bound();
    let first = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, T_CHECK);
    let before = snap_state(&c);
    for at in [T_CHECK, T_CHECK + SEC, T_CHECK + RUN_TIMEOUT_NANOS] {
        act(buyer(), RUN_DEPOSIT, at);
        assert_refused(&mut c, "a check is already running for this bounty", |c| {
            c.check_merge(id)
        });
    }
    assert_eq!(snap_state(&c), before);
    let second = start_check(
        &mut c,
        id,
        &stranger(),
        RUN_DEPOSIT,
        T_CHECK + RUN_TIMEOUT_NANOS + 1,
    );
    assert_ne!(first, second);
}

#[test]
fn the_look_that_found_the_pull_request_merged_works_for_any_payer() {
    for payer in [stranger(), buyer(), wallet(), owner()] {
        isolated(move || {
            let (mut c, id) = bound();
            let out = check_with(
                &mut c,
                id,
                &payer,
                RUN_DEPOSIT,
                T_CHECK,
                Ok(VAnswer::Pull(pull("closed", Some(DEADLINE - 1)))),
            );
            assert_eq!(out, "paid");
            let live = c.get_bounty(id).unwrap().live;
            assert_eq!(live, None);
        });
    }
}

// ---- 5b. Sponsored checks ----

fn float_after_one_sponsored_check() -> u128 {
    NearToken::from_millinear(50).as_yoctonear() - run_deposit()
}

#[test]
fn a_sponsored_check_is_paid_by_the_float_for_the_bound_wallet_and_leaves_held_alone() {
    let (mut c, id) = bound();
    let held = c.get_config().held.0;
    act(wallet(), zero(), T_CHECK);
    let _ = c.check_merge(id);
    let (args, deposit) = outlayer_call();
    assert_eq!(args["payer_account_id"], sponsor().as_str());
    assert_eq!(deposit, RUN_DEPOSIT);
    let cfg = c.get_config();
    assert_eq!(cfg.sponsor_float.0, float_after_one_sponsored_check());
    assert_eq!(cfg.sponsor_spent.0, run_deposit());
    assert_eq!(cfg.held.0, held);
    let b = c.get_bounty(id).unwrap();
    let live = b.live.unwrap();
    assert!(live.sponsored);
    assert_eq!(live.payer, sponsor());
    assert_eq!(b.sponsored_runs, 1);
    assert_accounting(&c);
}

#[test]
fn only_the_bound_wallet_can_use_a_sponsored_check() {
    let (mut c, id) = bound();
    let before = snap(&c);
    for who in [stranger(), buyer(), owner(), wallet2()] {
        act(who, zero(), T_CHECK);
        assert_refused(
            &mut c,
            "only the contributor's wallet can use a sponsored check",
            |c| c.check_merge(id),
        );
    }
    assert_eq!(snap(&c), before, "the float is untouched");
}

#[test]
fn a_fourth_sponsored_check_on_one_bounty_is_refused() {
    let (mut c, id) = bound();
    for k in 0..SPONSORED_RUNS_PER_BOUNTY as u64 {
        // Each earlier run has gone stale by the time the next starts.
        act(wallet(), zero(), T_CHECK + k * 2 * RUN_TIMEOUT_NANOS);
        let _ = c.check_merge(id);
    }
    assert_eq!(
        c.get_bounty(id).unwrap().sponsored_runs,
        SPONSORED_RUNS_PER_BOUNTY
    );
    let before = snap(&c);
    act(wallet(), zero(), T_CHECK + 8 * RUN_TIMEOUT_NANOS);
    assert_refused(
        &mut c,
        "this bounty has used its three sponsored checks",
        |c| c.check_merge(id),
    );
    assert_eq!(snap(&c), before);
    // A self-funded check is still allowed.
    start_check(
        &mut c,
        id,
        &wallet(),
        RUN_DEPOSIT,
        T_CHECK + 8 * RUN_TIMEOUT_NANOS,
    );
}

#[test]
fn a_sponsored_check_is_refused_when_the_float_or_the_total_cap_cannot_pay() {
    let msg = {
        let (mut c, id) = bound();
        c.sponsor_float = 0;
        act(wallet(), zero(), T_CHECK);
        refusal(&mut c, |c| c.check_merge(id))
    };
    assert!(
        msg.contains("the sponsor float cannot pay for this check"),
        "{msg}"
    );
    isolated(|| {
        let (mut c, id) = bound();
        act(owner(), zero(), T_CHECK);
        c.set_sponsor_limits(U128(NearToken::from_millinear(100).as_yoctonear()), U128(0));
        act(wallet(), zero(), T_CHECK);
        assert_refused(&mut c, "the sponsor's total spending cap is reached", |c| {
            c.check_merge(id)
        });
    });
}

#[test]
fn the_sponsor_float_can_only_be_funded_by_the_owner_or_sponsor_within_its_cap() {
    isolated(|| {
        let mut c = contract();
        act(sponsor(), NearToken::from_millinear(51), START);
        assert_refused(&mut c, "the sponsor float would exceed its cap", |c| {
            c.fund_sponsor()
        });
        act(stranger(), NearToken::from_millinear(1), START);
        assert_refused(
            &mut c,
            "only the owner or the sponsor account can fund the float",
            |c| c.fund_sponsor(),
        );
        act(owner(), zero(), START);
        assert_refused(&mut c, "attach the amount", |c| c.fund_sponsor());
        act(owner(), NearToken::from_millinear(50), START);
        assert_eq!(
            c.fund_sponsor().0,
            NearToken::from_millinear(100).as_yoctonear()
        );
    });
}

#[test]
fn an_empty_float_leaves_self_funded_checks_and_refunds_available() {
    let (mut c, id) = bound();
    c.sponsor_float = 0;
    assert_eq!(look(&mut c, id, T_CHECK, open_pull()), "pending");
    settle_at(&mut c, id, (DEADLINE + GRACE + REFUND_CAP_SECS) * SEC);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
}

// ---- 6. Settling and refunding ----

/// The time the refund cap opens for a bounty with the default terms (nanoseconds).
const REFUND_CAP_AT: u64 = VERIFY_UNTIL + REFUND_CAP_SECS * SEC;
/// Halfway between the end of the grace and the hard cutoff, in both builds.
const AFTER_GRACE: u64 = VERIFY_UNTIL + REFUND_CAP_SECS * SEC / 2;

#[test]
fn an_open_bounty_is_refunded_only_from_claim_by_and_only_once() {
    let mut c = contract();
    let id = post(&mut c);
    assert_cannot_settle(&mut c, id, START);
    assert_cannot_settle(&mut c, id, CLAIM_BY * SEC - 1);
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(1));
    settle_at(&mut c, id, CLAIM_BY * SEC);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(
        (b.status, b.claim, b.payout),
        (Status::Refunded, None, None)
    );
    assert_eq!(
        refund_of(&c, id),
        Settlement {
            kind: SettlementKind::Refund,
            key: b.maintainer_key.clone(),
            vault: b.maintainer_vault.clone(),
            principal: U128(REWARD),
            state: SettlementState::InFlight,
            attempt: 1,
            sent_at: U64(CLAIM_BY * SEC),
            outcome: AttemptOutcome::Unknown,
            reconcile: None,
            done_by: None,
        }
    );
    let sent = deposits();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, b.maintainer_vault.to_string());
    assert_eq!(sent[0].1, REWARD + DEPOSIT_FEE.as_yoctonear());
    assert_eq!(sent[0].2[8], SettlementKind::Refund.byte());
    assert_eq!(
        transfers_to_accounts(),
        0,
        "nothing goes to a plain account"
    );
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(0));
    assert_accounting(&c);
    // The second settle and a cancel both fail.
    assert_cannot_settle(&mut c, id, CLAIM_BY * SEC + SEC);
    act(buyer(), zero(), CLAIM_BY * SEC + SEC);
    assert_refused(
        &mut c,
        "only a bounty with no claim can be cancelled",
        |c| c.cancel(id),
    );
    assert_eq!(c.get_bounty(id).unwrap().refund.unwrap().attempt, 1);
}

#[test]
fn a_cancel_refunds_at_once_only_for_the_maintainer_and_only_once() {
    let mut c = contract();
    let id = post(&mut c);
    for who in [stranger(), wallet(), owner()] {
        act(who, zero(), START + SEC);
        assert_refused(&mut c, "only the maintainer can cancel", |c| c.cancel(id));
    }
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Open);
    act(buyer(), zero(), START + SEC);
    c.cancel(id);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.status, Status::Cancelled);
    assert_eq!(b.refund.unwrap().state, SettlementState::InFlight);
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(0));
    assert_accounting(&c);
    act(buyer(), zero(), START + 2 * SEC);
    assert_refused(
        &mut c,
        "only a bounty with no claim can be cancelled",
        |c| c.cancel(id),
    );
    assert_cannot_settle(&mut c, id, CLAIM_BY * SEC + SEC);
    assert_eq!(c.get_bounty(id).unwrap().refund.unwrap().attempt, 1);
}

#[test]
fn a_maintainer_cannot_cancel_a_claimed_or_bound_bounty() {
    let (mut c, id) = claimed();
    act(buyer(), zero(), T_CLAIM + SEC);
    assert_refused(
        &mut c,
        "only a bounty with no claim can be cancelled",
        |c| c.cancel(id),
    );
    isolated(|| {
        let (mut c, id) = bound();
        act(buyer(), zero(), T_CHECK);
        assert_refused(
            &mut c,
            "only a bounty with no claim can be cancelled",
            |c| c.cancel(id),
        );
        assert_eq!(c.get_bounty(id).unwrap().status, Status::Bound);
    });
}

#[test]
fn a_claimed_bounty_whose_claim_outlasts_claim_by_is_refunded_when_the_claim_ends() {
    let (mut c, id) = claimed();
    assert!(CLAIM_ENDS > CLAIM_BY);
    assert_cannot_settle(&mut c, id, T_CLAIM + SEC);
    assert_cannot_settle(&mut c, id, CLAIM_BY * SEC);
    assert_cannot_settle(&mut c, id, CLAIM_ENDS * SEC - 1);
    settle_at(&mut c, id, CLAIM_ENDS * SEC);
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.binding), (Status::Refunded, None));
    assert_eq!(b.refund.unwrap().vault, b.maintainer_vault);
    assert_eq!(b.payout, None, "the contributor's vault gets nothing");
    assert_accounting(&c);
    assert_cannot_settle(&mut c, id, CLAIM_ENDS * SEC + SEC);
}

#[test]
fn a_claimed_bounty_whose_claim_ended_before_claim_by_waits_for_claim_by() {
    let mut c = linked();
    let claim_by = START_S + 600 + MIN_CLAIM_SECS + 1_000;
    let id = post_terms(&mut c, |t| {
        t.claim_secs = U64(MIN_CLAIM_SECS);
        t.claim_by = U64(claim_by);
    });
    claim_at(&mut c, id, &wallet(), T_CLAIM);
    let ends = c.get_bounty(id).unwrap().claim.unwrap().ends_at.0;
    assert_eq!(ends, START_S + 600 + MIN_CLAIM_SECS);
    assert!(ends < claim_by);
    assert_cannot_settle(&mut c, id, ends * SEC);
    assert_cannot_settle(&mut c, id, claim_by * SEC - 1);
    settle_at(&mut c, id, claim_by * SEC);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
    assert_accounting(&c);
}

#[test]
fn a_claimed_bounty_with_a_live_submission_check_is_not_refunded_until_the_check_goes_stale() {
    let (mut c, id) = claimed();
    let requested = CLAIM_ENDS * SEC - 10 * SEC;
    let s = start_submit(&mut c, id, &wallet(), PR, requested);
    assert_cannot_settle(&mut c, id, CLAIM_ENDS * SEC + 1);
    assert_cannot_settle(&mut c, id, requested + RUN_TIMEOUT_NANOS);
    settle_at(&mut c, id, requested + RUN_TIMEOUT_NANOS + 1);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
    assert_eq!(c.get_bounty(id).unwrap().live, None);
    // The check's late result would have bound the pull request; it changes nothing now.
    let late = good_submission(id, &s, open_pull(), gist_facts(GH));
    let at = requested + RUN_TIMEOUT_NANOS + 2 * SEC;
    assert_eq!(
        on_check_with(&mut c, id, s.seq, at, late),
        "ignored:not_live"
    );
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.binding), (Status::Refunded, None));
    assert_eq!(c.bound_pr(U64(PR_ID)), None);
    assert_accounting(&c);
}

#[test]
fn a_bound_bounty_is_not_refunded_before_the_checking_window_ends_even_after_a_definite_look() {
    let (mut c, id) = bound();
    assert_cannot_settle(&mut c, id, T_CHECK);
    assert_eq!(look(&mut c, id, DEADLINE * SEC, open_pull()), "pending");
    assert!(c.get_bounty(id).unwrap().definite_look.is_some());
    assert_cannot_settle(&mut c, id, DEADLINE * SEC + 100 * SEC);
    assert_cannot_settle(&mut c, id, VERIFY_UNTIL - 1);
    settle_at(&mut c, id, VERIFY_UNTIL);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
}

#[test]
fn after_the_window_a_bound_bounty_needs_a_definite_look_requested_at_or_after_the_merge_deadline()
{
    // No look at all.
    isolated(|| {
        let (mut c, id) = bound();
        assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
        assert_cannot_settle(&mut c, id, REFUND_CAP_AT - 1);
    });
    // A definite look requested one nanosecond before the merge deadline is not enough.
    isolated(|| {
        let (mut c, id) = bound();
        assert_eq!(look(&mut c, id, DEADLINE * SEC - 1, open_pull()), "pending");
        assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
        assert_cannot_settle(&mut c, id, REFUND_CAP_AT - 1);
    });
    // Looks that return no result, or facts about another pull request, are not definite.
    isolated(|| {
        let (mut c, id) = bound();
        let at = DEADLINE * SEC;
        let out = check_with(
            &mut c,
            id,
            &stranger(),
            RUN_DEPOSIT,
            at,
            Err(Reason::Timeout),
        );
        assert_eq!(out, "no_result:timeout");
        let mut other = open_pull();
        other.pr_id += 1;
        assert_eq!(
            look(&mut c, id, at + 100 * SEC, other),
            "no_result:inconsistent"
        );
        assert_eq!(c.get_bounty(id).unwrap().definite_look, None);
        assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
    });
    // A definite look requested exactly at the merge deadline opens the refund at the window's end.
    isolated(|| {
        let (mut c, id) = bound();
        assert_eq!(look(&mut c, id, DEADLINE * SEC, open_pull()), "pending");
        assert_cannot_settle(&mut c, id, VERIFY_UNTIL - 1);
        settle_at(&mut c, id, VERIFY_UNTIL);
        let b = c.get_bounty(id).unwrap();
        assert_eq!(b.status, Status::Refunded);
        assert_eq!(b.refund.unwrap().vault, b.maintainer_vault);
        assert_eq!(
            b.binding.unwrap().wallet,
            wallet(),
            "the binding stays on record"
        );
        assert_accounting(&c);
        assert_cannot_settle(&mut c, id, VERIFY_UNTIL + SEC);
    });
    // So does a later one, requested just before the window ended.
    isolated(|| {
        let (mut c, id) = bound();
        let facts = pull("closed", None);
        assert_eq!(look(&mut c, id, VERIFY_UNTIL - 20 * SEC, facts), "pending");
        settle_at(&mut c, id, VERIFY_UNTIL);
        assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
    });
}

#[test]
fn a_bound_bounty_with_no_definite_look_is_refunded_after_the_cap_so_an_on_time_merge_can_go_unpaid(
) {
    let (mut c, id) = bound();
    // The pull request may have been merged on time, but every look at it failed.
    let failing = [
        Reason::Timeout,
        Reason::UpstreamUnavailable,
        Reason::RateLimited,
    ];
    for (k, reason) in failing.into_iter().enumerate() {
        let at = DEADLINE * SEC + (k as u64) * 100 * SEC;
        let out = check_with(&mut c, id, &stranger(), RUN_DEPOSIT, at, Err(reason));
        assert_eq!(out, no_result_text(reason));
    }
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.definite_look, b.merge, b.payout), (None, None, None));
    // The grace is over: looks are still accepted, and they keep failing until the cutoff.
    for at in [VERIFY_UNTIL, AFTER_GRACE] {
        let out = check_with(
            &mut c,
            id,
            &stranger(),
            RUN_DEPOSIT,
            at,
            Err(Reason::Unreachable),
        );
        assert_eq!(out, "no_result:unreachable");
    }
    assert_cannot_settle(&mut c, id, VERIFY_UNTIL + SEC);
    assert_cannot_settle(&mut c, id, REFUND_CAP_AT - 1);
    // At the cutoff checks are refused and the refund opens: the on-time merge goes unpaid.
    act(stranger(), RUN_DEPOSIT, REFUND_CAP_AT);
    assert_refused(
        &mut c,
        "merge checks ended at the hard refund cutoff",
        |c| c.check_merge(id),
    );
    settle_at(&mut c, id, REFUND_CAP_AT);
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.payout), (Status::Refunded, None));
    assert_eq!(b.refund.unwrap().vault, b.maintainer_vault);
    assert_accounting(&c);
}

#[test]
fn a_live_check_blocks_a_bound_refund_until_it_goes_stale_and_its_late_result_cannot_pay() {
    let (mut c, id) = bound();
    assert_eq!(look(&mut c, id, DEADLINE * SEC, open_pull()), "pending");
    let requested = VERIFY_UNTIL - SEC;
    let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, requested);
    assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
    assert_cannot_settle(&mut c, id, requested + RUN_TIMEOUT_NANOS);
    settle_at(&mut c, id, requested + RUN_TIMEOUT_NANOS + 1);
    assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
    // A late answer that says "merged on time" arrives: the refund stands.
    let facts = pull("closed", Some(DEADLINE - 1));
    let late = render_with(&merge_request(id, seq, PR), Ok(VAnswer::Pull(facts)));
    let at = requested + RUN_TIMEOUT_NANOS + 5 * SEC;
    assert_eq!(on_check_with(&mut c, id, seq, at, late), "ignored:not_live");
    let b = c.get_bounty(id).unwrap();
    assert_eq!(
        (b.status, b.payout, b.merge),
        (Status::Refunded, None, None)
    );
    assert_accounting(&c);
}

#[test]
fn an_ineligible_bounty_is_refunded_immediately_and_only_once() {
    let outcomes: Vec<(&'static str, fn(&mut VPull))> = vec![
        ("ineligible:base_ref", |p| {
            p.base_ref = "dev".into();
            p.merged_at = Some(DEADLINE - 10);
            p.merged = true;
            p.state = "closed".into();
        }),
        ("ineligible:merged_after_deadline", |p| {
            p.merged_at = Some(DEADLINE);
            p.merged = true;
            p.state = "closed".into();
        }),
    ];
    for (expected, edit) in outcomes {
        isolated(move || {
            let (mut c, id) = bound();
            let mut facts = open_pull();
            edit(&mut facts);
            assert_eq!(look(&mut c, id, T_CHECK, facts), expected);
            assert_eq!(c.get_bounty(id).unwrap().status, Status::Ineligible);
            assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(1));
            assert_accounting(&c);
            let now = T_CHECK + 11 * SEC;
            settle_at(&mut c, id, now);
            let b = c.get_bounty(id).unwrap();
            assert_eq!((b.status, b.payout.clone()), (Status::Refunded, None));
            assert_eq!(b.refund.unwrap().principal.0, REWARD);
            assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(0));
            assert_accounting(&c);
            assert_cannot_settle(&mut c, id, now + SEC);
            act(buyer(), zero(), now + SEC);
            assert_refused(
                &mut c,
                "only a bounty with no claim can be cancelled",
                |c| c.cancel(id),
            );
        });
    }
}

#[test]
fn a_paid_bounty_is_never_refunded_cancelled_or_ended() {
    let (mut c, id) = paid();
    let times = [
        T_CHECK + 20 * SEC,
        VERIFY_UNTIL,
        REFUND_CAP_AT,
        REFUND_CAP_AT + 1_000 * SEC,
    ];
    for at in times {
        assert_cannot_settle(&mut c, id, at);
        act(buyer(), zero(), at);
        assert_refused(
            &mut c,
            "only a bounty with no claim can be cancelled",
            |c| c.cancel(id),
        );
        for how in ENDS {
            // Before its end time an expiry is refused for that reason; every other call, and
            // an expiry after it, finds no claim to end.
            let early_expiry = matches!(how, End::Expire) && at < CLAIM_ENDS * SEC;
            let needle = if early_expiry {
                "the claim has not ended yet"
            } else {
                "no claim to end"
            };
            act(how.actor(), zero(), at);
            assert_refused(&mut c, needle, |c| how.call(c, id));
        }
    }
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.refund), (Status::Paid, None));
    assert_accounting(&c);
}

// ---- 7. Settlement and recovery for payouts and refunds ----

const KINDS: [SettlementKind; 2] = [SettlementKind::Payout, SettlementKind::Refund];

/// A bounty whose settlement of this kind was sent once (attempt 1, in flight) at the returned
/// time. The payout is the contributor's, the refund the maintainer's.
fn in_flight_of(kind: SettlementKind) -> (PrBounty, BountyId, u64) {
    match kind {
        SettlementKind::Payout => payout_in_flight(),
        SettlementKind::Refund => refund_in_flight(),
    }
}

fn settlement_of(c: &PrBounty, id: BountyId, kind: SettlementKind) -> Settlement {
    c.get_settlement(id, kind).expect("the settlement exists")
}

/// The key and vault the bounty pinned for this kind.
fn pinned(c: &PrBounty, id: BountyId, kind: SettlementKind) -> (PublicKey, AccountId) {
    let b = c.get_bounty(id).unwrap();
    match kind {
        SettlementKind::Payout => {
            let claim = b.claim.expect("a paid bounty has a claim");
            (claim.key, claim.vault)
        }
        SettlementKind::Refund => (b.maintainer_key, b.maintainer_vault),
    }
}

fn other(kind: SettlementKind) -> SettlementKind {
    match kind {
        SettlementKind::Payout => SettlementKind::Refund,
        SettlementKind::Refund => SettlementKind::Payout,
    }
}

fn held_and_in_flight(c: &PrBounty) -> (u128, u128) {
    let cfg = c.get_config();
    (cfg.held.0, cfg.in_flight.0)
}

/// One deposit call as the vault reads it: bounty, kind byte, attempt and amount.
#[derive(Debug, PartialEq)]
struct Sent {
    vault: String,
    attached: u128,
    bounty: u64,
    kind: u8,
    attempt: u32,
    amount: u128,
}

fn sent_deposits() -> Vec<Sent> {
    deposits()
        .into_iter()
        .map(|(vault, attached, args)| {
            assert_eq!(
                args.len(),
                29,
                "bounty u64, kind u8, attempt u32, amount u128"
            );
            Sent {
                vault,
                attached,
                bounty: u64::from_le_bytes(args[0..8].try_into().unwrap()),
                kind: args[8],
                attempt: u32::from_le_bytes(args[9..13].try_into().unwrap()),
                amount: u128::from_le_bytes(args[13..29].try_into().unwrap()),
            }
        })
        .collect()
}

/// The `seal` calls in the created receipts: (vault, attached, args).
fn seal_calls() -> Vec<(String, u128, Vec<u8>)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } if method_name == b"seal" => {
                    Some((to.clone(), attached_deposit.as_yoctonear(), args))
                }
                _ => None,
            })
        })
        .collect()
}

#[test]
fn a_payout_and_a_refund_are_each_sent_once_into_the_vault_of_the_pinned_key() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, sent_at) = in_flight_of(kind);
            let (key, vault) = pinned(&c, id, kind);
            assert_eq!(
                c.vault_of(key.clone()),
                vault,
                "the vault derives from the pinned key"
            );
            assert_eq!(
                settlement_of(&c, id, kind),
                Settlement {
                    kind,
                    key,
                    vault: vault.clone(),
                    principal: U128(REWARD),
                    state: SettlementState::InFlight,
                    attempt: 1,
                    sent_at: U64(sent_at),
                    outcome: AttemptOutcome::Unknown,
                    reconcile: None,
                    done_by: None,
                }
            );
            let b = c.get_bounty(id).unwrap();
            assert_eq!(
                b.settlement(other(kind)).cloned(),
                None,
                "only one kind exists"
            );
            assert_eq!(
                sent_deposits(),
                vec![Sent {
                    vault: vault.to_string(),
                    attached: REWARD + DEPOSIT_FEE.as_yoctonear(),
                    bounty: id,
                    kind: kind.byte(),
                    attempt: 1,
                    amount: REWARD,
                }]
            );
            assert_eq!(transfers_to_accounts(), 0);
            assert_eq!(held_and_in_flight(&c), (REWARD, REWARD));
            assert_accounting(&c);
            // Sending again while the attempt is in flight is refused.
            let before = snap(&c);
            act(stranger(), zero(), sent_at + SEC);
            assert_refused(
                &mut c,
                "no settlement of this bounty could be sent now",
                |c| c.send_due(id),
            );
            assert_eq!(snap(&c), before);
        });
    }
}

#[test]
fn a_payout_goes_to_the_vault_of_the_key_chosen_at_claim_and_a_refund_to_the_maintainers() {
    let (c, id, _) = payout_in_flight();
    let b = c.get_bounty(id).unwrap();
    let contributor_key = pk(&withdrawal_sk(&wallet()));
    assert_eq!(b.claim.as_ref().unwrap().key, contributor_key);
    assert_eq!(b.maintainer_key, pk(&maint_sk()));
    let payout = settlement_of(&c, id, SettlementKind::Payout);
    assert_eq!(payout.key, contributor_key);
    assert_eq!(payout.vault, keys::vault_of(VAULT_CODE, &contributor_key));
    assert_ne!(
        payout.vault, b.maintainer_vault,
        "the two parties' vaults differ"
    );
    assert_eq!(
        b.maintainer_vault,
        keys::vault_of(VAULT_CODE, &pk(&maint_sk()))
    );
}

#[test]
fn a_success_callback_makes_a_settlement_done_once_and_duplicates_change_nothing() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, sent_at) = in_flight_of(kind);
            callback(sent_at + SEC, PromiseResult::Successful(vec![]));
            assert!(c.on_settle(id, kind, 1));
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.outcome, s.done_by.as_deref(), s.attempt),
                (
                    SettlementState::Done,
                    AttemptOutcome::Succeeded,
                    Some("callback"),
                    1
                )
            );
            assert_eq!(held_and_in_flight(&c), (0, 0), "the vault holds it now");
            assert_accounting(&c);
            // Duplicates, in any order, change nothing.
            let before = snap(&c);
            assert!(!c.on_settle(id, kind, 1));
            c.on_settle_outcome(id, kind, 1);
            callback(sent_at + 2 * SEC, PromiseResult::Failed);
            assert!(
                !c.on_settle(id, kind, 1),
                "a late failure cannot undo a deposit"
            );
            assert_eq!(snap(&c), before);
            assert_eq!(settlement_of(&c, id, kind), s);
            // Nothing is left to recover, send or reconcile.
            act(stranger(), zero(), sent_at + 3 * SEC);
            assert_refused(&mut c, "this settlement is not in flight", |c| {
                c.recover_settlement(id, kind)
            });
            assert_refused(
                &mut c,
                "no settlement of this bounty could be sent now",
                |c| c.send_due(id),
            );
            let late = sent_at + OPEN_RECONCILE_DELAY_NANOS;
            let err = try_reconcile(&mut c, id, kind, buyer(), late, 1).unwrap_err();
            assert!(err.contains("this settlement is not in flight"), "{err}");
            assert_eq!(snap(&c), before);
        });
    }
}

#[test]
fn a_failed_callback_makes_a_settlement_due_and_send_due_resends_it_as_the_next_attempt() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, mut sent_at) = in_flight_of(kind);
            let (key, vault) = pinned(&c, id, kind);
            for attempt in 1..=2u32 {
                callback(sent_at + SEC, PromiseResult::Failed);
                assert!(c.on_settle(id, kind, attempt));
                let s = settlement_of(&c, id, kind);
                assert_eq!(
                    (s.state, s.outcome, s.attempt, s.done_by.clone()),
                    (SettlementState::Due, AttemptOutcome::Failed, attempt, None)
                );
                assert_eq!(
                    held_and_in_flight(&c),
                    (REWARD, 0),
                    "reserved, not in flight"
                );
                assert_accounting(&c);
                // A duplicate of the same failure changes nothing.
                let before = snap(&c);
                assert!(!c.on_settle(id, kind, attempt));
                assert_eq!(snap(&c), before);
                // Anyone resends the same principal into the same vault.
                sent_at += 10 * SEC;
                act(stranger(), zero(), sent_at);
                assert_eq!(c.send_due(id), 1);
                let s = settlement_of(&c, id, kind);
                assert_eq!(
                    (
                        s.state,
                        s.attempt,
                        s.principal.0,
                        s.vault.clone(),
                        s.key.clone()
                    ),
                    (
                        SettlementState::InFlight,
                        attempt + 1,
                        REWARD,
                        vault.clone(),
                        key.clone()
                    )
                );
                assert_eq!(s.sent_at.0, sent_at);
                assert_eq!(
                    sent_deposits(),
                    vec![Sent {
                        vault: vault.to_string(),
                        attached: REWARD + DEPOSIT_FEE.as_yoctonear(),
                        bounty: id,
                        kind: kind.byte(),
                        attempt: attempt + 1,
                        amount: REWARD,
                    }]
                );
                assert_eq!(held_and_in_flight(&c), (REWARD, REWARD));
                assert_accounting(&c);
                // The old attempt's callback is now stale.
                let before = snap(&c);
                callback(sent_at + SEC / 2, PromiseResult::Successful(vec![]));
                assert!(!c.on_settle(id, kind, attempt), "attempt {attempt} is over");
                assert_eq!(snap(&c), before);
            }
            callback(sent_at + SEC, PromiseResult::Successful(vec![]));
            assert!(c.on_settle(id, kind, 3));
            assert_eq!(settlement_of(&c, id, kind).state, SettlementState::Done);
            assert_eq!(held_and_in_flight(&c), (0, 0));
            assert_accounting(&c);
        });
    }
}

#[test]
fn lost_callbacks_leave_a_settlement_in_flight_with_an_unknown_outcome_and_recovery_refuses() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, sent_at) = in_flight_of(kind);
            let before = snap(&c);
            let times = [
                sent_at + SEC,
                sent_at + OPEN_RECONCILE_DELAY_NANOS,
                REFUND_CAP_AT + 1_000 * SEC,
            ];
            for at in times {
                act(stranger(), zero(), at);
                assert_refused(
                    &mut c,
                    "no outcome is recorded for this attempt; reconcile instead",
                    |c| c.recover_settlement(id, kind),
                );
                assert_refused(
                    &mut c,
                    "no settlement of this bounty could be sent now",
                    |c| c.send_due(id),
                );
            }
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.outcome, s.done_by),
                (SettlementState::InFlight, AttemptOutcome::Unknown, None)
            );
            assert_eq!(held_and_in_flight(&c), (REWARD, REWARD));
            assert_eq!(snap(&c), before);
            assert_refused(&mut c, "no such settlement", |c| {
                c.recover_settlement(id, other(kind))
            });
            assert_refused(&mut c, "no such bounty", |c| {
                c.recover_settlement(id + 7, kind)
            });
        });
    }
}

#[test]
fn a_recorded_outcome_finishes_the_attempt_without_sending_anything() {
    for kind in KINDS {
        // A recorded success is the vault's deposit: done, released once.
        isolated(move || {
            let (mut c, id, sent_at) = in_flight_of(kind);
            callback(sent_at + SEC, PromiseResult::Successful(vec![]));
            c.on_settle_outcome(id, kind, 1);
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.outcome),
                (SettlementState::InFlight, AttemptOutcome::Succeeded)
            );
            assert_eq!(
                held_and_in_flight(&c),
                (REWARD, REWARD),
                "recorded is not yet finished"
            );
            act(stranger(), zero(), sent_at + 2 * SEC);
            assert!(c.recover_settlement(id, kind));
            assert!(get_created_receipts().is_empty(), "recovery sends nothing");
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.done_by.as_deref()),
                (SettlementState::Done, Some("recorded_outcome"))
            );
            assert_eq!(held_and_in_flight(&c), (0, 0));
            assert_accounting(&c);
            assert_refused(&mut c, "this settlement is not in flight", |c| {
                c.recover_settlement(id, kind)
            });
        });
        // A recorded failure makes it due again, still reserved, and sends nothing.
        isolated(move || {
            let (mut c, id, sent_at) = in_flight_of(kind);
            callback(sent_at + SEC, PromiseResult::Failed);
            c.on_settle_outcome(id, kind, 1);
            // The outcome is written once: a later success cannot overwrite it, and an outcome
            // for another attempt is ignored.
            callback(sent_at + 2 * SEC, PromiseResult::Successful(vec![]));
            c.on_settle_outcome(id, kind, 1);
            c.on_settle_outcome(id, kind, 2);
            assert_eq!(settlement_of(&c, id, kind).outcome, AttemptOutcome::Failed);
            act(stranger(), zero(), sent_at + 3 * SEC);
            assert!(c.recover_settlement(id, kind));
            assert!(get_created_receipts().is_empty());
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.attempt, s.done_by),
                (SettlementState::Due, 1, None)
            );
            assert_eq!(held_and_in_flight(&c), (REWARD, 0));
            assert_accounting(&c);
        });
    }
}

/// The accounts that count as a party to a settlement of this kind, and some that do not.
fn parties_and_outsiders(kind: SettlementKind) -> (Vec<AccountId>, Vec<AccountId>) {
    match kind {
        SettlementKind::Payout => (vec![buyer(), wallet()], vec![stranger(), wallet2()]),
        SettlementKind::Refund => (vec![buyer()], vec![wallet(), stranger()]),
    }
}

#[test]
fn a_party_reconciles_after_the_party_delay_and_anyone_after_the_open_delay() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, sent) = in_flight_of(kind);
            let (parties, outsiders) = parties_and_outsiders(kind);
            let party = sent + PARTY_RECONCILE_DELAY_NANOS;
            let open = sent + OPEN_RECONCILE_DELAY_NANOS;
            assert!(party < open);
            let before = snap(&c);
            let too_early = |r: Result<(), String>| {
                let err = r.unwrap_err();
                assert!(err.contains("too early to reconcile this attempt"), "{err}");
            };
            for who in &parties {
                too_early(try_reconcile(&mut c, id, kind, who.clone(), party - 1, 1));
            }
            for who in &outsiders {
                too_early(try_reconcile(&mut c, id, kind, who.clone(), party, 1));
                too_early(try_reconcile(&mut c, id, kind, who.clone(), open - 1, 1));
            }
            let first = parties[0].clone();
            let err = try_reconcile(&mut c, id, kind, first.clone(), party, 2).unwrap_err();
            assert!(
                err.contains("only the current attempt can be reconciled"),
                "{err}"
            );
            let err = try_reconcile(&mut c, id, other(kind), first.clone(), party, 1).unwrap_err();
            assert!(err.contains("no such settlement"), "{err}");
            act(first.clone(), NearToken::from_millinear(9), party);
            assert_refused(&mut c, "attach exactly 0.01 NEAR", |c| {
                c.reconcile(id, kind, 1)
            });
            act_with_gas(first.clone(), RECONCILE_DEPOSIT, party, Gas::from_tgas(39));
            assert_refused(&mut c, "attach at least 40 Tgas", |c| {
                c.reconcile(id, kind, 1)
            });
            assert_eq!(
                snap(&c),
                before,
                "every refusal left the settlement as it was"
            );
            assert_eq!(settlement_of(&c, id, kind).reconcile, None);
            // The first party at the party delay: the vault is asked to seal this very attempt.
            try_reconcile(&mut c, id, kind, first.clone(), party, 1).unwrap();
            let (_, vault) = pinned(&c, id, kind);
            let seals = seal_calls();
            assert_eq!(seals.len(), 1);
            assert_eq!(seals[0].0, vault.to_string());
            assert_eq!(seals[0].1, RECONCILE_DEPOSIT.as_yoctonear());
            assert_eq!(seals[0].2, slot_args(id, kind, 1));
            assert_eq!(
                settlement_of(&c, id, kind).reconcile,
                Some(ReconcileMarker {
                    attempt: 1,
                    started_at: U64(party)
                })
            );
            // The marker blocks an overlapping reconcile until it expires.
            let marker_end = party + RECONCILE_MARKER_TTL_NANOS;
            let err = try_reconcile(&mut c, id, kind, first, marker_end - 1, 1).unwrap_err();
            assert!(
                err.contains("a reconciliation of this settlement is in progress"),
                "{err}"
            );
            let anyone = outsiders[0].clone();
            try_reconcile(&mut c, id, kind, anyone, open.max(marker_end), 1).unwrap();
            assert_eq!(settlement_of(&c, id, kind).state, SettlementState::InFlight);
        });
    }
}

/// Reconciles attempt `attempt` as the maintainer at `at`, then delivers the vault's `answer`.
fn reconcile_answer(
    c: &mut PrBounty,
    id: BountyId,
    kind: SettlementKind,
    attempt: u32,
    at: u64,
    answer: PromiseResult,
) -> String {
    try_reconcile(c, id, kind, buyer(), at, attempt).expect("the reconcile starts");
    callback(at + SEC, answer);
    c.on_reconcile(id, kind, attempt, U64(at))
}

#[test]
fn a_reconcile_that_finds_the_deposit_makes_the_settlement_done_exactly_once() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, sent) = in_flight_of(kind);
            let at = sent + PARTY_RECONCILE_DELAY_NANOS;
            let out = reconcile_answer(&mut c, id, kind, 1, at, slot(true, 1, REWARD, 0));
            assert_eq!(out, "deposited");
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.outcome, s.done_by.as_deref(), s.reconcile),
                (
                    SettlementState::Done,
                    AttemptOutcome::Succeeded,
                    Some("reconcile"),
                    None
                )
            );
            assert_eq!(held_and_in_flight(&c), (0, 0));
            assert_accounting(&c);
            // The same answer again, or a late callback, releases nothing more.
            let before = snap(&c);
            callback(at + 2 * SEC, slot(true, 1, REWARD, 0));
            assert_eq!(
                c.on_reconcile(id, kind, 1, U64(at)),
                "ignored:not_in_flight"
            );
            callback(at + 3 * SEC, PromiseResult::Successful(vec![]));
            assert!(!c.on_settle(id, kind, 1));
            assert_eq!(snap(&c), before);
        });
    }
}

#[test]
fn a_reconcile_that_finds_the_attempt_sealed_without_a_deposit_makes_it_due_and_it_is_resent() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, sent) = in_flight_of(kind);
            let (key, vault) = pinned(&c, id, kind);
            let at = sent + PARTY_RECONCILE_DELAY_NANOS;
            let out = reconcile_answer(&mut c, id, kind, 1, at, slot(false, 0, 0, 1));
            assert_eq!(out, "sealed_without_deposit");
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.outcome, s.reconcile, s.done_by),
                (SettlementState::Due, AttemptOutcome::Failed, None, None)
            );
            assert_eq!(
                held_and_in_flight(&c),
                (REWARD, 0),
                "the principal is still owed"
            );
            assert_accounting(&c);
            // Resend: attempt 2, same principal, same vault; the clocks start again.
            let resent = at + 10 * SEC;
            act(stranger(), zero(), resent);
            assert_eq!(c.send_due(id), 1);
            let s = settlement_of(&c, id, kind);
            assert_eq!(
                (s.state, s.attempt, s.principal.0, s.key, s.vault.clone()),
                (SettlementState::InFlight, 2, REWARD, key, vault)
            );
            assert_eq!(s.sent_at.0, resent);
            let soon = resent + PARTY_RECONCILE_DELAY_NANOS - 1;
            let early = try_reconcile(&mut c, id, kind, buyer(), soon, 2);
            assert!(early.unwrap_err().contains("too early"));
            let due = resent + PARTY_RECONCILE_DELAY_NANOS;
            let old = try_reconcile(&mut c, id, kind, buyer(), due, 1);
            assert!(old.unwrap_err().contains("only the current attempt"));
            // An answer about attempt 1 that arrives now is stale.
            let before = snap(&c);
            callback(resent + SEC, slot(false, 0, 0, 1));
            assert_eq!(
                c.on_reconcile(id, kind, 1, U64(at)),
                "ignored:not_in_flight"
            );
            assert_eq!(snap(&c), before);
        });
    }
}

#[test]
fn every_other_reconcile_answer_leaves_the_attempt_in_flight() {
    for kind in KINDS {
        isolated(move || {
            let (mut c, id, sent) = in_flight_of(kind);
            let cases = [
                (PromiseResult::Failed, "ignored:seal_failed"),
                (
                    PromiseResult::Successful(vec![1, 2, 3]),
                    "ignored:malformed",
                ),
                (PromiseResult::Successful(vec![]), "ignored:malformed"),
                (slot(true, 1, REWARD - 1, 0), "ignored:other_deposit"),
                (slot(true, 1, REWARD + 1, 0), "ignored:other_deposit"),
                (slot(true, 2, REWARD, 0), "ignored:other_deposit"),
                (slot(false, 0, 0, 0), "ignored:not_sealed"),
            ];
            for (k, (answer, expected)) in cases.into_iter().enumerate() {
                let step = (k as u64) * RECONCILE_MARKER_TTL_NANOS;
                let at = sent + PARTY_RECONCILE_DELAY_NANOS + step;
                assert_eq!(reconcile_answer(&mut c, id, kind, 1, at, answer), expected);
                let s = settlement_of(&c, id, kind);
                assert_eq!(
                    (s.state, s.outcome, s.attempt, s.done_by.clone()),
                    (SettlementState::InFlight, AttemptOutcome::Unknown, 1, None),
                    "{expected}"
                );
                assert_eq!(
                    s.reconcile, None,
                    "the matching marker is cleared: {expected}"
                );
                assert_eq!(held_and_in_flight(&c), (REWARD, REWARD), "{expected}");
                assert_accounting(&c);
            }
            // An answer for a settlement or bounty that does not exist is ignored.
            callback(sent + OPEN_RECONCILE_DELAY_NANOS, slot(true, 1, REWARD, 0));
            let missing = c.on_reconcile(id, other(kind), 1, U64(0));
            assert_eq!(missing, "ignored:no_settlement");
            assert_eq!(
                c.on_reconcile(id + 5, kind, 1, U64(0)),
                "ignored:no_settlement"
            );
            assert_eq!(held_and_in_flight(&c), (REWARD, REWARD));
        });
    }
}

#[test]
fn an_unknown_payout_is_never_counted_paid_and_never_turned_into_a_refund() {
    let (mut c, id, sent) = payout_in_flight();
    let is_unknown = |c: &PrBounty| {
        let b = c.get_bounty(id).unwrap();
        let p = b.payout.clone().unwrap();
        assert_eq!(
            (b.status, p.state, p.outcome, p.done_by, b.refund.clone()),
            (
                Status::Paid,
                SettlementState::InFlight,
                AttemptOutcome::Unknown,
                None,
                None
            )
        );
        assert_eq!(
            held_and_in_flight(c),
            (REWARD, REWARD),
            "still held, still in flight"
        );
    };
    is_unknown(&c);
    // Neither time nor any caller can turn it into a refund or end the claim.
    for at in [
        sent + SEC,
        VERIFY_UNTIL,
        REFUND_CAP_AT,
        REFUND_CAP_AT + 1_000 * SEC,
    ] {
        assert_cannot_settle(&mut c, id, at);
        act(buyer(), zero(), at);
        assert_refused(
            &mut c,
            "only a bounty with no claim can be cancelled",
            |c| c.cancel(id),
        );
        act(stranger(), RUN_DEPOSIT, at);
        assert_refused(&mut c, "no submitted pull request to check", |c| {
            c.check_merge(id)
        });
        act(buyer(), zero(), at);
        assert_refused(&mut c, "no claim to end", |c| c.revoke_claim(id));
        is_unknown(&c);
    }
    // A reconcile that cannot tell leaves it unknown.
    let at = sent + PARTY_RECONCILE_DELAY_NANOS;
    let answer = slot(false, 0, 0, 0);
    let out = reconcile_answer(&mut c, id, SettlementKind::Payout, 1, at, answer);
    assert_eq!(out, "ignored:not_sealed");
    is_unknown(&c);
    // A failed attempt makes the payout due again. It is still the payout, and still no refund.
    callback(at + 10 * SEC, PromiseResult::Failed);
    assert!(c.on_settle(id, SettlementKind::Payout, 1));
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.refund.clone()), (Status::Paid, None));
    assert_eq!(b.payout.unwrap().state, SettlementState::Due);
    assert_eq!(held_and_in_flight(&c), (REWARD, 0));
    assert_cannot_settle(&mut c, id, REFUND_CAP_AT + 1_000 * SEC);
    assert_accounting(&c);
}

#[test]
fn held_and_in_flight_follow_a_payout_from_the_look_to_the_vault_receipt() {
    let (mut c, id) = bound();
    assert_eq!(held_and_in_flight(&c), (REWARD, 0));
    let facts = pull("closed", Some(DEADLINE - 1));
    assert_eq!(look(&mut c, id, T_CHECK, facts), "paid");
    assert_eq!(held_and_in_flight(&c), (REWARD, 0), "owed, not sent");
    assert_accounting(&c);
    act(this(), zero(), T_CHECK + 20 * SEC);
    assert_eq!(c.send_due_after_check(id), 1);
    assert_eq!(held_and_in_flight(&c), (REWARD, REWARD));
    assert_accounting(&c);
    callback(T_CHECK + 21 * SEC, PromiseResult::Successful(vec![]));
    assert!(c.on_settle(id, SettlementKind::Payout, 1));
    assert_eq!(held_and_in_flight(&c), (0, 0));
    assert_accounting(&c);
}

#[test]
fn a_due_settlement_waits_when_the_balance_or_the_gas_cannot_pay_the_fee_and_is_sent_when_they_can()
{
    let (mut c, id) = paid();
    let at = T_CHECK + 20 * SEC;
    let fee = DEPOSIT_FEE.as_yoctonear() + VAULT_INIT_DEPOSIT.as_yoctonear();
    let call_as = |who: AccountId, balance: u128, gas: Gas| {
        let mut builder = context(who, zero(), at);
        builder
            .account_balance(NearToken::from_yoctonear(balance))
            .prepaid_gas(gas);
        testing_env!(builder.build());
    };
    call_as(stranger(), 0, Gas::from_tgas(300));
    // What the contract keeps back: storage, principals still inside it, and the sponsor float.
    let need = c.storage_cost() + (c.held - c.in_flight) + c.sponsor_float;
    let before = snap(&c);
    let waiting = |reason: &str| {
        get_logs()
            .iter()
            .any(|l| l.contains("settlement_waiting") && l.contains(&format!("reason={reason}")))
    };
    let nothing = "no settlement of this bounty could be sent now";
    call_as(stranger(), need + fee - 1, Gas::from_tgas(300));
    assert_refused(&mut c, nothing, |c| c.send_due(id));
    assert!(waiting("balance"));
    call_as(
        stranger(),
        need + fee,
        Gas::from_gas(GAS_PER_SEND.as_gas() - 1),
    );
    assert_refused(&mut c, nothing, |c| c.send_due(id));
    assert!(waiting("gas"));
    // The detached send after a check never fails; the settlement just stays due.
    call_as(this(), need + fee - 1, Gas::from_tgas(300));
    assert_eq!(c.send_due_after_check(id), 0);
    assert_eq!(snap(&c), before);
    let s = settlement_of(&c, id, SettlementKind::Payout);
    assert_eq!((s.state, s.attempt), (SettlementState::Due, 0));
    // With the fee covered and enough gas it goes out.
    call_as(stranger(), need + fee, Gas::from_tgas(300));
    assert_eq!(c.send_due(id), 1);
    assert_eq!(settlement_of(&c, id, SettlementKind::Payout).attempt, 1);
    assert_accounting(&c);
}

// ---- 8. Caps, allowlist, pause, repository, branch, times, claim time and grace ----

/// Applies `edit` to the terms of a valid posting, re-signs it for the new terms and expects
/// exactly this refusal with no state change.
fn assert_terms_refused(needle: &'static str, edit: impl FnOnce(&mut PostTerms) + Send + 'static) {
    assert_posting_refused(needle, move |p| {
        edit(&mut p.terms);
        p.deposit = p.terms.reward.0 + storage();
        let actor = p.who.clone();
        p.signed(&maint_sk(), &actor, POST_EXPIRES);
    });
}

/// The same edit must be accepted, and the bounty records the terms as given.
fn assert_terms_accepted(edit: impl FnOnce(&mut PostTerms) + Send + 'static) {
    isolated(move || {
        let mut c = contract();
        let mut posting = Posting::valid();
        edit(&mut posting.terms);
        posting.deposit = posting.terms.reward.0 + storage();
        let actor = posting.who.clone();
        posting.signed(&maint_sk(), &actor, POST_EXPIRES);
        let t = posting.terms.clone();
        let id = posting.call(&mut c, START);
        let b = c.get_bounty(id).unwrap();
        assert_eq!(
            (
                b.reward,
                b.base_ref.clone(),
                b.claim_by,
                b.claim_secs,
                b.merge_deadline,
                b.grace_secs
            ),
            (
                t.reward,
                t.base_ref,
                t.claim_by,
                t.claim_secs,
                t.merge_deadline,
                t.grace_secs
            )
        );
        assert_eq!(b.status, Status::Open);
        assert_accounting(&c);
    });
}

#[test]
fn only_an_approved_poster_can_post_and_a_removed_poster_cannot() {
    assert_posting_refused("only an approved maintainer can post", |p| {
        p.who = stranger();
        p.signed(&maint_sk(), &stranger(), POST_EXPIRES);
    });
    isolated(|| {
        let mut c = contract();
        assert!(c.is_poster(buyer()) && !c.is_poster(stranger()));
        act(owner(), zero(), START);
        c.add_poster(stranger());
        assert!(c.is_poster(stranger()));
        let mut posting = Posting::valid();
        posting.who = stranger();
        posting.signed(&maint_sk(), &stranger(), POST_EXPIRES);
        assert_eq!(posting.call(&mut c, START), 0);
        act(owner(), zero(), START);
        c.remove_poster(buyer());
        assert!(!c.is_poster(buyer()));
        let msg = refusal(&mut c, |c| Posting::valid().call(c, START));
        assert!(
            msg.contains("only an approved maintainer can post"),
            "{msg}"
        );
        assert_eq!(c.get_config().bounty_count, 1);
    });
}

#[test]
fn only_the_owner_can_change_posters_the_pause_the_caps_and_the_sponsor_limits() {
    let mut c = contract();
    let state = |c: &PrBounty| {
        (
            snap(c),
            c.is_poster(stranger()),
            c.is_poster(buyer()),
            c.get_config().max_reward.0,
        )
    };
    let before = state(&c);
    for who in [buyer(), stranger(), sponsor(), wallet()] {
        act(who, zero(), START);
        assert_refused(&mut c, "only the owner", |c| c.add_poster(stranger()));
        assert_refused(&mut c, "only the owner", |c| c.remove_poster(buyer()));
        assert_refused(&mut c, "only the owner", |c| c.set_paused(true));
        assert_refused(&mut c, "only the owner", |c| {
            c.set_caps(U128(REWARD), U128(2 * REWARD), 1)
        });
        assert_refused(&mut c, "only the owner", |c| {
            c.set_sponsor_limits(U128(1), U128(1))
        });
    }
    assert_eq!(before, state(&c));
    assert!(!c.get_config().paused);
}

#[test]
fn a_paused_contract_refuses_new_bounties_before_the_nonce_is_used_and_everything_else_still_runs()
{
    let (mut c, id) = bound();
    let open = post(&mut c);
    act(owner(), zero(), T_CHECK);
    c.set_paused(true);
    assert!(c.get_config().paused);
    let posting = Posting::valid();
    let nonce = posting.proof.nonce.clone();
    let before = posting_state(&c, &nonce);
    assert_refused(&mut c, "new bounties are paused", |c| {
        posting.clone().call(c, T_CHECK)
    });
    assert_eq!(posting_state(&c, &nonce), before);
    assert!(
        !nonce_used(&c, &nonce),
        "a refused posting does not use its nonce"
    );
    // Links, merge looks, payouts and refunds all still work.
    let linked_at = T_LINK + 2_000 * SEC;
    assert_eq!(
        link_wallet(&mut c, &wallet2(), &gist_n(2), OTHER_GH, linked_at),
        "linked"
    );
    let facts = pull("closed", Some(DEADLINE - 1));
    assert_eq!(look(&mut c, id, T_CHECK + 100 * SEC, facts), "paid");
    settle_at(&mut c, open, CLAIM_BY * SEC);
    assert_eq!(c.get_bounty(open).unwrap().status, Status::Refunded);
    assert_accounting(&c);
    // Unpausing accepts the very same posting, nonce and proof.
    act(owner(), zero(), CLAIM_BY * SEC);
    c.set_paused(false);
    assert!(!c.get_config().paused);
    let again = posting.call(&mut c, START);
    assert_eq!(c.get_bounty(again).unwrap().posting_nonce, nonce);
}

#[test]
fn the_reward_must_be_positive_and_no_more_than_the_reward_cap() {
    assert_terms_refused("reward is over the cap", |t| t.reward = U128(0));
    assert_terms_refused("reward is over the cap", |t| {
        t.reward = U128(2 * REWARD + 1)
    });
    assert_terms_accepted(|t| t.reward = U128(2 * REWARD));
    assert_terms_accepted(|t| t.reward = U128(1));
}

/// A posting of `reward` with a fresh nonce that must be refused; returns the refusal text.
fn refused_posting_of(c: &mut PrBounty, reward: u128, nonce: &str) -> String {
    let mut t = terms();
    t.reward = U128(reward);
    let key = pk(&maint_sk());
    act(buyer(), deposit_for(&t), START);
    let proof = posting_proof(&t, &maint_sk(), &key, &buyer(), nonce, POST_EXPIRES);
    refusal(c, |c| c.post_bounty(t, key, proof))
}

#[test]
fn the_total_held_cap_counts_every_reward_until_a_vault_confirms_it() {
    let mut c = contract();
    let cap = c.get_config().max_held.0;
    assert_eq!(cap, 5 * REWARD);
    let first = post_terms(&mut c, |t| t.reward = U128(2 * REWARD));
    post_terms(&mut c, |t| t.reward = U128(2 * REWARD));
    assert_eq!(c.get_config().held.0, 4 * REWARD);
    let before = snap(&c);
    let msg = refused_posting_of(&mut c, REWARD + 1, &hash_hex(90));
    assert!(msg.contains("the contract's total cap is reached"), "{msg}");
    assert_eq!(snap(&c), before);
    // Exactly the cap is accepted.
    post_terms(&mut c, |t| t.reward = U128(REWARD));
    assert_eq!(c.get_config().held.0, cap);
    // A cancel frees the open slot but not the money: the refund is not in a vault yet.
    act(buyer(), zero(), START + SEC);
    c.cancel(first);
    assert_eq!(c.get_config().held.0, cap);
    let msg = refused_posting_of(&mut c, 1, &hash_hex(91));
    assert!(msg.contains("the contract's total cap is reached"), "{msg}");
    // The vault receipt releases it.
    callback(START + 2 * SEC, PromiseResult::Successful(vec![]));
    assert!(c.on_settle(first, SettlementKind::Refund, 1));
    assert_eq!(c.get_config().held.0, cap - 2 * REWARD);
    post_terms(&mut c, |t| t.reward = U128(2 * REWARD));
    assert_accounting(&c);
}

#[test]
fn a_maintainer_can_have_only_the_capped_number_of_open_bounties_and_a_finished_one_frees_a_slot() {
    let mut c = contract();
    let cap = c.get_config().max_open_per_buyer;
    assert_eq!(cap, 3);
    let ids: Vec<BountyId> = (0..cap).map(|_| post(&mut c)).collect();
    let before = snap(&c);
    let msg = refused_posting_of(&mut c, REWARD, &hash_hex(90));
    assert!(
        msg.contains("this maintainer has too many open bounties"),
        "{msg}"
    );
    assert_eq!(snap(&c), before);
    // A cancel frees one slot, and the freed slot can be used once.
    act(buyer(), zero(), START + SEC);
    c.cancel(ids[0]);
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(cap - 1));
    post_with(&mut c, terms(), &hash_hex(91));
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(cap));
    let msg = refused_posting_of(&mut c, REWARD, &hash_hex(92));
    assert!(
        msg.contains("this maintainer has too many open bounties"),
        "{msg}"
    );
    // A refund after claim_by frees another.
    settle_at(&mut c, ids[1], CLAIM_BY * SEC);
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(cap - 1));
    assert_accounting(&c);
}

#[test]
fn a_paid_bounty_frees_the_maintainers_open_slot() {
    let (mut c, id) = bound();
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(1));
    let facts = pull("closed", Some(DEADLINE - 1));
    assert_eq!(look(&mut c, id, T_CHECK, facts), "paid");
    assert_eq!(c.open_by_buyer.get(&buyer()).copied(), Some(0));
}

#[test]
fn caps_and_sponsor_limits_are_checked_against_the_hard_limits_and_each_other() {
    let mut c = contract();
    let before = snap(&c);
    let cfg = c.get_config();
    act(owner(), zero(), START);
    let hard_reward = HARD_MAX_REWARD.as_yoctonear();
    let hard_held = HARD_MAX_HELD.as_yoctonear();
    let too_many = HARD_MAX_OPEN_PER_BUYER + 1;
    let reward_msg = "max_reward must be at most 5 NEAR";
    let held_msg = "max_held must be between max_reward and 10 NEAR";
    let open_msg = "max_open_per_buyer must be 1 to 5";
    for (reward, held, open, needle) in [
        (0, REWARD, 1, reward_msg),
        (hard_reward + 1, hard_held, 1, reward_msg),
        (2 * REWARD, 2 * REWARD - 1, 1, held_msg),
        (2 * REWARD, hard_held + 1, 1, held_msg),
        (2 * REWARD, 5 * REWARD, 0, open_msg),
        (2 * REWARD, 5 * REWARD, too_many, open_msg),
    ] {
        assert_refused(&mut c, needle, |c| {
            c.set_caps(U128(reward), U128(held), open)
        });
    }
    let float = HARD_MAX_SPONSOR_FLOAT.as_yoctonear();
    let spent = HARD_MAX_SPONSOR_SPENT.as_yoctonear();
    assert_refused(&mut c, "max_sponsor_float must be at most 1 NEAR", |c| {
        c.set_sponsor_limits(U128(float + 1), U128(spent))
    });
    assert_refused(&mut c, "max_sponsor_spent must be at most 2 NEAR", |c| {
        c.set_sponsor_limits(U128(float), U128(spent + 1))
    });
    let after = c.get_config();
    assert_eq!(
        (
            after.max_reward.0,
            after.max_held.0,
            after.max_open_per_buyer
        ),
        (cfg.max_reward.0, cfg.max_held.0, cfg.max_open_per_buyer)
    );
    assert_eq!(snap(&c), before);
    // The limits themselves are allowed.
    c.set_caps(U128(hard_reward), U128(hard_held), HARD_MAX_OPEN_PER_BUYER);
    c.set_sponsor_limits(U128(float), U128(spent));
    let cfg = c.get_config();
    assert_eq!(
        (
            cfg.max_reward.0,
            cfg.max_held.0,
            cfg.max_open_per_buyer,
            cfg.max_sponsor_float.0,
            cfg.max_sponsor_spent.0
        ),
        (
            hard_reward,
            hard_held,
            HARD_MAX_OPEN_PER_BUYER,
            float,
            spent
        )
    );
}

#[test]
fn only_the_approved_repository_and_its_id_can_be_posted() {
    let approved = "this pilot only pays for its approved repository";
    assert_terms_refused(approved, |t| t.repo = "proven-test/other".into());
    assert_terms_refused(approved, |t| t.repo_id = U64(REPO_ID + 1));
    assert_terms_refused(approved, |t| t.repo = String::new());
}

#[test]
fn the_issue_number_and_the_base_branch_are_checked() {
    let branch = "base_ref must be a branch name";
    assert_terms_refused("the issue number is required", |t| t.issue = 0);
    assert_terms_accepted(|t| t.issue = u64::MAX);
    assert_terms_refused(branch, |t| t.base_ref = String::new());
    assert_terms_refused(branch, |t| t.base_ref = "a".repeat(MAX_REF_LEN + 1));
    assert_terms_refused(branch, |t| t.base_ref = "ma\nin".into());
    assert_terms_refused(branch, |t| t.base_ref = "ma\tin".into());
    assert_terms_accepted(|t| t.base_ref = "a".repeat(MAX_REF_LEN));
    assert_terms_accepted(|t| t.base_ref = "release/1.x".into());
}

#[test]
fn the_posting_times_must_put_now_before_claim_by_and_claim_by_at_or_before_the_merge_deadline() {
    let times = "times must satisfy now < claim_by <= merge_deadline";
    assert_terms_refused(times, |t| t.claim_by = U64(START_S));
    assert_terms_refused(times, |t| t.claim_by = U64(START_S - 1));
    assert_terms_refused(times, |t| t.claim_by = U64(0));
    assert_terms_refused(times, |t| t.claim_by = U64(t.merge_deadline.0 + 1));
    assert_terms_accepted(|t| t.claim_by = U64(START_S + 1));
    assert_terms_accepted(|t| t.claim_by = t.merge_deadline);
}

#[test]
fn the_merge_deadline_may_be_at_most_thirty_days_away() {
    let far = "merge_deadline is more than 30 days away";
    assert_terms_refused(far, |t| {
        t.merge_deadline = U64(START_S + MAX_DURATION_SECS + 1)
    });
    assert_terms_refused(far, |t| t.merge_deadline = U64(u64::MAX / SEC));
    assert_terms_accepted(|t| t.merge_deadline = U64(START_S + MAX_DURATION_SECS));
}

#[test]
fn the_grace_must_be_between_ten_minutes_and_a_day() {
    let grace = "grace must be 10 minutes to 1 day";
    assert_terms_refused(grace, |t| t.grace_secs = U64(MIN_GRACE_SECS - 1));
    assert_terms_refused(grace, |t| t.grace_secs = U64(0));
    assert_terms_refused(grace, |t| t.grace_secs = U64(MAX_GRACE_SECS + 1));
    assert_terms_accepted(|t| t.grace_secs = U64(MIN_GRACE_SECS));
    assert_terms_accepted(|t| t.grace_secs = U64(MAX_GRACE_SECS));
}

#[test]
fn the_claim_time_must_be_between_the_minimum_and_thirty_days() {
    let claim = "a claim must last at least the minimum and at most 30 days";
    assert_terms_refused(claim, |t| t.claim_secs = U64(MIN_CLAIM_SECS - 1));
    assert_terms_refused(claim, |t| t.claim_secs = U64(0));
    assert_terms_refused(claim, |t| t.claim_secs = U64(MAX_DURATION_SECS + 1));
    assert_terms_accepted(|t| t.claim_secs = U64(MIN_CLAIM_SECS));
    assert_terms_accepted(|t| t.claim_secs = U64(MAX_DURATION_SECS));
}

// ---- 9. The configuration view and the answer size ----

#[test]
fn get_config_reports_the_timing_constants_the_storage_deposit_and_the_fees() {
    let c = contract();
    let cfg = c.get_config();
    assert_eq!(cfg.relink_delay_secs, RELINK_DELAY_SECS);
    assert_eq!(cfg.refund_cap_secs, REFUND_CAP_SECS);
    assert_eq!(cfg.min_claim_secs, MIN_CLAIM_SECS);
    assert_eq!(cfg.storage_deposit.0, STORAGE_DEPOSIT.as_yoctonear());
    assert_eq!(cfg.run_deposit.0, RUN_DEPOSIT.as_yoctonear());
    assert_eq!(cfg.deposit_fee.0, DEPOSIT_FEE.as_yoctonear());
    assert_eq!(cfg.reconcile_deposit.0, RECONCILE_DEPOSIT.as_yoctonear());
    assert_eq!(cfg.sponsored_runs_per_bounty, SPONSORED_RUNS_PER_BOUNTY);
    assert_eq!(
        cfg.party_reconcile_delay_secs,
        PARTY_RECONCILE_DELAY_NANOS / SEC
    );
    assert_eq!(
        cfg.open_reconcile_delay_secs,
        OPEN_RECONCILE_DELAY_NANOS / SEC
    );
    assert_eq!(
        cfg.reconcile_marker_ttl_secs,
        RECONCILE_MARKER_TTL_NANOS / SEC
    );
    assert_eq!(
        (cfg.owner.clone(), cfg.outlayer.clone(), cfg.sponsor.clone()),
        (owner(), outlayer(), sponsor())
    );
    assert_eq!(
        (cfg.network.as_str(), cfg.verifier_url.as_str()),
        ("testnet", URL)
    );
    assert_eq!(cfg.verifier_hash, HASH);
    assert_eq!(
        (cfg.pilot_repo.as_str(), cfg.pilot_repo_id.0),
        (REPO, REPO_ID)
    );
    assert_eq!(cfg.vault_code_hash, Base58CryptoHash::from(VAULT_CODE));
    assert_eq!(cfg.max_reward.0, 2 * REWARD);
    assert_eq!(cfg.max_held.0, 5 * REWARD);
    assert_eq!(cfg.max_open_per_buyer, 3);
    assert_eq!(
        (cfg.held.0, cfg.in_flight.0, cfg.bounty_count, cfg.paused),
        (0, 0, 0, false)
    );
}

#[test]
fn get_config_reports_the_link_storage_deposit_and_the_storage_deposit() {
    let c = contract();
    let cfg = c.get_config();
    assert_eq!(
        cfg.link_storage_deposit.0,
        LINK_STORAGE_DEPOSIT.as_yoctonear()
    );
    assert_eq!(
        cfg.link_storage_deposit.0,
        NearToken::from_millinear(7).as_yoctonear()
    );
    assert_eq!(cfg.storage_deposit.0, STORAGE_DEPOSIT.as_yoctonear());
    assert_eq!(
        cfg.storage_deposit.0,
        NearToken::from_millinear(30).as_yoctonear()
    );
    let json = serde_json::to_value(&cfg).unwrap();
    assert_eq!(
        json["link_storage_deposit"],
        LINK_STORAGE_DEPOSIT.as_yoctonear().to_string()
    );
    assert_eq!(
        json["storage_deposit"],
        STORAGE_DEPOSIT.as_yoctonear().to_string()
    );
    assert_eq!(json["run_deposit"], RUN_DEPOSIT.as_yoctonear().to_string());
}

#[test]
fn get_config_serializes_the_new_fields_under_their_documented_names() {
    let c = contract();
    let json = serde_json::to_value(c.get_config()).unwrap();
    assert_eq!(json["relink_delay_secs"], RELINK_DELAY_SECS);
    assert_eq!(json["refund_cap_secs"], REFUND_CAP_SECS);
    assert_eq!(json["min_claim_secs"], MIN_CLAIM_SECS);
    assert_eq!(
        json["storage_deposit"],
        STORAGE_DEPOSIT.as_yoctonear().to_string()
    );
    assert_eq!(json["run_deposit"], RUN_DEPOSIT.as_yoctonear().to_string());
    assert!(json.get("budget").is_none(), "the check reserve is gone");
}

#[test]
fn the_contract_reads_exactly_as_many_answer_bytes_as_the_verifier_can_write() {
    assert_eq!(answer::MAX_OUTPUT_BYTES, verifier::MAX_ANSWER_BYTES);
}

#[test]
fn a_branch_of_255_escaped_characters_still_gets_readable_answers_at_submission_and_merge() {
    // Any branch the posting accepts (255 bytes, no control characters) must leave every answer
    // within the contract's read limit, including ones made only of characters JSON escapes.
    for ch in ['"', '\\'] {
        isolated(move || {
            let branch: String = std::iter::repeat_n(ch, 255).collect();
            let mut c = linked();
            let id = post_terms(&mut c, |t| t.base_ref = branch.clone());
            claim_at(&mut c, id, &wallet(), T_CLAIM);
            let mut open = open_pull();
            open.base_ref = branch.clone();
            let s = start_submit(&mut c, id, &wallet(), PR, T_SUBMIT);
            let answer = render_with(
                &submit_request(id, &s),
                Ok(VAnswer::PullGist(open, gist_facts(GH))),
            );
            if let PromiseResult::Successful(bytes) = &answer {
                assert!(
                    bytes.len() <= answer::MAX_OUTPUT_BYTES,
                    "{} bytes",
                    bytes.len()
                );
            }
            assert_eq!(
                on_check_with(&mut c, id, s.seq, T_SUBMIT + 10 * SEC, answer),
                "bound"
            );
            let mut merged = pull("closed", Some(DEADLINE - 1));
            merged.base_ref = branch.clone();
            assert_eq!(look(&mut c, id, T_CHECK, merged), "paid");
            assert_accounting(&c);
        });
    }
}

#[test]
fn an_oversized_verifier_answer_is_a_failed_look_not_a_negative() {
    let (mut c, id) = bound();
    let seq = start_check(&mut c, id, &stranger(), RUN_DEPOSIT, DEADLINE * SEC);
    let too_long = PromiseResult::Successful(vec![b' '; answer::MAX_OUTPUT_BYTES + 1]);
    let out = on_check_with(&mut c, id, seq, DEADLINE * SEC + 10 * SEC, too_long);
    assert_eq!(out, "no_result:oversized");
    let b = c.get_bounty(id).unwrap();
    assert_eq!((b.status, b.definite_look), (Status::Bound, None));
    assert_cannot_settle(&mut c, id, VERIFY_UNTIL);
}

#[test]
fn the_link_number_view_matches_the_number_the_challenge_names() {
    let mut c = contract();
    assert_eq!(c.get_link_number(wallet()).0, 0);
    let expires = U64(START_S + 1_800);
    let at_zero = c.link_challenge(wallet(), expires);
    assert_eq!(
        at_zero,
        keys::link_challenge("testnet", this().as_str(), wallet().as_str(), 0, expires.0)
    );
    assert_eq!(
        link_wallet(&mut c, &wallet(), &gist_n(1), GH, T_LINK),
        "linked"
    );
    assert_eq!(c.get_link_number(wallet()).0, 1);
    assert_eq!(
        c.link_challenge(wallet(), expires),
        keys::link_challenge("testnet", this().as_str(), wallet().as_str(), 1, expires.0)
    );
    assert_ne!(c.link_challenge(wallet(), expires), at_zero);
    // Another wallet's number and challenge are its own.
    assert_eq!(c.get_link_number(stranger()).0, 0);
    assert_ne!(c.link_challenge(stranger(), expires), at_zero);
}
