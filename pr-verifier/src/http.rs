//! One `GET` to `https://api.github.com<path>` through `wasi:http`, with no credential, no redirect
//! and a cap on the body. Every failure becomes a fixed [`Reason`].

use proven_pr_verifier::{
    check_status, Reason, API_HOST, BETWEEN_BYTES_TIMEOUT_SECS, CONNECT_TIMEOUT_SECS,
    FIRST_BYTE_TIMEOUT_SECS, MAX_BODY_BYTES, USER_AGENT,
};
use wasi::http::outgoing_handler;
use wasi::http::types::{
    ErrorCode, Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
};
use wasi::io::streams::StreamError;

const NANOS_PER_SEC: u64 = 1_000_000_000;
const READ_CHUNK: u64 = 64 * 1024;

pub fn get(path: &str) -> Result<Vec<u8>, Reason> {
    let headers = Fields::from_list(&[
        (
            "accept".to_string(),
            b"application/vnd.github+json".to_vec(),
        ),
        ("x-github-api-version".to_string(), b"2022-11-28".to_vec()),
        ("user-agent".to_string(), USER_AGENT.as_bytes().to_vec()),
    ])
    .map_err(|_| Reason::Unreachable)?;
    let request = OutgoingRequest::new(headers);
    request
        .set_method(&Method::Get)
        .and_then(|()| request.set_scheme(Some(&Scheme::Https)))
        .and_then(|()| request.set_authority(Some(API_HOST)))
        .and_then(|()| request.set_path_with_query(Some(path)))
        .map_err(|()| Reason::BadRequest)?;
    let body = request.body().map_err(|()| Reason::Unreachable)?;
    OutgoingBody::finish(body, None).map_err(transport)?;

    // A host that cannot apply one of these still bounds the request by the manifest's
    // per-host timeout and the run's own time limit.
    let options = RequestOptions::new();
    let _ = options.set_connect_timeout(Some(CONNECT_TIMEOUT_SECS * NANOS_PER_SEC));
    let _ = options.set_first_byte_timeout(Some(FIRST_BYTE_TIMEOUT_SECS * NANOS_PER_SEC));
    let _ = options.set_between_bytes_timeout(Some(BETWEEN_BYTES_TIMEOUT_SECS * NANOS_PER_SEC));

    let pending = outgoing_handler::handle(request, Some(options)).map_err(transport)?;
    let response = loop {
        match pending.get() {
            Some(result) => break result,
            None => pending.subscribe().block(),
        }
    };
    let response = response
        .map_err(|()| Reason::Unreachable)?
        .map_err(transport)?;

    let headers = response.headers();
    let header = |name: &str| {
        headers
            .get(&name.to_string())
            .into_iter()
            .next()
            .and_then(|value| String::from_utf8(value).ok())
    };
    let remaining = header("x-ratelimit-remaining");
    let retry_after = header("retry-after");
    let length = header("content-length");
    drop(headers);
    check_status(
        response.status(),
        remaining.as_deref(),
        retry_after.as_deref(),
    )?;
    if length
        .and_then(|l| l.trim().parse::<u64>().ok())
        .is_some_and(|l| l > MAX_BODY_BYTES as u64)
    {
        return Err(Reason::Oversized);
    }

    let incoming = response.consume().map_err(|()| Reason::Unreachable)?;
    let stream = incoming.stream().map_err(|()| Reason::Unreachable)?;
    let mut out = Vec::new();
    loop {
        match stream.blocking_read(READ_CHUNK) {
            Ok(chunk) => {
                if out.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(Reason::Oversized);
                }
                out.extend_from_slice(&chunk);
            }
            Err(StreamError::Closed) => break,
            Err(StreamError::LastOperationFailed(_)) => return Err(Reason::Unreachable),
        }
    }
    Ok(out)
}

fn transport(error: ErrorCode) -> Reason {
    match error {
        ErrorCode::ConnectionTimeout
        | ErrorCode::ConnectionReadTimeout
        | ErrorCode::ConnectionWriteTimeout
        | ErrorCode::HttpResponseTimeout
        | ErrorCode::DnsTimeout => Reason::Timeout,
        ErrorCode::HttpResponseBodySize(_) => Reason::Oversized,
        _ => Reason::Unreachable,
    }
}
