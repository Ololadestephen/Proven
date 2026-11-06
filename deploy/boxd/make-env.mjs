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
const lines = {
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: "https://test.rpc.fastnear.com",
  ESCROW_CONTRACT: "escrow-v3.proven.testnet",
  PROVEN_MARKET_ESCROW: "escrow-v3.proven.testnet",
  PROVEN_BOARD: "board-v2.proven.testnet",
  PROVEN_RELAY_REQUIRE_SIGNATURES: "yes",
  // Signs the private inputs. A small account of its own, with no power over the escrow.
  RELAY_ACCOUNT_ID: need("HOSTED_RELAY_ACCOUNT_ID"),
  RELAY_PRIVATE_KEY: need("HOSTED_RELAY_PRIVATE_KEY"),
  // Records bid reviews. The key can call only record_review on the board.
  NEAR_ACCOUNT_ID: need("NEAR_ACCOUNT_ID"),
  PROVEN_REVIEWER_V2_PRIVATE_KEY: need("PROVEN_REVIEWER_V2_PRIVATE_KEY"),
  NEARAI_KEY_REVIEW: need("NEARAI_KEY_REVIEW"),
};
const out = new URL("runs/private/boxd.env", root);
mkdirSync(new URL("runs/private/", root), { recursive: true, mode: 0o700 });
writeFileSync(
  out,
  Object.entries(lines)
    .map(([name, value]) => `${name}=${value}\n`)
    .join(""),
  { mode: 0o600 },
);
chmodSync(out, 0o600);
console.log(
  `Wrote ${Object.keys(lines).length} settings to runs/private/boxd.env.`,
);
