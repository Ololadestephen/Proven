import { PublicError } from "./errors.ts";
import { isObject, jsonObject } from "./json.ts";

export interface LedgerRow {
  at: string;
  spender: string;
  stage: string;
  run: string;
  key_name?: string;
  model: string;
  status: number;
  input_tokens: number;
  output_tokens: number;
  cost_nano_usd: number;
  chat_id: string | null;
  request_hash: string;
  response_hash: string | null;
}

export const LEDGER_ERROR =
  "The inference ledger is invalid. Reconcile it before spending.";
export function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function parseLedgerRow(text: string): LedgerRow {
  const value = jsonObject(text, LEDGER_ERROR);
  const strings = ["at", "spender", "stage", "run", "model", "request_hash"];
  if (
    strings.some((field) => typeof value[field] !== "string") ||
    !nonnegativeInteger(value.status) ||
    value.status > 599 ||
    !nonnegativeInteger(value.input_tokens) ||
    !nonnegativeInteger(value.output_tokens) ||
    !nonnegativeInteger(value.cost_nano_usd) ||
    !(value.chat_id === null || typeof value.chat_id === "string") ||
    !(
      value.response_hash === null || typeof value.response_hash === "string"
    ) ||
    !(value.key_name === undefined || typeof value.key_name === "string")
  )
    throw new PublicError(LEDGER_ERROR);
  return value as unknown as LedgerRow;
}
export interface ModelReply {
  id: string;
  choices: Array<{
    message: { content: string | null };
    finish_reason: string | null;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}
export function parseModelReply(text: string): ModelReply {
  const message = "The model response is malformed.";
  const value = jsonObject(text, message);
  if (
    typeof value.id !== "string" ||
    !value.id ||
    !Array.isArray(value.choices) ||
    value.choices.length === 0 ||
    !isObject(value.usage) ||
    !nonnegativeInteger(value.usage.prompt_tokens) ||
    !nonnegativeInteger(value.usage.completion_tokens) ||
    value.choices.some(
      (choice) =>
        !isObject(choice) ||
        !isObject(choice.message) ||
        !(
          choice.message.content === null ||
          typeof choice.message.content === "string"
        ) ||
        !(
          choice.finish_reason === null ||
          typeof choice.finish_reason === "string"
        ),
    )
  )
    throw new PublicError(message);
  return value as unknown as ModelReply;
}
