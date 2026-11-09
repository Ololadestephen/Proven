//! Tests of the verifier's pure part against two real GitHub answers (near/near-sdk-rs pull
//! requests 1669, merged, and 1677, open, as served on November 9, 2026) and edited copies. The
//! fixtures keep GitHub's structure for the members read here, plus the title and description,
//! and drop the rest of the 17 KB answer, including the author's login and avatar.

use proven_pr_verifier::*;
use serde_json::{json, Value};

const MERGED: &str = include_str!("fixtures/near-sdk-rs-pr-1669.json");
const OPEN: &str = include_str!("fixtures/near-sdk-rs-pr-1677.json");

fn merged() -> Value {
    serde_json::from_str(MERGED).unwrap()
}

fn parse(value: &Value) -> Result<Facts, Reason> {
    parse_pull(value.to_string().as_bytes())
}

fn request() -> Request {
    parse_request(
        br#"{"v":1,"probe":"pr-verify.proven.testnet","reading":3,"repo":"near/near-sdk-rs","number":1669}"#,
    )
    .unwrap()
}

#[test]
fn a_merged_pull_request_gives_its_stable_ids_and_merge_time() {
    assert_eq!(
        parse_pull(MERGED.as_bytes()),
        Ok(Facts {
            repo_id: 190_815_700,
            pr_id: 5_125_170_190,
            pr_number: 1669,
            author_id: 163_825_889,
            base_ref: "master".to_string(),
            state: "closed".to_string(),
            merged: true,
            merged_at: Some(1_793_821_703), // 2026-11-04T19:48:23Z
        })
    );
}

#[test]
fn an_open_pull_request_is_not_merged_and_has_no_merge_time() {
    let facts = parse_pull(OPEN.as_bytes()).unwrap();
    assert_eq!(facts.state, "open");
    assert!(!facts.merged);
    assert_eq!(facts.merged_at, None);
    assert_eq!(facts.author_id, 59_515_280);
}

#[test]
fn a_missing_required_member_is_incomplete() {
    for pointer in [
        "/id",
        "/number",
        "/user/id",
        "/base/ref",
        "/base/repo/id",
        "/merged",
        "/state",
    ] {
        let mut pull = merged();
        *pull.pointer_mut(pointer).unwrap() = Value::Null;
        assert_eq!(parse(&pull), Err(Reason::Incomplete), "{pointer}");
    }
    let mut pull = merged();
    pull.as_object_mut().unwrap().remove("user");
    assert_eq!(parse(&pull), Err(Reason::Incomplete));
    let mut pull = merged();
    pull["merged_at"] = Value::Null;
    assert_eq!(
        parse(&pull),
        Err(Reason::Incomplete),
        "merged without a merge time"
    );
}

#[test]
fn a_wrong_type_or_an_inconsistent_answer_is_malformed() {
    let cases: [(&str, Value); 8] = [
        ("/user/id", json!("163825889")),
        ("/id", json!(-1)),
        ("/id", json!(0)),
        ("/merged", json!("true")),
        ("/merged_at", json!("2026-11-04 19:48:23")),
        ("/merged_at", json!("2026-02-30T00:00:00Z")),
        ("/state", json!("draft")),
        ("/base/ref", json!("main\u{0007}")),
    ];
    for (pointer, value) in cases {
        let mut pull = merged();
        *pull.pointer_mut(pointer).unwrap() = value.clone();
        assert_eq!(parse(&pull), Err(Reason::Malformed), "{pointer} = {value}");
    }
    let mut open_but_merged = merged();
    open_but_merged["state"] = json!("open");
    assert_eq!(parse(&open_but_merged), Err(Reason::Malformed));
    let mut unmerged_with_time = merged();
    unmerged_with_time["merged"] = json!(false);
    assert_eq!(parse(&unmerged_with_time), Err(Reason::Malformed));
    let mut long_ref = merged();
    long_ref["base"]["ref"] = json!("b".repeat(256));
    assert_eq!(parse(&long_ref), Err(Reason::Malformed));
    assert_eq!(parse_pull(b"[1,2,3]"), Err(Reason::Malformed));
    assert_eq!(parse_pull(b"{\"id\":5125170190,"), Err(Reason::Malformed));
    assert_eq!(
        parse_pull(b"<html>rate limited</html>"),
        Err(Reason::Malformed)
    );
}

#[test]
fn an_oversized_answer_is_refused_before_parsing() {
    let mut pull = merged();
    pull["body"] = json!("x".repeat(MAX_BODY_BYTES));
    assert_eq!(parse(&pull), Err(Reason::Oversized));
}

#[test]
fn statuses_map_to_fixed_reasons_and_redirects_are_not_followed() {
    assert_eq!(check_status(200, Some("59"), None), Ok(()));
    for status in [301, 302, 303, 307, 308] {
        assert_eq!(check_status(status, None, None), Err(Reason::Redirect));
    }
    assert_eq!(check_status(404, None, None), Err(Reason::NotFound));
    assert_eq!(check_status(429, None, None), Err(Reason::RateLimited));
    assert_eq!(check_status(403, Some("0"), None), Err(Reason::RateLimited));
    assert_eq!(
        check_status(403, Some("12"), Some("60")),
        Err(Reason::RateLimited)
    );
    assert_eq!(check_status(403, Some("12"), None), Err(Reason::Forbidden));
    assert_eq!(
        check_status(502, None, None),
        Err(Reason::UpstreamUnavailable)
    );
    assert_eq!(check_status(204, None, None), Err(Reason::UpstreamStatus));
}

#[test]
fn requests_are_strict() {
    let good = request();
    assert_eq!(api_path(&good), "/repos/near/near-sdk-rs/pulls/1669");
    for bad in [
        r#"{"v":1,"probe":"pr-verify.proven.testnet","reading":0,"repo":"near/near-sdk-rs","number":1,"url":"https://example.com"}"#,
        r#"{"v":2,"probe":"pr-verify.proven.testnet","reading":0,"repo":"near/near-sdk-rs","number":1}"#,
        r#"{"v":1,"probe":"Bad Probe","reading":0,"repo":"near/near-sdk-rs","number":1}"#,
        r#"{"v":1,"probe":"pr-verify.proven.testnet","reading":0,"repo":"near/near-sdk-rs/pulls","number":1}"#,
        r#"{"v":1,"probe":"pr-verify.proven.testnet","reading":0,"repo":"near/..","number":1}"#,
        r#"{"v":1,"probe":"pr-verify.proven.testnet","reading":0,"repo":"near/x?y=1","number":1}"#,
        r#"{"v":1,"probe":"pr-verify.proven.testnet","reading":0,"repo":"api.evil.com@near/x","number":1}"#,
        r#"{"v":1,"probe":"pr-verify.proven.testnet","reading":0,"repo":"near/near-sdk-rs","number":0}"#,
        r#"{"v":1,"probe":"pr-verify.proven.testnet","reading":0,"repo":"near/near-sdk-rs","number":4294967296}"#,
    ] {
        assert_eq!(
            parse_request(bad.as_bytes()),
            Err(Reason::BadRequest),
            "{bad}"
        );
    }
    assert_eq!(
        parse_request(&vec![b' '; MAX_REQUEST_BYTES + 1]),
        Err(Reason::BadRequest)
    );
}

#[test]
fn the_result_is_bound_to_the_request_and_carries_no_upstream_text() {
    let context = RunContext::from_vars(
        Some("pr-verify.proven.testnet".to_string()),
        Some("4242".to_string()),
    );
    let line = render(Some(&request()), &context, parse_pull(MERGED.as_bytes()));
    let out: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(out["status"], "ok");
    assert_eq!(out["probe"], "pr-verify.proven.testnet");
    assert_eq!(out["predecessor"], "pr-verify.proven.testnet");
    assert_eq!(out["reading"], 3);
    assert_eq!(out["request_id"], 4242);
    assert_eq!(out["facts"]["merged_at"], 1_793_821_703u64);
    let title = merged()["title"].as_str().unwrap().to_string();
    assert!(!line.contains(&title), "the title is not echoed");
    assert!(!line.contains("avatar_url") && !line.contains("\"body\""));

    let refused = render(Some(&request()), &context, Err(Reason::RateLimited));
    let refused: Value = serde_json::from_str(&refused).unwrap();
    assert_eq!(refused["status"], "no_result");
    assert_eq!(refused["reason"], "rate_limited");
    assert!(refused.get("facts").is_none());

    let unbound: Value = serde_json::from_str(&render(
        None,
        &RunContext::default(),
        Err(Reason::BadRequest),
    ))
    .unwrap();
    assert!(unbound.get("probe").is_none() && unbound["predecessor"].is_null());
}

#[test]
fn the_largest_result_stays_under_the_callers_cap() {
    let mut pull = merged();
    pull["base"]["ref"] = json!("b".repeat(255));
    let longest = parse_request(
        format!(
            r#"{{"v":1,"probe":"{}","reading":4294967295,"repo":"{}/{}","number":4294967295}}"#,
            "a".repeat(64),
            "o".repeat(39),
            "n".repeat(100)
        )
        .as_bytes(),
    )
    .unwrap();
    let context = RunContext::from_vars(Some("a".repeat(64)), Some(u64::MAX.to_string()));
    let line = render(Some(&longest), &context, parse(&pull));
    assert!(line.len() <= 1024, "{} bytes", line.len());
}

#[test]
fn timestamps_parse_only_in_githubs_form() {
    assert_eq!(unix_seconds("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(unix_seconds("2000-02-29T12:00:00Z"), Some(951_825_600));
    assert_eq!(unix_seconds("2026-11-04T19:48:23Z"), Some(1_793_821_703));
    for bad in [
        "2026-11-04T19:48:23+00:00",
        "2026-11-04T19:48:23.5Z",
        "2026-13-01T00:00:00Z",
        "2025-02-29T00:00:00Z",
        "2026-11-04T24:00:00Z",
        "1969-12-31T23:59:59Z",
        "+026-11-04T19:48:23Z",
    ] {
        assert_eq!(unix_seconds(bad), None, "{bad}");
    }
}

#[test]
fn an_empty_or_invalid_run_context_is_absent() {
    assert_eq!(
        RunContext::from_vars(Some(String::new()), Some(String::new())),
        RunContext::default()
    );
    assert_eq!(
        RunContext::from_vars(Some("Not An Account".to_string()), Some("x".to_string())),
        RunContext::default()
    );
}
