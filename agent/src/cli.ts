#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { publicMessage } from "./errors.ts";

export const MAX_INPUT_BYTES = 512 * 1024;

export interface ToolService {
  tools: readonly {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  /** Signed tools resolve to a CallResult. `pending` or `failed` means the transaction exists but did
   * not succeed, so reconcile it before acting again. A throw means nothing was submitted. */
  executeTool(
    name: string,
    args: unknown,
    options?: {
      actor?: "buyer" | "honest" | "fake" | "agent";
      dryRun?: boolean;
    },
  ): Promise<unknown>;
}

interface CliIo {
  input: AsyncIterable<string | Uint8Array>;
  output(text: string): void;
  diagnostic(text: string): void;
}

interface Command {
  name: string;
  json?: string;
  actor?: "buyer" | "honest" | "fake" | "agent";
  dryRun: boolean;
}

class InputError extends Error {}

const HELP = `Usage: proven <tool_name> [JSON|@file] [--dry-run] [--actor buyer|honest|fake|agent]

Without JSON or @file, read a JSON object from standard input.
Input is limited to 512 KiB. --dry-run plans the operation without signing.
Use the tool names and JSON arguments documented in skill.md.
`;

function parseCommand(argv: readonly string[]): Command | undefined {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return;
  const name = argv[0];
  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new InputError("Invalid command line. Use --help for usage.");
  }
  const command: Command = { name, dryRun: false };
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--dry-run" && !command.dryRun) {
      command.dryRun = true;
    } else if (value === "--actor" && command.actor === undefined) {
      const actor = argv[++index];
      if (
        actor !== "buyer" &&
        actor !== "honest" &&
        actor !== "fake" &&
        actor !== "agent"
      ) {
        throw new InputError(
          "Invalid actor. Choose buyer, honest, fake, or agent.",
        );
      }
      command.actor = actor;
    } else if (!value.startsWith("-") && command.json === undefined) {
      command.json = value;
    } else {
      throw new InputError("Invalid command line. Use --help for usage.");
    }
  }
  return command;
}

async function readBounded(
  input: AsyncIterable<string | Uint8Array>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES)
      throw new InputError("JSON input exceeds 512 KiB.");
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new InputError("Input must be valid UTF-8 JSON.");
  }
}

async function readArguments(
  command: Command,
  input: CliIo["input"],
): Promise<unknown> {
  let text: string;
  if (command.json?.startsWith("@")) {
    if (command.json.length === 1)
      throw new InputError("Provide a JSON file after @.");
    try {
      text = await readBounded(createReadStream(command.json.slice(1)));
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError("Cannot read the JSON input file.");
    }
  } else if (command.json !== undefined) {
    if (Buffer.byteLength(command.json) > MAX_INPUT_BYTES) {
      throw new InputError("JSON input exceeds 512 KiB.");
    }
    text = command.json;
  } else {
    text = await readBounded(input);
  }
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    throw new InputError("Input must be valid JSON.");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new InputError("Tool arguments must be a JSON object.");
  }
  return args;
}

/** A submitted transaction that failed or whose outcome is unknown. */
export function unsettled(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const { failed, pending } = result as { failed?: unknown; pending?: unknown };
  return failed === true || pending === true;
}

export async function runCli(
  argv: readonly string[],
  loadService: () => Promise<ToolService>,
  io: CliIo,
): Promise<number> {
  try {
    const command = parseCommand(argv);
    if (!command) {
      io.output(HELP);
      return 0;
    }
    const service = await loadService();
    if (!service.tools.some((tool) => tool.name === command.name)) {
      throw new InputError(
        "Unknown tool. See skill.md for available tool names.",
      );
    }
    const args = await readArguments(command, io.input);
    const result = await service.executeTool(command.name, args, {
      actor: command.actor,
      dryRun: command.dryRun,
    });
    const output = JSON.stringify(result);
    if (output === undefined)
      throw new Error("Tool returned no serializable result.");
    io.output(`${output}\n`);
    return unsettled(result) ? 1 : 0;
  } catch (error) {
    io.diagnostic(
      `${error instanceof InputError ? error.message : publicMessage(error)}\n`,
    );
    return 1;
  }
}

// The entry point, also when the path to it passes through a symlink.
if (import.meta.main) {
  process.exitCode = await runCli(
    process.argv.slice(2),
    () => import("./service.ts"),
    {
      input: process.stdin,
      output: (text) => {
        process.stdout.write(text);
      },
      diagnostic: (text) => {
        process.stderr.write(text);
      },
    },
  );
}
