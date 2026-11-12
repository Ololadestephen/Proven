import assert from "node:assert/strict";
import test from "node:test";
import { PublicError, publicMessage, safeCode, unreachable } from "./errors.ts";

test("a failure's safe code is a timeout, a system code or a class name, never its message", () => {
  const timeout = new Error("https://secret.example/key=abc");
  timeout.name = "TimeoutError";
  assert.equal(safeCode(timeout), "timeout");
  const refused = new TypeError("fetch failed", {
    cause: { code: "ECONNREFUSED" },
  });
  assert.equal(safeCode(refused), "ECONNREFUSED");
  const odd = new TypeError("fetch failed", {
    cause: { code: "not a code: key=abc" },
  });
  assert.equal(safeCode(odd), "TypeError");
  assert.equal(safeCode("text"), "unknown");
});

test("an unreachable service is a public error that keeps its cause", () => {
  const original = new TypeError(
    "fetch failed https://api.github.com/?token=x",
    {
      cause: { code: "ENOTFOUND" },
    },
  );
  const error = unreachable("GitHub", original);
  assert.ok(error instanceof PublicError);
  assert.equal(
    publicMessage(error),
    "GitHub could not be reached (ENOTFOUND).",
  );
  assert.equal(error.cause, original);
  assert.doesNotMatch(error.message, /token/);
});
