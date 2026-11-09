import assert from "node:assert/strict";
import test from "node:test";
import { runInWorker } from "./worker-run.ts";

const POST = `require("node:worker_threads").parentPort.postMessage(require("node:worker_threads").workerData);`;

test("the worker's one message is the answer, structured values included", async () => {
  assert.equal(await runInWorker(POST, "hello", 5_000, "test", true), "hello");
  assert.deepEqual(
    await runInWorker<{ ok: boolean; n: number[] }>(
      POST,
      { ok: true, n: [1, 2] },
      5_000,
      "test",
      true,
    ),
    { ok: true, n: [1, 2] },
  );
});

test("a worker that runs past its time limit is stopped and named", async () => {
  await assert.rejects(
    runInWorker("for (;;) {}", null, 100, "loop", true),
    /The loop took too long/,
  );
});

test("a worker that throws or exits without answering is a failure", async () => {
  await assert.rejects(
    runInWorker('throw new Error("broken")', null, 5_000, "test", true),
    /broken/,
  );
  await assert.rejects(
    runInWorker("process.exit(3)", null, 5_000, "quiet", true),
    /The quiet stopped \(3\)/,
  );
});
