// Opens (or closes) the mainnet job board to every buyer: one call of the board's own
// `set_market_open`, signed by its owner proven-ops.near with the key the owner placed in .env.
// It moves no funds; gas only. The owner said yes in chat on November 12.
//   NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes node scripts/open-market.ts open|close [--dry-run]
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { ROOT } from "../src/config.ts";
import { PublicError, publicMessage } from "../src/errors.ts";
import { networkSettings } from "../src/network.ts";

const TGAS = 10n ** 12n;
const BOARD = "proven-board.near";

const net = networkSettings(
  process.env.NEAR_NETWORK,
  process.env.PROVEN_STAGE2_APPROVED,
);
if (net.network !== "mainnet")
  throw new PublicError("This script is for mainnet only.");
const env: Record<string, string | undefined> = {
  ...parseEnv(readFileSync(`${ROOT}.env`, "utf8")),
};
const choice = process.argv[2];
if (choice !== "open" && choice !== "close") {
  console.error("usage: open-market.ts open|close [--dry-run]");
  process.exit(2);
}
const dry = process.argv.includes("--dry-run");
const provider = new JsonRpcProvider({ url: net.rpcs[0] });

async function main() {
  const owner = env.MAINNET_OPS_ACCOUNT_ID;
  const secret = env.MAINNET_OPS_PRIVATE_KEY;
  if (owner !== "proven-ops.near" || !secret?.startsWith("ed25519:"))
    throw new PublicError("MAINNET_OPS is not proven-ops.near in .env.");
  const config = (await provider.callFunction({
    contractId: BOARD,
    method: "get_config",
    args: {},
  })) as { owner?: string };
  if (config.owner !== owner)
    throw new PublicError(
      `The board's owner is ${config.owner}, not ${owner}.`,
    );
  const plan = {
    signer: owner,
    receiver: BOARD,
    method: "set_market_open",
    args: { open: choice === "open" },
    gas_tgas: 30,
    deposit: "0",
  };
  console.log(JSON.stringify(plan));
  if (dry) return console.log("dry run: nothing sent");
  const account = new Account(
    owner,
    provider,
    new KeyPairSigner(KeyPair.fromString(secret as `ed25519:${string}`)),
  );
  const result = await account.callFunctionRaw({
    contractId: BOARD,
    methodName: "set_market_open",
    args: { open: choice === "open" },
    gas: 30n * TGAS,
    deposit: 0n,
  });
  const ok =
    typeof result.status === "object" &&
    result.status !== null &&
    "SuccessValue" in result.status;
  console.log(`${ok ? "sent" : "FAILED"}: ${result.transaction.hash}`);
  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`open-market: ${publicMessage(error)}`);
  process.exit(1);
});
