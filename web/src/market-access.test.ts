import assert from "node:assert/strict";
import test from "node:test";
import { marketConfig, marketOpenTo } from "./market.ts";

test("a closed mainnet market reviews only its listed buyers", () => {
  assert.equal(marketOpenTo("a.near", undefined, "mainnet"), false);
  assert.equal(marketOpenTo("a.near", "", "mainnet"), false);
  assert.equal(marketOpenTo("b.near", "a.near", "mainnet"), false);
  assert.equal(marketOpenTo("a.near", "z.near, a.near", "mainnet"), true);
  assert.equal(marketOpenTo("a.near", "open", "mainnet"), true);
  assert.equal(marketOpenTo("a.near", undefined, "testnet"), true);
});

test("a closed market names its buyers, and an open one does not", () => {
  assert.deepEqual(marketConfig("a.near, b.near").buyers, ["a.near", "b.near"]);
  assert.equal(marketConfig("a.near").open, false);
  assert.equal(marketConfig("open").open, true);
  assert.equal(marketConfig("open").buyers, undefined);
});
