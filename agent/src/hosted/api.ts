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
import {
  publicView,
  SETUP_HASH,
  type HostedAgent,
  type HostedStore,
  type SetupRecord,
} from "./store.ts";
import { createHostedWallet, sendFromWallet } from "./wallets.ts";
import {
  enrollmentText,
  type HostedEnrollment,
} from "../../../shared/hosted-enrollment.ts";
import { inferenceBudget } from "./earnings.ts";
import {
  DAILY_LIMIT_NANO_USD,
  JOB_LIMIT_NANO_USD,
  MAX_CONCURRENT_JOBS,
} from "./limits.ts";

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
  earningsCapYocto?: string;
  enrollmentOwners?: ReadonlySet<string>;
  verifier: RelayVerifier;
  balance: (account: string) => Promise<bigint>;
  /** True if this finalized transaction is one exact setup-fee transfer from the owner. */
  paidTreasury: (
    hash: string,
    owner: string,
    amount: bigint,
  ) => Promise<boolean>;
  /** True if the agent holds a claim, so its NEAR may be needed for a job in progress. */
  hasActiveClaim: (wallet: string) => Promise<boolean>;
}

export function addPayload(
  input: {
    prompt: string;
    knowledge: string;
    skills: string[];
    min_buyer_paid_share?: number | null;
    keep_bps?: number;
  },
  setupTransaction?: string,
): string {
  return sha256(
    enrollmentText(
      {
        ...input,
        min_buyer_paid_share: input.min_buyer_paid_share ?? null,
        keep_bps: input.keep_bps ?? 0,
      },
      setupTransaction,
    ),
  );
}

export function canEnroll(
  deps: Pick<ApiDeps, "enrollmentOwners">,
  owner: string,
): boolean {
  return deps.enrollmentOwners?.has(owner) ?? true;
}

export function terms(
  deps?: Pick<
    ApiDeps,
    "treasury" | "codeSkills" | "earningsCapYocto" | "enrollmentOwners"
  >,
) {
  return {
    usd_per_near: USD_PER_NEAR,
    rate_review_below_usd: RATE_REVIEW_BELOW_USD,
    job_limit_usd: JOB_LIMIT_NANO_USD / 1e9,
    daily_limit_usd: DAILY_LIMIT_NANO_USD / 1e9,
    concurrent_jobs: MAX_CONCURRENT_JOBS,
    earnings_cap_near:
      Number(deps?.earningsCapYocto ?? "500000000000000000000000") / 1e24,
    setup_fee_near: Number(SETUP_FEE / 10n ** 21n) / 1000,
    treasury: deps?.treasury.accountId,
    enrollment_restricted: deps?.enrollmentOwners !== undefined,
    skills: SAFE_SKILLS,
    statement:
      "Agents do not pay NEAR AI in NEAR. NEAR AI bills the operator in USD credits, and the operator converts by hand. This is an unaudited, owner-funded deployment; on mainnet the owner holds a single key that can upgrade the contracts. The operator holds hosted agents' funds in OutLayer custody wallets whose policy allows only the escrow, the board, the agent's owner and the treasury.",
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
    keep_bps?: number;
    auth?: RelayAuth;
  },
  provision = createHostedWallet,
) {
  const owner = String(body.owner ?? "");
  if (!ACCOUNT.test(owner)) throw new PublicError("Invalid owner account.");
  if (!canEnroll(deps, owner))
    throw new PublicError(
      "Hosted enrollment is limited to invited pilot accounts.",
    );
  const prompt = String(body.prompt ?? "");
  const knowledge = String(body.knowledge ?? "");
  if (!prompt || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES)
    throw new PublicError("The prompt must be 1 byte to 8 KB.");
  if (Buffer.byteLength(knowledge) > MAX_KNOWLEDGE_BYTES)
    throw new PublicError("The knowledge text can be at most 32 KB.");
  const skills = [...new Set(body.skills ?? [])] as Skill[];
  const offered: readonly string[] = SAFE_SKILLS;
  if (skills.some((skill) => !offered.includes(skill)))
    throw new PublicError(`Skills come from this list: ${offered.join(", ")}.`);
  const share = body.min_buyer_paid_share ?? null;
  if (
    share !== null &&
    !(typeof share === "number" && share >= 0 && share <= 1)
  )
    throw new PublicError("min_buyer_paid_share must be from 0 to 1.");
  const keep = body.keep_bps ?? 0;
  if (!Number.isInteger(keep) || keep < 0 || keep > 10000)
    throw new PublicError("keep_bps must be an integer from 0 to 10000.");
  const hash = body.setup_transaction;
  if (typeof hash !== "string" || !SETUP_HASH.test(hash))
    throw new PublicError("Enter the setup payment transaction hash.");
  const settings = {
    prompt,
    knowledge,
    skills,
    min_buyer_paid_share: share,
    keep_bps: keep,
  };
  const payload = addPayload(settings, hash);
  const signed = await deps.verifier.verify(
    body.auth,
    [owner],
    "add_agent",
    0,
    payload,
  );
  if (!signed)
    throw new PublicError("Sign this request with the owner's wallet.");
  return deps.store.withSetup(hash, async () => {
    const stored = deps.store.readSetup(hash);
    if (stored === "legacy")
      throw new PublicError(
        "This payment was used by an earlier release. Ask the operator to reconcile it before paying again.",
      );
    if (stored && (stored.owner !== owner || stored.payload !== payload))
      throw new PublicError(
        "Resume this payment using its original account and agent settings.",
      );
    if (!stored && !(await deps.paidTreasury(hash, owner, SETUP_FEE)))
      throw new PublicError(
        "The setup payment could not be confirmed. Check the transaction hash and retry without paying again.",
      );
    const record: SetupRecord = stored ?? { owner, payload, reviews: 0 };
    const save = () => deps.store.saveSetup(hash, record);
    if (!stored) save();
    if (record.completed) return added(record.completed);
    await screenEnrollment(deps, settings, hash, record, save);
    if (record.refused !== undefined)
      return { added: false, reason: record.refused };
    if (!record.review)
      throw new PublicError("The agent review is unavailable.");
    const wallet = await provision(
      deps.config,
      owner,
      deps.treasury,
      undefined,
      {
        current: record.walletSetup,
        save: (stage) => {
          record.walletSetup = stage;
          save();
        },
      },
    );
    saveEnrolledAgent(deps.store, wallet, settings, owner, record.review);
    record.completed = wallet.wallet;
    delete record.walletSetup;
    save();
    return added(wallet.wallet);
  });
}

async function screenEnrollment(
  deps: ApiDeps,
  settings: HostedEnrollment,
  hash: string,
  record: SetupRecord,
  save: () => void,
) {
  if (record.review || record.refused !== undefined) return;
  if (record.reviews >= 2)
    throw new PublicError(
      "The review needs operator help. Keep your setup transaction hash and do not pay again.",
    );
  record.reviews++;
  save();
  const { answer, call } = await reviewAgent(
    deps.client,
    deps.key,
    { prompt: settings.prompt, knowledge: settings.knowledge },
    `add-${hash}`,
    REVIEW_LIMIT_NANO_USD,
  );
  if (!answer)
    throw new PublicError(
      "The review gave no usable answer. Retry with the same payment.",
    );
  if (answer.allow)
    record.review = {
      reason: answer.reason,
      model: call.model,
      chat_id: call.chatId,
      response_hash: call.responseHash,
    };
  else record.refused = answer.reason;
  save();
}

function saveEnrolledAgent(
  store: HostedStore,
  wallet: Awaited<ReturnType<typeof createHostedWallet>>,
  settings: HostedEnrollment,
  owner: string,
  review: HostedAgent["review"],
) {
  const existing = store.get(wallet.wallet);
  if (existing) {
    if (
      existing.owner !== owner ||
      existing.wallet_id !== wallet.wallet_id ||
      existing.custody_key !== wallet.custody_key
    )
      throw new PublicError("The wallet record needs operator reconciliation.");
    return;
  }
  const agent: HostedAgent = {
    ...wallet,
    owner,
    prompt: settings.prompt,
    knowledge: settings.knowledge,
    skills: settings.skills as Skill[],
    model: DEFAULT_MODEL,
    review,
    min_buyer_paid_share: settings.min_buyer_paid_share,
    keep_bps: settings.keep_bps,
    earnings: [],
    created_at: new Date().toISOString(),
    last_claim_at: null,
    settled_nano_usd: 0,
    paused: false,
  };
  store.save(agent);
}

function added(wallet: string) {
  return {
    added: true,
    agent_wallet: wallet,
    next: `Send NEAR to ${wallet} to fund it. It takes jobs once it holds at least 0.3 NEAR, and needs one registration on the board first.`,
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
    budget_usd: inferenceBudget(agent, balance, unsettled, spent) / 1e9,
    spent_usd: spent / 1e9,
    unsettled_usd: unsettled / 1e9,
    withdrawable_yocto: withdrawable(balance, unsettled).toString(),
  };
}

function clearWithdrawal(
  deps: ApiDeps,
  wallet: string,
  restorePaused?: boolean,
) {
  const latest = deps.store.get(wallet);
  if (!latest?.pending_withdrawal)
    throw new PublicError(
      "The withdrawal record changed. Reconcile before spending.",
    );
  delete latest.pending_withdrawal;
  if (restorePaused !== undefined) latest.paused = restorePaused;
  deps.store.save(latest);
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
  const fresh = deps.store.get(agent.wallet);
  if (
    !fresh ||
    fresh.pending_withdrawal ||
    fresh.pending_settlement_nano_usd ||
    fresh.pending_claim_bid !== undefined ||
    fresh.pending_registration
  )
    throw new PublicError(
      "An earlier action needs reconciliation before another withdrawal.",
    );
  // Acquire the durable spending gate before any further asynchronous read.
  const priorPaused = fresh.paused;
  fresh.paused = true;
  fresh.pending_withdrawal = true;
  deps.store.save(fresh);
  if (await deps.hasActiveClaim(agent.wallet)) {
    clearWithdrawal(deps, agent.wallet, priorPaused);
    throw new PublicError(
      "This agent holds a claim. Withdraw when the job has ended.",
    );
  }
  const spent = deps.ledger.spentNanoUsd(spenderOf(agent.wallet));
  const unsettled = Math.max(0, spent - fresh.settled_nano_usd);
  const balance = await deps.balance(agent.wallet);
  const amount = withdrawable(balance, unsettled);
  if (amount <= 0n) {
    clearWithdrawal(deps, agent.wallet, priorPaused);
    throw new PublicError("Nothing can be withdrawn.");
  }
  const hashes = await sendFromWallet(
    deps.config,
    agent.custody_key,
    agent.owner,
    amount,
    agent.wallet,
  );
  clearWithdrawal(deps, agent.wallet);
  return {
    sent_yocto: amount.toString(),
    transactions: hashes,
    agent_paused: true,
  };
}
