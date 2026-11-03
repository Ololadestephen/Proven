# Proven build artifacts

This branch holds compiled build outputs only. The source lives on `main`.

| File | sha256 | Built from |
|---|---|---|
| `proven-verifier.wasm` | `4398d9236325ecb5b2c99a00a9fc4c076603145f5f2ae39f3b6810f644ae3af2` | `verifier/`, `cargo build --release --target wasm32-wasip1`, rustc 1.99.1 (not yet a reproducible build) |
| `proven-verifier-26976fbd.wasm` | `26976fbd5d14bf639ea1ffc80ad49f2d5e3b1b5c8d043b7d82124d91ffd337f0` | `verifier/` at P3, `cargo build --release --target wasm32-wasip1 --bin proven-verifier`, rustc 1.99.1, wasmi 2.0.0 (not yet a reproducible build) |
| `proven-verifier-d41d8627.wasm` | `d41d8627a237e9ca79a1f44c0bb28fff6a3d5cbe69fcb28f0a13e9d748b52fe7` | `verifier/` after the P3 review: fakes generated inside the verifier, private check and reference read from OutLayer secrets; rustc 1.99.1, wasmi 2.0.0 (not yet a reproducible build) |
| `proven-verifier-48f85397.wasm` | `48f8539704a6a1b293e4930c5f254a59acd96fb61eaf100186c86c8301c7a128` | `verifier/` after the second P3 review: relay-owned private check, reference and deliverable; capped fake search; positional fake names; rustc 1.99.1, wasmi 2.0.0 (not yet a reproducible build) |

`proven-verifier.wasm` is the P1 spike verifier for OutLayer. It reads a job as JSON on stdin and checks that the invoice lines sum to the total. It prints `{pass, reason, input_sha256}` to stdout.

`proven-verifier-26976fbd.wasm` is the P3 verifier. It takes `{"mode": "verify" | "challenge", ...}` on stdin and prints a compact verdict (see `verifier/src/run.rs` once the source is published).
