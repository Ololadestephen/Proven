import {
  ContractMethodNotFoundError,
  RpcMethodNotFoundError,
} from "near-api-js/rpc-errors";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buyerAllowed,
  legacyAccess,
  readBoardAccess,
  MarketAccessError,
  configuredBoard,
} from "./market-access.ts";
const missing = new ContractMethodNotFoundError("block", 1);
test("the chain's closed and open policies override a contradictory env list", async () => {
  const closed = await readBoardAccess(
    async () => ({ open: false, buyers: ["listed.near"] }),
    () => legacyAccess("open", "mainnet"),
  );
  assert.equal(closed.source, "board");
  assert.equal(buyerAllowed(closed, "stranger.near"), false);
  assert.equal(buyerAllowed(closed, "listed.near"), true);
  const open = await readBoardAccess(
    async () => ({ open: true, buyers: [] }),
    () => legacyAccess("", "mainnet"),
  );
  assert.equal(buyerAllowed(open, "stranger.near"), true);
});
test("only the old contract's missing get_access permits the explicit env fallback", async () => {
  const result = await readBoardAccess(
    async () => {
      throw missing;
    },
    () => legacyAccess("listed.near", "mainnet"),
  );
  assert.equal(result.source, "legacy-env");
  assert.equal(buyerAllowed(result, "listed.near"), true);
  assert.equal(buyerAllowed(result, "stranger.near"), false);
  assert.deepEqual(legacyAccess(undefined, "mainnet"), {
    open: false,
    buyers: [],
  });
  assert.deepEqual(legacyAccess(undefined, "testnet"), {
    open: true,
    buyers: [],
  });
});
test("transport errors, generic missing RPC methods and invalid board responses fail closed", async () => {
  for (const error of [
    new Error("timeout"),
    new Error("Method not found"),
    new Error("HTTP 500"),
    Object.assign(new Error("Contract method is not found at block height 1"), {
      name: "ContractMethodNotFoundError",
      blockHash: "block",
      blockHeight: 1,
    }),
    new Error("Smart contract panicked: MethodResolveError(MethodNotFound)"),
    "MethodResolveError(MethodNotFound)",
    {
      cause: {
        name: "CONTRACT_EXECUTION_ERROR",
        info: {
          error: "Smart contract panicked: MethodResolveError(MethodNotFound)",
        },
      },
    },
    { code: -32601, message: "Method not found" },
  ]) {
    let fallback = false;
    await assert.rejects(
      readBoardAccess(
        async () => {
          throw error;
        },
        () => {
          fallback = true;
          return legacyAccess("open", "mainnet");
        },
      ),
      MarketAccessError,
    );
    assert.equal(fallback, false);
  }
  for (const value of [
    null,
    [],
    {},
    { open: "yes", buyers: [] },
    { open: true, buyers: [null] },
    { open: true, buyers: ["bad account"] },
  ])
    await assert.rejects(
      readBoardAccess(
        async () => value,
        () => legacyAccess("open", "mainnet"),
      ),
      MarketAccessError,
    );
});
test("a changed buyer list is read on the next decision, with no startup permission cache", async () => {
  let buyers = ["first.near"];
  const read = () =>
    readBoardAccess(
      async () => ({ open: false, buyers }),
      () => legacyAccess("open", "mainnet"),
    );
  assert.equal(buyerAllowed(await read(), "first.near"), true);
  buyers = ["second.near"];
  assert.equal(buyerAllowed(await read(), "first.near"), false);
  assert.equal(buyerAllowed(await read(), "second.near"), true);
});

test("the actual SDK missing-contract-method error permits fallback, but RPC missing methods do not", async () => {
  const result = await readBoardAccess(
    async () => {
      throw new ContractMethodNotFoundError("block", 1);
    },
    () => legacyAccess("listed.near", "mainnet"),
  );
  assert.equal(result.source, "legacy-env");
  assert.equal(buyerAllowed(result, "listed.near"), true);
  await assert.rejects(
    readBoardAccess(
      async () => {
        throw new RpcMethodNotFoundError("query");
      },
      () => legacyAccess("open", "mainnet"),
    ),
    MarketAccessError,
  );
});
test("missing board configuration cannot select an env fallback", () => {
  for (const value of [undefined, "", " "])
    assert.throws(
      () => configuredBoard(value),
      /board account is not configured/,
    );
  assert.equal(configuredBoard("board.near"), "board.near");
});
