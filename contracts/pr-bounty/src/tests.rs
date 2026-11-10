//! Unit tests on the mocked chain. Every verifier answer is produced by the bounty verifier's own
//! `render`, and every key proof is signed with real ed25519 keys over an independently built
//! NEP-413 payload.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, CurveType, PromiseResult, RuntimeFeesConfig};
use proven_pr_bounty_verifier as verifier;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use verifier::{PullFacts as VPull, Reason, RunContext};

const URL: &str = "https://test.fastfs.io/proven.testnet/outlayer.testnet/verifier.wasm";
const HASH: &str = "6df5a630107bef075bdd09203d64bbd26ec072e6edfd329b2f946a534c4e32fa";
const VAULT_CODE: [u8; 32] = [7; 32];
const GIST: &str = "0123456789abcdef0123456789abcdef";
const REPO: &str = "proven-test/bounty-pilot";
const REPO_ID: u64 = 800_000_001;
const ISSUE: u64 = 3;
const GH: u64 = 900_000_001;
const OTHER_GH: u64 = 900_000_002;
const PR: u64 = 12;
const PR_ID: u64 = 5_000_000_012;
const SEC: u64 = 1_000_000_000;
const START_S: u64 = 1_794_300_000;
const START: u64 = START_S * SEC;
const CLAIM_BY: u64 = START_S + 3_600;
const BIND_BY: u64 = START_S + 7_200;
const DEADLINE: u64 = START_S + 86_400;
const GRACE: u64 = 3_600;
const REWARD: u128 = 1_000_000_000_000_000_000_000_000;
const NONCE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const POST_EXPIRES: u64 = START_S + 1_800;
const T_CLAIM: u64 = START + 600 * SEC;
const CLAIM_EXPIRES: u64 = START_S + 600 + 1_800;
const T_NOMINATE: u64 = START + 1_200 * SEC;
const T_CHECK: u64 = START + 2_000 * SEC;

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
fn outlayer() -> AccountId {
    "outlayer.testnet".parse().unwrap()
}
fn budget() -> u128 {
    BUDGET.as_yoctonear()
}
fn post_deposit() -> NearToken {
    NearToken::from_yoctonear(REWARD + budget() + STORAGE_DEPOSIT.as_yoctonear())
}

fn sk(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn pk(key: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, key.verifying_key().to_bytes().to_vec()).unwrap()
}
fn pair(p: &SigningKey, b: &SigningKey) -> KeyPair {
    KeyPair {
        primary: pk(p),
        backup: pk(b),
    }
}
fn maint_keys() -> (SigningKey, SigningKey) {
    (sk(1), sk(2))
}
fn contrib_keys() -> (SigningKey, SigningKey) {
    (sk(3), sk(4))
}

/// NEP-413, built independently of the contract: tag, borsh(message), nonce = sha256(message),
/// borsh(recipient), no callback URL.
fn sign_proof(key: &SigningKey, message: &str, recipient: &str) -> Base64VecU8 {
    let nonce: [u8; 32] = Sha256::digest(message.as_bytes()).into();
    let mut payload = 2_147_484_061u32.to_le_bytes().to_vec();
    payload.extend((message.len() as u32).to_le_bytes());
    payload.extend(message.as_bytes());
    payload.extend(nonce);
    payload.extend((recipient.len() as u32).to_le_bytes());
    payload.extend(recipient.as_bytes());
    payload.push(0);
    let hash: [u8; 32] = Sha256::digest(&payload).into();
    Base64VecU8(key.sign(&hash).to_bytes().to_vec())
}

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

fn callback(at: u64, result: PromiseResult) {
    testing_env!(
        context(this(), NearToken::from_yoctonear(0), at).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn contract() -> PrBounty {
    act(owner(), NearToken::from_yoctonear(0), START);
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

fn terms() -> PostTerms {
    PostTerms {
        reward: U128(REWARD),
        repo: REPO.into(),
        repo_id: U64(REPO_ID),
        issue: ISSUE,
        base_ref: "main".into(),
        contributor_github_id: U64(GH),
        claim_by: U64(CLAIM_BY),
        bind_by: U64(BIND_BY),
        merge_deadline: U64(DEADLINE),
        grace_secs: U64(GRACE),
    }
}

fn posting_message(
    t: &PostTerms,
    keys: &KeyPair,
    maintainer: &str,
    nonce: &str,
    expires: u64,
    signing: Signing,
) -> String {
    keys::posting_message(
        "testnet",
        this().as_str(),
        maintainer,
        &keys::parse_nonce(nonce),
        t,
        keys,
        expires,
        signing,
    )
}

/// A posting proof signed by `p` (as primary) and `b` (as backup) for `t` and `nonce`.
fn posting_proof(
    t: &PostTerms,
    p: &SigningKey,
    b: &SigningKey,
    nonce: &str,
    expires: u64,
) -> PostingProof {
    let keys = pair(p, b);
    let sign = |key: &SigningKey, signing| {
        sign_proof(
            key,
            &posting_message(t, &keys, buyer().as_str(), nonce, expires, signing),
            this().as_str(),
        )
    };
    PostingProof {
        nonce: nonce.into(),
        expires_at: U64(expires),
        primary_signature: sign(p, Signing::Primary),
        backup_signature: sign(b, Signing::Backup),
    }
}

fn post_with(c: &mut PrBounty, t: PostTerms, nonce: &str) -> BountyId {
    let (p, b) = maint_keys();
    act(buyer(), post_deposit(), START);
    let proof = posting_proof(&t, &p, &b, nonce, POST_EXPIRES);
    c.post_bounty(t, pair(&p, &b), proof)
}

fn post(c: &mut PrBounty) -> BountyId {
    let nonce = format!("{:064x}", c.get_config().bounty_count + 1);
    post_with(c, terms(), &nonce)
}

fn claim_signatures(
    id: BountyId,
    who: &AccountId,
    p: &SigningKey,
    b: &SigningKey,
    expires: u64,
) -> (Base64VecU8, Base64VecU8) {
    let keys = pair(p, b);
    let msg = |signing| {
        keys::claim_message(
            "testnet",
            this().as_str(),
            who.as_str(),
            id,
            GH,
            &keys,
            expires,
            signing,
        )
    };
    (
        sign_proof(p, &msg(Signing::Primary), this().as_str()),
        sign_proof(b, &msg(Signing::Backup), this().as_str()),
    )
}

fn request(bounty: BountyId, seq: u64, op: verifier::Op) -> verifier::Request {
    verifier::Request {
        network: "testnet".into(),
        contract: this().to_string(),
        bounty,
        seq,
        repo: REPO.into(),
        op,
    }
}

fn ctx(id: u64) -> RunContext {
    RunContext::from_vars(Some(this().to_string()), Some(id.to_string()))
}

fn gist_facts() -> verifier::GistFacts {
    verifier::GistFacts {
        owner_id: GH,
        files: 1,
        challenge_matches: true,
    }
}

fn gist_answer(bounty: BountyId, seq: u64, facts: verifier::GistFacts) -> Json {
    let op = verifier::Op::Gist {
        gist_id: GIST.into(),
        challenge: format!("proven-claim:{}", "0".repeat(64)),
    };
    serde_json::from_str(&verifier::render(
        Some(&request(bounty, seq, op)),
        &ctx(15_100 + seq),
        Ok(verifier::Answer::Gist(facts)),
    ))
    .unwrap()
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

fn pull_answer(bounty: BountyId, seq: u64, facts: VPull) -> Json {
    let op = verifier::Op::Pull {
        number: facts.pr_number,
    };
    serde_json::from_str(&verifier::render(
        Some(&request(bounty, seq, op)),
        &ctx(15_100 + seq),
        Ok(verifier::Answer::Pull(facts)),
    ))
    .unwrap()
}

fn ok(value: &Json) -> PromiseResult {
    PromiseResult::Successful(value.to_string().into_bytes())
}

/// Runs `case` on its own thread, so it gets its own mocked chain and storage.
fn isolated(case: impl FnOnce() + Send + 'static) {
    std::thread::spawn(case).join().expect("case passed");
}

fn panics(case: impl FnOnce() + Send + 'static) -> String {
    let err = std::thread::spawn(case).join().expect_err("refused");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn pending(seq: u64, who: AccountId, keys: KeyPair) -> PendingClaim {
    PendingClaim {
        seq: U64(seq),
        wallet: who,
        gist_id: GIST.into(),
        requested_at: U64(T_CLAIM),
        expires_at: U64(CLAIM_EXPIRES),
        keys,
    }
}

fn claim_with(c: &mut PrBounty, id: BountyId, answer: PromiseResult) -> String {
    let (p, b) = contrib_keys();
    let (ps, bs) = claim_signatures(id, &wallet(), &p, &b, CLAIM_EXPIRES);
    act(wallet(), RUN_DEPOSIT, T_CLAIM);
    let _ = c.prove_claim(id, GIST.into(), U64(CLAIM_EXPIRES), pair(&p, &b), ps, bs);
    let seq = c.next_seq;
    callback(T_CLAIM + 10 * SEC, answer);
    c.on_claim(id, pending(seq, wallet(), pair(&p, &b)))
}

fn claimed() -> (PrBounty, BountyId) {
    let mut c = contract();
    let id = post(&mut c);
    let seq = c.next_seq + 1;
    assert_eq!(
        claim_with(&mut c, id, ok(&gist_answer(id, seq, gist_facts()))),
        "claimed"
    );
    (c, id)
}

fn nominate_with(c: &mut PrBounty, id: BountyId, facts: VPull) -> String {
    act(buyer(), RUN_DEPOSIT, T_NOMINATE);
    let _ = c.nominate(id, PR);
    let seq = c.get_bounty(id).unwrap().live.unwrap().seq.0;
    callback(T_NOMINATE + 10 * SEC, ok(&pull_answer(id, seq, facts)));
    c.on_check(id, U64(seq))
}

fn bound() -> (PrBounty, BountyId) {
    let (mut c, id) = claimed();
    assert_eq!(nominate_with(&mut c, id, pull("open", None)), "bound");
    (c, id)
}

fn check_with(
    c: &mut PrBounty,
    id: BountyId,
    who: AccountId,
    deposit: NearToken,
    at: u64,
    facts: VPull,
) -> String {
    act(who, deposit, at);
    let _ = c.check_merge(id);
    let seq = c.get_bounty(id).unwrap().live.unwrap().seq.0;
    callback(at + 10 * SEC, ok(&pull_answer(id, seq, facts)));
    c.on_check(id, U64(seq))
}

fn paid() -> (PrBounty, BountyId) {
    let (mut c, id) = bound();
    let outcome = check_with(
        &mut c,
        id,
        stranger(),
        RUN_DEPOSIT,
        T_CHECK,
        pull("closed", Some(DEADLINE - 1)),
    );
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

// ---- Posting with key proofs ----

#[test]
fn posting_records_keys_vault_and_consumes_the_nonce() {
    let mut c = contract();
    let id = post_with(&mut c, terms(), NONCE);
    let b = c.get_bounty(id).unwrap();
    let (p, k) = maint_keys();
    assert_eq!(b.maintainer_keys, pair(&p, &k));
    assert_eq!(
        b.maintainer_vault,
        keys::vault_of(VAULT_CODE, &pair(&p, &k))
    );
    assert!(b.maintainer_vault.as_str().starts_with("0s"));
    assert_eq!(b.budget.0, budget());
    assert_eq!(c.get_config().held.0, REWARD + budget());
    assert!(c.is_nonce_used(buyer(), NONCE.into()));
    assert!(
        !c.is_nonce_used(stranger(), NONCE.into()),
        "nonces are per maintainer"
    );
    // The views return the exact texts the contract verifies.
    act(buyer(), NearToken::from_yoctonear(0), START);
    let view = c.posting_key_message(
        terms(),
        pair(&p, &k),
        buyer(),
        NONCE.into(),
        U64(POST_EXPIRES),
        "backup".into(),
    );
    assert_eq!(
        view,
        posting_message(
            &terms(),
            &pair(&p, &k),
            buyer().as_str(),
            NONCE,
            POST_EXPIRES,
            Signing::Backup
        )
    );
    assert!(view.contains("signing: backup\nprimary: ed25519:"));
    assert!(view.ends_with("Either key alone can withdraw everything in the vault."));
}

#[test]
fn a_posting_nonce_cannot_be_reused() {
    let msg = panics(|| {
        let mut c = contract();
        post_with(&mut c, terms(), NONCE);
        post_with(&mut c, terms(), NONCE);
    });
    assert!(msg.contains("nonce has already been used"), "{msg}");
}

#[test]
fn a_copied_posting_proof_does_not_authorize_other_terms() {
    let msg = panics(|| {
        let mut c = contract();
        let (p, b) = maint_keys();
        let proof = posting_proof(&terms(), &p, &b, NONCE, POST_EXPIRES);
        let mut other = terms();
        other.reward = U128(REWARD / 2);
        act(
            buyer(),
            NearToken::from_yoctonear(REWARD / 2 + budget() + STORAGE_DEPOSIT.as_yoctonear()),
            START,
        );
        c.post_bounty(other, pair(&p, &b), proof);
    });
    assert!(msg.contains("primary key's proof does not match"), "{msg}");
}

#[test]
fn posting_key_proofs_that_do_not_hold_are_refused() {
    type Case = (
        &'static str,
        Box<dyn Fn(&mut PostTerms, &mut KeyPair, &mut PostingProof) + Send>,
    );
    let cases: Vec<Case> = vec![
        (
            "backup key must differ",
            Box::new(|_, k, _| k.backup = k.primary.clone()),
        ),
        (
            "primary key's proof does not match",
            Box::new(|_, k, _| std::mem::swap(&mut k.primary, &mut k.backup)),
        ),
        (
            "primary key's proof does not match",
            Box::new(|_, _, p| std::mem::swap(&mut p.primary_signature, &mut p.backup_signature)),
        ),
        (
            "primary key's proof does not match",
            Box::new(|_, k, _| k.backup = pk(&sk(9))),
        ),
        (
            "backup key's proof does not match",
            Box::new(|_, _, p| p.backup_signature = p.primary_signature.clone()),
        ),
        (
            "primary key's proof does not match",
            Box::new(|t, _, _| t.issue = 4),
        ),
        (
            "primary key's proof does not match",
            Box::new(|_, _, p| p.nonce = "2".repeat(64)),
        ),
        (
            "primary key's proof does not match",
            Box::new(|_, _, p| p.expires_at = U64(POST_EXPIRES + 1)),
        ),
        (
            "expires_at must be in the future",
            Box::new(|_, _, p| p.expires_at = U64(START_S)),
        ),
        (
            "at most one hour ahead",
            Box::new(|_, _, p| p.expires_at = U64(START_S + 3_601)),
        ),
        (
            "signatures must be 64 bytes",
            Box::new(|_, _, p| p.backup_signature.0.pop().map(|_| ()).unwrap()),
        ),
        (
            "nonce must be 64 lowercase hex",
            Box::new(|_, _, p| p.nonce = "A".repeat(64)),
        ),
        (
            "keys must be ed25519",
            Box::new(|_, k, _| {
                k.backup = PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap()
            }),
        ),
    ];
    for (expected, edit) in cases {
        let msg = panics(move || {
            let mut c = contract();
            let (p, b) = maint_keys();
            let mut t = terms();
            let mut keys = pair(&p, &b);
            let mut proof = posting_proof(&terms(), &p, &b, NONCE, POST_EXPIRES);
            edit(&mut t, &mut keys, &mut proof);
            let reward = t.reward.0;
            act(
                buyer(),
                NearToken::from_yoctonear(reward + budget() + STORAGE_DEPOSIT.as_yoctonear()),
                START,
            );
            c.post_bounty(t, keys, proof);
        });
        assert!(msg.contains(expected), "expected {expected:?}, got {msg:?}");
    }
}

#[test]
fn another_maintainers_proof_is_refused() {
    let msg = panics(|| {
        let mut c = contract();
        act(owner(), NearToken::from_yoctonear(0), START);
        c.add_poster(stranger());
        let (p, b) = maint_keys();
        let proof = posting_proof(&terms(), &p, &b, NONCE, POST_EXPIRES);
        act(stranger(), post_deposit(), START);
        c.post_bounty(terms(), pair(&p, &b), proof);
    });
    assert!(msg.contains("proof does not match"), "{msg}");
}

#[test]
fn a_paused_posting_is_refused_before_the_nonce_is_used() {
    isolated(|| {
        let mut c = contract();
        act(owner(), NearToken::from_yoctonear(0), START);
        c.set_paused(true);
        let (p, b) = maint_keys();
        let proof = posting_proof(&terms(), &p, &b, NONCE, POST_EXPIRES);
        act(buyer(), post_deposit(), START);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.post_bounty(terms(), pair(&p, &b), proof)
        }));
        assert!(r.is_err());
        assert!(!c.is_nonce_used(buyer(), NONCE.into()));
    });
}

#[test]
fn only_the_approved_repository_can_be_posted() {
    let msg = panics(|| {
        let mut c = contract();
        let mut t = terms();
        t.repo = "proven-test/other".into();
        post_with(&mut c, t, NONCE);
    });
    assert!(
        msg.contains("only pays for its approved repository"),
        "{msg}"
    );
}

// ---- Claiming with key proofs and challenge v3 ----

#[test]
fn an_accepted_claim_records_the_key_pair_and_its_vault() {
    isolated(|| {
        let (c, id) = claimed();
        let claim = c.get_bounty(id).unwrap().claim.unwrap();
        let (p, b) = contrib_keys();
        assert_eq!(claim.keys, pair(&p, &b));
        assert_eq!(claim.vault, keys::vault_of(VAULT_CODE, &pair(&p, &b)));
        assert_eq!(claim.wallet, wallet());
    });
}

#[test]
fn the_challenge_binds_the_ordered_key_pair() {
    isolated(|| {
        let mut c = contract();
        let id = post(&mut c);
        let (p, b) = contrib_keys();
        let one = c.claim_challenge(id, wallet(), U64(CLAIM_EXPIRES), pk(&p), pk(&b));
        let swapped = c.claim_challenge(id, wallet(), U64(CLAIM_EXPIRES), pk(&b), pk(&p));
        let other = c.claim_challenge(id, wallet(), U64(CLAIM_EXPIRES), pk(&p), pk(&sk(9)));
        assert!(one.starts_with("proven-claim:") && one.len() == 13 + 64);
        assert_ne!(one, swapped);
        assert_ne!(one, other);
        // The claim run sends exactly this challenge to the verifier.
        let (ps, bs) = claim_signatures(id, &wallet(), &p, &b, CLAIM_EXPIRES);
        act(wallet(), RUN_DEPOSIT, T_CLAIM);
        let _ = c.prove_claim(id, GIST.into(), U64(CLAIM_EXPIRES), pair(&p, &b), ps, bs);
        let (args, deposit) = outlayer_call();
        let input: Json = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
        assert_eq!(input["challenge"], one.as_str());
        assert_eq!(input["v"], 3);
        assert_eq!(deposit, RUN_DEPOSIT);
    });
}

#[test]
fn claim_key_proofs_for_another_wallet_or_bounty_are_refused() {
    let cases: Vec<(&str, u64, AccountId, u64)> = vec![
        ("another wallet", 0, stranger(), CLAIM_EXPIRES),
        ("another bounty", 1, wallet(), CLAIM_EXPIRES),
        ("another expiry", 0, wallet(), CLAIM_EXPIRES + 1),
    ];
    for (label, signed_for, who, expires) in cases {
        let msg = panics(move || {
            let mut c = contract();
            let id = post(&mut c);
            let (p, b) = contrib_keys();
            let (ps, bs) = claim_signatures(id + signed_for, &who, &p, &b, expires);
            act(wallet(), RUN_DEPOSIT, T_CLAIM);
            let _ = c.prove_claim(id, GIST.into(), U64(CLAIM_EXPIRES), pair(&p, &b), ps, bs);
        });
        assert!(msg.contains("proof does not match"), "{label}: {msg}");
    }
}

#[test]
fn claim_answers_that_do_not_hold_are_refused() {
    let cases: Vec<(&str, verifier::GistFacts)> = vec![
        (
            "mismatch:owner_id",
            verifier::GistFacts {
                owner_id: OTHER_GH,
                ..gist_facts()
            },
        ),
        (
            "mismatch:ambiguous",
            verifier::GistFacts {
                files: 2,
                ..gist_facts()
            },
        ),
        (
            "mismatch:challenge",
            verifier::GistFacts {
                challenge_matches: false,
                ..gist_facts()
            },
        ),
    ];
    for (expected, facts) in cases {
        isolated(move || {
            let mut c = contract();
            let id = post(&mut c);
            let seq = c.next_seq + 1;
            assert_eq!(
                claim_with(&mut c, id, ok(&gist_answer(id, seq, facts))),
                expected
            );
            assert_eq!(c.get_bounty(id).unwrap().status, Status::Open);
        });
    }
    isolated(|| {
        let mut c = contract();
        let id = post(&mut c);
        let seq = c.next_seq + 1;
        let answer = gist_answer(id + 7, seq, gist_facts());
        assert_eq!(
            claim_with(&mut c, id, ok(&answer)),
            "no_result:wrong_binding"
        );
        let failed = claim_with(&mut c, id, PromiseResult::Failed);
        assert_eq!(failed, "no_result:promise_failed");
        let reason = serde_json::from_str::<Json>(&verifier::render(
            Some(&request(
                id,
                c.next_seq,
                verifier::Op::Gist {
                    gist_id: GIST.into(),
                    challenge: format!("proven-claim:{}", "0".repeat(64)),
                },
            )),
            &ctx(1),
            Err(Reason::RateLimited),
        ))
        .unwrap();
        let _ = reason;
        assert_eq!(c.get_bounty(id).unwrap().status, Status::Open);
    });
}

#[test]
fn a_late_claim_result_is_stale_and_changes_nothing() {
    isolated(|| {
        let mut c = contract();
        let id = post(&mut c);
        let (p, b) = contrib_keys();
        let seq = c.next_seq + 1;
        callback(
            T_CLAIM + RUN_TIMEOUT_NANOS + 1,
            ok(&gist_answer(id, seq, gist_facts())),
        );
        assert_eq!(
            c.on_claim(id, pending(seq, wallet(), pair(&p, &b))),
            "no_result:stale"
        );
        assert!(c.get_bounty(id).unwrap().claim.is_none());
    });
}

// ---- Merge checks: verification boundary and the sponsor float ----

#[test]
fn nominations_and_the_merge_window_follow_the_existing_rules() {
    isolated(|| {
        let (mut c, id) = claimed();
        let mut foreign = pull("open", None);
        foreign.author_id = OTHER_GH;
        assert_eq!(nominate_with(&mut c, id, foreign), "mismatch:author_id");
        assert_eq!(nominate_with(&mut c, id, pull("open", None)), "bound");
        assert_eq!(
            check_with(
                &mut c,
                id,
                stranger(),
                RUN_DEPOSIT,
                T_CHECK,
                pull("open", None)
            ),
            "pending"
        );
        let early = pull("closed", Some(T_NOMINATE / SEC - 61));
        assert_eq!(
            check_with(
                &mut c,
                id,
                stranger(),
                RUN_DEPOSIT,
                T_CHECK + 100 * SEC,
                early
            ),
            "no_result:merged_before_binding"
        );
        let late = pull("closed", Some(DEADLINE));
        assert_eq!(
            check_with(
                &mut c,
                id,
                stranger(),
                RUN_DEPOSIT,
                T_CHECK + 200 * SEC,
                late
            ),
            "ineligible:merged_after_deadline"
        );
        assert!(c.get_bounty(id).unwrap().payout.is_none());
    });
}

#[test]
fn a_sponsored_check_is_paid_by_the_float_and_refunds_to_the_sponsor() {
    isolated(|| {
        let (mut c, id) = bound();
        let held = c.get_config().held.0;
        act(wallet(), NearToken::from_yoctonear(0), T_CHECK);
        let _ = c.check_merge(id);
        let (args, deposit) = outlayer_call();
        assert_eq!(args["payer_account_id"], sponsor().as_str());
        assert_eq!(deposit, RUN_DEPOSIT);
        // refund_to is checked in the sandbox, where the mock OutLayer records it.
        let cfg = c.get_config();
        assert_eq!(
            cfg.sponsor_float.0,
            NearToken::from_millinear(40).as_yoctonear()
        );
        assert_eq!(cfg.sponsor_spent.0, RUN_DEPOSIT.as_yoctonear());
        assert_eq!(cfg.held.0, held, "held is untouched");
        let b = c.get_bounty(id).unwrap();
        assert_eq!((b.sponsored_runs, b.budget.0), (1, budget()));
    });
}

#[test]
fn sponsored_checks_are_capped_per_bounty_in_total_and_by_the_float() {
    // A fourth sponsored check on one bounty.
    let msg = panics(|| {
        let (mut c, id) = bound();
        for k in 0..4u64 {
            act(
                wallet(),
                NearToken::from_yoctonear(0),
                T_CHECK + k * RUN_TIMEOUT_NANOS * 2,
            );
            let _ = c.check_merge(id);
        }
    });
    assert!(msg.contains("used its three sponsored checks"), "{msg}");
    // An empty float.
    let msg = panics(|| {
        let (mut c, id) = bound();
        c.sponsor_float = 0;
        act(wallet(), NearToken::from_yoctonear(0), T_CHECK);
        let _ = c.check_merge(id);
    });
    assert!(msg.contains("sponsor float cannot pay"), "{msg}");
    // The aggregate cap.
    let msg = panics(|| {
        let (mut c, id) = bound();
        act(owner(), NearToken::from_yoctonear(0), T_CHECK);
        c.set_sponsor_limits(U128(NearToken::from_millinear(100).as_yoctonear()), U128(0));
        act(wallet(), NearToken::from_yoctonear(0), T_CHECK);
        let _ = c.check_merge(id);
    });
    assert!(msg.contains("total spending cap"), "{msg}");
    // Funding above the float cap, and by someone else.
    let msg = panics(|| {
        let mut c = contract();
        act(sponsor(), NearToken::from_millinear(51), START);
        c.fund_sponsor();
    });
    assert!(msg.contains("exceed its cap"), "{msg}");
    let msg = panics(|| {
        let mut c = contract();
        act(stranger(), NearToken::from_millinear(1), START);
        c.fund_sponsor();
    });
    assert!(msg.contains("only the owner or the sponsor"), "{msg}");
    // An empty float leaves self-funded checks and refunds available.
    isolated(|| {
        let (mut c, id) = bound();
        c.sponsor_float = 0;
        assert_eq!(
            check_with(
                &mut c,
                id,
                stranger(),
                RUN_DEPOSIT,
                T_CHECK,
                pull("open", None)
            ),
            "pending"
        );
        act(
            stranger(),
            NearToken::from_yoctonear(0),
            (DEADLINE + GRACE) * SEC,
        );
        c.settle(id);
        assert_eq!(c.get_bounty(id).unwrap().status, Status::Refunded);
    });
}

// ---- Settlement into vaults ----

#[test]
fn a_paid_bounty_creates_both_settlements_and_sends_them_to_the_vaults() {
    isolated(|| {
        let (mut c, id) = paid();
        let b = c.get_bounty(id).unwrap();
        let payout = b.payout.clone().unwrap();
        let ret = b.budget_return.clone().unwrap();
        assert_eq!(
            (payout.principal.0, payout.state, payout.vault.clone()),
            (REWARD, SettlementState::Due, b.claim.unwrap().vault)
        );
        assert_eq!(
            (ret.principal.0, ret.vault.clone()),
            (budget(), b.maintainer_vault.clone())
        );
        assert_eq!(
            c.get_config().held.0,
            REWARD + budget(),
            "nothing released before confirmation"
        );
        // The detached send.
        act(this(), NearToken::from_yoctonear(0), T_CHECK + 20 * SEC);
        assert_eq!(c.send_due_after_check(id), 2);
        let sent = deposits();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].0, payout.vault.to_string());
        assert_eq!(sent[0].1, REWARD + DEPOSIT_FEE.as_yoctonear());
        assert_eq!(sent[1].1, budget() + DEPOSIT_FEE.as_yoctonear());
        // borsh(bounty u64, kind u8, attempt u32, amount u128)
        assert_eq!(sent[0].2.len(), 29);
        assert_eq!(sent[0].2[8], 0);
        assert_eq!(sent[1].2[8], 1);
        assert_eq!(
            transfers_to_accounts(),
            0,
            "no plain transfer to any account"
        );
        let cfg = c.get_config();
        assert_eq!(
            (cfg.held.0, cfg.in_flight.0),
            (REWARD + budget(), REWARD + budget())
        );
        // Callbacks: success releases once; a duplicate changes nothing.
        callback(T_CHECK + 21 * SEC, PromiseResult::Successful(vec![]));
        assert!(c.on_settle(id, SettlementKind::Payout, 1));
        assert!(!c.on_settle(id, SettlementKind::Payout, 1));
        let cfg = c.get_config();
        assert_eq!((cfg.held.0, cfg.in_flight.0), (budget(), budget()));
        // Failure makes it due again, still reserved.
        callback(T_CHECK + 21 * SEC, PromiseResult::Failed);
        assert!(c.on_settle(id, SettlementKind::BudgetReturn, 1));
        let ret = c.get_settlement(id, SettlementKind::BudgetReturn).unwrap();
        assert_eq!(ret.state, SettlementState::Due);
        let cfg = c.get_config();
        assert_eq!((cfg.held.0, cfg.in_flight.0), (budget(), 0));
    });
}

#[test]
fn a_refund_is_reward_plus_the_full_budget() {
    isolated(|| {
        let mut c = contract();
        let id = post(&mut c);
        act(buyer(), NearToken::from_yoctonear(0), START + SEC);
        c.cancel(id);
        let r = c.get_settlement(id, SettlementKind::Refund).unwrap();
        assert_eq!(
            (r.principal.0, r.state, r.attempt),
            (REWARD + budget(), SettlementState::InFlight, 1)
        );
        let sent = deposits();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].2[8], 2, "kind byte 2 is the refund");
    });
}

#[test]
fn a_recorded_outcome_finishes_the_attempt_without_sending() {
    isolated(|| {
        let mut c = contract();
        let id = post(&mut c);
        act(buyer(), NearToken::from_yoctonear(0), START + SEC);
        c.cancel(id);
        callback(START + 2 * SEC, PromiseResult::Successful(vec![]));
        c.on_settle_outcome(id, SettlementKind::Refund, 1);
        act(stranger(), NearToken::from_yoctonear(0), START + 3 * SEC);
        assert!(c.recover_settlement(id, SettlementKind::Refund));
        assert_eq!(c.get_config().held.0, 0);
        assert_eq!(
            c.get_settlement(id, SettlementKind::Refund)
                .unwrap()
                .done_by
                .as_deref(),
            Some("recorded_outcome")
        );
    });
    let msg = panics(|| {
        let mut c = contract();
        let id = post(&mut c);
        act(buyer(), NearToken::from_yoctonear(0), START + SEC);
        c.cancel(id);
        act(stranger(), NearToken::from_yoctonear(0), START + 3 * SEC);
        c.recover_settlement(id, SettlementKind::Refund);
    });
    assert!(msg.contains("no outcome is recorded"), "{msg}");
}

// ---- Reconcile: caller rule, delays, marker, answers ----

fn refund_in_flight() -> (PrBounty, BountyId, u64) {
    let mut c = contract();
    let id = post(&mut c);
    let sent_at = START + SEC;
    act(buyer(), NearToken::from_yoctonear(0), sent_at);
    c.cancel(id);
    (c, id, sent_at)
}

fn try_reconcile(
    c: &mut PrBounty,
    id: BountyId,
    who: AccountId,
    at: u64,
    attempt: u32,
) -> Result<(), String> {
    act(who, RECONCILE_DEPOSIT, at);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.reconcile(id, SettlementKind::Refund, attempt)
    }))
    .map_err(|e| e.downcast_ref::<String>().cloned().unwrap_or_default())
}

fn slot(deposited: bool, attempt: u32, amount: u128, sealed: u32) -> PromiseResult {
    let mut out = vec![u8::from(deposited)];
    out.extend(attempt.to_le_bytes());
    out.extend(amount.to_le_bytes());
    out.extend(sealed.to_le_bytes());
    PromiseResult::Successful(out)
}

#[test]
fn a_party_may_reconcile_at_15_minutes_and_anyone_at_24_hours() {
    isolated(|| {
        let (mut c, id, sent) = refund_in_flight();
        let party = sent + PARTY_RECONCILE_DELAY_NANOS;
        let open = sent + OPEN_RECONCILE_DELAY_NANOS;
        assert!(try_reconcile(&mut c, id, buyer(), party - 1, 1)
            .unwrap_err()
            .contains("too early"));
        assert!(try_reconcile(&mut c, id, stranger(), party, 1)
            .unwrap_err()
            .contains("too early"));
        assert!(try_reconcile(&mut c, id, stranger(), open - 1, 1)
            .unwrap_err()
            .contains("too early"));
        assert!(try_reconcile(&mut c, id, buyer(), party, 2)
            .unwrap_err()
            .contains("only the current attempt"));
        try_reconcile(&mut c, id, buyer(), party, 1).unwrap();
        // The marker blocks an overlapping reconcile until it expires.
        let marker = party + RECONCILE_MARKER_TTL_NANOS;
        assert!(try_reconcile(&mut c, id, buyer(), marker - 1, 1)
            .unwrap_err()
            .contains("in progress"));
        try_reconcile(&mut c, id, stranger(), open.max(marker), 1).unwrap();
        // The seal finds no deposit: due again, still reserved.
        callback(open + SEC, slot(false, 0, 0, 1));
        let started = c
            .get_settlement(id, SettlementKind::Refund)
            .unwrap()
            .reconcile
            .unwrap()
            .started_at;
        assert_eq!(
            c.on_reconcile(id, SettlementKind::Refund, 1, started),
            "sealed_without_deposit"
        );
        let r = c.get_settlement(id, SettlementKind::Refund).unwrap();
        assert_eq!((r.state, r.reconcile), (SettlementState::Due, None));
        assert_eq!(c.get_config().held.0, REWARD + budget());
        // A resend restarts both clocks.
        let resent = open + 2 * SEC;
        act(stranger(), NearToken::from_yoctonear(0), resent);
        c.send_due(id);
        assert!(try_reconcile(
            &mut c,
            id,
            stranger(),
            resent + OPEN_RECONCILE_DELAY_NANOS - 1,
            2
        )
        .unwrap_err()
        .contains("too early"));
        assert!(try_reconcile(
            &mut c,
            id,
            buyer(),
            resent + PARTY_RECONCILE_DELAY_NANOS - 1,
            2
        )
        .unwrap_err()
        .contains("too early"));
        // An answer about attempt 1 is stale now.
        callback(resent + SEC, slot(false, 0, 0, 1));
        assert_eq!(
            c.on_reconcile(id, SettlementKind::Refund, 1, started),
            "ignored:not_in_flight"
        );
    });
}

#[test]
fn reconcile_answers_release_once_or_leave_the_attempt_in_flight() {
    isolated(|| {
        let (mut c, id, sent) = refund_in_flight();
        let at = sent + PARTY_RECONCILE_DELAY_NANOS;
        let p = REWARD + budget();
        let cases = [
            (PromiseResult::Failed, "ignored:seal_failed"),
            (
                PromiseResult::Successful(vec![1, 2, 3]),
                "ignored:malformed",
            ),
            (slot(true, 1, p - 1, 0), "ignored:other_deposit"),
            (slot(true, 2, p, 0), "ignored:other_deposit"),
            (slot(false, 0, 0, 0), "ignored:not_sealed"),
        ];
        for (k, (answer, expected)) in cases.into_iter().enumerate() {
            let t = at + (k as u64) * RECONCILE_MARKER_TTL_NANOS;
            try_reconcile(&mut c, id, buyer(), t, 1).unwrap();
            callback(t + SEC, answer);
            assert_eq!(
                c.on_reconcile(id, SettlementKind::Refund, 1, U64(t)),
                expected
            );
            let r = c.get_settlement(id, SettlementKind::Refund).unwrap();
            assert_eq!(r.state, SettlementState::InFlight);
            assert_eq!(r.reconcile, None, "the matching marker is cleared");
        }
        let t = at + 10 * RECONCILE_MARKER_TTL_NANOS;
        try_reconcile(&mut c, id, wallet_or_buyer(), t, 1).unwrap();
        callback(t + SEC, slot(true, 1, p, 0));
        assert_eq!(
            c.on_reconcile(id, SettlementKind::Refund, 1, U64(t)),
            "deposited"
        );
        assert_eq!(c.get_config().held.0, 0);
        callback(t + 2 * SEC, slot(true, 1, p, 0));
        assert_eq!(
            c.on_reconcile(id, SettlementKind::Refund, 1, U64(t)),
            "ignored:not_in_flight"
        );
        assert_eq!(c.get_config().held.0, 0, "released exactly once");
    });
}

fn wallet_or_buyer() -> AccountId {
    buyer()
}

#[test]
fn reconcile_needs_the_exact_deposit_and_an_in_flight_settlement() {
    let msg = panics(|| {
        let (mut c, id, sent) = refund_in_flight();
        act(
            buyer(),
            NearToken::from_millinear(9),
            sent + PARTY_RECONCILE_DELAY_NANOS,
        );
        c.reconcile(id, SettlementKind::Refund, 1);
    });
    assert!(msg.contains("attach exactly 0.01 NEAR"), "{msg}");
    let msg = panics(|| {
        let (mut c, id, sent) = refund_in_flight();
        callback(sent + SEC, PromiseResult::Successful(vec![]));
        c.on_settle(id, SettlementKind::Refund, 1);
        act(
            buyer(),
            RECONCILE_DEPOSIT,
            sent + PARTY_RECONCILE_DELAY_NANOS,
        );
        c.reconcile(id, SettlementKind::Refund, 1);
    });
    assert!(msg.contains("not in flight"), "{msg}");
}

#[test]
fn the_contract_balance_never_decides_an_outcome_only_whether_a_send_is_affordable() {
    isolated(|| {
        let mut c = contract();
        let id = post(&mut c);
        // A balance that covers the principal but not the fee: the refund waits, still due.
        let mut ctx = context(buyer(), NearToken::from_yoctonear(0), START + SEC);
        ctx.account_balance(NearToken::from_yoctonear(
            REWARD + budget() + NearToken::from_millinear(50).as_yoctonear(),
        ));
        testing_env!(ctx.build());
        c.cancel(id);
        let r = c.get_settlement(id, SettlementKind::Refund).unwrap();
        assert_eq!((r.state, r.attempt), (SettlementState::Due, 0));
        assert_eq!(deposits().len(), 0);
    });
}
