import { postedBidId, matchesPostedBid } from "../../shared/post-result.ts";
// CLI and MCP tools for the bid board. Writes go through the configured custody wallet; board calls
// hold no job money. The JSON feed is read-only and needs no credentials.
import { createHash } from "node:crypto";
import {
  BoardClient,
  buyerRecord,
  postingDeposit,
  type Wallet,
} from "./board.ts";
import { handoff, handoffOverWeb } from "./handoff.ts";
import type { Config } from "./config.ts";
import { BOARD } from "./custody.ts";
import { PublicError } from "./errors.ts";
import { buildFeed } from "./feed.ts";
import {
  accountId,
  checkPostingCaps,
  fields,
  flag,
  integer,
  object,
  text,
  yocto,
  type Args,
} from "./validation.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const string = { type: "string" };
const id = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const page = {
  from_id: id,
  limit: { type: "integer", minimum: 1, maximum: 50 },
};

const definitions: Array<[string, string, Record<string, unknown>, string[]]> =
  [
    [
      "list_bids",
      "Read a page of bids on the board. No signing key is needed.",
      page,
      [],
    ],
    [
      "bid_status",
      "Read one bid, with its claim, review record and past jobs.",
      { bid_id: id },
      ["bid_id"],
    ],
    [
      "list_agents",
      "Read registered agents. Their hashes record a commitment, not proof of what ran.",
      page,
      [],
    ],
    [
      "swarm_feed",
      "Read the whole board as one JSON document with job states and attestation links.",
      {},
      [],
    ],
    [
      "post_bid",
      "Post checkable work and pay for it once: the payment, a compute budget, the attempt fees and storage, with what is unused returned. Fixes the check, reference and verifier hashes, then sends the check to be tested and starts the review, neither needing a signature. Nothing can claim the bid until the review allows it and the check has passed its test. Custody wallet only.",
      {
        description: string,
        check: string,
        reference: string,
        amount_near: string,
        deliver_hours: { type: "integer", minimum: 1, maximum: 24 },
        max_attempts: { type: "integer", minimum: 1, maximum: 3 },
        expires_in_hours: { type: "integer", minimum: 1, maximum: 168 },
        reveal_agreed: {
          type: "boolean",
          description:
            "Must be true: you agree the relay publishes the check when the bid closes.",
        },
        allowed_workers: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
        },
      },
      ["description", "check", "reference", "amount_near", "reveal_agreed"],
    ],
    [
      "register_agent",
      "Register this custody wallet as an agent. Its hashes never change: a new prompt needs a new wallet.",
      { prompt: string, knowledge: string, tools: string, model: string },
      ["prompt", "tools", "model"],
    ],
    [
      "claim_bid",
      "Apply for an open bid with this agent's wallet. The money is already held, so once the claim is confirmed the job is yours and you can start.",
      { bid_id: id },
      ["bid_id"],
    ],
    [
      "sync_bid",
      "Bring a bid in line with its escrow job: end a finished attempt and settle attempt fees by their recorded outcomes. Anyone can call it.",
      { bid_id: id },
      ["bid_id"],
    ],
    [
      "buyer_record",
      "Read a buyer's record from the chain: jobs paid, refunded and expired. Self-dealing can inflate it. No signing key is needed.",
      { buyer: string },
      ["buyer"],
    ],
    [
      "close_bid",
      "Take down your own bid while no worker is on it. The escrow refunds the payment and what is left of the compute budget; a sync then returns the unused fees.",
      { bid_id: id },
      ["bid_id"],
    ],
  ];

/** Exact decimal NEAR for a yocto amount, for the job tool's `amount_near`. */
export function nearText(yoctoAmount: string): string {
  const padded = yoctoAmount.padStart(25, "0");
  const fraction = padded.slice(-24).replace(/0+$/, "");
  return fraction
    ? `${padded.slice(0, -24)}.${fraction}`
    : padded.slice(0, -24);
}

export const boardTools = definitions.map(
  ([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { ...properties, dry_run: { type: "boolean" } },
      required,
      additionalProperties: false,
    } as Record<string, unknown>,
  }),
);
export const isBoardTool = (name: string) =>
  definitions.some(([key]) => key === name);

function wallet(config: Config): Wallet {
  if (!config.custodyKey || !config.account)
    throw new PublicError(
      "This board call needs a custody wallet. Scoped worker keys cannot attach deposits.",
    );
  return {
    api: config.custodyApi,
    key: config.custodyKey,
    account: config.account,
    escrow: config.escrow,
  };
}

export async function executeBoardTool(
  name: string,
  input: unknown,
  config: Config,
  forceDry = false,
): Promise<unknown> {
  const definition = definitions.find(([key]) => key === name);
  if (!definition) throw new PublicError("Unknown tool.");
  const args: Args = object(input);
  fields(args, [...Object.keys(definition[2]), "dry_run"]);
  const dry = flag(args, "dry_run") || forceDry;
  const board = new BoardClient(config.rpc);
  const bidId = () => integer(args, "bid_id", 0, Number.MAX_SAFE_INTEGER);

  if (name === "list_bids")
    return board.bids(
      integer(args, "from_id", 0, Number.MAX_SAFE_INTEGER, 0),
      integer(args, "limit", 1, 50, 20),
    );
  if (name === "list_agents")
    return board.agents(
      integer(args, "from_id", 0, 4_294_967_295, 0),
      integer(args, "limit", 1, 50, 20),
    );
  if (name === "swarm_feed") return buildFeed(board, config.escrow);
  if (name === "buyer_record")
    return buyerRecord(board, config.escrow, accountId(text(args, "buyer")));
  if (name === "bid_status") {
    const bid = await board.bid(bidId());
    if (!bid) throw new PublicError("Bid was not found.");
    return bid;
  }
  const planned = (method_name: string, call: Record<string, unknown>) => ({
    dry_run: true,
    call: { receiver_id: BOARD, method_name, args: call },
  });

  if (name === "post_bid") {
    const check = text(args, "check");
    const reference = text(args, "reference");
    let verifier: unknown;
    try {
      verifier = (object(JSON.parse(check)) as { verifier?: unknown }).verifier;
    } catch {
      throw new PublicError(
        "Check must be a JSON object naming its verifier hash.",
      );
    }
    if (typeof verifier !== "string")
      throw new PublicError("Check must name its verifier hash.");
    const format = (JSON.parse(check) as { format?: unknown }).format;
    if (typeof format !== "string")
      throw new PublicError("Check must carry its public format as text.");
    if (args.reveal_agreed !== true)
      throw new PublicError(
        "A bid needs reveal_agreed: the relay publishes the check when the bid closes.",
      );
    const hours = BigInt(integer(args, "expires_in_hours", 1, 168, 72));
    const call = {
      description: text(args, "description", 2048),
      amount: yocto(text(args, "amount_near", 30)),
      check_hash: hash(check),
      reference_hash: hash(reference),
      verifier_hash: verifier,
      format,
      expires_at: ((await board.now()) + hours * 3_600_000_000_000n).toString(),
      reveal_agreed: true,
      deliver_secs: integer(args, "deliver_hours", 1, 24, 4) * 3_600,
      max_attempts: integer(args, "max_attempts", 1, 3, 3),
      allowed_workers: Array.isArray(args.allowed_workers)
        ? args.allowed_workers.map((worker) => accountId(String(worker)))
        : null,
    };
    if (dry) return planned("post_bid", call);
    const escrowConfig = await board.view<{ run_deposit: string }>(
      "get_config",
      {},
      config.escrow,
    );
    checkPostingCaps(escrowConfig, call.amount);
    const deposit = postingDeposit(
      BigInt(call.amount),
      call.max_attempts,
      BigInt(escrowConfig.run_deposit),
    );
    const buyerWallet = wallet(config);
    const posted = await board.postBid(buyerWallet, call, deposit);
    const bidId = postedBidId(posted.posted_bid_id);
    const reconcile =
      "Posting has completed. Reconcile this transaction and its exact bid before any further action; do not post again.";
    if (bidId === null) return { ...posted, note: reconcile };
    let bid;
    try {
      bid = await board.bid(bidId);
    } catch {
      return { ...posted, bid_id: bidId, note: reconcile };
    }
    if (
      !matchesPostedBid(bid, {
        buyer: buyerWallet.account,
        check_hash: call.check_hash,
        reference_hash: call.reference_hash,
        verifier_hash: call.verifier_hash,
      })
    )
      return { ...posted, bid_id: bidId, note: reconcile };
    const jobId = bid?.job_id ?? null;
    if (jobId === null)
      return {
        ...posted,
        bid_id: bidId,
        job_id: null,
        note: "Posted. Wait for this bid's job creation; do not post again.",
      };
    // No signature: the texts match the hashes just fixed on chain.
    const challenge = { action: "challenge", job_id: jobId, check, reference };
    const sent = await (
      config.relayUrl
        ? handoffOverWeb(config.relayUrl, challenge)
        : handoff(config.socket, challenge)
    ).then(
      () => true,
      () => false,
    );
    const reviewed = config.relayUrl
      ? await fetch(
          `${config.relayUrl.replace(/\/$/, "")}/api/market/review/${bidId}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(320_000),
          },
        ).then(
          (reply) => reply.ok,
          () => false,
        )
      : false;
    return {
      ...posted,
      bid_id: bidId,
      job_id: jobId,
      check_sent: sent,
      review_started: reviewed,
    };
  }
  if (name === "register_agent") {
    const call = {
      prompt_hash: hash(text(args, "prompt")),
      knowledge_hash: hash(
        typeof args.knowledge === "string" ? args.knowledge : "",
      ),
      tools_hash: hash(text(args, "tools")),
      model: text(args, "model", 128),
      owner: null,
    };
    return dry
      ? planned("register_agent", call)
      : board.register(wallet(config), call);
  }
  if (name === "claim_bid")
    return dry
      ? planned("claim", { bid_id: bidId() })
      : board.claim(wallet(config), bidId());
  if (name === "sync_bid")
    return dry
      ? planned("sync", { bid_id: bidId() })
      : board.sync(wallet(config), bidId());
  if (name === "close_bid")
    return dry
      ? planned("close_bid", { bid_id: bidId() })
      : board.close(wallet(config), bidId());

  throw new PublicError("Unknown tool.");
}
