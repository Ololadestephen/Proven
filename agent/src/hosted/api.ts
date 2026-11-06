// What anyone can ask of the hosted service. Adding an agent and withdrawing both need the owner's wallet
// signature. Nothing here can touch a job, a verdict or another agent's money.
import { createHash } from "node:crypto";
import type { Account } from "near-api-js";
import {
  RelayVerifier,
  type RelayAuth,
} from "../../../relay/src/buyer-auth.ts";
import type { Config } from "../config.ts";
import { PublicError } from "../errors.ts";
import { DEFAULT_MODEL, type Ledger, type ModelClient } from "../inference.ts";
import { reviewAgent } from "./agent-review.ts";
import {
  ALLOWED_SKILLS,
  MAX_KNOWLEDGE_BYTES,
  MAX_PROMPT_BYTES,
  RATE_REVIEW_BELOW_USD,
  SAFE_SKILLS,
  SETUP_FEE,
  USD_PER_NEAR,
  withdrawable,
  type Skill,
} from "./limits.ts";
import { spenderOf } from "./runner.ts";
import { publicView, type HostedAgent, type HostedStore } from "./store.ts";
import { createHostedWallet, sendFromWallet } from "./wallets.ts";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;
const REVIEW_LIMIT_NANO_USD = 200_000_000;

export interface ApiDeps {
  config: Config;
  store: HostedStore;
  ledger: Ledger;
  client: Pick<ModelClient, "call">;
  key: string;
  treasury: Account;
  codeSkills?: boolean;
  verifier: RelayVerifier;
  balance: (account: string) => Promise<bigint>;
  /** True if this finished transaction is `owner` paying the treasury at least `amount`. */
  paidTreasury: (
    hash: string,
    owner: string,
    amount: bigint,
  ) => Promise<boolean>;
  /** True if the agent holds a claim, so its NEAR may be needed for a job in progress. */
  hasActiveClaim: (wallet: string) => Promise<boolean>;
}

export function addPayload(input: {
  prompt: string;
  knowledge: string;
  skills: string[];
}): string {
  return sha256(
    `${input.prompt}\0${input.knowledge}\0${[...input.skills].sort().join(",")}`,
  );
}

export function terms(deps?: Pick<ApiDeps, "treasury" | "codeSkills">) {
  return {
    usd_per_near: USD_PER_NEAR,
    rate_review_below_usd: RATE_REVIEW_BELOW_USD,
    setup_fee_near: Number(SETUP_FEE / 10n ** 21n) / 1000,
    treasury: deps?.treasury.accountId,
    skills: deps?.codeSkills ? ALLOWED_SKILLS : SAFE_SKILLS,
    statement:
      "Agents do not pay NEAR AI in NEAR. NEAR AI bills the operator in USD credits, and the operator converts by hand. The operator holds hosted agents' funds in OutLayer custody wallets whose policy allows only the escrow, the board, the agent's owner and the treasury.",
  };
}

/** The owner pays the setup fee first, so strangers cannot make the operator pay for wallets and reviews. */
export async function addAgent(
  deps: ApiDeps,
  body: {
    owner: string;
    prompt: string;
    knowledge?: string;
    skills?: string[];
    setup_transaction: string;
    min_buyer_paid_share?: number | null;
    auth?: RelayAuth;
  },
) {
  const owner = String(body.owner ?? "");
  if (!ACCOUNT.test(owner)) throw new PublicError("Invalid owner account.");
  const prompt = String(body.prompt ?? "");
  const knowledge = String(body.knowledge ?? "");
  if (!prompt || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES)
    throw new PublicError("The prompt must be 1 byte to 8 KB.");
  if (Buffer.byteLength(knowledge) > MAX_KNOWLEDGE_BYTES)
    throw new PublicError("The knowledge text can be at most 32 KB.");
  const skills = [...new Set(body.skills ?? [])] as Skill[];
  const offered: readonly string[] = deps.codeSkills
    ? ALLOWED_SKILLS
    : SAFE_SKILLS;
  if (skills.some((skill) => !offered.includes(skill)))
    throw new PublicError(`Skills come from this list: ${offered.join(", ")}.`);
  const share = body.min_buyer_paid_share ?? null;
  if (
    share !== null &&
    !(typeof share === "number" && share >= 0 && share <= 1)
  )
    throw new PublicError("min_buyer_paid_share must be from 0 to 1.");
  const signed = await deps.verifier.verify(
    body.auth,
    [owner],
    "add_agent",
    0,
    addPayload({ prompt, knowledge, skills }),
  );
  if (!signed)
    throw new PublicError("Sign this request with the owner's wallet.");
  if (!(await deps.paidTreasury(body.setup_transaction, owner, SETUP_FEE)))
    throw new PublicError(
      `Pay ${Number(SETUP_FEE) / 1e24} NEAR to ${deps.treasury.accountId} from the owner's account first, and give that transaction's hash.`,
    );
  if (!deps.store.claimSetupTransaction(body.setup_transaction))
    throw new PublicError("That setup payment has already been used.");
  const { answer, call } = await reviewAgent(
    deps.client,
    deps.key,
    { prompt, knowledge },
    `add-${sha256(prompt).slice(0, 12)}`,
    REVIEW_LIMIT_NANO_USD,
  );
  if (!answer || !answer.allow)
    return {
      added: false,
      reason: answer?.reason ?? "The review gave no usable answer.",
      note: "The setup fee is not refunded. The review can only keep an agent out; it never decides payment.",
    };
  const wallet = await createHostedWallet(deps.config, owner, deps.treasury);
  const agent: HostedAgent = {
    ...wallet,
    owner,
    prompt,
    knowledge,
    skills,
    model: DEFAULT_MODEL,
    review: {
      reason: answer.reason,
      model: call.model,
      chat_id: call.chatId,
      response_hash: call.responseHash,
    },
    min_buyer_paid_share: share,
    created_at: new Date().toISOString(),
    last_claim_at: null,
    settled_nano_usd: 0,
    paused: false,
  };
  deps.store.save(agent);
  return {
    added: true,
    agent_wallet: agent.wallet,
    next: `Send NEAR to ${agent.wallet} to fund it. It takes jobs once it holds at least 0.3 NEAR, and needs one registration on the board first.`,
  };
}

export async function agentStatus(deps: ApiDeps, wallet: string) {
  const agent = deps.store.get(wallet);
  if (!agent) throw new PublicError("No such hosted agent.");
  const balance = await deps.balance(wallet);
  const spent = deps.ledger.spentNanoUsd(spenderOf(wallet));
  const unsettled = Math.max(0, spent - agent.settled_nano_usd);
  return {
    ...publicView(agent),
    balance_yocto: balance.toString(),
    spent_usd: spent / 1e9,
    unsettled_usd: unsettled / 1e9,
    withdrawable_yocto: withdrawable(balance, unsettled).toString(),
  };
}

/** Only the owner. Spending is taken first, and nothing moves while a job could still need the NEAR. */
export async function withdraw(
  deps: ApiDeps,
  body: { wallet: string; auth?: RelayAuth },
) {
  const agent = deps.store.get(String(body.wallet ?? ""));
  if (!agent) throw new PublicError("No such hosted agent.");
  const signed = await deps.verifier.verify(
    body.auth,
    [agent.owner],
    "withdraw",
    0,
    sha256(agent.wallet),
  );
  if (!signed) throw new PublicError("Only the agent's owner can withdraw.");
  if (await deps.hasActiveClaim(agent.wallet))
    throw new PublicError(
      "This agent holds a claim. Withdraw when the job has ended.",
    );
  const fresh = deps.store.get(agent.wallet) ?? agent;
  fresh.paused = true;
  deps.store.save(fresh);
  const spent = deps.ledger.spentNanoUsd(spenderOf(agent.wallet));
  const unsettled = Math.max(0, spent - fresh.settled_nano_usd);
  const balance = await deps.balance(agent.wallet);
  const amount = withdrawable(balance, unsettled);
  if (amount <= 0n) throw new PublicError("Nothing can be withdrawn.");
  const hashes = await sendFromWallet(
    deps.config,
    agent.custody_key,
    agent.owner,
    amount,
  );
  return {
    sent_yocto: amount.toString(),
    transactions: hashes,
    agent_paused: true,
  };
}
