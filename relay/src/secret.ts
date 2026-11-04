// OutLayer secrets owned by the relay. The check, the reference and the deliverable are
// encrypted on this machine to the OutLayer keystore key for one exact verifier build (a
// WASM-hash-bound secret), stored on chain as ciphertext with `store_secrets`, and readable only by
// that build inside the TEE, only when the relay account calls it. The relay owns them, so no buyer
// or worker can change or delete them after handing them over.
//
//   npm run secret -- store <profile> <check.json> [reference.json]
//   npm run secret -- delete <profile>          (returns the 0.1 NEAR storage deposit)
//
// Encryption is OutLayer's ECIES v1, matching out-layer/outlayer-cli src/crypto.rs: X25519 ECDH,
// HKDF-SHA256 with info "outlayer-keystore-v1", ChaCha20-Poly1305, wire format
// [0x01 | ephemeral pub | nonce | ciphertext | tag]. The keystore key is fetched with an empty
// `secrets_json`, so no plaintext leaves this machine. That key comes from OutLayer's API and is
// trusted as OutLayer's TEE key; it is not attested here.

import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Account } from "near-api-js";
import { parseNearAmount } from "near-api-js";
import { type Config, loadConfig } from "./config.ts";
import { sha256Hex } from "./hash.ts";
import { relayAccount } from "./near.ts";

const HKDF_INFO = Buffer.from("outlayer-keystore-v1");
/// DER prefix of an X25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function encryptForKeystore(publicKeyHex: string, plaintext: string): string {
  const recipientRaw = Buffer.from(publicKeyHex, "hex");
  if (recipientRaw.length !== 32) throw new Error("the keystore key must be 32 bytes");
  const recipient = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, recipientRaw]), format: "der", type: "spki" });
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const ephemeralRaw = ephemeral.publicKey.export({ format: "der", type: "spki" }).subarray(X25519_SPKI_PREFIX.length);
  return Buffer.concat([Buffer.from([0x01]), ephemeralRaw, nonce, ciphertext]).toString("base64");
}

async function keystoreKey(api: string, wasmHash: string, owner: string, profile: string): Promise<string> {
  const response = await fetch(`${api}/secrets/pubkey`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessor: { type: "WasmHash", hash: wasmHash }, owner, profile, secrets_json: "{}" }),
  });
  if (!response.ok) throw new Error(`keystore key request failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { pubkey: string }).pubkey;
}

export const PROFILE_PATTERN = /^[a-z0-9_-]{1,48}$/;

function settled(response: { status: unknown; transaction: { hash: string } }, what: string): string {
  const status = response.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) throw new Error(`${what} failed: ${JSON.stringify(status.Failure ?? status)}`);
  return response.transaction.hash;
}

/** Stores `variables` as a secret owned by the relay, readable only by the configured verifier
 * build when the relay calls it. Returns the transaction hash and the ciphertext size. */
export async function storeSecret(account: Account, config: Config, profile: string, variables: Record<string, string>): Promise<{ transactionHash: string; ciphertextBytes: number }> {
  if (!PROFILE_PATTERN.test(profile)) throw new Error("profile: 1 to 48 of a-z, 0-9, _ and -");
  const publicKey = await keystoreKey(config.outlayerApi, config.verifierWasmHash, account.accountId, profile);
  const encrypted = encryptForKeystore(publicKey, JSON.stringify(variables));
  const response = await account.callFunctionRaw({
    contractId: config.outlayerContract,
    methodName: "store_secrets",
    args: {
      accessor: { WasmHash: { hash: config.verifierWasmHash } },
      profile,
      encrypted_secrets_base64: encrypted,
      access: { Whitelist: { accounts: [account.accountId] } },
      vault_id: null,
    },
    deposit: parseNearAmount("0.1") ?? "0",
    gas: 50_000_000_000_000n,
  });
  return { transactionHash: settled(response, "store_secrets"), ciphertextBytes: Buffer.from(encrypted, "base64").length };
}

/** Deletes a relay-owned secret and returns its storage deposit. */
export async function deleteSecret(account: Account, config: Config, profile: string): Promise<string> {
  const response = await account.callFunctionRaw({
    contractId: config.outlayerContract,
    methodName: "delete_secrets",
    args: { accessor: { WasmHash: { hash: config.verifierWasmHash } }, profile },
    gas: 50_000_000_000_000n,
  });
  return settled(response, "delete_secrets");
}

async function main(): Promise<void> {
  const [command, profile, checkPath, referencePath] = process.argv.slice(2);
  const config = loadConfig();
  const account = relayAccount(config);
  if (command === "delete" && profile) {
    console.log(JSON.stringify({ deleted: profile, transaction_hash: await deleteSecret(account, config, profile) }));
    return;
  }
  if (command !== "store" || !profile || !checkPath) {
    console.error("usage: secret store <profile> <check.json> [reference.json] | secret delete <profile>");
    process.exit(2);
  }
  const variables: Record<string, string> = { PROVEN_CHECK: readFileSync(checkPath, "utf8") };
  if (referencePath) variables.PROVEN_REFERENCE = readFileSync(referencePath, "utf8");
  const stored = await storeSecret(account, config, profile, variables);
  console.log(JSON.stringify({ profile, owner: account.accountId, secrets_ref: { profile, account_id: account.accountId }, bound_to_verifier: config.verifierWasmHash, ...stored }, null, 2));
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(`secret: ${error.message}`);
    process.exit(1);
  });
}
