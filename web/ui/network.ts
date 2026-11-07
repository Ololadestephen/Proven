// Which network this site serves, from the server. Everything that names a network reads it here.
const config = (await fetch("/api/market/config")
  .then((reply) => reply.json())
  .catch(() => ({ network: "testnet", open: true }))) as {
  network?: string;
  open?: boolean;
  buyers?: string[];
};

export const NETWORK: "mainnet" | "testnet" =
  config.network === "mainnet" ? "mainnet" : "testnet";
export const IS_MAINNET = NETWORK === "mainnet";
/** Off for everyone except listed buyers until the owner opens the market. */
export const MARKET_OPEN = config.open !== false;
export const canPost = (account: string | undefined) =>
  MARKET_OPEN || (!!account && (config.buyers ?? []).includes(account));
/** Shown wherever the network is named. Mainnet is never shown without its caps. */
export const NETWORK_LABEL = IS_MAINNET
  ? "Mainnet · unaudited · at most 0.1 NEAR per job, 0.2 per buyer, 1 held in total"
  : "Testnet";
export const COIN = IS_MAINNET ? "NEAR" : "testnet NEAR";
export const OUTLAYER_API = IS_MAINNET
  ? "https://api.outlayer.ai"
  : "https://testnet-api.outlayer.ai";
