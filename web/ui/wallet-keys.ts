// Wallet message signing for the withdrawal key. Some wallets sign messages with a different key
// than the one that signs their transactions (an account with several access keys, a hardware
// wallet, a wallet that derives a separate message key). The contract takes the withdrawal key
// explicitly, so the key that counts is the one the wallet says it signed the message with. These
// functions ask for a NEP-413 signature, take the public key from the wallet's own answer, and
// check the signature locally against that key and the exact bytes the contract will hash before
// the page uses it. Nothing here sends a transaction.
import {
  base64,
  ed25519Key,
  keyProofHash,
  keyProofNonce,
  keyText,
  signatureBytes,
  verifies,
} from "./bounty-keys.ts";
import {
  withdrawHash,
  withdrawMessage,
  withdrawNonce,
} from "./vault-client.ts";
import type { Withdrawal } from "./vault-client.ts";

/** The part of the page's wallet this module needs. */
export interface MessageSigner {
  accountId: string;
  label?: string;
  signNep413?: (
    message: string,
    recipient: string,
    nonce: Uint8Array,
  ) => Promise<{ public_key?: string; signature_base64?: string }>;
}

export type WalletKeyErrorCode =
  | "cannot_sign"
  | "wallet_error"
  | "wrong_actor"
  | "no_public_key"
  | "bad_key"
  | "key_not_expected"
  | "bad_signature"
  | "signature_mismatch";
export class WalletKeyError extends Error {
  readonly code: WalletKeyErrorCode;
  constructor(code: WalletKeyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
const nameOf = (wallet: MessageSigner) => wallet.label ?? "This wallet";

/** `ed25519:6W6S…hffW`: enough to recognize a key, never enough to type one. */
export function shortKey(key: string): string {
  const [curve = "", body = ""] = key.split(":");
  return body.length > 12
    ? `${curve}:${body.slice(0, 4)}…${body.slice(-4)}`
    : key;
}

/** What a proof returns: the key the wallet signed with, and the signature as base64. */
export interface KeyProof {
  publicKey: string;
  signatureBase64: string;
}

/**
 * Asks the wallet to sign `message` (a withdrawal-key proof text) for `contract`, and returns the
 * key the wallet names with a signature that verifies against that key. Refuses, with a message
 * the page can show, a wallet that cannot sign messages, a signature without a key, a key that is
 * not ed25519, a malformed signature, or a signature that does not verify. With `expectedKey`, a
 * wallet that signs with another key is refused too. Also refuses a text that names another
 * account as its actor, before the wallet is asked.
 */
export async function proveWithdrawalKey(
  wallet: MessageSigner,
  message: string,
  options: { contract: string; expectedKey?: string },
): Promise<KeyProof> {
  const { contract, expectedKey } = options;
  const signer = wallet.signNep413;
  if (typeof signer !== "function")
    throw new WalletKeyError(
      "cannot_sign",
      `${nameOf(wallet)} cannot sign messages, so it cannot prove a withdrawal key. Nothing was sent. Choose a wallet that supports message signing.`,
    );
  const actor = /^actor: (.+)$/m.exec(message)?.[1];
  if (actor !== wallet.accountId)
    throw new WalletKeyError(
      "wrong_actor",
      `This proof is for ${actor ?? "no account"}, not for the connected account ${wallet.accountId}. Nothing was signed.`,
    );
  let answer: Awaited<ReturnType<NonNullable<MessageSigner["signNep413"]>>>;
  try {
    answer = await signer.call(
      wallet,
      message,
      contract,
      keyProofNonce(message),
    );
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new WalletKeyError(
      "wallet_error",
      `${nameOf(wallet)} did not sign the message.${reason} Nothing was sent.`,
    );
  }
  return checkProof(
    wallet,
    answer,
    keyProofHash(message, contract),
    expectedKey,
  );
}

/** Checks a wallet's answer against the hash it should have signed, using the key it reports. */
function checkProof(
  wallet: MessageSigner,
  answer: { public_key?: string; signature_base64?: string } | null | undefined,
  hash: Uint8Array,
  expectedKey?: string,
): KeyProof {
  const reported = answer?.public_key;
  if (typeof reported !== "string" || !reported)
    throw new WalletKeyError(
      "no_public_key",
      `${nameOf(wallet)} signed but did not say which key it used, so the signature cannot be checked. The withdrawal key is not accepted.`,
    );
  let publicKey: Uint8Array;
  try {
    publicKey = ed25519Key(reported);
  } catch {
    throw new WalletKeyError(
      "bad_key",
      `${nameOf(wallet)} signed with a key that is not an ed25519 key. Vaults accept ed25519 keys only.`,
    );
  }
  const key = keyText(publicKey);
  if (expectedKey !== undefined && key !== keyText(ed25519Key(expectedKey)))
    throw new WalletKeyError(
      "key_not_expected",
      `${nameOf(wallet)} signed with ${shortKey(key)}, not with the expected key ${shortKey(expectedKey)}.`,
    );
  let signature: Uint8Array;
  try {
    signature = signatureBytes(String(answer?.signature_base64 ?? ""));
  } catch {
    throw new WalletKeyError(
      "bad_signature",
      `${nameOf(wallet)} returned a signature that is not 64 bytes. The withdrawal key is not accepted.`,
    );
  }
  if (!verifies(signature, hash, publicKey))
    throw new WalletKeyError(
      "signature_mismatch",
      `The signature does not match ${shortKey(key)} and this exact text. The wallet may have signed with a different key or a different message. The withdrawal key is not accepted.`,
    );
  return { publicKey: key, signatureBase64: base64(signature) };
}

/**
 * Signs one withdrawal with the wallet and checks it against the vault's key. The signature is
 * returned only if it verifies for exactly this vault, destination, amount, number and deadline
 * and was made by `vaultKey`. Nothing is sent.
 */
export async function signWithdrawal(
  wallet: MessageSigner,
  withdrawal: Withdrawal,
  vaultKey: string,
): Promise<Uint8Array> {
  const signer = wallet.signNep413;
  if (typeof signer !== "function")
    throw new WalletKeyError(
      "cannot_sign",
      `${nameOf(wallet)} cannot sign messages, so it cannot authorize a withdrawal. Nothing was sent.`,
    );
  let answer: Awaited<ReturnType<NonNullable<MessageSigner["signNep413"]>>>;
  try {
    answer = await signer.call(
      wallet,
      withdrawMessage(withdrawal),
      withdrawal.vault,
      withdrawNonce(withdrawal.n),
    );
  } catch (error) {
    const reason = error instanceof Error ? ` ${error.message}` : "";
    throw new WalletKeyError(
      "wallet_error",
      `${nameOf(wallet)} did not sign the withdrawal.${reason} Nothing was sent.`,
    );
  }
  const proof = checkProof(wallet, answer, withdrawHash(withdrawal), vaultKey);
  return signatureBytes(proof.signatureBase64);
}

export type KeyCheck =
  | { kind: "same"; text: string }
  | { kind: "different"; text: string }
  | { kind: "unknown"; text: string };

/**
 * What the page tells the person about the key that will own the vault. `messageKey` is the key
 * the wallet signed the proof with; `transactionKey` is the key that signs its transactions, when
 * the page knows it (for example from the wallet's account list).
 */
export function describeKeyCheck(input: {
  messageKey: string;
  transactionKey?: string | null;
}): KeyCheck {
  const message = shortKey(input.messageKey);
  const transaction = input.transactionKey ?? null;
  if (transaction === null)
    return {
      kind: "unknown",
      text: `Payouts will be withdrawn with ${message}, the key this wallet signs messages with. Whether it is also the key that signs this wallet's transactions could not be checked. Keep this key: the money cannot be recovered without it.`,
    };
  if (transaction === input.messageKey)
    return {
      kind: "same",
      text: `This wallet signs messages and transactions with the same key (${message}). Payouts will be withdrawn with this key.`,
    };
  return {
    kind: "different",
    text: `This wallet signs messages with a different key than it signs transactions; payouts will be withdrawn with ${message}. Its transactions use ${shortKey(transaction)}. Keep the message-signing key: if it is lost, the money cannot be recovered.`,
  };
}
