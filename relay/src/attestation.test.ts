// Tests against a real testnet attestation: OutLayer job 15385 (request 6145), the P1 spike run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type AttestationRecord, checkAttestation, taskHash } from "./attestation.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";

const record: AttestationRecord = JSON.parse(readFileSync("test-fixtures/outlayer-job-15385.json", "utf8"));
const input = readFileSync("test-fixtures/outlayer-job-15385-input.json", "utf8");
const output = { pass: true, reason: "lines sum to the total", input_sha256: "f06dc0af1a86408e280f92aa9de11aa16209d617eba2f115a21a17ceb0e7fd44" };
const expected = {
  wasmHash: "4398d9236325ecb5b2c99a00a9fc4c076603145f5f2ae39f3b6810f644ae3af2",
  inputText: input,
  outputHash: sha256Hex(canonicalJson(output)),
  caller: "proven.testnet",
  transactionHash: "BAdj3FiRM4NfrTKB88DLi1i3w3i5q9nytCK6TqwApEBE",
};

test("canonical JSON sorts keys and matches OutLayer's output hash", () => {
  assert.equal(canonicalJson({ b: [1, { d: null, c: true }], a: "x" }), '{"a":"x","b":[1,{"c":true,"d":null}]}');
  assert.equal(expected.outputHash, record.output_hash);
});

test("task hash matches the commitment Intel signed for job 15385", () => {
  assert.equal(taskHash(record), "0632316420e82792c83a1e3072349d335fffbc9ab231514251bbf8cda68ffd7f");
});

test("a genuine attestation passes every relay check", () => {
  assert.equal(checkAttestation(record, expected), taskHash(record));
});

test("tampering with what was run or returned is caught", () => {
  const cases: Array<[string, Partial<typeof expected>, RegExp]> = [
    ["another verifier build", { wasmHash: "0".repeat(64) }, /wasm_hash/],
    ["another input", { inputText: input + " " }, /input_hash/],
    ["another output", { outputHash: sha256Hex("{}") }, /output_hash/],
    ["another caller", { caller: "someone.testnet" }, /caller/],
    ["another transaction", { transactionHash: "x" }, /transaction/],
  ];
  for (const [name, change, error] of cases) {
    assert.throws(() => checkAttestation(record, { ...expected, ...change }), error, name);
  }
});

test("a record whose fields were edited no longer matches the quote", () => {
  const edited = { ...record, output_hash: sha256Hex("forged"), };
  assert.throws(() => checkAttestation(edited, { ...expected, outputHash: edited.output_hash }), /task hash mismatch/);
  const quote = Buffer.from(record.tdx_quote, "base64");
  quote[520] ^= 0xff;
  assert.throws(() => checkAttestation({ ...record, tdx_quote: quote.toString("base64") }, expected), /RTMR3/);
});
