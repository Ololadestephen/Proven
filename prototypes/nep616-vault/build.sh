#!/usr/bin/env bash
# Builds the three prototype contracts into target/proto/ and prints their sizes and SHA-256.
# Sandbox only: nothing here is published or deployed.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p target/proto
for crate in vault escrow actor; do
  (cd "$crate" && cargo near build non-reproducible-wasm --out-dir ../target/proto >/dev/null)
done
for wasm in target/proto/*.wasm; do
  echo "$(basename "$wasm") bytes=$(wc -c < "$wasm" | tr -d ' ') sha256=$(shasum -a 256 "$wasm" | cut -d' ' -f1)"
done
