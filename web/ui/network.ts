// Which network this site serves, from the server. Everything that names a network reads it here.
const config = (await fetch("/api/market/config")
  .then((reply) => reply.json())
  .catch(() => ({ network: "testnet", open: true }))) as {
  network?: string;
  open?: boolean;
  buyers?: string[];
  caps?: {
    max_job: string;
    max_held: string;
    max_held_per_buyer: string;
  } | null;
};

export const NETWORK: "mainnet" | "testnet" =
  config.network === "mainnet" ? "mainnet" : "testnet";
export const IS_MAINNET = NETWORK === "mainnet";
/** Off for everyone except listed buyers until the owner opens the market. */
export const MARKET_OPEN = config.open !== false;
export const canPost = (account: string | undefined) =>
  MARKET_OPEN || (!!account && (config.buyers ?? []).includes(account));
const inNear = (yocto: string) => Number(BigInt(yocto) / 10n ** 18n) / 1e6;
/** The most one job can pay, as the escrow enforces it. Unknown means the page cannot check it. */
export const MAX_JOB: bigint | null = config.caps
  ? BigInt(config.caps.max_job)
  : null;
/** Shown wherever the network is named. Mainnet is shown with its limits, read from the escrow. */
export const NETWORK_LABEL = IS_MAINNET
  ? config.caps
    ? `Mainnet · unaudited · at most ${inNear(config.caps.max_job)} NEAR per job, ${inNear(config.caps.max_held_per_buyer)} per buyer, ${inNear(config.caps.max_held)} held in total`
    : "Mainnet · unaudited"
  : "Testnet";
export const COIN = IS_MAINNET ? "NEAR" : "testnet NEAR";
export const OUTLAYER_API = IS_MAINNET
  ? "https://api.outlayer.ai"
  : "https://testnet-api.outlayer.ai";
