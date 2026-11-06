import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import {
  base58Decode,
  collectMessage,
  CollectVerifier,
  nep413Digest,
  RELAY_RECIPIENT,
  type CollectAuth,
} from "./buyer-auth.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  return out;
}

const NOW = 1_800_000_000_000;
const pair = generateKeyPairSync("ed25519");
const raw = pair.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const encoded = `ed25519:${base58(raw)}`;
const implicit = raw.toString("hex");

function auth(
  over: { job?: number; at?: number; recipient?: string } = {},
): CollectAuth {
  const message = collectMessage(over.job ?? 7, over.at ?? NOW);
  const nonce = randomBytes(32);
  return {
    public_key: encoded,
    message,
    nonce_base64: nonce.toString("base64"),
    signature_base64: sign(
      null,
      nep413Digest(message, nonce, over.recipient ?? RELAY_RECIPIENT),
      pair.privateKey,
    ).toString("base64"),
  };
}
const verifier = (onChain = false) =>
  new CollectVerifier(
    async () => onChain,
    () => NOW,
  );

test("base58 round-trips a key", () => {
  assert.deepEqual(base58Decode(base58(raw)), Buffer.from(raw));
});

test("the buyer's own key can collect its job, once per signature", async () => {
  const v = verifier();
  const good = auth();
  assert.equal(await v.verify(good, implicit, 7), true);
  assert.equal(await v.verify(good, implicit, 7), false, "replay");
});

test("a named buyer's key must be on chain", async () => {
  assert.equal(await verifier(true).verify(auth(), "buyer.testnet", 7), true);
  assert.equal(await verifier(false).verify(auth(), "buyer.testnet", 7), false);
});

test("anyone else, another job, an old message or another recipient is refused", async () => {
  const v = verifier();
  assert.equal(
    await v.verify(auth(), "b".repeat(64), 7),
    false,
    "not the buyer",
  );
  assert.equal(
    await v.verify(auth({ job: 8 }), implicit, 7),
    false,
    "other job",
  );
  assert.equal(
    await v.verify(auth({ at: NOW - 400_000 }), implicit, 7),
    false,
    "old",
  );
  assert.equal(
    await v.verify(auth({ recipient: "other" }), implicit, 7),
    false,
  );
  const tampered = auth();
  tampered.message = collectMessage(7, NOW + 1);
  assert.equal(await v.verify(tampered, implicit, 7), false, "tampered");
  assert.equal(
    await v.verify({ ...auth(), signature_base64: "bad" }, implicit, 7),
    false,
  );
});
