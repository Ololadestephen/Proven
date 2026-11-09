import { JsonRpcProvider } from "near-api-js";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";

/** Match the SDK instance used by this provider, including callers in sibling packages. */
export function isAbsentAccount(error: unknown): boolean {
  return error instanceof AccountDoesNotExistError;
}
import { TESTNET_RPC_URLS } from "./config.ts";

/** Explicit testnet routing: broadcast bytes to one endpoint; read state from another. */
export class DemoRpcProvider extends JsonRpcProvider {
  private readonly writer: JsonRpcProvider;
  constructor(readUrl: string, broadcastUrl = readUrl) {
    if (![readUrl, broadcastUrl].every((url) => TESTNET_RPC_URLS.includes(url)))
      throw new Error("Demo RPC endpoints must be approved testnet URLs");
    super({ url: readUrl }, { retries: 1 });
    this.writer = new JsonRpcProvider({ url: broadcastUrl }, { retries: 1 });
  }
  override sendJsonRpc: JsonRpcProvider["sendJsonRpc"] = (method, params) =>
    method === "broadcast_tx_async"
      ? this.writer.sendJsonRpc(method, params)
      : super.sendJsonRpc(method, params);
}

/** A public RPC can rate-limit a busy service, so a request it refuses that way goes to the next approved
 * one. Callers can also opt into transient read failover. The extra fallback applies only to
 * query requests, which cannot submit a transaction. */
export class FallbackRpcProvider extends JsonRpcProvider {
  private readonly others: JsonRpcProvider[];
  private readonly retryReadFailures: boolean;
  constructor(urls: readonly string[], retryReadFailures = false) {
    const options = retryReadFailures ? { retries: 1 } : undefined;
    super({ url: urls[0]! }, options);
    this.retryReadFailures = retryReadFailures;
    this.others = urls
      .slice(1)
      .map((url) => new JsonRpcProvider({ url }, options));
  }
  override async sendJsonRpc<T>(method: never, params: never): Promise<T> {
    const canRetry = (error: unknown) =>
      isRateLimit(error) ||
      (this.retryReadFailures &&
        method === "query" &&
        isTransientReadError(error));
    try {
      return (await super.sendJsonRpc(method, params)) as T;
    } catch (error) {
      if (!canRetry(error)) throw error;
      for (const [index, other] of this.others.entries()) {
        try {
          return (await other.sendJsonRpc(method, params)) as T;
        } catch (next) {
          if (!canRetry(next) || index === this.others.length - 1) throw next;
        }
      }
      throw error;
    }
  }
}

export function isRateLimit(error: unknown): boolean {
  return /rate limit|429|too many requests/i.test(String(error));
}

function isTransientReadError(error: unknown): boolean {
  if (error instanceof Error && [502, 503, 504].includes(Number(error.cause)))
    return true;
  return /fetch failed|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|temporarily unavailable|bad gateway|service unavailable|gateway timeout|(?:HTTP|status(?: code)?)[: ]+50[234]/i.test(
    String(error),
  );
}
