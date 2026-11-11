// Proving a withdrawal key with wallets that sign messages and transactions with different keys,
// and with wallets that misbehave. Fake wallets only; nothing is sent anywhere.
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { NearWalletBase } from "@hot-labs/near-connect";
import {
  base64,
  base58,
  claimMessage,
  hex,
  keyProofHash,
  keyProofNonce,
  keyText,
  nep413Hash,
  postingMessage,
  vaultAddress,
} from "../ui/bounty-keys.ts";
import {
  WalletKeyError,
  describeKeyCheck,
  proveWithdrawalKey,
  shortKey,
  signWithdrawal,
  type MessageSigner,
  type WalletKeyErrorCode,
} from "../ui/wallet-keys.ts";
import { adaptWallet } from "../ui/wallet-adapter.ts";
import {
  withdrawHash,
  withdrawMessage,
  withdrawNonce,
} from "../ui/vault-client.ts";
import type { Withdrawal } from "../ui/vault-client.ts";

const CONTRACT = "pr-bounty.proven-funding.testnet";
const ACCOUNT = "contrib.testnet";
const secret = (n: number) => new Uint8Array(32).fill(n);
const keyOf = (n: number) => keyText(ed25519.getPublicKey(secret(n)));
/** Key 1 signs this account's transactions; key 2 is the one its wallet signs messages with. */
const TX_KEY = keyOf(1);
const MESSAGE_KEY = keyOf(2);
const code = hex(new Uint8Array(32).fill(0x30));

const claim = (key: string, actor = ACCOUNT) =>
  claimMessage("testnet", CONTRACT, actor, 609, "2019604405", key, 1794301385);

interface Asked {
  message: string;
  recipient: string;
  nonce: Uint8Array;
}
/** A wallet that signs with `secretOf` and reports `reported` as its key. */
function wallet(
  over: {
    signWith?: number;
    reported?: string | undefined | null;
    sign?: (hash: Uint8Array, asked: Asked) => string;
    throws?: Error;
    label?: string;
  } = {},
) {
  const asked: Asked[] = [];
  const signer: MessageSigner = {
    accountId: ACCOUNT,
    label: over.label ?? "Test wallet",
    signNep413: async (message, recipient, nonce) => {
      asked.push({ message, recipient, nonce });
      if (over.throws) throw over.throws;
      const hash = nep413Hash(message, nonce, recipient);
      const signature =
        over.sign?.(hash, { message, recipient, nonce }) ??
        base64(ed25519.sign(hash, secret(over.signWith ?? 2)));
      return {
        public_key:
          over.reported === null
            ? undefined
            : (over.reported ?? keyOf(over.signWith ?? 2)),
        signature_base64: signature,
      };
    },
  };
  return { signer, asked };
}
const codeOf = async (run: Promise<unknown>): Promise<WalletKeyErrorCode> => {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof WalletKeyError, String(error));
    return error.code;
  }
  throw new Error("expected a WalletKeyError");
};

test("a wallet that signs messages and transactions with one key proves it", async () => {
  const w = wallet({ signWith: 1 });
  const message = claim(TX_KEY);
  const proof = await proveWithdrawalKey(w.signer, message, {
    contract: CONTRACT,
  });
  assert.equal(proof.publicKey, TX_KEY);
  // The wallet is asked for exactly the contract's NEP-413 payload.
  assert.deepEqual(w.asked, [
    {
      message,
      recipient: CONTRACT,
      nonce: keyProofNonce(message),
    },
  ]);
  assert.ok(
    ed25519.verify(
      Buffer.from(proof.signatureBase64, "base64"),
      keyProofHash(message, CONTRACT),
      ed25519.getPublicKey(secret(1)),
    ),
  );
});

test("a wallet whose message key differs from its transaction key is accepted for the message key", async () => {
  // The account has two keys. The wallet's transactions use TX_KEY, its messages use MESSAGE_KEY.
  const w = wallet({ signWith: 2 });
  const message = claim(MESSAGE_KEY);
  const proof = await proveWithdrawalKey(w.signer, message, {
    contract: CONTRACT,
  });
  assert.equal(proof.publicKey, MESSAGE_KEY);
  assert.notEqual(proof.publicKey, TX_KEY);
  // The vault belongs to the key that signed the message, not to the transaction key.
  const vault = vaultAddress(Buffer.from(code, "hex"), proof.publicKey);
  assert.notEqual(vault, vaultAddress(Buffer.from(code, "hex"), TX_KEY));
  const check = describeKeyCheck({
    messageKey: proof.publicKey,
    transactionKey: TX_KEY,
  });
  assert.equal(check.kind, "different");
  assert.match(
    check.text,
    /This wallet signs messages with a different key than it signs transactions; payouts will be withdrawn with ed25519:/,
  );
  assert.ok(check.text.includes(shortKey(MESSAGE_KEY)));
  assert.ok(check.text.includes(shortKey(TX_KEY)));
  assert.ok(
    !check.text.includes(MESSAGE_KEY),
    "the full key is not typeset into the sentence",
  );
});

test("a proof for a posting verifies the same way", async () => {
  const terms = {
    reward: "1000000000000000000000000",
    repo: "proven-test/bounty-pilot",
    repo_id: "800000001",
    issue: 9501,
    base_ref: "main",
    claim_by: "1794310019",
    claim_secs: "3600",
    merge_deadline: "1794313019",
    grace_secs: "600",
  };
  const message = postingMessage(
    "testnet",
    CONTRACT,
    ACCOUNT,
    new Uint8Array(32).fill(9),
    terms,
    MESSAGE_KEY,
    1794301385,
  );
  const proof = await proveWithdrawalKey(wallet().signer, message, {
    contract: CONTRACT,
    expectedKey: MESSAGE_KEY,
  });
  assert.equal(proof.publicKey, MESSAGE_KEY);
});

test("a wallet that reports no public key is refused, even with a valid signature", async () => {
  const w = wallet({ reported: null });
  assert.equal(
    await codeOf(
      proveWithdrawalKey(w.signer, claim(MESSAGE_KEY), { contract: CONTRACT }),
    ),
    "no_public_key",
  );
  assert.equal(
    await codeOf(
      proveWithdrawalKey(wallet({ reported: "" }).signer, claim(MESSAGE_KEY), {
        contract: CONTRACT,
      }),
    ),
    "no_public_key",
  );
});

test("a signature that does not verify is refused: another message, another key, another recipient, or garbage", async () => {
  const message = claim(MESSAGE_KEY);
  const attempts: [string, Parameters<typeof wallet>[0], WalletKeyErrorCode][] =
    [
      [
        "signs another message",
        {
          sign: (_, a) =>
            base64(
              ed25519.sign(keyProofHash(`${a.message} `, CONTRACT), secret(2)),
            ),
        },
        "signature_mismatch",
      ],
      [
        "signs for another recipient",
        {
          sign: (_, a) =>
            base64(
              ed25519.sign(
                nep413Hash(a.message, a.nonce, "other.testnet"),
                secret(2),
              ),
            ),
        },
        "signature_mismatch",
      ],
      [
        "signs with another key than it reports",
        { signWith: 3, reported: MESSAGE_KEY },
        "signature_mismatch",
      ],
      [
        "returns 64 zero bytes",
        { sign: () => base64(new Uint8Array(64)) },
        "signature_mismatch",
      ],
      [
        "returns 63 bytes",
        { sign: () => base64(new Uint8Array(63).fill(1)) },
        "bad_signature",
      ],
      ["returns text", { sign: () => "not a signature!" }, "bad_signature"],
      ["returns nothing", { sign: () => "" }, "bad_signature"],
      [
        "reports a key that is not ed25519",
        { reported: "secp256k1:abcdef" },
        "bad_key",
      ],
      [
        "reports a key of the wrong length",
        { reported: `ed25519:${base58(new Uint8Array(33).fill(1))}` },
        "bad_key",
      ],
    ];
  for (const [label, over, expected] of attempts)
    assert.equal(
      await codeOf(
        proveWithdrawalKey(wallet(over).signer, message, {
          contract: CONTRACT,
        }),
      ),
      expected,
      label,
    );
});

test("a signature in base58 or hex form is read the same as base64", async () => {
  const message = claim(MESSAGE_KEY);
  for (const form of [
    (s: Uint8Array) => `ed25519:${base58(s)}`,
    (s: Uint8Array) => hex(s),
  ]) {
    const w = wallet({
      sign: (hash) => form(ed25519.sign(hash, secret(2))),
    });
    const proof = await proveWithdrawalKey(w.signer, message, {
      contract: CONTRACT,
    });
    assert.equal(proof.publicKey, MESSAGE_KEY);
    assert.match(proof.signatureBase64, /^[A-Za-z0-9+/]+={0,2}$/);
  }
});

test("a wallet that signs with a key other than the expected one is refused", async () => {
  const message = claim(MESSAGE_KEY);
  const w = wallet({ signWith: 3 });
  const error = await proveWithdrawalKey(w.signer, message, {
    contract: CONTRACT,
    expectedKey: MESSAGE_KEY,
  }).catch((e) => e);
  assert.ok(error instanceof WalletKeyError);
  assert.equal(error.code, "key_not_expected");
  assert.ok(error.message.includes(shortKey(keyOf(3))));
  assert.ok(error.message.includes(shortKey(MESSAGE_KEY)));
});

test("a proof for another account is refused before the wallet is asked", async () => {
  const w = wallet();
  assert.equal(
    await codeOf(
      proveWithdrawalKey(w.signer, claim(MESSAGE_KEY, "someone-else.testnet"), {
        contract: CONTRACT,
      }),
    ),
    "wrong_actor",
  );
  assert.equal(
    await codeOf(
      proveWithdrawalKey(w.signer, "no actor line here", {
        contract: CONTRACT,
      }),
    ),
    "wrong_actor",
  );
  assert.deepEqual(w.asked, []);
});

test("a wallet that signs for a different account is refused", async () => {
  // Through the real adapter: the connector answers with another account's name.
  const connector = (accountId: string | undefined) =>
    ({
      manifest: {
        name: "Fake connector",
        features: { testnet: true, signMessage: true },
      },
      getAccounts: async () => [{ accountId: ACCOUNT }],
      signMessage: async (req: {
        message: string;
        recipient: string;
        nonce: Uint8Array;
      }) => ({
        accountId,
        publicKey: MESSAGE_KEY,
        signature: base64(
          ed25519.sign(
            nep413Hash(req.message, req.nonce, req.recipient),
            secret(2),
          ),
        ),
      }),
    }) as unknown as NearWalletBase;
  const message = claim(MESSAGE_KEY);
  const other = adaptWallet(
    connector("other.testnet"),
    ACCOUNT,
    async () => {},
  );
  const error = await proveWithdrawalKey(other, message, {
    contract: CONTRACT,
  }).catch((e) => e);
  assert.ok(error instanceof WalletKeyError);
  assert.equal(error.code, "wallet_error");
  assert.match(error.message, /different or missing account/);
  // The same connector answering for the right account works.
  const right = adaptWallet(connector(ACCOUNT), ACCOUNT, async () => {});
  assert.equal(
    (await proveWithdrawalKey(right, message, { contract: CONTRACT }))
      .publicKey,
    MESSAGE_KEY,
  );
});

test("a wallet that cannot sign messages gives a clear error and sends nothing", async () => {
  const bare = { accountId: ACCOUNT, label: "Old wallet" } as MessageSigner;
  const error = await proveWithdrawalKey(bare, claim(MESSAGE_KEY), {
    contract: CONTRACT,
  }).catch((e) => e);
  assert.ok(error instanceof WalletKeyError);
  assert.equal(error.code, "cannot_sign");
  assert.match(error.message, /Old wallet cannot sign messages/);
  assert.match(error.message, /Nothing was sent/);
  assert.equal(
    await codeOf(signWithdrawal(bare, withdrawal(), MESSAGE_KEY)),
    "cannot_sign",
  );
  // The adapter itself refuses a connector without message signing.
  assert.throws(
    () =>
      adaptWallet(
        {
          manifest: {
            name: "No messages",
            features: { testnet: true, signMessage: false },
          },
        } as unknown as NearWalletBase,
        ACCOUNT,
        async () => {},
      ),
    /message signing/,
  );
});

test("a wallet that fails or is closed gives its reason and nothing is accepted", async () => {
  const w = wallet({ throws: new Error("User closed the window.") });
  const error = await proveWithdrawalKey(w.signer, claim(MESSAGE_KEY), {
    contract: CONTRACT,
  }).catch((e) => e);
  assert.ok(error instanceof WalletKeyError);
  assert.equal(error.code, "wallet_error");
  assert.match(
    error.message,
    /Test wallet did not sign the message\. User closed the window\. Nothing was sent\./,
  );
  // A thrown value that is not an Error still ends in a clear message.
  const odd = wallet();
  odd.signer.signNep413 = async () => {
    throw "closed";
  };
  assert.equal(
    await codeOf(
      proveWithdrawalKey(odd.signer, claim(MESSAGE_KEY), {
        contract: CONTRACT,
      }),
    ),
    "wallet_error",
  );
});

// ---- Withdrawals ----
function withdrawal(over: Partial<Withdrawal> = {}): Withdrawal {
  return {
    chain: "testnet",
    vault: vaultAddress(Buffer.from(code, "hex"), MESSAGE_KEY),
    to: "payee.testnet",
    amount: 5_000_000_000_000_000_000_000n,
    n: 3n,
    deadline: 1794301385,
    ...over,
  };
}

test("a withdrawal is signed by the vault's key for exactly this vault, amount and number", async () => {
  const w = wallet({ signWith: 2 });
  const sent = withdrawal();
  const signature = await signWithdrawal(w.signer, sent, MESSAGE_KEY);
  assert.equal(signature.length, 64);
  assert.deepEqual(w.asked, [
    {
      message: withdrawMessage(sent),
      recipient: sent.vault,
      nonce: withdrawNonce(3n),
    },
  ]);
  assert.ok(
    ed25519.verify(
      signature,
      withdrawHash(sent),
      ed25519.getPublicKey(secret(2)),
    ),
  );
  // It does not verify for any other amount or number.
  assert.ok(
    !ed25519.verify(
      signature,
      withdrawHash(withdrawal({ amount: sent.amount + 1n })),
      ed25519.getPublicKey(secret(2)),
    ),
  );
  assert.ok(
    !ed25519.verify(
      signature,
      withdrawHash(withdrawal({ n: 4n })),
      ed25519.getPublicKey(secret(2)),
    ),
  );
});

test("a withdrawal signed by another key, or not by the key it names, is refused", async () => {
  const sent = withdrawal();
  // The connected wallet is not the vault's key (the person switched accounts or wallets).
  const error = await signWithdrawal(
    wallet({ signWith: 1 }).signer,
    sent,
    MESSAGE_KEY,
  ).catch((e) => e);
  assert.ok(error instanceof WalletKeyError);
  assert.equal(error.code, "key_not_expected");
  assert.equal(
    await codeOf(
      signWithdrawal(
        wallet({ signWith: 3, reported: MESSAGE_KEY }).signer,
        sent,
        MESSAGE_KEY,
      ),
    ),
    "signature_mismatch",
  );
  assert.equal(
    await codeOf(
      signWithdrawal(wallet({ reported: null }).signer, sent, MESSAGE_KEY),
    ),
    "no_public_key",
  );
  assert.equal(
    await codeOf(
      signWithdrawal(
        wallet({ throws: new Error("closed") }).signer,
        sent,
        MESSAGE_KEY,
      ),
    ),
    "wallet_error",
  );
  // A signature over a different amount is not this withdrawal's.
  const wrongAmount = wallet({
    sign: () =>
      base64(ed25519.sign(withdrawHash(withdrawal({ amount: 1n })), secret(2))),
  });
  assert.equal(
    await codeOf(signWithdrawal(wrongAmount.signer, sent, MESSAGE_KEY)),
    "signature_mismatch",
  );
});

test("the key check sentence covers same, different and unknown keys", () => {
  const same = describeKeyCheck({
    messageKey: MESSAGE_KEY,
    transactionKey: MESSAGE_KEY,
  });
  assert.equal(same.kind, "same");
  assert.match(same.text, /same key/);
  const unknown = describeKeyCheck({ messageKey: MESSAGE_KEY });
  assert.equal(unknown.kind, "unknown");
  assert.equal(
    describeKeyCheck({ messageKey: MESSAGE_KEY, transactionKey: null }).kind,
    "unknown",
  );
  assert.match(unknown.text, /could not be checked/);
  const different = describeKeyCheck({
    messageKey: MESSAGE_KEY,
    transactionKey: TX_KEY,
  });
  assert.equal(different.kind, "different");
  assert.match(
    different.text,
    /cannot be recovered|lost, the money cannot be recovered/,
  );
  for (const check of [same, unknown, different])
    assert.ok(check.text.includes(shortKey(MESSAGE_KEY)));
});

test("short keys keep the start and the end, and leave short text alone", () => {
  assert.equal(
    shortKey(MESSAGE_KEY),
    `ed25519:${MESSAGE_KEY.slice(8, 12)}…${MESSAGE_KEY.slice(-4)}`,
  );
  assert.equal(shortKey("ed25519:abc"), "ed25519:abc");
  assert.equal(shortKey("nonsense"), "nonsense");
});
