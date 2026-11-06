// Takes jobs for hosted agents, in the published order, within the attempt limits. One pass does a little
// for each agent and reads everything again from the chain, so a crash loses nothing. Only the verifier's
// recorded verdict pays anyone: nothing in here decides an outcome.
import { createHash } from "node:crypto";
import { BoardClient, buyerRecord, type Bid, type Wallet } from "../board.ts";
import type { Config } from "../config.ts";
import { PublicError } from "../errors.ts";
import { DEFAULT_MODEL, type Ledger, type ModelClient } from "../inference.ts";
import { createRuntime } from "../near.ts";
import { createService } from "../service.ts";
import { workRefusal } from "../swarm-rules.ts";
import type { Job } from "../types.ts";
import { MIN_TO_WORK, budgetNanoUsd, nanoUsdToNear } from "./limits.ts";
import type { SandboxCall } from "./sandbox.ts";
import type { HostedAgent, HostedStore } from "./store.ts";
import { doHostedWork } from "./work.ts";

export interface RunnerDeps {
  config: Config;
  store: HostedStore;
  ledger: Ledger;
  client: Pick<ModelClient, "call">;
  key: string;
  balance: (account: string) => Promise<bigint>;
  /** Moves spent NEAR to the treasury. Returns the transaction hash. */
  settle: (agent: HostedAgent, yocto: bigint) => Promise<string>;
  treasury: string;
  sandbox?: SandboxCall;
  log: (line: string, detail?: unknown) => void;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export const spenderOf = (wallet: string) => `hosted:${wallet}`;

function walletOf(agent: HostedAgent, config: Config): Wallet {
  return {
    api: config.custodyApi,
    key: agent.custody_key,
    account: agent.wallet,
    escrow: config.escrow,
    hosted: { owner: agent.owner, treasury: "" },
  };
}

export function agentConfig(
  agent: HostedAgent,
  config: Config,
  treasury: string,
): Config {
  return {
    ...config,
    actor: "agent",
    custodyKey: agent.custody_key,
    account: agent.wallet,
    allowedWorkers: [],
    hosted: { owner: agent.owner, treasury },
  };
}

function unsettled(deps: RunnerDeps, agent: HostedAgent): number {
  return Math.max(
    0,
    deps.ledger.spentNanoUsd(spenderOf(agent.wallet)) - agent.settled_nano_usd,
  );
}

/** Takes what an agent has spent out of its wallet, so its balance is always what it really has. */
export async function settleSpending(deps: RunnerDeps, agent: HostedAgent) {
  const owed = unsettled(deps, agent);
  if (owed <= 0) return;
  const hash = await deps.settle(agent, nanoUsdToNear(owed));
  const fresh = deps.store.get(agent.wallet) ?? agent;
  fresh.settled_nano_usd += owed;
  deps.store.save(fresh);
  deps.log("settled", { agent: agent.wallet, nano_usd: owed, hash });
}

/** Everything that would stop this agent taking this bid. */
export function claimRefusal(
  bid: Bid,
  agent: HostedAgent,
  now: bigint,
  balance: bigint,
): string | null {
  if (agent.paused) return "paused";
  if (bid.state !== "Open") return "not open";
  if (now >= BigInt(bid.expires_at)) return "expired";
  if (bid.funded_attempts >= 3) return "no attempts left";
  if (bid.buyer === agent.wallet || bid.buyer === agent.owner) return "own bid";
  if (bid.allowed_workers && !bid.allowed_workers.includes(agent.wallet))
    return "not on this bid's list";
  if (balance < MIN_TO_WORK) return "not enough NEAR";
  return null;
}

async function work(
  deps: RunnerDeps,
  agent: HostedAgent,
  bid: Bid,
  bidId: number,
  jobId: number,
  job: Job,
) {
  const board = new BoardClient(deps.config.rpc);
  const refusal = workRefusal(bid, jobId, job, agent.wallet, await board.now());
  if (refusal) return deps.log("not_starting", { job: jobId, refusal });
  // One try per job, so a failed try never turns into repeated spending. The exception is a call that
  // never finished, such as a dropped connection: it gets one more try, and its worst case is still charged.
  const entries = deps.store.readLog(jobId) as Array<{ step?: string }>;
  const started = entries.filter(
    (entry) => entry.step === "work_started",
  ).length;
  const interrupted = entries.filter(
    (entry) => entry.step === "work_interrupted",
  ).length;
  if (started > interrupted || started >= 2) return;
  deps.store.log(jobId, { step: "work_started", agent: agent.wallet });
  const spender = spenderOf(agent.wallet);
  const balance = await deps.balance(agent.wallet);
  const limit = () =>
    deps.ledger.spentNanoUsd(spender) +
    budgetNanoUsd(
      balance,
      unsettled(deps, agent),
      deps.ledger.spentNanoUsd(spender),
    );
  const result = await doHostedWork(
    deps.client,
    {
      id: spender,
      prompt: agent.prompt,
      knowledge: agent.knowledge,
      skills: agent.skills,
      model: agent.model,
      key: deps.key,
    },
    { description: bid.description, format: bid.format },
    `bid-${bidId}`,
    limit,
    (run, nanoUsd) =>
      deps.ledger.append({
        at: new Date().toISOString(),
        spender,
        stage: "skill",
        run,
        model: "none",
        status: 200,
        input_tokens: 0,
        output_tokens: 0,
        cost_nano_usd: nanoUsd,
        chat_id: null,
        request_hash: "",
        response_hash: null,
      }),
    deps.sandbox,
  ).catch((error: Error) => {
    if (/did not complete/.test(error.message))
      deps.store.log(jobId, { step: "work_interrupted" });
    throw error;
  });
  deps.store.log(jobId, {
    step: "work",
    agent: agent.wallet,
    bid: bidId,
    refusal: result.refusal,
    usd: result.costNanoUsd / 1e9,
    skills: result.skills,
    inference: result.calls.map((call) => ({
      model: call.model,
      chat_id: call.chatId,
      request_hash: call.requestHash,
      response_hash: call.responseHash,
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
    })),
  });
  if (result.deliverable === null)
    return deps.log("no_delivery", { job: jobId, refusal: result.refusal });
  const tool = createService(
    createRuntime(agentConfig(agent, deps.config, deps.treasury)),
  );
  const delivered = (await tool("deliver", {
    job_id: jobId,
    deliverable: result.deliverable,
  })) as { transaction_hash?: string; private_handoff?: unknown };
  deps.store.log(jobId, {
    step: "deliver",
    transaction_hash: delivered.transaction_hash,
    handed_over: Boolean(delivered.private_handoff),
  });
  if (!delivered.private_handoff)
    throw new PublicError("The private handoff failed.");
}

/** Moves one agent's active job one step along. Returns true if it holds a claim. */
async function advance(
  deps: RunnerDeps,
  agent: HostedAgent,
  bidId: number,
  bid: Bid,
) {
  const board = new BoardClient(deps.config.rpc);
  const wallet = walletOf(agent, deps.config);
  wallet.hosted = { owner: agent.owner, treasury: deps.treasury };
  const jobId = bid.claim?.job_id ?? null;
  if (jobId === null) {
    if ((await board.now()) > BigInt(bid.claim!.expires_at))
      await board.sync(wallet, bidId);
    return;
  }
  const job = await board.view<Job | null>(
    "get_job",
    { job_id: jobId },
    deps.config.escrow,
  );
  if (!job) return void (await board.sync(wallet, bidId));
  const tool = createService(
    createRuntime(agentConfig(agent, deps.config, deps.treasury)),
  );
  const log = (step: string, detail: unknown) =>
    deps.store.log(jobId, { step, detail });
  switch (job.state) {
    case "Funded":
      return work(deps, agent, bid, bidId, jobId, job);
    case "Delivered": {
      const run = (await tool("request_verification", { job_id: jobId })) as {
        transaction_hash?: string;
        job?: Job;
      };
      return log("verify", {
        transaction_hash: run.transaction_hash,
        request: run.job?.verdict_request_id,
      });
    }
    case "Passed":
    case "Failed": {
      const done = (await tool("release_or_refund", { job_id: jobId })) as {
        transaction_hash?: string;
      };
      return log(
        job.state === "Passed" ? "release" : "refund",
        done.transaction_hash,
      );
    }
    case "Released":
    case "Refunded":
    case "Expired":
    case "CheckRejected": {
      const fee = await board.fee(jobId);
      if (fee?.state === "Held")
        log(
          "settle_fee",
          (await board.settleFee(wallet, jobId)).transaction_hash,
        );
      await board.sync(wallet, bidId);
      await settleSpending(deps, agent);
      return log("finished", {
        state: job.state,
        failed_rule: job.failed_rule,
      });
    }
    default:
      return; // Waiting for the buyer, or for a run or payout in flight.
  }
}

/** One pass over the board. */
export async function runnerPass(deps: RunnerDeps): Promise<void> {
  const board = new BoardClient(deps.config.rpc);
  const bids: Array<[number, Bid]> = [];
  for (let from = 0; ; from += 50) {
    const page = await board.bids(from, 50);
    bids.push(...page);
    if (page.length < 50) break;
  }
  const hosted = deps.store.inOrder();
  const busy = new Set<string>();
  for (const [bidId, bid] of bids) {
    const agent =
      bid.claim && hosted.find((a) => a.wallet === bid.claim!.agent);
    if (!agent) continue;
    busy.add(agent.wallet);
    try {
      await advance(deps, agent, bidId, bid);
    } catch (error) {
      deps.log("step_failed", {
        agent: agent.wallet,
        bid: bidId,
        error: String(error),
      });
    }
  }
  // An agent registers itself once it has NEAR. The hashes commit to its public texts and its skills.
  for (const agent of hosted) {
    if (agent.paused || (await deps.balance(agent.wallet)) < MIN_TO_WORK)
      continue;
    if (await board.agent(agent.wallet)) continue;
    try {
      const wallet = walletOf(agent, deps.config);
      wallet.hosted = { owner: agent.owner, treasury: deps.treasury };
      const done = await board.register(wallet, {
        prompt_hash: sha256(agent.prompt),
        knowledge_hash: sha256(agent.knowledge),
        tools_hash: sha256(JSON.stringify([...agent.skills].sort())),
        model: agent.model,
        owner: agent.owner,
      });
      deps.log("registered", {
        agent: agent.wallet,
        hash: done.transaction_hash,
      });
    } catch (error) {
      deps.log("register_failed", {
        agent: agent.wallet,
        error: String(error),
      });
    }
  }
  const now = await board.now();
  for (const [bidId, bid] of bids) {
    if (bid.state !== "Open") continue;
    for (const agent of deps.store.inOrder()) {
      if (busy.has(agent.wallet)) continue;
      const balance = await deps.balance(agent.wallet);
      const refusal = claimRefusal(bid, agent, now, balance);
      if (refusal) continue;
      const attempted = await board.view<unknown>("get_attempt", {
        bid_id: bidId,
        account: agent.wallet,
      });
      if (attempted !== null) continue;
      if (agent.min_buyer_paid_share !== null) {
        const record = await buyerRecord(board, deps.config.escrow, bid.buyer);
        if ((record.paid_share ?? 1) < agent.min_buyer_paid_share) continue;
      }
      try {
        const wallet = walletOf(agent, deps.config);
        wallet.hosted = { owner: agent.owner, treasury: deps.treasury };
        const claimed = await board.claim(wallet, bidId);
        const fresh = deps.store.get(agent.wallet) ?? agent;
        fresh.last_claim_at = new Date().toISOString();
        deps.store.save(fresh);
        busy.add(agent.wallet);
        deps.log("claimed", {
          agent: agent.wallet,
          bid: bidId,
          hash: claimed.transaction_hash,
        });
        break;
      } catch (error) {
        deps.log("claim_failed", {
          agent: agent.wallet,
          bid: bidId,
          error: String(error),
        });
      }
    }
  }
}

export const HOSTED_MODEL = DEFAULT_MODEL;
