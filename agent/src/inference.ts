// The one client for every model call (RULES section 7). It records tokens and cost per stage,
// per run and per agent, including failed calls, and enforces a per-agent limit before spending.
// Prompts, responses and keys are never logged. Model output is untrusted text: nothing here acts
// on it, and it can never decide payment.
import { sha256Hex } from "../../relay/src/hash.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PublicError, safeCode } from "./errors.ts";
import { isObject, jsonObject } from "./json.ts";
import {
  LEDGER_ERROR,
  nonnegativeInteger,
  parseLedgerRow,
  parseModelReply,
  type LedgerRow,
  type ModelReply,
} from "./inference-data.ts";
export type { LedgerRow } from "./inference-data.ts";

export const API = "https://cloud-api.near.ai/v1";
export const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
const TIMEOUT_MS = 300_000;
/** Most reasoning tokens per call, so a long think still leaves room for an answer. */
const THINKING_BUDGET = 4_000;
const NANO_PER_USD = 1_000_000_000;

export interface ModelPrice {
  inputNanoUsd: number;
  outputNanoUsd: number;
  verifiable: boolean;
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallRequest {
  /** Who spends: an agent id, or `review`. */
  spender: string;
  stage: string;
  run: string;
  /** The model key. A key pool fills it in, so pooled callers leave it out. */
  key?: string;
  messages: Message[];
  maxOutputTokens: number;
  model?: string;
  /** The key's environment variable name, for the ledger. Never the key itself. */
  keyName?: string;
  /** Hard local limit for this spender, in nano-USD. Refused before spending if it could pass. */
  limitNanoUsd?: number;
  /** Explicitly retain only public bid-review responses for fingerprint-proven reasons. */
  retainPublicResponse?: boolean;
}

export interface CallResult {
  text: string;
  finishReason: string | null;
  chatId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
  requestHash: string;
  responseHash: string;
  publicResponseBody?: string;
}

export class Ledger {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  append(row: LedgerRow): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }
  rows(): LedgerRow[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new PublicError(
        "The inference ledger could not be read. Reconcile it before spending.",
      );
    }
    return text.split("\n").filter(Boolean).map(parseLedgerRow);
  }
  spentNanoUsd(spender: string): number {
    const spent = this.rows()
      .filter((row) => row.spender === spender)
      .reduce((sum, row) => sum + row.cost_nano_usd, 0);
    if (!Number.isSafeInteger(spent)) throw new PublicError(LEDGER_ERROR);
    return spent;
  }
}

/** Prices from the public model list. A model with no listed price cannot be called. */
export async function fetchPrices(
  fetcher: typeof fetch = fetch,
): Promise<Map<string, ModelPrice>> {
  const response = await fetcher(`${API}/model/list`);
  if (!response.ok)
    throw new PublicError("The model price list is unavailable.");
  const body = jsonObject(
    await response.text(),
    "The model price list is not valid JSON.",
  );
  if (!Array.isArray(body.models))
    throw new PublicError("The model price list has no valid models array.");
  const prices = new Map<string, ModelPrice>();
  for (const model of body.models) {
    if (!isObject(model))
      throw new PublicError("The model price list contains an invalid entry.");
    const input = model.inputCostPerToken;
    const output = model.outputCostPerToken;
    if (
      typeof model.modelId === "string" &&
      model.modelId &&
      isObject(input) &&
      isObject(output) &&
      input.scale === 9 &&
      output.scale === 9
    ) {
      if (
        !nonnegativeInteger(input.amount) ||
        !nonnegativeInteger(output.amount)
      )
        throw new PublicError(
          "The model price list contains invalid token prices.",
        );
      prices.set(model.modelId, {
        inputNanoUsd: input.amount,
        outputNanoUsd: output.amount,
        verifiable:
          isObject(model.metadata) && model.metadata.verifiable === true,
      });
    }
  }
  return prices;
}

export function usd(nano: number): string {
  return (nano / NANO_PER_USD).toFixed(6);
}

export class ModelClient {
  private readonly ledger: Ledger;
  private readonly prices: Map<string, ModelPrice>;
  private readonly fetcher: typeof fetch;
  constructor(
    ledger: Ledger,
    prices: Map<string, ModelPrice>,
    fetcher: typeof fetch = fetch,
  ) {
    this.ledger = ledger;
    this.prices = prices;
    this.fetcher = fetcher;
  }

  async call(request: CallRequest): Promise<CallResult> {
    if (!request.key) throw new PublicError("No model key is configured.");
    const model = request.model ?? DEFAULT_MODEL;
    const price = this.prices.get(model);
    if (!price) throw new PublicError(`Model ${model} has no listed price.`);
    if (!price.verifiable)
      throw new PublicError(`Model ${model} is not verifiable.`);
    const body = JSON.stringify({
      model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens,
      temperature: 0.7,
      thinking_token_budget: THINKING_BUDGET,
    });
    // Tokens are roughly 4 bytes each; counting every byte as a token stays on the safe side.
    const worst =
      Buffer.byteLength(body, "utf8") * price.inputNanoUsd +
      request.maxOutputTokens * price.outputNanoUsd;
    if (
      !nonnegativeInteger(worst) ||
      !nonnegativeInteger(request.maxOutputTokens) ||
      request.maxOutputTokens === 0
    )
      throw new PublicError("The model request cannot be priced safely.");
    const spent = this.ledger.spentNanoUsd(request.spender);
    if (request.limitNanoUsd !== undefined) {
      if (spent + worst > request.limitNanoUsd) {
        throw new PublicError(
          `${request.spender} has reached its inference limit.`,
        );
      }
    }
    const requestHash = sha256Hex(body);
    const row = (status: number): LedgerRow => ({
      at: new Date().toISOString(),
      spender: request.spender,
      stage: request.stage,
      run: request.run,
      ...(request.keyName ? { key_name: request.keyName } : {}),
      model,
      status,
      input_tokens: 0,
      output_tokens: 0,
      cost_nano_usd: 0,
      chat_id: null,
      request_hash: requestHash,
      response_hash: null,
    });
    let response: Response;
    try {
      response = await this.fetcher(`${API}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.key}`,
          "content-type": "application/json",
          "accept-encoding": "identity",
          "x-no-aliasing": "true",
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // A code only: no request or key text is ever in it.
      console.error(`model call failed: ${safeCode(error)}`);
      // The outcome is unknown and it may have been charged, so count the worst case: the local
      // limit must never be passed because of a call we could not see finish.
      this.ledger.append({ ...row(0), cost_nano_usd: worst });
      throw new ModelInterrupted("transport");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      this.ledger.append({ ...row(response.status), cost_nano_usd: worst });
      throw new ModelInterrupted("response_read");
    }
    if (!response.ok) {
      this.ledger.append(row(response.status));
      throw new ModelRefused(
        response.status,
        errorCode(bytes),
        errorMessage(bytes),
      );
    }
    const responseHash = sha256Hex(bytes);
    let parsed: ModelReply;
    try {
      parsed = parseModelReply(new TextDecoder().decode(bytes));
    } catch {
      this.ledger.append({
        ...row(response.status),
        cost_nano_usd: worst,
        response_hash: responseHash,
      });
      throw new PublicError(
        "The model response is malformed. Its possible cost was reserved; no output was accepted.",
      );
    }
    const inputTokens = parsed.usage.prompt_tokens;
    const outputTokens = parsed.usage.completion_tokens;
    const costNanoUsd =
      inputTokens * price.inputNanoUsd + outputTokens * price.outputNanoUsd;
    if (!nonnegativeInteger(costNanoUsd)) {
      this.ledger.append({
        ...row(response.status),
        cost_nano_usd: worst,
        response_hash: responseHash,
      });
      throw new PublicError(
        "The model response has an invalid cost. Its possible cost was reserved.",
      );
    }
    this.ledger.append({
      ...row(response.status),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_nano_usd: costNanoUsd,
      chat_id: parsed.id,
      response_hash: responseHash,
    });
    return {
      text: parsed.choices[0]!.message.content ?? "",
      finishReason: parsed.choices[0]!.finish_reason,
      chatId: parsed.id,
      model,
      inputTokens,
      outputTokens,
      costNanoUsd,
      requestHash,
      responseHash,
      ...(request.retainPublicResponse
        ? { publicResponseBody: new TextDecoder().decode(bytes) }
        : {}),
    };
  }
}

/** A possibly charged request whose transport or response ended without a usable outcome. */
export class ModelInterrupted extends PublicError {
  readonly phase: "transport" | "response_read";
  constructor(phase: "transport" | "response_read") {
    super(
      phase === "transport"
        ? "The model call did not complete."
        : "The model response could not be read. Its possible cost was reserved.",
    );
    this.phase = phase;
  }
}

export class ModelRefused extends PublicError {
  readonly status: number;
  readonly code: string;
  /** True only for NEAR AI's own statement that this key reached its limit. */
  readonly limitReached: boolean;
  constructor(status: number, code: string, message = "") {
    super(`The model service refused the call: HTTP ${status} (${code}).`);
    this.status = status;
    this.code = code;
    this.limitReached =
      status === 402 && message.startsWith("API key spend limit exceeded");
  }
}

/** Only a short machine code from the server's error, never free text that could echo a key. */
function errorMessage(bytes: Uint8Array): string {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as {
      error?: { message?: unknown };
    };
    return typeof body.error?.message === "string" ? body.error.message : "";
  } catch {
    return "";
  }
}

function errorCode(bytes: Uint8Array): string {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as {
      error?: { type?: unknown; code?: unknown };
    };
    const code = body.error?.code ?? body.error?.type;
    return typeof code === "string" && /^[a-z0-9_.-]{1,64}$/i.test(code)
      ? code
      : "unknown";
  } catch {
    return "unknown";
  }
}
