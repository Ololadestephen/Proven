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

const RPC = "https://test.rpc.fastnear.com";
export type RpcMethod = "block" | "query" | "EXPERIMENTAL_tx_status";
/** The whole JSON-RPC answer, so a caller can tell a missing account from a failed read. */
export async function rpcAnswer(
  method: RpcMethod,
  params: unknown,
  transport: typeof fetch,
) {
  return object(
    await readJson(RPC, transport, {
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
) {
  const response = await rpcAnswer(method, params, transport);
  if (response.error || !("result" in response))
    throw new ReadError(
      "Testnet RPC could not return this snapshot. No transaction was sent.",
    );
  return object(response.result);
}
