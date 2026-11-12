import { ReadError, object } from "./model.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Fixed callers choose the URL; request inputs never choose an upstream. */
export async function readJson(
  url: string,
  transport: typeof fetch,
  body?: unknown,
): Promise<unknown> {
  try {
    const response = await transport(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Upstream HTTP failure");
    }
    if (!response.body) throw new Error("Missing body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("Oversized body");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new ReadError(
      "Public upstream data is unavailable or malformed. No transaction was sent.",
    );
  }
}

// The RPC for bounty and snapshot reads, on the network this site serves. PROVEN_MAINNET_RPC_URL
// or PROVEN_TESTNET_RPC_URL moves them to another public endpoint when one rate-limits a busy page.
/** Recorded testnet jobs are read from testnet whatever network the site serves. */
export const TESTNET_RPC =
  process.env.PROVEN_TESTNET_RPC_URL || "https://test.rpc.fastnear.com";
const RPC =
  process.env.NEAR_NETWORK === "mainnet"
    ? process.env.PROVEN_MAINNET_RPC_URL || "https://rpc.mainnet.fastnear.com"
    : process.env.PROVEN_TESTNET_RPC_URL || "https://test.rpc.fastnear.com";
export type RpcMethod = "block" | "query" | "EXPERIMENTAL_tx_status";
/** The whole JSON-RPC answer, so a caller can tell a missing account from a failed read. */
export async function rpcAnswer(
  method: RpcMethod,
  params: unknown,
  transport: typeof fetch,
  url: string = RPC,
) {
  return object(
    await readJson(url, transport, {
      jsonrpc: "2.0",
      id: "proven-read",
      method,
      params,
    }),
  );
}
export async function rpc(
  method: RpcMethod,
  params: unknown,
  transport: typeof fetch,
  url: string = RPC,
) {
  const response = await rpcAnswer(method, params, transport, url);
  if (response.error || !("result" in response))
    throw new ReadError(
      "The NEAR RPC could not return this snapshot. No transaction was sent.",
    );
  return object(response.result);
}
