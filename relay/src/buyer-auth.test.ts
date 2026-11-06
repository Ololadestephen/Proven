import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import {
  base58Decode,
  nep413Digest,
  RELAY_RECIPIENT,
  relayMessage,
  relayPayload,
  RelayVerifier,
  type RelayAuth,
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

const PAYLOAD = relayPayload({ action: "collect" });
function auth(
  over: {
    job?: number;
    at?: number;
    recipient?: string;
    action?: string;
    payload?: string;
  } = {},
): RelayAuth {
  const message = relayMessage(
    over.action ?? "collect",
    over.job ?? 7,
    over.payload ?? PAYLOAD,
    over.at ?? NOW,
  );
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
  new RelayVerifier(
    async () => onChain,
    () => NOW,
  );
const check = (
  v: RelayVerifier,
  a: RelayAuth | undefined,
  who: string[] = [implicit],
) => v.verify(a, who, "collect", 7, PAYLOAD);

test("base58 round-trips a key", () => {
  assert.deepEqual(base58Decode(base58(raw)), Buffer.from(raw));
});

test("the right key can act, once per signature", async () => {
  const v = verifier();
  const good = auth();
  assert.equal(await check(v, good), true);
  assert.equal(await check(v, good), false, "replay");
});

test("a named account's key must be on chain, and any allowed account will do", async () => {
  assert.equal(await check(verifier(true), auth(), ["buyer.testnet"]), true);
  assert.equal(await check(verifier(false), auth(), ["buyer.testnet"]), false);
  assert.equal(
    await check(verifier(false), auth(), ["other.testnet", implicit]),
    true,
  );
});

test("anyone else, another job, action or text, an old message or another recipient is refused", async () => {
  const v = verifier();
  assert.equal(await check(v, auth(), ["b".repeat(64)]), false, "not allowed");
  assert.equal(await check(v, auth({ job: 8 })), false, "other job");
  assert.equal(
    await check(v, auth({ action: "deliver" })),
    false,
    "other action",
  );
  assert.equal(
    await check(v, auth({ payload: "c".repeat(64) })),
    false,
    "other text",
  );
  assert.equal(await check(v, auth({ at: NOW - 400_000 })), false, "old");
  assert.equal(await check(v, auth({ recipient: "other" })), false);
  assert.equal(await check(v, undefined), false, "unsigned");
  const tampered = auth();
  tampered.message = relayMessage("collect", 7, PAYLOAD, NOW + 1);
  assert.equal(await check(v, tampered), false, "tampered");
  assert.equal(await check(v, { ...auth(), signature_base64: "bad" }), false);
});

test("a signature covers the exact texts", () => {
  const one = relayPayload({ action: "deliver", deliverable: "a" });
  assert.notEqual(one, relayPayload({ action: "deliver", deliverable: "b" }));
  assert.notEqual(
    relayPayload({ action: "challenge", check: "a", reference: "bc" }),
    relayPayload({ action: "challenge", check: "ab", reference: "c" }),
  );
});

test("a nonce written another way, or in the wrong type, is not a new nonce", async () => {
  const verifier = new RelayVerifier(
    async () => false,
    () => NOW,
  );
  const first = auth({ job: 7 });
  first.public_key = encoded;
  const account = implicit;
  assert.equal(
    await verifier.verify(first, [account], "collect", 7, PAYLOAD),
    true,
  );
  const reworded = {
    ...first,
    nonce_base64: Buffer.from(first.nonce_base64, "base64").toString(
      "base64url",
    ),
  };
  assert.equal(
    await verifier.verify(reworded, [account], "collect", 7, PAYLOAD),
    false,
  );
  const asArray = {
    ...first,
    nonce_base64: [...Buffer.from(first.nonce_base64, "base64")],
  } as unknown as RelayAuth;
  assert.equal(
    await verifier.verify(asArray, [account], "collect", 7, PAYLOAD),
    false,
  );
});
