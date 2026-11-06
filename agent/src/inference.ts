// The one client for every model call (RULES section 7). It records tokens and cost per stage,
// per run and per agent, including failed calls, and enforces a per-agent limit before spending.
// Prompts, responses and keys are never logged. Model output is untrusted text: nothing here acts
// on it, and it can never decide payment.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PublicError } from "./errors.ts";

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
  role: "system" | "user";
  content: string;
}

export interface CallRequest {
  /** Who spends: an agent id, or `review`. */
  spender: string;
  stage: string;
  run: string;
  key: string;
  messages: Message[];
  maxOutputTokens: number;
  model?: string;
  /** Hard local limit for this spender, in nano-USD. Refused before spending if it could pass. */
  limitNanoUsd?: number;
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
}

export interface LedgerRow {
  at: string;
  spender: string;
  stage: string;
  run: string;
  model: string;
  status: number;
  input_tokens: number;
  output_tokens: number;
  cost_nano_usd: number;
  chat_id: string | null;
  request_hash: string;
  response_hash: string | null;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerRow);
  }
  spentNanoUsd(spender: string): number {
    return this.rows()
      .filter((row) => row.spender === spender)
      .reduce((sum, row) => sum + row.cost_nano_usd, 0);
  }
}

/** Prices from the public model list. A model with no listed price cannot be called. */
export async function fetchPrices(
  fetcher: typeof fetch = fetch,
): Promise<Map<string, ModelPrice>> {
  const response = await fetcher(`${API}/model/list`);
  if (!response.ok)
    throw new PublicError("The model price list is unavailable.");
  const body = (await response.json()) as {
    models?: Array<{
      modelId?: string;
      inputCostPerToken?: { amount?: number; scale?: number };
      outputCostPerToken?: { amount?: number; scale?: number };
      metadata?: { verifiable?: boolean };
    }>;
  };
  const prices = new Map<string, ModelPrice>();
  for (const model of body.models ?? []) {
    const input = model.inputCostPerToken;
    const output = model.outputCostPerToken;
    if (model.modelId && input?.scale === 9 && output?.scale === 9) {
      prices.set(model.modelId, {
        inputNanoUsd: input.amount ?? 0,
        outputNanoUsd: output.amount ?? 0,
        verifiable: model.metadata?.verifiable === true,
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
      body.length * price.inputNanoUsd +
      request.maxOutputTokens * price.outputNanoUsd;
    if (request.limitNanoUsd !== undefined) {
      if (
        this.ledger.spentNanoUsd(request.spender) + worst >
        request.limitNanoUsd
      ) {
        throw new PublicError(
          `${request.spender} has reached its inference limit.`,
        );
      }
    }
    const requestHash = sha256(body);
    const row = (status: number): LedgerRow => ({
      at: new Date().toISOString(),
      spender: request.spender,
      stage: request.stage,
      run: request.run,
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
    } catch {
      // The outcome is unknown and it may have been charged, so count the worst case: the local
      // limit must never be passed because of a call we could not see finish.
      this.ledger.append({ ...row(0), cost_nano_usd: worst });
      throw new PublicError("The model call did not complete.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      this.ledger.append(row(response.status));
      throw new ModelRefused(response.status, errorCode(bytes));
    }
    const responseHash = sha256(bytes);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      id?: string;
      choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const inputTokens = parsed.usage?.prompt_tokens ?? 0;
    const outputTokens = parsed.usage?.completion_tokens ?? 0;
    const costNanoUsd =
      inputTokens * price.inputNanoUsd + outputTokens * price.outputNanoUsd;
    this.ledger.append({
      ...row(response.status),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_nano_usd: costNanoUsd,
      chat_id: parsed.id ?? null,
      response_hash: responseHash,
    });
    return {
      text: parsed.choices?.[0]?.message?.content ?? "",
      finishReason: parsed.choices?.[0]?.finish_reason ?? null,
      chatId: parsed.id ?? "",
      model,
      inputTokens,
      outputTokens,
      costNanoUsd,
      requestHash,
      responseHash,
    };
  }
}

export class ModelRefused extends PublicError {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`The model service refused the call: HTTP ${status} (${code}).`);
    this.status = status;
    this.code = code;
  }
}

/** Only a short machine code from the server's error, never free text that could echo a key. */
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
