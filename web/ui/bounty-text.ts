// Text helpers shared by the PR bounty components.
import { NEAR } from "./market-types.ts";
import { COIN, OUTLAYER_API } from "./network.ts";

/** An amount of NEAR with up to six decimals, and the network's coin name. */
export function near(yocto: string | bigint): string {
  const value = BigInt(yocto);
  const fraction = (value % NEAR)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${value / NEAR}${fraction ? `.${fraction.slice(0, 6)}` : ""} ${COIN}`;
}

export const attestationUrl = (requestId: string) =>
  `${OUTLAYER_API}/attestations/by-request/${requestId}`;
