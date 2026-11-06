// One attempt on one bid, driven from what the chain says at each step, so an interrupted attempt
// resumes without repeating a signed call. The buyer's steps and the agent's steps use separate
// custody wallets. The model only ever produces candidate bytes for a job the chain says is funded:
// job id, payee and amount all come from the chain. Only the escrow's recorded verdict moves money.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { BoardClient, fundRefusal, type Bid, type Wallet } from "./board.ts";
import { loadConfig, ROOT, type Config } from "./config.ts";
import { BOARD } from "./custody.ts";
import { PublicError } from "./errors.ts";
import {
  DEFAULT_MODEL,
  fetchPrices,
  Ledger,
  ModelClient,
  usd,
} from "./inference.ts";
import { doWork, type AgentProfile } from "./llm-work.ts";
import { createRuntime } from "./near.ts";
import { reviewBid } from "./bid-review.ts";
import { createService } from "./service.ts";
import type { Job } from "./types.ts";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const NANO_USD_PER_USD = 1e9;
const YOCTO_PER_NEAR = 10 ** 24;
/** What an agent may spend before it has earned anything, and the most earnings can raise that to. */
const BASE_LIMIT_NANO_USD = 0.05 * NANO_USD_PER_USD;
const CEILING_NANO_USD = 0.3 * NANO_USD_PER_USD;
/** Nominal, for this ledger only. Testnet NEAR is not converted to anything, and NEAR AI bills USD. */
export const NOMINAL_NANO_USD_PER_NEAR = 1 * NANO_USD_PER_USD;
const REVIEW_LIMIT_NANO_USD = 0.1 * NANO_USD_PER_USD;
export const AGENT_TOOLS = JSON.stringify(["submit_deliverable"]);
const CLAIM_WINDOW_SECS = 1_800;
const POLL_MS = 15_000;
const POLLS = 40;

const pause = () =>
  new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

export function inferenceLimit(earnedYocto: bigint): number {
  const earned =
    (Number(earnedYocto) / YOCTO_PER_NEAR) * NOMINAL_NANO_USD_PER_NEAR;
  return Math.min(BASE_LIMIT_NANO_USD + earned, CEILING_NANO_USD);
}

/** The agent starts work only on a funded job naming it, for this bid's amount and active claim. */
export function workRefusal(
  bid: Bid,
  jobId: number,
  job: Job,
  wallet: string,
): string | null {
  if (job.state !== "Funded") return "the job is not funded";
  if (job.worker !== wallet) return "the job names a different worker";
  if (job.token !== null || job.amount !== bid.amount)
    return "the job pays something other than the bid";
  if (bid.claim?.agent !== wallet || bid.claim.job_id !== jobId)
    return "this job is not linked to this agent's claim";
  return null;
}

interface AgentFiles {
  wallet: Wallet;
  config: Config;
  prompt: string;
  knowledge: string;
  id: string;
}

function env(): Record<string, string | undefined> {
  return parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
}

function buyer(): { wallet: Wallet; config: Config } {
  const config = loadConfig("buyer");
  if (!config.custodyKey || !config.account)
    throw new PublicError("The buyer custody wallet is not configured.");
  return {
    config,
    wallet: {
      api: config.custodyApi,
      key: config.custodyKey,
      account: config.account,
      escrow: config.escrow,
    },
  };
}

export function agentFiles(letter: string): AgentFiles {
  const upper = letter.toUpperCase();
  const lower = letter.toLowerCase();
  const values = env();
  const account = values[`PROVEN_AGENT_${upper}_ACCOUNT_ID`];
  const key = values[`PROVEN_AGENT_${upper}_CUSTODY_KEY`];
  if (!account || !key)
    throw new PublicError(`Agent ${upper} has no wallet. Run the swarm setup.`);
  const base = loadConfig("buyer");
  const config: Config = { ...base, actor: "agent", account, custodyKey: key };
  return {
    config,
    wallet: { api: base.custodyApi, key, account, escrow: base.escrow },
    prompt: readFileSync(
      `${ROOT}agent/scripts/prompts/agent-${lower}.txt`,
      "utf8",
    ),
    knowledge: readFileSync(
      `${ROOT}agent/scripts/prompts/agent-${lower}-knowledge.txt`,
      "utf8",
    ),
    id: `agent-${lower}`,
  };
}

export async function postBid(jobDir: string) {
  const { wallet, config } = buyer();
  const description = readFileSync(`${ROOT}${jobDir}/task.txt`, "utf8");
  const check = readFileSync(`${ROOT}${jobDir}/check.json`, "utf8");
  const reference = readFileSync(`${ROOT}${jobDir}/reference.json`, "utf8");
  const { verifier } = JSON.parse(check) as { verifier: string };
  const result = await new BoardClient(config.rpc).postBid(wallet, {
    description,
    amount: (10n ** 22n).toString(),
    check_hash: sha256(check),
    reference_hash: sha256(reference),
    verifier_hash: verifier,
    claim_window_secs: CLAIM_WINDOW_SECS,
  });
  return { bid_id: result.result, transaction_hash: result.transaction_hash };
}

export async function runReview(bidId: number, keyName: string) {
  const values = env();
  const { config } = buyer();
  const board = new BoardClient(config.rpc);
  const bid = await board.bid(bidId);
  if (!bid || bid.state !== "Unreviewed")
    throw new PublicError("That bid is not waiting for a review.");
  const key = values[keyName];
  if (!key) throw new PublicError(`${keyName} is not set.`);
  const client = new ModelClient(
    new Ledger(`${ROOT}runs/inference-ledger.jsonl`),
    await fetchPrices(),
  );
  const { answer, call } = await reviewBid(
    client,
    key,
    bid.description,
    `bid-${bidId}`,
    REVIEW_LIMIT_NANO_USD,
  );
  const summary = {
    bid_id: bidId,
    answer,
    model: call.model,
    chat_id: call.chatId,
    usd: usd(call.costNanoUsd),
    response_hash: call.responseHash,
  };
  if (!answer) return { ...summary, recorded: false, state: "Unreviewed" };
  const signer = new Account(
    values.NEAR_ACCOUNT_ID ?? "",
    new JsonRpcProvider({ url: config.rpc }),
    new KeyPairSigner(
      KeyPair.fromString(
        values.PROVEN_REVIEWER_PRIVATE_KEY as `ed25519:${string}`,
      ),
    ),
  );
  const outcome = await signer.callFunctionRaw({
    contractId: BOARD,
    methodName: "record_review",
    args: {
      bid_id: bidId,
      allow: answer.allow,
      review_hash: call.responseHash,
      model: call.model,
      chat_id: call.chatId,
    },
    gas: 30_000_000_000_000n,
  });
  const after = await board.bid(bidId);
  return {
    ...summary,
    recorded: true,
    transaction_hash: outcome.transaction.hash,
    state: after?.state,
  };
}

async function earned(
  board: BoardClient,
  config: Config,
  wallet: string,
): Promise<bigint> {
  let total = 0n;
  for (let from = 0; ; from += 50) {
    const page = await board.view<Array<[number, Job]>>(
      "get_jobs",
      { from_id: from, limit: 50 },
      config.escrow,
    );
    for (const [, job] of page)
      if (job.worker === wallet && job.state === "Released")
        total += BigInt(job.amount);
    const { next_job_id } = await board.view<{ next_job_id: number }>(
      "get_config",
      {},
      config.escrow,
    );
    if (from + 50 >= next_job_id) return total;
  }
}

/** Runs one attempt on a bid for one agent, resuming from whatever the chain already records. */
export async function attempt(
  bidId: number,
  letter: string,
  jobDir: string,
  keyName: string,
  log: (step: string, detail: unknown) => void,
) {
  const agent = agentFiles(letter);
  const { wallet: buyerWallet, config: buyerConfig } = buyer();
  const board = new BoardClient(buyerConfig.rpc);
  const buyerTool = createService(createRuntime(buyerConfig));
  const agentTool = createService(createRuntime(agent.config));
  const check = readFileSync(`${ROOT}${jobDir}/check.json`, "utf8");
  const reference = readFileSync(`${ROOT}${jobDir}/reference.json`, "utf8");
  const account = agent.wallet.account;

  const readBid = async (): Promise<Bid> => {
    const bid = await board.bid(bidId);
    if (!bid) throw new PublicError("That bid does not exist.");
    return bid;
  };

  if (!(await board.agent(account))) {
    const registered = await board.register(agent.wallet, {
      prompt_hash: sha256(agent.prompt),
      knowledge_hash: sha256(agent.knowledge),
      tools_hash: sha256(AGENT_TOOLS),
      model: DEFAULT_MODEL,
    });
    log("register_agent", registered.transaction_hash);
  }

  let bid = await readBid();
  if (bid.claim && bid.claim.agent !== account) {
    await board.sync(agent.wallet, bidId);
    bid = await readBid();
  }
  if (bid.state === "Open") {
    log("claim", (await board.claim(agent.wallet, bidId)).transaction_hash);
    bid = await readBid();
  }
  if (bid.state !== "Claimed" || bid.claim?.agent !== account)
    throw new PublicError(
      `This agent does not hold a claim on this bid. Its state is ${bid.state}.`,
    );

  // Link before funding, so a claim cannot lapse under a job about to run.
  let jobId = bid.claim.job_id;
  if (jobId === null) {
    const posted = (await buyerTool("post_job", {
      worker: account,
      check,
      reference,
      amount_near: "0.01",
    })) as { result: number; transaction_hash: string };
    jobId = posted.result;
    if (!Number.isSafeInteger(jobId))
      throw new PublicError(
        `post_job returned no job id: ${posted.transaction_hash}`,
      );
    log("post_job", {
      job_id: jobId,
      transaction_hash: posted.transaction_hash,
    });
    log(
      "link_job",
      (await board.link(buyerWallet, bidId, jobId)).transaction_hash,
    );
  }
  const readJob = async () => {
    const job = await board.view<Job | null>(
      "get_job",
      { job_id: jobId },
      buyerConfig.escrow,
    );
    if (!job)
      throw new PublicError("The linked job no longer exists. Sync the bid.");
    return job;
  };

  const privateDir = `${ROOT}runs/private/bid-${bidId}-${letter.toLowerCase()}`;
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const deliverablePath = `${privateDir}/deliverable.json`;

  for (let step = 0; step < POLLS; step++) {
    const job = await readJob();
    switch (job.state) {
      case "Draft": {
        const run = (await buyerTool("challenge_check", {
          job_id: jobId,
          check,
          reference,
        })) as { transaction_hash?: string; job?: Job };
        log("challenge", {
          transaction_hash: run.transaction_hash,
          state: run.job?.state,
          fakes: `${run.job?.fakes_caught} of ${run.job?.fakes_total}`,
          request: run.job?.challenge_request_id,
        });
        break;
      }
      case "Challenged": {
        const refusal = fundRefusal(await readBid(), jobId, await board.now());
        if (refusal)
          throw new PublicError(`The buyer did not fund: ${refusal}.`);
        const funded = (await buyerTool("fund_job", { job_id: jobId })) as {
          transaction_hash?: string;
          failed?: boolean;
        };
        if (funded.failed)
          throw new PublicError(
            `Funding failed on chain: ${funded.transaction_hash}`,
          );
        log("fund_job", funded.transaction_hash);
        break;
      }
      case "Funded": {
        const refusal = workRefusal(await readBid(), jobId, job, account);
        if (refusal)
          throw new PublicError(`The agent did not start: ${refusal}.`);
        if (!existsSync(deliverablePath)) {
          const key = env()[keyName];
          if (!key) throw new PublicError(`${keyName} is not set.`);
          const client = new ModelClient(
            new Ledger(`${ROOT}runs/inference-ledger.jsonl`),
            await fetchPrices(),
          );
          const profile: AgentProfile = {
            id: agent.id,
            prompt: agent.prompt,
            knowledge: agent.knowledge,
            key,
            limitNanoUsd: inferenceLimit(
              await earned(board, buyerConfig, account),
            ),
          };
          const work = await doWork(
            client,
            profile,
            (await readBid()).description,
            "agent-work",
            `bid-${bidId}`,
          );
          log("inference", {
            model: work.call.model,
            chat_id: work.call.chatId,
            input_tokens: work.call.inputTokens,
            output_tokens: work.call.outputTokens,
            usd: usd(work.call.costNanoUsd),
            limit_usd: usd(profile.limitNanoUsd ?? 0),
            request_hash: work.call.requestHash,
            response_hash: work.call.responseHash,
          });
          if (work.deliverable === null) {
            log("no_delivery", work.refusal);
            return {
              bid_id: bidId,
              job_id: jobId,
              outcome: `no delivery: ${work.refusal}; the money returns to the buyer when the job expires`,
            };
          }
          writeFileSync(deliverablePath, work.deliverable, { mode: 0o600 });
        }
        const delivered = (await agentTool("deliver", {
          job_id: jobId,
          deliverable: readFileSync(deliverablePath, "utf8"),
        })) as { transaction_hash?: string; private_handoff?: unknown };
        log("deliver", {
          transaction_hash: delivered.transaction_hash,
          private_handoff: Boolean(delivered.private_handoff),
        });
        if (!delivered.private_handoff)
          throw new PublicError(
            "The private handoff failed. Is the relay handoff running?",
          );
        break;
      }
      case "Delivered": {
        const run = (await agentTool("request_verification", {
          job_id: jobId,
        })) as { transaction_hash?: string; job?: Job };
        log("request_verification", {
          transaction_hash: run.transaction_hash,
          state: run.job?.state,
          request: run.job?.verdict_request_id,
          failed_rule: run.job?.failed_rule,
        });
        break;
      }
      case "Passed":
      case "Failed": {
        const settled = (await agentTool("release_or_refund", {
          job_id: jobId,
        })) as { transaction_hash?: string };
        log(
          job.state === "Passed" ? "release" : "refund",
          settled.transaction_hash,
        );
        break;
      }
      case "Challenging":
      case "Verifying":
      case "Releasing":
      case "Refunding":
      case "Expiring":
        // A run or payout is in flight. Starting another could pay twice for compute, so only wait.
        await pause();
        break;
      default: {
        await board.sync(agent.wallet, bidId);
        const after = await readBid();
        const final = await readJob();
        return {
          bid_id: bidId,
          job_id: jobId,
          job_state: final.state,
          bid_state: after.state,
          failed_rule: final.failed_rule,
          fakes: `${final.fakes_caught} of ${final.fakes_total}`,
          challenge_attestation: `https://testnet-api.outlayer.ai/attestations/by-request/${final.challenge_request_id}`,
          verdict_attestation: final.verdict_request_id
            ? `https://testnet-api.outlayer.ai/attestations/by-request/${final.verdict_request_id}`
            : null,
          deliverable_hash: final.deliverable_hash,
          report_hash: final.report_hash,
        };
      }
    }
  }
  throw new PublicError(
    "The attempt did not settle in time. Read the job and run this again to resume.",
  );
}
