// Which network this site serves, from the server. Everything that names a network reads it here.
import { marketStatusLines, parseMarketSettings } from "./network-status.ts";

const config = await fetch("/api/market/config")
  .then(async (reply) =>
    reply.ok ? parseMarketSettings(await reply.json()) : null,
  )
  .catch(() => null);

export const NETWORK: "mainnet" | "testnet" = config?.network ?? "testnet";
export const IS_MAINNET = NETWORK === "mainnet";
/** Unknown access never lets a buyer post before its board permissions are read. */
export const MARKET_OPEN = config?.open === true;
export const canPost = (account: string | undefined) =>
  MARKET_OPEN || (!!account && (config?.buyers ?? []).includes(account));
/** The most one job can pay, as the escrow enforces it. Unknown means the page cannot check it. */
export const MAX_JOB: bigint | null = config?.caps
  ? BigInt(config.caps.max_job)
  : null;
/** The sidebar's status lines. Mainnet always names the owner's single upgrade key; limits come
 * only from the escrow. */
export const NETWORK_LINES = marketStatusLines(config);
export const COIN = IS_MAINNET ? "NEAR" : "testnet NEAR";
export const OUTLAYER_API = IS_MAINNET
  ? "https://api.outlayer.ai"
  : "https://testnet-api.outlayer.ai";
