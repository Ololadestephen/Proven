import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_INPUT_BYTES, runCli } from "./cli.ts";
import type { ToolService } from "./cli.ts";
import { PublicError } from "./errors.ts";

async function invoke(argv: string[], input = "{}", api?: ToolService) {
  let stdout = "";
  let stderr = "";
  const calls: unknown[][] = [];
  const service: ToolService = api ?? {
    tools: [
      {
        name: "job_status",
        description: "Read",
        inputSchema: { type: "object" },
      },
    ],
    executeTool: async (...args) => {
      calls.push(args);
      return { state: "Draft" };
    },
  };
  const code = await runCli(argv, async () => service, {
    input: (async function* () {
      yield input;
    })(),
    output: (text) => {
      stdout += text;
    },
    diagnostic: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr, calls };
}

test("help succeeds without loading service or reading stdin", async () => {
  let help = "";
  const code = await runCli(
    ["--help"],
    async () => {
      throw new Error("must not load");
    },
    {
      input: (async function* () {
        throw new Error("must not read");
      })(),
      output: (text) => {
        help += text;
      },
      diagnostic: () => assert.fail("unexpected diagnostic"),
    },
  );
  assert.equal(code, 0);
  assert.match(help, /Usage: proven/);
});

test("inline JSON and flags reach the shared service and output is JSON", async () => {
  const result = await invoke([
    "job_status",
    '{"job_id":"8"}',
    "--actor",
    "honest",
    "--dry-run",
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, [
    ["job_status", { job_id: "8" }, { actor: "honest", dryRun: true }],
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { state: "Draft" });
  assert.equal(result.stderr, "");
});

test("missing inline JSON reads stdin; @file reads the named JSON file", async () => {
  assert.deepEqual(
    (await invoke(["job_status"], '{"job_id":"9"}')).calls[0]?.[1],
    { job_id: "9" },
  );
  const directory = await mkdtemp(join(tmpdir(), "proven-cli-"));
  try {
    const path = join(directory, "input.json");
    await writeFile(path, '{"job_id":"10"}');
    assert.deepEqual(
      (await invoke(["job_status", `@${path}`], "not used")).calls[0]?.[1],
      { job_id: "10" },
    );
    await writeFile(path, "x".repeat(MAX_INPUT_BYTES + 1));
    assert.match(
      (await invoke(["job_status", `@${path}`])).stderr,
      /exceeds 512 KiB/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown commands, flags, repeated flags, and missing actor fail without executing", async () => {
  for (const argv of [
    [],
    ["missing"],
    ["job_status", "--unknown"],
    ["job_status", "--dry-run", "--dry-run"],
    ["job_status", "--actor"],
    ["job_status", "--actor", "owner"],
    ["job_status", "{}", "{}"],
    ["job_status", "--actor", "buyer", "--actor", "fake"],
  ]) {
    const result = await invoke(argv);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.equal(result.stdout, "");
  }
});

test("invalid JSON, non-object input, and oversized UTF-8 are rejected without echoing input", async () => {
  for (const input of [
    '{"PRIVATE_CHECK_CONTENT":',
    "null",
    "[]",
    "1",
    `{"private":"${"é".repeat(MAX_INPUT_BYTES / 2)}"}`,
  ]) {
    const result = await invoke(["job_status"], input);
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("PRIVATE_CHECK_CONTENT"), false);
  }
  assert.equal(
    (
      await invoke([
        "job_status",
        `{"private":"${"x".repeat(MAX_INPUT_BYTES)}"}`,
      ])
    ).code,
    1,
  );
});

test("file errors and tool exceptions cannot expose payloads or paths", async () => {
  const missing = await invoke([
    "job_status",
    "@/missing/PRIVATE_CHECK_CONTENT.json",
  ]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr.includes("PRIVATE_CHECK_CONTENT"), false);
  const failed = await invoke(["job_status"], "{}", {
    tools: [{ name: "job_status", description: "Read", inputSchema: {} }],
    executeTool: async () => {
      throw new Error("PRIVATE_CHECK_CONTENT");
    },
  });
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr.includes("PRIVATE_CHECK_CONTENT"), false);
});

test("declared public service errors remain useful diagnostics", async () => {
  const result = await invoke(["job_status"], "{}", {
    tools: [{ name: "job_status", description: "Read", inputSchema: {} }],
    executeTool: async () => {
      throw new PublicError(
        "The selected actor cannot perform this operation.",
      );
    },
  });
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "The selected actor cannot perform this operation.\n",
  );
});

test("stdin accepts the exact byte limit and rejects invalid UTF-8", async () => {
  assert.equal(
    (await invoke(["job_status"], `{}`.padEnd(MAX_INPUT_BYTES))).code,
    0,
  );
  let diagnostics = "";
  const code = await runCli(
    ["job_status"],
    async () => ({
      tools: [{ name: "job_status", description: "Read", inputSchema: {} }],
      executeTool: async () => assert.fail("invalid UTF-8 reached the service"),
    }),
    {
      input: (async function* () {
        yield Buffer.from([0xff]);
      })(),
      output: () => assert.fail("unexpected stdout"),
      diagnostic: (text) => {
        diagnostics += text;
      },
    },
  );
  assert.equal(code, 1);
  assert.equal(diagnostics, "Input must be valid UTF-8 JSON.\n");
});
