import { readPublicReview } from "../../shared/public-review.ts";
import { randomBytes } from "node:crypto";
// Local routes behind the Market page. Reads use the configured network. The relay checks every
// private text against the job's hashes, so this only passes requests along to its local socket. This
// server never decides a verdict and holds no wallet, except for the opt-in dev signer below.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { JsonRpcProvider } from "near-api-js";
import { relayPayload, type RelayAuth } from "../../relay/src/buyer-auth.ts";
import { FallbackRpcProvider } from "../../relay/src/rpc.ts";
import {
  buyerAllowed,
  configuredBoard,
  legacyAccess,
  missingView,
  readBoardAccess,
} from "../../relay/src/market-access.ts";
import { ReadError } from "./model.ts";
import { RateLimiter } from "./rate-limiter.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
export const NETWORK =
  process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
// Mainnet has no default board, so a missing setting fails rather than reading the testnet one.
export const BOARD =
  process.env.PROVEN_BOARD ??
  (NETWORK === "mainnet" ? "" : "board-v4.proven.testnet");
export const MARKET_ESCROW =
  process.env.PROVEN_MARKET_ESCROW ?? "escrow-v5.proven.testnet";
// Mainnet reads start at free.rpc.fastnear.com: from the host, rpc.intea.rs answers in over a second
// a call and rpc.mainnet.fastnear.com rate-limits (measured November 12).
const RPC =
  NETWORK === "mainnet"
    ? "https://free.rpc.fastnear.com"
    : "https://test.rpc.fastnear.com";
const HOSTED_SERVICE = process.env.PROVEN_HOSTED_URL ?? "http://127.0.0.1:4175";
const MAX_BODY = 512 * 1024;
const HANDOFF_ACTIONS = new Set([
  "challenge",
  "deliver",
  "pin_verification",
  "cleanup",
  "collect",
]);

// A rate limit from one public RPC moves to the next approved one, so a busy page keeps working.
export const provider = new FallbackRpcProvider(
  NETWORK === "mainnet"
    ? // The archival endpoint is deprecated and refuses every call, so it is not a fallback.
      [RPC, "https://rpc.intea.rs", "https://rpc.mainnet.near.org"]
    : [RPC, "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
  NETWORK === "mainnet",
);
const view = <T>(
  contractId: string,
  method: string,
  args: Record<string, unknown>,
) =>
  provider.callFunction({ contractId, method, args }) as unknown as Promise<T>;

/** A read only lookup on the server's configured network; the browser validates the board event. */
export async function postingOutcome(
  body: Record<string, unknown>,
): Promise<unknown> {
  const { buyer, hash } = body;
  if (
    typeof buyer !== "string" ||
    buyer.length < 2 ||
    buyer.length > 64 ||
    !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(buyer) ||
    typeof hash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)
  )
    throw new ReadError(
      "A valid buyer and transaction hash are required.",
      400,
    );
  try {
    return await provider.viewTransactionStatus({
      txHash: hash,
      accountId: buyer,
      waitUntil: "FINAL",
    });
  } catch {
    throw new ReadError(
      "The posting outcome is not available yet. Check the board before retrying.",
      502,
    );
  }
}

interface Job {
  buyer: string;
  /** Null while the job waits for a worker. */
  worker: string | null;
  amount: string;
  token: string | null;
  state: string;
  spec_hash: string;
  fakes_hash: string;
  format_hash: string;
  verifier_hash: string;
  delivered_at: string | null;
  verdict_window_secs: number;
  run_started_at: string | null;
  deliverable_hash: string | null;
  fakes_caught: number;
  fakes_total: number;
  failed_rule: string | null;
  challenge_request_id: string | null;
  verdict_request_id: string | null;
  deadline: string;
  compute_budget: string;
  expires_at: string;
  max_attempts: number;
  history: Array<{
    worker: string;
    outcome: string;
    failed_rule: string | null;
    verdict_request_id: string | null;
  }>;
}
interface Claim {
  number: number;
  agent: string;
  expires_at: string;
  job_id: number | null;
}
interface Bid {
  buyer: string;
  description: string;
  amount: string;
  check_hash: string;
  reference_hash: string;
  verifier_hash: string;
  format: string;
  format_hash: string;
  expires_at: string;
  state: string;
  claim: Claim | null;
  /** The escrow job that holds this bid's money. Null only while it is being created. */
  job_id: number | null;
  [key: string]: unknown;
}

const MARKET_CACHE_MS = 4_000;
let cached: {
  at: number;
  value: Awaited<ReturnType<typeof readMarket>>;
} | null = null;
let marketRead: Promise<unknown> | null = null;
/** Share an in-flight refresh even if it takes longer than the cache window. */
export function readMarketCached(now = Date.now()): Promise<unknown> {
  if (cached && now - cached.at <= MARKET_CACHE_MS)
    return Promise.resolve(cached.value);
  marketRead ??= readMarket()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .catch((error: unknown) => {
      if (!cached) throw error;
      return { ...cached.value, snapshot_stale: true };
    })
    .finally(() => {
      marketRead = null;
    });
  return marketRead;
}

/** How old a snapshot the page may be shown while a newer one is read in the background. */
const MARKET_SERVE_STALE_MS = 60_000;
/** For page loads and polling: a recent snapshot at once, with a refresh started behind it, so a
 * visitor never waits for the full chain read. Safety checks before or after a transaction use
 * readMarketCached instead, which never answers from a snapshot older than its short window. */
export function readMarketSnapshot(now = Date.now()): Promise<unknown> {
  if (
    cached &&
    now - cached.at > MARKET_CACHE_MS &&
    now - cached.at <= MARKET_SERVE_STALE_MS
  ) {
    void readMarketCached(now).catch(() => undefined);
    return Promise.resolve(cached.value);
  }
  return readMarketCached(now);
}

export async function readMarket() {
  const config = await view<{
    verifier_hash: string;
    paused: boolean;
    run_deposit: string;
  }>(MARKET_ESCROW, "get_config", {});
  const bids: Array<[number, Bid]> = [];
  for (let from = 0; ; from += 50) {
    const page = await view<Array<[number, Bid]>>(BOARD, "get_bids", {
      from_id: from,
      limit: 50,
    });
    bids.push(...page);
    if (page.length < 50) break;
  }
  const agents = await view<Array<{ wallet: string }>>(BOARD, "get_agents", {
    from_index: 0,
    limit: 50,
  });
  // Each agent's record, counted by the board once per attempt. An older board has none.
  const agentRecords = Object.fromEntries(
    await Promise.all(
      agents.map(
        async (agent) =>
          [
            agent.wallet,
            await view<AgentRecord>(BOARD, "get_agent_record", {
              wallet: agent.wallet,
            }).catch((error) => {
              if (missingView(error)) return null;
              throw error;
            }),
          ] as const,
      ),
    ),
  );
  const records = new Map<string, BuyerRecord>();
  const rows = await Promise.all(
    bids.map(async ([id, bid]) => {
      const job =
        bid.job_id !== null
          ? await view<Job | null>(MARKET_ESCROW, "get_job", {
              job_id: bid.job_id,
            })
          : null;
      const record = records.get(bid.buyer) ?? emptyRecord();
      records.set(bid.buyer, record);
      countJob(record, job);
      const ended = job && ["Released", "Refunded"].includes(job.state);
      return {
        id,
        ...bid,
        review_reason: readPublicReview(
          `${ROOT}runs/private/bid-reviews`,
          BOARD,
          id,
          bid.review,
        ),
        job: job ? { id: bid.job_id, ...job } : null,
        last_job: ended ? { id: bid.job_id, ...job } : null,
      };
    }),
  );
  return {
    network: NETWORK,
    buyer_records: Object.fromEntries(records),
    agent_records: agentRecords,
    board: BOARD,
    escrow: MARKET_ESCROW,
    verifier_hash: config.verifier_hash,
    paused: config.paused,
    /** What the escrow attaches for each run, paid from the job's budget. */
    run_deposit: config.run_deposit,
    agents: agents.map((agent) => agent.wallet),
    bids: rows.reverse(),
  };
}

interface AgentRecord {
  paid: number;
  failed: number;
  failed_format: number;
  no_delivery: number;
  no_verdict: number;
}

interface BuyerRecord {
  paid: number;
  refunded: number;
  expired: number;
}
const emptyRecord = (): BuyerRecord => ({ paid: 0, refunded: 0, expired: 0 });
/** Counted per attempt, from the escrow's own records. */
function countJob(
  record: BuyerRecord,
  job: { history?: Array<{ outcome: string }> } | null,
) {
  for (const attempt of job?.history ?? []) {
    if (attempt.outcome === "Paid") record.paid += 1;
    if (attempt.outcome === "Failed") record.refunded += 1;
    if (attempt.outcome === "NoDelivery" || attempt.outcome === "NoVerdict")
      record.expired += 1;
  }
}

export async function boardAccess() {
  // Checked first, so a missing board is reported as such rather than as a failed read.
  const board = configuredBoard(BOARD);
  return readBoardAccess(
    () => view(board, "get_access", {}),
    () => legacyAccess(process.env.PROVEN_MARKET_ACCESS, NETWORK),
  );
}

/** The escrow's limits on NEAR, read from the chain and kept for a minute, so the page never states
 * limits the contract does not enforce. */
let capsRead: { at: number; caps: Caps | null } | null = null;
interface Caps {
  max_job: string;
  max_held: string;
  max_held_per_buyer: string;
}
async function escrowCaps(): Promise<Caps | null> {
  if (capsRead && Date.now() - capsRead.at < 60_000) return capsRead.caps;
  const config = await view<{ caps: Array<Caps & { token: string | null }> }>(
    MARKET_ESCROW,
    "get_config",
    {},
  ).catch(() => null);
  // A failed read shows the limits as unavailable now, and is tried again on the next request
  // rather than kept for a minute.
  if (!config) return null;
  const near = config.caps.find((cap) => cap.token === null);
  const caps = near
    ? {
        max_job: near.max_job,
        max_held: near.max_held,
        max_held_per_buyer: near.max_held_per_buyer,
      }
    : null;
  capsRead = { at: Date.now(), caps };
  return caps;
}

/** The access setting and the escrow's limits, for the page. */
/** Every page waits for these settings, so one read serves all visitors for a few seconds. The board
 * itself enforces who may post, so a briefly cached answer never lets anyone post. */
const SETTINGS_MS = 15_000;
let settingsRead: { at: number; value: Promise<unknown> } | null = null;
export function marketSettings() {
  const now = Date.now();
  if (settingsRead && now - settingsRead.at < SETTINGS_MS)
    return settingsRead.value;
  const value = readMarketSettings();
  settingsRead = { at: now, value };
  // A failed read is not kept: the next visitor reads again.
  value.catch(() => {
    if (settingsRead?.value === value) settingsRead = null;
  });
  return value;
}
async function readMarketSettings() {
  const [access, caps] = await Promise.all([boardAccess(), escrowCaps()]);
  return {
    network: NETWORK,
    open: access.open,
    ...(access.open ? {} : { buyers: access.buyers }),
    access_source: access.source,
    caps,
  };
}

/** Publishes a bid's check once its bid has ended. The relay checks the rule against the chain. */
export function revealRoute(bidId: number) {
  if (!Number.isSafeInteger(bidId) || bidId < 0)
    throw new ReadError("Invalid bid.", 400);
  return relay({ action: "reveal", bid_id: bidId });
}

/** Passes one request to the hosted agents service on this machine, on fixed paths only. */
export async function hostedRoute(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (
    !/^\/(terms|health|agents|withdraw|(?:agents|enrollment)\/[a-z0-9._-]{2,64}|jobs\/\d{1,12}\/log)$/.test(
      path,
    )
  )
    throw new ReadError("Route not found.", 404);
  const response = await fetch(`${HOSTED_SERVICE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  }).catch(() => {
    throw new ReadError("The hosted agents service is not reachable.", 503);
  });
  const text = await response.text();
  let reply: { error?: string } = {};
  try {
    reply = JSON.parse(text) as { error?: string };
  } catch {
    if (response.ok)
      throw new ReadError(
        method === "POST"
          ? "The hosted agents service sent an unreadable reply. Check the agent or withdrawal before retrying."
          : "The hosted agents service sent an unreadable reply.",
        502,
      );
  }
  if (!response.ok)
    throw new ReadError(
      reply.error ?? "The hosted agents service refused this.",
      response.status === 404 ? 404 : 400,
    );
  return reply;
}

export async function sample() {
  const dir = `${ROOT}examples/swarm-job`;
  const [description, check, reference] = await Promise.all(
    ["task.txt", "check.json", "reference.json"].map((name) =>
      readFile(`${dir}/${name}`, "utf8"),
    ),
  );
  // A check's exact text can be on one bid only, so each copy of the example differs by trailing spaces.
  const unique = Array.from(randomBytes(16), (byte) =>
    byte.toString(2).padStart(8, "0").replace(/0/g, " ").replace(/1/g, "\t"),
  ).join("");
  return { description, check: `${check}${unique}`, reference };
}

function relay(request: Record<string, unknown>): Promise<unknown> {
  const socket =
    process.env.PROVEN_RELAY_SOCKET ?? `${ROOT}runs/private/relay.sock`;
  return new Promise((resolve, reject) => {
    let data = "";
    const client = createConnection(socket);
    client.setTimeout(120_000, () => client.destroy(new Error("timeout")));
    client.on("connect", () => client.end(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > MAX_BODY) client.destroy(new Error("large"));
    });
    client.on("error", () =>
      reject(
        new ReadError("The local relay is not reachable. Start it first.", 503),
      ),
    );
    client.on("end", () => {
      try {
        const reply = JSON.parse(data) as { ok?: boolean; result?: unknown };
        if (reply.ok !== true) throw new Error("refused");
        resolve(reply.result);
      } catch {
        reject(new ReadError("The relay refused this.", 403));
      }
    });
  });
}

export async function relayRoute(body: unknown) {
  const request = body as Record<string, unknown>;
  if (
    !request ||
    typeof request.action !== "string" ||
    !HANDOFF_ACTIONS.has(request.action)
  )
    throw new ReadError("That relay action is not available.", 400);
  // A check and reference are proven by the job's hashes on chain, so they need no signature.
  if (!request.auth && request.action !== "challenge")
    throw new ReadError("Sign this request with your wallet.", 401);
  return relay(request);
}

let reviewing = false;
/** Each review spends the operator's model credit. The key pool also caps the project's total on disk. */
const reviewsByBuyer = new RateLimiter(5, 3_600_000);
/** Runs the bid review, which can only keep a bid off the board. Fixed command, one at a time. Only the
 * bid's own buyer can ask, because each review spends the operator's model credit. */
export async function reviewRoute(
  bidId: number,
  auth?: RelayAuth,
): Promise<unknown> {
  if (!Number.isSafeInteger(bidId) || bidId < 0)
    throw new ReadError("Invalid bid.", 400);
  const bid = await view<Bid | null>(BOARD, "get_bid", { bid_id: bidId });
  if (!bid) throw new ReadError("No such bid.", 404);
  if (bid.state !== "Unreviewed")
    throw new ReadError("That bid is not waiting for a review.", 409);
  // A review spends the operator's model credit, so a closed market reviews only its listed buyers.
  if (!buyerAllowed(await boardAccess(), bid.buyer))
    throw new ReadError("The market is not open to this buyer.", 403);
  // Anyone can start it, so the buyer signs nothing after posting. The market-access check above, one
  // review at a time, and the per-buyer limit below bound what it can cost.
  void auth;
  if (reviewing) throw new ReadError("A review is already running.", 429);
  if (!reviewsByBuyer.allow(bid.buyer))
    throw new ReadError("Too many reviews. Try again later.", 429);
  reviewing = true;
  const run = new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["scripts/swarm.ts", "review", String(bidId), "NEARAI_KEY_REVIEW"],
      {
        cwd: `${ROOT}agent`,
        timeout: 320_000,
        env: { ...process.env, PROVEN_BOARD: BOARD },
      },
      (error, stdout) => {
        reviewing = false;
        if (error) {
          reject(
            new ReadError(
              "We couldn’t finish the bid review. Check the bid status before trying again.",
              502,
            ),
          );
          return;
        }
        try {
          const reply = JSON.parse(stdout) as { recorded?: boolean };
          if (reply?.recorded !== true) {
            reject(
              new ReadError(
                "The review has no confirmed decision yet. Check the bid status before trying again.",
                503,
              ),
            );
            return;
          }
          resolve(reply);
        } catch {
          reject(new ReadError("The review gave no usable answer.", 502));
        }
      },
    );
  });
  return reviewOutcome(bidId, run, () =>
    view<Bid | null>(BOARD, "get_bid", { bid_id: bidId }),
  );
}

/** The chain decides: if the review command failed after its decision landed (a lost wait for the
 * transaction outcome, a failed read-back), this reports the decision the board recorded instead of
 * an error. A bid still waiting for review, or a board that cannot be read, keeps the error. */
export function reviewOutcome(
  bidId: number,
  run: Promise<unknown>,
  readBid: () => Promise<{ state: string } | null>,
): Promise<unknown> {
  return run.catch(async (error: unknown) => {
    const after = await readBid().catch(() => null);
    if (after && after.state !== "Unreviewed")
      return {
        bid_id: bidId,
        recorded: true,
        state: after.state,
        confirmed_from_chain: true,
      };
    throw error;
  });
}
