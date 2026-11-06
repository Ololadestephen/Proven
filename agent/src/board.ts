// Reads and calls on the bid board. Every write here is signed through a custody wallet whose policy
// allows only the escrow and the board. The board holds no job money and cannot record a verdict.
import { JsonRpcProvider } from "near-api-js";
import { BOARD, custodyCall } from "./custody.ts";
import { PublicError } from "./errors.ts";
import { waitTransactionResult } from "./near.ts";
import type { CallResult } from "./types.ts";

const NEAR = 10n ** 24n;
export const CLAIM_DEPOSIT = (NEAR / 1000n) * 5n;
export const REGISTER_DEPOSIT = (NEAR / 1000n) * 20n;
export const POST_DEPOSIT = (NEAR / 1000n) * 80n;
/** The attempt fee plus its record. A pass, no delivery or no verdict returns the fee, not the record. */
export const LINK_DEPOSIT = (NEAR / 1000n) * 17n;
const READ_GAS = "90000000000000";
const SHORT_GAS = "30000000000000";
/** The buyer does not fund a claim with less than this left: the fund call has to land first. */
export const FUND_MARGIN_NANOS = 60_000_000_000n;

export interface Claim {
  number: number;
  agent: string;
  claimed_at: string;
  expires_at: string;
  job_id: number | null;
}
export interface Bid {
  buyer: string;
  description: string;
  amount: string;
  check_hash: string;
  reference_hash: string;
  verifier_hash: string;
  format: string;
  format_hash: string;
  expires_at: string;
  claim_window_secs: number;
  state: string;
  review: {
    allow: boolean;
    review_hash: string;
    model: string;
    chat_id: string;
  } | null;
  claim: Claim | null;
  claims_made: number;
  funded_attempts: number;
  allowed_workers: string[] | null;
  past_jobs: Array<{
    agent: string;
    job_id: number;
    funded: boolean;
    bid_state_after: string;
  }>;
}
export interface Agent {
  wallet: string;
  prompt_hash: string;
  knowledge_hash: string;
  tools_hash: string;
  owner?: string | null;
  model: string;
}
export interface AttemptFee {
  bid_id: number;
  buyer: string;
  worker: string;
  amount: string;
  state: "Held" | "Paying" | "PaidToWorker" | "ReturnedToBuyer";
}

export interface Wallet {
  hosted?: { owner: string; treasury: string };
  api: string;
  key: string;
  account: string;
  escrow: string;
}

/** Link before fund: the buyer funds only a claim that is still active and linked to this job. */
export function fundRefusal(
  bid: Bid,
  jobId: number,
  now: bigint,
): string | null {
  if (bid.state !== "Claimed" || !bid.claim)
    return "the bid has no active claim";
  if (bid.claim.job_id !== jobId) return "the claim is not linked to this job";
  if (now >= BigInt(bid.expires_at)) return "the bid has expired";
  if (now + FUND_MARGIN_NANOS >= BigInt(bid.claim.expires_at))
    return "the claim window is about to end";
  return null;
}

export class BoardClient {
  private readonly provider: JsonRpcProvider;
  constructor(rpc: string) {
    this.provider = new JsonRpcProvider({ url: rpc });
  }

  async view<T>(
    method: string,
    args: Record<string, unknown>,
    contractId = BOARD,
  ): Promise<T> {
    return (await this.provider.callFunction({
      contractId,
      method,
      args,
    })) as T;
  }
  bid(bidId: number): Promise<Bid | null> {
    return this.view("get_bid", { bid_id: bidId });
  }
  bids(fromId: number, limit: number): Promise<Array<[number, Bid]>> {
    return this.view("get_bids", { from_id: fromId, limit });
  }
  agent(wallet: string): Promise<Agent | null> {
    return this.view("get_agent", { wallet });
  }
  agents(fromIndex: number, limit: number): Promise<Agent[]> {
    return this.view("get_agents", { from_index: fromIndex, limit });
  }
  async now(): Promise<bigint> {
    const block = await this.provider.viewBlock({ finality: "final" });
    return BigInt(block.header.timestamp_nanosec);
  }

  private async write(
    wallet: Wallet,
    method_name: string,
    args: Record<string, unknown>,
    deposit: bigint,
    gas: string,
  ): Promise<CallResult> {
    const tx = await custodyCall(
      wallet.api,
      wallet.key,
      wallet.account,
      wallet.escrow,
      {
        receiver_id: BOARD,
        method_name,
        args,
        deposit: deposit.toString(),
        gas,
      },
      wallet.hosted,
    );
    const result = await waitTransactionResult(
      this.provider,
      tx,
      wallet.account,
    );
    if (result.failed)
      throw new PublicError(`Board call ${method_name} failed on chain: ${tx}`);
    if (result.pending)
      throw new PublicError(
        `Board call ${method_name} has an unknown outcome: ${tx}. Read the bid before doing anything else.`,
      );
    return result;
  }

  postBid(
    wallet: Wallet,
    args: {
      description: string;
      amount: string;
      check_hash: string;
      reference_hash: string;
      verifier_hash: string;
      format: string;
      expires_at: string;
      reveal_agreed: boolean;
      claim_window_secs: number;
      allowed_workers?: string[] | null;
    },
  ) {
    return this.write(wallet, "post_bid", args, POST_DEPOSIT, SHORT_GAS);
  }
  register(wallet: Wallet, args: Omit<Agent, "wallet">) {
    return this.write(
      wallet,
      "register_agent",
      args,
      REGISTER_DEPOSIT,
      SHORT_GAS,
    );
  }
  claim(wallet: Wallet, bidId: number) {
    return this.write(
      wallet,
      "claim",
      { bid_id: bidId },
      CLAIM_DEPOSIT,
      SHORT_GAS,
    );
  }
  link(wallet: Wallet, bidId: number, jobId: number) {
    return this.write(
      wallet,
      "link_job",
      { bid_id: bidId, job_id: jobId },
      LINK_DEPOSIT,
      READ_GAS,
    );
  }
  settleFee(wallet: Wallet, jobId: number) {
    return this.write(wallet, "settle_fee", { job_id: jobId }, 0n, READ_GAS);
  }
  fee(jobId: number): Promise<AttemptFee | null> {
    return this.view("get_fee", { job_id: jobId });
  }
  sync(wallet: Wallet, bidId: number) {
    return this.write(wallet, "sync", { bid_id: bidId }, 0n, READ_GAS);
  }
  close(wallet: Wallet, bidId: number) {
    return this.write(wallet, "close_bid", { bid_id: bidId }, 0n, READ_GAS);
  }
}

export interface BuyerRecord {
  buyer: string;
  bids: number;
  jobs_paid: number;
  jobs_refunded: number;
  jobs_expired: number;
  /** Paid out of paid and refunded together, or null with no finished jobs yet. */
  paid_share: number | null;
  note: string;
}

/** A buyer's record, read from the chain. Every bid and past job is read, so nothing here is self-reported. */
export async function buyerRecord(
  board: BoardClient,
  escrow: string,
  buyer: string,
): Promise<BuyerRecord> {
  const record = { jobs_paid: 0, jobs_refunded: 0, jobs_expired: 0, bids: 0 };
  for (let from = 0; ; from += 50) {
    const page = await board.bids(from, 50);
    for (const [, bid] of page) {
      if (bid.buyer !== buyer) continue;
      record.bids += 1;
      const ids = new Set(bid.past_jobs.map((past) => past.job_id));
      if (bid.claim?.job_id != null) ids.add(bid.claim.job_id);
      for (const jobId of ids) {
        const job = await board.view<{ state: string } | null>(
          "get_job",
          { job_id: jobId },
          escrow,
        );
        if (job?.state === "Released") record.jobs_paid += 1;
        if (job?.state === "Refunded") record.jobs_refunded += 1;
        if (job?.state === "Expired") record.jobs_expired += 1;
      }
    }
    if (page.length < 50) break;
  }
  const finished = record.jobs_paid + record.jobs_refunded;
  return {
    buyer,
    ...record,
    paid_share: finished ? record.jobs_paid / finished : null,
    note: "Read from the chain. A buyer paying its own second account can inflate this.",
  };
}
