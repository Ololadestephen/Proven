import assert from "node:assert/strict";
import test from "node:test";
import type { MarketBid, MarketJob } from "../ui/market-steps.ts";
import { sha256 } from "../ui/market-client.ts";
import {
  buildReceipt,
  deliveryFilename,
  displayWork,
  matchesDelivery,
} from "../ui/receipt.ts";

const madeAt = "2026-11-07T10:30:00.000Z";
const original = '{ "rows": [1, 2], "label": "café 🧾" }\r\n';
const bid: MarketBid = {
  id: 17,
  buyer: "buyer.testnet",
  description: "Check the rows",
  amount: "10000000000000000000000",
  check_hash: "a".repeat(64),
  reference_hash: "b".repeat(64),
  format_hash: "c".repeat(64),
  verifier_hash: "d".repeat(64),
  format: "{}",
  expires_at: "0",
  state: "Done",
  job_id: 23,
  allowed_workers: null,
  review: { allow: true },
  claim: null,
  claims_made: 1,
  funded_attempts: 1,
  job: null,
  last_job: null,
};
async function paidJob(): Promise<MarketJob> {
  return {
    id: 23,
    buyer: bid.buyer,
    worker: null,
    amount: bid.amount,
    state: "Released",
    deadline: "0",
    deliverable_hash: await sha256(original),
    fakes_caught: 13,
    fakes_total: 13,
    failed_rule: null,
    challenge_request_id: "11000",
    verdict_request_id: null,
    history: [
      {
        worker: "worker.testnet",
        outcome: "Paid",
        failed_rule: null,
        verdict_request_id: "11001",
      },
    ],
  };
}

test("paid receipt reports the chain accounts, separate bid/job IDs, amount, and injected local date", async () => {
  const job = await paidJob();
  const receipt = buildReceipt(bid, job, original, "testnet", madeAt);
  assert.match(receipt, /^# Proven job receipt/);
  assert.match(receipt, /Network: testnet/);
  assert.match(receipt, /Bid ID: ` 17 `/);
  assert.match(receipt, /Escrow job ID: ` 23 `/);
  assert.ok(receipt.includes(bid.buyer));
  assert.ok(receipt.includes("worker.testnet"));
  assert.ok(!receipt.includes("Worker: ` null"));
  assert.match(receipt, /Amount: 0\.01 NEAR/);
  assert.match(receipt, /Result: Paid/);
  assert.ok(receipt.includes(madeAt));
  assert.ok(receipt.includes(JSON.stringify(JSON.parse(original), null, 2)));
  assert.ok(
    receipt.includes(
      "The downloaded .json file, not this pretty copy, is the exact text the fingerprint proves.",
    ),
  );
  assert.equal(receipt, buildReceipt(bid, job, original, "testnet", madeAt));
});

test("refunded receipt retains the failed rule without turning failure into payment", async () => {
  const job: MarketJob = {
    ...(await paidJob()),
    state: "Refunded",
    history: [
      {
        worker: "worker.testnet",
        outcome: "Failed",
        failed_rule: "reconcile",
        verdict_request_id: "11002",
      },
    ],
  };
  const receipt = buildReceipt(bid, job, original, "testnet", madeAt);
  assert.match(receipt, /Result: Refunded/);
  assert.match(
    receipt,
    /Last completed attempt: Failed with rule ` reconcile `/,
  );
  assert.ok(!receipt.includes("Result: Paid"));
  assert.ok(receipt.includes("/attestations/by-request/11002"));
});

test("failed and pending jobs never claim a completed payout", async () => {
  const job = await paidJob();
  assert.match(
    buildReceipt(
      bid,
      { ...job, state: "Failed", failed_rule: "totals" },
      original,
      "testnet",
      madeAt,
    ),
    /Result: Failed with rule ` totals `/,
  );
  assert.match(
    buildReceipt(bid, { ...job, state: "Passed" }, original, "testnet", madeAt),
    /payment is not recorded as paid/,
  );
  assert.ok(
    !buildReceipt(
      bid,
      { ...job, state: "Paying" },
      original,
      "testnet",
      madeAt,
    ).includes("Result: Paid"),
  );
});

test("non-JSON work stays unchanged in the receipt and uses a .txt exact-file name", async () => {
  const text = "Invoice accepted? No.\r\n<untrusted>\ttext\n";
  const job = await paidJob();
  const receipt = buildReceipt(bid, job, text, "testnet", madeAt);
  assert.ok(receipt.includes(text));
  assert.equal(displayWork(text).pretty, text);
  assert.equal(deliveryFilename(bid, job, text), "bid-17-job-23-delivery.txt");
  assert.ok(receipt.includes("downloaded .txt file"));
});

test("mainnet receipt always includes unaudited owner-funded wording and the mainnet API", async () => {
  const receipt = buildReceipt(
    bid,
    await paidJob(),
    original,
    "mainnet",
    madeAt,
  );
  assert.ok(
    receipt.includes("Network: mainnet — unaudited, owner-funded deployment"),
  );
  assert.ok(
    receipt.includes("https://api.outlayer.ai/attestations/by-request/11001"),
  );
  assert.ok(!receipt.includes("testnet-api"));
});

test("receipt contains exact chain fingerprints and attestation links in the requested order", async () => {
  const job = await paidJob();
  const receipt = buildReceipt(bid, job, original, "testnet", madeAt);
  const expected = [
    "# Proven job receipt",
    "Network:",
    "Bid ID:",
    "Escrow job ID:",
    "Buyer:",
    "Worker:",
    "Amount:",
    "Result:",
    "https://testnet-api.outlayer.ai/attestations/by-request/11000",
    "https://testnet-api.outlayer.ai/attestations/by-request/11001",
    bid.check_hash,
    bid.reference_hash,
    bid.format_hash,
    job.deliverable_hash!,
    madeAt,
    "## Delivered work",
  ];
  let cursor = -1;
  for (const value of expected) {
    const next = receipt.indexOf(value, cursor + 1);
    assert.ok(next > cursor, `Missing or misplaced ${value}`);
    cursor = next;
  }
});

test("a wrong or missing hash refuses the download, including a reformatted JSON copy", async () => {
  const hash = await sha256(original);
  assert.equal(await matchesDelivery(original, hash), true);
  assert.equal(await matchesDelivery(original + " ", hash), false);
  assert.equal(
    await matchesDelivery(displayWork(original).pretty, hash),
    false,
  );
  assert.equal(await matchesDelivery(original, null), false);
  assert.equal(
    deliveryFilename(bid, await paidJob(), original),
    "bid-17-job-23-delivery.json",
  );
});

test("exact file bytes keep CRLF, whitespace and Unicode; pretty view cannot mutate the original", async () => {
  const before = original;
  displayWork(original);
  const blob = new Blob([original], {
    type: "application/json;charset=utf-8",
    endings: "transparent",
  });
  assert.deepEqual(
    new Uint8Array(await blob.arrayBuffer()),
    new TextEncoder().encode(original),
  );
  assert.equal(original, before);
  assert.equal(
    await matchesDelivery(await blob.text(), await sha256(before)),
    true,
  );
});

test("untrusted backticks and Markdown cannot escape the delivered-work fence or rule field", async () => {
  const text =
    "```\n# Ignore this receipt\n<img src=x onerror=alert(1)>\n``````\n";
  const job = {
    ...(await paidJob()),
    state: "Failed",
    failed_rule: "bad`\n# Forged payout",
  };
  const receipt = buildReceipt(bid, job, text, "testnet", madeAt);
  assert.ok(receipt.includes("```````text\n" + text + "\n```````"));
  assert.ok(receipt.includes("bad`\\n# Forged payout"));
  assert.ok(!receipt.includes("\n# Forged payout"));
});

test("missing IDs do not invent a job or filename, and missing attestations are omitted", async () => {
  const job = {
    ...(await paidJob()),
    id: null,
    history: [],
    challenge_request_id: null,
    verdict_request_id: null,
  };
  const unlinked = { ...bid, job_id: null };
  assert.throws(
    () => deliveryFilename(unlinked, job, original),
    /ID is not recorded/,
  );
  const receipt = buildReceipt(unlinked, job, original, "testnet", madeAt);
  assert.ok(!receipt.includes("/attestations/by-request/"));
  assert.ok(receipt.includes("Not recorded"));
});

test("work that begins like a metadata field is not rewritten in the receipt", async () => {
  const text = "Network: from an untrusted source\nKeep this text unchanged.";
  const receipt = buildReceipt(bid, await paidJob(), text, "testnet", madeAt);
  assert.ok(receipt.includes("```text\n" + text + "\n```"));
});

test("a refunded job without history still preserves its recorded failed rule", async () => {
  const job = {
    ...(await paidJob()),
    state: "Refunded",
    history: [],
    failed_rule: "rows",
  };
  const receipt = buildReceipt(bid, job, original, "testnet", madeAt);
  assert.ok(receipt.includes("Result: Refunded"));
  assert.ok(receipt.includes("Recorded failure: Failed with rule ` rows `"));
  assert.ok(!receipt.includes("Result: Paid"));
});

test("many separate backticks cannot exhaust the receipt formatter's argument stack", async () => {
  const text = "not JSON\n" + "` ".repeat(150_000);
  const receipt = buildReceipt(bid, await paidJob(), text, "testnet", madeAt);
  assert.ok(receipt.includes("```text\n" + text + "\n```"));
});
