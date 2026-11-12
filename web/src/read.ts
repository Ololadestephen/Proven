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
    ? process.env.PROVEN_MAINNET_RPC_URL || "https://free.rpc.fastnear.com"
    : process.env.PROVEN_TESTNET_RPC_URL || "https://test.rpc.fastnear.com";
/** The same public endpoints the market reads fall back to, in order. */
const RPC_ENDPOINTS =
  process.env.NEAR_NETWORK === "mainnet"
    ? [RPC, "https://rpc.intea.rs", "https://rpc.mainnet.near.org"]
    : [RPC, "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"];
export type RpcMethod = "block" | "query" | "EXPERIMENTAL_tx_status";
/** The whole JSON-RPC answer, so a caller can tell a missing account from a failed read. Without a
 * fixed url, a failed request (a rate limit, an outage, unreadable data) moves to the next public
 * endpoint; an answer from the chain, including an error answer, is returned as it is. */
export async function rpcAnswer(
  method: RpcMethod,
  params: unknown,
  transport: typeof fetch,
  url?: string,
) {
  const body = { jsonrpc: "2.0", id: "proven-read", method, params };
  const endpoints = url ? [url] : RPC_ENDPOINTS;
  let failure: unknown;
  for (const endpoint of endpoints) {
    try {
      return object(await readJson(endpoint, transport, body));
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
export async function rpc(
  method: RpcMethod,
  params: unknown,
  transport: typeof fetch,
  url?: string,
) {
  const response = await rpcAnswer(method, params, transport, url);
  if (response.error || !("result" in response))
    throw new ReadError(
      "The NEAR RPC could not return this snapshot. No transaction was sent.",
    );
  return object(response.result);
}
