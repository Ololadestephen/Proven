// Real test of the key pool against a real NEAR AI spending limit. It calls until the first key is
// really refused at its limit, checks the pool moved to the next key and that call worked, then checks
// a budget stops the pool before any call. Prints no key. Spends up to the first key's limit.
//   node scripts/limit-test.ts <first-key-variable> <spare-key-variable> <max-calls>
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ROOT } from "../src/config.ts";
import { fetchPrices, Ledger, ModelClient, usd } from "../src/inference.ts";
import { BudgetStop, KeyPool } from "../src/key-pool.ts";

const [firstName, spareName, maxCalls] = process.argv.slice(2);
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const first = env[firstName];
const spare = env[spareName];
if (!first || !spare) throw new Error("Both key variables must be set.");
const ledger = new Ledger(`${ROOT}runs/inference-ledger.jsonl`);
const client = new ModelClient(ledger, await fetchPrices());
const logPath = `${ROOT}runs/limit-test-events.jsonl`;
const run = `limit-test-${Date.now()}`;
const generous = {
  agentNanoUsd: 200_000_000,
  projectNanoUsd: 1_000_000_000,
  jobNanoUsd: 200_000_000,
};
const pool = new KeyPool(
  client,
  ledger,
  [
    { name: firstName, key: first },
    { name: spareName, key: spare },
  ],
  generous,
  logPath,
);
const request = (i: number) => ({
  spender: "limit-test",
  stage: "limit-test",
  run,
  key: "",
  maxOutputTokens: 8_000,
  messages: [
    {
      role: "user" as const,
      content: `Call ${i}. List the integers from 1 to 3000, one per line, with no other text.`,
    },
  ],
});
const keyOfLastRow = () => ledger.rows().at(-1)?.key_name;

const rows: unknown[] = [];
let switched = false;
let afterSwitch: unknown = null;
for (let i = 0; i < Number(maxCalls); i++) {
  const call = await pool.call(request(i));
  const key = keyOfLastRow();
  const row = { call: i, key, usd: usd(call.costNanoUsd) };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (key === spareName) {
    switched = true;
    afterSwitch = row;
    break;
  }
}

// A budget already reached stops the pool before any call, whichever key is next.
let budgetStop = "no stop";
const before = ledger.rows().length;
try {
  await new KeyPool(
    client,
    ledger,
    [{ name: spareName, key: spare }],
    { ...generous, jobNanoUsd: 1 },
    logPath,
  ).call(request(999));
} catch (error) {
  budgetStop = error instanceof BudgetStop ? error.message : "other error";
}
const result = {
  at: new Date().toISOString(),
  first_key: firstName,
  spare_key: spareName,
  rows,
  switched,
  after_switch: afterSwitch,
  budget_stop: budgetStop,
  calls_made_after_budget_stop: ledger.rows().length - before,
  run_usd: usd(
    ledger
      .rows()
      .filter((row) => row.run === run)
      .reduce((sum, row) => sum + row.cost_nano_usd, 0),
  ),
};
writeFileSync(
  `${ROOT}runs/limit-test.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result).slice(-320));
