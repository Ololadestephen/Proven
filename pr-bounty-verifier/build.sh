#!/usr/bin/env bash
# Builds the PR bounty verifier for OutLayer (wasm32-wasip2) and prints its size and SHA-256, the
# hash the bounty contract pins. Local paths are remapped so the hash does not depend on where the
# repository or the Cargo registry sits; the same rustc and Cargo.lock should give the same bytes.
set -euo pipefail
cd "$(dirname "$0")"
# Both spellings of the repository path: Cargo canonicalises the path dependency, so a checkout
# behind a symlink (macOS /tmp is /private/tmp) shows up under its physical path.
root="$(cd .. && pwd)"
physical="$(cd .. && pwd -P)"
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${physical}=/build --remap-path-prefix=${root}=/build"
cargo build --locked --release --target wasm32-wasip2 --bin proven-pr-bounty-verifier
wasm=target/wasm32-wasip2/release/proven-pr-bounty-verifier.wasm
echo "rustc: $(rustc --version)"
echo "bytes: $(wc -c < "$wasm" | tr -d ' ')"
echo "sha256: $(shasum -a 256 "$wasm" | cut -d' ' -f1)"
