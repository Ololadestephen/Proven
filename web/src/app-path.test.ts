import assert from "node:assert/strict";
import test from "node:test";
import { isAppPath } from "./server.ts";

test("the server serves the app's own pages and nothing else under /app", () => {
  for (const path of [
    "/app",
    "/app/",
    "/app/market",
    "/app/bounties",
    "/app/bounties/new",
    "/app/bounties/2",
    "/app/bids/6",
  ])
    assert.equal(isAppPath(path), true, path);
  for (const path of ["/app/bounties/old", "/app/bounties/new/1", "/app/x"])
    assert.equal(isAppPath(path), false, path);
});
