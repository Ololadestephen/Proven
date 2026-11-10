//! Generates the cross-language test vectors the web page is checked against: key-proof messages
//! and their NEP-413 hashes, posting terms digests, key pair digests, claim challenges, vault
//! addresses and withdrawal messages, hashes and JSON arguments. The vault address is also derived
//! here independently (borsh `StateInit::V1` + keccak-256) and must agree with the contract's.
//!
//!   UPDATE_VECTORS=1 cargo test --test vectors     writes ../../web/test-fixtures/pr-bounty-vectors.json
//!   cargo test --test vectors                      checks that the committed file is current

use near_sdk::json_types::{U128, U64};
use near_sdk::{CurveType, PublicKey};
use proven_pr_bounty::keys::{self, ClaimBinding, KeyPair, PostTerms, Signing};
use proven_vault::logic;
use rand_chacha::rand_core::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

const FILE: &str = "../../web/test-fixtures/pr-bounty-vectors.json";
const CONTRACT: &str = "pr-bounty.proven-funding.testnet";
const CODE: [u8; 32] = [0x30; 32];

fn key(rng: &mut ChaCha20Rng) -> ([u8; 32], PublicKey) {
    let mut seed = [0u8; 32];
    rng.fill_bytes(&mut seed);
    let sk = ed25519_dalek::SigningKey::from_bytes(&seed);
    let pk =
        PublicKey::from_parts(CurveType::ED25519, sk.verifying_key().to_bytes().to_vec()).unwrap();
    (sk.verifying_key().to_bytes(), pk)
}

fn account(rng: &mut ChaCha20Rng, suffix: &str) -> String {
    format!("acct{}{suffix}", rng.next_u32() % 100_000)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn borsh_str(out: &mut Vec<u8>, s: &[u8]) {
    out.extend((s.len() as u32).to_le_bytes());
    out.extend(s);
}

/// NEP-616 address, built without near-sdk: borsh(StateInit::V1 { CodeHash, BTreeMap }).
fn independent_vault(code: &[u8; 32], primary: &[u8; 32], backup: &[u8; 32]) -> String {
    let mut k = vec![0u8];
    k.extend(primary);
    let mut b = vec![0u8];
    b.extend(backup);
    let entries: Vec<(&[u8], Vec<u8>)> = vec![
        (b"b", b),
        (b"f", 0u128.to_le_bytes().to_vec()),
        (b"k", k),
        (b"n", 0u64.to_le_bytes().to_vec()),
    ];
    let mut out = vec![0u8, 0u8]; // StateInit::V1, GlobalContractId::CodeHash
    out.extend(code);
    out.extend((entries.len() as u32).to_le_bytes());
    for (key, value) in entries {
        borsh_str(&mut out, key);
        borsh_str(&mut out, &value);
    }
    let hash = Keccak256::digest(&out);
    format!("0s{}", hex(&hash[12..32]))
}

fn nep413_hash(message: &[u8], nonce: &[u8; 32], recipient: &[u8]) -> String {
    let mut p = 2_147_484_061u32.to_le_bytes().to_vec();
    borsh_str(&mut p, message);
    p.extend(nonce);
    borsh_str(&mut p, recipient);
    p.push(0);
    hex(&Sha256::digest(&p))
}

fn case(rng: &mut ChaCha20Rng, index: usize) -> Value {
    let (pb, primary) = key(rng);
    let (bb, backup) = key(rng);
    let pair = KeyPair {
        primary: primary.clone(),
        backup: backup.clone(),
    };
    let maintainer = account(rng, ".testnet");
    let wallet = account(rng, ".testnet");
    let mut nonce = [0u8; 32];
    rng.fill_bytes(&mut nonce);
    let terms = PostTerms {
        reward: U128((u128::from(rng.next_u64()) << 20) | 1),
        repo: "proven-test/bounty-pilot".into(),
        repo_id: U64(800_000_000 + u64::from(rng.next_u32() % 1000)),
        issue: 1 + u64::from(rng.next_u32() % 5000),
        base_ref: if index.is_multiple_of(2) {
            "main".into()
        } else {
            "release/v1.2".into()
        },
        contributor_github_id: U64(900_000_000 + u64::from(rng.next_u32())),
        claim_by: U64(1_794_300_000 + u64::from(rng.next_u32() % 100_000)),
        bind_by: U64(1_794_400_000),
        merge_deadline: U64(1_794_500_000),
        grace_secs: U64(600 + u64::from(rng.next_u32() % 86_000)),
    };
    let expires = 1_794_300_000 + u64::from(rng.next_u32() % 3600);
    let bounty = u64::from(rng.next_u32() % 1000);
    let gh = 900_000_000 + u64::from(rng.next_u32());
    let mut out = json!({
        "primary": String::from(&primary), "backup": String::from(&backup),
        "network": "testnet", "contract": CONTRACT, "maintainer": maintainer, "wallet": wallet,
        "nonce": hex(&nonce), "expires_at": expires.to_string(), "bounty": bounty, "github_id": gh.to_string(),
        "terms": {
            "reward": terms.reward.0.to_string(), "repo": terms.repo, "repo_id": terms.repo_id.0.to_string(),
            "issue": terms.issue, "base_ref": terms.base_ref, "contributor_github_id": terms.contributor_github_id.0.to_string(),
            "claim_by": terms.claim_by.0.to_string(), "bind_by": terms.bind_by.0.to_string(),
            "merge_deadline": terms.merge_deadline.0.to_string(), "grace_secs": terms.grace_secs.0.to_string(),
        },
    });
    out["terms_digest"] = json!(keys::terms_digest(
        "testnet",
        CONTRACT,
        &maintainer,
        &nonce,
        &terms,
        &pair
    ));
    out["key_pair_digest"] = json!(keys::key_pair_digest(&pair));
    for (label, signing) in [("primary", Signing::Primary), ("backup", Signing::Backup)] {
        let post = keys::posting_message(
            "testnet",
            CONTRACT,
            &maintainer,
            &nonce,
            &terms,
            &pair,
            expires,
            signing,
        );
        let claim = keys::claim_message(
            "testnet", CONTRACT, &wallet, bounty, gh, &pair, expires, signing,
        );
        let independent = |m: &str| {
            nep413_hash(
                m.as_bytes(),
                &Sha256::digest(m.as_bytes()).into(),
                CONTRACT.as_bytes(),
            )
        };
        assert_eq!(
            hex(&keys::key_proof_hash(&post, CONTRACT)),
            independent(&post)
        );
        out[format!("posting_message_{label}")] = json!(post);
        out[format!("posting_hash_{label}")] = json!(independent(&post));
        out[format!("claim_message_{label}")] = json!(claim);
        out[format!("claim_hash_{label}")] = json!(independent(&claim));
    }
    out["challenge"] = json!(keys::challenge(
        &ClaimBinding {
            network: "testnet",
            contract: CONTRACT,
            bounty,
            repo: &terms.repo,
            repo_id: terms.repo_id.0,
            issue: terms.issue,
            wallet: &wallet,
            github_id: gh,
            expires_at: expires,
        },
        &pair
    ));
    let vault = keys::vault_of(CODE, &pair).to_string();
    assert_eq!(
        vault,
        independent_vault(&CODE, &pb, &bb),
        "near-sdk and the independent derivation agree"
    );
    let swapped = keys::vault_of(
        CODE,
        &KeyPair {
            primary: backup,
            backup: primary,
        },
    )
    .to_string();
    assert_ne!(vault, swapped, "order matters");
    out["vault"] = json!(vault);
    // A withdrawal from that vault.
    let to = account(rng, ".near");
    let amount = (u128::from(rng.next_u64()) << 32) | u128::from(rng.next_u32());
    let n = u64::from(rng.next_u32() % 50);
    let deadline = 1_794_300_000 + u64::from(rng.next_u32() % 900);
    let mut mb = [0u8; logic::MAX_MESSAGE];
    let msg = logic::withdraw_message(
        &mut mb,
        b"testnet",
        vault.as_bytes(),
        to.as_bytes(),
        amount,
        n,
        deadline,
    )
    .unwrap()
    .to_vec();
    let mut pb2 = [0u8; logic::MAX_PAYLOAD];
    let payload =
        logic::nep413_payload(&mut pb2, &msg, &logic::withdraw_nonce(n), vault.as_bytes())
            .unwrap()
            .to_vec();
    assert_eq!(
        hex(&Sha256::digest(&payload)),
        nep413_hash(&msg, &logic::withdraw_nonce(n), vault.as_bytes())
    );
    let signature = hex(&[0x5a; 64]);
    let args = format!(
        r#"{{"to":"{to}","amount":"{amount}","n":"{n}","deadline":"{deadline}","signature":"{signature}"}}"#
    );
    let parsed = logic::parse_withdraw(args.as_bytes()).unwrap();
    assert_eq!(
        (parsed.to, parsed.amount, parsed.n, parsed.deadline),
        (to.as_bytes(), amount, n, deadline)
    );
    out["withdrawal"] = json!({
        "chain": "testnet", "vault": vault, "to": to, "amount": amount.to_string(), "n": n.to_string(),
        "deadline": deadline.to_string(), "message": String::from_utf8(msg).unwrap(),
        "nonce": hex(&logic::withdraw_nonce(n)), "hash": hex(&Sha256::digest(&payload)), "args": args,
    });
    out
}

#[test]
fn vectors_are_current() {
    let mut rng = ChaCha20Rng::seed_from_u64(616);
    let cases: Vec<Value> = (0..50).map(|i| case(&mut rng, i)).collect();
    let mut seen = std::collections::HashSet::new();
    for c in &cases {
        assert!(seen.insert(c["posting_hash_primary"].as_str().unwrap().to_string()));
        assert_ne!(c["posting_hash_primary"], c["posting_hash_backup"]);
        assert_ne!(c["claim_hash_primary"], c["claim_hash_backup"]);
    }
    let doc = json!({
        "about": "Generated by contracts/pr-bounty/tests/vectors.rs. Do not edit by hand.",
        "vault_code_hash_hex": hex(&CODE),
        "cases": cases,
    });
    let text = serde_json::to_string_pretty(&doc).unwrap() + "\n";
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::create_dir_all("../../web/test-fixtures").unwrap();
        std::fs::write(FILE, &text).unwrap();
    } else {
        let current = std::fs::read_to_string(FILE).unwrap_or_default();
        assert!(
            current == text,
            "{FILE} is out of date: run with UPDATE_VECTORS=1"
        );
    }
}
