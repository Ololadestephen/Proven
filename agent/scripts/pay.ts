// Testnet helper: sends NEAR from one of our own test accounts and prints the transaction hash.
//   node scripts/pay.ts <to> <yocto>
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { ROOT } from "../src/config.ts";

const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const account = new Account(
  env.WORKER_HONEST_ACCOUNT_ID!,
  new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" }),
  new KeyPairSigner(KeyPair.fromString(env.WORKER_HONEST_PRIVATE_KEY as `ed25519:${string}`)),
);
const sent = await account.signAndSendTransaction({
  receiverId: process.argv[2]!,
  actions: [actions.transfer(BigInt(process.argv[3]!))],
});
console.log(sent.transaction.hash);
