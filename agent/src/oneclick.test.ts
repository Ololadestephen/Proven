import test from "node:test";
import assert from "node:assert/strict";
import { createOneClick } from "./oneclick.ts";
import { settlementService } from "./settlement-cli.ts";
import { runCli } from "./cli.ts";

type Json = Record<string, unknown>;
interface QuoteFixture {
  timestamp: unknown;
  quoteRequest: Json;
  quote: Json;
}
interface StatusFixture {
  status: unknown;
  quoteResponse: { quote: Json; quoteRequest: Json };
  swapDetails: Json;
}

const clock = Date.parse("2026-11-04T15:00:00Z");
const input = {
  origin_asset: "nep141:near-usdc.near",
  destination_asset: "nep141:base-usdc.omft.near",
  amount: "1000000",
  refund_to: "0".repeat(64),
  recipient: `0x${"1".repeat(40)}`,
};
const tokens = [
  {
    assetId: input.origin_asset,
    blockchain: "near",
    symbol: "USDC",
    decimals: 6,
  },
  {
    assetId: input.destination_asset,
    blockchain: "base",
    symbol: "USDC",
    decimals: 6,
  },
];

function fixture(change: (value: QuoteFixture) => void = () => {}) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/tokens")) return Response.json(tokens);
    const response = {
      correlationId: "correlation-1",
      timestamp: new Date(clock).toISOString(),
      signature: "service-signature",
      quoteRequest: JSON.parse(String(options?.body)),
      quote: {
        amountIn: "1000000",
        minAmountIn: "1000000",
        amountOut: "997000",
        minAmountOut: "987030",
        timeEstimate: 22,
        withdrawFee: "2400",
        refundFee: "1000",
      },
    };
    change(response);
    return Response.json(response);
  };
  return { calls, client: createOneClick(fetcher, () => clock) };
}

test("dry quote is always dry, bound to the complete request, and never loads a signer", async () => {
  const { client, calls } = fixture();
  const result = await client.dryQuote(input);
  assert.equal(result.execution_enabled, false);
  assert.equal(result.signature_verified, false);
  assert.equal(result.quote.amountOut, "997000");
  assert.equal(result.quote.withdrawFee, "2400");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/v0/tokens", "/v0/quote"],
  );
  const sent = JSON.parse(String(calls[1]!.options?.body));
  assert.equal(sent.dry, true);
  assert.equal(sent.swapType, "EXACT_INPUT");
  assert.equal(sent.amount, input.amount);
  assert.equal(sent.refundTo, input.refund_to);
  assert.equal(sent.recipient, input.recipient);
  assert.equal(calls[1]!.options?.redirect, "error");
  assert.equal("depositAddress" in result.quote, false);
});

test("reject unknown or executable input before any request", async () => {
  for (const change of [
    { dry: false },
    { depositAddress: "pay-here" },
    { amount: "0" },
    { amount: "-1" },
    { amount: "1.2" },
    { amount: "01" },
    { amount: 100 },
    { slippage_bps: 101 },
    { recipient: "with spaces" },
  ]) {
    const { client, calls } = fixture();
    await assert.rejects(client.dryQuote({ ...input, ...change }));
    assert.equal(calls.length, 0);
  }
});

test("reject missing assets and every changed quote commitment", async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.dryQuote({ ...input, origin_asset: "missing" }));
  assert.equal(calls.length, 1);
  for (const key of [
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "destinationAsset",
    "depositType",
    "amount",
    "refundTo",
    "refundType",
    "recipient",
    "recipientType",
    "deadline",
  ]) {
    const { client } = fixture((value) => {
      value.quoteRequest[key] = "changed";
    });
    await assert.rejects(client.dryQuote(input), /does not match/);
  }
});

test("reject funding fields, stale timestamps and invalid quote amounts", async () => {
  const changes = [
    ...[
      "depositAddress",
      "depositMemo",
      "chainDepositAddresses",
      "deadline",
      "timeWhenInactive",
    ].map((key) => (value: QuoteFixture) => {
      value.quote[key] = "unexpected";
    }),
    (value: QuoteFixture) => {
      value.timestamp = "2020-01-01";
    },
    (value: QuoteFixture) => {
      value.quote.amountIn = "2000000";
    },
    (value: QuoteFixture) => {
      value.quote.minAmountOut = "1000001";
    },
    (value: QuoteFixture) => {
      value.quote.minAmountOut = "1";
    },
    (value: QuoteFixture) => {
      value.quote.minAmountIn = "1000001";
    },
    (value: QuoteFixture) => {
      value.quote.amountOut = 997000;
    },
    (value: QuoteFixture) => {
      value.quote.timeEstimate = -1;
    },
  ];
  for (const change of changes)
    await assert.rejects(fixture(change).client.dryQuote(input));
});

test("transport failures, invalid UTF-8/JSON and oversized streams fail without retry or raw errors", async () => {
  const bodies = [
    "not json",
    "x".repeat(1024 * 1024 + 1),
    new Uint8Array([0xff]),
  ];
  for (const body of bodies) {
    let count = 0;
    const client = createOneClick(async () => {
      count++;
      return new Response(body);
    });
    await assert.rejects(client.dryQuote(input), /invalid response/);
    assert.equal(count, 1);
  }
  for (const status of [400, 429, 500]) {
    const client = createOneClick(
      async () => new Response("PRIVATE-error", { status }),
    );
    await assert.rejects(
      client.dryQuote(input),
      (error) =>
        error instanceof Error &&
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes("PRIVATE"),
    );
  }
  const client = createOneClick(async () => {
    throw new Error("PRIVATE-network-timeout");
  });
  await assert.rejects(
    client.dryQuote(input),
    /This command sent no funds; no automatic retry/,
  );
});

function statusFixture(
  status: string,
  change: (value: StatusFixture) => void = () => {},
) {
  let requested = "";
  const client = createOneClick(async (url) => {
    requested = String(url);
    const response: StatusFixture = {
      status,
      quoteResponse: {
        quote: { depositAddress: "deposit.near" },
        quoteRequest: { dry: false, refundTo: "worker.near" },
      },
      swapDetails: {
        originChainTxHashes: [{ hash: "origin-hash" }],
        destinationChainTxHashes: [{ hash: "destination-hash" }],
        refundedAmount: "998000",
      },
    };
    change(response);
    return Response.json(response);
  });
  return { client, requested: () => requested };
}

test("all seven API statuses are informational and cannot pay or retry", async () => {
  for (const status of [
    "PENDING_DEPOSIT",
    "KNOWN_DEPOSIT_TX",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
  ]) {
    const { client, requested } = statusFixture(status);
    const result = await client.status("deposit.near");
    assert.equal(result.status, status);
    assert.equal(
      result.terminal,
      ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(status),
    );
    assert.equal(result.chain_verified, false);
    assert.equal(result.execution_enabled, false);
    assert.equal(result.refund_to, "worker.near");
    assert.equal(
      requested(),
      "https://1click.chaindefuser.com/v0/status?depositAddress=deposit.near",
    );
    if (status === "REFUNDED") assert.match(result.action, /fees may reduce/);
    if (status === "FAILED")
      assert.match(result.action, /does not prove a refund/);
  }
});

test("unknown, unbound or malformed status is an error, never a refund or success", async () => {
  for (const change of [
    (value: StatusFixture) => {
      value.status = "NEW_STATE";
    },
    (value: StatusFixture) => {
      value.quoteResponse.quote.depositAddress = "other.near";
    },
    (value: StatusFixture) => {
      value.quoteResponse.quoteRequest.dry = true;
    },
    (value: StatusFixture) => {
      value.swapDetails.destinationChainTxHashes = "bad";
    },
  ])
    await assert.rejects(
      statusFixture("SUCCESS", change).client.status("deposit.near"),
    );
});

test("memo-based status queries bind both the address and memo", async () => {
  const fixture = statusFixture("PROCESSING", (value) => {
    value.quoteResponse.quote.depositMemo = "12345";
  });
  await assert.rejects(fixture.client.status("deposit.near"));
  await assert.rejects(fixture.client.status("deposit.near", "different"));
  const result = await fixture.client.status("deposit.near", "12345");
  assert.equal(result.deposit_memo, "12345");
  assert.equal(
    new URL(fixture.requested()).searchParams.get("depositMemo"),
    "12345",
  );
});

test("settlement CLI works without --dry-run and remains incapable of payment", async () => {
  const { client, calls } = fixture();
  let output = "",
    diagnostic = "";
  const code = await runCli(
    ["quote", JSON.stringify(input)],
    async () => settlementService(client),
    {
      input: (async function* () {})(),
      output: (value) => {
        output += value;
      },
      diagnostic: (value) => {
        diagnostic += value;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(diagnostic, "");
  assert.equal(JSON.parse(output).execution_enabled, false);
  assert.equal(JSON.parse(String(calls[1]!.options?.body)).dry, true);
  await assert.rejects(settlementService(client).executeTool("pay", {}));
  await assert.rejects(
    settlementService(client).executeTool("status", {
      deposit_address: "deposit.near",
      amount: "1",
    }),
  );
});
