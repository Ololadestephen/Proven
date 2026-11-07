// Settings, read from the environment (`.env` at the repository root).
// Keys are only ever handed to the signer; they are never printed or logged.

import type { KeyPairString } from "near-api-js";

export interface Config {
  rpcUrl: string;
  broadcastRpcUrl?: string;
  relayAccountId: string;
  relayPrivateKey: KeyPairString;
  escrowContract: string;
  outlayerContract: string;
  outlayerApi: string;
}

export const TESTNET_RPC_URLS: readonly string[] = [
  "https://test.rpc.fastnear.com",
  "https://near-testnet.drpc.org",
  "https://testnet-rpc.intea.rs",
  "https://rpc.testnet.near.org",
  "https://archival-rpc.testnet.near.org",
];

function required(name: string, fallback?: string): string {
  const value =
    process.env[name] || (fallback ? process.env[fallback] : undefined);
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export const MAINNET_RPC_URLS: readonly string[] = [
  "https://rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
];

/** Unaudited, owner-funded Stage 2 only: refused without the approval flag, and no default escrow. */
function loadMainnetConfig(): Config {
  if (process.env.PROVEN_STAGE2_APPROVED !== "yes")
    throw new Error("Mainnet is refused without the Stage 2 approval flag.");
  // Its own small account, as on testnet. The ops account owns the escrow and never goes on a server.
  const key = required("MAINNET_RELAY_PRIVATE_KEY");
  if (!key.startsWith("ed25519:"))
    throw new Error("MAINNET_RELAY_PRIVATE_KEY must be an ed25519 key");
  const rpcUrl = process.env.MAINNET_RPC_URL || MAINNET_RPC_URLS[0]!;
  if (!MAINNET_RPC_URLS.includes(rpcUrl))
    throw new Error("Use an approved mainnet RPC endpoint");
  return {
    rpcUrl,
    relayAccountId: required("MAINNET_RELAY_ACCOUNT_ID"),
    relayPrivateKey: key as KeyPairString,
    escrowContract: required("MAINNET_ESCROW_ACCOUNT_ID"),
    outlayerContract: "outlayer.near",
    outlayerApi: "https://api.outlayer.ai",
  };
}

export function loadConfig(): Config {
  if (process.env.NEAR_NETWORK === "mainnet") return loadMainnetConfig();
  const key = required("RELAY_PRIVATE_KEY", "NEAR_PRIVATE_KEY");
  if (!key.startsWith("ed25519:"))
    throw new Error("RELAY_PRIVATE_KEY must be an ed25519 key");
  return {
    rpcUrl: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com",
    broadcastRpcUrl: process.env.PROVEN_BROADCAST_RPC_URL,
    relayAccountId: required("RELAY_ACCOUNT_ID", "NEAR_ACCOUNT_ID"),
    relayPrivateKey: key as KeyPairString,
    escrowContract: process.env.ESCROW_CONTRACT || "escrow-v5.proven.testnet",
    outlayerContract: process.env.OUTLAYER_CONTRACT || "outlayer.testnet",
    outlayerApi: process.env.OUTLAYER_API || "https://testnet-api.outlayer.ai",
  };
}
