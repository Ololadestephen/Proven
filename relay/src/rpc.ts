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
