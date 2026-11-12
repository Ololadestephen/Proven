import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ToolService } from "./cli.ts";
import { createMcpHandler, MAX_LINE_BYTES, serveMcp } from "./mcp.ts";
import { PublicError } from "./errors.ts";

const service: ToolService = {
  tools: [
    {
      name: "job_status",
      description: "Read a job.",
      inputSchema: { type: "object" },
    },
  ],
  executeTool: async (_name, args) => ({ received: args }),
};
const request = (method: string, params?: unknown, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const initialization = (protocolVersion = "2025-11-25") =>
  request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "transport-test", version: "1" },
  });

async function ready(api = service) {
  const handle = createMcpHandler(api);
  await handle(initialization());
  await handle(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  return handle;
}

test("initialize negotiates each supported version and falls back to the newest", async () => {
  for (const version of [
    "2025-11-25",
    "2025-06-18",
    "2024-11-05",
    "2099-01-01",
  ]) {
    const response = await createMcpHandler(service)(initialization(version));
    assert.deepEqual(response?.result, {
      protocolVersion: version === "2099-01-01" ? "2025-11-25" : version,
      capabilities: { tools: {} },
      serverInfo: { name: "proven", version: "0.1.0" },
    });
  }
});

test("initialization validates parameters, runs once, and gates tools until ready", async () => {
  const handle = createMcpHandler(service);
  assert.equal((await handle(request("tools/list")))?.error?.code, -32000);
  assert.equal((await handle(request("initialize", {})))?.error?.code, -32602);
  await handle(initialization());
  assert.equal((await handle(request("tools/list")))?.error?.code, -32000);
  assert.equal((await handle(initialization()))?.error?.code, -32600);
  await handle('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.deepEqual((await handle(request("tools/list")))?.result, {
    tools: service.tools,
  });
});

test("notifications never receive replies or execute tools", async () => {
  let calls = 0;
  const handle = await ready({
    ...service,
    executeTool: async () => {
      calls++;
      return {};
    },
  });
  for (const method of [
    "notifications/cancelled",
    "unknown",
    "tools/call",
    "ping",
  ]) {
    assert.equal(
      await handle(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          params: { name: "job_status" },
        }),
      ),
      undefined,
    );
  }
  assert.equal(calls, 0);
});

test("ping is available before initialization; unknown methods have standard errors", async () => {
  assert.deepEqual(
    (await createMcpHandler(service)(request("ping")))?.result,
    {},
  );
  const handle = await ready();
  assert.equal((await handle(request("unknown")))?.error?.code, -32601);
  assert.equal((await handle(request("ping", [])))?.error?.code, -32602);
  assert.equal(
    (await handle(request("tools/list", { cursor: "unsupported" })))?.error
      ?.code,
    -32602,
  );
});

test("malformed requests redact private input and use standard errors", async () => {
  const handle = await ready();
  const secret = "PRIVATE_CHECK_CONTENT";
  for (const [line, code] of [
    [`{"${secret}":`, -32700],
    [
      JSON.stringify({ jsonrpc: "2.0", id: { secret }, method: "ping" }),
      -32600,
    ],
    [JSON.stringify([{ jsonrpc: "2.0", id: secret, method: "ping" }]), -32600],
    [JSON.stringify({ jsonrpc: "1.0", id: secret, method: "ping" }), -32600],
  ] as const) {
    const result = await handle(line);
    assert.equal(result?.error?.code, code);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("tool calls return structured JSON and never forward an actor option", async () => {
  const calls: unknown[][] = [];
  const handle = await ready({
    ...service,
    executeTool: async (...args) => {
      calls.push(args);
      return { state: "Draft" };
    },
  });
  const response = await handle(
    request(
      "tools/call",
      { name: "job_status", arguments: { job_id: "7" } },
      "read-7",
    ),
  );
  assert.equal(response?.id, "read-7");
  assert.deepEqual(response?.result, {
    content: [{ type: "text", text: '{"state":"Draft"}' }],
    structuredContent: { state: "Draft" },
    isError: false,
  });
  assert.deepEqual(calls, [["job_status", { job_id: "7" }]]);
  for (const injection of [
    { actor: "buyer" },
    { options: { actor: "buyer" } },
    { dryRun: false },
  ]) {
    assert.equal(
      (
        await handle(
          request("tools/call", {
            name: "job_status",
            arguments: {},
            ...injection,
          }),
        )
      )?.error?.code,
      -32602,
    );
  }
  assert.equal(calls.length, 1);
});

test("invalid call parameters and unknown tools never execute", async () => {
  let calls = 0;
  const handle = await ready({
    ...service,
    executeTool: async () => {
      calls++;
      return {};
    },
  });
  for (const params of [
    undefined,
    {},
    { name: 7 },
    { name: "missing" },
    { name: "job_status", arguments: [] },
    { name: "job_status", arguments: null },
  ]) {
    assert.equal(
      (await handle(request("tools/call", params)))?.error?.code,
      -32602,
    );
  }
  assert.equal(calls, 0);
});

test("tool failures and serialization failures are tool errors with private details redacted", async () => {
  for (const executeTool of [
    async () => {
      throw new Error("PRIVATE_CHECK_CONTENT");
    },
    async () => ({ secret: 1n }),
  ]) {
    const handle = await ready({ ...service, executeTool });
    const response = await handle(
      request("tools/call", { name: "job_status" }),
    );
    assert.equal((response?.result as Record<string, unknown>).isError, true);
    assert.equal(
      JSON.stringify(response).includes("PRIVATE_CHECK_CONTENT"),
      false,
    );
    assert.equal(response?.error, undefined);
  }
});

test("bounds count UTF-8 bytes rather than JavaScript characters", async () => {
  const response = await createMcpHandler(service)(
    "é".repeat(MAX_LINE_BYTES / 2 + 1),
  );
  assert.equal(response?.error?.code, -32600);
  assert.deepEqual(
    (await createMcpHandler(service)(request("ping").padEnd(MAX_LINE_BYTES)))
      ?.result,
    {},
  );
});

test("declared public service errors are recoverable tool errors", async () => {
  const handle = await ready({
    ...service,
    executeTool: async () => {
      throw new PublicError(
        "The selected actor cannot perform this operation.",
      );
    },
  });
  const response = await handle(request("tools/call", { name: "job_status" }));
  assert.deepEqual(
    (response?.result as Record<string, unknown>).structuredContent,
    { error: "The selected actor cannot perform this operation." },
  );
  assert.equal((response?.result as Record<string, unknown>).isError, true);
});

async function framed(chunks: Uint8Array[]) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });
  await serveMcp(
    (async function* () {
      yield* chunks;
    })(),
    output,
    service,
  );
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("framing supports split lines, CRLF, multiple lines, and a final line without newline", async () => {
  const bytes = Buffer.from(
    `${request("ping")}\r\n${request("ping", undefined, 2)}`,
  );
  const responses = await framed([bytes.subarray(0, 4), bytes.subarray(4)]);
  assert.deepEqual(
    responses.map((response) => response.id),
    [1, 2],
  );
});

test("oversized lines and invalid UTF-8 are rejected and the next line works", async () => {
  const responses = await framed([
    Buffer.alloc(MAX_LINE_BYTES, 120),
    Buffer.from(`PRIVATE\n${request("ping")}\n`),
    Buffer.from([0xff, 0x0a]),
    Buffer.from(`${request("ping", undefined, 2)}\n`),
  ]);
  assert.deepEqual(
    responses.map((response) => response.error?.code ?? response.id),
    [-32600, 1, -32700, 2],
  );
  assert.equal(JSON.stringify(responses).includes("PRIVATE"), false);
});

test("real child stdio sends protocol-only stdout and exits on stdin close", async () => {
  const mcpUrl = new URL("./mcp.ts", import.meta.url).href;
  const fixture = `import {serveMcp} from ${JSON.stringify(mcpUrl)};
await serveMcp(process.stdin, process.stdout, {
tools:[{name:'job_status',description:'Read',inputSchema:{type:'object'}}],
executeTool:async()=>({state:'Draft'})});`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", fixture],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(
    `${initialization()}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n${request("tools/call", { name: "job_status" }, 2)}\n`,
  );
  assert.equal(await finished, 0);
  assert.equal(stderr, "");
  const replies = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  assert.equal(replies[1].result.structuredContent.state, "Draft");
});

test("a submitted call that failed or is unknown is a tool error that still carries its transaction", async () => {
  for (const [value, isError] of [
    [{ transaction_hash: "t", failed: true }, true],
    [{ transaction_hash: "t", pending: true }, true],
    [{ transaction_hash: "t" }, false],
  ] as const) {
    const handle = await ready({ ...service, executeTool: async () => value });
    const response = await handle(
      request("tools/call", { name: "job_status" }),
    );
    const result = response?.result as Record<string, unknown>;
    assert.equal(result.isError, isError);
    assert.deepEqual(result.structuredContent, value);
  }
});
