import test from "node:test";
import assert from "node:assert/strict";
import {
  navigationIndex,
  sectionFromHash,
  EVIDENCE_NAVIGATION,
  MARKET_NAVIGATION,
} from "../ui/navigation-state.ts";
test("workspace fragments select sections and recorded jobs select evidence without invoking actions", () => {
  for (const [hash, expected] of [
    ["", "workspace"],
    ["#workspace", "workspace"],
    ["#lookup", "lookup"],
    ["#demo", "demo"],
    ["#trust", "trust"],
    ["#job-35", "lookup"],
    ["#job-36", "lookup"],
    ["#job-99999999999999999", "workspace"],
    ["#javascript:alert(1)", "workspace"],
    ["#api/demo/start", "workspace"],
  ])
    assert.equal(sectionFromHash(hash!), expected);
});

test("navigation wraps focus and leaves Tab and unrelated keys native", () => {
  assert.equal(navigationIndex("ArrowUp", 0, 4), 3);
  assert.equal(navigationIndex("ArrowDown", 3, 4), 0);
  assert.equal(navigationIndex("Home", 2, 4), 0);
  assert.equal(navigationIndex("End", 1, 4), 3);
  assert.equal(navigationIndex("Tab", 1, 4), null);
  assert.equal(navigationIndex("Enter", 1, 4), null);
  assert.equal(navigationIndex("ArrowDown", -1, 4), null);
  assert.equal(navigationIndex("ArrowDown", 0, 0), null);
});

test("the market and evidence pages share one list, each opening on its own section", () => {
  assert.deepEqual(
    MARKET_NAVIGATION.map((item) => item.label),
    EVIDENCE_NAVIGATION.map((item) => item.label),
  );
  assert.equal(MARKET_NAVIGATION[0]?.label, "Market");
  assert.equal(sectionFromHash("", MARKET_NAVIGATION, "market"), "market");
  assert.equal(
    sectionFromHash("#market-trust", MARKET_NAVIGATION, "market"),
    "trust",
  );
  assert.equal(
    sectionFromHash("#post-job", MARKET_NAVIGATION, "market"),
    "post",
  );
  assert.equal(sectionFromHash("", EVIDENCE_NAVIGATION, "lookup"), "lookup");
  assert.equal(
    sectionFromHash("#job-35", EVIDENCE_NAVIGATION, "lookup"),
    "lookup",
  );
  assert.equal(EVIDENCE_NAVIGATION[0]?.href, "/app");
  assert.equal(
    MARKET_NAVIGATION.find((item) => item.id === "lookup")?.href,
    "/evidence#lookup",
  );
});
