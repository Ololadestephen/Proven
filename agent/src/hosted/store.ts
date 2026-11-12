// What the hosted service remembers, one owner-only file per agent. Prompts and knowledge are public by
// design. The custody key never leaves this file, and `publicView` leaves it out.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ALLOWED_SKILLS, type Skill } from "./limits.ts";
import { PublicError } from "../errors.ts";
import { isObject } from "../json.ts";
import type { WalletSetup } from "./wallets.ts";

export const SETUP_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export interface SetupRecord {
  owner: string;
  payload: string;
  reviews: number;
  review?: HostedAgent["review"];
  refused?: string;
  walletSetup?: WalletSetup;
  completed?: string;
}

/** One paid job credited to a hosted worker: what escrow paid, what went to inference and what was kept. */
export interface EarningsRecord {
  escrow: string;
  job_id: number;
  verdict_request_id: string;
  amount_yocto: string;
  inference_yocto: string;
  retained_yocto: string;
  at: string;
}

export interface HostedAgent {
  wallet: string;
  wallet_id: string;
  custody_key: string;
  owner: string;
  prompt: string;
  knowledge: string;
  skills: Skill[];
  model: string;
  review: {
    reason: string;
    model: string;
    chat_id: string;
    response_hash: string;
  };
  /** Skip buyers who have paid less than this share of their finished jobs. Null takes any buyer. */
  min_buyer_paid_share: number | null;
  created_at: string;
  /** Used for the fair order: whoever has waited longest goes first. */
  last_claim_at: string | null;
  settled_nano_usd: number;
  paused: boolean;
  keep_bps?: number;
  earnings?: EarningsRecord[];
  pending_settlement_nano_usd?: number;
  pending_withdrawal?: boolean;
  pending_claim_bid?: number;
  pending_registration?: boolean;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function damaged(): never {
  throw new PublicError(
    "Hosted persistence is damaged or unavailable. Work and spending are stopped; reconcile the stored records.",
  );
}
function parseSetup(value: unknown): SetupRecord {
  if (
    !isObject(value) ||
    typeof value.owner !== "string" ||
    typeof value.payload !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.payload) ||
    ![0, 1, 2].includes(value.reviews as number) ||
    (value.refused !== undefined && typeof value.refused !== "string") ||
    (value.completed !== undefined &&
      (typeof value.completed !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.completed)))
  )
    return damaged();
  const review = value.review;
  if (
    review !== undefined &&
    (!isObject(review) ||
      !["reason", "model", "chat_id", "response_hash"].every(
        (field) => typeof review[field] === "string",
      ))
  )
    return damaged();
  const setup = value.walletSetup;
  if (setup !== undefined) {
    if (!review || !isObject(setup)) return damaged();
    if (setup.stage !== "registering") {
      const wallet = setup.wallet;
      if (
        (setup.stage !== "registered" && setup.stage !== "storing_policy") ||
        !isObject(wallet) ||
        typeof wallet.wallet !== "string" ||
        !/^[a-f0-9]{64}$/.test(wallet.wallet) ||
        typeof wallet.wallet_id !== "string" ||
        !wallet.wallet_id ||
        typeof wallet.custody_key !== "string" ||
        !wallet.custody_key
      )
        return damaged();
    }
  }
  return value as unknown as SetupRecord;
}
function parseAgent(text: string, wallet: string): HostedAgent {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return damaged();
  }
  if (
    !isObject(x) ||
    x.wallet !== wallet ||
    ![
      "owner",
      "prompt",
      "knowledge",
      "model",
      "wallet_id",
      "custody_key",
      "created_at",
    ].every((k) => typeof x[k] === "string") ||
    !isObject(x.review) ||
    !["reason", "model", "chat_id", "response_hash"].every(
      (k) => typeof (x.review as Record<string, unknown>)[k] === "string",
    ) ||
    !Array.isArray(x.skills) ||
    !x.skills.every(
      (v) =>
        typeof v === "string" &&
        (ALLOWED_SKILLS as readonly string[]).includes(v),
    ) ||
    typeof x.paused !== "boolean" ||
    !Number.isSafeInteger(x.settled_nano_usd) ||
    Number(x.settled_nano_usd) < 0 ||
    !(
      x.min_buyer_paid_share === null ||
      (typeof x.min_buyer_paid_share === "number" &&
        x.min_buyer_paid_share >= 0 &&
        x.min_buyer_paid_share <= 1)
    ) ||
    !(x.last_claim_at === null || typeof x.last_claim_at === "string") ||
    !(
      x.keep_bps === undefined ||
      (Number.isInteger(x.keep_bps) &&
        Number(x.keep_bps) >= 0 &&
        Number(x.keep_bps) <= 10000)
    ) ||
    !(
      x.pending_settlement_nano_usd === undefined ||
      (Number.isSafeInteger(x.pending_settlement_nano_usd) &&
        Number(x.pending_settlement_nano_usd) > 0)
    ) ||
    !(
      x.pending_registration === undefined ||
      typeof x.pending_registration === "boolean"
    ) ||
    !(
      x.pending_claim_bid === undefined ||
      (Number.isSafeInteger(x.pending_claim_bid) &&
        Number(x.pending_claim_bid) >= 0)
    ) ||
    !(
      x.pending_withdrawal === undefined ||
      typeof x.pending_withdrawal === "boolean"
    )
  )
    return damaged();
  if (x.earnings !== undefined) {
    if (!Array.isArray(x.earnings)) return damaged();
    const jobs = new Set<string>();
    for (const row of x.earnings) {
      if (
        !isObject(row) ||
        typeof row.escrow !== "string" ||
        !Number.isSafeInteger(row.job_id) ||
        Number(row.job_id) < 0 ||
        typeof row.verdict_request_id !== "string" ||
        !/^\d+$/.test(row.verdict_request_id) ||
        typeof row.at !== "string" ||
        !["amount_yocto", "inference_yocto", "retained_yocto"].every(
          (k) => typeof row[k] === "string" && /^\d+$/.test(row[k] as string),
        ) ||
        BigInt(row.inference_yocto as string) +
          BigInt(row.retained_yocto as string) !==
          BigInt(row.amount_yocto as string)
      )
        return damaged();
      const id = `${row.escrow}:${row.job_id}`;
      if (jobs.has(id)) return damaged();
      jobs.add(id);
    }
  }
  return x as unknown as HostedAgent;
}

export class HostedStore {
  private readonly dir: string;
  private readonly activeSetups = new Set<string>();
  constructor(root: string) {
    this.dir = root;
    mkdirSync(join(root, "agents"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
  }
  private path(wallet: string) {
    if (!/^[a-z0-9._-]{2,64}$/.test(wallet)) throw new Error("bad wallet");
    return join(this.dir, "agents", `${wallet}.json`);
  }
  save(agent: HostedAgent) {
    const path = this.path(agent.wallet);
    writeFileSync(`${path}.tmp`, JSON.stringify(agent), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  get(wallet: string): HostedAgent | null {
    try {
      return parseAgent(readFileSync(this.path(wallet), "utf8"), wallet);
    } catch (error) {
      if (missing(error)) return null;
      return damaged();
    }
  }
  all(): HostedAgent[] {
    return readdirSync(join(this.dir, "agents"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const agent = this.get(name.slice(0, -5));
        if (!agent) return damaged();
        return agent;
      });
  }
  /** Agents in the published order: longest waiting first, then oldest. */
  inOrder(): HostedAgent[] {
    return this.all().sort(
      (a, b) =>
        (a.last_claim_at ?? "").localeCompare(b.last_claim_at ?? "") ||
        a.created_at.localeCompare(b.created_at) ||
        a.wallet.localeCompare(b.wallet),
    );
  }
  private setupPath(hash: string) {
    if (!SETUP_HASH.test(hash))
      throw new PublicError("Invalid setup transaction hash.");
    return join(this.dir, `setup-${hash}`);
  }
  /** The hosted service has an exclusive data-directory lock; hold a per-payment lock across awaits. */
  async withSetup<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeSetups.has(hash))
      throw new PublicError(
        "This signup is already running. Retry with the same payment shortly.",
      );
    this.activeSetups.add(hash);
    try {
      return await operation();
    } finally {
      this.activeSetups.delete(hash);
    }
  }
  readSetup(hash: string): SetupRecord | "legacy" | null {
    const path = this.setupPath(hash);
    try {
      const text = readFileSync(path, "utf8");
      // Earlier releases only stored an empty spent marker. Never reuse those payments.
      return text === "" ? "legacy" : parseSetup(JSON.parse(text));
    } catch (error) {
      if (missing(error)) return null;
      return damaged();
    }
  }
  saveSetup(hash: string, record: SetupRecord) {
    const path = this.setupPath(hash);
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(record), {
        mode: 0o600,
        flush: true,
      });
      renameSync(`${path}.tmp`, path);
    } catch {
      return damaged();
    }
  }
  /** Kept until the relay has it, so a failed hand-over can never lose work already fixed on chain. */
  saveDelivery(jobId: number, text: string) {
    writeFileSync(join(this.dir, "logs", `job-${jobId}.delivery`), text, {
      mode: 0o600,
    });
  }
  readDelivery(jobId: number): string | null {
    try {
      return readFileSync(
        join(this.dir, "logs", `job-${jobId}.delivery`),
        "utf8",
      );
    } catch (error) {
      if (missing(error)) return null;
      return damaged();
    }
  }
  removeDelivery(jobId: number) {
    rmSync(join(this.dir, "logs", `job-${jobId}.delivery`), { force: true });
  }
  log(jobId: number, entry: Record<string, unknown>) {
    const path = join(this.dir, "logs", `job-${jobId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { flag: "a", mode: 0o600 },
    );
  }
  readLog(jobId: number): unknown[] {
    try {
      return readFileSync(join(this.dir, "logs", `job-${jobId}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const entry: unknown = JSON.parse(line);
          if (
            !isObject(entry) ||
            typeof entry.step !== "string" ||
            !entry.step ||
            typeof entry.at !== "string"
          )
            return damaged();
          return entry;
        });
    } catch (error) {
      if (missing(error)) return [];
      return damaged();
    }
  }
}

export function publicView(agent: HostedAgent) {
  const { custody_key: _key, wallet_id: _id, ...rest } = agent;
  return rest;
}
