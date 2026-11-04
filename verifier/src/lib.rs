//! Proven verifier.
//!
//! Two modes, both deterministic (no clock, no network, no randomness):
//! - `verify` runs a buyer's acceptance check on one deliverable and says pass or fail.
//! - `challenge` generates planted fakes from the buyer's reference itself, then runs the check on
//!   the reference and on every fake. A fake counts only if it is confirmed wrong; the check is
//!   accepted only if it passes the reference, there are at least `MIN_FAKES` confirmed fakes, and
//!   it rejects every one of them.
//!
//! The check, the deliverable and the reference arrive as exact file texts, and the verifier
//! hashes those texts itself, so its output names exactly what it judged. Only the rules decide:
//! nothing a deliverable says about itself is read as a result, and no deliverable text is ever
//! copied into the output.

mod check;
mod data;
pub mod fakes;
mod function;
pub mod run;

use sha2::{Digest, Sha256};

/// The id of the first rule a deliverable failed, or `format` if it could not be read at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedRule(pub String);

impl FailedRule {
    fn format() -> Self {
        Self("format".to_string())
    }
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
