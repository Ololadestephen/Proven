// The PR bounty page's calls and the flows that need a wallet signature. Builders return the exact
// `{receiver, method, args, deposit, gas}` of each contract method (contracts/pr-bounty/src/lib.rs).
// Flows take an injected wallet and an injected chain reader, so tests drive them with fakes:
//   postFlow     freeze the terms and a fresh nonce, have the wallet's message key prove itself, post;
//   claimFlow    the same for a claim;
//   linkFlow     GitHub's device flow, one gist, then `link`;
//   withdrawFlow check, sign with the vault's key, send.
// Every flow first refuses when `approved` is false: before this build's fees are approved
// (`FEES_APPROVED` in posting-review.ts) no wallet is asked to sign anything and no GitHub
// request is made. A wallet failure after a call was sent is never handled here: it propagates
// to the journal in bounty-wallet.ts, which resolves it by reading the chain, never by resending.
import type { Call, WalletCallResult } from "./market-types.ts";
import { NEAR, TGAS } from "./market-types.ts";
import {
  base64,
  claimMessage,
  ed25519Key,
  hex,
  keyText,
  linkChallenge,
  postingMessage,
  signatureBytes,
  type PostTerms,
} from "./bounty-keys.ts";
import {
  connect,
  type ConnectOptions,
  type DeviceStart,
} from "./github-link.ts";
import {
  describeKeyCheck,
  proveWithdrawalKey,
  signWithdrawal,
  type KeyCheck,
  type MessageSigner,
} from "./wallet-keys.ts";
import {
  checkWithdrawal,
  chooseDeadline,
  mayAuthorizeAgain,
  sendWithdrawal,
  withdrawArgs,
  type Refusal,
  type SettlementKindName,
  type Withdrawal,
  type WithdrawalOutcome,
} from "./vault-client.ts";
import type { Review } from "./posting-review.ts";
import type { VaultRead } from "./vault-view.ts";

// ---- Amounts and gas, as the contract takes them ----

/** `RUN_DEPOSIT`: the verifier run that `link`, `submit_pr`, `check_merge` and `reconcile` pay. */
export const RUN_DEPOSIT = NEAR / 100n;
/** `LINK_STORAGE_DEPOSIT`: held for a link's storage, returned unless the link is recorded. */
export const LINK_STORAGE_DEPOSIT = (NEAR * 7n) / 1000n;
/** `link` takes exactly this: the run and the link's storage. */
export const LINK_DEPOSIT = RUN_DEPOSIT + LINK_STORAGE_DEPOSIT;
/** `STORAGE_DEPOSIT`: kept with each bounty's record; a post attaches the reward plus this. */
export const STORAGE_DEPOSIT = (NEAR * 30n) / 1000n;
export const RECONCILE_DEPOSIT = NEAR / 100n;
export const GAS = {
  post: 100n * TGAS,
  link: 300n * TGAS,
  claim: 30n * TGAS,
  end: 30n * TGAS,
  cancel: 100n * TGAS,
  submit: 300n * TGAS,
  check: 300n * TGAS,
  settle: 100n * TGAS,
  sendDue: 100n * TGAS,
  recover: 30n * TGAS,
  reconcile: 100n * TGAS,
  linkChange: 30n * TGAS,
  withdraw: 30n * TGAS,
} as const;
/** A key proof stays valid this long: inside the contract's one-hour limit, with room to sign. */
export const PROOF_VALID_SECS = 30 * 60;

/** Shown beside any button that would sign or send while the fees are not approved. */
export const SIGNING_OFF =
  "Signing is off in this build: the fees are not approved yet, so no wallet is asked to sign or send anything.";

// ---- Errors ----

export type FlowErrorCode =
  | "signing_off"
  | "busy"
  | "nonce_used"
  | "contract_disagrees"
  | "key_mismatch"
  | "bad_input"
  | "unreadable"
  | "refused";
/** A refusal with a code the page can branch on and a message it can show as written. */
export class FlowError extends Error {
  readonly code: FlowErrorCode;
  constructor(code: FlowErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function requireApproved(approved: boolean): void {
  if (!approved) throw new FlowError("signing_off", SIGNING_OFF);
}

// ---- Call builders ----

const call = (
  receiver: string,
  method: string,
  args: Record<string, unknown>,
  deposit: bigint,
  gas: bigint,
): Call => ({ receiver, method, args, deposit, gas });

const checkId = (bountyId: number) => {
  if (!Number.isSafeInteger(bountyId) || bountyId < 0)
    throw new FlowError("bad_input", "Name a bounty number.");
  return bountyId;
};

/** The terms a posting fixes, from the review the maintainer saw. `issue` is a JSON number, as
 * the contract's plain `u64`; every `U64` and `U128` field is a decimal string. */
export function postTerms(review: Review): PostTerms {
  const d = review.deadlines;
  return {
    reward: review.reward.toString(),
    repo: review.repo,
    repo_id: String(review.repo_id),
    issue: review.issue,
    base_ref: review.branch,
    claim_by: String(d.claim_by),
    claim_secs: String(d.claim_secs),
    merge_deadline: String(d.merge_deadline),
    grace_secs: String(d.grace_secs),
  };
}

export interface PostingProofArgs {
  nonce: string;
  expires_at: string;
  signature: string;
}
export interface ClaimProofArgs {
  expires_at: string;
  signature: string;
}
/** A signature the contract will parse: 64 bytes, as base64. */
function signatureArg(text: string): string {
  try {
    return base64(signatureBytes(text));
  } catch {
    throw new FlowError("bad_input", "The signature is not 64 bytes.");
  }
}

/** `post_bounty`: attaches exactly the reward plus the record deposit, and no check reserve. */
export function postBountyCall(
  contract: string,
  review: Review,
  key: string,
  proof: PostingProofArgs,
): Call {
  if (review.fees.check_reserve !== 0n)
    throw new FlowError(
      "bad_input",
      "The contract takes no check reserve. Review the posting again.",
    );
  if (
    !/^[0-9a-f]{64}$/.test(proof.nonce) ||
    !/^[0-9]{1,20}$/.test(proof.expires_at)
  )
    throw new FlowError("bad_input", "The posting proof is malformed.");
  return call(
    contract,
    "post_bounty",
    {
      terms: postTerms(review),
      key: keyText(ed25519Key(key)),
      proof: {
        nonce: proof.nonce,
        expires_at: proof.expires_at,
        signature: signatureArg(proof.signature),
      },
    },
    review.reward + review.fees.storage_deposit,
    GAS.post,
  );
}

/** `link`: attaches exactly 0.017 NEAR, 0.01 for the run and 0.007 for the link's storage. */
export const linkCall = (contract: string, gistId: string, expiresAt: number) =>
  call(
    contract,
    "link",
    { gist_id: gistId, expires_at: String(expiresAt) },
    LINK_DEPOSIT,
    GAS.link,
  );

/** `claim`: no deposit. The proof is the withdrawal key's signature over the claim message. */
export const claimCall = (
  contract: string,
  bountyId: number,
  key: string,
  proof: ClaimProofArgs,
) =>
  call(
    contract,
    "claim",
    {
      bounty_id: checkId(bountyId),
      key: keyText(ed25519Key(key)),
      proof: {
        expires_at: proof.expires_at,
        signature: signatureArg(proof.signature),
      },
    },
    0n,
    GAS.claim,
  );

const byId = (method: string, gas: bigint) => (contract: string, id: number) =>
  call(contract, method, { bounty_id: checkId(id) }, 0n, gas);
export const releaseClaimCall = byId("release_claim", GAS.end);
export const revokeClaimCall = byId("revoke_claim", GAS.end);
export const expireClaimCall = byId("expire_claim", GAS.end);
export const cancelCall = byId("cancel", GAS.cancel);
export const settleCall = byId("settle", GAS.settle);
export const sendDueCall = byId("send_due", GAS.sendDue);

/** `submit_pr`: attaches exactly 0.01 NEAR for the run; the unused part comes back. */
export function submitPrCall(
  contract: string,
  bountyId: number,
  prNumber: number,
): Call {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || prNumber > 0xffff_ffff)
    throw new FlowError("bad_input", "Name a pull request number.");
  return call(
    contract,
    "submit_pr",
    { bounty_id: checkId(bountyId), pr_number: prNumber },
    RUN_DEPOSIT,
    GAS.submit,
  );
}

/** `check_merge`: 0.01 NEAR when you pay, nothing for the bound wallet's sponsored check. */
export const checkMergeCall = (
  contract: string,
  bountyId: number,
  sponsored: boolean,
) =>
  call(
    contract,
    "check_merge",
    { bounty_id: checkId(bountyId) },
    sponsored ? 0n : RUN_DEPOSIT,
    GAS.check,
  );

export const recoverSettlementCall = (
  contract: string,
  bountyId: number,
  kind: SettlementKindName,
) =>
  call(
    contract,
    "recover_settlement",
    { bounty_id: checkId(bountyId), kind },
    0n,
    GAS.recover,
  );

/** `reconcile`: attaches exactly 0.01 NEAR; what the vault does not keep comes back. */
export const reconcileCall = (
  contract: string,
  bountyId: number,
  kind: SettlementKindName,
  attempt: number,
) =>
  call(
    contract,
    "reconcile",
    { bounty_id: checkId(bountyId), kind, attempt },
    RECONCILE_DEPOSIT,
    GAS.reconcile,
  );

const forWallet = (method: string) => (contract: string, wallet: string) =>
  call(contract, method, { wallet }, 0n, GAS.linkChange);
export const activateLinkCall = forWallet("activate_link");
export const confirmLinkChangeCall = forWallet("confirm_link_change");
export const cancelLinkChangeCall = forWallet("cancel_link_change");

/** The vault's `withdraw`, sent to the vault itself with the key's signature. */
export const withdrawCall = (w: Withdrawal, signature: Uint8Array): Call =>
  call(
    w.vault,
    "withdraw",
    JSON.parse(withdrawArgs(w, signature)) as Record<string, unknown>,
    0n,
    GAS.withdraw,
  );

// ---- A pull request, as typed ----

export type PullRequestInput =
  { ok: true; number: number } | { ok: false; message: string };
const MAX_PR = 0xffff_ffff;
const SUFFIXES = new Set(["files", "commits", "checks"]);
const bad = (message: string): PullRequestInput => ({ ok: false, message });
const prNumber = (digits: string): PullRequestInput => {
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PR)
    return bad(
      `${digits} is not a pull request number. Use a number from 1 to ${MAX_PR}.`,
    );
  return { ok: true, number: n };
};

/**
 * A pull request number such as `42` or `#42`, or a link such as
 * https://github.com/<owner>/<repo>/pull/42, for the bounty's repository only. An issue link,
 * another repository, another host and anything else is refused with what to enter instead.
 */
export function parsePullRequestInput(
  text: string,
  repo: string,
): PullRequestInput {
  const input = text.trim();
  if (input === "") return bad("Enter the pull request number or its link.");
  const plain = /^#?([0-9]{1,10})$/.exec(input);
  if (plain) return prNumber(plain[1] as string);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return bad(
      `That is not a pull request number or a GitHub link. Enter a number such as 42, or a link such as https://github.com/${repo}/pull/42.`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  )
    return bad(
      `Only https://github.com links work. Enter a number, or a link such as https://github.com/${repo}/pull/42.`,
    );
  const [owner = "", name = "", kind = "", number = "", ...rest] = url.pathname
    .split("/")
    .filter(Boolean);
  if (kind === "issues")
    return bad(
      "That is an issue link. Enter the number or link of the pull request that fixes it.",
    );
  if (kind !== "pull" || number === "")
    return bad(
      `That link is not a pull request. Use a link such as https://github.com/${repo}/pull/42.`,
    );
  if (`${owner}/${name}`.toLowerCase() !== repo.toLowerCase())
    return bad(
      `That pull request is in ${owner}/${name}. This bounty is for ${repo}.`,
    );
  if (
    rest.length > 1 ||
    (rest.length === 1 && !SUFFIXES.has(rest[0] as string))
  )
    return bad(
      `That link has extra parts after the pull request number. Use https://github.com/${repo}/pull/${number}.`,
    );
  if (!/^[0-9]{1,10}$/.test(number))
    return bad(`"${number}" is not a pull request number.`);
  return prNumber(number);
}

// ---- A link change, and what its outcome says ----

/** Who may do what to a wallet's waiting link change. The contract decides; this only offers the buttons. */
export function linkChangeRoles(input: {
  /** The connected account. */
  viewer: string;
  /** The wallet the change is for. */
  wallet: string;
  /** The wallet that holds the new GitHub id today, or null when nobody does. */
  owner: string | null;
  activatesAt: number;
  now: number;
}): { canActivate: boolean; canConfirm: boolean; canCancel: boolean } {
  const incumbent = input.owner ?? input.wallet;
  return {
    canActivate: input.now >= input.activatesAt,
    canConfirm: input.viewer === incumbent,
    canCancel: input.viewer === input.wallet || input.viewer === input.owner,
  };
}

/** The string `on_link` returned, from a wallet's call result, or null when the wallet gave none. */
export function linkOutcomeOf(result: WalletCallResult | void): string | null {
  const value = result && result.result;
  return typeof value === "string" ? value : null;
}
/** Whether a link outcome means the contract stored nothing and returned the storage deposit. */
export const linkOutcomeStoresNothing = (outcome: string) =>
  !["linked", "link_pending", "link_refreshed"].includes(outcome);

/** What a link outcome means for the person, in plain sentences. */
export function linkOutcomeText(outcome: string, relinkDelaySecs: number) {
  const hours = Math.round(relinkDelaySecs / 3600);
  const returned =
    " Nothing was stored, and the 0.007 NEAR storage deposit was returned to your wallet.";
  if (outcome === "linked") return "GitHub is connected to this wallet.";
  if (outcome === "link_refreshed")
    return "Your link now uses the new gist. The GitHub account is the same.";
  if (outcome === "link_pending")
    return `This change waits ${hours} hours before it applies to later claims and submissions. Until then the earlier link stays in force.`;
  if (outcome === "mismatch:challenge")
    return `The check did not find this wallet's challenge as the gist's text.${returned}`;
  if (outcome === "mismatch:ambiguous")
    return `The gist does not hold exactly one file.${returned}`;
  if (outcome === "mismatch:gist_used")
    return `This gist was already used for a link.${returned}`;
  if (outcome.startsWith("no_result"))
    return `The check could not read the gist (${outcome}). Try again.${returned}`;
  return `The link was not recorded (${outcome}).${returned}`;
}

// ---- Flows ----

/** The wallet the flows use: message signing, calls, and what it can tell about its keys. */
export interface FlowWallet extends MessageSigner {
  call(call: Call): Promise<WalletCallResult | void>;
  /** The key that signs this wallet's transactions, when it can say. */
  transactionKey?: () => Promise<string | null>;
  /** Throws when an earlier call is still journaled, so a second click never asks the wallet. */
  assertIdle?: () => void;
}

export interface PostingRequest {
  terms: PostTerms;
  key: string;
  maintainer: string;
  nonce: string;
  expires_at: string;
}
export interface ClaimRequest {
  bounty_id: number;
  wallet: string;
  github_id: string;
  key: string;
  expires_at: string;
}
/** Reads of the chain the flows need. Each throws when the read fails; none returns a guess. */
export interface FlowChain {
  /** The latest block's time, in Unix seconds. */
  nowSecs(): Promise<number>;
  nonceUsed(maintainer: string, nonce: string): Promise<boolean>;
  /** The contract's own text for a posting proof (`posting_key_message`). */
  postingMessage(request: PostingRequest): Promise<string>;
  /** The contract's own text for a claim proof (`claim_key_message`). */
  claimMessage(request: ClaimRequest): Promise<string>;
  /** The contract's link challenge for a wallet (`link_challenge`), only compared, never used. */
  linkChallenge(wallet: string, expiresAt: number): Promise<string>;
  /** How many links the wallet has completed (`get_link_number`). */
  linkNumber(wallet: string): Promise<number>;
  vault(vault: string): Promise<VaultRead>;
  /** Whether a NEAR account exists, or null when the read failed. */
  accountExists(account: string): Promise<boolean | null>;
}

async function transactionKeyOf(wallet: FlowWallet): Promise<string | null> {
  try {
    return (await wallet.transactionKey?.()) ?? null;
  } catch {
    return null;
  }
}

const PROBE = (account: string) =>
  [
    "Proven key check",
    `actor: ${account}`,
    "This message only shows which key this wallet signs messages with. It moves no money and nothing uses it.",
  ].join("\n");

/**
 * Finds the key this wallet signs messages with, by having it sign a harmless text. That key, not
 * the one that signs transactions, is the withdrawal key a post or a claim proves. Nothing is sent.
 */
export async function discoverMessageKey(input: {
  approved: boolean;
  contract: string;
  wallet: FlowWallet;
}): Promise<{ key: string; keyCheck: KeyCheck }> {
  requireApproved(input.approved);
  input.wallet.assertIdle?.();
  const proof = await proveWithdrawalKey(
    input.wallet,
    PROBE(input.wallet.accountId),
    { contract: input.contract },
  );
  return {
    key: proof.publicKey,
    keyCheck: describeKeyCheck({
      messageKey: proof.publicKey,
      transactionKey: await transactionKeyOf(input.wallet),
    }),
  };
}

/** The result of a flow that sent a call. */
export interface FlowResult {
  call: Call;
  result: WalletCallResult | void;
  /** The key the wallet signed the proof with, and what to tell the person about it. */
  key: string;
  keyCheck: KeyCheck;
}

/** The proof's key must be the key the person was shown, in the same spelling. */
function sameKey(proved: string, expected: string): void {
  if (proved !== keyText(ed25519Key(expected)))
    throw new FlowError(
      "key_mismatch",
      "The wallet proved a different key than the one shown. Nothing was sent.",
    );
}

export interface PostFlowInput {
  approved: boolean;
  contract: string;
  network: string;
  wallet: FlowWallet;
  chain: FlowChain;
  /** What the maintainer reviewed. Its terms are frozen into the message and the call. */
  review: Review;
  /** The wallet's message key, from `discoverMessageKey`. */
  key: string;
  /** A fresh 32-byte nonce for this posting. */
  nonce: Uint8Array;
}

/**
 * Posts a funded bounty. The nonce is checked unused, the contract's own message must equal the
 * page's, the wallet signs it with `key` (and with no other key), and only then is the post sent.
 */
export async function postFlow(input: PostFlowInput): Promise<FlowResult> {
  requireApproved(input.approved);
  const { wallet, chain, contract, network, review } = input;
  wallet.assertIdle?.();
  if (input.nonce.length !== 32)
    throw new FlowError("bad_input", "A posting nonce has 32 bytes.");
  const maintainer = wallet.accountId;
  const nonce = hex(input.nonce);
  const key = keyText(ed25519Key(input.key));
  if (await chain.nonceUsed(maintainer, nonce))
    throw new FlowError(
      "nonce_used",
      "This posting number was already used. Start the posting again.",
    );
  const terms = postTerms(review);
  const expiresAt = (await chain.nowSecs()) + PROOF_VALID_SECS;
  const message = postingMessage(
    network,
    contract,
    maintainer,
    input.nonce,
    terms,
    key,
    expiresAt,
  );
  const theirs = await chain.postingMessage({
    terms,
    key,
    maintainer,
    nonce,
    expires_at: String(expiresAt),
  });
  if (theirs !== message)
    throw new FlowError(
      "contract_disagrees",
      "The page and the contract built different texts for this posting. Nothing was signed. Reload the page.",
    );
  const proof = await proveWithdrawalKey(wallet, message, {
    contract,
    expectedKey: key,
  });
  sameKey(proof.publicKey, key);
  const keyCheck = describeKeyCheck({
    messageKey: proof.publicKey,
    transactionKey: await transactionKeyOf(wallet),
  });
  const sent = postBountyCall(contract, review, key, {
    nonce,
    expires_at: String(expiresAt),
    signature: proof.signatureBase64,
  });
  return { call: sent, result: await wallet.call(sent), key, keyCheck };
}

export interface ClaimFlowInput {
  approved: boolean;
  contract: string;
  network: string;
  wallet: FlowWallet;
  chain: FlowChain;
  bountyId: number;
  /** The GitHub id of the wallet's active link, which the proof covers. */
  githubId: string;
  /** The wallet's message key, from `discoverMessageKey`. */
  key: string;
}

/** Claims a bounty: the withdrawal key proves itself for this wallet, bounty and GitHub id, then `claim`. */
export async function claimFlow(input: ClaimFlowInput): Promise<FlowResult> {
  requireApproved(input.approved);
  const { wallet, chain, contract, network } = input;
  wallet.assertIdle?.();
  const key = keyText(ed25519Key(input.key));
  const expiresAt = (await chain.nowSecs()) + PROOF_VALID_SECS;
  const message = claimMessage(
    network,
    contract,
    wallet.accountId,
    input.bountyId,
    input.githubId,
    key,
    expiresAt,
  );
  const theirs = await chain.claimMessage({
    bounty_id: input.bountyId,
    wallet: wallet.accountId,
    github_id: input.githubId,
    key,
    expires_at: String(expiresAt),
  });
  if (theirs !== message)
    throw new FlowError(
      "contract_disagrees",
      "The page and the contract built different texts for this claim. Nothing was signed. Reload the page.",
    );
  const proof = await proveWithdrawalKey(wallet, message, {
    contract,
    expectedKey: key,
  });
  sameKey(proof.publicKey, key);
  const keyCheck = describeKeyCheck({
    messageKey: proof.publicKey,
    transactionKey: await transactionKeyOf(wallet),
  });
  const sent = claimCall(contract, input.bountyId, key, {
    expires_at: String(expiresAt),
    signature: proof.signatureBase64,
  });
  return { call: sent, result: await wallet.call(sent), key, keyCheck };
}

export interface LinkFlowInput {
  approved: boolean;
  network: string;
  contract: string;
  wallet: FlowWallet;
  chain: Pick<FlowChain, "nowSecs" | "linkChallenge" | "linkNumber">;
  /** Everything `connect` accepts except the challenge, which the page builds itself. */
  github: Omit<ConnectOptions, "getChallenge" | "onDeviceCode"> & {
    onDeviceCode: (start: DeviceStart) => void;
  };
}
const LINK_CHALLENGE = /^proven-link:[0-9a-f]{64}$/;

/**
 * The challenge the gist will hold, built by the page from the connected wallet, the network,
 * the contract, the wallet's link number and the expiry. The contract's own `link_challenge`
 * must give exactly the same text, or nothing is created.
 *
 * Only the wallet comes from a source the server does not control (the connected wallet). The
 * network comes from the RPC's config and the contract from the server's settings, so a server
 * and RPC that agree on another contract would also agree here. The page does refuse a network
 * that contradicts the wallet's own name (a `.testnet` wallet on mainnet, or a `.near` one on
 * testnet).
 */
export async function localLinkChallenge(input: {
  network: string;
  contract: string;
  wallet: string;
  expiresAt: number;
  chain: Pick<FlowChain, "linkChallenge" | "linkNumber">;
}): Promise<string> {
  const { network, contract, wallet, expiresAt, chain } = input;
  const named = wallet.endsWith(".testnet")
    ? "testnet"
    : wallet.endsWith(".near")
      ? "mainnet"
      : null;
  if (named && named !== network)
    throw new FlowError(
      "contract_disagrees",
      `This wallet is a ${named} account, but the contract reports ${network}. No gist was created.`,
    );
  const number = await chain.linkNumber(wallet);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new FlowError(
      "contract_disagrees",
      "The contract returned a link number this page cannot use. No gist was created.",
    );
  const local = linkChallenge(network, contract, wallet, number, expiresAt);
  const contractSays = await chain.linkChallenge(wallet, expiresAt);
  if (!LINK_CHALLENGE.test(contractSays) || contractSays !== local)
    throw new FlowError(
      "contract_disagrees",
      "The link challenge the contract returned is not the one this page built for your wallet. No gist was created.",
    );
  return local;
}
/**
 * Connects GitHub once: the device flow, one secret gist holding the challenge this page built
 * for the connected wallet (and the contract confirmed), then `link`. Returns the gist, the
 * GitHub id and the call's result, whose string is the contract's outcome. Nothing starts unless
 * signing is approved.
 */
export async function linkFlow(input: LinkFlowInput): Promise<{
  gistId: string;
  githubId: number;
  expiresAt: number;
  call: Call;
  result: WalletCallResult | void;
}> {
  requireApproved(input.approved);
  const { wallet, chain, contract } = input;
  wallet.assertIdle?.();
  let expiresAt = 0;
  const gist = await connect({
    ...input.github,
    getChallenge: async () => {
      expiresAt = (await chain.nowSecs()) + PROOF_VALID_SECS;
      return await localLinkChallenge({
        network: input.network,
        contract,
        wallet: wallet.accountId,
        expiresAt,
        chain,
      });
    },
  });
  const sent = linkCall(contract, gist.gistId, expiresAt);
  return {
    gistId: gist.gistId,
    githubId: gist.githubId,
    expiresAt,
    call: sent,
    result: await wallet.call(sent),
  };
}

/** Sends one built call (cancel, release, submit, check, settle and the like) once approved. */
export async function sendFlow(input: {
  approved: boolean;
  wallet: FlowWallet;
  call: Call;
}): Promise<WalletCallResult | void> {
  requireApproved(input.approved);
  input.wallet.assertIdle?.();
  return await input.wallet.call(input.call);
}

export const REFUSAL_TEXT: Record<Refusal, string> = {
  bad_destination: "The destination is not a valid NEAR account id.",
  destination_is_vault: "The destination cannot be the vault itself.",
  destination_missing: "That named account does not exist on this network.",
  zero_amount: "Enter an amount above zero.",
  above_balance: "That is more than the vault can pay.",
  deadline_passed: "This authorization's deadline has passed. Sign a new one.",
  deadline_too_far: "The deadline is too far ahead.",
};

export interface WithdrawFlowInput {
  approved: boolean;
  network: string;
  wallet: FlowWallet;
  chain: Pick<FlowChain, "nowSecs" | "vault" | "accountExists">;
  vault: string;
  to: string;
  amount: bigint;
  /** The latest withdrawal this browser recorded for the vault, if any. */
  earlier: {
    n: bigint;
    deadline: number;
    outcome: WithdrawalOutcome["kind"];
  } | null;
  /** Called with the signed withdrawal just before the wallet is asked to send it, so the page
   * records it first and a closed tab still blocks a second authorization. */
  beforeSend?: (withdrawal: Withdrawal) => void;
}

/**
 * One withdrawal: reads the vault now, refuses what the vault would refuse, has the wallet sign
 * with the vault's key (no other key is accepted), then sends. The send's error is returned with
 * the transaction hash the wallet named, if any, so the page can re-check the transaction.
 */
export async function withdrawFlow(input: WithdrawFlowInput): Promise<{
  withdrawal: Withdrawal;
  hash: string | null;
  error: unknown;
  key: string;
  keyCheck: KeyCheck;
}> {
  requireApproved(input.approved);
  const { wallet, chain, vault } = input;
  wallet.assertIdle?.();
  const read = await chain.vault(vault);
  if (!read.exists || !read.info)
    throw new FlowError("unreadable", "The vault could not be read.");
  const { info } = read;
  const now = await chain.nowSecs();
  if (!mayAuthorizeAgain(input.earlier, BigInt(info.n), now))
    throw new FlowError(
      "busy",
      "An earlier withdrawal is still pending. Re-check it, or wait for its deadline, before signing a new one.",
    );
  let exists: boolean | null = null;
  try {
    exists = await chain.accountExists(input.to);
  } catch {
    exists = null;
  }
  const withdrawal: Withdrawal = {
    chain: input.network,
    vault,
    to: input.to,
    amount: input.amount,
    n: BigInt(info.n),
    deadline: chooseDeadline(now),
  };
  const refusal = checkWithdrawal(
    withdrawal,
    BigInt(info.available),
    exists,
    now,
  );
  if (refusal) throw new FlowError("refused", REFUSAL_TEXT[refusal]);
  const signature = await signWithdrawal(wallet, withdrawal, info.key);
  if ((await chain.nowSecs()) >= withdrawal.deadline)
    throw new FlowError("refused", REFUSAL_TEXT.deadline_passed);
  const keyCheck = describeKeyCheck({
    messageKey: info.key,
    transactionKey: await transactionKeyOf(wallet),
  });
  input.beforeSend?.(withdrawal);
  const sent = await sendWithdrawal(wallet, withdrawal, signature);
  return {
    withdrawal,
    hash: sent.hash,
    error: sent.error,
    key: info.key,
    keyCheck,
  };
}
