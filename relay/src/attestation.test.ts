// Tests against a real testnet attestation: OutLayer job 15385 (request 6145), the P1 spike run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type AttestationRecord,
  checkAttestation,
  type Expected,
  taskHash,
} from "./attestation.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";

const record: AttestationRecord = JSON.parse(
  readFileSync("test-fixtures/outlayer-job-15385.json", "utf8"),
);
const input = readFileSync(
  "test-fixtures/outlayer-job-15385-input.json",
  "utf8",
);
const output = {
  pass: true,
  reason: "lines sum to the total",
  input_sha256:
    "f06dc0af1a86408e280f92aa9de11aa16209d617eba2f115a21a17ceb0e7fd44",
};
const expected: Expected = {
  wasmHash: "4398d9236325ecb5b2c99a00a9fc4c076603145f5f2ae39f3b6810f644ae3af2",
  inputText: input,
  outputHash: sha256Hex(canonicalJson(output)),
  caller: "proven.testnet",
  transactionHash: "BAdj3FiRM4NfrTKB88DLi1i3w3i5q9nytCK6TqwApEBE",
};

test("canonical JSON sorts keys and matches OutLayer's output hash", () => {
  assert.equal(
    canonicalJson({ b: [1, { d: null, c: true }], a: "x" }),
    '{"a":"x","b":[1,{"c":true,"d":null}]}',
  );
  assert.equal(expected.outputHash, record.output_hash);
});

test("task hash matches the commitment Intel signed for job 15385", () => {
  assert.equal(
    taskHash(record),
    "0632316420e82792c83a1e3072349d335fffbc9ab231514251bbf8cda68ffd7f",
  );
});

test("a genuine attestation passes every relay check", () => {
  assert.equal(checkAttestation(record, expected), taskHash(record));
});

test("tampering with what was run or returned is caught", () => {
  const cases: Array<[string, Partial<Expected>, RegExp]> = [
    ["another verifier build", { wasmHash: "0".repeat(64) }, /wasm_hash/],
    ["another input", { inputText: input + " " }, /input_hash/],
    ["another output", { outputHash: sha256Hex("{}") }, /output_hash/],
    ["another caller", { caller: "someone.testnet" }, /caller/],
    ["another transaction", { transactionHash: "x" }, /transaction/],
    [
      "another secret",
      { secretsRef: "someone.testnet/profile" },
      /secrets_ref/,
    ],
  ];
  for (const [name, change, error] of cases) {
    assert.throws(
      () => checkAttestation(record, { ...expected, ...change }),
      error,
      name,
    );
  }
});

test("a record whose fields were edited no longer matches the quote", () => {
  const edited = { ...record, output_hash: sha256Hex("forged") };
  assert.throws(
    () =>
      checkAttestation(edited, { ...expected, outputHash: edited.output_hash }),
    /task hash mismatch/,
  );
  const quote = Buffer.from(record.tdx_quote, "base64");
  quote[520] ^= 0xff;
  assert.throws(
    () =>
      checkAttestation(
        { ...record, tdx_quote: quote.toString("base64") },
        expected,
      ),
    /RTMR3/,
  );
});

test("the rebuilt input includes the format hash, as in a real mainnet run", async () => {
  const { runInput } = await import("./cli.ts");
  // proven-escrow.near job 2, OutLayer request 2858, whose attested input_hash is below.
  const job = {
    spec_hash:
      "b6ea8f968b89dc6d048e8ad79930885a50efcb7dfc36fa7b3e81cca9d4026e88",
    fakes_hash:
      "2c21728a2970b469ab93d6c1ed070845feb203ab6f3ceebe132403267291e8c8",
    format_hash:
      "49f904652939a67c775a566bac3be03703bfe3126b1385ffbe337d549fdd5159",
  } as Parameters<typeof runInput>[0];
  assert.equal(
    sha256Hex(runInput(job, 2, "Challenge", "proven-escrow.near")),
    "942b23166961f6b3c8833a4d44fc1a47732f18115e5605668213aef3e7cf005f",
  );
});

test("the relay rebuilds exactly the input the contract sent to OutLayer", async () => {
  const { runInput } = await import("./cli.ts");
  // The real input of escrow-v2 job 0 (OutLayer request 8667), whose attested input_hash is below.
  const job = {
    spec_hash:
      "fee7502fb427d36f939abba0a6be20039b2b5351ff854389208716fa51f3c47f",
    fakes_hash:
      "9c0cb42926c605d11c696e52e821793097358176d5ac6d5a833bb91fa14418dc",
    deliverable_hash: "c".repeat(64),
  } as Parameters<typeof runInput>[0];
  const input = runInput(job, 0, "Challenge", "escrow-v2.proven.testnet");
  assert.equal(
    sha256Hex(input),
    "0b1ac1173baef271678141e9366be6295ce1f66c8d7140d29dd10d6c12956a87",
  );
  assert.equal(
    runInput(job, 7, "Verify", "e.testnet"),
    `{"mode":"verify","escrow":"e.testnet","job":7,"check_hash":"${job.spec_hash}","deliverable_hash":"${"c".repeat(64)}"}`,
  );
});
