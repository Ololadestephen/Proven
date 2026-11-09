#!/usr/bin/env bash
# Builds the PR verifier for OutLayer (wasm32-wasip2) and prints its size and SHA-256, the hash a
# caller pins. Local paths are remapped so the hash does not depend on where the source or the
# Cargo registry sits; the same rustc and Cargo.lock should give the same bytes.
set -euo pipefail
cd "$(dirname "$0")"
here="$(pwd)"
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${here}=/build"
cargo build --locked --release --target wasm32-wasip2 --bin proven-pr-verifier
wasm=target/wasm32-wasip2/release/proven-pr-verifier.wasm
echo "rustc: $(rustc --version)"
echo "bytes: $(wc -c < "$wasm" | tr -d ' ')"
echo "sha256: $(shasum -a 256 "$wasm" | cut -d' ' -f1)"
