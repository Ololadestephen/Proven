import assert from "node:assert/strict";
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import { test } from "node:test";
import { encryptForKeystore } from "./secret.ts";

const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/// The keystore's side of ECIES v1, written independently here to check our encryption.
function decrypt(privateKey: ReturnType<typeof createPrivateKey>, base64: string): string {
  const wire = Buffer.from(base64, "base64");
  assert.equal(wire[0], 0x01);
  const ephemeral = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, wire.subarray(1, 33)]), format: "der", type: "spki" });
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey, publicKey: ephemeral }), Buffer.alloc(0), Buffer.from("outlayer-keystore-v1"), 32));
  const nonce = wire.subarray(33, 45);
  const body = wire.subarray(45, wire.length - 16);
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(wire.subarray(wire.length - 16));
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

test("encryption matches OutLayer's ECIES v1 wire format and decrypts with the recipient key", () => {
  const recipient = generateKeyPairSync("x25519");
  const publicHex = recipient.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("hex");
  const plaintext = JSON.stringify({ PROVEN_CHECK: "{\"kind\":\"data\"}", PROVEN_REFERENCE: "{\"rows\":[]}" });
  const sealed = encryptForKeystore(publicHex, plaintext);
  assert.equal(Buffer.from(sealed, "base64").length, 1 + 32 + 12 + Buffer.byteLength(plaintext) + 16);
  assert.equal(decrypt(recipient.privateKey, sealed), plaintext);
  assert.notEqual(encryptForKeystore(publicHex, plaintext), sealed, "each encryption uses a fresh ephemeral key and nonce");
});

test("a tampered ciphertext does not decrypt", () => {
  const recipient = generateKeyPairSync("x25519");
  const publicHex = recipient.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("hex");
  const wire = Buffer.from(encryptForKeystore(publicHex, "secret"), "base64");
  wire[50] ^= 1;
  assert.throws(() => decrypt(recipient.privateKey, wire.toString("base64")));
});
