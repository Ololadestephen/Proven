// Settings, read from the environment (`.env` at the repository root).
// Keys are only ever handed to the signer; they are never printed or logged.

import type { KeyPairString } from "near-api-js";

export interface Config {
  rpcUrl: string;
  relayAccountId: string;
  relayPrivateKey: KeyPairString;
  escrowContract: string;
  outlayerContract: string;
  outlayerApi: string;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] || (fallback ? process.env[fallback] : undefined);
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export function loadConfig(): Config {
  const key = required("RELAY_PRIVATE_KEY", "NEAR_PRIVATE_KEY");
  if (!key.startsWith("ed25519:")) throw new Error("RELAY_PRIVATE_KEY must be an ed25519 key");
  return {
    rpcUrl: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org",
    relayAccountId: required("RELAY_ACCOUNT_ID", "NEAR_ACCOUNT_ID"),
    relayPrivateKey: key as KeyPairString,
    escrowContract: process.env.ESCROW_CONTRACT || "escrow-v2.proven.testnet",
    outlayerContract: process.env.OUTLAYER_CONTRACT || "outlayer.testnet",
    outlayerApi: process.env.OUTLAYER_API || "https://testnet-api.outlayer.ai",
  };
}
