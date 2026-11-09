//! The program OutLayer runs: a request on stdin, one compact JSON line on stdout. See `lib.rs`.

use proven_pr_verifier::{parse_request, render, Reason, RunContext, MAX_REQUEST_BYTES};
use std::io::{Read, Write};

/// The outbound allowlist, embedded in a custom section so the WASM's SHA-256 covers it. OutLayer
/// refuses any other host for this build.
#[cfg(target_family = "wasm")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

#[cfg(all(target_os = "wasi", target_env = "p2"))]
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
        Ok(request) => {
            let result = fetch(&proven_pr_verifier::api_path(request))
                .and_then(|body| proven_pr_verifier::parse_pull(&body));
            render(Some(request), &context, result)
        }
        Err(reason) => render(None, &context, Err(*reason)),
    };
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(line.as_bytes());
    let _ = stdout.flush();
}
