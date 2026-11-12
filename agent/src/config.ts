import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { PublicError } from "./errors.ts";
import { networkSettings } from "./network.ts";
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
  /** A hosted relay's https address. Without it, the local socket is used. */
  relayUrl?: string;
  /** Set for a hosted agent's wallet, whose stored policy also allows its owner and the treasury. */
  hosted?: { owner: string; treasury: string };
}
export function loadConfig(selected?: Actor): Config {
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
  } catch {
    /* Read-only/dry-run use needs no credentials. */
  }
  const get = (name: string) => process.env[name] ?? file[name];
  // The Stage 2 flag counts only when set for this command, never from the .env file.
  const net = networkSettings(
    get("NEAR_NETWORK"),
    process.env.PROVEN_STAGE2_APPROVED,
  );
  const mainnet = net.network === "mainnet";
  const actor = selected ?? get("PROVEN_ACTOR") ?? "buyer";
  if (
    actor !== "buyer" &&
    actor !== "honest" &&
    actor !== "fake" &&
    actor !== "agent"
  )
    throw new PublicError("Invalid actor.");
  const escrow = accountId(
    mainnet
      ? (get("MAINNET_ESCROW_ACCOUNT_ID") ?? "")
      : (get("ESCROW_CONTRACT") ?? "escrow-v5.proven.testnet"),
  );
  if (!escrow.endsWith(net.suffix))
    throw new PublicError("The escrow is not on this network.");
  const rpc = mainnet
    ? (get("MAINNET_RPC_URL") ?? net.rpcs[0])
    : (get("NEAR_RPC_URL") ?? net.rpcs[0]);
  if (!(net.rpcs as readonly string[]).includes(rpc))
    throw new PublicError("Use an approved RPC endpoint for this network.");
  const custodyApi = get("PROVEN_CUSTODY_API") ?? net.custodyApi;
  if (custodyApi !== net.custodyApi)
    throw new PublicError("Use this network's custody API.");
  const prefix = mainnet
    ? actor === "honest"
      ? "MAINNET_WORKER_A_SCOPED"
      : "MAINNET_WORKER_B_SCOPED"
    : actor === "honest"
      ? "PROVEN_HONEST"
      : "PROVEN_FAKE";
  const buyerPrefix = mainnet ? "MAINNET_BUYER" : "PROVEN_BUYER";
  const account =
    actor === "buyer"
      ? get(`${buyerPrefix}_ACCOUNT_ID`)
      : actor === "agent"
        ? get("PROVEN_AGENT_ACCOUNT_ID")
        : get(`${prefix}_ACCOUNT_ID`);
  if (account) accountId(account);
  return {
    actor,
    escrow,
    rpc,
    custodyApi,
    socket: get("PROVEN_RELAY_SOCKET") ?? `${ROOT}runs/private/relay.sock`,
    custodyKey:
      actor === "buyer"
        ? get(`${buyerPrefix}_CUSTODY_KEY`)
        : actor === "agent"
          ? get("PROVEN_AGENT_CUSTODY_KEY")
          : undefined,
    account,
    key:
      actor === "buyer" || actor === "agent"
        ? undefined
        : get(`${prefix}_PRIVATE_KEY`),
    demoSession: process.env.PROVEN_DEMO_SESSION,
    relayUrl: get("PROVEN_RELAY_URL"),
  };
}
