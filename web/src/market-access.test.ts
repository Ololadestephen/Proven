import assert from "node:assert/strict";
import test from "node:test";
import { marketOpenTo } from "./market.ts";

test("a closed mainnet market reviews only its listed buyers", () => {
  assert.equal(marketOpenTo("a.near", undefined, "mainnet"), false);
  assert.equal(marketOpenTo("a.near", "", "mainnet"), false);
  assert.equal(marketOpenTo("b.near", "a.near", "mainnet"), false);
  assert.equal(marketOpenTo("a.near", "z.near, a.near", "mainnet"), true);
  assert.equal(marketOpenTo("a.near", "open", "mainnet"), true);
  assert.equal(marketOpenTo("a.near", undefined, "testnet"), true);
});
