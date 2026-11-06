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

test("primary navigation is quiet and page destinations stay distinct", () => {
  assert.deepEqual(
    MARKET_NAVIGATION.map((item) => item.label),
    ["Overview", "Market", "My jobs", "Agents"],
  );
  assert.equal(
    MARKET_NAVIGATION.find((item) => item.id === "market")?.href,
    "/app/market",
  );
  assert.equal(
    EVIDENCE_NAVIGATION.find((item) => item.id === "demo")?.href,
    "/examples",
  );
  assert.equal(
    EVIDENCE_NAVIGATION.find((item) => item.id === "trust")?.href,
    "/trust",
  );
  assert.equal(
    sectionFromHash("#job-35", EVIDENCE_NAVIGATION, "lookup"),
    "lookup",
  );
});
