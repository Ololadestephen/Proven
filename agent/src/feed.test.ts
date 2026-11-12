import assert from "node:assert/strict";
import test from "node:test";
import type { Bid, BoardClient } from "./board.ts";
import { buildFeed } from "./feed.ts";
import type { Job } from "./types.ts";

const HASH = "a".repeat(64);
const ESCROW = "escrow-v5.proven.testnet";

function bid(jobId: number | null): Bid {
  return {
    buyer: "buyer.testnet",
    description: "Clean the sample table",
    amount: "1000",
    check_hash: HASH,
    reference_hash: HASH,
    verifier_hash: HASH,
    format: "rows",
    format_hash: HASH,
    expires_at: "0",
    deliver_secs: 600,
    max_attempts: 2,
    job_id: jobId,
    state: "Open",
    review: null,
    claim: null,
    claims_made: 2,
    funded_attempts: 2,
    allowed_workers: null,
  } as unknown as Bid;
}

function job(): Job {
  return {
    buyer: "buyer.testnet",
    worker: "second.testnet",
    history: [
      {
        worker: "first.testnet",
        outcome: "Failed",
        failed_rule: "rows.total",
        verdict_request_id: "11",
      },
      {
        worker: "second.testnet",
        outcome: "Passed",
        failed_rule: null,
        verdict_request_id: "12",
      },
    ],
    amount: "1000",
    token: null,
    state: "Released",
    spec_hash: HASH,
    fakes_hash: HASH,
    verifier_hash: HASH,
    secrets_owner: "owner.testnet",
    deliverable_hash: HASH,
    deadline: "0",
    delivered_at: "0",
    verdict_window_secs: 1800,
    attempt: 2,
    run_started_at: null,
    fakes_total: 3,
    fakes_caught: 3,
    challenge_request_id: null,
    challenge_report_hash: null,
    verdict_request_id: "12",
    report_hash: HASH,
    failed_rule: null,
  };
}

/** A board with three bids: one with a two-attempt job, one whose job is gone, one still being created. */
function fakeBoard(): { board: BoardClient; views: unknown[] } {
  const views: unknown[] = [];
  const jobs = new Map<number, Job | null>([
    [7, job()],
    [8, null],
  ]);
  const board = {
    async view(method: string, args: { job_id: number }, contract: string) {
      views.push([method, args.job_id, contract]);
      return jobs.get(args.job_id) ?? null;
    },
    async bids(from: number) {
      return from === 0
        ? [
            [1, bid(7)],
            [2, bid(8)],
            [3, bid(null)],
          ]
        : [];
    },
    async agents() {
      return [];
    },
  };
  return { board: board as unknown as BoardClient, views };
}

test("the feed keeps every attempt of a job, in the escrow's order", async () => {
  const { board, views } = fakeBoard();
  const feed = await buildFeed(board, ESCROW);
  assert.equal(feed.network, "testnet");
  const [first] = feed.bids as Array<{ job: Record<string, unknown> }>;
  assert.deepEqual(first.job.history, [
    {
      worker: "first.testnet",
      outcome: "Failed",
      failed_rule: "rows.total",
      verdict_request_id: "11",
    },
    {
      worker: "second.testnet",
      outcome: "Passed",
      failed_rule: null,
      verdict_request_id: "12",
    },
  ]);
  assert.equal(first.job.state, "Released");
  assert.match(String(first.job.verdict_attestation), /12/);
  assert.equal(first.job.challenge_attestation, null);
  assert.deepEqual(views, [
    ["get_job", 7, ESCROW],
    ["get_job", 8, ESCROW],
  ]);
});

test("a missing job reads as Cancelled and a bid without a job has none", async () => {
  const { board } = fakeBoard();
  const feed = await buildFeed(board, ESCROW);
  const [, gone, creating] = feed.bids as Array<{ job: unknown }>;
  assert.deepEqual(gone.job, { job_id: 8, state: "Cancelled" });
  assert.equal(creating.job, null);
});

test("a job recorded before history existed shows an empty history", async () => {
  const { board } = fakeBoard();
  const view = board.view.bind(board);
  board.view = (async (...args: Parameters<typeof view>) => {
    const value = (await view(...args)) as Job | null;
    if (value) delete value.history;
    return value;
  }) as typeof board.view;
  const feed = await buildFeed(board, "escrow.proven.near");
  const [first] = feed.bids as Array<{ job: Record<string, unknown> }>;
  assert.deepEqual(first.job.history, []);
  assert.equal(feed.network, "mainnet");
});
