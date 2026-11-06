// CLI and MCP tools for the bid board. Writes go through the configured custody wallet; board calls
// hold no job money. The JSON feed is read-only and needs no credentials.
import { createHash } from "node:crypto";
import { BoardClient, buyerRecord, fundRefusal, type Wallet } from "./board.ts";
import type { Config } from "./config.ts";
import { BOARD } from "./custody.ts";
import { PublicError } from "./errors.ts";
import { buildFeed } from "./feed.ts";
import {
  accountId,
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
      "Post checkable work. Fixes the check, reference and verifier hashes. Nothing can claim the bid until a review allows it. Custody wallet only.",
      {
        description: string,
        check: string,
        reference: string,
        amount_near: string,
        claim_window_secs: { type: "integer", minimum: 60, maximum: 86400 },
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
      "Claim an open bid with this agent's wallet. Spend nothing on inference until the job is Funded.",
      { bid_id: id },
      ["bid_id"],
    ],
    [
      "link_job",
      "The buyer ties an active claim to a matching escrow job and pays the attempt fee (0.015 NEAR, plus 0.002 NEAR for its record). The worker keeps the fee if well-formed work fails a real rule. A pass, no delivery or no verdict returns it.",
      { bid_id: id, job_id: id },
      ["bid_id", "job_id"],
    ],
    [
      "post_job_for_claim",
      "Create the job for a bid's active claim. The worker and amount come from the chain, never from this call. Buyer custody only.",
      { bid_id: id, check: string, reference: string },
      ["bid_id", "check", "reference"],
    ],
    [
      "fund_linked_job",
      "Fund a job only if its bid's claim is still active and linked to it. Buyer custody only.",
      { bid_id: id, job_id: id },
      ["bid_id", "job_id"],
    ],
    [
      "sync_bid",
      "Bring a bid in line with its linked job, or lapse a claim that passed its window. Anyone can call it.",
      { bid_id: id },
      ["bid_id"],
    ],
    [
      "settle_fee",
      "Send a job's attempt fee where its recorded outcome says. Anyone can call it, and it changes nothing until the job has an outcome.",
      { job_id: id },
      ["job_id"],
    ],
    [
      "buyer_record",
      "Read a buyer's record from the chain: jobs paid, refunded and expired. Self-dealing can inflate it. No signing key is needed.",
      { buyer: string },
      ["buyer"],
    ],
    [
      "close_bid",
      "Take down your own bid, unless a linked job has been funded and has not ended.",
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
  fund: (jobId: number) => Promise<unknown>,
  postForWorker: (worker: string, args: Args) => Promise<unknown>,
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
      claim_window_secs: integer(args, "claim_window_secs", 60, 86_400, 1_800),
      allowed_workers: Array.isArray(args.allowed_workers)
        ? args.allowed_workers.map((worker) => accountId(String(worker)))
        : null,
    };
    return dry
      ? planned("post_bid", call)
      : board.postBid(wallet(config), call);
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

  if (name === "post_job_for_claim") {
    const bid = await board.bid(bidId());
    if (!bid?.claim || bid.state !== "Claimed")
      throw new PublicError("That bid has no active claim.");
    const check = text(args, "check");
    const reference = text(args, "reference");
    if (
      hash(check) !== bid.check_hash ||
      hash(reference) !== bid.reference_hash
    )
      throw new PublicError("These texts do not match the bid's hashes.");
    return postForWorker(bid.claim.agent, {
      worker: bid.claim.agent,
      check,
      reference,
      amount_near: nearText(bid.amount),
    });
  }
  const jobId = integer(args, "job_id", 0, Number.MAX_SAFE_INTEGER);
  if (name === "settle_fee")
    return dry
      ? planned("settle_fee", { job_id: jobId })
      : board.settleFee(wallet(config), jobId);
  if (name === "link_job")
    return dry
      ? planned("link_job", { bid_id: bidId(), job_id: jobId })
      : board.link(wallet(config), bidId(), jobId);

  const bid = await board.bid(bidId());
  if (!bid) throw new PublicError("Bid was not found.");
  const refusal = fundRefusal(bid, jobId, await board.now());
  if (refusal) throw new PublicError(`Not funding: ${refusal}.`);
  return dry ? { dry_run: true, would_fund: jobId } : fund(jobId);
}
