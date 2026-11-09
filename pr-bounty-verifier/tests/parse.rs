//! Tests of the bounty verifier's pure part. The comment and repository fixtures are synthetic,
//! in the shape GitHub served for public near/near-sdk-rs comments on November 9, 2026; the pull
//! request fixtures are the probe verifier's real ones.

use proven_pr_bounty_verifier::*;
use serde_json::{json, Value};

const COMMENT: &str = include_str!("fixtures/claim-comment.json");
const REPOSITORY: &str = include_str!("fixtures/repository.json");
const MERGED_PR: &str = include_str!("../../pr-verifier/tests/fixtures/near-sdk-rs-pr-1669.json");
const REPO: &str = "proven-test/bounty-pilot";
const CHALLENGE: &str =
    "proven-claim:1111111111111111111111111111111111111111111111111111111111111111";

fn comment() -> Value {
    serde_json::from_str(COMMENT).unwrap()
}

fn parse(value: &Value) -> Result<CommentFacts, Reason> {
    parse_comment(value.to_string().as_bytes(), 800_000_001, REPO, CHALLENGE)
}

fn request(op: Value) -> Result<Request, Reason> {
    let mut base = json!({"v": 2, "network": "testnet", "contract": "pr-bounty.proven.testnet", "bounty": 4, "seq": 17, "repo": REPO});
    for (k, v) in op.as_object().unwrap() {
        base[k] = v.clone();
    }
    parse_request(base.to_string().as_bytes())
}

#[test]
fn a_claim_comment_gives_its_author_issue_times_and_challenge_match() {
    assert_eq!(
        parse_comment(COMMENT.as_bytes(), 800_000_001, REPO, CHALLENGE),
        Ok(CommentFacts {
            repo_id: 800_000_001,
            comment_id: 7_000_000_001,
            author_id: 900_000_001,
            issue_number: 3,
            created_at: 1_794_301_205, // 2026-11-10T09:00:05Z
            updated_at: 1_794_301_205,
            challenge_matches: true,
        })
    );
}

#[test]
fn only_the_exact_challenge_as_the_whole_comment_matches() {
    for body in [
        "I claim this. proven-claim:1111111111111111111111111111111111111111111111111111111111111111",
        "proven-claim:1111111111111111111111111111111111111111111111111111111111111112",
        "PROVEN-CLAIM:1111111111111111111111111111111111111111111111111111111111111111",
        "",
    ] {
        let mut edited = comment();
        edited["body"] = json!(body);
        assert!(!parse(&edited).unwrap().challenge_matches, "{body:?}");
    }
    let mut padded = comment();
    padded["body"] = json!(format!("\n  {CHALLENGE}  \r\n"));
    assert!(parse(&padded).unwrap().challenge_matches);
}

#[test]
fn a_comment_on_another_repository_or_with_a_garbled_issue_url_is_malformed() {
    for url in [
        "https://api.github.com/repos/someone-else/bounty-pilot/issues/3",
        "https://api.github.com/repos/proven-test/bounty-pilot-fork/issues/3",
        "https://api.github.com/repos/proven-test/bounty-pilot/pulls/3",
        "https://api.github.com/repos/proven-test/bounty-pilot/issues/3x",
        "https://api.github.com/repos/proven-test/bounty-pilot/issues/",
        "https://evil.example/repos/proven-test/bounty-pilot/issues/3",
    ] {
        let mut moved = comment();
        moved["issue_url"] = json!(url);
        assert_eq!(parse(&moved), Err(Reason::Malformed), "{url}");
    }
    let mut cased = comment();
    cased["issue_url"] = json!("https://api.github.com/repos/Proven-Test/Bounty-Pilot/issues/3");
    assert_eq!(
        parse(&cased).unwrap().issue_number,
        3,
        "GitHub's canonical case may differ"
    );
}

#[test]
fn an_edited_comment_shows_a_later_update_time() {
    let mut edited = comment();
    edited["updated_at"] = json!("2026-11-10T09:30:00Z");
    let facts = parse(&edited).unwrap();
    assert!(facts.updated_at > facts.created_at);
    let mut backwards = comment();
    backwards["updated_at"] = json!("2026-11-10T08:00:00Z");
    assert_eq!(parse(&backwards), Err(Reason::Malformed));
}

#[test]
fn missing_or_mistyped_comment_members_are_no_result() {
    for pointer in [
        "/user/id",
        "/id",
        "/created_at",
        "/updated_at",
        "/issue_url",
        "/body",
    ] {
        let mut gap = comment();
        *gap.pointer_mut(pointer).unwrap() = Value::Null;
        assert_eq!(parse(&gap), Err(Reason::Incomplete), "{pointer}");
    }
    let mut stringly = comment();
    stringly["user"]["id"] = json!("900000001");
    assert_eq!(parse(&stringly), Err(Reason::Malformed));
    assert_eq!(
        parse_comment(b"[]", 1, REPO, CHALLENGE),
        Err(Reason::Malformed)
    );
    let big = vec![b' '; MAX_BODY_BYTES + 1];
    assert_eq!(
        parse_comment(&big, 1, REPO, CHALLENGE),
        Err(Reason::Oversized)
    );
}

#[test]
fn the_repository_must_be_public_and_named_as_asked() {
    assert_eq!(parse_repo(REPOSITORY.as_bytes(), REPO), Ok(800_000_001));
    assert_eq!(
        parse_repo(REPOSITORY.as_bytes(), "proven-test/other"),
        Err(Reason::Malformed)
    );
    let mut private: Value = serde_json::from_str(REPOSITORY).unwrap();
    private["private"] = json!(true);
    assert_eq!(
        parse_repo(private.to_string().as_bytes(), REPO),
        Err(Reason::Malformed)
    );
    let mut no_id: Value = serde_json::from_str(REPOSITORY).unwrap();
    no_id["id"] = Value::Null;
    assert_eq!(
        parse_repo(no_id.to_string().as_bytes(), REPO),
        Err(Reason::Incomplete)
    );
}

#[test]
fn requests_take_only_their_own_members() {
    assert_eq!(
        request(json!({"op": "pull", "number": 12})).unwrap().op,
        Op::Pull { number: 12 }
    );
    assert_eq!(
        request(json!({"op": "comment", "comment_id": 7, "challenge": CHALLENGE}))
            .unwrap()
            .op,
        Op::Comment {
            comment_id: 7,
            challenge: CHALLENGE.to_string()
        }
    );
    for bad in [
        json!({"op": "pull"}),
        json!({"op": "pull", "number": 0}),
        json!({"op": "pull", "number": 12, "comment_id": 7}),
        json!({"op": "comment", "comment_id": 7}),
        json!({"op": "comment", "comment_id": 7, "challenge": "proven-claim:abc"}),
        json!({"op": "comment", "comment_id": 7, "challenge": CHALLENGE, "number": 3}),
        json!({"op": "issue", "number": 3}),
        json!({"op": "pull", "number": 12, "url": "https://example.com"}),
        json!({"op": "pull", "number": 12, "network": "localnet"}),
        json!({"op": "pull", "number": 12, "repo": "a/b/c"}),
        json!({"op": "pull", "number": 12, "v": 1}),
    ] {
        assert_eq!(request(bad.clone()), Err(Reason::BadRequest), "{bad}");
    }
}

#[test]
fn answers_are_bound_and_carry_no_text() {
    let context = RunContext::from_vars(
        Some("pr-bounty.proven.testnet".into()),
        Some("15100".into()),
    );
    let comment_request =
        request(json!({"op": "comment", "comment_id": 7000000001u64, "challenge": CHALLENGE}))
            .unwrap();
    let facts = parse_comment(COMMENT.as_bytes(), 800_000_001, REPO, CHALLENGE).unwrap();
    let line = render(Some(&comment_request), &context, Ok(Answer::Comment(facts)));
    let out: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(out["network"], "testnet");
    assert_eq!(out["contract"], "pr-bounty.proven.testnet");
    assert_eq!(out["bounty"], 4);
    assert_eq!(out["seq"], 17);
    assert_eq!(out["op"], "comment");
    assert_eq!(out["comment_id"], 7_000_000_001u64);
    assert_eq!(out["request_id"], 15100);
    assert_eq!(out["comment"]["author_id"], 900_000_001u64);
    assert!(
        !line.contains("proven-claim:"),
        "the challenge and comment text are not echoed"
    );
    assert!(!line.contains("example-contributor"));

    let pull_request = request(json!({"op": "pull", "number": 1669})).unwrap();
    let pulled = render(
        Some(&pull_request),
        &context,
        parse_pull(MERGED_PR.as_bytes()).map(Answer::Pull),
    );
    let pulled: Value = serde_json::from_str(&pulled).unwrap();
    assert_eq!(pulled["pull"]["merged_at"], 1_793_821_703u64);
    assert!(pulled.get("comment").is_none());

    let refused: Value = serde_json::from_str(&render(
        Some(&pull_request),
        &context,
        Err(Reason::RateLimited),
    ))
    .unwrap();
    assert_eq!(refused["reason"], "rate_limited");
    assert!(refused.get("pull").is_none());
}

#[test]
fn the_largest_answer_fits_the_contracts_cap() {
    let longest = request(json!({
        "contract": "c".repeat(64), "repo": format!("{}/{}", "o".repeat(39), "n".repeat(100)),
        "bounty": u64::MAX, "seq": u64::MAX, "op": "pull", "number": u64::from(u32::MAX),
    }))
    .unwrap();
    let mut pull: Value = serde_json::from_str(MERGED_PR).unwrap();
    pull["base"]["ref"] = json!("b".repeat(255));
    let context = RunContext::from_vars(Some("c".repeat(64)), Some(u64::MAX.to_string()));
    let line = render(
        Some(&longest),
        &context,
        parse_pull(pull.to_string().as_bytes()).map(Answer::Pull),
    );
    assert!(line.len() <= 1024, "{} bytes", line.len());
}

#[test]
fn paths_hold_only_validated_parts() {
    assert_eq!(
        pull_path(REPO, 5),
        "/repos/proven-test/bounty-pilot/pulls/5"
    );
    assert_eq!(repo_path(REPO), "/repos/proven-test/bounty-pilot");
    assert_eq!(
        comment_path(REPO, 9),
        "/repos/proven-test/bounty-pilot/issues/comments/9"
    );
    assert!(is_challenge(CHALLENGE));
    assert!(!is_challenge(&CHALLENGE.to_uppercase()));
}
