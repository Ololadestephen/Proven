//! Proven PR bounty verifier: the facts a PR merge bounty contract needs from GitHub's public REST
//! API, bound to the contract's request.
//!
//! Two operations, each answered with one compact JSON line:
//!
//! - `pull`: `GET /repos/<owner>/<name>/pulls/<number>`, giving the base repository id, the pull
//!   request id and number, the author id, the base branch, the state, the merge flag and
//!   `merged_at` in Unix seconds (the probe verifier's parser, unchanged);
//! - `comment`: `GET /repos/<owner>/<name>` for the repository id, then
//!   `GET /repos/<owner>/<name>/issues/comments/<id>`, giving the comment id, the author id, the
//!   issue it is on, its creation and update times, and whether its whole text is exactly the
//!   claim challenge the contract sent.
//!
//! Every request goes to the fixed host `api.github.com` without a credential, follows no
//! redirect and reads a bounded body (see `proven_pr_verifier`). The answer echoes the network,
//! contract, bounty, request sequence number, operation and target, plus the worker's predecessor
//! and request id. It never prints the comment text, a title, a description or GitHub's error text,
//! and it judges nothing: the contract decides.

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
use probe::{is_account_id, is_repo, unix_seconds};

pub const OUTPUT_VERSION: u32 = 2;
pub const OUTPUT_KIND: &str = "proven-pr-bounty-facts";
pub const CHALLENGE_PREFIX: &str = "proven-claim:";
const CHALLENGE_HEX_LEN: usize = 64;

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
    comment_id: Option<u64>,
    challenge: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Pull { number: u64 },
    Comment { comment_id: u64, challenge: String },
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

/// The facts read from a claim comment and its repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentFacts {
    pub repo_id: u64,
    pub comment_id: u64,
    pub author_id: u64,
    pub issue_number: u64,
    pub created_at: u64,
    pub updated_at: u64,
    /// The comment's whole text, trimmed of surrounding whitespace, equals the challenge.
    pub challenge_matches: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Pull(PullFacts),
    Comment(CommentFacts),
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
    let op = match (raw.op.as_str(), raw.number, raw.comment_id, raw.challenge) {
        ("pull", Some(number), None, None) if (1..=u64::from(u32::MAX)).contains(&number) => {
            Op::Pull { number }
        }
        ("comment", None, Some(comment_id), Some(challenge))
            if comment_id > 0 && is_challenge(&challenge) =>
        {
            Op::Comment {
                comment_id,
                challenge,
            }
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

/// `proven-claim:` followed by 64 lowercase hex characters.
pub fn is_challenge(value: &str) -> bool {
    value.strip_prefix(CHALLENGE_PREFIX).is_some_and(|hex| {
        hex.len() == CHALLENGE_HEX_LEN
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub fn pull_path(repo: &str, number: u64) -> String {
    format!("/repos/{repo}/pulls/{number}")
}

pub fn repo_path(repo: &str) -> String {
    format!("/repos/{repo}")
}

pub fn comment_path(repo: &str, comment_id: u64) -> String {
    format!("/repos/{repo}/issues/comments/{comment_id}")
}

/// The repository's stable id, from `GET /repos/<owner>/<name>`. A private repository, or one
/// whose canonical name differs from the one asked for, is malformed.
pub fn parse_repo(body: &[u8], repo: &str) -> Result<u64, Reason> {
    let value = object(body)?;
    let id = id(&value["id"])?;
    let full_name = text(&value["full_name"])?;
    let private = flag(&value["private"])?;
    if private || !full_name.eq_ignore_ascii_case(repo) {
        return Err(Reason::Malformed);
    }
    Ok(id)
}

/// The facts of one issue comment, from `GET /repos/<owner>/<name>/issues/comments/<id>`. The
/// comment must sit on an issue of `repo`, by GitHub's own `issue_url`.
pub fn parse_comment(
    body: &[u8],
    repo_id: u64,
    repo: &str,
    challenge: &str,
) -> Result<CommentFacts, Reason> {
    let value = object(body)?;
    let issue_url = text(&value["issue_url"])?;
    let prefix = format!("https://{API_HOST}/repos/{repo}/issues/");
    let issue_number = match issue_url.get(..prefix.len()) {
        Some(head) if head.eq_ignore_ascii_case(&prefix) => {
            let tail = &issue_url[prefix.len()..];
            if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Reason::Malformed);
            }
            tail.parse::<u64>().map_err(|_| Reason::Malformed)?
        }
        _ => return Err(Reason::Malformed),
    };
    let body_text = match &value["body"] {
        Value::Null => return Err(Reason::Incomplete),
        Value::String(s) => s.as_str(),
        _ => return Err(Reason::Malformed),
    };
    let facts = CommentFacts {
        repo_id,
        comment_id: id(&value["id"])?,
        author_id: id(&value["user"]["id"])?,
        issue_number,
        created_at: time(&value["created_at"])?,
        updated_at: time(&value["updated_at"])?,
        challenge_matches: body_text.trim() == challenge,
    };
    if issue_number == 0 || facts.updated_at < facts.created_at {
        return Err(Reason::Malformed);
    }
    Ok(facts)
}

/// The one line this program prints. A request that could not be read is answered without a
/// binding, which the contract refuses.
pub fn render(
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
            Op::Comment { comment_id, .. } => {
                out["op"] = json!("comment");
                out["comment_id"] = json!(comment_id);
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
        Ok(Answer::Comment(f)) => {
            out["status"] = json!("ok");
            out["comment"] = json!({
                "repo_id": f.repo_id, "comment_id": f.comment_id, "author_id": f.author_id,
                "issue_number": f.issue_number, "created_at": f.created_at,
                "updated_at": f.updated_at, "challenge_matches": f.challenge_matches,
            });
        }
        Err(reason) => {
            out["status"] = json!("no_result");
            out["reason"] = json!(reason.code());
        }
    }
    out.to_string()
}

fn object(body: &[u8]) -> Result<Value, Reason> {
    if body.len() > MAX_BODY_BYTES {
        return Err(Reason::Oversized);
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| Reason::Malformed)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(Reason::Malformed)
    }
}

fn id(value: &Value) -> Result<u64, Reason> {
    match value {
        Value::Null => Err(Reason::Incomplete),
        Value::Number(_) => value.as_u64().filter(|n| *n > 0).ok_or(Reason::Malformed),
        _ => Err(Reason::Malformed),
    }
}

fn text(value: &Value) -> Result<String, Reason> {
    match value {
        Value::Null => Err(Reason::Incomplete),
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        _ => Err(Reason::Malformed),
    }
}

fn flag(value: &Value) -> Result<bool, Reason> {
    match value {
        Value::Null => Err(Reason::Incomplete),
        Value::Bool(b) => Ok(*b),
        _ => Err(Reason::Malformed),
    }
}

fn time(value: &Value) -> Result<u64, Reason> {
    match value {
        Value::Null => Err(Reason::Incomplete),
        Value::String(s) => unix_seconds(s).ok_or(Reason::Malformed),
        _ => Err(Reason::Malformed),
    }
}
