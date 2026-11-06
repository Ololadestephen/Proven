// Does NEAR AI itself stop a key at its spending limit? Calls through the shared client on a key with
// a very small limit until NEAR AI refuses, or until the call cap. Prints no key. No local limit is
// passed, so only NEAR AI can stop it.
//   node scripts/limit-test.ts <key-variable> <max-calls>
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ROOT } from "../src/config.ts";
import {
  fetchPrices,
  Ledger,
  ModelClient,
  ModelRefused,
  usd,
} from "../src/inference.ts";

const [keyName, maxCalls] = process.argv.slice(2);
const key = parseEnv(readFileSync(`${ROOT}.env`, "utf8"))[keyName];
if (!key) throw new Error(`${keyName} is not set`);
const client = new ModelClient(
  new Ledger(`${ROOT}runs/inference-ledger.jsonl`),
  await fetchPrices(),
);

const rows: unknown[] = [];
let spent = 0;
let stopped: unknown = null;
for (let i = 0; i < Number(maxCalls) && !stopped; i++) {
  try {
    const call = await client.call({
      spender: "limit-test",
      stage: "limit-test",
      run: `${keyName}-${i}`,
      key,
      maxOutputTokens: 8_000,
      messages: [
        {
          role: "user",
          content:
            "List the integers from 1 to 3000, one per line, with no other text.",
        },
      ],
    });
    spent += call.costNanoUsd;
    rows.push({
      call: i,
      status: 200,
      output_tokens: call.outputTokens,
      usd: usd(call.costNanoUsd),
      cumulative_usd: usd(spent),
    });
  } catch (error) {
    stopped =
      error instanceof ModelRefused
        ? { call: i, status: error.status, code: error.code }
        : { call: i, error: "did not complete" };
  }
  console.log(JSON.stringify(rows.at(-1)));
}
const result = {
  key: keyName,
  at: new Date().toISOString(),
  rows,
  stopped,
  cumulative_usd: usd(spent),
};
writeFileSync(
  `${ROOT}runs/limit-test.json`,
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify({ stopped, cumulative_usd: usd(spent) }));
