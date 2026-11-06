import { JsonRpcProvider } from "near-api-js";
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
 * one. Only a rate limit moves on: a refusal means the request was not processed, so nothing is repeated
 * that might already have taken effect, and a transaction goes out as the same signed bytes anyway. */
export class FallbackRpcProvider extends JsonRpcProvider {
  private readonly others: JsonRpcProvider[];
  constructor(urls: readonly string[]) {
    super({ url: urls[0]! });
    this.others = urls.slice(1).map((url) => new JsonRpcProvider({ url }));
  }
  override async sendJsonRpc<T>(method: never, params: never): Promise<T> {
    try {
      return (await super.sendJsonRpc(method, params)) as T;
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      for (const [index, other] of this.others.entries()) {
        try {
          return (await other.sendJsonRpc(method, params)) as T;
        } catch (next) {
          if (!isRateLimit(next) || index === this.others.length - 1)
            throw next;
        }
      }
      throw error;
    }
  }
}

export function isRateLimit(error: unknown): boolean {
  return /rate limit|429|too many requests/i.test(String(error));
}
