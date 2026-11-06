// CLI and MCP tools for the bid board. Writes go through the configured custody wallet; board calls
// hold no job money. The JSON feed is read-only and needs no credentials.
import { createHash } from "node:crypto";
import { BoardClient, fundRefusal, type Wallet } from "./board.ts";
import type { Config } from "./config.ts";
import { BOARD } from "./custody.ts";
import { PublicError } from "./errors.ts";
import { buildFeed } from "./feed.ts";
import {
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
      },
      ["description", "check", "reference", "amount_near"],
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
      "Tie an active claim to a matching escrow job. Anyone can call it, and the board checks the job on chain.",
      { bid_id: id, job_id: id },
      ["bid_id", "job_id"],
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
      "close_bid",
      "Take down your own bid, unless a linked job has been funded and has not ended.",
      { bid_id: id },
      ["bid_id"],
    ],
  ];

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
    const call = {
      description: text(args, "description", 2048),
      amount: yocto(text(args, "amount_near", 30)),
      check_hash: hash(check),
      reference_hash: hash(reference),
      verifier_hash: verifier,
      claim_window_secs: integer(args, "claim_window_secs", 60, 86_400, 1_800),
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

  const jobId = integer(args, "job_id", 0, Number.MAX_SAFE_INTEGER);
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
