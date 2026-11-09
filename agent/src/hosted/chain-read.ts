// `chain_read`: read-only NEAR data for hosted agents, from free endpoints with no key. The skill writes
// every request body itself from a short list of read methods, so a model can never send a transaction,
// name a host or follow a redirect. State reads name an explicit block, so every worker sees the buyer's
// snapshot. Free RPC nodes keep only recent state (state 100,000 blocks back was readable and 150,000 back
// was not, on November 9, 2026, at about 0.57 seconds a block); history comes from neardata, which keeps
// every block. What it returns is untrusted data, and decides nothing. Transport is in chain-transport.ts.
import {
  blockEvents,
  CHAIN_LIMITS,
  createTransport,
  rpc,
  type ChainEndpoints,
  type ReadCount,
  type Transport,
} from "./chain-transport.ts";
import type { SkillOutcome } from "./function-skill.ts";

export {
  CHAIN_LIMITS,
  chainEndpoints,
  type ChainEndpoints,
} from "./chain-transport.ts";

const ACCOUNT =
  /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const FUNCTION = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,5}$/;
const MAX_PATHS = 16;
/** Attempts whose read counts are kept; older ones are dropped first. */
const TRACKED_RUNS = 1_000;

type Request =
  | { method: "view_account"; account: string; block: number }
  | {
      method: "call_function";
      account: string;
      fn: string;
      args: string;
      block: number;
    }
  | { method: "block"; block: number | "final" }
  | { method: "tx"; hash: string; sender: string }
  | { method: "events"; account: string; block: number };

type Method = Request["method"];
type Fields = Record<string, unknown>;

function blockHeight(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function needs(method: string, fields: string[]): string {
  return `${method} needs ${fields.join(", ")}`;
}

function argsText(value: Fields): string | null {
  const args = value.args;
  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Array.isArray(args))
  )
    return null;
  const text = JSON.stringify(args ?? {});
  return text.length <= CHAIN_LIMITS.maxArgsChars ? text : null;
}

/** One checker per read method. Each checks every field it uses. */
const PARSERS: Record<Method, (value: Fields) => Request | string> = {
  view_account(value) {
    const account = String(value.account_id ?? "");
    const block = blockHeight(value.block);
    if (!ACCOUNT.test(account) || block === null)
      return needs("view_account", ["account_id", "block (a block height)"]);
    return { method: "view_account", account, block };
  },
  call_function(value) {
    const account = String(value.account_id ?? "");
    const fn = String(value.function ?? "");
    const block = blockHeight(value.block);
    if (!ACCOUNT.test(account) || !FUNCTION.test(fn) || block === null)
      return needs("call_function", [
        "account_id",
        "function",
        "block (a block height)",
      ]);
    const args = argsText(value);
    if (args === null) return "args must be one JSON object of at most 2 KB";
    return { method: "call_function", account, fn, args, block };
  },
  block(value) {
    if (value.block === "final") return { method: "block", block: "final" };
    const block = blockHeight(value.block);
    if (block === null) return needs("block", ['block (a height, or "final")']);
    return { method: "block", block };
  },
  tx(value) {
    const hash = String(value.hash ?? "");
    const sender = String(value.sender_id ?? "");
    if (!TX_HASH.test(hash) || !ACCOUNT.test(sender))
      return needs("tx", ["hash", "sender_id"]);
    return { method: "tx", hash, sender };
  },
  events(value) {
    const account = String(value.account_id ?? "");
    const block = blockHeight(value.block);
    if (!ACCOUNT.test(account) || block === null)
      return needs("events", ["account_id", "block (a block height)"]);
    return { method: "events", account, block };
  },
};

function isMethod(value: unknown): value is Method {
  return typeof value === "string" && Object.hasOwn(PARSERS, value);
}

function parseObject(input: string): Fields | null {
  try {
    const value: unknown = JSON.parse(input);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Fields)
      : null;
  } catch {
    return null;
  }
}

/** Reads and checks one request. Anything not on the list of read methods is refused. */
export function readRequest(input: string): Request | string {
  const value = parseObject(input);
  if (!value) return "chain_read takes one JSON object";
  if (!isMethod(value.method))
    return 'method must be "view_account", "call_function", "block", "tx" or "events"';
  return PARSERS[value.method](value);
}

function checkPaths(paths: unknown): string[] | undefined {
  if (paths === undefined) return undefined;
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > MAX_PATHS ||
    !paths.every((path) => typeof path === "string" && PATH.test(path))
  )
    throw new Error("select must be a list of 1 to 16 field paths like a.b");
  return paths as string[];
}

function at(item: unknown, path: string): unknown {
  let value = item;
  for (const key of path.split("."))
    value =
      value && typeof value === "object" ? (value as Fields)[key] : undefined;
  return value ?? null;
}

/** Keeps only the named fields, by dotted path, from an object or from each object of a list. */
export function select(value: unknown, paths: unknown): unknown {
  const checked = checkPaths(paths);
  if (!checked) return value;
  const pick = (item: unknown) =>
    Object.fromEntries(checked.map((path) => [path, at(item, path)]));
  return Array.isArray(value) ? value.map(pick) : pick(value);
}

// ---- One function per method: the RPC body it sends, and the fields it keeps ----

interface CallResult {
  result?: number[];
  logs?: string[];
  block_height?: number;
}

function decoded(bytes: number[]): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callFunction(
  t: Transport,
  request: Extract<Request, { method: "call_function" }>,
  count: ReadCount,
): Promise<unknown> {
  const result = (await rpc(
    t,
    "query",
    {
      request_type: "call_function",
      account_id: request.account,
      method_name: request.fn,
      args_base64: Buffer.from(request.args).toString("base64"),
      block_id: request.block,
    },
    count,
  )) as CallResult;
  if (!Array.isArray(result?.result)) return result;
  return {
    block_height: result.block_height,
    value: decoded(result.result),
    logs: result.logs ?? [],
  };
}

interface BlockResult {
  header?: Fields;
  chunks?: unknown[];
  author?: string;
}

async function blockSummary(
  t: Transport,
  request: Extract<Request, { method: "block" }>,
  count: ReadCount,
): Promise<unknown> {
  const params =
    request.block === "final"
      ? { finality: "final" }
      : { block_id: request.block };
  const block = (await rpc(t, "block", params, count)) as BlockResult;
  if (!block?.header) return block;
  const h = block.header;
  return {
    height: h.height,
    hash: h.hash,
    prev_hash: h.prev_hash,
    timestamp_nanosec: h.timestamp_nanosec,
    epoch_id: h.epoch_id,
    author: block.author,
    chunks: block.chunks?.length ?? 0,
  };
}

interface TxResult {
  status?: unknown;
  transaction?: {
    signer_id?: string;
    receiver_id?: string;
    actions?: unknown[];
  };
  receipts_outcome?: Array<{
    id?: string;
    outcome?: { executor_id?: string; logs?: string[]; status?: unknown };
  }>;
}

async function txSummary(
  t: Transport,
  request: Extract<Request, { method: "tx" }>,
  count: ReadCount,
): Promise<unknown> {
  const tx = (await rpc(
    t,
    "tx",
    {
      tx_hash: request.hash,
      sender_account_id: request.sender,
      wait_until: "FINAL",
    },
    count,
  )) as TxResult;
  if (!tx?.transaction) return tx;
  return {
    status: tx.status,
    signer_id: tx.transaction.signer_id,
    receiver_id: tx.transaction.receiver_id,
    actions: tx.transaction.actions,
    receipts: (tx.receipts_outcome ?? []).map((receipt) => ({
      id: receipt.id,
      executor_id: receipt.outcome?.executor_id,
      status: receipt.outcome?.status,
      logs: receipt.outcome?.logs ?? [],
    })),
  };
}

type Reader<M extends Method> = (
  t: Transport,
  request: Extract<Request, { method: M }>,
  count: ReadCount,
) => Promise<unknown>;

const READERS: { [M in Method]: Reader<M> } = {
  view_account: (t, request, count) =>
    rpc(
      t,
      "query",
      {
        request_type: "view_account",
        account_id: request.account,
        block_id: request.block,
      },
      count,
    ),
  call_function: callFunction,
  block: blockSummary,
  tx: txSummary,
  events: (t, request) => blockEvents(t, request.account, request.block),
};

function fetchResult(
  t: Transport,
  request: Request,
  count: ReadCount,
): Promise<unknown> {
  const reader = READERS[request.method] as Reader<Method>;
  return reader(t, request as never, count);
}

// ---- The skill ----

export interface ChainReader {
  read(input: string, run: string): Promise<SkillOutcome>;
}

interface RunCount extends ReadCount {
  all: number;
}

function refusal(message: string): SkillOutcome {
  return { output: `Error: ${message}`, ran: false };
}

function answerText(method: Method, value: unknown): string {
  const answer = JSON.stringify({ method, result: value });
  if (answer.length <= CHAIN_LIMITS.maxResultChars) return answer;
  return `${answer.slice(0, CHAIN_LIMITS.maxResultChars)}... [truncated: the result is ${answer.length} characters; use "select" to keep only the fields you need]`;
}

/** Results by request, never changed after they are stored. A "final" block changes from block to
 * block, so it is never kept. */
class ResultCache {
  private readonly entries = new Map<string, unknown>();
  static cacheable(request: Request): boolean {
    return !(request.method === "block" && request.block === "final");
  }
  has(request: Request): boolean {
    return (
      ResultCache.cacheable(request) &&
      this.entries.has(JSON.stringify(request))
    );
  }
  get(request: Request): unknown {
    return this.entries.get(JSON.stringify(request));
  }
  set(request: Request, value: unknown) {
    if (!ResultCache.cacheable(request)) return;
    this.entries.set(JSON.stringify(request), value);
    if (this.entries.size > CHAIN_LIMITS.cacheEntries)
      this.entries.delete(this.entries.keys().next().value!);
  }
}

export function chainReader(
  endpoints: ChainEndpoints,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): ChainReader {
  const transport = createTransport(endpoints, fetchImpl, now);
  const cache = new ResultCache();
  const runs = new Map<string, RunCount>();

  /** Counts one read against the attempt, or null if it has none left. Refused reads count too. */
  function takeRead(run: string): RunCount | null {
    const count = runs.get(run) ?? { all: 0, archival: 0 };
    if (count.all >= CHAIN_LIMITS.readsPerRun) return null;
    count.all += 1;
    runs.set(run, count);
    if (runs.size > TRACKED_RUNS) runs.delete(runs.keys().next().value!);
    return count;
  }

  async function result(request: Request, count: RunCount): Promise<unknown> {
    if (cache.has(request)) return cache.get(request);
    const value = await fetchResult(transport, request, count);
    cache.set(request, value);
    return value;
  }

  return {
    async read(input, run) {
      const request = readRequest(input);
      if (typeof request === "string") return refusal(`${request}.`);
      let paths: string[] | undefined;
      try {
        paths = checkPaths(parseObject(input)?.select);
      } catch (error) {
        return refusal(`${(error as Error).message}.`);
      }
      const count = takeRead(run);
      if (!count)
        return refusal(
          `this attempt has used its ${CHAIN_LIMITS.readsPerRun} chain reads.`,
        );
      let value: unknown;
      try {
        value = await result(request, count);
      } catch (error) {
        // A read that gave no result is not charged; it still counts against the attempt's reads.
        return refusal((error as Error).message.slice(0, 300));
      }
      return {
        output: answerText(request.method, select(value, paths)),
        ran: true,
      };
    },
  };
}
