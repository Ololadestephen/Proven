// Published limits and the published rate for hosted agents. Everything here is shown on the page.
//
// Agents do not pay NEAR AI in NEAR. NEAR AI bills the operator in USD credits, and the operator buys
// those by hand. An agent's NEAR only sets how much inference the operator will run for it, at this rate.

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;

/** USD of inference per NEAR, set below the market price to leave room for the price moving. */
export const USD_PER_NEAR = 2;
export const NANO_USD = 1_000_000_000;

/** Kept back for claims, verification runs and gas, so it never turns into inference. */
export const OPERATING_RESERVE = 270n * MILLI;
/** The least an agent's wallet must hold to take a job: the reserve plus a little to spend. */
export const MIN_TO_WORK = 300n * MILLI;
/** One-time setup: the agent's custody wallet and its stored policy. Not refundable. */
export const SETUP_FEE = 50n * MILLI;
/** Left behind on withdrawal, for the wallet's own gas. */
export const WITHDRAW_LEFT_BEHIND = 2n * MILLI;

/** Hard limits. The per-call limit is the agent's remaining budget, checked at its worst case first. */
export const AGENT_LIMIT_NANO_USD = 0.5 * NANO_USD;
export const JOB_LIMIT_NANO_USD = 0.05 * NANO_USD;
export const PROJECT_LIMIT_NANO_USD = 5 * NANO_USD;

export const MAX_PROMPT_BYTES = 8 * 1024;
export const MAX_KNOWLEDGE_BYTES = 32 * 1024;
/** Model calls in one attempt, however the prompt behaves. */
export const MAX_ROUNDS = 6;
export const MAX_OUTPUT_TOKENS = 8_000;
/** Charged per skill use, so skills count against the budget even when they cost us little. */
export const SKILL_USE_NANO_USD = 100_000;

export const ALLOWED_SKILLS = [
  "knowledge_search",
  "calculator",
  "json_validator",
] as const;
export type Skill = (typeof ALLOWED_SKILLS)[number];

export function nearToNanoUsd(yocto: bigint): number {
  return (Number(yocto) / Number(NEAR)) * USD_PER_NEAR * NANO_USD;
}

export function nanoUsdToNear(nanoUsd: number): bigint {
  if (nanoUsd <= 0) return 0n;
  // Rounded up, so spending is never undercharged.
  return (
    (BigInt(Math.ceil(nanoUsd)) * NEAR) / BigInt(USD_PER_NEAR * NANO_USD) + 1n
  );
}

/** What an agent can still spend: its wallet above the reserve, less what is spent and not yet taken. */
export function budgetNanoUsd(
  balance: bigint,
  unsettledNanoUsd: number,
  spentNanoUsd: number,
): number {
  const spendable =
    balance > OPERATING_RESERVE ? balance - OPERATING_RESERVE : 0n;
  const fromWallet = nearToNanoUsd(spendable) - unsettledNanoUsd;
  const underCeiling = AGENT_LIMIT_NANO_USD - spentNanoUsd;
  return Math.max(0, Math.min(fromWallet, underCeiling));
}

/** What an owner can take out now. Spent inference comes first, then the wallet's own gas stays behind. */
export function withdrawable(
  balance: bigint,
  unsettledNanoUsd: number,
): bigint {
  const owed = nanoUsdToNear(unsettledNanoUsd);
  const out = balance - owed - WITHDRAW_LEFT_BEHIND;
  return out > 0n ? out : 0n;
}
