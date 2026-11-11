//! The withdrawal key, the messages its NEP-413 key proofs sign, the posting terms digest, the
//! GitHub link challenge and the vault address. One key receives each party's money: the key a
//! wallet signs a proof with at posting (maintainer's refund) or at claiming (contributor's
//! payout). The key may differ from the key that signs the wallet's transactions; what matters is
//! that its holder proved control of it for this exact account and these exact terms before any
//! money was locked or any payout key was accepted. The web page builds the same bytes and is
//! checked against vectors generated from this code.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::state_init::{StateInit, StateInitV1};
use near_sdk::{env, near, require, AccountId, CryptoHash, GlobalContractId, PublicKey};

/// NEP-413's prefix tag, 2^31 + 413.
pub const NEP413_TAG: u32 = 2_147_484_061;
/// The longest a key proof or a link challenge may stay valid.
pub const KEY_PROOF_TTL_SECS: u64 = 60 * 60;
const NANOS: u64 = 1_000_000_000;

/// What a bounty's posting fixes; covered by the posting terms digest.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PostTerms {
    pub reward: U128,
    pub repo: String,
    pub repo_id: U64,
    pub issue: u64,
    pub base_ref: String,
    /// The bounty accepts claims until this time (Unix seconds).
    pub claim_by: U64,
    /// How long one claim lasts before anyone can end it.
    pub claim_secs: U64,
    pub merge_deadline: U64,
    pub grace_secs: U64,
}

/// The maintainer's withdrawal-key proof for one posting.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PostingProof {
    /// 32 bytes as 64 lowercase hex characters, fresh per posting.
    pub nonce: String,
    /// Unix seconds, at most one hour ahead.
    pub expires_at: U64,
    pub signature: Base64VecU8,
}

/// The contributor's withdrawal-key proof for one claim.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClaimProof {
    pub expires_at: U64,
    pub signature: Base64VecU8,
}

/// The 32 key bytes of an ed25519 key; refuses any other curve or length.
pub fn ed25519_bytes(key: &PublicKey) -> [u8; 32] {
    let b = key.as_bytes();
    require!(
        b.len() == 33 && b[0] == 0,
        "keys must be ed25519 public keys"
    );
    b[1..].try_into().expect("32 bytes")
}

pub fn key_text(key: &PublicKey) -> String {
    String::from(key)
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 64 lowercase hex characters to 32 bytes.
pub fn parse_nonce(nonce: &str) -> [u8; 32] {
    let b = nonce.as_bytes();
    let ok = b.len() == 64
        && b.iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c));
    require!(ok, "nonce must be 64 lowercase hex characters");
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&nonce[2 * i..2 * i + 2], 16).expect("hex");
    }
    out
}

fn borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend((s.len() as u32).to_le_bytes());
    out.extend(s.as_bytes());
}

/// The NEP-413 payload bytes: tag, then borsh of message, 32-byte nonce, recipient and no URL.
pub fn nep413_payload(message: &str, nonce: &[u8; 32], recipient: &str) -> Vec<u8> {
    let mut out = NEP413_TAG.to_le_bytes().to_vec();
    borsh_str(&mut out, message);
    out.extend(nonce);
    borsh_str(&mut out, recipient);
    out.push(0);
    out
}

/// The NEP-413 hash of a key-proof message: its nonce is the SHA-256 of the message, and its
/// recipient is this contract.
pub fn key_proof_hash(message: &str, contract: &str) -> [u8; 32] {
    let nonce = env::sha256_array(message.as_bytes());
    env::sha256_array(nep413_payload(message, &nonce, contract))
}

/// The canonical bytes of a posting's terms.
pub fn terms_bytes(
    network: &str,
    contract: &str,
    maintainer: &str,
    nonce: &[u8; 32],
    terms: &PostTerms,
    key: &PublicKey,
) -> Vec<u8> {
    let mut out = Vec::new();
    borsh_str(&mut out, "proven-pr-bounty-terms:v2");
    borsh_str(&mut out, network);
    borsh_str(&mut out, contract);
    borsh_str(&mut out, maintainer);
    out.extend(nonce);
    out.extend(terms.reward.0.to_le_bytes());
    borsh_str(&mut out, &terms.repo);
    out.extend(terms.repo_id.0.to_le_bytes());
    out.extend(terms.issue.to_le_bytes());
    borsh_str(&mut out, &terms.base_ref);
    out.extend(terms.claim_by.0.to_le_bytes());
    out.extend(terms.claim_secs.0.to_le_bytes());
    out.extend(terms.merge_deadline.0.to_le_bytes());
    out.extend(terms.grace_secs.0.to_le_bytes());
    out.extend(ed25519_bytes(key));
    out
}

pub fn terms_digest(
    network: &str,
    contract: &str,
    maintainer: &str,
    nonce: &[u8; 32],
    terms: &PostTerms,
    key: &PublicKey,
) -> String {
    hex(&env::sha256_array(terms_bytes(
        network, contract, maintainer, nonce, terms, key,
    )))
}

const PROOF_TAIL: &str = "This key alone can withdraw everything the vault receives. Nobody can replace it, and nobody can recover the money if it is lost.";

pub fn posting_message(
    network: &str,
    contract: &str,
    maintainer: &str,
    nonce: &[u8; 32],
    terms: &PostTerms,
    key: &PublicKey,
    expires_at: u64,
) -> String {
    let digest = terms_digest(network, contract, maintainer, nonce, terms, key);
    [
        "Proven PR bounty withdrawal-key proof v2".to_string(),
        "role: maintainer (refund)".to_string(),
        format!("network: {network}"),
        format!("contract: {contract}"),
        format!("actor: {maintainer}"),
        format!("nonce: {}", hex(nonce)),
        format!("terms: {digest}"),
        format!("reward_yocto: {}", terms.reward.0),
        format!("issue: {}#{}", terms.repo, terms.issue),
        format!("withdrawal_key: {}", key_text(key)),
        format!("expires_at: {expires_at}"),
        PROOF_TAIL.to_string(),
    ]
    .join("\n")
}

pub fn claim_message(
    network: &str,
    contract: &str,
    wallet: &str,
    bounty: u64,
    github_id: u64,
    key: &PublicKey,
    expires_at: u64,
) -> String {
    [
        "Proven PR bounty withdrawal-key proof v2".to_string(),
        "role: contributor (payout)".to_string(),
        format!("network: {network}"),
        format!("contract: {contract}"),
        format!("actor: {wallet}"),
        format!("bounty: {bounty}"),
        format!("github_id: {github_id}"),
        format!("withdrawal_key: {}", key_text(key)),
        format!("expires_at: {expires_at}"),
        PROOF_TAIL.to_string(),
    ]
    .join("\n")
}

/// Checks a proof's or challenge's expiry when the call starts: in the future, at most one hour
/// ahead.
pub fn check_expiry(expires_at: u64) {
    let now = env::block_timestamp();
    let at = expires_at.saturating_mul(NANOS);
    require!(
        now < at && at <= now.saturating_add(KEY_PROOF_TTL_SECS * NANOS),
        "expires_at must be in the future and at most one hour ahead"
    );
}

fn signature(sig: &Base64VecU8) -> [u8; 64] {
    sig.0
        .as_slice()
        .try_into()
        .unwrap_or_else(|_| env::panic_str("signatures must be 64 bytes"))
}

/// Verifies the withdrawal key's proof over `message`. Panics before any state change.
pub fn verify_key(key: &PublicKey, sig: &Base64VecU8, contract: &str, message: &str) {
    let ok = env::ed25519_verify(
        &signature(sig),
        key_proof_hash(message, contract),
        &ed25519_bytes(key),
    );
    require!(ok, "the withdrawal key's proof does not match");
}

/// The challenge that goes, alone, in the link gist: `proven-link:` + hex SHA-256 of the network,
/// contract, wallet, the wallet's link number and the expiry. It names one wallet and one use.
pub fn link_challenge(
    network: &str,
    contract: &str,
    wallet: &str,
    link_number: u64,
    expires_at: u64,
) -> String {
    let text = format!(
        "proven-pr-bounty-link:v1|{network}|{contract}|{wallet}|{link_number}|{expires_at}"
    );
    format!("proven-link:{}", hex(&env::sha256_array(text.as_bytes())))
}

/// The key that consumes a posting nonce for one maintainer.
pub fn nonce_key(maintainer: &AccountId, nonce: &[u8; 32]) -> [u8; 32] {
    let mut b = Vec::new();
    borsh_str(&mut b, "proven-posting-nonce:v1");
    borsh_str(&mut b, maintainer.as_str());
    b.extend(nonce);
    env::sha256_array(b)
}

/// The key that bars one wallet from claiming one bounty again.
pub fn bar_key(bounty: u64, wallet: &AccountId) -> [u8; 32] {
    let mut b = Vec::new();
    borsh_str(&mut b, "proven-claim-bar:v1");
    b.extend(bounty.to_le_bytes());
    borsh_str(&mut b, wallet.as_str());
    env::sha256_array(b)
}

/// The vault's initial state entries for a key: `f`, `k`, `n`.
pub fn vault_entries(key: &PublicKey) -> [(Vec<u8>, Vec<u8>); 3] {
    [
        (b"f".to_vec(), 0u128.to_le_bytes().to_vec()),
        (b"k".to_vec(), key.as_bytes().to_vec()),
        (b"n".to_vec(), 0u64.to_le_bytes().to_vec()),
    ]
}

/// The vault address of a withdrawal key (NEP-616, code by hash).
pub fn vault_of(code: CryptoHash, key: &PublicKey) -> AccountId {
    ed25519_bytes(key);
    StateInit::V1(StateInitV1 {
        code: GlobalContractId::CodeHash(code),
        data: vault_entries(key).into_iter().collect(),
    })
    .derive_account_id()
}
