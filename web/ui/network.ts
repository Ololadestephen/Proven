// Which network this site serves, from the server. Everything that names a network reads it here.
const config = (await fetch("/api/market/config")
  .then((reply) => reply.json())
  .catch(() => ({ network: "testnet" }))) as { network?: string };

export const NETWORK: "mainnet" | "testnet" =
  config.network === "mainnet" ? "mainnet" : "testnet";
export const IS_MAINNET = NETWORK === "mainnet";
/** Shown wherever the network is named. Mainnet is never shown without its caps. */
export const NETWORK_LABEL = IS_MAINNET
  ? "Mainnet · unaudited · at most 0.1 NEAR per job, 0.2 per buyer, 1 held in total"
  : "Testnet";
export const COIN = IS_MAINNET ? "NEAR" : "testnet NEAR";
export const OUTLAYER_API = IS_MAINNET
  ? "https://api.outlayer.ai"
  : "https://testnet-api.outlayer.ai";
