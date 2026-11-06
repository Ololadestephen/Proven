import assert from "node:assert/strict";
import test from "node:test";
import { attestationUrl, networkSettings } from "./network.ts";

test("mainnet is refused without the Stage 2 flag", () => {
  assert.throws(() => networkSettings("mainnet", undefined), /Stage 2/);
  assert.throws(() => networkSettings("mainnet", "no"), /Stage 2/);
  assert.equal(
    networkSettings("mainnet", "yes").custodyApi,
    "https://api.outlayer.ai",
  );
  assert.equal(networkSettings(undefined, undefined).network, "testnet");
  assert.throws(() => networkSettings("devnet", "yes"));
});

test("attestation links follow the network", () => {
  assert.match(attestationUrl("7", "e.testnet"), /testnet-api/);
  assert.match(attestationUrl("7", "e.near"), /\/\/api\.outlayer/);
});
