# Proven build artifacts

This branch holds compiled build outputs only. The source lives on `main`.

| File | sha256 | Built from |
|---|---|---|
| `proven-verifier.wasm` | `4398d9236325ecb5b2c99a00a9fc4c076603145f5f2ae39f3b6810f644ae3af2` | `verifier/`, `cargo build --release --target wasm32-wasip1`, rustc 1.99.1 (not yet a reproducible build) |

`proven-verifier.wasm` is the P1 spike verifier for OutLayer. It reads a job as JSON on stdin and checks that the invoice lines sum to the total. It prints `{pass, reason, input_sha256}` to stdout.
