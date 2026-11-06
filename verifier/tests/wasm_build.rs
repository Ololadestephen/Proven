//! Hostile functions run through the real WebAssembly build, the one OutLayer runs. A native test
//! cannot show this: the build once crashed on these inputs only when compiled to WebAssembly.
//! Build it, then run: `cargo test --release --test wasm_build -- --ignored`. Needs `wasmtime`.

use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

const WASM: &str = "target/wasm32-wasip1/release/proven-verifier.wasm";

fn run_wasm(input: &Value) -> Value {
    let mut child = Command::new("wasmtime")
        .arg(WASM)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wasmtime must be installed");
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "the verifier crashed: {}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
#[ignore = "needs the release WebAssembly build and wasmtime"]
fn a_worker_function_cannot_stop_a_verdict_in_the_webassembly_build() {
    use base64::Engine as _;
    let check = std::fs::read_to_string("../examples/function-job/check-strong.json").unwrap().replace(r#""rules""#, r#""fuel": 10000000, "rules""#);
    let slow_then_correct = r#"(module (func (export "vat") (param i64 i64) (result i64) (local i64)
        (loop $l (local.set 2 (i64.add (local.get 2) (i64.const 1))) (br_if $l (i64.lt_s (local.get 2) (i64.const 300000))))
        (if (result i64) (i64.lt_s (local.get 0) (i64.const 100)) (then (i64.const 0))
          (else (i64.div_s (i64.add (i64.mul (local.get 0) (local.get 1)) (i64.const 5000)) (i64.const 10000))))))"#;
    let cases = [
        (slow_then_correct, "monotonic_net"),
        (r#"(module (func $f (export "vat") (param i64 i64) (result i64) (call $f (local.get 0) (local.get 1))))"#, "basic"),
        (r#"(module (func (export "vat") (param i64 i64) (result i64) (loop $l (br $l)) (i64.const 0)))"#, "basic"),
    ];
    for (text, rule) in cases {
        let bytes = wat::parse_str(text).unwrap();
        let deliverable = json!({ "wasm_base64": base64::engine::general_purpose::STANDARD.encode(bytes) }).to_string();
        let verdict = run_wasm(&json!({ "mode": "verify", "check": check, "deliverable": deliverable }));
        assert_eq!((verdict["pass"].as_bool(), verdict["failed_rule"].as_str()), (Some(false), Some(rule)));
    }
}
