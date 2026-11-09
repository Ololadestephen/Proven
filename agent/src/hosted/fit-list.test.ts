import assert from "node:assert/strict";
import test from "node:test";
import { fitList, MAX_SKILL_RESULT } from "./fit-list.ts";

test("a list that fits is returned whole, with no shown or total", () => {
  assert.equal(
    fitList([1, 2, 3], (shown) => ({ items: shown })),
    '{"items":[1,2,3]}',
  );
});

test("a list that does not fit is shortened, and says how much is shown", () => {
  const entries = Array.from({ length: 1000 }, (_, i) => `entry-${i}`);
  const text = fitList(entries, (shown) => ({
    count: entries.length,
    items: shown,
  }));
  assert.ok(text.length <= MAX_SKILL_RESULT);
  const value = JSON.parse(text) as {
    count: number;
    items: string[];
    shown: number;
    total: number;
  };
  assert.equal(value.total, 1000);
  assert.equal(value.items.length, value.shown);
  assert.ok(value.shown > 0 && value.shown < 1000);
  assert.deepEqual(value.items, entries.slice(0, value.shown));
});

test("even a wrapper too large on its own is cut to the limit", () => {
  const text = fitList([], () => ({ note: "x".repeat(MAX_SKILL_RESULT * 2) }));
  assert.equal(text.length, MAX_SKILL_RESULT);
});
