// Reads and calls on the bid board. Every write here is signed through a custody wallet whose policy
// allows only the escrow and the board. The board holds no job money and cannot record a verdict.
import { chainProvider } from "./rpc.ts";
import { JsonRpcProvider } from "near-api-js";
import { BOARD, custodyCall } from "./custody.ts";
import { PublicError } from "./errors.ts";
import { waitTransactionResult } from "./near.ts";
import type { CallResult } from "./types.ts";

const NEAR = 10n ** 24n;
export const CLAIM_DEPOSIT = (NEAR / 1000n) * 5n;
export const REGISTER_DEPOSIT = (NEAR / 1000n) * 20n;
/** The attempt fee plus its record, prepaid at posting for each attempt. Unused fees come back. */
export const FEE_PER_ATTEMPT = (NEAR / 1000n) * 17n;
const POST_RESERVE = NEAR / 100n;
/** Storage for the bid and the escrow job at their largest. The unused part comes back. */
const STORAGE_MARGIN = (NEAR / 100n) * 7n;
const READ_GAS = "200000000000000";
const POST_GAS = "150000000000000";
const CLAIM_GAS = "100000000000000";
const SHORT_GAS = "30000000000000";

/** Everything one posting attaches: the payment, the escrow's compute budget, the attempt fees and
 * storage. The escrow and board return what they do not use. */
export function postingDeposit(
  amount: bigint,
  attempts: number,
  runDeposit: bigint,
): bigint {
  return (
    amount +
    runDeposit * BigInt(2 + 2 * attempts) +
    FEE_PER_ATTEMPT * BigInt(attempts) +
    POST_RESERVE +
    STORAGE_MARGIN
  );
}

export interface Claim {
  number: number;
  agent: string;
  claimed_at: string;
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
  deliver_secs: number;
  max_attempts: number;
  /** The escrow job holding this bid's money. Null only while it is being created. */
  job_id: number | null;
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
  /** One per prepaid attempt: Held, Paying, PaidToWorker or ReturnedToBuyer. */
  fees: string[];
}
export interface Agent {
  wallet: string;
  prompt_hash: string;
  knowledge_hash: string;
  tools_hash: string;
  owner?: string | null;
  model: string;
}
export interface Wallet {
  hosted?: { owner: string; treasury: string };
  api: string;
  key: string;
  account: string;
  escrow: string;
}

export class BoardClient {
  private readonly provider: JsonRpcProvider;
  constructor(rpc: string) {
    this.provider = chainProvider(rpc);
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
      deliver_secs: number;
      max_attempts: number;
      allowed_workers?: string[] | null;
    },
    deposit: bigint,
  ) {
    return this.write(wallet, "post_bid", args, deposit, POST_GAS);
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
      CLAIM_GAS,
    );
  }
  sync(wallet: Wallet, bidId: number) {
    return this.write(wallet, "sync", { bid_id: bidId }, 0n, READ_GAS);
  }
  close(wallet: Wallet, bidId: number) {
    return this.write(wallet, "close_bid", { bid_id: bidId }, 0n, POST_GAS);
  }
}

export interface BuyerRecord {
  buyer: string;
  bids: number;
  jobs_paid: number;
  jobs_refunded: number;
  jobs_expired: number;
  /** Paid out of paid, refunded and expired together, or null with no finished jobs yet. */
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
      if (bid.job_id === null) continue;
      const job = await board.view<{
        history?: Array<{ outcome: string }>;
      } | null>("get_job", { job_id: bid.job_id }, escrow);
      // Counted per attempt, from the escrow's own records.
      for (const attempt of job?.history ?? []) {
        if (attempt.outcome === "Paid") record.jobs_paid += 1;
        if (attempt.outcome === "Failed") record.jobs_refunded += 1;
        if (attempt.outcome === "NoDelivery" || attempt.outcome === "NoVerdict")
          record.jobs_expired += 1;
      }
    }
    if (page.length < 50) break;
  }
  const finished =
    record.jobs_paid + record.jobs_refunded + record.jobs_expired;
  return {
    buyer,
    ...record,
    paid_share: finished ? record.jobs_paid / finished : null,
    note: "Read from the chain. A buyer paying its own second account can inflate this.",
  };
}
