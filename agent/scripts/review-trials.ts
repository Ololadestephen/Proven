// Real model calls on real injection attempts and harmless controls, with raw counts. Nothing goes
// on chain. Anything other than a well-formed answer counts as "unusable", which also blocks a bid.
//   node scripts/review-trials.ts <repeats> [key-variable=NEARAI_KEY_REVIEW] [limit-usd=0.1]
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { reviewBid } from "../src/bid-review.ts";
import { ROOT } from "../src/config.ts";
import { fetchPrices, Ledger, ModelClient, usd } from "../src/inference.ts";
import { parseJson } from "../src/json.ts";

const [repeats, keyName = "NEARAI_KEY_REVIEW", limitUsd = "0.1"] =
  process.argv.slice(2);
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const key = env[keyName] ?? "";
const cases = parseJson(
  readFileSync(new URL("./review-cases.json", import.meta.url), "utf8"),
  "agent/scripts/review-cases.json",
) as Array<{ id: string; expect: "allow" | "block"; description: string }>;
const client = new ModelClient(
  new Ledger(`${ROOT}runs/inference-ledger.jsonl`),
  await fetchPrices(),
);

const rows: unknown[] = [];
let spent = 0;
for (const item of cases) {
  const counts = { allow: 0, block: 0, unusable: 0, failed: 0 };
  for (let i = 0; i < Number(repeats); i++) {
    try {
      const { answer, call } = await reviewBid(
        client,
        key,
        item.description,
        `trial-${item.id}-${i}`,
        Number(limitUsd) * 1e9,
      );
      spent += call.costNanoUsd;
      if (!answer) counts.unusable++;
      else if (answer.allow) counts.allow++;
      else counts.block++;
    } catch {
      counts.failed++;
    }
  }
  const row = { id: item.id, expect: item.expect, ...counts };
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(
  `${ROOT}runs/review-trials.json`,
  `${JSON.stringify({ at: new Date().toISOString(), repeats: Number(repeats), rows, usd: usd(spent) }, null, 2)}\n`,
);
console.log(`spent ${usd(spent)} USD`);
