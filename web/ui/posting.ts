import {
  matchesPostedBid,
  postedBidId,
  postedBidFromOutcome,
} from "../../shared/post-result.ts";
import type { MarketBid } from "./market-steps.ts";
import type { WalletCallResult } from "./market-types.ts";

export { postedBidId };

export interface PostingTerms {
  buyer: string;
  check_hash: string;
  reference_hash: string;
  verifier_hash: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Wallets may return a full outcome, a hash wrapper, a hash, or nothing after a redirect. */
export function postingReceipt(
  outcome: unknown,
  board: string,
  buyer: string,
): WalletCallResult {
  const value = record(outcome) ? outcome : {};
  const transaction = record(value.transaction) ? value.transaction : {};
  const hash = [
    typeof outcome === "string" ? outcome : null,
    transaction.hash,
    value.transaction_hash,
    value.transactionHash,
    value.hash,
  ].find(
    (candidate) =>
      typeof candidate === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate),
  );
  const id = postedBidFromOutcome(outcome, board, buyer);
  return {
    transaction_hash: typeof hash === "string" ? hash : "",
    ...(id === null ? {} : { posted_bid_id: id }),
  };
}

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

/** used_checks makes a check unique on this board; still require the signer and every commitment. */
export async function resolvePostedBid(options: {
  bids: MarketBid[];
  receipt: WalletCallResult | void;
  expected: PostingTerms;
  board: string;
  readOutcome: (hash: string, buyer: string) => Promise<unknown>;
}): Promise<MarketBid | null> {
  const { bids, receipt, expected, board, readOutcome } = options;
  const direct = confirmedPostedBid(bids, receipt, expected);
  if (direct) return direct;
  const hash = receipt?.transaction_hash;
  if (typeof hash === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) {
    try {
      const outcome = await readOutcome(hash, expected.buyer);
      if (
        record(outcome) &&
        record(outcome.transaction) &&
        outcome.transaction.hash === hash
      ) {
        const id = postedBidFromOutcome(outcome, board, expected.buyer);
        const found = confirmedPostedBid(
          bids,
          { transaction_hash: hash, posted_bid_id: id ?? undefined },
          expected,
        );
        if (found) return found;
      }
    } catch {
      // A read failure never authorizes another posting. The board commitments can still identify it.
    }
  }
  const matches = bids.filter((bid) => matchesPostedBid(bid, expected));
  return matches.length === 1 ? matches[0]! : null;
}

/** One automatic handoff and one review per mounted posting, including overlapping recovery reads. */
export function startPostingFollowup(
  started: { current: boolean },
  bid: MarketBid | null,
  sendCheck: (jobId: number) => Promise<void>,
  review: (bidId: number) => Promise<void>,
): { check: Promise<void>; review: Promise<void> } | null {
  if (started.current || !bid || bid.job_id == null) return null;
  started.current = true;
  return {
    check: Promise.resolve().then(() => sendCheck(bid.job_id!)),
    review: Promise.resolve().then(() => review(bid.id)),
  };
}
