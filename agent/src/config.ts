import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { PublicError } from "./errors.ts";
import { accountId } from "./validation.ts";
import type { Actor } from "./types.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export interface Config {
  actor: Actor;
  escrow: string;
  rpc: string;
  socket: string;
  custodyApi: string;
  custodyKey?: string;
  account?: string;
  key?: string;
  demoSession?: string;
}
export function loadConfig(selected?: Actor): Config {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
  } catch {
    /* Read-only/dry-run use needs no credentials. */
  }
  const get = (name: string) => process.env[name] ?? file[name];
  if ((get("NEAR_NETWORK") ?? "testnet") !== "testnet")
    throw new PublicError("This agent interface supports testnet only.");
  const actor = selected ?? get("PROVEN_ACTOR") ?? "buyer";
  if (actor !== "buyer" && actor !== "honest" && actor !== "fake")
    throw new PublicError("Invalid actor.");
  const escrow = accountId(
    get("ESCROW_CONTRACT") ?? "escrow-v2.proven.testnet",
  );
  if (!escrow.endsWith(".testnet"))
    throw new PublicError("Escrow must be a testnet account.");
  const rpc = get("NEAR_RPC_URL") ?? "https://test.rpc.fastnear.com";
  if (
    ![
      "https://test.rpc.fastnear.com",
      "https://rpc.testnet.near.org",
      "https://archival-rpc.testnet.near.org",
    ].includes(rpc)
  )
    throw new PublicError("Use an approved testnet RPC endpoint.");
  const custodyApi =
    get("PROVEN_CUSTODY_API") ?? "https://testnet-api.outlayer.ai";
  if (custodyApi !== "https://testnet-api.outlayer.ai")
    throw new PublicError("Use the testnet custody API.");
  const prefix = actor === "honest" ? "PROVEN_HONEST" : "PROVEN_FAKE";
  const account =
    actor === "buyer"
      ? get("PROVEN_BUYER_ACCOUNT_ID")
      : get(`${prefix}_ACCOUNT_ID`);
  if (account) accountId(account);
  return {
    actor,
    escrow,
    rpc,
    custodyApi,
    socket: get("PROVEN_RELAY_SOCKET") ?? `${ROOT}runs/private/relay.sock`,
    custodyKey: actor === "buyer" ? get("PROVEN_BUYER_CUSTODY_KEY") : undefined,
    account,
    key: actor === "buyer" ? undefined : get(`${prefix}_PRIVATE_KEY`),
    demoSession: process.env.PROVEN_DEMO_SESSION,
  };
}
