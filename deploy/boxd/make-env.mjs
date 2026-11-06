// Writes the short .env a hosted testnet server gets, from the full one on this machine, and prints no values.
// It holds only what the server needs: no buyer, worker, custody, mainnet or owner keys.
//   node deploy/boxd/make-env.mjs
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const root = new URL("../../", import.meta.url);
const env = parseEnv(readFileSync(new URL(".env", root), "utf8"));
const need = (name) => {
  if (!env[name]) throw new Error(`${name} is not set in .env.`);
  return env[name];
};
const shared = {
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: "https://test.rpc.fastnear.com",
  ESCROW_CONTRACT: "escrow-v4.proven.testnet",
};
// For the web server and its review step, which face the internet. No relay key.
const web = {
  ...shared,
  PROVEN_MARKET_ESCROW: "escrow-v4.proven.testnet",
  PROVEN_BOARD: "board-v3.proven.testnet",
  // Records bid reviews. The key can call only record_review on the board.
  NEAR_ACCOUNT_ID: need("NEAR_ACCOUNT_ID"),
  PROVEN_REVIEWER_V3_PRIVATE_KEY: need("PROVEN_REVIEWER_V3_PRIVATE_KEY"),
  NEARAI_KEY_REVIEW: need("NEARAI_KEY_REVIEW"),
};
// For the relay only. A small account of its own, with no power over the escrow.
const relay = {
  ...shared,
  PROVEN_BOARD: "board-v3.proven.testnet",
  RELAY_ACCOUNT_ID: need("HOSTED_RELAY_ACCOUNT_ID"),
  RELAY_PRIVATE_KEY: need("HOSTED_RELAY_PRIVATE_KEY"),
};
// For the hosted agents service only: the treasury, and the NEAR AI key hosted agents spend.
const hosted = {
  ...shared,
  PROVEN_BOARD: "board-v3.proven.testnet",
  HOSTED_TREASURY_ACCOUNT_ID: need("HOSTED_TREASURY_ACCOUNT_ID"),
  HOSTED_TREASURY_PRIVATE_KEY: need("HOSTED_TREASURY_PRIVATE_KEY"),
  NEARAI_KEY_HOSTED: env.NEARAI_KEY_HOSTED ?? need("NEARAI_KEY_AGENT_B"),
  ...(process.env.SANDBOX_URL && process.env.SANDBOX_TOKEN
    ? {
        SANDBOX_URL: process.env.SANDBOX_URL,
        SANDBOX_TOKEN: process.env.SANDBOX_TOKEN,
      }
    : {}),
};
mkdirSync(new URL("runs/private/", root), { recursive: true, mode: 0o700 });
for (const [name, lines] of [
  ["boxd.env", web],
  ["boxd-relay.env", relay],
  ["boxd-hosted.env", hosted],
]) {
  const out = new URL(`runs/private/${name}`, root);
  writeFileSync(
    out,
    Object.entries(lines)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  );
  chmodSync(out, 0o600);
}
console.log("Wrote the three short env files under runs/private.");
