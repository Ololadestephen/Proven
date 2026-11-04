import { PublicError } from "./errors.ts";

const API = "https://1click.chaindefuser.com";
const MAX_RESPONSE = 1024 * 1024;
type Json = Record<string, unknown>;
type Transport = typeof fetch;

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PublicError("Invalid 1Click JSON object.");
  return value as Json;
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\s\x00-\x1f]/.test(value)
  )
    throw new PublicError("Invalid 1Click text field.");
  return value;
}
function units(value: unknown, allowZero = false): string {
  const result = text(value, 78);
  if (!/^(0|[1-9][0-9]*)$/.test(result) || (!allowZero && result === "0"))
    throw new PublicError(
      "Amounts must be positive integer strings in token base units.",
    );
  return result;
}

export interface DryQuoteInput {
  origin_asset: string;
  destination_asset: string;
  amount: string;
  refund_to: string;
  recipient: string;
  slippage_bps: number;
}

function quoteInput(value: unknown): DryQuoteInput {
  const input = object(value);
  const allowed = [
    "origin_asset",
    "destination_asset",
    "amount",
    "refund_to",
    "recipient",
    "slippage_bps",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new PublicError(
      "Unknown quote argument. This command supports dry quotes only.",
    );
  const slippage = input.slippage_bps ?? 100;
  if (
    !Number.isInteger(slippage) ||
    (slippage as number) < 0 ||
    (slippage as number) > 100
  )
    throw new PublicError("slippage_bps must be an integer from 0 to 100.");
  return {
    origin_asset: text(input.origin_asset),
    destination_asset: text(input.destination_asset),
    amount: units(input.amount),
    refund_to: text(input.refund_to, 128),
    recipient: text(input.recipient, 128),
    slippage_bps: slippage as number,
  };
}

const RECOVERY = {
  PENDING_DEPOSIT:
    "Awaiting a deposit. No payment or refund is proven by this API status.",
  KNOWN_DEPOSIT_TX:
    "Deposit transaction reported. Wait for confirmation; do not send again.",
  INCOMPLETE_DEPOSIT:
    "Deposit is incomplete. Reconcile the original quote and chain history; do not automatically top up.",
  PROCESSING:
    "Settlement is processing. Wait and reconcile; do not send again.",
  SUCCESS:
    "API reports settlement success. Verify the destination transaction independently.",
  REFUNDED:
    "API reports a refund to the original quote's refundTo address. Verify the refund transaction and amount independently; fees may reduce it.",
  FAILED:
    "API reports failure. This does not prove a refund. Preserve the quote and deposit evidence, reconcile chain history and contact 1Click support before any retry.",
} as const;

async function request(
  transport: Transport,
  path: string,
  body?: Json,
): Promise<unknown> {
  try {
    const response = await transport(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PublicError(
        `1Click returned HTTP ${response.status}. This command sent no funds. Check route availability and minimum amount.`,
      );
    }
    if (!response.body) throw new Error("Missing body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) throw new Error("Oversized body");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError(
      "1Click request failed or returned an invalid response. This command sent no funds; no automatic retry was made.",
    );
  }
}

async function dryQuote(
  value: unknown,
  transport: Transport,
  now: () => number,
) {
  const input = quoteInput(value);
  const tokens = await request(transport, "/v0/tokens");
  if (!Array.isArray(tokens))
    throw new PublicError("Invalid 1Click token list.");
  const origin = token(tokens, input.origin_asset),
    destination = token(tokens, input.destination_asset);
  const quoteRequest = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: input.slippage_bps,
    originAsset: origin.asset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: destination.asset,
    amount: input.amount,
    refundTo: input.refund_to,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now() + 60 * 60 * 1000).toISOString(),
  };
  const result = object(await request(transport, "/v0/quote", quoteRequest));
  const validated = validateQuote(result, quoteRequest, input, now());
  return {
    mode: "dry_quote",
    network: "mainnet_quotes_only",
    execution_enabled: false,
    source: API,
    fetched_at: new Date(now()).toISOString(),
    origin,
    destination,
    quote_request: quoteRequest,
    correlation_id: text(result.correlationId),
    timestamp: validated.timestamp,
    service_signature: text(result.signature, 4096),
    signature_verified: false,
    quote: validated.quote,
    note: "Unauthenticated API estimate only. No deposit address requested, no funds moved and no job verdict required for a dry quote. This is not a settlement authorization.",
  };
}

async function status(
  transport: Transport,
  address: unknown,
  memoValue?: unknown,
) {
  const depositAddress = text(address, 128);
  const memo = memoValue === undefined ? undefined : text(memoValue, 128);
  const query = new URLSearchParams({ depositAddress });
  if (memo !== undefined) query.set("depositMemo", memo);
  const response = object(await request(transport, `/v0/status?${query}`));
  const quoteResponse = object(response.quoteResponse),
    quote = object(quoteResponse.quote);
  const originalRequest = object(quoteResponse.quoteRequest);
  if (
    quote.depositAddress !== depositAddress ||
    quote.depositMemo !== memo ||
    originalRequest.dry !== false
  )
    throw new PublicError(
      "1Click status is not bound to the requested real deposit address.",
    );
  if (
    typeof response.status !== "string" ||
    !Object.hasOwn(RECOVERY, response.status)
  )
    throw new PublicError(
      "Unknown 1Click settlement status. Reconcile manually; do not retry a payment.",
    );
  const state = response.status as keyof typeof RECOVERY;
  const details = object(response.swapDetails);
  return {
    mode: "status_read_only",
    source: API,
    execution_enabled: false,
    deposit_address: depositAddress,
    ...(memo === undefined ? {} : { deposit_memo: memo }),
    status: state,
    terminal: ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(
      state,
    ),
    action: RECOVERY[state],
    chain_verified: false,
    origin_transaction_hashes: hashes(details, "originChainTxHashes"),
    destination_transaction_hashes: hashes(details, "destinationChainTxHashes"),
    ...(details.refundedAmount === undefined
      ? {}
      : { refunded_amount: units(details.refundedAmount, true) }),
    refund_to: text(originalRequest.refundTo, 128),
    note: "1Click status is not an escrow verdict and cannot release or refund a Proven job. FAILED is not proof of a refund. No payment retry is performed.",
  };
}

function token(tokenList: unknown[], id: string) {
  const matches = tokenList.filter((item) => object(item).assetId === id);
  if (matches.length !== 1)
    throw new PublicError(
      "Asset is missing or ambiguous in the current 1Click token list.",
    );
  const item = object(matches[0]);
  if (
    !Number.isInteger(item.decimals) ||
    (item.decimals as number) < 0 ||
    (item.decimals as number) > 36
  )
    throw new PublicError("Invalid token decimals.");
  return {
    asset: id,
    chain: text(item.blockchain),
    symbol: text(item.symbol),
    decimals: item.decimals as number,
  };
}

function hashes(details: Json, field: string) {
  const entries = details[field];
  if (!Array.isArray(entries) || entries.length > 100)
    throw new PublicError("Invalid 1Click transaction evidence.");
  return entries.map((entry) => text(object(entry).hash));
}

/** Read-only API adapter. No credentials, signer, real quote or deposit endpoint. */
export function createOneClick(transport: Transport = fetch, now = Date.now) {
  return {
    dryQuote: (value: unknown) => dryQuote(value, transport, now),
    status: (address: unknown, memo?: unknown) =>
      status(transport, address, memo),
  };
}

function validateQuote(
  result: Json,
  expectedRequest: Json,
  input: DryQuoteInput,
  clock: number,
) {
  const echoed = object(result.quoteRequest),
    quote = object(result.quote);
  for (const [key, expected] of Object.entries(expectedRequest)) {
    if (echoed[key] !== expected)
      throw new PublicError(
        "1Click quote does not match the requested route, addresses or limits.",
      );
  }
  if (
    [
      "depositAddress",
      "depositMemo",
      "chainDepositAddresses",
      "deadline",
      "timeWhenInactive",
    ].some((key) => key in quote)
  )
    throw new PublicError(
      "1Click returned funding fields for a dry quote. Refusing the response.",
    );
  const timestamp = text(result.timestamp);
  if (
    !Number.isFinite(Date.parse(timestamp)) ||
    Math.abs(clock - Date.parse(timestamp)) > 5 * 60 * 1000
  )
    throw new PublicError("1Click quote timestamp is invalid or stale.");
  const amountIn = units(quote.amountIn),
    amountOut = units(quote.amountOut),
    minAmountOut = units(quote.minAmountOut);
  const minAmountIn = units(quote.minAmountIn);
  if (
    amountIn !== input.amount ||
    BigInt(minAmountIn) > BigInt(amountIn) ||
    BigInt(minAmountOut) <
      (BigInt(amountOut) * BigInt(10_000 - input.slippage_bps)) / 10_000n ||
    BigInt(minAmountOut) > BigInt(amountOut)
  )
    throw new PublicError(
      "1Click quote amounts do not match EXACT_INPUT bounds.",
    );
  if (
    typeof quote.timeEstimate !== "number" ||
    !Number.isFinite(quote.timeEstimate) ||
    quote.timeEstimate < 0
  )
    throw new PublicError("Invalid 1Click time estimate.");

  return {
    timestamp,
    quote: {
      amountIn,
      minAmountIn,
      amountOut,
      minAmountOut,
      timeEstimate: quote.timeEstimate,
      ...(quote.refundFee === undefined
        ? {}
        : { refundFee: units(quote.refundFee, true) }),
      ...(quote.withdrawFee === undefined
        ? {}
        : { withdrawFee: units(quote.withdrawFee, true) }),
    },
  };
}
