import assert from "node:assert/strict";
import test from "node:test";
import { attestationUrl, near } from "../ui/bounty-text.ts";
import { COIN, OUTLAYER_API } from "../ui/network.ts";

const NEAR = 10n ** 24n;

test("near() shows up to six decimals and the network's coin", () => {
  assert.equal(near(0n), `0 ${COIN}`);
  assert.equal(near(NEAR), `1 ${COIN}`);
  assert.equal(near(NEAR + NEAR / 2n), `1.5 ${COIN}`);
  assert.equal(near("60000000000000000000000"), `0.06 ${COIN}`);
  assert.equal(near(100_000_000_000_000_000_000n), `0.0001 ${COIN}`);
  // Beyond six decimals is cut, never rounded, and never leaves trailing zeros.
  assert.equal(near(NEAR + 1n), `1 ${COIN}`);
  assert.equal(near(1_234_567_890_000_000_000_000n), `0.001234 ${COIN}`);
  assert.equal(near("1000000000000000000000000"), near(NEAR));
});

test("attestationUrl points at the network's OutLayer API", () => {
  assert.equal(
    attestationUrl("3005"),
    `${OUTLAYER_API}/attestations/by-request/3005`,
  );
});
