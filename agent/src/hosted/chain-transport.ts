// How `chain_read` reaches NEAR: fixed free endpoints, a body size cap, rate limits for the whole service,
// fallback from one RPC to the next, and neardata redirects followed only to its own archive hosts. The
// request bodies come from chain-read.ts, which builds them from a short list of read methods.

export interface ChainEndpoints {
  /** Tried in order when one cannot be reached. */
  rpcs: readonly string[];
  neardata: string;
  /** Severely rate limited; used for older state only when the operator turns it on. */
  archival: string | null;
}

/** The runner reads the chain through rpc.mainnet.fastnear.com, so skill reads start elsewhere. These
 * are the only hosts the skill reads. */
export function chainEndpoints(
  network: "mainnet" | "testnet",
  archival: boolean,
): ChainEndpoints {
  return network === "mainnet"
    ? {
        rpcs: ["https://rpc.intea.rs", "https://free.rpc.fastnear.com"],
        neardata: "https://mainnet.neardata.xyz",
        archival: archival ? "https://archival-rpc.mainnet.near.org" : null,
      }
    : {
        rpcs: ["https://testnet-rpc.intea.rs", "https://test.rpc.fastnear.com"],
        neardata: "https://testnet.neardata.xyz",
        archival: archival ? "https://archival-rpc.testnet.near.org" : null,
      };
}

const KIB = 1024;

export const CHAIN_LIMITS = {
  /** Reads one attempt may make, cached reads included. */
  readsPerRun: 30,
  /** Archival reads one attempt may make, when archival is on. */
  archivalPerRun: 2,
  /** neardata allows 180 a minute per address; this whole service stays well under it. */
  neardataPerMinute: 120,
  rpcPerMinute: 300,
  /** A neardata block can be over 300 KB. */
  maxResponseBytes: KIB * KIB,
  maxResultChars: 4 * KIB,
  maxArgsChars: 2 * KIB,
  timeoutMs: 10_000,
  cacheEntries: 500,
  maxCacheEntryBytes: 16 * KIB,
};

const MINUTE_MS = 60_000;
const MAX_REDIRECTS = 2;
const GONE = new Set(["GARBAGE_COLLECTED_BLOCK", "UNKNOWN_BLOCK"]);
const GC_MESSAGE =
  "Free nodes no longer keep that block's data; they keep roughly the last 100,000 blocks (about 16 hours). Ask for a recent block, or use events for history.";

/** A read that gave no result, for a reason the agent should hear. */
export class Refused extends Error {}
/** The node no longer keeps that block. */
class Gone extends Error {}

/** At most `limit` requests in any minute, for the whole service. */
class Window {
  private times: number[] = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  take(now: number): boolean {
    this.times = this.times.filter((at) => now - at < MINUTE_MS);
    if (this.times.length >= this.limit) return false;
    this.times.push(now);
    return true;
  }
}

export interface Transport {
  endpoints: ChainEndpoints;
  fetchImpl: typeof fetch;
  now: () => number;
  rpcWindow: Window;
  neardataWindow: Window;
}

/** Archival reads used by one attempt. */
export interface ReadCount {
  archival: number;
}

export function createTransport(
  endpoints: ChainEndpoints,
  fetchImpl: typeof fetch,
  now: () => number,
): Transport {
  return {
    endpoints,
    fetchImpl,
    now,
    rpcWindow: new Window(CHAIN_LIMITS.rpcPerMinute),
    neardataWindow: new Window(CHAIN_LIMITS.neardataPerMinute),
  };
}

/** The body as text, refused past the size cap however the server describes its length. */
export async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > CHAIN_LIMITS.maxResponseBytes)
    throw new Refused("The response is over 1 MB.");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CHAIN_LIMITS.maxResponseBytes) {
      await reader.cancel();
      throw new Refused("The response is over 1 MB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface RpcReply {
  result?: unknown;
  error?: {
    cause?: { name?: string; info?: unknown };
    message?: string;
    data?: unknown;
  };
}

/** A result, or an error about the request (such as an unknown account), which is also a result. */
function rpcResult(text: string): unknown {
  let reply: RpcReply;
  try {
    reply = JSON.parse(text) as RpcReply;
  } catch {
    throw new Error("The RPC answer was not JSON.");
  }
  if (!reply.error) return reply.result;
  const cause = reply.error.cause?.name ?? "";
  if (GONE.has(cause)) throw new Gone(cause);
  return {
    error: cause || reply.error.message || "RPC error",
    detail: reply.error.data ?? reply.error.cause?.info ?? null,
  };
}

async function rpcAt(
  t: Transport,
  url: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!t.rpcWindow.take(t.now()))
    throw new Refused(
      "The service's read limit is reached; try again in a minute.",
    );
  const response = await t.fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "proven", method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(CHAIN_LIMITS.timeoutMs),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  return rpcResult(await readCapped(response));
}

/** Older state, from the archival node, when the operator turned it on and the attempt has reads left. */
async function archivalRead(
  t: Transport,
  method: string,
  params: unknown,
  count: ReadCount,
): Promise<unknown> {
  const archival = t.endpoints.archival;
  if (!archival) throw new Refused(GC_MESSAGE);
  if (count.archival >= CHAIN_LIMITS.archivalPerRun)
    throw new Refused("This attempt has used its archival reads.");
  count.archival += 1;
  try {
    return await rpcAt(t, archival, method, params);
  } catch (error) {
    throw new Refused(
      error instanceof Gone
        ? "Not even the archival node has that block."
        : `The archival node did not answer: ${(error as Error).message.slice(0, 100)}`,
    );
  }
}

/** One read RPC call. The next RPC is tried only when one cannot be reached; free nodes keep the same
 * history, so a block one has dropped goes to the archival node instead. */
export async function rpc(
  t: Transport,
  method: string,
  params: unknown,
  count: ReadCount,
): Promise<unknown> {
  let lastError: Error | null = null;
  for (const url of t.endpoints.rpcs) {
    try {
      return await rpcAt(t, url, method, params);
    } catch (error) {
      if (error instanceof Refused) throw error;
      if (error instanceof Gone) return archivalRead(t, method, params, count);
      lastError = error as Error;
    }
  }
  throw new Refused(
    `No free RPC answered: ${lastError?.message.slice(0, 100) ?? "unknown"}.`,
  );
}

/** Where a neardata redirect may lead: its own archive hosts (a2., a3. and so on), for the same path. */
function redirectTarget(home: URL, from: URL, location: string | null): URL {
  const next = new URL(location ?? "", from);
  const allowed =
    next.protocol === "https:" &&
    next.port === "" &&
    next.hostname.endsWith(`.${home.hostname}`) &&
    next.pathname === from.pathname;
  if (!allowed)
    throw new Refused(
      "neardata redirected somewhere this skill does not read.",
    );
  return next;
}

async function neardataGet(t: Transport, path: string): Promise<Response> {
  const home = new URL(t.endpoints.neardata);
  let url = new URL(path, home);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await t.fetchImpl(url.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(CHAIN_LIMITS.timeoutMs),
    });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel();
    url = redirectTarget(home, url, response.headers.get("location"));
  }
  throw new Refused("neardata redirected too many times.");
}

interface NeardataBlock {
  shards?: Array<{
    receipt_execution_outcomes?: Array<{
      tx_hash?: string;
      execution_outcome?: {
        id?: string;
        outcome?: { executor_id?: string; logs?: string[]; status?: unknown };
      };
    }>;
  }>;
}

const EVENT_PREFIX = "EVENT_JSON:";

function eventValue(log: string): unknown {
  try {
    return JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch {
    return { unreadable: log.slice(0, 200) };
  }
}

function succeeded(status: unknown): boolean {
  return !!status && typeof status === "object" && !("Failure" in status);
}

type ReceiptOutcome = NonNullable<
  NonNullable<NeardataBlock["shards"]>[number]["receipt_execution_outcomes"]
>[number];

/** The events in one receipt's logs, if that receipt ran on `account`. */
function receiptEvents(item: ReceiptOutcome, account: string): unknown[] {
  const outcome = item.execution_outcome?.outcome;
  if (outcome?.executor_id !== account) return [];
  const where = {
    tx_hash: item.tx_hash ?? null,
    receipt_id: item.execution_outcome?.id ?? null,
    succeeded: succeeded(outcome.status),
  };
  return (outcome.logs ?? [])
    .filter((log) => log.startsWith(EVENT_PREFIX))
    .map((log) => ({ ...where, event: eventValue(log) }));
}

/** The NEP-297 events one contract logged in a block, with the receipt and transaction of each. */
export function eventsInBlock(data: NeardataBlock, account: string): unknown[] {
  return (data.shards ?? [])
    .flatMap((shard) => shard.receipt_execution_outcomes ?? [])
    .flatMap((item) => receiptEvents(item, account));
}

/** One block from neardata, which keeps every block, reduced to one contract's events. */
export async function blockEvents(
  t: Transport,
  account: string,
  block: number,
): Promise<unknown> {
  if (!t.neardataWindow.take(t.now()))
    throw new Refused(
      "The service's history read limit is reached; try again in a minute.",
    );
  const response = await neardataGet(t, `/v0/block/${block}`);
  const text = await readCapped(response);
  if (response.status === 404)
    throw new Refused(`neardata has no block ${block}: ${text.slice(0, 120)}`);
  if (!response.ok) throw new Refused(`neardata HTTP ${response.status}.`);
  let data: NeardataBlock | null;
  try {
    data = JSON.parse(text) as NeardataBlock | null;
  } catch {
    throw new Refused("neardata's answer was not JSON.");
  }
  // neardata answers null for a height that produced no block.
  if (data === null) return { block, skipped: true, events: [] };
  return { block, events: eventsInBlock(data, account) };
}
