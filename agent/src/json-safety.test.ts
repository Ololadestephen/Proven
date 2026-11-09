import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger,
  ModelClient,
  ModelInterrupted,
  fetchPrices,
  type LedgerRow,
} from "./inference.ts";
import { PublicError } from "./errors.ts";
import { parseBidCheck } from "./swarm.ts";
import {
  createHostedWallet,
  parseHostedPolicy,
  sendFromWallet,
  MAX_TRANSFER,
} from "./hosted/wallets.ts";
import type { Config } from "./config.ts";
import type { Account } from "near-api-js";

const MODEL = "test/model";
const request = {
  spender: "test-agent",
  stage: "work",
  run: "test-run",
  key: "test-placeholder",
  messages: [{ role: "user" as const, content: "test" }],
  maxOutputTokens: 10,
  model: MODEL,
};
const prices = new Map([
  [MODEL, { inputNanoUsd: 100, outputNanoUsd: 1000, verifiable: true }],
]);
const goodReply = () => ({
  id: "chat-test",
  choices: [{ message: { content: "candidate" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 5 },
});
const goodRow = (): LedgerRow => ({
  at: "2026-11-07T00:00:00Z",
  spender: request.spender,
  stage: request.stage,
  run: request.run,
  model: MODEL,
  status: 200,
  input_tokens: 20,
  output_tokens: 5,
  cost_nano_usd: 7000,
  chat_id: "chat-test",
  request_hash: "a".repeat(64),
  response_hash: "b".repeat(64),
});
function temporary(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "proven-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "ledger.jsonl") };
}

test("invalid ledger JSON or row shape cannot reset a balance or reach a paid model call", async (t) => {
  const { path } = temporary(t);
  for (const text of [
    "{PRIVATE-INPUT",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...goodRow(), cost_nano_usd: -1 }),
    JSON.stringify({ ...goodRow(), cost_nano_usd: "7000" }),
    JSON.stringify({ ...goodRow(), input_tokens: null }),
  ]) {
    writeFileSync(path, text);
    let calls = 0;
    const client = new ModelClient(new Ledger(path), prices, (async () => {
      calls++;
      return new Response(JSON.stringify(goodReply()));
    }) as typeof fetch);
    await assert.rejects(
      client.call(request),
      (error: unknown) =>
        error instanceof PublicError &&
        /inference ledger is invalid/.test(error.message) &&
        !error.message.includes("PRIVATE-INPUT"),
    );
    assert.equal(calls, 0);
    assert.equal(readFileSync(path, "utf8"), text);
  }
});

test("an unreadable ledger fails closed rather than looking like an empty ledger", async (t) => {
  const { dir } = temporary(t);
  let calls = 0;
  const client = new ModelClient(new Ledger(dir), prices, (async () => {
    calls++;
    return new Response(JSON.stringify(goodReply()));
  }) as typeof fetch);
  await assert.rejects(client.call(request), /ledger could not be read/);
  assert.equal(calls, 0);
});

test("invalid successful model replies reserve possible cost and stop the next budgeted call", async (t) => {
  const { path } = temporary(t);
  const invalid = [
    "{PRIVATE-OUTPUT",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...goodReply(), usage: undefined }),
    JSON.stringify({ ...goodReply(), choices: [] }),
    JSON.stringify({
      ...goodReply(),
      usage: { prompt_tokens: -1, completion_tokens: 1 },
    }),
    JSON.stringify({
      ...goodReply(),
      choices: [{ message: { content: 17 }, finish_reason: "stop" }],
    }),
    JSON.stringify({
      ...goodReply(),
      usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 },
    }),
  ];
  for (const text of invalid) {
    rmSync(path, { force: true });
    let calls = 0;
    const ledger = new Ledger(path);
    const client = new ModelClient(ledger, prices, (async () => {
      calls++;
      return new Response(text, { status: 200 });
    }) as typeof fetch);
    await assert.rejects(
      client.call(request),
      (error: unknown) =>
        error instanceof PublicError &&
        /model response/.test(error.message) &&
        !error.message.includes("PRIVATE-OUTPUT"),
    );
    const spent = ledger.spentNanoUsd(request.spender);
    assert.ok(spent >= 10_000);
    assert.equal(calls, 1);
    await assert.rejects(
      client.call({ ...request, limitNanoUsd: spent }),
      /inference limit/,
    );
    assert.equal(calls, 1);
    assert.equal(ledger.rows().length, 1);
  }
});

test("an unreadable successful response reserves cost, never accepts output", async (t) => {
  const { path } = temporary(t);
  const ledger = new Ledger(path);
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private transport data"));
      },
    }),
  );
  const client = new ModelClient(
    ledger,
    prices,
    (async () => response) as typeof fetch,
  );
  await assert.rejects(
    client.call(request),
    (error) =>
      error instanceof ModelInterrupted &&
      error.phase === "response_read" &&
      /response could not be read/.test(error.message),
  );
  assert.ok(ledger.spentNanoUsd(request.spender) >= 10_000);
});

test("a valid model refusal to produce content still records real token cost", async (t) => {
  const { path } = temporary(t);
  const reply = {
    ...goodReply(),
    choices: [{ message: { content: null }, finish_reason: "stop" }],
  };
  const ledger = new Ledger(path);
  const client = new ModelClient(
    ledger,
    prices,
    (async () => new Response(JSON.stringify(reply))) as typeof fetch,
  );
  const result = await client.call(request);
  assert.equal(result.text, "");
  assert.equal(ledger.spentNanoUsd(request.spender), 7000);
});

test("invalid model prices never become a zero-cost listed model", async () => {
  for (const text of [
    "{PRIVATE-PRICE",
    "null",
    "[]",
    "{}",
    '{"models":{}}',
    JSON.stringify({
      models: [
        {
          modelId: MODEL,
          inputCostPerToken: { amount: null, scale: 9 },
          outputCostPerToken: { amount: 1, scale: 9 },
        },
      ],
    }),
  ])
    await assert.rejects(
      fetchPrices((async () => new Response(text)) as typeof fetch),
      PublicError,
    );
  const listed = await fetchPrices(
    (async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              modelId: MODEL,
              inputCostPerToken: { amount: 0, scale: 9 },
              outputCostPerToken: { amount: 0, scale: 9 },
              metadata: { verifiable: true },
            },
          ],
        }),
      )) as typeof fetch,
  );
  assert.deepEqual(listed.get(MODEL), {
    inputNanoUsd: 0,
    outputNanoUsd: 0,
    verifiable: true,
  });
});

const sourcePolicy = {
  rules: {
    transaction_types: ["call"],
    allowed_tokens: ["native"],
    addresses: { mode: "whitelist", list: ["escrow.testnet"] },
    limits: {
      per_transaction: { native: "100000000000000000000000" },
      daily: { native: "1000000000000000000000000" },
    },
  },
  capabilities: Object.fromEntries(
    [
      "raw_sign",
      "sign_message",
      "evm_sign",
      "solana_sign",
      "swap",
      "cross_chain_withdraw",
      "limit_order",
      "confidential",
      "payment_check",
    ].map((name) => [name, { allowed: false }]),
  ),
};

test("a malformed or unsafe custody policy cannot register a wallet or ask for a signature", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let signed = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("must not call OutLayer");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const config = {
    escrow: "escrow.testnet",
    custodyApi: "https://example.invalid",
  } as Config;
  const treasury = {
    accountId: "treasury.testnet",
    callFunctionRaw: async () => {
      signed++;
      throw new Error("must not sign");
    },
  } as unknown as Account;
  await assert.rejects(
    createHostedWallet(config, "owner.testnet", treasury, () => {
      throw new Error("PRIVATE-PATH");
    }),
    (error) =>
      error instanceof PublicError &&
      /policy could not be read/.test(error.message) &&
      !error.message.includes("PRIVATE-PATH"),
  );
  assert.equal(calls, 0);
  assert.equal(signed, 0);
  for (const text of [
    "{PRIVATE-POLICY",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...sourcePolicy, rules: null }),
    JSON.stringify({ ...sourcePolicy, capabilities: {} }),
    JSON.stringify({
      ...sourcePolicy,
      capabilities: {
        ...sourcePolicy.capabilities,
        raw_sign: { allowed: true },
      },
    }),
  ]) {
    await assert.rejects(
      createHostedWallet(config, "owner.testnet", treasury, () => text),
      (error: unknown) =>
        error instanceof PublicError &&
        /custody policy is invalid/.test(error.message) &&
        !error.message.includes("PRIVATE-POLICY"),
    );
    assert.equal(calls, 0);
    assert.equal(signed, 0);
  }
});

test("a valid hosted policy retains spending restrictions and allows relay messages only", () => {
  const policy = parseHostedPolicy(
    JSON.stringify(sourcePolicy),
    "escrow.testnet",
    "owner.testnet",
    "treasury.testnet",
  );
  const rules = policy.rules as typeof sourcePolicy.rules;
  assert.deepEqual(rules.transaction_types, ["call", "transfer"]);
  assert.deepEqual(rules.limits, sourcePolicy.rules.limits);
  const capabilities = policy.capabilities as Record<string, unknown>;
  assert.deepEqual(capabilities.sign_message, {
    allowed: true,
    allowed_recipients: ["proven-relay"],
  });
  assert.deepEqual(capabilities.raw_sign, { allowed: false });
});

test("invalid bid checks fail before credential reads or any posting plan", () => {
  for (const text of [
    "{PRIVATE-CHECK",
    "null",
    "[]",
    "{}",
    JSON.stringify({ verifier: "not-a-hash", format: "{}" }),
    JSON.stringify({ verifier: "a".repeat(64), format: {} }),
    JSON.stringify({ verifier: "a".repeat(64), format: "[1]" }),
  ])
    assert.throws(
      () => parseBidCheck(text),
      (error: unknown) =>
        error instanceof PublicError &&
        !error.message.includes("PRIVATE-CHECK"),
    );
  assert.deepEqual(
    parseBidCheck(
      JSON.stringify({ verifier: "a".repeat(64), format: '{"kind":"data"}' }),
    ),
    { verifier: "a".repeat(64), format: '{"kind":"data"}' },
  );
});

test("non-ASCII requests reserve every UTF-8 byte after a malformed response and enforce that limit", async (t) => {
  const { path } = temporary(t);
  const ledger = new Ledger(path);
  let calls = 0;
  let wireBody = "";
  const client = new ModelClient(ledger, prices, (async (_url, init) => {
    calls++;
    wireBody = String(init?.body);
    return new Response("{bad");
  }) as typeof fetch);
  const unicode = {
    ...request,
    messages: [{ role: "user" as const, content: "漢字🙂".repeat(20) }],
  };
  await assert.rejects(client.call(unicode), /model response/);
  const exactReserve =
    Buffer.byteLength(wireBody, "utf8") * 100 + request.maxOutputTokens * 1000;
  assert.ok(Buffer.byteLength(wireBody, "utf8") > wireBody.length);
  assert.equal(ledger.spentNanoUsd(request.spender), exactReserve);
  await assert.rejects(
    client.call({ ...unicode, limitNanoUsd: exactReserve * 2 - 1 }),
    /inference limit/,
  );
  assert.equal(calls, 1);
});

test("an invalid or asynchronous custody transfer response stops before another withdrawal step", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const body of [
    "{PRIVATE",
    "{}",
    JSON.stringify({ tx_hash: 17 }),
    JSON.stringify({ tx_hash: "" }),
    JSON.stringify({ request_id: "12345678-1234-1234-1234-123456789abc" }),
    JSON.stringify({ result: { tx_hash: 17 } }),
  ]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(body);
    }) as typeof fetch;
    await assert.rejects(
      sendFromWallet(
        { custodyApi: "https://example.invalid" } as Config,
        "test-placeholder",
        "owner.testnet",
        MAX_TRANSFER + 1n,
        "worker.testnet",
      ),
      (error) =>
        error instanceof PublicError &&
        /Reconcile wallet history before retrying/.test(error.message) &&
        !error.message.includes("PRIVATE"),
    );
    assert.equal(calls, 1);
  }
});
test("confirmed custody transfer hashes allow exactly the required withdrawal steps", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const amounts: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    amounts.push(JSON.parse(String(init?.body)).amount);
    return new Response(
      JSON.stringify({ result: { tx_hash: "A".repeat(44) } }),
    );
  }) as typeof fetch;
  assert.deepEqual(
    await sendFromWallet(
      { custodyApi: "https://example.invalid" } as Config,
      "test-placeholder",
      "owner.testnet",
      MAX_TRANSFER + 1n,
      "worker.testnet",
      async (hash, from) => ({
        transaction: {
          hash,
          signer_id: from,
          receiver_id: "owner.testnet",
          actions: [{ Transfer: { deposit: amounts.at(-1) } }],
        },
        status: { SuccessValue: "" },
      }),
    ),
    ["A".repeat(44), "A".repeat(44)],
  );
  assert.deepEqual(amounts, [MAX_TRANSFER.toString(), "1"]);
});

test("malformed custody registration, ciphertext and signatures never reach treasury reads or signing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const made = {
    api_key: "test-placeholder",
    wallet_id: "wallet-test",
    near_account_id: "a".repeat(64),
  };
  const encrypted = {
    encrypted_base64: Buffer.from("ciphertext").toString("base64"),
  };
  const signed = {
    public_key_hex: "a".repeat(64),
    signature_hex: "b".repeat(128),
  };
  const cases = [
    [{ ...made, api_key: "" }],
    [{ ...made, wallet_id: " " }],
    [made, {}],
    [made, { encrypted_base64: "" }],
    [made, { encrypted_base64: "not base64!!" }],
    [made, encrypted, {}],
    [made, encrypted, { ...signed, public_key_hex: 17 }],
    [made, encrypted, { ...signed, signature_hex: "a" }],
    [
      made,
      encrypted,
      { ...signed, version: -1, locked: false, valid_until: null },
    ],
    [
      made,
      encrypted,
      { ...signed, version: 1, locked: "false", valid_until: null },
    ],
    [
      made,
      encrypted,
      { ...signed, version: 1, locked: false, valid_until: "bad" },
    ],
    [made, encrypted, { ...signed, locked: false }],
  ];
  for (const replies of cases) {
    let calls = 0,
      paid = 0,
      reads = 0;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(replies[calls++]))) as typeof fetch;
    const treasury = {
      accountId: "treasury.testnet",
      provider: {
        callFunction: async () => {
          reads++;
          throw new Error("must not read quote");
        },
      },
      callFunctionRaw: async () => {
        paid++;
        throw new Error("must not sign");
      },
    } as unknown as Account;
    await assert.rejects(
      createHostedWallet(
        {
          escrow: "escrow.testnet",
          custodyApi: "https://example.invalid",
        } as Config,
        "owner.testnet",
        treasury,
        () => JSON.stringify(sourcePolicy),
      ),
      PublicError,
    );
    assert.equal(calls, replies.length);
    assert.equal(paid, 0);
    assert.equal(reads, 0);
  }
});
