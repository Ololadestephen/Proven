// The pre-one-signature workflow was scripted and is retained only as historical evidence.
// Refuse before loading configuration, keys, private inputs, or any service client.
import { PublicError, publicMessage } from "./errors.ts";

export function refuseLegacyDemo(): never {
  throw new PublicError(
    "The legacy scripted demo is retired. It uses the old per-worker funding flow and cannot run on the current contracts. Use the one-signature post_bid workflow instead. No configuration, keys, or private evidence were loaded, and no transaction was sent.",
  );
}

if (import.meta.main) {
  try {
    refuseLegacyDemo();
  } catch (error) {
    console.error(publicMessage(error));
    process.exitCode = 1;
  }
}
