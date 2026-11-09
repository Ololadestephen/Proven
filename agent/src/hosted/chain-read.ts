// `chain_read`: read-only NEAR data for hosted agents, from free endpoints with no key. The skill writes
// every request body itself from a short list of read methods, so a model can never send a transaction,
// name a host or follow a redirect. State reads name an explicit block, so every worker sees the buyer's
// snapshot. Free RPC nodes keep only recent state (state 100,000 blocks back was readable and 150,000 back
// was not, on November 9, 2026, at about 0.57 seconds a block); history comes from neardata, which keeps
// every block. What it returns is untrusted data, and decides nothing.
import type { SkillOutcome } from "./function-skill.ts";

export interface ChainEndpoints {
  /** Tried in order when one cannot be reached. */
  rpcs: readonly string[];
  neardata: string;
  /** Severely rate limited; used for older state only when the operator turns it on. */
  archival: string | null;
}

/** The runner reads the chain through rpc.mainnet.fastnear.com, so skill reads start elsewhere. */
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

export const CHAIN_LIMITS = {
  /** Reads one attempt may make, cached reads included. */
  readsPerRun: 30,
  /** Archival reads one attempt may make, when archival is on. */
  archivalPerRun: 2,
  /** neardata allows 180 a minute per address; this whole service stays well under it. */
  neardataPerMinute: 120,
  rpcPerMinute: 300,
  /** A neardata block can be over 300 KB. */
  maxResponseBytes: 1024 * 1024,
  maxResultChars: 4 * 1024,
  maxArgsChars: 2 * 1024,
  timeoutMs: 10_000,
  cacheEntries: 500,
};

const ACCOUNT =
  /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const FUNCTION = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,5}$/;
const GONE = new Set(["GARBAGE_COLLECTED_BLOCK", "UNKNOWN_BLOCK"]);

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

type Fetch = typeof fetch;

function blockHeight(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

/** Reads and checks one request. Every field is checked; anything else is refused. */
export function readRequest(input: string): Request | string {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return "chain_read takes one JSON object";
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "chain_read takes one JSON object";
  const account = String(value.account_id ?? "");
  const block = blockHeight(value.block);
  const needs = (fields: string[]) =>
    `${String(value.method)} needs ${fields.join(", ")}`;
  switch (value.method) {
    case "view_account":
      if (!ACCOUNT.test(account) || block === null)
        return needs(["account_id", "block (a block height)"]);
      return { method: "view_account", account, block };
    case "call_function": {
      const fn = String(value.function ?? "");
      const args = JSON.stringify(value.args ?? {});
      if (!ACCOUNT.test(account) || !FUNCTION.test(fn) || block === null)
        return needs(["account_id", "function", "block (a block height)"]);
      if (
        (value.args !== undefined &&
          (typeof value.args !== "object" ||
            value.args === null ||
            Array.isArray(value.args))) ||
        args.length > CHAIN_LIMITS.maxArgsChars
      )
        return "args must be one JSON object of at most 2 KB";
      return { method: "call_function", account, fn, args, block };
    }
    case "block":
      if (value.block === "final") return { method: "block", block: "final" };
      if (block === null) return needs(['block (a height, or "final")']);
      return { method: "block", block };
    case "tx": {
      const hash = String(value.hash ?? "");
      const sender = String(value.sender_id ?? "");
      if (!TX_HASH.test(hash) || !ACCOUNT.test(sender))
        return needs(["hash", "sender_id"]);
      return { method: "tx", hash, sender };
    }
    case "events":
      if (!ACCOUNT.test(account) || block === null)
        return needs(["account_id", "block (a block height)"]);
      return { method: "events", account, block };
    default:
      return 'method must be "view_account", "call_function", "block", "tx" or "events"';
  }
}

/** Keeps only the named fields, by dotted path, from an object or from each object of a list. */
export function select(value: unknown, paths: unknown): unknown {
  if (paths === undefined) return value;
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > 16 ||
    !paths.every((path) => typeof path === "string" && PATH.test(path))
  )
    throw new Error("select must be a list of 1 to 16 field paths like a.b");
  const pick = (item: unknown) => {
    const out: Record<string, unknown> = {};
    for (const path of paths as string[]) {
      let at: unknown = item;
      for (const key of path.split("."))
        at =
          at && typeof at === "object"
            ? (at as Record<string, unknown>)[key]
            : undefined;
      out[path] = at ?? null;
    }
    return out;
  };
  return Array.isArray(value) ? value.map(pick) : pick(value);
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > CHAIN_LIMITS.maxResponseBytes)
    throw new Error("The response is over 1 MB.");
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
      throw new Error("The response is over 1 MB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One request per minute window, for the whole service. */
class Window {
  private times: number[] = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  take(now: number): boolean {
    this.times = this.times.filter((at) => now - at < 60_000);
    if (this.times.length >= this.limit) return false;
    this.times.push(now);
    return true;
  }
}

class Refused extends Error {}
class Gone extends Error {}

export interface ChainReader {
  read(input: string, run: string): Promise<SkillOutcome>;
}

export function chainReader(
  endpoints: ChainEndpoints,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): ChainReader {
  const cache = new Map<string, string>();
  const reads = new Map<string, { all: number; archival: number }>();
  const rpcWindow = new Window(CHAIN_LIMITS.rpcPerMinute);
  const neardataWindow = new Window(CHAIN_LIMITS.neardataPerMinute);

  async function get(url: string, init?: RequestInit): Promise<Response> {
    return fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(CHAIN_LIMITS.timeoutMs),
    });
  }

  async function rpcAt(url: string, method: string, params: unknown) {
    if (!rpcWindow.take(now()))
      throw new Refused(
        "The service's read limit is reached; try again in a minute.",
      );
    const response = await get(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "proven", method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const reply = JSON.parse(await readCapped(response)) as {
      result?: unknown;
      error?: {
        cause?: { name?: string; info?: unknown };
        message?: string;
        data?: unknown;
      };
    };
    if (reply.error) {
      const cause = reply.error.cause?.name ?? "";
      if (GONE.has(cause)) throw new Gone(cause);
      // An answer about the request, such as an unknown account or a contract panic, is a result.
      return {
        error: cause || reply.error.message || "RPC error",
        detail: reply.error.data ?? reply.error.cause?.info ?? null,
      };
    }
    return reply.result;
  }

  async function rpc(
    method: string,
    params: unknown,
    count: { archival: number },
  ) {
    let lastError: unknown = null;
    for (const url of endpoints.rpcs) {
      try {
        return await rpcAt(url, method, params);
      } catch (error) {
        if (error instanceof Refused) throw error;
        if (error instanceof Gone) {
          lastError = error;
          break;
        }
        lastError = error;
      }
    }
    if (lastError instanceof Gone) {
      if (!endpoints.archival)
        throw new Refused(
          "Free nodes no longer keep that block's data; they keep roughly the last 100,000 blocks (about 16 hours). Ask for a recent block, or use events for history.",
        );
      if (count.archival >= CHAIN_LIMITS.archivalPerRun)
        throw new Refused("This attempt has used its archival reads.");
      count.archival += 1;
      try {
        return await rpcAt(endpoints.archival, method, params);
      } catch (error) {
        throw new Refused(
          error instanceof Gone
            ? "Not even the archival node has that block."
            : `The archival node did not answer: ${(error as Error).message.slice(0, 100)}`,
        );
      }
    }
    throw new Refused(
      `No free RPC answered: ${(lastError as Error)?.message?.slice(0, 100) ?? "unknown"}.`,
    );
  }

  /** neardata sends old blocks to its archive hosts (a2., a3. and so on). Only those are followed. */
  async function neardataGet(path: string): Promise<Response> {
    const home = new URL(endpoints.neardata);
    let url = new URL(path, home);
    for (let hop = 0; hop <= 2; hop++) {
      const response = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(CHAIN_LIMITS.timeoutMs),
      });
      if (response.status < 300 || response.status >= 400) return response;
      await response.body?.cancel();
      const next = new URL(response.headers.get("location") ?? "", url);
      if (
        next.protocol !== "https:" ||
        next.port !== "" ||
        !next.hostname.endsWith(`.${home.hostname}`) ||
        next.pathname !== url.pathname
      )
        throw new Refused(
          "neardata redirected somewhere this skill does not read.",
        );
      url = next;
    }
    throw new Refused("neardata redirected too many times.");
  }

  async function events(account: string, block: number) {
    if (!neardataWindow.take(now()))
      throw new Refused(
        "The service's history read limit is reached; try again in a minute.",
      );
    const response = await neardataGet(`/v0/block/${block}`);
    const text = await readCapped(response);
    if (response.status === 404)
      throw new Refused(
        `neardata has no block ${block}: ${text.slice(0, 120)}`,
      );
    if (!response.ok) throw new Refused(`neardata HTTP ${response.status}.`);
    const data = JSON.parse(text) as {
      shards?: Array<{
        receipt_execution_outcomes?: Array<{
          tx_hash?: string;
          execution_outcome?: {
            id?: string;
            outcome?: {
              executor_id?: string;
              logs?: string[];
              status?: unknown;
            };
          };
        }>;
      }>;
    } | null;
    if (data === null) return { block, skipped: true, events: [] };
    const found: unknown[] = [];
    for (const shard of data.shards ?? [])
      for (const item of shard.receipt_execution_outcomes ?? []) {
        const outcome = item.execution_outcome?.outcome;
        if (outcome?.executor_id !== account) continue;
        const succeeded =
          !!outcome.status &&
          typeof outcome.status === "object" &&
          !("Failure" in outcome.status);
        for (const log of outcome.logs ?? []) {
          if (!log.startsWith("EVENT_JSON:")) continue;
          let event: unknown;
          try {
            event = JSON.parse(log.slice("EVENT_JSON:".length));
          } catch {
            event = { unreadable: log.slice(0, 200) };
          }
          found.push({
            tx_hash: item.tx_hash ?? null,
            receipt_id: item.execution_outcome?.id ?? null,
            succeeded,
            event,
          });
        }
      }
    return { block, events: found };
  }

  async function fetchResult(request: Request, count: { archival: number }) {
    switch (request.method) {
      case "view_account":
        return rpc(
          "query",
          {
            request_type: "view_account",
            account_id: request.account,
            block_id: request.block,
          },
          count,
        );
      case "call_function": {
        const result = (await rpc(
          "query",
          {
            request_type: "call_function",
            account_id: request.account,
            method_name: request.fn,
            args_base64: Buffer.from(request.args).toString("base64"),
            block_id: request.block,
          },
          count,
        )) as {
          result?: number[];
          logs?: string[];
          block_height?: number;
          error?: string;
        };
        if (!Array.isArray(result?.result)) return result;
        const text = Buffer.from(result.result).toString("utf8");
        let value: unknown = text;
        try {
          value = JSON.parse(text);
        } catch {
          /* Not JSON: the text itself. */
        }
        return {
          block_height: result.block_height,
          value,
          logs: result.logs ?? [],
        };
      }
      case "block": {
        const block = (await rpc(
          "block",
          request.block === "final"
            ? { finality: "final" }
            : { block_id: request.block },
          count,
        )) as {
          header?: Record<string, unknown>;
          chunks?: unknown[];
          author?: string;
          error?: string;
        };
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
      case "tx": {
        const tx = (await rpc(
          "tx",
          {
            tx_hash: request.hash,
            sender_account_id: request.sender,
            wait_until: "FINAL",
          },
          count,
        )) as {
          status?: unknown;
          transaction?: {
            signer_id?: string;
            receiver_id?: string;
            actions?: unknown[];
          };
          receipts_outcome?: Array<{
            id?: string;
            outcome?: {
              executor_id?: string;
              logs?: string[];
              status?: unknown;
            };
          }>;
          error?: string;
        };
        if (!tx?.transaction) return tx;
        return {
          status: tx.status,
          signer_id: tx.transaction.signer_id,
          receiver_id: tx.transaction.receiver_id,
          actions: tx.transaction.actions,
          receipts: (tx.receipts_outcome ?? []).map((r) => ({
            id: r.id,
            executor_id: r.outcome?.executor_id,
            status: r.outcome?.status,
            logs: r.outcome?.logs ?? [],
          })),
        };
      }
      case "events":
        return events(request.account, request.block);
    }
  }

  return {
    async read(input, run) {
      const request = readRequest(input);
      if (typeof request === "string")
        return { output: `Error: ${request}.`, ran: false };
      let paths: unknown;
      try {
        paths = (JSON.parse(input) as { select?: unknown }).select;
        select({}, paths);
      } catch (error) {
        return { output: `Error: ${(error as Error).message}.`, ran: false };
      }
      const count = reads.get(run) ?? { all: 0, archival: 0 };
      if (count.all >= CHAIN_LIMITS.readsPerRun)
        return {
          output: `Error: this attempt has used its ${CHAIN_LIMITS.readsPerRun} chain reads.`,
          ran: false,
        };
      count.all += 1;
      reads.set(run, count);
      if (reads.size > 1_000) reads.delete(reads.keys().next().value!);
      // "final" changes from block to block, so it is never cached.
      const key = JSON.stringify(request);
      const cacheable = !(
        request.method === "block" && request.block === "final"
      );
      let text = cacheable ? cache.get(key) : undefined;
      if (text === undefined) {
        try {
          text = JSON.stringify(await fetchResult(request, count));
        } catch (error) {
          // A read that gave no result is not charged; it still counts against the attempt's reads.
          return {
            output: `Error: ${(error as Error).message.slice(0, 300)}`,
            ran: false,
          };
        }
        if (cacheable) {
          cache.set(key, text);
          if (cache.size > CHAIN_LIMITS.cacheEntries)
            cache.delete(cache.keys().next().value!);
        }
      }
      const value = select(JSON.parse(text) as unknown, paths);
      const answer = JSON.stringify({ method: request.method, result: value });
      return {
        output:
          answer.length <= CHAIN_LIMITS.maxResultChars
            ? answer
            : `${answer.slice(0, CHAIN_LIMITS.maxResultChars)}... [truncated: the result is ${answer.length} characters; use "select" to keep only the fields you need]`,
        ran: true,
      };
    },
  };
}
