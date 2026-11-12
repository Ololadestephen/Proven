import { savePublicReview } from "../../shared/public-review.ts";
import { chainProvider } from "./rpc.ts";
import { randomBytes } from "node:crypto";
// One attempt on one bid, driven from what the chain says at each step, so an interrupted attempt
// resumes without repeating a signed call. The buyer's steps and the agent's steps use separate
// custody wallets. The model only ever produces candidate bytes for a job the chain says is funded:
// job id, payee and amount all come from the chain. Only the escrow's recorded verdict moves money.
import { workRefusal } from "./swarm-rules.ts";
export { workRefusal };
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { BoardClient, postingDeposit, type Bid, type Wallet } from "./board.ts";
import { handoff, handoffOverWeb } from "./handoff.ts";
import { keysFrom, KeyPool } from "./key-pool.ts";
import { attestationUrl } from "./network.ts";
import { loadConfig, ROOT, type Config } from "./config.ts";
import { BOARD } from "./custody.ts";
import { PublicError } from "./errors.ts";
import { jsonObject } from "./json.ts";
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
/** The whole project's inference, across every key. */
const PROJECT_LIMIT_NANO_USD = 1 * NANO_USD_PER_USD;
/** More than this on one job is abnormal: about ten full-size calls. */
const JOB_LIMIT_NANO_USD = 0.05 * NANO_USD_PER_USD;
const REVIEW_LIMIT_NANO_USD = 0.1 * NANO_USD_PER_USD;
export const AGENT_TOOLS = JSON.stringify(["submit_deliverable"]);
const CLAIM_WINDOW_SECS = 1_800;
const POLL_MS = 15_000;
const POLLS = 40;

const pause = () =>
  new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));

/** One agent's keys in order. Budgets count every key, whichever one ran. */
async function pooledClient(spender: string, ...names: string[]) {
  const ledger = new Ledger(`${ROOT}runs/inference-ledger.jsonl`);
  const keys = keysFrom(env(), [...new Set(names)]);
  if (keys.length === 0)
    throw new PublicError(`${spender} has no NEAR AI key set.`);
  return new KeyPool(
    new ModelClient(ledger, await fetchPrices()),
    ledger,
    keys,
    {
      agentNanoUsd: CEILING_NANO_USD,
      projectNanoUsd: PROJECT_LIMIT_NANO_USD,
      jobNanoUsd: JOB_LIMIT_NANO_USD,
    },
    `${ROOT}runs/key-events.jsonl`,
  );
}

export function inferenceLimit(earnedYocto: bigint): number {
  const earned =
    (Number(earnedYocto) / YOCTO_PER_NEAR) * NOMINAL_NANO_USD_PER_NEAR;
  return Math.min(BASE_LIMIT_NANO_USD + earned, CEILING_NANO_USD);
}

interface AgentFiles {
  wallet: Wallet;
  config: Config;
  prompt: string;
  knowledge: string;
  id: string;
}

function env(): Record<string, string | undefined> {
  // A service's own environment wins, so a mainnet service never picks up the file's testnet values.
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { ...file, ...process.env };
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

/** Sixteen random bytes as spaces and tabs: valid after any JSON text, and short. */
function uniqueSpaces(): string {
  return Array.from(randomBytes(16), (byte) =>
    byte.toString(2).padStart(8, "0").replace(/0/g, " ").replace(/1/g, "\t"),
  ).join("");
}

/** Reject malformed or incomplete acceptance checks before reading credentials or calling the board. */
export function parseBidCheck(check: string): {
  verifier: string;
  format: string;
} {
  const message =
    "The bid acceptance check is invalid. It must name a verifier hash and a public format.";
  const value = jsonObject(check, message);
  if (
    typeof value.verifier !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.verifier) ||
    typeof value.format !== "string" ||
    !value.format.trim()
  )
    throw new PublicError(message);
  jsonObject(
    value.format,
    "The bid's public format is not a valid JSON object.",
  );
  return { verifier: value.verifier, format: value.format };
}

export async function postBid(
  jobDir: string,
  checkFile = "check.json",
  referenceFile = "reference.json",
) {
  const description = readFileSync(`${ROOT}${jobDir}/task.txt`, "utf8");
  // The exact text can be on one bid only, so each posting of an example differs by a trailing space.
  const check = `${readFileSync(`${ROOT}${jobDir}/${checkFile}`, "utf8")}${uniqueSpaces()}`;
  const reference = readFileSync(`${ROOT}${jobDir}/${referenceFile}`, "utf8");
  const { verifier, format } = parseBidCheck(check);
  const { wallet, config } = buyer();
  const board = new BoardClient(config.rpc);
  const { run_deposit } = await board.view<{ run_deposit: string }>(
    "get_config",
    {},
    config.escrow,
  );
  const amount = 10n ** 22n;
  const call = {
    description,
    amount: amount.toString(),
    check_hash: sha256(check),
    reference_hash: sha256(reference),
    verifier_hash: verifier,
    format,
    expires_at: ((await board.now()) + 72n * 3_600_000_000_000n).toString(),
    reveal_agreed: true,
    deliver_secs: 4 * 3_600,
    max_attempts: 3,
    // A test can keep a bid to named workers, so hosted agents do not take it.
    allowed_workers: process.env.PROVEN_BID_WORKERS?.split(",") ?? null,
  };
  const result = await board.postBid(
    wallet,
    call,
    postingDeposit(amount, call.max_attempts, BigInt(run_deposit)),
  );
  // The bid and its job, then the check to the relay, which tests it. No signature is needed.
  const found = (await board.bids(0, 50)).find(
    ([, bid]) => bid.check_hash === call.check_hash,
  );
  if (found && found[1].job_id !== null) {
    const challenge = {
      action: "challenge",
      job_id: found[1].job_id,
      check,
      reference,
    };
    await (config.relayUrl
      ? handoffOverWeb(config.relayUrl, challenge)
      : handoff(config.socket, challenge));
  }
  // The exact text a job on this bid must use.
  mkdirSync(`${ROOT}runs/private`, { recursive: true, mode: 0o700 });
  writeFileSync(
    `${ROOT}runs/private/bid-${String(found?.[0])}-check.json`,
    check,
    {
      mode: 0o600,
    },
  );
  return {
    bid_id: found?.[0] ?? null,
    job_id: found?.[1].job_id ?? null,
    transaction_hash: result.transaction_hash,
    check,
  };
}

export async function runReview(bidId: number, keyName: string) {
  const values = env();
  // Only the network is read here: a hosted server holds the review keys, never the buyer's wallet.
  const config = loadConfig();
  const board = new BoardClient(config.rpc);
  const bid = await board.bid(bidId);
  if (!bid || bid.state !== "Unreviewed")
    throw new PublicError("That bid is not waiting for a review.");
  const key = values[keyName];
  if (!key) throw new PublicError(`${keyName} is not set.`);
  const client = await pooledClient("review", keyName);
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
  if (!call.publicResponseBody)
    throw new PublicError(
      "The public review response was not retained; no decision was recorded.",
    );
  savePublicReview(
    `${ROOT}runs/private/bid-reviews`,
    BOARD,
    bidId,
    call.publicResponseBody,
    {
      allow: answer.allow,
      review_hash: call.responseHash,
      model: call.model,
      chat_id: call.chatId,
    },
  );
  const signer = new Account(
    values.NEAR_ACCOUNT_ID ?? "",
    chainProvider(config.rpc),
    new KeyPairSigner(
      KeyPair.fromString(
        (values.PROVEN_REVIEWER_V4_PRIVATE_KEY ??
          values.PROVEN_REVIEWER_V2_PRIVATE_KEY) as `ed25519:${string}`,
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
  // The decision is already on chain; a failed read-back must not report the review as failed.
  const after = await board.bid(bidId).catch(() => null);
  return {
    ...summary,
    recorded:
      (outcome.status as { SuccessValue?: string }).SuccessValue !== undefined,
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
  /** A fixed wrong delivery instead of a model's work. Always logged and labelled as scripted. */
  scriptedDeliverable?: string,
) {
  const agent = agentFiles(letter);
  const { wallet: buyerWallet, config: buyerConfig } = buyer();
  const board = new BoardClient(buyerConfig.rpc);
  const buyerTool = createService(createRuntime(buyerConfig));
  const agentTool = createService(createRuntime(agent.config));
  const saved = `${ROOT}runs/private/bid-${bidId}-check.json`;
  const check = readFileSync(
    existsSync(saved) ? saved : `${ROOT}${jobDir}/check.json`,
    "utf8",
  );
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
      owner: null,
    });
    log("register_agent", registered.transaction_hash);
  }

  let bid = await readBid();
  if (bid.state === "Open") {
    // The money is already held: the claim gives this agent the job straight away.
    log("claim", (await board.claim(agent.wallet, bidId)).transaction_hash);
    bid = await readBid();
  }
  if (
    bid.state !== "Claimed" ||
    bid.claim?.agent !== account ||
    bid.job_id === null
  )
    throw new PublicError(
      `This agent does not hold a claim on this bid. Its state is ${bid.state}.`,
    );
  const jobId = bid.job_id;
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

  const privateDir = `${ROOT}runs/private/job-${jobId}-${letter.toLowerCase()}`;
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const deliverablePath = `${privateDir}/deliverable.json`;

  for (let step = 0; step < POLLS; step++) {
    const job = await readJob();
    switch (job.state) {
      case "Funded": {
        const refusal = workRefusal(
          await readBid(),
          jobId,
          job,
          account,
          await board.now(),
        );
        if (refusal)
          throw new PublicError(`The agent did not start: ${refusal}.`);
        if (scriptedDeliverable !== undefined) {
          writeFileSync(deliverablePath, scriptedDeliverable, { mode: 0o600 });
          log("scripted_wrong_delivery", {
            note: "Scripted by the operator, not model work",
            hash: sha256(scriptedDeliverable),
          });
        }
        if (!existsSync(deliverablePath)) {
          const key = env()[keyName];
          if (!key) throw new PublicError(`${keyName} is not set.`);
          const client = await pooledClient(
            agent.id,
            `NEARAI_KEY_AGENT_${letter.toUpperCase()}`,
            keyName,
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
      case "Verifying":
      case "Releasing":
      case "Refunding":
      case "Expiring":
        // A run or payout is in flight. Starting another could pay twice for compute, so only wait.
        await pause();
        break;
      case "Open":
        // The escrow ended this agent's attempt and reopened the job for the next worker.
        await board.sync(agent.wallet, bidId);
        return {
          bid_id: bidId,
          job_id: jobId,
          outcome: "attempt ended",
          history: job.history,
        };
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
          challenge_attestation: attestationUrl(
            final.challenge_request_id ?? "",
            buyerConfig.escrow,
          ),
          verdict_attestation: final.verdict_request_id
            ? attestationUrl(final.verdict_request_id ?? "", buyerConfig.escrow)
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
