// Runs one skill request in a worker thread with a time limit and small heap, so a slow request (a long
// WebAssembly run, a regular expression that backtracks) stops without holding up the service.
import { Worker } from "node:worker_threads";

const HEAP_LIMITS = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
};

/** `source` is a worker file, or worker code text when `evalCode` is true. The worker posts one message,
 * which is the answer. A worker that times out, throws or exits first is a failure. */
export function runInWorker<T = string>(
  source: string | URL,
  workerData: unknown,
  timeLimitMs: number,
  label: string,
  evalCode = false,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(source, {
      eval: evalCode,
      workerData,
      resourceLimits: HEAP_LIMITS,
    });
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      done();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`The ${label} took too long.`))),
      timeLimitMs,
    );
    worker.once("message", (answer: T) => finish(() => resolve(answer)));
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) =>
      finish(() => reject(new Error(`The ${label} stopped (${code}).`))),
    );
  });
}
