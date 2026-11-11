//! The program OutLayer runs: a request on stdin, one compact JSON line on stdout. See `lib.rs`.

// The probe verifier's HTTP client names its items `proven_pr_verifier::…`; this library
// re-exports them, so the same file compiles here unchanged.
extern crate proven_pr_bounty_verifier as proven_pr_verifier;

use proven_pr_bounty_verifier::{
    gist_path, parse_gist, parse_pull, parse_request, pull_path, render, Answer, Op, Reason,
    Request, RunContext, MAX_REQUEST_BYTES,
};
use std::io::{Read, Write};

/// The outbound allowlist, embedded in a custom section so the WASM's SHA-256 covers it. OutLayer
/// refuses any other host for this build.
#[cfg(target_family = "wasm")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

/// The probe verifier's HTTP client, the same file: one `GET` to `api.github.com`, no credential,
/// no redirect, a capped body.
#[cfg(all(target_os = "wasi", target_env = "p2"))]
#[path = "../../pr-verifier/src/http.rs"]
mod http;

#[cfg(all(target_os = "wasi", target_env = "p2"))]
fn fetch(path: &str) -> Result<Vec<u8>, Reason> {
    http::get(path)
}

/// Native builds exist only for tests and have no network.
#[cfg(not(all(target_os = "wasi", target_env = "p2")))]
fn fetch(_path: &str) -> Result<Vec<u8>, Reason> {
    Err(Reason::Unreachable)
}

fn answer(request: &Request) -> Result<Answer, Reason> {
    match &request.op {
        Op::Pull { number } => {
            let body = fetch(&pull_path(&request.repo, *number))?;
            parse_pull(&body).map(Answer::Pull)
        }
        Op::PullGist {
            number,
            gist_id,
            challenge,
        } => {
            let pull = parse_pull(&fetch(&pull_path(&request.repo, *number))?)?;
            let gist = parse_gist(&fetch(&gist_path(gist_id))?, gist_id, challenge)?;
            Ok(Answer::PullGist(pull, gist))
        }
        Op::Gist { gist_id, challenge } => {
            let body = fetch(&gist_path(gist_id))?;
            parse_gist(&body, gist_id, challenge).map(Answer::Gist)
        }
    }
}

fn main() {
    let mut input = Vec::new();
    let read = std::io::stdin()
        .take(MAX_REQUEST_BYTES as u64 + 1)
        .read_to_end(&mut input);
    let context = RunContext::from_vars(
        std::env::var("NEAR_PREDECESSOR_ID").ok(),
        std::env::var("NEAR_REQUEST_ID").ok(),
    );
    let request = read
        .map_err(|_| Reason::BadRequest)
        .and_then(|_| parse_request(&input));
    let line = match &request {
        Ok(request) => render(Some(request), &context, answer(request)),
        Err(reason) => render(None, &context, Err(*reason)),
    };
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}
