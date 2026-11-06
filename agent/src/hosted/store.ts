// What the hosted service remembers, one owner-only file per agent. Prompts and knowledge are public by
// design. The custody key never leaves this file, and `publicView` leaves it out.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Skill } from "./limits.ts";

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
}

export class HostedStore {
  private readonly dir: string;
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
      return JSON.parse(readFileSync(this.path(wallet), "utf8")) as HostedAgent;
    } catch {
      return null;
    }
  }
  all(): HostedAgent[] {
    return readdirSync(join(this.dir, "agents"))
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(
            readFileSync(join(this.dir, "agents", name), "utf8"),
          ) as HostedAgent,
      );
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
  /** A setup fee transaction can pay for one agent only. */
  claimSetupTransaction(hash: string): boolean {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hash)) return false;
    try {
      writeFileSync(join(this.dir, `setup-${hash}`), "", {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch {
      return false;
    }
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
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      return [];
    }
  }
}

export function publicView(agent: HostedAgent) {
  const { custody_key: _key, wallet_id: _id, ...rest } = agent;
  return rest;
}
