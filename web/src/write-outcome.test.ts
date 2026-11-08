import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Account, KeyPair } from "near-api-js";
import { BOARD, createDevWallet } from "./market.ts";
import { ReadError } from "./model.ts";
import { createApp } from "./server.ts";

test("dev submission errors remain unknown, while preflight refusals keep their definite error", async (t) => {
  const state = globalThis as {
    __provenEnv?: string;
    __provenOutsider?: { account: string; key: string };
  };
  const priorEnv = state.__provenEnv;
  const priorOutsider = state.__provenOutsider;
  state.__provenEnv = "";
  // Synthetic, unused signing material: both submission methods are replaced before use.
  state.__provenOutsider = {
    account: "synthetic-worker.testnet",
    key: KeyPair.fromRandom("ed25519").toString(),
  };
  t.after(() => {
    if (priorEnv === undefined) delete state.__provenEnv;
    else state.__provenEnv = priorEnv;
    if (priorOutsider === undefined) delete state.__provenOutsider;
    else state.__provenOutsider = priorOutsider;
  });
  let calls = 0;
  const uncertain = async () => {
    calls++;
    throw new Error("PRIVATE transport failure after broadcast");
  };
  t.mock.method(Account.prototype, "callFunctionRaw", uncertain);
  t.mock.method(Account.prototype, "signAndSendTransaction", uncertain);
  const wallet = createDevWallet();
  const call = {
    as: "worker",
    receiver: BOARD,
    method: "claim",
    args: { bid_id: 1 },
    deposit: "0",
    gas: "100000000000000",
  };
  const unknown = (error: unknown) => {
    assert.ok(error instanceof ReadError);
    assert.equal(error.status, 502);
    assert.match(error.message, /outcome is unknown/);
    assert.match(
      error.message,
      /Reconcile wallet history and the chain before retrying/,
    );
    assert.doesNotMatch(
      error.message,
      /PRIVATE|No transaction was sent|transaction failed/,
    );
    return true;
  };
  await assert.rejects(wallet.call(call), unknown);
  await assert.rejects(
    wallet.transfer({ as: "worker", receiver: "receiver.testnet", yocto: "1" }),
    unknown,
  );
  assert.equal(
    calls,
    2,
    "each action submits once and never automatically retries",
  );
  await assert.rejects(
    wallet.call({ ...call, receiver: "outside.testnet" }),
    (error: unknown) => {
      assert.ok(error instanceof ReadError);
      assert.equal(error.status, 403);
      assert.match(error.message, /reaches only these contracts/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("unexpected HTTP write errors warn about an unknown outcome without leaking upstream details", async (t) => {
  const wallet = {
    list: () => ({}),
    call: async () => {
      throw new Error("PRIVATE call failed after broadcast");
    },
    transfer: async () => {
      throw new Error("PRIVATE transfer failed after broadcast");
    },
    sign: () => {
      throw new ReadError("This request is refused before signing.", 403);
    },
  } as unknown as ReturnType<typeof createDevWallet>;
  const app = createApp(
    async () => {
      throw new Error("PRIVATE read failure");
    },
    undefined,
    undefined,
    wallet,
  );
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => app.close());
  const address = app.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  for (const path of ["call", "transfer"]) {
    const response = await fetch(`${base}/api/market/dev/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 502);
    const { error } = (await response.json()) as { error: string };
    assert.match(error, /A transaction may have been sent/);
    assert.match(
      error,
      /Reconcile wallet history and the chain before retrying/,
    );
    assert.doesNotMatch(error, /PRIVATE|No transaction was sent/);
  }
  const refused = await fetch(`${base}/api/market/dev/sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), {
    error: "This request is refused before signing.",
  });
  const read = await fetch(`${base}/api/jobs/1`);
  assert.equal(read.status, 502);
  assert.deepEqual(await read.json(), {
    error: "The public snapshot could not be read.",
  });
});

test("dev calls preserve the confirmed return value with the transaction hash, without guessing malformed output", async (t) => {
  const state = globalThis as {
    __provenEnv?: string;
    __provenOutsider?: { account: string; key: string };
  };
  const priorEnv = state.__provenEnv;
  const priorOutsider = state.__provenOutsider;
  state.__provenEnv = "";
  state.__provenOutsider = {
    account: "synthetic-worker.testnet",
    key: KeyPair.fromRandom("ed25519").toString(),
  };
  t.after(() => {
    if (priorEnv === undefined) delete state.__provenEnv;
    else state.__provenEnv = priorEnv;
    if (priorOutsider === undefined) delete state.__provenOutsider;
    else state.__provenOutsider = priorOutsider;
  });
  let returnedText = "0";
  let posted = false;
  t.mock.method(
    Account.prototype,
    "callFunctionRaw",
    async () =>
      ({
        transaction: {
          hash: "confirmed-transaction",
          receiver_id: BOARD,
          signer_id: "synthetic-worker.testnet",
          actions: [{ FunctionCall: { method_name: "post_bid" } }],
        },
        status: { SuccessValue: Buffer.from(returnedText).toString("base64") },
        receipts_outcome: posted
          ? [
              {
                outcome: {
                  executor_id: BOARD,
                  status: { SuccessValue: "" },
                  logs: [
                    "EVENT_JSON:" +
                      JSON.stringify({
                        standard: "proven-board",
                        version: "1.0.0",
                        event: "bid_posted",
                        data: [
                          { buyer: "synthetic-worker.testnet", bid_id: 150 },
                        ],
                      }),
                  ],
                },
              },
            ]
          : [],
      }) as Awaited<ReturnType<Account["callFunctionRaw"]>>,
  );
  const wallet = createDevWallet();
  const call = {
    as: "worker",
    receiver: BOARD,
    method: "post_bid",
    args: {},
    deposit: "0",
    gas: "100000000000000",
  };
  assert.deepEqual(await wallet.call(call), {
    transaction_hash: "confirmed-transaction",
    result: 0,
  });
  returnedText = "not a bid ID";
  assert.deepEqual(await wallet.call(call), {
    transaction_hash: "confirmed-transaction",
    result: null,
  });
  returnedText = "true";
  posted = true;
  assert.deepEqual(await wallet.call(call), {
    transaction_hash: "confirmed-transaction",
    result: true,
    posted_bid_id: 150,
  });
});
