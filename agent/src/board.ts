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
export const POST_DEPOSIT = (NEAR / 1000n) * 60n;
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
  claim_window_secs: number;
  state: string;
  review: { allow: boolean; review_hash: string; model: string; chat_id: string } | null;
  claim: Claim | null;
  claims_made: number;
  funded_attempts: number;
  past_jobs: Array<{ agent: string; job_id: number; funded: boolean; bid_state_after: string }>;
}
export interface Agent {
  wallet: string;
  prompt_hash: string;
  knowledge_hash: string;
  tools_hash: string;
  model: string;
}
export interface Wallet {
  api: string;
  key: string;
  account: string;
  escrow: string;
}

/** Link before fund: the buyer funds only a claim that is still active and linked to this job. */
export function fundRefusal(bid: Bid, jobId: number, now: bigint): string | null {
  if (bid.state !== "Claimed" || !bid.claim) return "the bid has no active claim";
  if (bid.claim.job_id !== jobId) return "the claim is not linked to this job";
  if (now + FUND_MARGIN_NANOS >= BigInt(bid.claim.expires_at)) return "the claim window is about to end";
  return null;
}

export class BoardClient {
  private readonly provider: JsonRpcProvider;
  constructor(rpc: string) {
    this.provider = new JsonRpcProvider({ url: rpc });
  }

  async view<T>(method: string, args: Record<string, unknown>, contractId = BOARD): Promise<T> {
    return (await this.provider.callFunction({ contractId, method, args })) as T;
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

  private async write(wallet: Wallet, method_name: string, args: Record<string, unknown>, deposit: bigint, gas: string): Promise<CallResult> {
    const tx = await custodyCall(wallet.api, wallet.key, wallet.account, wallet.escrow, {
      receiver_id: BOARD,
      method_name,
      args,
      deposit: deposit.toString(),
      gas,
    });
    const result = await waitTransactionResult(this.provider, tx, wallet.account);
    if (result.failed) throw new PublicError(`Board call ${method_name} failed on chain: ${tx}`);
    if (result.pending) throw new PublicError(`Board call ${method_name} has an unknown outcome: ${tx}. Read the bid before doing anything else.`);
    return result;
  }

  postBid(wallet: Wallet, args: { description: string; amount: string; check_hash: string; reference_hash: string; verifier_hash: string; claim_window_secs: number }) {
    return this.write(wallet, "post_bid", args, POST_DEPOSIT, SHORT_GAS);
  }
  register(wallet: Wallet, args: Omit<Agent, "wallet">) {
    return this.write(wallet, "register_agent", args, REGISTER_DEPOSIT, SHORT_GAS);
  }
  claim(wallet: Wallet, bidId: number) {
    return this.write(wallet, "claim", { bid_id: bidId }, CLAIM_DEPOSIT, SHORT_GAS);
  }
  link(wallet: Wallet, bidId: number, jobId: number) {
    return this.write(wallet, "link_job", { bid_id: bidId, job_id: jobId }, 0n, READ_GAS);
  }
  sync(wallet: Wallet, bidId: number) {
    return this.write(wallet, "sync", { bid_id: bidId }, 0n, READ_GAS);
  }
  close(wallet: Wallet, bidId: number) {
    return this.write(wallet, "close_bid", { bid_id: bidId }, 0n, READ_GAS);
  }
}
