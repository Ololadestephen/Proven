import type { MarketBid } from "./market-steps.ts";
export const TGAS = 1_000_000_000_000n;
export const NEAR = 10n ** 24n;
export interface Market {
  board: string;
  escrow: string;
  network?: string;
  buyer_records?: Record<
    string,
    { paid: number; refunded: number; expired: number }
  >;
  verifier_hash: string;
  paused: boolean;
  agents: string[];
  bids: MarketBid[];
}
export interface Call {
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  deposit: bigint;
  gas: bigint;
}
export interface Wallet {
  accountId: string;
  label: string;
  call(call: Call): Promise<void>;
  /** Sends NEAR, and returns the transaction's hash. */
  transfer(receiver: string, yocto: bigint): Promise<string>;
  signForRelay(message: string): Promise<{
    public_key: string;
    signature_base64: string;
    nonce_base64: string;
  }>;
  signOut(): Promise<void>;
}

export type Run = (label: string, task: () => Promise<void>) => Promise<void>;
