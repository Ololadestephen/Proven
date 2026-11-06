import test from "node:test";
import assert from "node:assert/strict";
import { navigationIndex, sectionFromHash } from "../ui/navigation-state.ts";
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

test("market navigation matches its own section anchors and retains an explicit evidence destination", () => {
  const items = [
    { id: "workspace" as const, label: "Market", href: "#market-overview" },
    { id: "lookup" as const, label: "Post a job", href: "#post-job" },
    { id: "demo" as const, label: "Job evidence", href: "/app" },
    { id: "trust" as const, label: "Trust & limits", href: "#market-trust" },
  ];
  assert.equal(sectionFromHash("#post-job", items), "lookup");
  assert.equal(sectionFromHash("#market-trust", items), "trust");
  assert.equal(sectionFromHash("#market-overview", items), "workspace");
  assert.equal(sectionFromHash("#unknown", items), "workspace");
});
