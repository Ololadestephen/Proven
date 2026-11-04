#!/usr/bin/env node
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import type { Writable } from "node:stream";
import type { ToolService } from "./cli.ts";
import { publicMessage } from "./errors.ts";

export const MAX_LINE_BYTES = 512 * 1024;
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"] as const;
type Id = string | number | null;
type JsonObject = Record<string, unknown>;

interface RpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(id: Id, code: number, message: string): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultResponse(id: Id, result: unknown): RpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function emptyParams(params: unknown): boolean {
  return (
    params === undefined ||
    (object(params) && Object.keys(params).every((key) => key === "_meta"))
  );
}

function toolResult(value: unknown, isError = false): JsonObject {
  const structuredContent = object(value) ? value : { result: value };
  const text = JSON.stringify(structuredContent);
  return { content: [{ type: "text", text }], structuredContent, isError };
}

/** One handler per connection: negotiation and readiness never cross sessions. */
export function createMcpHandler(
  service: ToolService,
): (line: string) => Promise<RpcResponse | undefined> {
  let initialized = false;
  let ready = false;

  return async (line) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      return errorResponse(null, -32600, "Message exceeds 512 KiB.");
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return errorResponse(null, -32700, "Parse error.");
    }
    if (
      !object(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      return errorResponse(null, -32600, "Invalid request.");
    }
    if (!Object.hasOwn(message, "id")) {
      if (
        message.method === "notifications/initialized" &&
        initialized &&
        emptyParams(message.params)
      )
        ready = true;
      return;
    }
    const id = message.id;
    if (!(
      typeof id === "string" ||
      (typeof id === "number" && Number.isSafeInteger(id))
    )) {
      return errorResponse(null, -32600, "Invalid request id.");
    }
    if (message.params !== undefined && !object(message.params)) {
      return errorResponse(id, -32602, "Invalid parameters.");
    }
    if (message.method === "ping") {
      return emptyParams(message.params)
        ? resultResponse(id, {})
        : errorResponse(id, -32602, "Invalid parameters.");
    }
    if (message.method === "initialize") {
      if (initialized) return errorResponse(id, -32600, "Already initialized.");
      const params = message.params;
      if (
        !object(params) ||
        typeof params.protocolVersion !== "string" ||
        !object(params.capabilities) ||
        !object(params.clientInfo) ||
        typeof params.clientInfo.name !== "string" ||
        typeof params.clientInfo.version !== "string"
      ) {
        return errorResponse(id, -32602, "Invalid initialization parameters.");
      }
      const protocolVersion =
        PROTOCOL_VERSIONS.find(
          (version) => version === params.protocolVersion,
        ) ?? PROTOCOL_VERSIONS[0];
      initialized = true;
      return resultResponse(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "proven", version: "0.1.0" },
      });
    }
    if (!ready)
      return errorResponse(
        id,
        -32000,
        "Initialize the connection before using tools.",
      );
    if (message.method === "tools/list") {
      if (!emptyParams(message.params))
        return errorResponse(
          id,
          -32602,
          "Invalid parameters. Pagination is not used.",
        );
      return resultResponse(id, { tools: service.tools });
    }
    if (message.method !== "tools/call")
      return errorResponse(id, -32601, "Method not found.");
    const params = message.params;
    if (
      !object(params) ||
      typeof params.name !== "string" ||
      (params.arguments !== undefined && !object(params.arguments)) ||
      Object.keys(params).some(
        (key) => !["name", "arguments", "_meta"].includes(key),
      )
    ) {
      return errorResponse(id, -32602, "Invalid tool parameters.");
    }
    if (!service.tools.some((tool) => tool.name === params.name)) {
      return errorResponse(id, -32602, "Unknown tool.");
    }
    try {
      // Actor and execution policy come from local configuration, never MCP parameters.
      const value = await service.executeTool(
        params.name,
        params.arguments ?? {},
      );
      return resultResponse(id, toolResult(value));
    } catch (error) {
      return resultResponse(
        id,
        toolResult({ error: publicMessage(error) }, true),
      );
    }
  };
}

async function writeResponse(
  output: Writable,
  response: RpcResponse | undefined,
): Promise<void> {
  if (response && !output.write(`${JSON.stringify(response)}\n`))
    await once(output, "drain");
}

/** Bounded framing discards an oversized line and resumes at its next newline. */
export async function serveMcp(
  input: AsyncIterable<string | Uint8Array>,
  output: Writable,
  service: ToolService,
): Promise<void> {
  const handle = createMcpHandler(service);
  let pending = Buffer.alloc(0);
  let oversized = false;
  const finishLine = async () => {
    if (oversized) {
      await writeResponse(
        output,
        errorResponse(null, -32600, "Message exceeds 512 KiB."),
      );
    } else {
      let line: string | undefined;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(pending);
      } catch {
        await writeResponse(
          output,
          errorResponse(null, -32700, "Invalid UTF-8 message."),
        );
      }
      if (line !== undefined) await writeResponse(output, await handle(line));
    }
    pending = Buffer.alloc(0);
    oversized = false;
  };
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      if (!oversized) {
        if (pending.length + end - start > MAX_LINE_BYTES) {
          pending = Buffer.alloc(0);
          oversized = true;
        } else {
          pending = Buffer.concat([pending, bytes.subarray(start, end)]);
        }
      }
      if (newline === -1) break;
      await finishLine();
      start = newline + 1;
    }
  }
  if (pending.length || oversized) await finishLine();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await serveMcp(process.stdin, process.stdout, await import("./service.ts"));
  } catch (error) {
    process.stderr.write(`${publicMessage(error)}\n`);
    process.exitCode = 1;
  }
}
