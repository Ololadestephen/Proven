//! Recipient key pairs, the messages their NEP-413 key proofs sign, the posting terms digest, the
//! claim challenge (v3) and the vault address. The exact formats are in the design
//! (`.kiro/specs/pr-bounty-vault-settlement/design.md`, "Message formats"); the web page builds
//! the same bytes and is checked against vectors generated from this code.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::state_init::{StateInit, StateInitV1};
use near_sdk::{env, near, require, AccountId, CryptoHash, GlobalContractId, PublicKey};

/// NEP-413's prefix tag, 2^31 + 413.
pub const NEP413_TAG: u32 = 2_147_484_061;
/// The longest a key proof may stay valid (OD-8).
pub const KEY_PROOF_TTL_SECS: u64 = 60 * 60;
const NANOS: u64 = 1_000_000_000;

/// One recipient: an ordered pair of distinct ed25519 keys. Not an account name.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyPair {
    pub primary: PublicKey,
    pub backup: PublicKey,
}

/// What a bounty's posting fixes; covered by the posting terms digest.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PostTerms {
    pub reward: U128,
    pub repo: String,
    pub repo_id: U64,
    pub issue: u64,
    pub base_ref: String,
    pub contributor_github_id: U64,
    pub claim_by: U64,
    pub bind_by: U64,
    pub merge_deadline: U64,
    pub grace_secs: U64,
}

/// The maintainer's two key proofs for one posting.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PostingProof {
    /// 32 bytes as 64 lowercase hex characters, fresh per posting.
    pub nonce: String,
    /// Unix seconds, at most one hour ahead.
    pub expires_at: U64,
    pub primary_signature: Base64VecU8,
    pub backup_signature: Base64VecU8,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Signing {
    Primary,
    Backup,
}

impl Signing {
    pub fn word(self) -> &'static str {
        match self {
            Signing::Primary => "primary",
            Signing::Backup => "backup",
        }
    }
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

/// Checks a key pair's shape: both ed25519, and different.
pub fn check_pair(keys: &KeyPair) {
    let (p, b) = (ed25519_bytes(&keys.primary), ed25519_bytes(&keys.backup));
    require!(p != b, "the backup key must differ from the primary key");
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

/// The canonical bytes of a posting's terms (OD-3).
pub fn terms_bytes(
    network: &str,
    contract: &str,
    maintainer: &str,
    nonce: &[u8; 32],
    terms: &PostTerms,
    keys: &KeyPair,
) -> Vec<u8> {
    let mut out = Vec::new();
    borsh_str(&mut out, "proven-pr-bounty-terms:v1");
    borsh_str(&mut out, network);
    borsh_str(&mut out, contract);
    borsh_str(&mut out, maintainer);
    out.extend(nonce);
    out.extend(terms.reward.0.to_le_bytes());
    borsh_str(&mut out, &terms.repo);
    out.extend(terms.repo_id.0.to_le_bytes());
    out.extend(terms.issue.to_le_bytes());
    borsh_str(&mut out, &terms.base_ref);
    out.extend(terms.contributor_github_id.0.to_le_bytes());
    out.extend(terms.claim_by.0.to_le_bytes());
    out.extend(terms.bind_by.0.to_le_bytes());
    out.extend(terms.merge_deadline.0.to_le_bytes());
    out.extend(terms.grace_secs.0.to_le_bytes());
    out.extend(ed25519_bytes(&keys.primary));
    out.extend(ed25519_bytes(&keys.backup));
    out
}

pub fn terms_digest(
    network: &str,
    contract: &str,
    maintainer: &str,
    nonce: &[u8; 32],
    terms: &PostTerms,
    keys: &KeyPair,
) -> String {
    hex(&env::sha256_array(terms_bytes(
        network, contract, maintainer, nonce, terms, keys,
    )))
}

const PROOF_TAIL: &str = "Either key alone can withdraw everything in the vault.";

#[allow(clippy::too_many_arguments)]
pub fn posting_message(
    network: &str,
    contract: &str,
    maintainer: &str,
    nonce: &[u8; 32],
    terms: &PostTerms,
    keys: &KeyPair,
    expires_at: u64,
    signing: Signing,
) -> String {
    let digest = terms_digest(network, contract, maintainer, nonce, terms, keys);
    [
        "Proven PR bounty key proof v1".to_string(),
        "role: maintainer".to_string(),
        format!("network: {network}"),
        format!("contract: {contract}"),
        format!("actor: {maintainer}"),
        format!("nonce: {}", hex(nonce)),
        format!("terms: {digest}"),
        format!("reward_yocto: {}", terms.reward.0),
        format!("issue: {}#{}", terms.repo, terms.issue),
        format!("signing: {}", signing.word()),
        format!("primary: {}", key_text(&keys.primary)),
        format!("backup: {}", key_text(&keys.backup)),
        format!("expires_at: {expires_at}"),
        PROOF_TAIL.to_string(),
    ]
    .join("\n")
}

#[allow(clippy::too_many_arguments)]
pub fn claim_message(
    network: &str,
    contract: &str,
    wallet: &str,
    bounty: u64,
    github_id: u64,
    keys: &KeyPair,
    expires_at: u64,
    signing: Signing,
) -> String {
    [
        "Proven PR bounty key proof v1".to_string(),
        "role: contributor".to_string(),
        format!("network: {network}"),
        format!("contract: {contract}"),
        format!("actor: {wallet}"),
        format!("bounty: {bounty}"),
        format!("github_id: {github_id}"),
        format!("signing: {}", signing.word()),
        format!("primary: {}", key_text(&keys.primary)),
        format!("backup: {}", key_text(&keys.backup)),
        format!("expires_at: {expires_at}"),
        PROOF_TAIL.to_string(),
    ]
    .join("\n")
}

/// Checks a key proof's expiry when the call starts: in the future, at most one hour ahead.
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

/// Verifies both key proofs: the primary key over its `signing: primary` text, the backup key
/// over its `signing: backup` text. `message` builds the text for a given signing key.
pub fn verify_pair(
    keys: &KeyPair,
    primary_signature: &Base64VecU8,
    backup_signature: &Base64VecU8,
    contract: &str,
    message: impl Fn(Signing) -> String,
) {
    check_pair(keys);
    let (p, b) = (signature(primary_signature), signature(backup_signature));
    let ok_p = env::ed25519_verify(
        &p,
        key_proof_hash(&message(Signing::Primary), contract),
        &ed25519_bytes(&keys.primary),
    );
    require!(ok_p, "the primary key's proof does not match");
    let ok_b = env::ed25519_verify(
        &b,
        key_proof_hash(&message(Signing::Backup), contract),
        &ed25519_bytes(&keys.backup),
    );
    require!(ok_b, "the backup key's proof does not match");
}

/// SHA-256 of the ordered key pair, in the claim challenge.
pub fn key_pair_digest(keys: &KeyPair) -> String {
    let mut b = Vec::new();
    borsh_str(&mut b, "proven-key-pair:v1");
    b.extend(ed25519_bytes(&keys.primary));
    b.extend(ed25519_bytes(&keys.backup));
    hex(&env::sha256_array(b))
}

/// Everything a claim challenge binds besides the key pair.
pub struct ClaimBinding<'a> {
    pub network: &'a str,
    pub contract: &'a str,
    pub bounty: u64,
    pub repo: &'a str,
    pub repo_id: u64,
    pub issue: u64,
    pub wallet: &'a str,
    pub github_id: u64,
    pub expires_at: u64,
}

/// Challenge v3: `proven-claim:` + hex SHA-256 of everything the claim binds, including the
/// ordered key pair's digest. Same shape as before, so the verifier is unchanged.
pub fn challenge(c: &ClaimBinding, keys: &KeyPair) -> String {
    let text = format!(
        "proven-pr-bounty-claim:v3|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        c.network,
        c.contract,
        c.bounty,
        c.repo,
        c.repo_id,
        c.issue,
        c.wallet,
        c.github_id,
        c.expires_at,
        key_pair_digest(keys),
    );
    format!("proven-claim:{}", hex(&env::sha256_array(text.as_bytes())))
}

/// The key that consumes a posting nonce for one maintainer.
pub fn nonce_key(maintainer: &AccountId, nonce: &[u8; 32]) -> [u8; 32] {
    let mut b = Vec::new();
    borsh_str(&mut b, "proven-posting-nonce:v1");
    borsh_str(&mut b, maintainer.as_str());
    b.extend(nonce);
    env::sha256_array(b)
}

/// The vault's initial state entries for a key pair: `b`, `f`, `k`, `n`.
pub fn vault_entries(keys: &KeyPair) -> [(Vec<u8>, Vec<u8>); 4] {
    [
        (b"b".to_vec(), keys.backup.as_bytes().to_vec()),
        (b"f".to_vec(), 0u128.to_le_bytes().to_vec()),
        (b"k".to_vec(), keys.primary.as_bytes().to_vec()),
        (b"n".to_vec(), 0u64.to_le_bytes().to_vec()),
    ]
}

/// The vault address of a key pair (NEP-616, code by hash).
pub fn vault_of(code: CryptoHash, keys: &KeyPair) -> AccountId {
    StateInit::V1(StateInitV1 {
        code: GlobalContractId::CodeHash(code),
        data: vault_entries(keys).into_iter().collect(),
    })
    .derive_account_id()
}
