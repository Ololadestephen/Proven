// The wallet flows of the PR bounty page (post, claim, link, withdraw) with fake wallets, a fake
// chain, a fake GitHub network and the real bounty journal. Nothing here touches a real network,
// wallet or key. Flows are called with approved=true; with approved=false each refuses first.
import assert from "node:assert/strict";
import test from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  claimFlow,
  discoverMessageKey,
  linkFlow,
  postFlow,
  postBountyCall,
  sendFlow,
  withdrawFlow,
  withdrawCall,
  SIGNING_OFF,
  type FlowChain,
  type FlowWallet,
} from "../ui/bounty-actions.ts";
import {
  base64,
  claimMessage,
  fromHex,
  keyText,
  linkChallenge,
  nep413Hash,
  postingMessage,
} from "../ui/bounty-keys.ts";
import {
  ADVANCED_DEFAULTS,
  PREVIEW_FEES,
  reviewPosting,
  type Review,
} from "../ui/posting-review.ts";
import { WalletKeyError } from "../ui/wallet-keys.ts";
import { withdrawHash } from "../ui/vault-client.ts";
import { BOUNTY_PENDING_KEY } from "../ui/action-guard.ts";
import type {
  BountyReader,
  BountyView,
  WalletLinkView,
} from "../ui/bounty-reconcile.ts";
import {
  IDLE_MESSAGE,
  guardBountyWallet,
  readBountyJournal,
  reconcileBountyJournal,
  releaseBountyJournal,
  snapshotBefore,
  type BountyTarget,
  type JournalEnv,
} from "../ui/bounty-wallet.ts";
import type { Call, Wallet } from "../ui/market-types.ts";
import { GIST_FILE } from "../ui/github-link.ts";
import type { VaultRead } from "../ui/vault-view.ts";

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;
const NOW = 1_793_000_000;
const CONTRACT = "pr-bounty.proven-funding.testnet";
const NETWORK = "testnet";
const ME = "contrib.testnet";
const VAULT = `0s${"ab".repeat(20)}`;
const secret = (n: number) => new Uint8Array(32).fill(n);
const keyOf = (n: number) => keyText(ed25519.getPublicKey(secret(n)));
/** Key 1 signs this account's transactions; key 2 is what its wallet signs messages with. */
const TX_KEY = keyOf(1);
const MESSAGE_KEY = keyOf(2);
const NONCE = new Uint8Array(32).fill(0x5a);

const review = (): Review => {
  const out = reviewPosting({
    meta: {
      repo: "Ololadestephen/flop",
      repo_id: 1346702196,
      issue: 1,
      title: "Pilot A",
      html_url: "https://github.com/Ololadestephen/flop/issues/1",
      default_branch: "main",
    },
    rewardText: "0.1",
    advanced: ADVANCED_DEFAULTS,
    limits: { max_reward: 2n * NEAR, room: 5n * NEAR },
    pilot: { repo: "Ololadestephen/flop", repo_id: 1346702196 },
    fees: PREVIEW_FEES,
    now: NOW,
  });
  assert.ok(out.ok);
  return out.review;
};

// ---- A fake chain ----

interface ChainState {
  bounty: BountyView;
  link: WalletLinkView | null;
  nonces: Set<string>;
  posted: Map<string, number>;
  vaultN: bigint;
  barred: boolean;
  /** What the contract's own text views say, instead of the page's, to test a disagreement. */
  differentText: boolean;
  /** The wallet's link number as the contract reports it. */
  linkNumber: number;
  /** When set, `link_challenge` answers for this wallet instead of the one asked about. */
  challengeFor: string | null;
  reads: string[];
}
const openBounty = (): BountyView => ({
  buyer: "maint.testnet",
  status: "Open",
  claim: null,
  binding: null,
  live: null,
  last_check: null,
  payout: null,
  refund: null,
});
function fakeChain(over: Partial<ChainState> = {}) {
  const state: ChainState = {
    bounty: openBounty(),
    link: null,
    nonces: new Set(),
    posted: new Map(),
    vaultN: 0n,
    barred: false,
    differentText: false,
    linkNumber: 0,
    challengeFor: null,
    reads: [],
    ...over,
  };
  const chain: BountyReader & FlowChain = {
    async bounty() {
      state.reads.push("bounty");
      return structuredClone(state.bounty);
    },
    async link() {
      state.reads.push("link");
      return structuredClone(state.link);
    },
    async nonceUsed(m, n) {
      state.reads.push("nonceUsed");
      return state.nonces.has(`${m}/${n}`);
    },
    async postedByNonce(m, n) {
      return state.posted.get(`${m}/${n}`) ?? null;
    },
    async vaultN() {
      return String(state.vaultN);
    },
    async barred() {
      return state.barred;
    },
    async nowSecs() {
      return NOW;
    },
    async postingMessage(r) {
      if (state.differentText) return "something else";
      return postingMessage(
        NETWORK,
        CONTRACT,
        r.maintainer,
        fromHex(r.nonce),
        r.terms,
        r.key,
        r.expires_at,
      );
    },
    async claimMessage(r) {
      if (state.differentText) return "something else";
      return claimMessage(
        NETWORK,
        CONTRACT,
        r.wallet,
        r.bounty_id,
        r.github_id,
        r.key,
        r.expires_at,
      );
    },
    async linkChallenge(wallet, expiresAt) {
      state.reads.push("linkChallenge");
      return linkChallenge(
        NETWORK,
        CONTRACT,
        state.challengeFor ?? wallet,
        state.linkNumber,
        expiresAt,
      );
    },
    async linkNumber() {
      state.reads.push("linkNumber");
      return state.linkNumber;
    },
    async vault(): Promise<VaultRead> {
      return {
        exists: true,
        info: {
          key: MESSAGE_KEY,
          n: String(state.vaultN),
          fund: "0",
          available: String(5n * NEAR),
        },
      };
    },
    async accountExists() {
      return true;
    },
  };
  return { chain, state };
}
type Fake = ReturnType<typeof fakeChain>;
/** What the chain does with each call, as far as the views show it. */
function apply(f: Fake, who: string, call: Call) {
  const a = call.args;
  if (call.method === "claim")
    f.state.bounty = {
      ...openBounty(),
      status: "Claimed",
      claim: { wallet: who, key: String(a.key), claimed_at: "200" },
    };
  else if (call.method === "post_bounty") {
    const nonce = (a.proof as { nonce: string }).nonce;
    f.state.nonces.add(`${who}/${nonce}`);
    f.state.posted.set(`${who}/${nonce}`, 9);
  } else if (call.method === "withdraw") f.state.vaultN += 1n;
  else if (call.method === "link")
    f.state.link = {
      active: { gist_id: String(a.gist_id), github_id: "583231" },
      pending: null,
    };
  else if (call.method === "release_claim") f.state.bounty = openBounty();
  else throw new Error(`the fake chain does not know ${call.method}`);
}

// ---- A fake wallet ----

interface WalletOptions {
  /** Which secret signs messages. */
  signWith?: number;
  /** The key the wallet says it signed with; default is the real one. */
  reported?: string;
  /** Sign the hash with a secret other than the one reported. */
  forgeWith?: number;
  noSigning?: boolean;
  /** What a call does: land and answer, land and then fail, or fail before anything lands. */
  call?: "ok" | "landThenThrow" | "throwBefore";
  transactionKey?: string | null;
  result?: unknown;
}
function fakeWallet(f: Fake, options: WalletOptions = {}) {
  const signed: { message: string; recipient: string }[] = [];
  const calls: Call[] = [];
  const wallet: FlowWallet & Wallet = {
    accountId: ME,
    label: "Test wallet",
    transfer: async () => "",
    signForRelay: async () => ({
      public_key: "",
      signature_base64: "",
      nonce_base64: "",
    }),
    signOut: async () => {},
    transactionKey: async () =>
      options.transactionKey === undefined ? TX_KEY : options.transactionKey,
    call: async (call) => {
      calls.push(call);
      if (options.call === "throwBefore")
        throw new Error("The wallet lost its connection.");
      apply(f, ME, call);
      if (options.call === "landThenThrow")
        throw new Error("The wallet lost its connection.");
      return {
        transaction_hash: "H".repeat(44),
        ...(options.result !== undefined ? { result: options.result } : {}),
      };
    },
    signNep413: options.noSigning
      ? (undefined as unknown as Wallet["signNep413"])
      : async (message, recipient, nonce) => {
          signed.push({ message, recipient });
          const hash = nep413Hash(message, nonce, recipient);
          const own = options.signWith ?? 2;
          const signature = ed25519.sign(
            hash,
            secret(options.forgeWith ?? own),
          );
          return {
            public_key: options.reported ?? keyOf(own),
            signature_base64: base64(signature),
          };
        },
  };
  return { wallet, signed, calls };
}

const refuses = async (run: Promise<unknown>, code?: string) => {
  try {
    await run;
  } catch (error) {
    if (code !== undefined)
      assert.equal(
        (error as { code?: string }).code,
        code,
        error instanceof Error ? error.message : String(error),
      );
    return error as Error;
  }
  throw new Error("expected a refusal");
};

// ---- Signing is off ----

test("with signing off, no flow asks the wallet for a signature or sends anything", async () => {
  const f = fakeChain();
  const w = fakeWallet(f);
  const github = {
    fetch: (async () => {
      throw new Error("GitHub must not be called");
    }) as typeof fetch,
    onDeviceCode: () => {},
  };
  const run = [
    postFlow({
      approved: false,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      review: review(),
      key: MESSAGE_KEY,
      nonce: NONCE,
    }),
    claimFlow({
      approved: false,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      bountyId: 3,
      githubId: "583231",
      key: MESSAGE_KEY,
    }),
    linkFlow({
      approved: false,
      network: NETWORK,
      contract: CONTRACT,
      wallet: w.wallet,
      chain: f.chain,
      github,
    }),
    withdrawFlow({
      approved: false,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      vault: VAULT,
      to: "payee.testnet",
      amount: MILLI,
      earlier: null,
    }),
    discoverMessageKey({
      approved: false,
      contract: CONTRACT,
      wallet: w.wallet,
    }),
    sendFlow({
      approved: false,
      wallet: w.wallet,
      call: postBountyCall(CONTRACT, review(), MESSAGE_KEY, {
        nonce: "ab".repeat(32),
        expires_at: "1",
        signature: base64(new Uint8Array(64)),
      }),
    }),
  ];
  for (const pending of run) {
    const error = await refuses(pending, "signing_off");
    assert.equal(error.message, SIGNING_OFF);
  }
  assert.deepEqual(w.signed, []);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(f.state.reads, [], "not even a read happens");
});

// ---- Post ----

test("a post is proved by the message key, not the transaction key, and the call carries that proof", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { signWith: 2 });
  const r = review();
  const done = await postFlow({
    approved: true,
    contract: CONTRACT,
    network: NETWORK,
    wallet: w.wallet,
    chain: f.chain,
    review: r,
    key: MESSAGE_KEY,
    nonce: NONCE,
  });
  assert.equal(done.key, MESSAGE_KEY);
  assert.notEqual(done.key, TX_KEY);
  assert.equal(done.keyCheck.kind, "different");
  assert.match(
    done.keyCheck.text,
    /This wallet signs messages with a different key than it signs transactions; payouts will be withdrawn with ed25519:/,
  );
  // The wallet saw the contract's own text, for the contract as recipient.
  assert.equal(w.signed.length, 1);
  assert.equal(w.signed[0]?.recipient, CONTRACT);
  const args = done.call.args as {
    terms: unknown;
    key: string;
    proof: { nonce: string; expires_at: string; signature: string };
  };
  assert.equal(args.key, MESSAGE_KEY);
  assert.equal(args.proof.nonce, "5a".repeat(32));
  assert.equal(args.proof.expires_at, String(NOW + 1800));
  // The signature verifies under the message key over exactly the text that was shown.
  const message = w.signed[0]?.message as string;
  assert.match(message, new RegExp(`withdrawal_key: ${MESSAGE_KEY}`));
  assert.ok(
    ed25519.verify(
      Buffer.from(args.proof.signature, "base64"),
      nep413Hash(
        message,
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", Buffer.from(message)),
        ),
        CONTRACT,
      ),
      ed25519.getPublicKey(secret(2)),
    ),
  );
  // One call, with the reward plus the record deposit.
  assert.deepEqual(w.calls, [done.call]);
  assert.equal(done.call.deposit, r.reward + 30n * MILLI);
  assert.equal(done.call.method, "post_bounty");
});

test("a wallet that signs with another key than the one passed sends nothing", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { signWith: 2 });
  const error = await refuses(
    postFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      review: review(),
      // The page was told the transaction key, but the wallet signs messages with another.
      key: TX_KEY,
      nonce: NONCE,
    }),
  );
  assert.ok(error instanceof WalletKeyError);
  assert.equal(error.code, "key_not_expected");
  assert.deepEqual(w.calls, []);
});

test("a wallet that cannot sign messages is refused with a clear error and nothing is sent", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { noSigning: true });
  const error = await refuses(
    postFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      review: review(),
      key: MESSAGE_KEY,
      nonce: NONCE,
    }),
  );
  assert.ok(error instanceof WalletKeyError);
  assert.equal(error.code, "cannot_sign");
  assert.match(error.message, /cannot sign messages.*Nothing was sent/);
  assert.deepEqual(w.calls, []);
  const probe = await refuses(
    discoverMessageKey({
      approved: true,
      contract: CONTRACT,
      wallet: w.wallet,
    }),
  );
  assert.equal((probe as WalletKeyError).code, "cannot_sign");
});

test("a signature that does not match the reported key is refused and nothing is sent", async () => {
  const f = fakeChain();
  // The wallet says it used key 2 but signs with key 3.
  const w = fakeWallet(f, { signWith: 2, forgeWith: 3 });
  const error = await refuses(
    postFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      review: review(),
      key: MESSAGE_KEY,
      nonce: NONCE,
    }),
  );
  assert.equal((error as WalletKeyError).code, "signature_mismatch");
  assert.deepEqual(w.calls, []);
});

test("a posting number that was already used is refused before anything is signed", async () => {
  const f = fakeChain();
  f.state.nonces.add(`${ME}/${"5a".repeat(32)}`);
  const w = fakeWallet(f);
  await refuses(
    postFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      review: review(),
      key: MESSAGE_KEY,
      nonce: NONCE,
    }),
    "nonce_used",
  );
  assert.deepEqual(w.signed, []);
  assert.deepEqual(w.calls, []);
});

test("if the contract builds another text than the page, nothing is signed", async () => {
  const f = fakeChain({ differentText: true });
  const w = fakeWallet(f);
  await refuses(
    postFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      review: review(),
      key: MESSAGE_KEY,
      nonce: NONCE,
    }),
    "contract_disagrees",
  );
  await refuses(
    claimFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      bountyId: 3,
      githubId: "583231",
      key: MESSAGE_KEY,
    }),
    "contract_disagrees",
  );
  assert.deepEqual(w.signed, []);
  assert.deepEqual(w.calls, []);
});

// ---- Claim ----

test("a claim is proved by the message key, shows the key check, and attaches the 0.0001 NEAR claim fee", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { signWith: 2 });
  const done = await claimFlow({
    approved: true,
    contract: CONTRACT,
    network: NETWORK,
    wallet: w.wallet,
    chain: f.chain,
    bountyId: 3,
    githubId: "583231",
    key: MESSAGE_KEY,
  });
  assert.equal(done.keyCheck.kind, "different");
  assert.equal(done.key, MESSAGE_KEY);
  assert.equal(done.call.method, "claim");
  assert.equal(done.call.deposit, 100_000_000_000_000_000_000n);
  const args = done.call.args as {
    bounty_id: number;
    key: string;
    proof: { expires_at: string; signature: string };
  };
  assert.equal(args.bounty_id, 3);
  assert.equal(args.key, MESSAGE_KEY);
  assert.equal(args.proof.expires_at, String(NOW + 1800));
  const message = w.signed[0]?.message as string;
  assert.match(message, /role: contributor \(payout\)/);
  assert.match(message, /github_id: 583231/);
  assert.match(message, /bounty: 3/);
  assert.deepEqual(f.state.bounty.claim?.key, MESSAGE_KEY);
});

test("a claim with a wallet whose message key differs from the one passed sends nothing", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { signWith: 2 });
  const error = await refuses(
    claimFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      bountyId: 3,
      githubId: "583231",
      key: TX_KEY,
    }),
  );
  assert.equal((error as WalletKeyError).code, "key_not_expected");
  assert.deepEqual(w.calls, []);
});

test("a wallet that reports its transaction key as the message key gets the plain key check", async () => {
  const f = fakeChain();
  const same = fakeWallet(f, { signWith: 1, transactionKey: TX_KEY });
  const found = await discoverMessageKey({
    approved: true,
    contract: CONTRACT,
    wallet: same.wallet,
  });
  assert.equal(found.key, TX_KEY);
  assert.equal(found.keyCheck.kind, "same");
  const unknown = fakeWallet(f, { signWith: 2, transactionKey: null });
  const other = await discoverMessageKey({
    approved: true,
    contract: CONTRACT,
    wallet: unknown.wallet,
  });
  assert.equal(other.key, MESSAGE_KEY);
  assert.equal(other.keyCheck.kind, "unknown");
  assert.deepEqual(same.calls, []);
});

// ---- Withdraw ----

test("a withdrawal is signed by the vault's key, shows the key check, and sends the vault's withdraw", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { signWith: 2 });
  let recorded: unknown = null;
  const done = await withdrawFlow({
    approved: true,
    network: NETWORK,
    wallet: w.wallet,
    chain: f.chain,
    vault: VAULT,
    to: "payee.testnet",
    amount: 2n * NEAR,
    earlier: null,
    beforeSend: (withdrawal) => {
      // Recorded before the wallet is asked to send.
      assert.deepEqual(w.calls, []);
      recorded = withdrawal;
    },
  });
  assert.equal(done.error, null);
  assert.equal(done.hash, "H".repeat(44));
  assert.equal(done.key, MESSAGE_KEY);
  assert.equal(done.keyCheck.kind, "different");
  assert.deepEqual(recorded, done.withdrawal);
  assert.equal(done.withdrawal.n, 0n);
  assert.equal(done.withdrawal.deadline, NOW + 600);
  assert.equal(w.calls.length, 1);
  const sent = w.calls[0] as Call;
  assert.equal(sent.receiver, VAULT);
  assert.equal(sent.method, "withdraw");
  assert.equal(sent.deposit, 0n);
  // The signature in the call verifies under the vault key over this withdrawal.
  const signature = Buffer.from(String(sent.args.signature), "hex");
  assert.ok(
    ed25519.verify(
      signature,
      withdrawHash(done.withdrawal),
      ed25519.getPublicKey(secret(2)),
    ),
  );
  assert.deepEqual(sent, withdrawCall(done.withdrawal, signature));
});

test("a wallet that signs a withdrawal with another key sends nothing", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { signWith: 1 });
  const error = await refuses(
    withdrawFlow({
      approved: true,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      vault: VAULT,
      to: "payee.testnet",
      amount: NEAR,
      earlier: null,
    }),
  );
  assert.equal((error as WalletKeyError).code, "key_not_expected");
  assert.deepEqual(w.calls, []);
});

test("a withdrawal the vault would refuse is refused before any signature", async () => {
  const f = fakeChain();
  const w = fakeWallet(f);
  const attempt = (over: { to?: string; amount?: bigint }) =>
    withdrawFlow({
      approved: true,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      vault: VAULT,
      to: over.to ?? "payee.testnet",
      amount: over.amount ?? NEAR,
      earlier: null,
    });
  assert.match(
    (await refuses(attempt({ amount: 6n * NEAR }), "refused")).message,
    /more than the vault can pay/,
  );
  assert.match(
    (await refuses(attempt({ to: "NOT AN ACCOUNT" }), "refused")).message,
    /not a valid NEAR account/,
  );
  assert.match(
    (await refuses(attempt({ to: VAULT }), "refused")).message,
    /cannot be the vault itself/,
  );
  assert.deepEqual(w.signed, []);
  // An earlier withdrawal that is pending, with the same number and a live deadline, blocks.
  await refuses(
    withdrawFlow({
      approved: true,
      network: NETWORK,
      wallet: w.wallet,
      chain: f.chain,
      vault: VAULT,
      to: "payee.testnet",
      amount: NEAR,
      earlier: { n: 0n, deadline: NOW + 100, outcome: "pending" },
    }),
    "busy",
  );
  assert.deepEqual(w.signed, []);
  assert.deepEqual(w.calls, []);
});

test("a send that fails still returns the hash the wallet named, for the page to re-check", async () => {
  const f = fakeChain();
  const w = fakeWallet(f, { call: "landThenThrow" });
  const done = await withdrawFlow({
    approved: true,
    network: NETWORK,
    wallet: w.wallet,
    chain: f.chain,
    vault: VAULT,
    to: "payee.testnet",
    amount: NEAR,
    earlier: null,
  });
  assert.match(String((done.error as Error).message), /lost its connection/);
  assert.equal(done.hash, null);
});

// ---- Link ----

const DEVICE = "3584d83530557fdd1f46af8289938c8ef79f9dc5";
const TOKEN = "ghu_0123456789abcdefghijklmnopqrstuvwxyzAB";
const GIST = "aa5a315d61ae9438b18d";
function githubNetwork() {
  const seen: string[] = [];
  const gists: string[] = [];
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const transport = (async (url: string, init: RequestInit = {}) => {
    seen.push(`${init.method ?? "GET"} ${url}`);
    if (url === "/api/github/device/code")
      return json({
        device_code: DEVICE,
        user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        expires_in: 899,
        interval: 5,
      });
    if (url === "/api/github/device/token")
      return json({ access_token: TOKEN, token_type: "bearer" });
    if (url === "https://api.github.com/user") return json({ id: 583231 });
    if (url === "https://api.github.com/gists") {
      const body = JSON.parse(String(init.body));
      gists.push(body.files[GIST_FILE].content);
      return json(
        {
          id: GIST,
          public: false,
          owner: { id: 583231 },
          files: { [GIST_FILE]: body.files[GIST_FILE] },
        },
        201,
      );
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return { seen, gists, transport };
}

test("connecting GitHub builds the challenge for this wallet, makes one gist, and sends link with 0.017 NEAR", async () => {
  const f = fakeChain({ linkNumber: 2 });
  const w = fakeWallet(f, { result: "linked" });
  const net = githubNetwork();
  const codes: string[] = [];
  const done = await linkFlow({
    approved: true,
    network: NETWORK,
    contract: CONTRACT,
    wallet: w.wallet,
    chain: f.chain,
    github: {
      fetch: net.transport,
      sleep: async () => {},
      now: () => 1_000_000,
      onDeviceCode: (start) => codes.push(start.userCode),
    },
  });
  assert.deepEqual(codes, ["WDJB-MJHT"]);
  assert.equal(done.githubId, 583231);
  assert.equal(done.gistId, GIST);
  assert.equal(done.expiresAt, NOW + 1800);
  assert.deepEqual(w.calls, [
    {
      receiver: CONTRACT,
      method: "link",
      args: { gist_id: GIST, expires_at: String(NOW + 1800) },
      deposit: 17n * MILLI,
      gas: 300n * 10n ** 12n,
    },
  ]);
  assert.equal(done.result && done.result.result, "linked");
  // The gist held exactly the contract's challenge; no message signature was needed.
  assert.deepEqual(w.signed, []);
  assert.ok(net.seen.includes("POST https://api.github.com/gists"));
  // The one gist held exactly the challenge built here for this wallet, network, contract,
  // link number and expiry, and the contract's own view agreed with it.
  assert.deepEqual(net.gists, [
    linkChallenge(NETWORK, CONTRACT, w.wallet.accountId, 2, NOW + 1800),
  ]);
  assert.ok(f.state.reads.includes("linkNumber"));
  assert.ok(f.state.reads.includes("linkChallenge"));
});

test("a challenge for another wallet, network, contract, number or expiry stops the connection before any gist exists", async () => {
  const cases: [string, (f: ReturnType<typeof fakeChain>) => void][] = [
    [
      "not a challenge",
      (f) => void (f.chain.linkChallenge = async () => "not a challenge"),
    ],
    ["another wallet", (f) => void (f.state.challengeFor = "attacker.testnet")],
    [
      "another network",
      (f) =>
        void (f.chain.linkChallenge = async (wallet, at) =>
          linkChallenge("mainnet", CONTRACT, wallet, 0, at)),
    ],
    [
      "another contract",
      (f) =>
        void (f.chain.linkChallenge = async (wallet, at) =>
          linkChallenge(NETWORK, "other.testnet", wallet, 0, at)),
    ],
    [
      "another link number",
      (f) =>
        void (f.chain.linkChallenge = async (wallet, at) =>
          linkChallenge(NETWORK, CONTRACT, wallet, 1, at)),
    ],
    [
      "another expiry",
      (f) =>
        void (f.chain.linkChallenge = async (wallet, at) =>
          linkChallenge(NETWORK, CONTRACT, wallet, 0, at + 1)),
    ],
    ["an unusable link number", (f) => void (f.state.linkNumber = -1)],
  ];
  for (const [label, spoil] of cases) {
    const f = fakeChain();
    spoil(f);
    const w = fakeWallet(f);
    const net = githubNetwork();
    await refuses(
      linkFlow({
        approved: true,
        network: NETWORK,
        contract: CONTRACT,
        wallet: w.wallet,
        chain: f.chain,
        github: {
          fetch: net.transport,
          sleep: async () => {},
          now: () => 1_000_000,
          onDeviceCode: () => {},
        },
      }),
      "contract_disagrees",
    );
    assert.ok(!net.seen.includes("POST https://api.github.com/gists"), label);
    assert.deepEqual(w.calls, [], label);
  }
});
test("a failed read of the link number stops the connection before any gist exists", async () => {
  const f = fakeChain();
  f.chain.linkNumber = async () => {
    throw new Error("The wallet's link number could not be read.");
  };
  const w = fakeWallet(f);
  const net = githubNetwork();
  await assert.rejects(
    linkFlow({
      approved: true,
      network: NETWORK,
      contract: CONTRACT,
      wallet: w.wallet,
      chain: f.chain,
      github: {
        fetch: net.transport,
        sleep: async () => {},
        now: () => 1_000_000,
        onDeviceCode: () => {},
      },
    }),
    /link number could not be read/,
  );
  assert.ok(!net.seen.includes("POST https://api.github.com/gists"));
  assert.deepEqual(w.calls, []);
});

// ---- The journal around a wallet ----

const store = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};
const lockManager = () => {
  let locked = false;
  return {
    request: async (
      _name: string,
      _options: unknown,
      callback: (value: object | null) => Promise<unknown>,
    ) => {
      if (locked) return callback(null);
      locked = true;
      try {
        return await callback({});
      } finally {
        locked = false;
      }
    },
  } as LockManager;
};
/** A wallet whose calls go through the journal, as the page's are. */
function guarded(
  f: Fake,
  options: WalletOptions,
  target: BountyTarget = { label: "Claiming", bountyId: 3 },
) {
  const w = fakeWallet(f, options);
  const storage = store();
  const pending: unknown[] = [];
  const env: JournalEnv = {
    locks: lockManager(),
    storage,
    reader: f.chain,
    onPending: (p) => void pending.push(p),
  };
  const wallet = guardBountyWallet(w.wallet as Wallet, env, () => target);
  return { ...w, wallet, env, storage, pending };
}
const claim = (g: ReturnType<typeof guarded>, f: Fake) =>
  claimFlow({
    approved: true,
    contract: CONTRACT,
    network: NETWORK,
    wallet: g.wallet,
    chain: f.chain,
    bountyId: 3,
    githubId: "583231",
    key: MESSAGE_KEY,
  });

test("a wallet error after the claim landed keeps the journal, sends once, and the chain read clears it", async () => {
  const f = fakeChain();
  const g = guarded(f, { call: "landThenThrow" });
  await refuses(claim(g, f));
  assert.equal(g.calls.length, 1);
  const saved = readBountyJournal(g.storage);
  assert.ok(saved?.call);
  assert.equal(saved.call.method, "claim");
  assert.equal(saved.bountyId, 3);
  // A second click: the flow refuses before the wallet is asked to sign or send anything.
  const signedBefore = g.signed.length;
  const second = await refuses(claim(g, f));
  assert.equal(second.message, IDLE_MESSAGE);
  assert.equal(g.signed.length, signedBefore);
  assert.equal(g.calls.length, 1);
  // The chain shows the claim, so the journal clears. Nothing is resent.
  assert.equal(await reconcileBountyJournal(g.env, saved), true);
  assert.equal(g.storage.getItem(BOUNTY_PENDING_KEY), null);
  assert.equal(g.calls.length, 1);
});

test("a wallet error after the post landed is resolved by the nonce on the chain", async () => {
  const f = fakeChain();
  const g = guarded(
    f,
    { call: "landThenThrow" },
    { label: "Posting the bounty", bountyId: null },
  );
  await refuses(
    postFlow({
      approved: true,
      contract: CONTRACT,
      network: NETWORK,
      wallet: g.wallet,
      chain: f.chain,
      review: review(),
      key: MESSAGE_KEY,
      nonce: NONCE,
    }),
  );
  const saved = readBountyJournal(g.storage);
  assert.equal(saved?.call?.method, "post_bounty");
  assert.equal(await reconcileBountyJournal(g.env, saved!), true);
  assert.equal(g.calls.length, 1);
});

test("a wallet error before anything landed keeps the journal until the person releases it after a chain read", async () => {
  const f = fakeChain();
  const g = guarded(f, { call: "throwBefore" });
  await refuses(claim(g, f));
  const saved = readBountyJournal(g.storage)!;
  // The chain shows no claim, so reconcile keeps the journal ...
  assert.equal(await reconcileBountyJournal(g.env, saved), false);
  assert.ok(g.storage.getItem(BOUNTY_PENDING_KEY));
  // ... and release, which reads the chain first, clears it.
  assert.equal(await releaseBountyJournal(g.env, saved), true);
  assert.equal(g.storage.getItem(BOUNTY_PENDING_KEY), null);
});

test("release refuses to clear a call whose effect is on the chain", async () => {
  const f = fakeChain();
  const g = guarded(f, { call: "landThenThrow" });
  await refuses(claim(g, f));
  const saved = readBountyJournal(g.storage)!;
  assert.equal(await releaseBountyJournal(g.env, saved), false);
  assert.ok(g.storage.getItem(BOUNTY_PENDING_KEY));
});

test("two clicks at once reach the wallet's send only once", async () => {
  const f = fakeChain();
  const g = guarded(f, { call: "ok" });
  const results = await Promise.allSettled([claim(g, f), claim(g, f)]);
  assert.equal(g.calls.length, 1);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const refused = results.find((r) => r.status === "rejected");
  assert.match(
    String((refused as PromiseRejectedResult).reason.message),
    /Another tab is signing|earlier action/,
  );
});

test("a stale page does not reach the wallet's send", async () => {
  const f = fakeChain();
  // The "before" snapshot was taken when the person clicked; then another wallet claimed.
  const before = await snapshotBefore(f.chain, ME, {
    label: "Claiming",
    bountyId: 3,
    call: { receiver: CONTRACT, method: "claim", args: {} },
  });
  const g = guarded(f, { call: "ok" }, {
    label: "Claiming",
    bountyId: 3,
    before,
  } as BountyTarget);
  f.state.bounty = {
    ...openBounty(),
    status: "Claimed",
    claim: { wallet: "other.testnet", key: MESSAGE_KEY, claimed_at: "150" },
  };
  const error = await refuses(claim(g, f));
  assert.match(error.message, /bounty changed/);
  assert.equal(g.calls.length, 0);
  assert.equal(g.storage.getItem(BOUNTY_PENDING_KEY), null);
});

test("a withdrawal through the journal is resolved by the vault's number", async () => {
  const f = fakeChain();
  const g = guarded(
    f,
    { call: "landThenThrow" },
    {
      label: "Withdrawing",
      bountyId: null,
      call: { receiver: VAULT, method: "withdraw", args: {} },
    },
  );
  const done = await withdrawFlow({
    approved: true,
    network: NETWORK,
    wallet: g.wallet,
    chain: f.chain,
    vault: VAULT,
    to: "payee.testnet",
    amount: NEAR,
    earlier: null,
  });
  assert.ok(done.error);
  const saved = readBountyJournal(g.storage)!;
  assert.equal(saved.call?.method, "withdraw");
  assert.equal(await reconcileBountyJournal(g.env, saved), true);
  assert.equal(g.calls.length, 1);
});

test("a call made outside any action is refused by the wallet", async () => {
  const f = fakeChain();
  const w = fakeWallet(f);
  const wallet = guardBountyWallet(
    w.wallet as Wallet,
    {
      locks: lockManager(),
      storage: store(),
      reader: f.chain,
      onPending: () => {},
    },
    () => null,
  );
  await refuses(wallet.call({ ...({} as Call) }));
  assert.deepEqual(w.calls, []);
});
test("a network that contradicts the wallet's own name stops the connection before any gist exists", async () => {
  const f = fakeChain();
  const w = fakeWallet(f);
  const net = githubNetwork();
  await refuses(
    linkFlow({
      approved: true,
      network: w.wallet.accountId.endsWith(".testnet") ? "mainnet" : "testnet",
      contract: CONTRACT,
      wallet: w.wallet,
      chain: f.chain,
      github: {
        fetch: net.transport,
        sleep: async () => {},
        now: () => 1_000_000,
        onDeviceCode: () => {},
      },
    }),
    "contract_disagrees",
  );
  assert.ok(!net.seen.includes("POST https://api.github.com/gists"));
  assert.deepEqual(w.calls, []);
});
