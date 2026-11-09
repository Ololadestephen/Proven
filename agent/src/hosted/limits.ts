// Published limits and the published rate for hosted agents. Everything here is shown on the page.
//
// Agents do not pay NEAR AI in NEAR. NEAR AI bills the operator in USD credits, and the operator buys
// those by hand. An agent's NEAR only sets how much inference the operator will run for it, at this rate.

const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;

/** USD of inference per NEAR, set below the market price to leave room for the price moving. */
export const USD_PER_NEAR = 2;
/** Below this NEAR price the rate leaves too little margin, and the owner reviews it. */
export const RATE_REVIEW_BELOW_USD = 2.5;
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
export const DAILY_LIMIT_NANO_USD = 0.25 * NANO_USD;
export const MAX_CONCURRENT_JOBS = 1;
export const PROJECT_LIMIT_NANO_USD = 5 * NANO_USD;

export const MAX_PROMPT_BYTES = 8 * 1024;
export const MAX_KNOWLEDGE_BYTES = 32 * 1024;
/** Model calls in one attempt, however the prompt behaves. */
export const MAX_ROUNDS = 6;
export const MAX_OUTPUT_TOKENS = 8_000;
/** Charged per skill use, so skills count against the budget even when they cost us little. */
export const SKILL_USE_NANO_USD = 100_000;

/** Run inside this service, within fixed limits. A stranger's text can choose when to call one and
 * with what input, but none writes anything, and model-written WebAssembly runs only in an
 * interpreter with fuel, inside a WebAssembly module with no imports. */
export const SAFE_SKILLS = [
  "knowledge_search",
  "calculator",
  "json_validator",
  "csv_to_json",
  "wat_compile",
  "run_function",
  "table_aggregate",
  "extract",
  // Reads only, from fixed free NEAR endpoints; see chain-read.ts.
  "chain_read",
] as const;
/** Run in a disposable sandbox on a separate isolated machine. See deploy/sandbox. */
export const CODE_SKILLS = [
  "run_code",
  "run_tests",
  "read_repo",
  "make_patch",
] as const;
export const ALLOWED_SKILLS = [...SAFE_SKILLS, ...CODE_SKILLS] as const;
/** A sandbox run costs far more of our machine than a pure function, so it is charged more. */
export const CODE_SKILL_USE_NANO_USD = 2_000_000;
/** Compiling and running WebAssembly takes more of our machine than a text function. */
export const FUNCTION_SKILL_USE_NANO_USD = 200_000;
export type Skill = (typeof ALLOWED_SKILLS)[number];

/** What one use of each skill is charged. Only a use that ran is charged. */
export const SKILL_PRICES: Record<Skill, number> = {
  knowledge_search: SKILL_USE_NANO_USD,
  calculator: SKILL_USE_NANO_USD,
  json_validator: SKILL_USE_NANO_USD,
  csv_to_json: SKILL_USE_NANO_USD,
  wat_compile: FUNCTION_SKILL_USE_NANO_USD,
  run_function: FUNCTION_SKILL_USE_NANO_USD,
  table_aggregate: SKILL_USE_NANO_USD,
  // Each pattern runs in its own worker thread.
  extract: FUNCTION_SKILL_USE_NANO_USD,
  // Charged only for a read that returned a result, cached or not.
  chain_read: FUNCTION_SKILL_USE_NANO_USD,
  run_code: CODE_SKILL_USE_NANO_USD,
  run_tests: CODE_SKILL_USE_NANO_USD,
  read_repo: CODE_SKILL_USE_NANO_USD,
  make_patch: CODE_SKILL_USE_NANO_USD,
};

const CODE_SKILL_HELP =
  'input is {"language":"python"|"node","command":"...","files":{...},"repo":{"owner","name","commit"}} (files and repo optional); runs in an offline sandbox';

/** One line per skill, shown to the model, so it knows what input each one takes. */
export const SKILL_HELP: Record<Skill, string> = {
  knowledge_search:
    "input is search words; returns the best matching paragraphs of your knowledge",
  calculator: "input is one arithmetic expression, for example (12.5 * 4) - 3",
  json_validator:
    "input is a candidate result; says whether it fits the public format",
  csv_to_json:
    "input is CSV text with a header row; returns the rows as JSON objects",
  wat_compile:
    'input is WebAssembly text; says whether it compiles and would load as the bid\'s function. On a function bid you may then answer with only {"wat":"<the text>"} and it is compiled for you',
  run_function:
    'input is {"wat":"<WebAssembly text>","cases":[[arguments],...]} with up to 64 cases; returns what the function gives for each, by the verifier\'s rules. Only on a function bid',
  table_aggregate:
    'input is {"op":"totals","rows":[...],"fields":["amount"],"group_by":"supplier"} for exact count, sum, min and max (group_by optional); {"op":"reconcile","rows":[...],"items":"lines","item_field":"amount","total_field":"total","key_field":"id"} for rows whose items do not add up to their total; or {"op":"duplicates","rows":[...],"field":"id"}. Write numbers above 2^53 or with decimals as strings',
  extract:
    'input is {"text":"...","pattern":"<regular expression>","flags":"i","normalise":{"1":"cents","date":"date_dmy"}}; returns each match\'s groups by number and name. Normalisers: trim, lower, upper, number, number_comma_decimal, cents, cents_comma_decimal, date_ymd, date_dmy, date_mdy. A value that cannot be normalised exactly becomes null',
  chain_read:
    'reads NEAR, never writes. input is one of {"method":"view_account","account_id":"x.near","block":123}, {"method":"call_function","account_id":"x.near","function":"get_x","args":{},"block":123}, {"method":"block","block":123 or "final"}, {"method":"tx","hash":"...","sender_id":"x.near"}, {"method":"events","account_id":"x.near","block":123} (the EVENT_JSON logs of that contract in that block, any age). Add "select":["field.path"] to keep only some fields. State reads need the block the bid names; free nodes keep only about the last 100,000 blocks. Up to 30 reads per attempt',
  run_code: CODE_SKILL_HELP,
  run_tests: CODE_SKILL_HELP,
  read_repo: CODE_SKILL_HELP,
  make_patch: CODE_SKILL_HELP,
};

export function nearToNanoUsd(yocto: bigint): number {
  return Number((yocto * BigInt(USD_PER_NEAR * NANO_USD)) / NEAR);
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
