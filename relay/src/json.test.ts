import assert from "node:assert/strict";
import test from "node:test";
import { JsonInputError, parseJsonObject, verifierFromCheck } from "./json.ts";

test("private malformed checks fail with a clear error without exposing input", () => {
  const secret = '{"private":"do not expose';
  assert.throws(
    () => verifierFromCheck(secret),
    (error: unknown) => {
      assert.ok(error instanceof JsonInputError);
      assert.equal(error.message, "Check is not valid JSON.");
      assert.ok(!error.message.includes("private"));
      return true;
    },
  );
});

test("JSON alone is not a usable check or private record", () => {
  for (const text of ["null", "[]", "true", '"ok"'])
    assert.throws(
      () => parseJsonObject(text, "Private record"),
      JsonInputError,
    );
  for (const value of [{}, { verifier: true }, { verifier: "success" }])
    assert.throws(
      () => verifierFromCheck(JSON.stringify(value)),
      /valid verifier hash/,
    );
  const hash = "ab".repeat(32);
  assert.equal(verifierFromCheck(JSON.stringify({ verifier: hash })), hash);
});
