#!/usr/bin/env node
import { runCli } from "./cli.ts";
import { createOneClick } from "./oneclick.ts";
import { PublicError } from "./errors.ts";

/** Separate from the signing tools: even without --dry-run this can never pay. */
export function settlementService(client = createOneClick()) {
  return {
    tools: [
      {
        name: "quote",
        description: "Fetch a real dry quote; never create a deposit address.",
        inputSchema: {},
      },
      {
        name: "status",
        description: "Read an existing 1Click deposit's API status.",
        inputSchema: {},
      },
    ],
    async executeTool(name: string, args: unknown) {
      if (name === "quote") return client.dryQuote(args);
      if (
        name === "status" &&
        args &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        Object.keys(args).every((key) =>
          ["deposit_address", "deposit_memo"].includes(key),
        ) &&
        "deposit_address" in args
      )
        return client.status(
          args.deposit_address,
          "deposit_memo" in args ? args.deposit_memo : undefined,
        );
      throw new PublicError(
        "Use quote with route arguments, or status with deposit_address and optional deposit_memo. This CLI cannot execute settlements.",
      );
    },
  };
}

// The entry point, also when the path to it passes through a symlink.
if (import.meta.main) {
  process.exitCode = await runCli(
    process.argv.slice(2),
    async () => settlementService(),
    {
      input: process.stdin,
      output: (text) => process.stdout.write(text),
      diagnostic: (text) => process.stderr.write(text),
    },
  );
}
