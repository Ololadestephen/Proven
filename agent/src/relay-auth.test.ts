import assert from "node:assert/strict";
import test from "node:test";
import { KeyPair } from "near-api-js";
import { nep413Digest, RELAY_RECIPIENT } from "../../relay/src/buyer-auth.ts";
import { relayMessage, relayPayload, signWithKey } from "./relay-auth.ts";

// SHA-256 of the exact pre-hash texts; the relay's own tests check the same separation.
const EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const A = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";

test("the payload hashes exactly the texts each action signs", () => {
  assert.equal(
    relayPayload({ action: "challenge", check: "a", reference: "bc" }),
    "40bb547d936bbd31318ee37ac8799e7ecbb22eda2651f65e3214bffb8ce97bb4",
  );
  assert.equal(
    relayPayload({ action: "challenge", check: "ab", reference: "c" }),
    "6c032e631d39a14d85aff7e319546af701e26c97b57ca95fbfe9c6ba855f67bf",
  );
  assert.equal(relayPayload({ action: "deliver", deliverable: "a" }), A);
  assert.equal(relayPayload({ action: "cleanup", kind: "a" }), A);
  assert.equal(relayPayload({ action: "collect", deliverable: "a" }), EMPTY);
});

test("the message names the relay, action, job, payload and time", () => {
  const before = Date.now();
  const message = relayMessage({ action: "collect", job_id: 7 });
  const match = /^proven-relay:collect:7:([a-f0-9]{64}):(\d+)$/.exec(message);
  assert.ok(match, message);
  assert.equal(match[1], EMPTY);
  assert.ok(Number(match[2]) >= before && Number(match[2]) <= Date.now());
});

test("a key signs the NEP-413 digest addressed to the relay", () => {
  const pair = KeyPair.fromRandom("ed25519");
  const message = "proven-relay:collect:7:" + EMPTY + ":1";
  const signed = signWithKey(pair.toString(), message);
  assert.equal(signed.public_key, pair.getPublicKey().toString());
  const nonce = Buffer.from(signed.nonce_base64, "base64");
  assert.equal(nonce.length, 32);
  const signature = Buffer.from(signed.signature_base64, "base64");
  assert.ok(
    pair.verify(nep413Digest(message, nonce, RELAY_RECIPIENT), signature),
  );
  assert.ok(
    !pair.verify(nep413Digest(message, nonce, "someone-else"), signature),
  );
});
