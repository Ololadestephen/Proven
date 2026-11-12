import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicError } from "../src/errors.ts";
import { loadJournal, saveEnv, writeJournal } from "./setup-common.ts";

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "proven-setup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("saveEnv replaces an existing line, appends a new one and keeps the rest", (t) => {
  const path = join(scratch(t), ".env");
  writeFileSync(path, "A=1\nKEY_V2=old\nB=2\n");
  const env: Record<string, string | undefined> = { A: "1", KEY_V2: "old" };
  saveEnv(path, env, { KEY_V2: "new", C_3: "x" });
  assert.equal(readFileSync(path, "utf8"), "A=1\nB=2\nKEY_V2=new\nC_3=x\n");
  assert.deepEqual(env, { A: "1", KEY_V2: "new", C_3: "x" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("saveEnv refuses a bad name or a multi-line value and changes nothing", (t) => {
  const path = join(scratch(t), ".env");
  writeFileSync(path, "A=1\n");
  const env: Record<string, string | undefined> = { A: "1" };
  const bad: Record<string, string>[] = [
    { "A=1\nB": "x" },
    { lower: "x" },
    { "A.*": "x" },
    { OK: "x", INJECT: "1\nOTHER=2" },
  ];
  for (const values of bad) {
    assert.throws(() => saveEnv(path, env, values), PublicError);
  }
  assert.equal(readFileSync(path, "utf8"), "A=1\n");
  assert.deepEqual(env, { A: "1" });
});

test("loadJournal starts empty, reads an object, and names a damaged file", (t) => {
  const dir = scratch(t);
  const path = join(dir, "setup.json");
  assert.deepEqual(loadJournal(path), {});
  writeJournal(path, { deployed: "abc", steps: [1, 2] });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(loadJournal(path), { deployed: "abc", steps: [1, 2] });
  for (const text of ['{"deployed":', "[]", "null"]) {
    writeFileSync(path, text);
    assert.throws(
      () => loadJournal(path),
      (error: unknown) =>
        error instanceof PublicError && error.message.startsWith(path),
    );
  }
});
