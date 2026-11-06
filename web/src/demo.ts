import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join, resolve, parse } from "node:path";

export type DemoState =
  "disabled" | "ready" | "running" | "completed" | "stopped" | "consumed";
export interface DemoJob {
  worker: "honest" | "fake";
  id: number;
  phase: string;
}
export interface DemoStatus {
  state: DemoState;
  message: string;
  elapsed_ms: number;
  jobs: DemoJob[];
}
export interface DemoEvents {
  job(job: DemoJob): void;
  done(success: boolean): void;
}
export type DemoLaunch = (events: DemoEvents) => void;
const ALLOWANCE = "browser-demo-allowance.json";
const USED = "browser-demo-used.json";
const MESSAGES: Record<DemoState, string> = {
  disabled:
    "Live demo is disabled. The operator must prepare one testnet allowance.",
  ready: "One fixed live scripted testnet demo is available.",
  running:
    "The fixed testnet demo is running. Repeated clicks cannot start another run.",
  completed:
    "The scripted demo completed with an honest payment, a fake refund and secret cleanup.",
  stopped:
    "The demo stopped or its outcome is uncertain. The operator must reconcile its private evidence; no automatic retry.",
  consumed:
    "This allowance was already consumed. The operator must reconcile its private evidence before any new run.",
};

/** Check every path component before traversing; allowance state must be owner-only. */
async function privateDirectory(directory: string) {
  const absolute = resolve(directory);
  let part = parse(absolute).root;
  for (const component of absolute.slice(part.length).split("/")) {
    part = join(part, component);
    try {
      await mkdir(part, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(part);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe state directory");
  }
  const info = await lstat(absolute);
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Unsafe state permissions");
}
async function syncDirectory(directory: string) {
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function allowanceExists(directory: string) {
  try {
    const file = join(directory, ALLOWANCE),
      info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 256
    )
      return false;
    const data = JSON.parse(await readFile(file, "utf8"));
    return (
      JSON.stringify(data) ===
      JSON.stringify({ network: "testnet", max_runs: 1, mode: "operator" })
    );
  } catch {
    return false;
  }
}
async function used(directory: string) {
  try {
    await lstat(join(directory, USED));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** An explicit local operator action. No server or deployment startup creates allowances. */
export async function armDemo(directory: string) {
  await privateDirectory(directory);
  if (await used(directory))
    throw new Error(
      "Consumed allowance requires reconciliation; it cannot be rearmed here.",
    );
  const file = await open(join(directory, ALLOWANCE), "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify({ network: "testnet", max_runs: 1, mode: "operator" }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
}

export class BrowserDemo {
  private state: DemoState = "disabled";
  private jobs: DemoJob[] = [];
  private started = 0;
  private finished = 0;
  private directory: string;
  private launch: DemoLaunch;
  private now: () => number;
  private constructor(
    directory: string,
    launch: DemoLaunch,
    now: () => number,
  ) {
    this.directory = directory;
    this.launch = launch;
    this.now = now;
  }
  static async create(directory: string, launch: DemoLaunch, now = Date.now) {
    const demo = new BrowserDemo(directory, launch, now);
    try {
      await privateDirectory(directory);
      if (await used(directory)) demo.state = "consumed";
      else if (await allowanceExists(directory)) demo.state = "ready";
    } catch {
      /* Unsafe or unavailable storage disables signing. */
    }
    return demo;
  }
  status(): DemoStatus {
    return {
      state: this.state,
      message: MESSAGES[this.state],
      elapsed_ms: this.started
        ? Math.max(0, (this.finished || this.now()) - this.started)
        : 0,
      jobs: this.jobs.map((job) => ({ ...job })),
    };
  }
  async start(): Promise<DemoStatus> {
    if (this.state !== "ready") return this.status();
    this.state = "running"; // Synchronous latch before any await.
    this.started = this.now();
    try {
      await privateDirectory(this.directory);
      if (!(await allowanceExists(this.directory)))
        throw new Error("Allowance missing");
      const file = await open(join(this.directory, USED), "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            network: "testnet",
            consumed_at: new Date().toISOString(),
            maximum_runs: 1,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(this.directory);
    } catch (error) {
      this.state =
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "consumed"
          : "stopped";
      this.finished = this.now();
      return this.status();
    }
    try {
      this.launch({
        job: (job) => {
          if (this.state !== "running") return;
          const entry = this.jobs.find((item) => item.worker === job.worker);
          if (entry) {
            if (entry.id === job.id) entry.phase = job.phase;
          } else this.jobs.push({ ...job });
        },
        done: (success) => {
          if (this.state !== "running") return;
          this.state = success ? "completed" : "stopped";
          this.finished = this.now();
        },
      });
    } catch {
      this.state = "stopped";
      this.finished = this.now();
    }
    return this.status();
  }
}
