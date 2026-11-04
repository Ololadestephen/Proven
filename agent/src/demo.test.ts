import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ROOT } from "./config.ts";

test("resume refuses an uncertain creation before invoking any tool or posting another job", async () => {
  const file = `${ROOT}runs/p4-demo-${randomUUID()}.json`;
  await mkdir(`${ROOT}runs`, { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      scripted: true,
      dry_run: false,
      cases: [{ worker: "honest", post_started: true }],
    }),
    { mode: 0o600 },
  );
  try {
    const result = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [`${ROOT}agent/src/demo.ts`, "--resume", file],
        {
          env: {
            ...process.env,
            PROVEN_HONEST_ACCOUNT_ID: "honest.testnet",
            PROVEN_FAKE_ACCOUNT_ID: "fake.testnet",
          },
        },
      );
      let out = "",
        err = "";
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
    assert.match(
      result.err,
      /unknown prior outcome.*Reconcile custody history/,
    );
  } finally {
    await unlink(file);
  }
});
