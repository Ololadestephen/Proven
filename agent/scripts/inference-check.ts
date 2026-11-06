// One real NEAR AI call per key, to confirm the keys and the credit work. Prints no key.
import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";
import { fetchPrices, Ledger, ModelClient, usd } from "../src/inference.ts";
import { publicMessage } from "../src/errors.ts";
import { ROOT } from "../src/config.ts";

const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const client = new ModelClient(new Ledger(`${ROOT}runs/inference-ledger.jsonl`), await fetchPrices());
for (const [spender, name] of [["agent-a", "NEARAI_KEY_AGENT_A"], ["agent-b", "NEARAI_KEY_AGENT_B"], ["review", "NEARAI_KEY_REVIEW"]] as const) {
  try {
    const r = await client.call({ spender, stage: "key-check", run: "first-call", key: env[name] ?? "", messages: [{ role: "user", content: "Reply with the single word: ready" }], maxOutputTokens: 200 });
    console.log(JSON.stringify({ spender, chat_id: r.chatId, model: r.model, finish: r.finishReason, text: r.text.slice(0, 80), input: r.inputTokens, output: r.outputTokens, usd: usd(r.costNanoUsd) }));
  } catch (error) {
    console.log(JSON.stringify({ spender, failed: publicMessage(error) }));
  }
}
