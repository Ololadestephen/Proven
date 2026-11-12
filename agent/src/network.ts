// What differs between networks. Mainnet is refused unless the operator states the Stage 2 approval,
// and it has no default escrow: its accounts must be named on purpose.
import { PublicError } from "./errors.ts";

export type Network = "testnet" | "mainnet";
const NETWORKS = {
  testnet: {
    suffix: ".testnet",
    rpcs: [
      "https://test.rpc.fastnear.com",
      "https://near-testnet.drpc.org",
      "https://testnet-rpc.intea.rs",
      "https://rpc.testnet.near.org",
      "https://archival-rpc.testnet.near.org",
    ],
    custodyApi: "https://testnet-api.outlayer.ai",
  },
  mainnet: {
    suffix: ".near",
    rpcs: [
      "https://free.rpc.fastnear.com",
      "https://rpc.mainnet.fastnear.com",
      "https://rpc.mainnet.near.org",
    ],
    custodyApi: "https://api.outlayer.ai",
  },
} as const;

export function networkSettings(
  name: string | undefined,
  stage2Approved: string | undefined,
) {
  const network = name ?? "testnet";
  if (network !== "testnet" && network !== "mainnet")
    throw new PublicError("Unknown network.");
  if (network === "mainnet" && stage2Approved !== "yes")
    throw new PublicError(
      "Mainnet is refused without the Stage 2 approval flag.",
    );
  return { network: network as Network, ...NETWORKS[network] };
}

/** The escrow's own account decides the network, so a link can never point at the wrong one. */
export const attestationUrl = (request: string, escrow: string) =>
  `${escrow.endsWith(".near") ? NETWORKS.mainnet.custodyApi : NETWORKS.testnet.custodyApi}/attestations/by-request/${request}`;
