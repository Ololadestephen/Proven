#!/usr/bin/env bash
# Builds the prototype contracts into target/proto/ and prints their sizes and SHA-256.
# Sandbox only: nothing here is published or deployed.
#
# The vault has no dependencies and is built with plain cargo: wasm32-unknown-unknown, the
# workspace's size-optimized release profile, MVP opcodes only, and local paths remapped so the
# bytes do not depend on where the checkout or the Cargo home sits. The same rustc and the same
# tree give the same hash (checked by building from a copy in another directory).
#
# `./build.sh vault` builds only the vault.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p target/proto
root="$(pwd)"
physical="$(pwd -P)"
export RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${physical}=/build --remap-path-prefix=${root}=/build"
cargo build --locked --release --target wasm32-unknown-unknown -p proven-proto-vault \
  --target-dir target/vault-build --quiet
unset RUSTFLAGS
cp target/vault-build/wasm32-unknown-unknown/release/proven_proto_vault.wasm target/proto/
if [ "${1:-all}" != "vault" ]; then
  for crate in escrow actor; do
    (cd "$crate" && cargo near build non-reproducible-wasm --no-abi --out-dir ../target/proto >/dev/null)
  done
  rm -rf target/cargo-near-abi
fi
echo "rustc: $(rustc --version)"
for wasm in target/proto/*.wasm; do
  echo "$(basename "$wasm") bytes=$(wc -c < "$wasm" | tr -d ' ') sha256=$(shasum -a 256 "$wasm" | cut -d' ' -f1)"
done
