import assert from "node:assert/strict";
import test from "node:test";
import {
  LEDGER_ERROR,
  parseLedgerRow,
  parseModelReply,
} from "./inference-data.ts";

const row = {
  at: "2026-11-12T10:00:00.000Z",
  spender: "agent-a",
  stage: "work",
  run: "bid-3",
  model: "z-ai/glm-5.3-flash",
  status: 200,
  input_tokens: 690,
  output_tokens: 1994,
  cost_nano_usd: 4_437_660,
  chat_id: "d051020bb60d41d1a6236a4d397b66c5",
  request_hash: "a".repeat(64),
  response_hash: null,
};

test("a valid ledger row parses, with or without a key name", () => {
  assert.deepEqual(parseLedgerRow(JSON.stringify(row)), row);
  const named = { ...row, key_name: "NEARAI_KEY_HOSTED" };
  assert.equal(parseLedgerRow(JSON.stringify(named)).key_name, named.key_name);
});

test("a ledger row with a bad cost, status or field is refused", () => {
  for (const bad of [
    { ...row, cost_nano_usd: -1 },
    { ...row, cost_nano_usd: 1.5 },
    { ...row, input_tokens: "690" },
    { ...row, status: 600 },
    { ...row, chat_id: 7 },
    { ...row, key_name: 7 },
    { ...row, model: undefined },
  ])
    assert.throws(() => parseLedgerRow(JSON.stringify(bad)), {
      message: LEDGER_ERROR,
    });
  for (const text of ["", "not json", "[]", "null"])
    assert.throws(() => parseLedgerRow(text), { message: LEDGER_ERROR });
});

const reply = {
  id: "chat-1",
  choices: [{ message: { content: '{"rows":[]}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

test("a valid model reply parses, including a null content or finish reason", () => {
  assert.deepEqual(parseModelReply(JSON.stringify(reply)), reply);
  const empty = {
    ...reply,
    choices: [{ message: { content: null }, finish_reason: null }],
  };
  assert.deepEqual(parseModelReply(JSON.stringify(empty)), empty);
});

test("a model reply without choices, usage or an id is malformed", () => {
  for (const bad of [
    { ...reply, choices: [] },
    { ...reply, id: "" },
    { ...reply, usage: { prompt_tokens: 10 } },
    { ...reply, choices: [{ message: { content: 7 }, finish_reason: null }] },
    { ...reply, choices: [{ finish_reason: "stop" }] },
  ])
    assert.throws(() => parseModelReply(JSON.stringify(bad)), {
      message: "The model response is malformed.",
    });
  assert.throws(() => parseModelReply("{"), {
    message: "The model response is malformed.",
  });
});
