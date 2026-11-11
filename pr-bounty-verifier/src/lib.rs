//! Proven PR bounty verifier: the facts a PR merge bounty contract needs from GitHub's public REST
//! API, bound to the contract's request.
//!
//! Three request shapes, each answered with one compact JSON line (output version 4):
//!
//! - `pull`: `GET /repos/<owner>/<name>/pulls/<number>`, giving the base repository id, the pull
//!   request id and number, the author id, the base branch, the state, the merge flag and
//!   `merged_at` in Unix seconds (the probe verifier's parser, unchanged);
//! - `pull` with a `gist_id` and `challenge`: both reads in one run, so a submission is checked
//!   against the wallet's GitHub link at the same moment as the pull request;
//! - `gist`: `GET /gists/<id>`, giving the gist's owner id, how many files it has, and whether it
//!   has exactly one complete file whose text is exactly the claim challenge the contract sent.
//!   Only a gist's owner can change it, so, unlike an issue comment, a repository's writers
//!   cannot put words in a contributor's gist.
//!
//! Every request goes to the fixed host `api.github.com` without a credential, follows no
//! redirect and reads a bounded body. The answer echoes the network, contract, bounty, request
//! sequence number, operation and target, plus the worker's predecessor and request id. It never
//! prints a gist's text, a title, a description or GitHub's error text, and it judges nothing:
//! the contract decides.

use serde::Deserialize;
use serde_json::{json, Value};

/// The probe verifier's parsing, status rules and limits, compiled in from its own unchanged
/// source, so its published build (bb6c733f…) keeps its bytes and this build has no path
/// dependency whose location would change the output.
#[path = "../../pr-verifier/src/lib.rs"]
pub mod probe;

pub use probe::{
    check_status, parse_pull, Facts as PullFacts, Reason, RunContext, API_HOST,
    BETWEEN_BYTES_TIMEOUT_SECS, CONNECT_TIMEOUT_SECS, FIRST_BYTE_TIMEOUT_SECS, MAX_BODY_BYTES,
    MAX_REQUEST_BYTES, USER_AGENT,
};
use probe::{is_account_id, is_repo};

pub const OUTPUT_VERSION: u32 = 4;
/// The longest answer this program prints; the contract reads at most this many bytes. The
/// largest real answer is a submission with both facts, the longest names and a 255-byte base
/// branch made only of characters JSON escapes (`"` or `\`), about 1,340 bytes: every branch name
/// a maintainer can choose fits. An answer that would still be longer is replaced by a bound
/// `no_result:oversized` (see `render`), so the contract never sees an unreadable answer.
pub const MAX_ANSWER_BYTES: usize = 1536;
pub const OUTPUT_KIND: &str = "proven-pr-bounty-facts";
pub const CHALLENGE_PREFIX: &str = "proven-link:";
const CHALLENGE_HEX_LEN: usize = 64;
const MAX_GIST_ID_LEN: usize = 64;

/// What the contract asks for. Unknown members are refused; each operation takes only its own.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRequest {
    v: u32,
    network: String,
    contract: String,
    bounty: u64,
    seq: u64,
    op: String,
    repo: String,
    number: Option<u64>,
    gist_id: Option<String>,
    challenge: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Pull {
        number: u64,
    },
    /// A pull request and, in the same run, the gist that links the submitting wallet to its
    /// GitHub account. Both facts are read at the same moment.
    PullGist {
        number: u64,
        gist_id: String,
        challenge: String,
    },
    Gist {
        gist_id: String,
        challenge: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub network: String,
    pub contract: String,
    pub bounty: u64,
    pub seq: u64,
    pub repo: String,
    pub op: Op,
}

/// The facts read from a claim gist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GistFacts {
    /// `owner.id`: the account that owns the gist, the only one that can change it.
    pub owner_id: u64,
    /// How many files the gist has. A claim needs exactly one.
    pub files: u32,
    /// The gist has exactly one file, not truncated, whose whole text (trimmed of surrounding
    /// whitespace) equals the challenge.
    pub challenge_matches: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Pull(PullFacts),
    PullGist(PullFacts, GistFacts),
    Gist(GistFacts),
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Reason> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(Reason::BadRequest);
    }
    let raw: RawRequest = serde_json::from_slice(bytes).map_err(|_| Reason::BadRequest)?;
    let common = raw.v == OUTPUT_VERSION
        && matches!(raw.network.as_str(), "testnet" | "mainnet")
        && is_account_id(&raw.contract)
        && is_repo(&raw.repo);
    if !common {
        return Err(Reason::BadRequest);
    }
    let op = match (raw.op.as_str(), raw.number, raw.gist_id, raw.challenge) {
        ("pull", Some(number), None, None) if (1..=u64::from(u32::MAX)).contains(&number) => {
            Op::Pull { number }
        }
        ("pull", Some(number), Some(gist_id), Some(challenge))
            if (1..=u64::from(u32::MAX)).contains(&number)
                && is_gist_id(&gist_id)
                && is_challenge(&challenge) =>
        {
            Op::PullGist {
                number,
                gist_id,
                challenge,
            }
        }
        ("gist", None, Some(gist_id), Some(challenge))
            if is_gist_id(&gist_id) && is_challenge(&challenge) =>
        {
            Op::Gist { gist_id, challenge }
        }
        _ => return Err(Reason::BadRequest),
    };
    Ok(Request {
        network: raw.network,
        contract: raw.contract,
        bounty: raw.bounty,
        seq: raw.seq,
        repo: raw.repo,
        op,
    })
}

/// `proven-link:` followed by 64 lowercase hex characters.
pub fn is_challenge(value: &str) -> bool {
    value.strip_prefix(CHALLENGE_PREFIX).is_some_and(|hex| {
        hex.len() == CHALLENGE_HEX_LEN
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// A gist id as GitHub issues them: lowercase hex (older gists have decimal ids, also hex digits).
pub fn is_gist_id(value: &str) -> bool {
    (1..=MAX_GIST_ID_LEN).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn pull_path(repo: &str, number: u64) -> String {
    format!("/repos/{repo}/pulls/{number}")
}

pub fn gist_path(gist_id: &str) -> String {
    format!("/gists/{gist_id}")
}

/// The facts of one gist, from `GET /gists/<id>`. GitHub's answer must be about the gist asked
/// for, with a known owner and a complete file list; every file must be complete.
pub fn parse_gist(body: &[u8], gist_id: &str, challenge: &str) -> Result<GistFacts, Reason> {
    if body.len() > MAX_BODY_BYTES {
        return Err(Reason::Oversized);
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| Reason::Malformed)?;
    if !value.is_object() {
        return Err(Reason::Malformed);
    }
    match &value["id"] {
        Value::Null => return Err(Reason::Incomplete),
        Value::String(id) if id == gist_id => {}
        _ => return Err(Reason::Malformed),
    }
    let owner_id = match &value["owner"] {
        Value::Null => return Err(Reason::Incomplete),
        owner => match &owner["id"] {
            Value::Null => return Err(Reason::Incomplete),
            id => id.as_u64().filter(|n| *n > 0).ok_or(Reason::Malformed)?,
        },
    };
    // A list GitHub cut short is not the whole gist.
    match &value["truncated"] {
        Value::Bool(false) | Value::Null => {}
        _ => return Err(Reason::Malformed),
    }
    let files = match &value["files"] {
        Value::Null => return Err(Reason::Incomplete),
        Value::Object(files) => files,
        _ => return Err(Reason::Malformed),
    };
    let mut texts = Vec::with_capacity(files.len());
    for file in files.values() {
        let complete = matches!(file["truncated"], Value::Bool(false));
        match (&file["content"], complete) {
            (Value::String(text), true) => texts.push(text.as_str()),
            (Value::Null, _) => return Err(Reason::Incomplete),
            _ => return Err(Reason::Malformed),
        }
    }
    let count = u32::try_from(texts.len()).map_err(|_| Reason::Malformed)?;
    Ok(GistFacts {
        owner_id,
        files: count,
        challenge_matches: count == 1 && texts[0].trim() == challenge,
    })
}

/// The one line this program prints. A request that could not be read is answered without a
/// binding, which the contract refuses. Never longer than `MAX_ANSWER_BYTES`.
pub fn render(
    request: Option<&Request>,
    context: &RunContext,
    result: Result<Answer, Reason>,
) -> String {
    render_capped(request, context, result, MAX_ANSWER_BYTES)
}

/// `render` with an explicit cap: an answer longer than `cap` becomes the bound
/// `no_result:oversized` answer for the same request.
#[doc(hidden)]
pub fn render_capped(
    request: Option<&Request>,
    context: &RunContext,
    result: Result<Answer, Reason>,
    cap: usize,
) -> String {
    let line = render_line(request, context, result);
    if line.len() <= cap {
        line
    } else {
        render_line(request, context, Err(Reason::Oversized))
    }
}

fn render_line(
    request: Option<&Request>,
    context: &RunContext,
    result: Result<Answer, Reason>,
) -> String {
    let mut out = json!({
        "v": OUTPUT_VERSION,
        "kind": OUTPUT_KIND,
        "predecessor": context.predecessor,
        "request_id": context.request_id,
    });
    if let Some(request) = request {
        out["network"] = json!(request.network);
        out["contract"] = json!(request.contract);
        out["bounty"] = json!(request.bounty);
        out["seq"] = json!(request.seq);
        out["repo"] = json!(request.repo);
        match &request.op {
            Op::Pull { number } => {
                out["op"] = json!("pull");
                out["number"] = json!(number);
            }
            Op::PullGist {
                number, gist_id, ..
            } => {
                out["op"] = json!("pull");
                out["number"] = json!(number);
                out["gist_id"] = json!(gist_id);
            }
            Op::Gist { gist_id, .. } => {
                out["op"] = json!("gist");
                out["gist_id"] = json!(gist_id);
            }
        }
    }
    match result {
        Ok(Answer::Pull(f)) => {
            out["status"] = json!("ok");
            out["pull"] = json!({
                "repo_id": f.repo_id, "pr_id": f.pr_id, "pr_number": f.pr_number,
                "author_id": f.author_id, "base_ref": f.base_ref, "state": f.state,
                "merged": f.merged, "merged_at": f.merged_at,
            });
        }
        Ok(Answer::PullGist(p, g)) => {
            out["status"] = json!("ok");
            out["pull"] = json!({
                "repo_id": p.repo_id, "pr_id": p.pr_id, "pr_number": p.pr_number,
                "author_id": p.author_id, "base_ref": p.base_ref, "state": p.state,
                "merged": p.merged, "merged_at": p.merged_at,
            });
            out["gist"] = json!({
                "owner_id": g.owner_id, "files": g.files, "challenge_matches": g.challenge_matches,
            });
        }
        Ok(Answer::Gist(f)) => {
            out["status"] = json!("ok");
            out["gist"] = json!({
                "owner_id": f.owner_id, "files": f.files, "challenge_matches": f.challenge_matches,
            });
        }
        Err(reason) => {
            out["status"] = json!("no_result");
            out["reason"] = json!(reason.code());
        }
    }
    out.to_string()
}
