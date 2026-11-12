import assert from "node:assert/strict";
import test from "node:test";
import { PublicError } from "./errors.ts";
import { isObject, jsonObject, parseJson } from "./json.ts";

test("parseJson returns any JSON value, including arrays and null", () => {
  assert.deepEqual(parseJson('{"a":[1,2]}', "check.json"), { a: [1, 2] });
  assert.deepEqual(parseJson("[1]", "cases.json"), [1]);
  assert.equal(parseJson("null", "x"), null);
});

test("parseJson names the source and never echoes the text", () => {
  const text = '{"key":"ed25519:not-a-real-secret"';
  assert.throws(
    () => parseJson(text, "runs/stage2-setup.json"),
    (error: unknown) => {
      assert.ok(error instanceof PublicError);
      assert.equal(error.message, "runs/stage2-setup.json is not valid JSON.");
      assert.ok(!error.message.includes("not-a-real-secret"));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("jsonObject accepts only a JSON object and throws the given public message", () => {
  assert.deepEqual(jsonObject('{"ok":true}', "bad"), { ok: true });
  for (const text of ["[]", "null", "1", '"s"', "{"]) {
    assert.throws(
      () => jsonObject(text, "The reply was unreadable."),
      (error: unknown) =>
        error instanceof PublicError &&
        error.message === "The reply was unreadable.",
    );
  }
});

test("isObject excludes arrays and null", () => {
  assert.equal(isObject({}), true);
  assert.equal(isObject([]), false);
  assert.equal(isObject(null), false);
  assert.equal(isObject("{}"), false);
});
