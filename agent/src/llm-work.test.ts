import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeliverable } from "./llm-work.ts";

test("one JSON object is a deliverable, with or without one code fence", () => {
  assert.equal(parseDeliverable('{"rows":[]}').deliverable, '{"rows":[]}');
  assert.equal(parseDeliverable('```json\n{"rows":[]}\n```').deliverable, '{"rows":[]}');
});

test("anything else is refused and never delivered", () => {
  assert.equal(parseDeliverable("Here is the answer: {}").refusal, "not_json");
  assert.equal(parseDeliverable("[1,2]").refusal, "not_an_object");
  assert.equal(parseDeliverable("null").refusal, "not_an_object");
  assert.equal(parseDeliverable(`{"a":"${"x".repeat(70_000)}"}`).refusal, "too_large");
});
