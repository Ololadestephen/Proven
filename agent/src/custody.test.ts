import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOARD,
  assertPolicy,
  custodyCall,
  custodyTransaction,
} from "./custody.ts";
import { publicMessage } from "./errors.ts";

const escrow = "escrow-v2.proven.testnet";
const policy = () => ({
  ...JSON.parse(
    readFileSync(new URL("../custody-policy.json", import.meta.url), "utf8"),
  ),
  policy: "stored",
  frozen: false,
});
test("stored escrow-only native-call policy passes; missing or broader policy fails closed", () => {
  assert.doesNotThrow(() => assertPolicy(policy(), escrow));
  const withBoard = policy();
  withBoard.rules.addresses.list = [escrow, BOARD];
  assert.doesNotThrow(() => assertPolicy(withBoard, escrow));
  const boardOnly = policy();
  boardOnly.rules.addresses.list = [BOARD];
  assert.throws(() => assertPolicy(boardOnly, escrow));
  const withStranger = policy();
  withStranger.rules.addresses.list = [escrow, BOARD, "other.testnet"];
  assert.throws(() => assertPolicy(withStranger, escrow));
  const alterations = [
    (p: any) => {
      p.policy = "none";
    },
    (p: any) => {
      p.frozen = true;
    },
    (p: any) => {
      p.rules.transaction_types.push("transfer");
    },
    (p: any) => {
      p.rules.addresses.list.push("attacker.testnet");
    },
    (p: any) => {
      p.rules.allowed_tokens = ["*"];
    },
    (p: any) => {
      p.rules.limits.per_transaction.native = "1000000000000000000000000";
    },
    (p: any) => {
      delete p.rules.limits.daily;
    },
    (p: any) => {
      p.capabilities.raw_sign.allowed = true;
    },
    (p: any) => {
      delete p.capabilities.sign_message;
    },
  ];
  for (const alter of alterations) {
    const p = policy();
    alter(p);
    assert.throws(() => assertPolicy(p, escrow));
  }
  for (const value of [null, {}, "stored"])
    assert.throws(() => assertPolicy(value, escrow));
});
test("wrong target and excessive deposit are refused before a network request", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("should not call");
  };
  try {
    for (const plan of [
      {
        receiver_id: "attacker.testnet",
        method_name: "fund",
        args: {},
        gas: "70000000000000",
        deposit: "0",
      },
      {
        receiver_id: escrow,
        method_name: "fund",
        args: {},
        gas: "70000000000000",
        deposit: "100000000000000000000001",
      },
    ])
      await assert.rejects(
        custodyCall(
          "https://testnet-api.outlayer.ai",
          "private-token",
          "a".repeat(64),
          escrow,
          plan,
        ),
      );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("identity and policy checks precede signing and upstream errors never expose bodies", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  const account = "a".repeat(64);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/call"))
      assert.match(
        String((init?.headers as Record<string, string>)["X-Idempotency-Key"]),
        /^[a-f0-9-]{36}$/,
      );
    return new Response(
      JSON.stringify(
        url.endsWith("chain=near")
          ? {
              address: account,
              executor_account_id: account,
              asset_account_id: null,
            }
          : url.endsWith("/policy")
            ? policy()
            : { message: "private-token secret payload" },
      ),
      { status: url.endsWith("/call") ? 403 : 200 },
    );
  };
  try {
    const plan = {
      receiver_id: escrow,
      method_name: "fund",
      args: { job_id: 1 },
      gas: "70000000000000",
      deposit: "1",
    };
    await assert.rejects(
      custodyCall(
        "https://testnet-api.outlayer.ai",
        "private-token",
        "b".repeat(64),
        escrow,
        plan,
      ),
    );
    assert.equal(seen.length, 1);
    seen.length = 0;
    try {
      await custodyCall(
        "https://testnet-api.outlayer.ai",
        "private-token",
        account,
        escrow,
        plan,
      );
      assert.fail("expected refusal");
    } catch (error) {
      assert.doesNotMatch(publicMessage(error), /private-token|secret payload/);
    }
    assert.deepEqual(
      seen.map((url) => new URL(url).pathname),
      ["/wallet/v1/address", "/wallet/v1/policy", "/wallet/v1/call"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("submission transport failure reports unknown outcome and never retries the write", async () => {
  const original = globalThis.fetch;
  let writes = 0;
  const account = "a".repeat(64);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/call")) {
      writes++;
      throw new Error("private upstream body");
    }
    return new Response(
      JSON.stringify(
        url.endsWith("chain=near")
          ? { address: account, asset_account_id: null }
          : policy(),
      ),
    );
  };
  try {
    await assert.rejects(
      custodyCall(
        "https://testnet-api.outlayer.ai",
        "private-token",
        account,
        escrow,
        {
          receiver_id: escrow,
          method_name: "fund",
          args: {},
          gas: "70000000000000",
          deposit: "1",
        },
      ),
      /outcome is unknown.*history before retrying/,
    );
    assert.equal(writes, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("pending custody responses retain nested transaction hashes but never-admitted hashes are refused", async () => {
  const original = globalThis.fetch;
  const account = "a".repeat(64),
    transaction = "1".repeat(44);
  let neverAdmitted = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    return new Response(
      JSON.stringify(
        url.endsWith("chain=near")
          ? { address: account, asset_account_id: null }
          : url.endsWith("/policy")
            ? policy()
            : {
                status: "processing",
                result: {
                  tx_hash: transaction,
                  never_reached_chain: neverAdmitted,
                },
              },
      ),
    );
  };
  const plan = {
    receiver_id: escrow,
    method_name: "fund",
    args: {},
    gas: "70000000000000",
    deposit: "1",
  };
  try {
    assert.equal(
      await custodyCall(
        "https://testnet-api.outlayer.ai",
        "private-token",
        account,
        escrow,
        plan,
      ),
      transaction,
    );
    neverAdmitted = true;
    await assert.rejects(
      custodyCall(
        "https://testnet-api.outlayer.ai",
        "private-token",
        account,
        escrow,
        plan,
      ),
      /never reached chain/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("processing custody call follows only its fixed request id using reads", async () => {
  const original = globalThis.fetch,
    id = "12345678-1234-1234-1234-123456789abc",
    tx = "1".repeat(44);
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(
      String(url),
      `https://testnet-api.outlayer.ai/wallet/v1/requests/${id}`,
    );
    assert.equal(options?.method, undefined);
    assert.equal(options?.redirect, "error");
    reads++;
    return Response.json({
      request_id: id,
      type: "call",
      status: "processing",
      result: reads === 1 ? {} : { tx_hash: tx },
    });
  };
  try {
    assert.equal(
      await custodyTransaction(
        "https://testnet-api.outlayer.ai",
        "private-token",
        { request_id: id, status: "processing" },
        async () => {},
      ),
      tx,
    );
    assert.equal(reads, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("custody polling is bounded and wrong requests or never-submitted results cannot be accepted", async () => {
  const original = globalThis.fetch,
    id = "12345678-1234-1234-1234-123456789abc";
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return Response.json({
      request_id: id,
      type: "call",
      status: "processing",
    });
  };
  try {
    await assert.rejects(
      custodyTransaction(
        "https://testnet-api.outlayer.ai",
        "private-token",
        { request_id: id, status: "processing" },
        async () => {},
      ),
      /Check wallet history/,
    );
    assert.equal(reads, 30);
    globalThis.fetch = async () =>
      Response.json({
        request_id: "other",
        type: "call",
        result: { tx_hash: "1".repeat(44) },
      });
    await assert.rejects(
      custodyTransaction(
        "https://testnet-api.outlayer.ai",
        "private-token",
        { request_id: id },
        async () => {},
      ),
      /does not match/,
    );
    await assert.rejects(
      custodyTransaction(
        "https://testnet-api.outlayer.ai",
        "private-token",
        { result: { tx_hash: "1".repeat(44), never_submitted: true } },
        async () => {},
      ),
      /never reached chain/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("transient status-read failure is retried without submitting the call again", async () => {
  const original = globalThis.fetch;
  const id = "12345678-1234-1234-1234-123456789abc";
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith(`/requests/${id}`));
    assert.equal(options?.method, undefined);
    reads++;
    if (reads === 1) return new Response("unavailable", { status: 503 });
    return Response.json({
      request_id: id,
      type: "call",
      status: "processing",
      result: { tx_hash: "1".repeat(44) },
    });
  };
  try {
    assert.equal(
      await custodyTransaction(
        "https://testnet-api.outlayer.ai",
        "private-token",
        { request_id: id, status: "processing" },
        async () => {},
      ),
      "1".repeat(44),
    );
    assert.equal(reads, 2);
  } finally {
    globalThis.fetch = original;
  }
});
