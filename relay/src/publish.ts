// Publishes a verifier build to FastFS, the way `outlayer upload` does (format from
// out-layer/outlayer-cli src/commands/upload.rs): one `__fastdata_fastfs` call per chunk to the
// OutLayer contract, with a Borsh payload. The call fails on purpose after being recorded on chain;
// FastFS's indexer reads its arguments. OutLayer's workers refuse bytes that do not match the hash.
//
//   npm run publish-verifier -- <file.wasm>

import { readFileSync } from "node:fs";
import { sha256Hex } from "./hash.ts";
import { actions } from "near-api-js";
import { loadConfig } from "./config.ts";
import { relayAccount } from "./near.ts";

const CHUNK_SIZE = 1 << 20;
const TGAS = 1_000_000_000_000n;
/** The CLI's epoch for chunk nonces, so a re-upload supersedes an earlier one. */
const NONCE_EPOCH_SECS = 1_769_376_240;

function borshString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

/** Borsh `FastfsData::Partial`: one chunk of a file larger than a chunk (or a whole small file). */
export function partialPayload(
  path: string,
  offset: number,
  fullSize: number,
  mimeType: string,
  chunk: Buffer,
  nonce: number,
): Buffer {
  return Buffer.concat([
    Buffer.from([1]),
    borshString(path),
    u32(offset),
    u32(fullSize),
    borshString(mimeType),
    u32(chunk.length),
    chunk,
    u32(nonce),
  ]);
}

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error("usage: publish-verifier <file.wasm>");
    process.exit(2);
  }
  const config = loadConfig();
  const account = relayAccount(config);
  const content = readFileSync(file);
  const hash = sha256Hex(content);
  const path = `${hash}.wasm`;
  const nonce = Math.floor(Date.now() / 1000) - NONCE_EPOCH_SECS;
  for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
    const chunk = content.subarray(offset, offset + CHUNK_SIZE);
    const payload = partialPayload(
      path,
      offset,
      content.length,
      "application/wasm",
      chunk,
      nonce,
    );
    const response = await account.signAndSendTransaction({
      receiverId: config.outlayerContract,
      actions: [
        actions.functionCall(
          "__fastdata_fastfs",
          new Uint8Array(payload),
          1n * TGAS,
          0n,
        ),
      ],
      throwOnFailure: false,
    });
    console.error(
      `chunk at ${offset}: ${chunk.length} bytes, tx ${response.transaction.hash}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        sha256: hash,
        url: `https://${config.outlayerContract === "outlayer.near" ? "main" : "test"}.fastfs.io/${account.accountId}/${config.outlayerContract}/${path}`,
        bytes: content.length,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(`publish: ${error.message}`);
    process.exit(1);
  });
}
