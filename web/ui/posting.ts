import { matchesPostedBid, postedBidId } from "../../shared/post-result.ts";
import type { MarketBid } from "./market-steps.ts";
import type { WalletCallResult } from "./market-types.ts";

export { postedBidId };

/** Malformed return bytes leave posting unresolved; they never select a bid by its content. */
export function decodeCallResult(base64: unknown): unknown {
  if (typeof base64 !== "string") return null;
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
      ),
    );
  } catch {
    return null;
  }
}

export function confirmedPostedBid(
  bids: MarketBid[],
  receipt: WalletCallResult | void,
  expected: {
    buyer: string;
    check_hash: string;
    reference_hash: string;
    verifier_hash: string;
  },
): MarketBid | null {
  const id = postedBidId(receipt?.posted_bid_id);
  if (id === null) return null;
  const bid = bids.find((item) => item.id === id);
  return bid && matchesPostedBid(bid, expected) ? bid : null;
}
