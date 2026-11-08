import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { refuseLegacyDemo } from "./demo.ts";
import { PublicError } from "./errors.ts";

const entry = fileURLToPath(new URL("./demo.ts", import.meta.url));
const refusal = /The legacy scripted demo is retired/;

test("importing the retired demo has no side effects and its refusal is a public error", () => {
  assert.throws(refuseLegacyDemo, (error) => {
    assert.ok(error instanceof PublicError);
    assert.match(error.message, refusal);
    assert.match(error.message, /one-signature post_bid workflow/);
    return true;
  });
});

for (const args of [
  [],
  ["--dry-run"],
  ["--resume", "/no-such-private-evidence.json"],
  ["--operator-compute"],
  ["--operator-compute", "--dry-run"],
  ["--operator-compute", "--resume", "/no-such-private-evidence.json"],
]) {
  test(`the retired demo refuses ${args.join(" ") || "a fresh run"} before configuration or evidence loading`, async () => {
    const result = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((resolve, reject) => {
      // An empty environment contains no wallet configuration or service credentials.
      const child = spawn(process.execPath, [entry, ...args], {
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (data) => {
        out += data;
      });
      child.stderr.on("data", (data) => {
        err += data;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out, err }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.out, "");
    assert.match(result.err, refusal);
    assert.match(
      result.err,
      /No configuration, keys, or private evidence were loaded/,
    );
    assert.match(result.err, /no transaction was sent/);
    assert.ok(!result.err.includes("ENOENT"));
  });
}
