//! Tests of the bounty verifier's pure part. The gist fixture is synthetic, in the shape GitHub
//! serves for `GET /gists/<id>` (checked against a public gist on November 9, 2026, and the
//! response schema in GitHub's REST documentation); the pull request fixtures are the probe
//! verifier's real ones.

use proven_pr_bounty_verifier::*;
use serde_json::{json, Value};

const GIST: &str = include_str!("fixtures/link-gist.json");
const MERGED_PR: &str = include_str!("../../pr-verifier/tests/fixtures/near-sdk-rs-pr-1669.json");
const REPO: &str = "proven-test/bounty-pilot";
const GIST_ID: &str = "0123456789abcdef0123456789abcdef";
const CHALLENGE: &str =
    "proven-link:1111111111111111111111111111111111111111111111111111111111111111";

fn gist() -> Value {
    serde_json::from_str(GIST).unwrap()
}

fn parse(value: &Value) -> Result<GistFacts, Reason> {
    parse_gist(value.to_string().as_bytes(), GIST_ID, CHALLENGE)
}

fn file(content: Value) -> Value {
    json!({"filename": "x.txt", "type": "text/plain", "size": 1, "truncated": false, "content": content})
}

fn request(op: Value) -> Result<Request, Reason> {
    let mut base = json!({"v": 4, "network": "testnet", "contract": "pr-bounty.proven.testnet", "bounty": 4, "seq": 17, "repo": REPO});
    for (k, v) in op.as_object().unwrap() {
        base[k] = v.clone();
    }
    parse_request(base.to_string().as_bytes())
}

#[test]
fn a_claim_gist_gives_its_owner_and_an_exact_match() {
    assert_eq!(
        parse_gist(GIST.as_bytes(), GIST_ID, CHALLENGE),
        Ok(GistFacts {
            owner_id: 900_000_001,
            files: 1,
            challenge_matches: true
        })
    );
}

#[test]
fn only_the_exact_challenge_as_the_whole_single_file_matches() {
    for content in [
        "I claim this. proven-link:1111111111111111111111111111111111111111111111111111111111111111",
        "proven-link:1111111111111111111111111111111111111111111111111111111111111112",
        "PROVEN-CLAIM:1111111111111111111111111111111111111111111111111111111111111111",
        "",
    ] {
        let mut edited = gist();
        edited["files"]["proven-claim.txt"]["content"] = json!(content);
        assert!(!parse(&edited).unwrap().challenge_matches, "{content:?}");
    }
    let mut padded = gist();
    padded["files"]["proven-claim.txt"]["content"] = json!(format!("\n  {CHALLENGE}  \r\n"));
    assert!(parse(&padded).unwrap().challenge_matches);
}

#[test]
fn a_gist_with_more_than_one_file_is_ambiguous_and_never_matches() {
    let mut two = gist();
    two["files"]["other.txt"] = file(json!(CHALLENGE));
    let facts = parse(&two).unwrap();
    assert_eq!((facts.files, facts.challenge_matches), (2, false));
    let mut none = gist();
    none["files"] = json!({});
    let facts = parse(&none).unwrap();
    assert_eq!((facts.files, facts.challenge_matches), (0, false));
}

#[test]
fn truncated_or_mismatched_gists_are_malformed() {
    let mut cut_file = gist();
    cut_file["files"]["proven-claim.txt"]["truncated"] = json!(true);
    assert_eq!(parse(&cut_file), Err(Reason::Malformed));
    let mut cut_list = gist();
    cut_list["truncated"] = json!(true);
    assert_eq!(parse(&cut_list), Err(Reason::Malformed));
    let mut other = gist();
    other["id"] = json!("fedcba9876543210fedcba9876543210");
    assert_eq!(
        parse(&other),
        Err(Reason::Malformed),
        "an answer about another gist"
    );
    let mut stringly = gist();
    stringly["owner"]["id"] = json!("900000001");
    assert_eq!(parse(&stringly), Err(Reason::Malformed));
    let mut zero = gist();
    zero["owner"]["id"] = json!(0);
    assert_eq!(parse(&zero), Err(Reason::Malformed));
    assert_eq!(
        parse_gist(b"[]", GIST_ID, CHALLENGE),
        Err(Reason::Malformed)
    );
    assert_eq!(
        parse_gist(b"{\"id\":", GIST_ID, CHALLENGE),
        Err(Reason::Malformed)
    );
    let big = vec![b' '; MAX_BODY_BYTES + 1];
    assert_eq!(parse_gist(&big, GIST_ID, CHALLENGE), Err(Reason::Oversized));
}

#[test]
fn missing_members_are_incomplete() {
    for pointer in [
        "/id",
        "/owner",
        "/owner/id",
        "/files",
        "/files/proven-claim.txt/content",
        "/files/proven-claim.txt",
    ] {
        let mut gap = gist();
        *gap.pointer_mut(pointer).unwrap() = Value::Null;
        assert_eq!(parse(&gap), Err(Reason::Incomplete), "{pointer}");
    }
}

#[test]
fn requests_take_only_their_own_members() {
    assert_eq!(
        request(json!({"op": "pull", "number": 12})).unwrap().op,
        Op::Pull { number: 12 }
    );
    assert_eq!(
        request(json!({"op": "gist", "gist_id": GIST_ID, "challenge": CHALLENGE}))
            .unwrap()
            .op,
        Op::Gist {
            gist_id: GIST_ID.into(),
            challenge: CHALLENGE.into()
        }
    );
    for bad in [
        json!({"op": "pull"}),
        json!({"op": "pull", "number": 0}),
        json!({"op": "pull", "number": 12, "gist_id": GIST_ID}),
        json!({"op": "gist", "gist_id": GIST_ID}),
        json!({"op": "gist", "gist_id": GIST_ID, "challenge": "proven-link:abc"}),
        json!({"op": "gist", "gist_id": "../repos/x", "challenge": CHALLENGE}),
        json!({"op": "gist", "gist_id": "ABCDEF", "challenge": CHALLENGE}),
        json!({"op": "gist", "gist_id": "a".repeat(65), "challenge": CHALLENGE}),
        json!({"op": "gist", "gist_id": GIST_ID, "challenge": CHALLENGE, "number": 3}),
        json!({"op": "comment", "comment_id": 7, "challenge": CHALLENGE}),
        json!({"op": "pull", "number": 12, "url": "https://example.com"}),
        json!({"op": "pull", "number": 12, "network": "localnet"}),
        json!({"op": "pull", "number": 12, "repo": "a/b/c"}),
        json!({"op": "pull", "number": 12, "v": 2}),
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
    let gist_request =
        request(json!({"op": "gist", "gist_id": GIST_ID, "challenge": CHALLENGE})).unwrap();
    let facts = parse_gist(GIST.as_bytes(), GIST_ID, CHALLENGE).unwrap();
    let line = render(Some(&gist_request), &context, Ok(Answer::Gist(facts)));
    let out: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(out["v"], 4);
    assert_eq!(out["network"], "testnet");
    assert_eq!(out["contract"], "pr-bounty.proven.testnet");
    assert_eq!(
        (out["bounty"].clone(), out["seq"].clone()),
        (json!(4), json!(17))
    );
    assert_eq!(out["op"], "gist");
    assert_eq!(out["gist_id"], GIST_ID);
    assert_eq!(out["request_id"], 15100);
    assert_eq!(
        out["gist"],
        json!({"owner_id": 900_000_001u64, "files": 1, "challenge_matches": true})
    );
    assert!(
        !line.contains("proven-link:"),
        "the challenge and gist text are not echoed"
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
    assert!(pulled.get("gist").is_none());

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
    let gist_longest = request(json!({
        "contract": "c".repeat(64), "repo": format!("{}/{}", "o".repeat(39), "n".repeat(100)),
        "bounty": u64::MAX, "seq": u64::MAX, "op": "gist", "gist_id": "a".repeat(64), "challenge": CHALLENGE,
    }))
    .unwrap();
    let facts = GistFacts {
        owner_id: u64::MAX,
        files: u32::MAX,
        challenge_matches: false,
    };
    assert!(render(Some(&gist_longest), &context, Ok(Answer::Gist(facts))).len() <= 1024);
    // A submission carries both facts and the gist id, so it is the largest answer.
    let both_longest = request(json!({
        "contract": "c".repeat(64), "repo": format!("{}/{}", "o".repeat(39), "n".repeat(100)),
        "bounty": u64::MAX, "seq": u64::MAX, "op": "pull", "number": u64::from(u32::MAX),
        "gist_id": "a".repeat(64), "challenge": CHALLENGE,
    }))
    .unwrap();
    let mut big: Value = serde_json::from_str(MERGED_PR).unwrap();
    big["base"]["ref"] = json!("b".repeat(255));
    let facts = GistFacts {
        owner_id: u64::MAX,
        files: u32::MAX,
        challenge_matches: false,
    };
    let line = render(
        Some(&both_longest),
        &context,
        parse_pull(big.to_string().as_bytes()).map(|p| Answer::PullGist(p, facts.clone())),
    );
    assert!(line.len() <= MAX_ANSWER_BYTES, "{} bytes", line.len());
    // The same with a base branch made only of characters JSON escapes: still a real answer.
    for escaped in ["\"", "\\"] {
        let mut worst: Value = serde_json::from_str(MERGED_PR).unwrap();
        worst["base"]["ref"] = json!(escaped.repeat(255));
        let line = render(
            Some(&both_longest),
            &context,
            parse_pull(worst.to_string().as_bytes()).map(|p| Answer::PullGist(p, facts.clone())),
        );
        let out: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(out["status"], "ok", "the worst branch name still fits");
        assert_eq!(out["pull"]["base_ref"], json!(escaped.repeat(255)));
        println!(
            "worst-case answer with 255 escaped characters: {} bytes",
            line.len()
        );
        assert!(line.len() <= MAX_ANSWER_BYTES, "{} bytes", line.len());
    }
}

#[test]
fn an_answer_over_the_cap_becomes_a_bound_oversized_no_result() {
    let req = request(json!({"op": "pull", "number": 12})).unwrap();
    let context = RunContext::from_vars(Some("pr-bounty.proven.testnet".into()), Some("7".into()));
    let facts = parse_pull(MERGED_PR.as_bytes()).unwrap();
    let full = render(Some(&req), &context, Ok(Answer::Pull(facts.clone())));
    let cut = render_capped(
        Some(&req),
        &context,
        Ok(Answer::Pull(facts)),
        full.len() - 1,
    );
    let out: Value = serde_json::from_str(&cut).unwrap();
    assert_eq!(out["status"], "no_result");
    assert_eq!(out["reason"], "oversized");
    // Still bound to the request, so the contract records it as a failed look, not a wrong one.
    assert_eq!(out["number"], 12);
    assert_eq!(out["seq"], 17);
    assert_eq!(out["request_id"], 7);
    assert!(out.get("pull").is_none());
    assert!(cut.len() < full.len());
}

#[test]
fn paths_hold_only_validated_parts() {
    assert_eq!(
        pull_path(REPO, 5),
        "/repos/proven-test/bounty-pilot/pulls/5"
    );
    assert_eq!(
        gist_path(GIST_ID),
        "/gists/0123456789abcdef0123456789abcdef"
    );
    assert!(is_challenge(CHALLENGE) && !is_challenge(&CHALLENGE.to_uppercase()));
    assert!(is_gist_id("1234567") && !is_gist_id("") && !is_gist_id("a/b"));
}

#[test]
fn a_submission_reads_the_pull_request_and_the_link_gist_in_one_run() {
    let both = request(json!({
        "op": "pull", "number": 12, "gist_id": GIST_ID, "challenge": CHALLENGE
    }))
    .unwrap();
    assert_eq!(
        both.op,
        Op::PullGist {
            number: 12,
            gist_id: GIST_ID.into(),
            challenge: CHALLENGE.into()
        }
    );
    // A gist without a challenge, or a challenge without a gist, is not a request.
    for bad in [
        json!({"op": "pull", "number": 12, "gist_id": GIST_ID}),
        json!({"op": "pull", "number": 12, "challenge": CHALLENGE}),
        json!({"op": "pull", "number": 12, "gist_id": "../x", "challenge": CHALLENGE}),
        json!({"op": "pull", "number": 0, "gist_id": GIST_ID, "challenge": CHALLENGE}),
        json!({"op": "pull", "number": 12, "gist_id": GIST_ID, "challenge": "proven-claim:abc"}),
    ] {
        assert_eq!(request(bad.clone()), Err(Reason::BadRequest), "{bad}");
    }
    let context = RunContext::from_vars(
        Some("pr-bounty.proven.testnet".into()),
        Some("15101".into()),
    );
    let pull = parse_pull(MERGED_PR.as_bytes()).unwrap();
    let gist = parse_gist(GIST.as_bytes(), GIST_ID, CHALLENGE).unwrap();
    let line = render(Some(&both), &context, Ok(Answer::PullGist(pull, gist)));
    let out: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(out["v"], 4);
    assert_eq!(out["op"], "pull");
    assert_eq!(out["number"], 12);
    assert_eq!(out["gist_id"], GIST_ID);
    assert_eq!(out["status"], "ok");
    assert_eq!(out["pull"]["author_id"], 163825889u64);
    assert_eq!(out["gist"]["challenge_matches"], true);
    assert!(
        !line.contains("proven-link:"),
        "the challenge text is never printed"
    );
    assert!(line.len() <= MAX_ANSWER_BYTES, "{} bytes", line.len());
    // If either read fails, nothing but the reason is reported.
    let failed = render(Some(&both), &context, Err(Reason::RateLimited));
    let out: Value = serde_json::from_str(&failed).unwrap();
    assert_eq!(out["status"], "no_result");
    assert_eq!(out["reason"], "rate_limited");
    assert!(out.get("pull").is_none() && out.get("gist").is_none());
}
