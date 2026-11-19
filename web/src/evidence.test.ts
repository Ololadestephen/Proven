import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  taskHash,
  type AttestationRecord,
} from "../../relay/src/attestation.ts";
import { loadJob, audit } from "./evidence.ts";
import { ESCROW, type Job } from "./model.ts";
import { fixture } from "../test-fixtures/job.ts";
import { readJson } from "./read.ts";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
// Synthetic unverified quote for exercising binding checks, never presented as Intel-signed evidence.
function record(
  job: Job,
  kind: "challenge" | "verify",
  escrow = ESCROW,
): AttestationRecord {
  const challenge = kind === "challenge",
    other = (challenge ? job.fakes_hash : job.deliverable_hash)!,
    format = job.format_hash ? { format_hash: job.format_hash } : {};
  const input = JSON.stringify(
    challenge
      ? {
          mode: "challenge",
          escrow,
          job: 11,
          check_hash: job.spec_hash,
          reference_hash: other,
          ...format,
        }
      : {
          mode: "verify",
          escrow,
          job: 11,
          ...format,
          check_hash: job.spec_hash,
          deliverable_hash: other,
        },
  );
  const r: AttestationRecord = {
    task_id: 123,
    request_id: Number(
      challenge ? job.challenge_request_id : job.verdict_request_id,
    ),
    task_type: "execute",
    tdx_quote: "",
    worker_measurement: "f".repeat(96),
    caller_account_id: "anyone.testnet",
    transaction_hash: "public-transaction",
    block_height: 123,
    build_target: "wasm32-wasip1",
    wasm_hash: job.verifier_hash,
    input_hash: digest(input),
    output_hash: (challenge ? job.challenge_report_hash : job.report_hash)!,
    secrets_ref: `relay.testnet/${challenge ? "c" : "v"}11-${other.slice(0, 12)}`,
    timestamp: 123,
    attached_usd: "0.001",
  };
  const quote = Buffer.alloc(700);
  quote.writeUInt16LE(4);
  Buffer.from(r.worker_measurement, "hex").copy(quote, 520);
  Buffer.from(taskHash(r), "hex").copy(quote, 568);
  r.tdx_quote = quote.toString("base64");
  return r;
}

test("audit selects stored request id and compares all hash bindings without claiming signatures", async () => {
  const job = {
    ...fixture("Released"),
    verdict_request_id: "8815",
    report_hash: "a".repeat(64),
  };
  for (const kind of ["challenge", "verify"] as const) {
    const r = record(job, kind);
    let url = "";
    const result = await audit(job, 11, kind, async (target) => {
      url = String(target);
      return Response.json(r);
    });
    assert.equal(result.status, "matched");
    assert.ok(
      url.endsWith(`/by-request/${kind === "challenge" ? "8814" : "8815"}`),
    );
    assert.match(result.not_checked[0]!, /Intel signature/);
    assert.equal(result.checks.length, 7);
    for (const change of [
      { request_id: 99 },
      { wasm_hash: "0".repeat(64) },
      { input_hash: "0".repeat(64) },
      { output_hash: "0".repeat(64) },
      { secrets_ref: "wrong/profile" },
      { tdx_quote: "invalid" },
    ]) {
      const bad = await audit(job, 11, kind, async () =>
        Response.json({ ...r, ...change }),
      );
      assert.equal(bad.status, "mismatch");
      assert.deepEqual(bad.checks, []);
    }
  }
});

test("missing and unavailable attestations are not matches and do not replace the job's verdict", async () => {
  assert.equal(
    (
      await audit(fixture(), 11, "verify", async () => {
        throw new Error("must not fetch");
      })
    ).status,
    "not_recorded",
  );
  const bad = await audit(fixture(), 11, "challenge", async () => {
    throw new Error("PRIVATE upstream details");
  });
  assert.equal(bad.status, "unavailable");
  assert.ok(!JSON.stringify(bad).includes("PRIVATE"));
});

test("final block and get_job are fixed to the same hash; only view RPC is issued", async () => {
  const job = fixture("Released"),
    calls: unknown[] = [],
    blockHash = "A".repeat(44);
  const result = await loadJob("11", async (url, options) => {
    if (String(url).includes("outlayer")) throw new Error("Unavailable API");
    const call = JSON.parse(String(options?.body));
    calls.push(call);
    assert.equal(options?.redirect, "error");
    if (call.method === "block")
      return Response.json({
        result: {
          header: { hash: blockHash, height: 123, timestamp_nanosec: "1000" },
        },
      });
    assert.equal(call.method, "query");
    assert.equal(call.params.method_name, "get_job");
    assert.equal(call.params.account_id, ESCROW);
    assert.equal(call.params.block_id, blockHash);
    assert.deepEqual(
      JSON.parse(Buffer.from(call.params.args_base64, "base64").toString()),
      { job_id: 11 },
    );
    return Response.json({
      result: {
        block_hash: blockHash,
        block_height: 123,
        result: [...Buffer.from(JSON.stringify(job))],
      },
    });
  });
  assert.equal(calls.length, 2);
  assert.equal(result.block_height, 123);
  assert.equal(result.job.state, "Released");
  assert.equal(result.attestations.challenge.status, "unavailable");
});

test("a market job is read and audited against the escrow it lives on", async () => {
  const job = fixture("Released"),
    blockHash = "A".repeat(44),
    escrow = "escrow-v5.proven.testnet";
  const result = await loadJob(
    "21",
    async (url, options) => {
      if (String(url).includes("outlayer")) throw new Error("Unavailable API");
      const call = JSON.parse(String(options?.body));
      if (call.method === "block")
        return Response.json({
          result: {
            header: { hash: blockHash, height: 123, timestamp_nanosec: "1000" },
          },
        });
      assert.equal(call.params.account_id, escrow);
      return Response.json({
        result: {
          block_hash: blockHash,
          block_height: 123,
          result: [...Buffer.from(JSON.stringify(job))],
        },
      });
    },
    escrow,
  );
  assert.equal(result.escrow, escrow);
  assert.notEqual(escrow, ESCROW);
  const attested = async () => Response.json(record(job, "challenge", escrow));
  assert.equal(
    (await audit(job, 11, "challenge", attested, escrow)).status,
    "matched",
  );
  assert.equal(
    (await audit(job, 11, "challenge", attested)).status,
    "mismatch",
  );
  const formatted = {
    ...job,
    format_hash: "f".repeat(64),
    verdict_request_id: "8815",
    report_hash: "a".repeat(64),
  };
  for (const kind of ["challenge", "verify"] as const) {
    const withFormat = async () =>
      Response.json(record(formatted, kind, escrow));
    assert.equal(
      (await audit(formatted, 11, kind, withFormat, escrow)).status,
      "matched",
    );
  }
});

test("read failures and malformed, oversized or invalid UTF-8 responses remain redacted errors", async () => {
  for (const body of [
    "invalid json",
    "x".repeat(1024 * 1024 + 1),
    new Uint8Array([0xff]),
  ])
    await assert.rejects(
      readJson("https://public.example", async () => new Response(body)),
      /unavailable or malformed/,
    );
  await assert.rejects(
    readJson(
      "https://public.example",
      async () => new Response("secret", { status: 500 }),
    ),
    /unavailable/,
  );
  await assert.rejects(
    loadJob("bad", async () => {
      throw new Error("must not fetch");
    }),
    /job id/,
  );
  await assert.rejects(
    loadJob("11", async () => Response.json({ error: { message: "PRIVATE" } })),
    /could not return/,
  );
});

test("a query at another block cannot be shown as the selected final snapshot", async () => {
  await assert.rejects(
    loadJob("11", async (_url, options) => {
      const call = JSON.parse(String(options?.body));
      if (call.method === "block")
        return Response.json({
          result: {
            header: {
              hash: "A".repeat(44),
              height: 123,
              timestamp_nanosec: "1000",
            },
          },
        });
      return Response.json({
        result: {
          block_hash: "B".repeat(44),
          block_height: 124,
          result: [...Buffer.from(JSON.stringify(fixture()))],
        },
      });
    }),
    /does not match/,
  );
});
