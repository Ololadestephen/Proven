// Takes jobs for hosted agents, in the published order, within the attempt limits. One pass does a little
// for each agent and reads everything again from the chain, so a crash loses nothing. Only the verifier's
// recorded verdict pays anyone: nothing in here decides an outcome.
import { sha256Hex } from "../../../relay/src/hash.ts";
import {
  BoardClient,
  buyerRecord,
  requireSettled,
  type Bid,
  type Wallet,
} from "../board.ts";
import type { Config } from "../config.ts";
import { PublicError } from "../errors.ts";
import {
  DEFAULT_MODEL,
  ModelInterrupted,
  type Ledger,
  type ModelClient,
} from "../inference.ts";
import { createRuntime } from "../near.ts";
import { createService } from "../service.ts";
import { workRefusal } from "../swarm-rules.ts";
import type { Job } from "../types.ts";
import {
  MIN_TO_WORK,
  DAILY_LIMIT_NANO_USD,
  JOB_LIMIT_NANO_USD,
  PROJECT_LIMIT_NANO_USD,
  SAFE_SKILLS,
  nanoUsdToYoctoNear,
} from "./limits.ts";
import { inferenceBudget, recordEarnings } from "./earnings.ts";
import type { ChainReader } from "./chain-read.ts";
import type { SandboxCall } from "./sandbox.ts";
import type { HostedAgent, HostedStore } from "./store.ts";
import { doHostedWork } from "./work.ts";

export interface RunnerDeps {
  config: Config;
  store: HostedStore;
  ledger: Ledger;
  client: Pick<ModelClient, "call"> & {
    account?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  };
  balance: (account: string) => Promise<bigint>;
  /** Moves spent NEAR to the treasury. Returns the transaction hash. */
  settle: (agent: HostedAgent, yocto: bigint) => Promise<string>;
  treasury: string;
  sandbox?: SandboxCall;
  /** Read-only NEAR access for chain_read. Without it, chain_read is refused. */
  chain?: ChainReader;
  earningsCapYocto?: string;
  /** When each job's verification was last tried, by escrow and job id. */
  verifyTries: Map<string, number>;
  log: (line: string, detail?: unknown) => void;
}

const VERIFY_RETRY_MS = 300_000;
/** A failed hand-over or run waits before trying again, so one stuck job cannot flood the relay or use
 * up its signing allowance. The tries belong to one runner and are keyed by escrow and job. Returns true
 * when a try may start now, and records it. */
export function takeVerifyTry(
  deps: Pick<RunnerDeps, "config" | "verifyTries">,
  jobId: number,
  now: number,
): boolean {
  const key = `${deps.config.escrow}:${jobId}`;
  if (now - (deps.verifyTries.get(key) ?? 0) < VERIFY_RETRY_MS) return false;
  deps.verifyTries.set(key, now);
  return true;
}

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
  const fresh = deps.store.get(agent.wallet);
  if (!fresh) throw new PublicError("The worker record is unavailable.");
  if (
    fresh.pending_settlement_nano_usd ||
    fresh.pending_withdrawal ||
    fresh.pending_claim_bid !== undefined ||
    fresh.pending_registration
  )
    throw new PublicError(
      "An earlier payment needs reconciliation. Automatic spending is stopped.",
    );
  const owed = unsettled(deps, fresh);
  if (owed <= 0) return;
  fresh.pending_settlement_nano_usd = owed;
  deps.store.save(fresh);
  const hash = await deps.settle(fresh, nanoUsdToYoctoNear(owed));
  if (!hash)
    throw new PublicError(
      "The settlement outcome is unknown. Reconcile before another payment.",
    );
  const latest = deps.store.get(agent.wallet);
  if (!latest || latest.pending_settlement_nano_usd !== owed)
    throw new PublicError(
      "The settlement record changed. Reconcile before spending.",
    );
  latest.settled_nano_usd += owed;
  delete latest.pending_settlement_nano_usd;
  deps.store.save(latest);
  deps.log("settled", { agent: agent.wallet, nano_usd: owed, hash });
}

export function dailyRemaining(
  ledger: Pick<Ledger, "rows">,
  spender: string,
  now = new Date(),
): number {
  const day = now.toISOString().slice(0, 10);
  let spent = 0;
  for (const row of ledger.rows()) {
    if (row.spender !== spender) continue;
    if (!Number.isFinite(Date.parse(row.at)))
      throw new PublicError(
        "The spending ledger has an invalid date. Spending is stopped.",
      );
    if (new Date(row.at).toISOString().slice(0, 10) === day)
      spent += row.cost_nano_usd;
  }
  return Math.max(0, DAILY_LIMIT_NANO_USD - spent);
}

export function chargeHostedSkill(
  ledger: Pick<Ledger, "rows" | "spentNanoUsd" | "append">,
  spender: string,
  run: string,
  nanoUsd: number,
  spenderLimit: number,
) {
  const rows = ledger.rows();
  const projectSpent = rows.reduce((sum, row) => sum + row.cost_nano_usd, 0);
  const jobSpent = rows
    .filter((row) => row.spender === spender && row.run === run)
    .reduce((sum, row) => sum + row.cost_nano_usd, 0);
  if (
    !Number.isSafeInteger(nanoUsd) ||
    nanoUsd < 0 ||
    ledger.spentNanoUsd(spender) + nanoUsd > spenderLimit ||
    projectSpent + nanoUsd > PROJECT_LIMIT_NANO_USD ||
    jobSpent + nanoUsd > JOB_LIMIT_NANO_USD
  )
    throw new PublicError(
      "The skill would exceed an inference budget. Spending stopped.",
    );
  ledger.append({
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
  });
}

/** Everything that would stop this agent taking this bid. */
export function claimRefusal(
  bid: Bid,
  agent: HostedAgent,
  now: bigint,
  balance: bigint,
): string | null {
  if (agent.paused) return "paused";
  if (
    agent.pending_settlement_nano_usd ||
    agent.pending_withdrawal ||
    agent.pending_claim_bid !== undefined ||
    agent.pending_registration
  )
    return "payment needs reconciliation";
  if (
    agent.skills?.some(
      (skill) => !(SAFE_SKILLS as readonly string[]).includes(skill),
    )
  )
    return "unsupported skills";
  if (bid.state !== "Open") return "not open";
  if (now >= BigInt(bid.expires_at)) return "expired";
  if (bid.funded_attempts >= 3) return "no attempts left";
  if (bid.buyer === agent.wallet || bid.buyer === agent.owner) return "own bid";
  if (bid.allowed_workers && !bid.allowed_workers.includes(agent.wallet))
    return "not on this bid's list";
  if (balance < MIN_TO_WORK) return "not enough NEAR";
  return null;
}

export function canStartHostedWork(
  entries: unknown[],
  wallet: string,
): boolean {
  let started = 0,
    interrupted = 0;
  for (const value of entries) {
    const row = value as { step?: string; agent?: string };
    if (!["work_started", "work_interrupted"].includes(row.step ?? ""))
      continue;
    if (!row.agent)
      throw new PublicError(
        "Legacy work records need reconciliation before retrying this job.",
      );
    if (row.agent !== wallet) continue;
    if (row.step === "work_started") started++;
    else interrupted++;
  }
  if (interrupted > started)
    throw new PublicError(
      "The work history is inconsistent. Reconcile before spending.",
    );
  return started <= interrupted && started < 2;
}

async function work(
  deps: RunnerDeps,
  agent: HostedAgent,
  bid: Bid,
  bidId: number,
  jobId: number,
  job: Job,
) {
  if (
    agent.paused ||
    agent.pending_settlement_nano_usd ||
    agent.pending_withdrawal ||
    agent.pending_claim_bid !== undefined ||
    agent.pending_registration ||
    agent.skills.some(
      (skill) => !(SAFE_SKILLS as readonly string[]).includes(skill),
    )
  )
    throw new PublicError(
      "The agent cannot spend while paused, awaiting reconciliation or using unsupported skills.",
    );
  const board = new BoardClient(deps.config.rpc);
  const refusal = workRefusal(bid, jobId, job, agent.wallet, await board.now());
  if (refusal) return deps.log("not_starting", { job: jobId, refusal });
  // One try per job, so a failed try never turns into repeated spending. The exception is a call that
  // never finished, such as a dropped connection: it gets one more try, and its worst case is still charged.
  if (!canStartHostedWork(deps.store.readLog(jobId), agent.wallet)) return;
  deps.store.log(jobId, { step: "work_started", agent: agent.wallet });
  const spender = spenderOf(agent.wallet);
  const balance = await deps.balance(agent.wallet);
  const limit = () =>
    deps.ledger.spentNanoUsd(spender) +
    Math.min(
      inferenceBudget(
        agent,
        balance,
        unsettled(deps, agent),
        deps.ledger.spentNanoUsd(spender),
      ),
      dailyRemaining(deps.ledger, spender),
    );
  const result = await doHostedWork(
    deps.client,
    {
      id: spender,
      prompt: agent.prompt,
      knowledge: agent.knowledge,
      skills: agent.skills,
      model: agent.model,
    },
    { description: bid.description, format: bid.format },
    `bid-${bidId}`,
    limit,
    (run, nanoUsd) => {
      if (!deps.client.account)
        throw new PublicError(
          "The hosted client cannot serialize skill spending. Work stopped.",
        );
      return deps.client.account(() =>
        chargeHostedSkill(deps.ledger, spender, run, nanoUsd, limit()),
      );
    },
    { sandbox: deps.sandbox, chain: deps.chain },
  ).catch((error: Error) => {
    if (error instanceof ModelInterrupted)
      deps.store.log(jobId, { step: "work_interrupted", agent: agent.wallet });
    throw error;
  });
  deps.store.log(jobId, {
    step: "work",
    agent: agent.wallet,
    bid: bidId,
    refusal: result.refusal,
    usd: result.costNanoUsd / 1e9,
    skills: result.skills,
    format_checks: result.format_checks,
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
  deps.store.saveDelivery(jobId, result.deliverable);
  await handOver(deps, agent, jobId);
}

/** Records the delivery on chain if needed, and gives the relay its text. Safe to repeat with the same bytes. */
async function handOver(deps: RunnerDeps, agent: HostedAgent, jobId: number) {
  const deliverable = deps.store.readDelivery(jobId);
  if (deliverable === null) return false;
  const tool = createService(
    createRuntime(agentConfig(agent, deps.config, deps.treasury)),
  );
  const delivered = (await tool("deliver", {
    job_id: jobId,
    deliverable,
  })) as { transaction_hash?: string; private_handoff?: unknown };
  deps.store.log(jobId, {
    step: "deliver",
    transaction_hash: delivered.transaction_hash,
    handed_over: Boolean(delivered.private_handoff),
  });
  if (!delivered.private_handoff)
    throw new PublicError("The private handoff failed.");
  deps.store.removeDelivery(jobId);
  return true;
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
  const jobId = bid.job_id;
  if (jobId === null) return;
  const job = await board.view<Job | null>(
    "get_job",
    { job_id: jobId },
    deps.config.escrow,
  );
  if (!job) return;
  // The escrow ended this agent's attempt and reopened the job, or gave it to someone else.
  if (
    job.worker !== agent.wallet &&
    !["Released", "Refunded"].includes(job.state)
  ) {
    requireSettled(await board.sync(wallet, bidId), "sync");
    await settleSpending(deps, agent);
    const mine = (job.history ?? [])
      .filter((a) => a.worker === agent.wallet)
      .at(-1);
    return deps.store.log(jobId, {
      step: "finished",
      detail: { outcome: mine?.outcome },
    });
  }
  const tool = createService(
    createRuntime(agentConfig(agent, deps.config, deps.treasury)),
  );
  const log = (step: string, detail: unknown) =>
    deps.store.log(jobId, { step, detail });
  switch (job.state) {
    case "Funded":
      return work(deps, agent, bid, bidId, jobId, job);
    case "Delivered": {
      if (!takeVerifyTry(deps, jobId, Date.now())) return;
      // A delivery the relay does not have yet goes first, or the run would have nothing to check.
      await handOver(deps, agent, jobId);
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
    case "Refunded": {
      deps.verifyTries.delete(`${deps.config.escrow}:${jobId}`);
      // The sync settles this attempt's fee by its recorded outcome.
      requireSettled(await board.sync(wallet, bidId), "sync");
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

/** Finished bids can have no claim. Never depend on a still-present claim to credit paid work. */
export async function reconcilePaidJobs(
  deps: RunnerDeps,
  bids: Array<[number, Bid]>,
  board = new BoardClient(deps.config.rpc),
) {
  for (const [, bid] of bids) {
    if (bid.job_id === null || !["Done", "Claimed"].includes(bid.state))
      continue;
    const job = await board.view<Job | null>(
      "get_job",
      { job_id: bid.job_id },
      deps.config.escrow,
    );
    if (!job?.worker || !deps.store.get(job.worker)) continue;
    recordEarnings(
      deps.store,
      job.worker,
      deps.config.escrow,
      bid.job_id,
      job,
      deps.earningsCapYocto ?? "500000000000000000000000",
    );
  }
}

/** One pass over the board. */
export async function runnerPass(
  deps: RunnerDeps,
  bidScope?: ReadonlySet<number>,
): Promise<void> {
  const board = new BoardClient(deps.config.rpc);
  const bids: Array<[number, Bid]> = [];
  for (let from = 0; ; from += 50) {
    const page = await board.bids(from, 50);
    bids.push(...page);
    if (page.length < 50) break;
  }
  const hosted = deps.store.inOrder();
  await reconcilePaidJobs(deps, bids);
  const busy = new Set<string>();
  for (const [bidId, bid] of bids) {
    const agent =
      bid.claim && hosted.find((a) => a.wallet === bid.claim!.agent);
    if (!agent) continue;
    busy.add(agent.wallet);
    if (bidScope && !bidScope.has(bidId)) continue;
    try {
      await advance(deps, deps.store.get(agent.wallet)!, bidId, bid);
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
    if (
      agent.paused ||
      agent.pending_settlement_nano_usd ||
      agent.pending_withdrawal ||
      agent.skills.some(
        (skill) => !(SAFE_SKILLS as readonly string[]).includes(skill),
      ) ||
      (await deps.balance(agent.wallet)) < MIN_TO_WORK
    )
      continue;
    if (await board.agent(agent.wallet)) continue;
    try {
      const latest = deps.store.get(agent.wallet);
      if (
        !latest ||
        latest.paused ||
        latest.pending_withdrawal ||
        latest.pending_settlement_nano_usd ||
        latest.pending_claim_bid !== undefined ||
        latest.pending_registration
      )
        continue;
      latest.pending_registration = true;
      deps.store.save(latest);
      const wallet = walletOf(agent, deps.config);
      wallet.hosted = { owner: agent.owner, treasury: deps.treasury };
      const done = requireSettled(
        await board.register(wallet, {
          prompt_hash: sha256Hex(agent.prompt),
          knowledge_hash: sha256Hex(agent.knowledge),
          tools_hash: sha256Hex(JSON.stringify([...agent.skills].sort())),
          model: agent.model,
          owner: agent.owner,
        }),
        "register_agent",
      );
      const registered = deps.store.get(agent.wallet);
      if (!registered?.pending_registration)
        throw new PublicError(
          "The registration record changed. Reconcile before another action.",
        );
      delete registered.pending_registration;
      deps.store.save(registered);
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
    if (bid.state !== "Open" || (bidScope && !bidScope.has(bidId))) continue;
    for (const agent of deps.store.inOrder()) {
      if (
        busy.has(agent.wallet) ||
        dailyRemaining(deps.ledger, spenderOf(agent.wallet)) <= 0
      )
        continue;
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
        const beforeClaim = deps.store.get(agent.wallet);
        if (
          !beforeClaim ||
          beforeClaim.paused ||
          beforeClaim.pending_withdrawal ||
          beforeClaim.pending_settlement_nano_usd ||
          beforeClaim.pending_claim_bid !== undefined ||
          beforeClaim.pending_registration
        )
          continue;
        beforeClaim.pending_claim_bid = bidId;
        deps.store.save(beforeClaim);
        const claimed = requireSettled(
          await board.claim(wallet, bidId),
          "claim",
        );
        const fresh = deps.store.get(agent.wallet) ?? agent;
        delete fresh.pending_claim_bid;
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
