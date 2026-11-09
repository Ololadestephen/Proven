//! Proven PR verifier: reads one pull request from GitHub's public REST API and reports the facts a
//! merge bounty needs, bound to the request that asked for them.
//!
//! The request names a repository (`owner/name`) and a pull request number, plus the caller and
//! reading it answers. The program sends one unauthenticated `GET` to the fixed host
//! `api.github.com`, follows no redirect, reads at most [`MAX_BODY_BYTES`] of the answer and prints
//! one compact JSON line:
//!
//! - `"status":"ok"` with `facts`: the base repository's id, the pull request's id and number, the
//!   author's id, the base branch, the state, the merge flag and `merged_at` in Unix seconds;
//! - `"status":"no_result"` with a fixed `reason` code, when GitHub could not be read or its
//!   answer lacks or garbles a required field.
//!
//! It never prints the title, the description or GitHub's error text. It judges nothing: whether
//! the facts satisfy a bounty is the calling contract's decision. This file is the pure part and
//! builds natively for tests; `main.rs` adds the WASI HTTP call.

use serde::Deserialize;
use serde_json::{json, Value};

/// The only host this program talks to. The embedded manifest makes OutLayer enforce it too.
pub const API_HOST: &str = "api.github.com";
/// GitHub's pull request object is about 17 KB plus its description, which GitHub caps at 65,536
/// characters; even fully escaped that stays under this.
pub const MAX_BODY_BYTES: usize = 512 * 1024;
pub const MAX_REQUEST_BYTES: usize = 4096;
pub const OUTPUT_VERSION: u32 = 1;
pub const OUTPUT_KIND: &str = "proven-pr-facts";
pub const CONNECT_TIMEOUT_SECS: u64 = 10;
pub const FIRST_BYTE_TIMEOUT_SECS: u64 = 15;
pub const BETWEEN_BYTES_TIMEOUT_SECS: u64 = 10;
pub const USER_AGENT: &str = "proven-pr-verifier/0.1";
const MAX_ACCOUNT_LEN: usize = 64;
const MAX_OWNER_LEN: usize = 39;
const MAX_NAME_LEN: usize = 100;
const MAX_REF_LEN: usize = 255;

/// What the caller asks for. Unknown members are refused.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    /// The contract the answer is for. On chain it must equal the run's predecessor.
    pub probe: String,
    /// The caller's own reading index, echoed so a result cannot be applied to another reading.
    pub reading: u32,
    pub repo: String,
    pub number: u64,
}

/// Why there is no result. Each is a fixed code; nothing GitHub wrote is passed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    BadRequest,
    Timeout,
    Unreachable,
    RateLimited,
    Forbidden,
    NotFound,
    Redirect,
    UpstreamUnavailable,
    UpstreamStatus,
    Oversized,
    Malformed,
    Incomplete,
}

impl Reason {
    pub fn code(self) -> &'static str {
        match self {
            Reason::BadRequest => "bad_request",
            Reason::Timeout => "timeout",
            Reason::Unreachable => "unreachable",
            Reason::RateLimited => "rate_limited",
            Reason::Forbidden => "forbidden",
            Reason::NotFound => "not_found",
            Reason::Redirect => "redirect",
            Reason::UpstreamUnavailable => "upstream_unavailable",
            Reason::UpstreamStatus => "upstream_status",
            Reason::Oversized => "oversized",
            Reason::Malformed => "malformed",
            Reason::Incomplete => "incomplete",
        }
    }
}

/// The facts read from GitHub's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// `base.repo.id`: the repository the pull request targets.
    pub repo_id: u64,
    pub pr_id: u64,
    pub pr_number: u64,
    /// `user.id`: the account that opened the pull request.
    pub author_id: u64,
    pub base_ref: String,
    /// `open` or `closed`.
    pub state: String,
    pub merged: bool,
    /// `merged_at` in Unix seconds; present exactly when `merged` is true.
    pub merged_at: Option<u64>,
}

/// What the worker says about the run, from its environment. Empty values are absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunContext {
    pub predecessor: Option<String>,
    pub request_id: Option<u64>,
}

impl RunContext {
    pub fn from_vars(predecessor: Option<String>, request_id: Option<String>) -> Self {
        Self {
            predecessor: predecessor.filter(|p| is_account_id(p)),
            request_id: request_id.and_then(|id| id.parse().ok()),
        }
    }
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, Reason> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(Reason::BadRequest);
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|_| Reason::BadRequest)?;
    let valid = request.v == OUTPUT_VERSION
        && is_account_id(&request.probe)
        && is_repo(&request.repo)
        && request.number > 0
        && request.number <= u64::from(u32::MAX);
    if valid {
        Ok(request)
    } else {
        Err(Reason::BadRequest)
    }
}

/// The path of the one request this program makes.
pub fn api_path(request: &Request) -> String {
    format!("/repos/{}/pulls/{}", request.repo, request.number)
}

/// Turns the response status into a reason, before any body is read. Redirects are never followed:
/// GitHub answers 301 for a renamed or transferred repository, and that is no result.
pub fn check_status(
    status: u16,
    rate_limit_remaining: Option<&str>,
    retry_after: Option<&str>,
) -> Result<(), Reason> {
    match status {
        200 => Ok(()),
        301 | 302 | 303 | 307 | 308 => Err(Reason::Redirect),
        404 | 410 => Err(Reason::NotFound),
        429 => Err(Reason::RateLimited),
        403 if rate_limit_remaining.map(str::trim) == Some("0") || retry_after.is_some() => {
            Err(Reason::RateLimited)
        }
        403 => Err(Reason::Forbidden),
        500..=599 => Err(Reason::UpstreamUnavailable),
        _ => Err(Reason::UpstreamStatus),
    }
}

/// Reads the facts out of GitHub's pull request object. A required member that is missing or
/// null is `incomplete`; one of the wrong type or inconsistent with the others is `malformed`.
pub fn parse_pull(body: &[u8]) -> Result<Facts, Reason> {
    if body.len() > MAX_BODY_BYTES {
        return Err(Reason::Oversized);
    }
    let pull: Value = serde_json::from_slice(body).map_err(|_| Reason::Malformed)?;
    if !pull.is_object() {
        return Err(Reason::Malformed);
    }
    let base = &pull["base"];
    let facts = Facts {
        repo_id: id(&base["repo"]["id"])?,
        pr_id: id(&pull["id"])?,
        pr_number: id(&pull["number"])?,
        author_id: id(&pull["user"]["id"])?,
        base_ref: text(&base["ref"])?,
        state: text(&pull["state"])?,
        merged: flag(&pull["merged"])?,
        merged_at: match &pull["merged_at"] {
            Value::Null => None,
            Value::String(at) => Some(unix_seconds(at).ok_or(Reason::Malformed)?),
            _ => return Err(Reason::Malformed),
        },
    };
    if facts.base_ref.len() > MAX_REF_LEN || facts.base_ref.chars().any(char::is_control) {
        return Err(Reason::Malformed);
    }
    match (facts.state.as_str(), facts.merged, facts.merged_at) {
        (_, true, None) => Err(Reason::Incomplete),
        ("open", true, _) | (_, false, Some(_)) => Err(Reason::Malformed),
        ("open" | "closed", _, _) => Ok(facts),
        _ => Err(Reason::Malformed),
    }
}

/// The one line this program prints. A request that could not be read is answered without a
/// binding, which no caller accepts.
pub fn render(
    request: Option<&Request>,
    context: &RunContext,
    result: Result<Facts, Reason>,
) -> String {
    let mut out = json!({
        "v": OUTPUT_VERSION,
        "kind": OUTPUT_KIND,
        "predecessor": context.predecessor,
        "request_id": context.request_id,
    });
    if let Some(request) = request {
        out["probe"] = json!(request.probe);
        out["reading"] = json!(request.reading);
        out["repo"] = json!(request.repo);
        out["number"] = json!(request.number);
    }
    match result {
        Ok(facts) => {
            out["status"] = json!("ok");
            out["facts"] = json!({
                "repo_id": facts.repo_id,
                "pr_id": facts.pr_id,
                "pr_number": facts.pr_number,
                "author_id": facts.author_id,
                "base_ref": facts.base_ref,
                "state": facts.state,
                "merged": facts.merged,
                "merged_at": facts.merged_at,
            });
        }
        Err(reason) => {
            out["status"] = json!("no_result");
            out["reason"] = json!(reason.code());
        }
    }
    out.to_string()
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

/// Parses GitHub's timestamp form, `YYYY-MM-DDTHH:MM:SSZ`, and nothing else.
pub fn unix_seconds(at: &str) -> Option<u64> {
    let b = at.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    if b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<u64> {
        let digits = &at[from..to];
        if digits.bytes().all(|c| c.is_ascii_digit()) {
            digits.parse().ok()
        } else {
            None
        }
    };
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || day == 0
        || day > month_days[(month - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Days from 1970-01-01 to the given civil date (Howard Hinnant's algorithm).
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = y / 400;
    let year_of_era = y - era * 400;
    let day_of_year = (153 * m + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// A NEAR account id: 2 to 64 characters of lowercase letters, digits and `-_.`.
pub fn is_account_id(value: &str) -> bool {
    (2..=MAX_ACCOUNT_LEN).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
}

/// `owner/name` with GitHub's character sets, so the path can hold nothing else.
pub fn is_repo(value: &str) -> bool {
    let Some((owner, name)) = value.split_once('/') else {
        return false;
    };
    let owner_ok = (1..=MAX_OWNER_LEN).contains(&owner.len())
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !owner.starts_with('-');
    let name_ok = (1..=MAX_NAME_LEN).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && name != "."
        && name != "..";
    owner_ok && name_ok
}
