//! Reading the verifier's answer: size, shape and binding. Anything that is not the verifier's
//! well-formed answer to this exact request becomes a `no_result:` outcome, never a verdict.

use near_sdk::serde::Deserialize;
use near_sdk::serde_json;
use near_sdk::{AccountId, PromiseError};

/// The verifier never prints more than this (its `MAX_ANSWER_BYTES`): its worst real answer, a
/// submission with the longest names and a 255-byte branch of escaped characters, is 1,333
/// bytes, and anything longer it replaces with a bound `no_result:oversized`.
pub const MAX_OUTPUT_BYTES: usize = 1536;
const OUTPUT_VERSION: u32 = 4;
const OUTPUT_KIND: &str = "proven-pr-bounty-facts";
const MAX_REF_LEN: usize = 255;
/// The verifier's own no-result codes. Any other is treated as a malformed answer.
const VERIFIER_REASONS: [&str; 12] = [
    "bad_request",
    "timeout",
    "unreachable",
    "rate_limited",
    "forbidden",
    "not_found",
    "redirect",
    "upstream_unavailable",
    "upstream_status",
    "oversized",
    "malformed",
    "incomplete",
];

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct Raw {
    v: u32,
    kind: String,
    predecessor: Option<AccountId>,
    request_id: Option<u64>,
    network: Option<String>,
    contract: Option<AccountId>,
    bounty: Option<u64>,
    seq: Option<u64>,
    repo: Option<String>,
    op: Option<String>,
    number: Option<u64>,
    gist_id: Option<String>,
    status: String,
    pull: Option<PullFacts>,
    gist: Option<GistFacts>,
    reason: Option<String>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PullFacts {
    pub repo_id: u64,
    pub pr_id: u64,
    pub pr_number: u64,
    pub author_id: u64,
    pub base_ref: String,
    pub state: String,
    pub merged: bool,
    pub merged_at: Option<u64>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct GistFacts {
    pub owner_id: u64,
    pub files: u32,
    pub challenge_matches: bool,
}

/// What the request asked for, so the answer can be checked against it.
#[derive(Clone, Copy)]
pub enum Parsed<'a> {
    Pull(u64),
    /// A submission: the pull request and the wallet's link gist, read in one run.
    PullGist(u64, &'a str),
    Gist(&'a str),
}

impl Parsed<'_> {
    pub fn pull(number: u64) -> Self {
        Parsed::Pull(number)
    }
}

pub struct Answer {
    pub request_id: u64,
    pub pull: Option<PullFacts>,
    pub gist: Option<GistFacts>,
}

fn no_result(reason: &str) -> String {
    format!("no_result:{reason}")
}

/// The verifier's facts, if `result` is its well-formed answer to exactly this request. The
/// error is the outcome to record.
#[allow(clippy::too_many_arguments)]
pub fn parse(
    result: &Result<Vec<u8>, PromiseError>,
    network: &str,
    contract: &AccountId,
    bounty: u64,
    seq: u64,
    repo: &str,
    asked: Parsed<'_>,
) -> Result<Answer, String> {
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(PromiseError::TooLong(_)) => return Err(no_result("oversized")),
        Err(_) => return Err(no_result("promise_failed")),
    };
    if bytes.as_slice() == b"null" {
        return Err(no_result("no_output"));
    }
    let raw: Raw = serde_json::from_slice(bytes).map_err(|_| no_result("malformed"))?;
    if raw.v != OUTPUT_VERSION || raw.kind != OUTPUT_KIND {
        return Err(no_result("malformed"));
    }
    let (op, target) = match asked {
        Parsed::Pull(number) => ("pull", raw.number == Some(number) && raw.gist_id.is_none()),
        Parsed::PullGist(number, id) => (
            "pull",
            raw.number == Some(number) && raw.gist_id.as_deref() == Some(id),
        ),
        Parsed::Gist(id) => (
            "gist",
            raw.gist_id.as_deref() == Some(id) && raw.number.is_none(),
        ),
    };
    let bound = raw.predecessor.as_ref() == Some(contract)
        && raw.contract.as_ref() == Some(contract)
        && raw.network.as_deref() == Some(network)
        && raw.bounty == Some(bounty)
        && raw.seq == Some(seq)
        && raw.repo.as_deref() == Some(repo)
        && raw.op.as_deref() == Some(op)
        && target
        && raw.request_id.is_some();
    if !bound {
        return Err(no_result("wrong_binding"));
    }
    let request_id = raw.request_id.unwrap_or_default();
    match (raw.status.as_str(), raw.reason, raw.pull, raw.gist, asked) {
        ("no_result", Some(reason), None, None, _)
            if VERIFIER_REASONS.contains(&reason.as_str()) =>
        {
            Err(no_result(&reason))
        }
        ("ok", None, Some(pull), gist, asked @ (Parsed::Pull(_) | Parsed::PullGist(..)))
            if gist.is_some() == matches!(asked, Parsed::PullGist(..)) =>
        {
            let consistent = matches!(pull.state.as_str(), "open" | "closed")
                && !pull.base_ref.is_empty()
                && pull.base_ref.len() <= MAX_REF_LEN
                && pull.merged == pull.merged_at.is_some()
                && !(pull.merged && pull.state == "open");
            if !consistent {
                return Err(no_result("malformed"));
            }
            Ok(Answer {
                request_id,
                pull: Some(pull),
                gist,
            })
        }
        ("ok", None, None, Some(gist), Parsed::Gist(_)) => Ok(Answer {
            request_id,
            pull: None,
            gist: Some(gist),
        }),
        _ => Err(no_result("malformed")),
    }
}
