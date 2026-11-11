#!/usr/bin/env bash
# Builds the vault for NEAR (wasm32-unknown-unknown) and prints its size, SHA-256 and the global
# publication cost (bytes x 10^-4 NEAR, before gas). Local paths are remapped so the bytes do not
# depend on where the checkout or the Cargo home sits; the same rustc and Cargo.lock give the same
# hash (check by building from a copy in another directory). Nothing here publishes or deploys.
set -euo pipefail
cd "$(dirname "$0")"
root="$(pwd)"
physical="$(pwd -P)"
target="${VAULT_TARGET_DIR:-$root/target}"
export RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${physical}=/build --remap-path-prefix=${root}=/build"
cargo build --locked --release --target wasm32-unknown-unknown --target-dir "$target" --quiet
mkdir -p out
cp "$target/wasm32-unknown-unknown/release/proven_vault.wasm" out/proven_vault.wasm
bytes=$(wc -c < out/proven_vault.wasm | tr -d ' ')
echo "rustc: $(rustc --version)"
echo "bytes: $bytes"
echo "sha256: $(shasum -a 256 out/proven_vault.wasm | cut -d' ' -f1)"
echo "publication storage: $(python3 -c "print(f'{$bytes / 10000:.4f}')") NEAR (plus deploy gas)"
