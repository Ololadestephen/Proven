// Every chain call in the agent tools, with the same rate-limit fallback the relay uses.
import { FallbackRpcProvider } from "../../relay/src/rpc.ts";

const MAINNET = [
  "https://rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
];
const TESTNET = [
  "https://test.rpc.fastnear.com",
  "https://near-testnet.drpc.org",
  "https://testnet-rpc.intea.rs",
];

export function chainProvider(rpc: string): FallbackRpcProvider {
  const others = (rpc.includes("mainnet") ? MAINNET : TESTNET).filter(
    (url) => url !== rpc,
  );
  return new FallbackRpcProvider([rpc, ...others]);
}
