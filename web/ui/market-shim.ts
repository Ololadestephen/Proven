// Wallet libraries expect a few Node globals in the browser. Loaded before everything else in the bundle.
import { Buffer } from "buffer";

const scope = globalThis as unknown as Record<string, unknown>;
scope.Buffer ??= Buffer;
scope.global ??= globalThis;
scope.process ??= {
  env: { NODE_ENV: "production" },
  browser: true,
  version: "",
  nextTick: (callback: () => void) => queueMicrotask(callback),
};
