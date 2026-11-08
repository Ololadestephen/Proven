import { randomBytes } from "node:crypto";
// Local routes behind the Market page. Reads use the configured network. The relay checks every
// private text against the job's hashes, so this only passes requests along to its local socket. This
// server never decides a verdict and holds no wallet, except for the opt-in dev signer below.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { parseEnv } from "node:util";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import {
  relayPayload,
  RelayVerifier,
  type RelayAuth,
} from "../../relay/src/buyer-auth.ts";
import { FallbackRpcProvider } from "../../relay/src/rpc.ts";
import { postedBidFromOutcome } from "../../relay/src/post-result.ts";
import {
  buyerAllowed,
  configuredBoard,
  legacyAccess,
  readBoardAccess,
} from "../../relay/src/market-access.ts";
import { ReadError } from "./model.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
export const NETWORK =
  process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const BOARD = process.env.PROVEN_BOARD ?? "board-v4.proven.testnet";
export const MARKET_ESCROW =
  process.env.PROVEN_MARKET_ESCROW ?? "escrow-v5.proven.testnet";
const RPC =
  NETWORK === "mainnet"
    ? "https://rpc.mainnet.fastnear.com"
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
const provider = new FallbackRpcProvider(
  NETWORK === "mainnet"
    ? [RPC, "https://rpc.mainnet.near.org"]
    : [RPC, "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
);
const view = <T>(
  contractId: string,
  method: string,
  args: Record<string, unknown>,
) =>
  provider.callFunction({ contractId, method, args }) as unknown as Promise<T>;

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
let cached: { at: number; value: Promise<unknown> } | null = null;
/** Many people reading the board share one set of chain reads. */
export function readMarketCached(now = Date.now()): Promise<unknown> {
  if (!cached || now - cached.at > MARKET_CACHE_MS) {
    const value = readMarket();
    value.catch(() => {
      cached = null;
    });
    cached = { at: now, value };
  }
  return cached.value;
}

/** A fixed number of writes per client per minute. Reads are shared through the cache above. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(client: string, now = Date.now()): boolean {
    const recent = (this.hits.get(client) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(client, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(client);
    this.hits.set(client, recent);
    // Full: forget the longest-quiet client, never everyone's counts at once.
    if (this.hits.size > 10_000)
      this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}

export async function readMarket() {
  const [config, boardConfig] = await Promise.all([
    view<{
      next_job_id: number;
      verifier_hash: string;
      paused: boolean;
      run_deposit: string;
    }>(MARKET_ESCROW, "get_config", {}),
    view<{ escrow: string; reviewer: string }>(BOARD, "get_config", {}),
  ]);
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
            }).catch(() => null),
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

/** What the page and the agent tools need in order to reach the right network and wallets. */
/** The same setting the relay obeys. Mainnet has no default, so forgetting it leaves the market closed. */
export function marketOpenTo(
  buyer: string,
  setting = process.env.PROVEN_MARKET_ACCESS,
  network: string = NETWORK,
): boolean {
  return buyerAllowed(legacyAccess(setting, network), buyer);
}

/** Legacy settings are used only when the board confirms get_access is not implemented. */
export function marketConfig(setting = process.env.PROVEN_MARKET_ACCESS) {
  const access = legacyAccess(setting, NETWORK);
  return {
    network: NETWORK,
    open: access.open,
    ...(access.open ? {} : { buyers: access.buyers }),
  };
}

export function boardAccess() {
  return readBoardAccess(
    () =>
      view(
        configuredBoard(
          NETWORK === "mainnet" ? process.env.PROVEN_BOARD : BOARD,
        ),
        "get_access",
        {},
      ),
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
  const near = config?.caps.find((cap) => cap.token === null);
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
export async function marketSettings() {
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
    !/^\/(terms|health|agents|withdraw|agents\/[a-z0-9._-]{2,64}|jobs\/\d{1,12}\/log)$/.test(
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
  const reply = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
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

const verifier = new RelayVerifier(async (accountId, publicKey) => {
  try {
    await provider.viewAccessKey({
      accountId,
      publicKey,
      finalityQuery: { finality: "final" },
    });
    return true;
  } catch {
    return false;
  }
});

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
  return new Promise((resolve, reject) => {
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
              "The review could not finish. The bid stays closed.",
              502,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new ReadError("The review gave no usable answer.", 502));
        }
      },
    );
  });
}

/** The dev signer: for testing this page without a wallet app. It needs the --dev-wallet flag, signs only
 * with two testnet keys on this machine, and can reach only the board and the escrow. */
export function createDevWallet() {
  const env = parseEnv(
    // Loaded once at startup; this flag is never used on a hosted server.
    (globalThis as { __provenEnv?: string }).__provenEnv ?? "",
  );
  const accounts: Record<string, { id: string; key: string }> = {};
  if (env.WORKER_HONEST_ACCOUNT_ID && env.WORKER_HONEST_PRIVATE_KEY)
    accounts.buyer = {
      id: env.WORKER_HONEST_ACCOUNT_ID,
      key: env.WORKER_HONEST_PRIVATE_KEY,
    };
  const outsider = (
    globalThis as { __provenOutsider?: { account: string; key: string } }
  ).__provenOutsider;
  if (outsider) accounts.worker = { id: outsider.account, key: outsider.key };
  for (const account of Object.values(accounts))
    if (!account.id.endsWith(".testnet") && !/^[a-f0-9]{64}$/.test(account.id))
      throw new Error("The dev signer is for testnet accounts only.");
  const signer = (as: string) => {
    const account = accounts[as];
    if (!account) throw new ReadError("No such dev account.", 400);
    return account;
  };
  return {
    list: () =>
      Object.fromEntries(
        Object.entries(accounts).map(([role, account]) => [role, account.id]),
      ),
    async call(body: {
      as: string;
      receiver: string;
      method: string;
      args: Record<string, unknown>;
      deposit: string;
      gas: string;
    }) {
      if (body.receiver !== BOARD && body.receiver !== MARKET_ESCROW)
        throw new ReadError(
          "The dev signer reaches only these contracts.",
          403,
        );
      const { id, key } = signer(body.as);
      const account = new Account(
        id,
        provider,
        new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
      );
      try {
        const outcome = await account.callFunctionRaw({
          contractId: body.receiver,
          methodName: body.method,
          args: body.args,
          deposit: body.deposit,
          gas: BigInt(body.gas),
        });
        let result: unknown = null;
        if (
          typeof outcome.status === "object" &&
          "SuccessValue" in outcome.status
        ) {
          try {
            result = JSON.parse(
              Buffer.from(outcome.status.SuccessValue, "base64").toString(
                "utf8",
              ),
            );
          } catch {
            // Non-JSON results cannot identify a posted bid. Preserve the transaction for reconciliation.
          }
        }
        const postedBid =
          body.method === "post_bid"
            ? postedBidFromOutcome(outcome, body.receiver, id)
            : null;
        return {
          transaction_hash: outcome.transaction.hash,
          result,
          ...(postedBid === null ? {} : { posted_bid_id: postedBid }),
        };
      } catch {
        throw new ReadError(
          "The transaction outcome is unknown. Reconcile wallet history and the chain before retrying.",
          502,
        );
      }
    },
    async transfer(body: { as: string; receiver: string; yocto: string }) {
      const { id, key } = signer(body.as);
      const account = new Account(
        id,
        provider,
        new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
      );
      try {
        const outcome = await account.signAndSendTransaction({
          receiverId: body.receiver,
          actions: [actions.transfer(BigInt(body.yocto))],
        });
        return { transaction_hash: outcome.transaction.hash };
      } catch {
        throw new ReadError(
          "The transaction outcome is unknown. Reconcile wallet history and the chain before retrying.",
          502,
        );
      }
    },
    sign(body: {
      as: string;
      message: string;
      nonce_base64: string;
      recipient: string;
    }) {
      const { key } = signer(body.as);
      const pair = KeyPair.fromString(key as `ed25519:${string}`);
      const text = (value: string) => {
        const bytes = Buffer.from(value);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(bytes.length);
        return Buffer.concat([length, bytes]);
      };
      const tag = Buffer.alloc(4);
      tag.writeUInt32LE(2147484061);
      const digest = createHash("sha256")
        .update(
          Buffer.concat([
            tag,
            text(body.message),
            Buffer.from(body.nonce_base64, "base64"),
            text(body.recipient),
            Buffer.from([0]),
          ]),
        )
        .digest();
      return {
        public_key: pair.getPublicKey().toString(),
        signature_base64: Buffer.from(pair.sign(digest).signature).toString(
          "base64",
        ),
      };
    },
  };
}
