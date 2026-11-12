#!/usr/bin/env node
// The swarm as one JSON document, read from chain with no credentials. Inference costs come from the
// operator's local ledger when one exists, and are labelled as local: they are not on chain.
//   npm run --silent feed
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BoardClient, type Bid } from "./board.ts";
import { ROOT } from "./config.ts";
import { BOARD } from "./custody.ts";
import { publicMessage } from "./errors.ts";
import { attestationUrl } from "./network.ts";
import { Ledger, usd } from "./inference.ts";
import type { Job } from "./types.ts";

function jobView(jobId: number, job: Job | null, escrow: string) {
  if (!job) return { job_id: jobId, state: "Cancelled" };
  return {
    job_id: jobId,
    state: job.state,
    worker: job.worker,
    amount: job.amount,
    fakes_caught: job.fakes_caught,
    fakes_total: job.fakes_total,
    failed_rule: job.failed_rule,
    /** Every finished attempt, in the order the escrow recorded it. */
    history: (job.history ?? []).map((attempt) => ({
      worker: attempt.worker,
      outcome: attempt.outcome,
      failed_rule: attempt.failed_rule,
      verdict_request_id: attempt.verdict_request_id,
    })),
    deliverable_hash: job.deliverable_hash,
    report_hash: job.report_hash,
    challenge_attestation: job.challenge_request_id
      ? attestationUrl(job.challenge_request_id, escrow)
      : null,
    verdict_attestation: job.verdict_request_id
      ? attestationUrl(job.verdict_request_id, escrow)
      : null,
  };
}

function localInference(): Record<string, string> | null {
  const path = `${ROOT}runs/inference-ledger.jsonl`;
  if (!existsSync(path)) return null;
  const ledger = new Ledger(path);
  const totals = new Map<string, number>();
  for (const row of ledger.rows())
    totals.set(row.spender, (totals.get(row.spender) ?? 0) + row.cost_nano_usd);
  return Object.fromEntries(
    [...totals].map(([spender, cost]) => [spender, usd(cost)]),
  );
}

export async function buildFeed(board: BoardClient, escrow: string) {
  const readJob = async (jobId: number) =>
    jobView(
      jobId,
      await board.view<Job | null>("get_job", { job_id: jobId }, escrow),
      escrow,
    );
  const bids: unknown[] = [];
  for (let from = 0; ; from += 50) {
    const page = await board.bids(from, 50);
    for (const [id, bid] of page) bids.push(await bidView(id, bid, readJob));
    if (page.length < 50) break;
  }
  const agents = [];
  for (let from = 0; ; from += 50) {
    const page = await board.agents(from, 50);
    agents.push(...page);
    if (page.length < 50) break;
  }
  return {
    network: escrow.endsWith(".near") ? "mainnet" : "testnet",
    board: BOARD,
    escrow,
    bids,
    agents,
    agents_note:
      "Hashes record what an operator committed to, not proof of what ran.",
    inference_usd_local_ledger: localInference(),
    inference_note:
      "Paid in USD credits by each agent's operator. This is the local ledger of this operator, not an on-chain record.",
  };
}

async function bidView(
  id: number,
  bid: Bid,
  readJob: (jobId: number) => Promise<unknown>,
) {
  const current = bid.job_id;
  return {
    id,
    state: bid.state,
    buyer: bid.buyer,
    description: bid.description,
    amount: bid.amount,
    check_hash: bid.check_hash,
    reference_hash: bid.reference_hash,
    verifier_hash: bid.verifier_hash,
    deliver_secs: bid.deliver_secs,
    max_attempts: bid.max_attempts,
    fees: bid.fees,
    review: bid.review,
    claim: bid.claim,
    claims_made: bid.claims_made,
    funded_attempts: bid.funded_attempts,
    /** The escrow job, with every attempt in its history. */
    job: current === null ? null : await readJob(current),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const escrow = process.env.ESCROW_CONTRACT ?? "escrow-v5.proven.testnet";
  buildFeed(
    new BoardClient(
      process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
    ),
    escrow,
  )
    .then((feed) => console.log(JSON.stringify(feed, null, 2)))
    .catch((error) => {
      console.error(publicMessage(error));
      process.exitCode = 1;
    });
}
