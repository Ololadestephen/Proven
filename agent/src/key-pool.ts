// A pool of NEAR AI keys, so work continues when one key reaches its own limit, under budgets a key
// switch cannot get around. The ledger counts every key, so moving to a spare changes nothing about
// what an agent or the project has spent.
//
// It moves to the next key only when NEAR AI says that key reached its spending limit. That call never
// ran, so nothing is repeated. Any other error stops here. A timeout has an unknown outcome and may
// have been charged, so it never moves on. Abnormal spending for a job stops and alerts, not switches.
import { appendFileSync } from "node:fs";
import { PublicError } from "./errors.ts";
import {
  ModelRefused,
  type CallRequest,
  type CallResult,
  type Ledger,
  type ModelClient,
} from "./inference.ts";

export interface PoolLimits {
  /** The most this agent may ever spend, across all its keys, in nano-USD. */
  agentNanoUsd: number;
  /** The most the whole project may ever spend, across everything, in nano-USD. */
  projectNanoUsd: number;
  /** More than this on one job is abnormal, whatever the key. */
  jobNanoUsd: number;
}

export interface NamedKey {
  /** The environment variable's name, which is safe to log. Never the key itself. */
  name: string;
  key: string;
}

export class BudgetStop extends PublicError {}

export class KeyPool {
  private readonly client: Pick<ModelClient, "call">;
  private readonly ledger: Pick<Ledger, "rows">;
  private readonly keys: NamedKey[];
  private readonly limits: PoolLimits;
  private readonly logPath: string;
  private index = 0;

  constructor(
    client: Pick<ModelClient, "call">,
    ledger: Pick<Ledger, "rows">,
    keys: NamedKey[],
    limits: PoolLimits,
    logPath: string,
  ) {
    if (keys.length === 0) throw new PublicError("The key pool has no keys.");
    this.client = client;
    this.ledger = ledger;
    this.keys = keys;
    this.limits = limits;
    this.logPath = logPath;
  }

  private log(event: string, detail: Record<string, unknown>) {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`,
    );
  }

  private stop(reason: string, detail: Record<string, unknown>): never {
    this.log("alert", { reason, ...detail });
    throw new BudgetStop(`Stopped, owner alert needed: ${reason}.`);
  }

  private checkBudgets(request: CallRequest) {
    const rows = this.ledger.rows();
    const sum = (keep: (row: (typeof rows)[number]) => boolean) =>
      rows.filter(keep).reduce((total, row) => total + row.cost_nano_usd, 0);
    const detail = { agent: request.spender, job: request.run };
    if (sum(() => true) >= this.limits.projectNanoUsd)
      this.stop("the project's inference budget is reached", detail);
    if (
      sum((row) => row.spender === request.spender) >= this.limits.agentNanoUsd
    )
      this.stop("this agent's inference budget is reached", detail);
    if (
      sum(
        (row) => row.spender === request.spender && row.run === request.run,
      ) >= this.limits.jobNanoUsd
    )
      this.stop("this agent's spending is abnormal for its job", detail);
  }

  /** `request.key` is ignored: the pool chooses the key. */
  async call(request: CallRequest): Promise<CallResult> {
    for (;;) {
      this.checkBudgets(request);
      const current = this.keys[this.index];
      if (!current)
        this.stop("every key in the pool has reached its limit", {
          agent: request.spender,
          job: request.run,
        });
      try {
        return await this.client.call({
          ...request,
          key: current.key,
          keyName: current.name,
        });
      } catch (error) {
        if (!(error instanceof ModelRefused) || !error.limitReached)
          throw error;
        this.index += 1;
        this.log("key_switch", {
          from: current.name,
          to: this.keys[this.index]?.name ?? null,
          agent: request.spender,
          job: request.run,
        });
      }
    }
  }
}

/** The named keys that are set, in order: for example `NEARAI_KEY_AGENT_A`, then its `_2`, `_3`. */
export function keysFrom(
  env: Record<string, string | undefined>,
  names: string[],
): NamedKey[] {
  const out: NamedKey[] = [];
  for (const name of names) {
    for (const candidate of [name, `${name}_2`, `${name}_3`]) {
      const key = env[candidate];
      if (key) out.push({ name: candidate, key });
    }
  }
  return out;
}
