// Scripted agents using exactly the public CLI. Private inputs travel through stdin, never argv.
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { JsonRpcProvider } from "near-api-js";
import { ROOT, loadConfig } from "./config.ts";
import { PublicError, publicMessage } from "./errors.ts";
import type { Actor } from "./types.ts";
import { runDemo, type DemoEvidence, type Outcome } from "./demo-runner.ts";
import {
  createOperatorDemoTools,
  type OperatorStatus,
} from "./demo-operator.ts";
import { handoff } from "./handoff.ts";
import { waitTransactionResult } from "./near.ts";
import { nativePayoutProof } from "./payout-proof.ts";
import { assertPolicy, custodyRead } from "./custody.ts";

function parseLocalJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicError("Invalid local JSON. No transaction was sent.");
  }
}

async function tool(
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
  dry = false,
  session?: string,
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const cli = spawn(
      process.execPath,
      [
        `${ROOT}agent/src/cli.ts`,
        name,
        "--actor",
        actor,
        ...(dry ? ["--dry-run"] : []),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(session ? { PROVEN_DEMO_SESSION: session } : {}),
        },
      },
    );
    let output = "";
    const timer = setTimeout(() => {
      cli.kill();
      reject(
        new PublicError(
          "Demo command timed out. Inspect job status and evidence before retrying.",
        ),
      );
    }, 240000);
    cli.stdout.on("data", (data) => {
      output += data.toString();
      if (Buffer.byteLength(output) > 1048576) cli.kill();
    });
    cli.stderr.resume();
    cli.on("error", () => {
      clearTimeout(timer);
      reject(new PublicError("Could not start the agent CLI."));
    });
    cli.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new PublicError(
            `Demo ${name} stopped. Inspect the last recorded job before retrying.`,
          ),
        );
      try {
        resolve(JSON.parse(output) as Outcome);
      } catch {
        reject(new PublicError("Demo CLI returned invalid JSON."));
      }
    });
    cli.stdin.on("error", () => undefined);
    cli.stdin.end(JSON.stringify(args));
  });
}

async function main() {
  const invocationStartedAt = new Date().toISOString();
  const rawArgs = process.argv.slice(2);
  const operator = rawArgs.includes("--operator-compute");
  const cliArgs = rawArgs.filter((arg) => arg !== "--operator-compute");
  if (rawArgs.filter((arg) => arg === "--operator-compute").length > 1)
    throw new PublicError("Duplicate operator mode flag.");
  const dry = cliArgs.includes("--dry-run");
  const resume = cliArgs[0] === "--resume" ? cliArgs[1] : undefined;
  if (!(
    cliArgs.length === 0 ||
    (cliArgs.length === 1 && dry) ||
    (cliArgs.length === 2 &&
      resume &&
      dirname(resume) === `${ROOT}runs` &&
      /^p[46]-demo-[a-f0-9-]{36}\.json$/.test(basename(resume)))
  ))
    throw new PublicError(
      "Usage: npm run demo -- [--operator-compute] [--dry-run | --resume <evidence-file>]",
    );
  const evidence: DemoEvidence = resume
    ? (parseLocalJson(readFileSync(resume, "utf8")) as DemoEvidence)
    : {
        scripted: true,
        dry_run: dry,
        cases: [],
        started_at: invocationStartedAt,
      };
  if (resume && evidence.dry_run)
    throw new PublicError("Cannot resume dry-run evidence as a live run.");
  if (!evidence || evidence.scripted !== true || !Array.isArray(evidence.cases))
    throw new PublicError("Invalid demo evidence. No transaction was sent.");
  if (
    resume &&
    evidence.cases.some((entry) => entry.post_started && !entry.post)
  )
    throw new PublicError(
      "Job creation has an unknown prior outcome. Reconcile custody history and record its id before resuming.",
    );
  if (
    resume &&
    (evidence.compute_mode ?? "custody") !== (operator ? "operator" : "custody")
  )
    throw new PublicError("Resume must preserve the saved compute payer mode.");
  evidence.compute_mode = operator ? "operator" : "custody";
  let sponsor: OperatorStatus | undefined;
  const base = `${ROOT}examples/data-job/`;
  const check = readFileSync(`${base}check-strong.json`, "utf8");
  const reference = readFileSync(`${base}reference.json`, "utf8");
  const build = parseLocalJson(check) as { verifier?: unknown };
  const config = loadConfig("buyer");
  const provider = new JsonRpcProvider({ url: config.rpc });
  if (!dry) {
    if (!config.account || !config.custodyKey)
      throw new PublicError("Restricted custody buyer is not configured.");
    assertPolicy(
      await custodyRead(
        config.custodyApi,
        config.custodyKey,
        "/wallet/v1/policy",
      ),
      config.escrow,
    );
    const socket = lstatSync(config.socket, { throwIfNoEntry: false });
    if (
      !socket?.isSocket() ||
      (socket.mode & 0o077) !== 0 ||
      socket.uid !== process.getuid?.()
    )
      throw new PublicError(
        "Start the private relay handoff before running the demo.",
      );
    if (operator) {
      sponsor = (await handoff(config.socket, {
        action: "demo_status",
      })) as OperatorStatus;
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const workers = [
        loadConfig("honest").account,
        loadConfig("fake").account,
      ];
      if (
        !sponsor?.enabled ||
        sponsor.escrow !== config.escrow ||
        sponsor.buyer !== config.account ||
        JSON.stringify(sponsor.workers) !== JSON.stringify(workers) ||
        sponsor.spec_hash !== hash(check) ||
        sponsor.reference_hash !== hash(reference) ||
        sponsor.verifier_hash !== build.verifier ||
        (!resume && (sponsor.remaining !== 4 || sponsor.jobs.length !== 0)) ||
        (evidence.operator_session &&
          evidence.operator_session !== sponsor.session_id)
      )
        throw new PublicError(
          "Start the matching one-run private relay with --demo-compute before creating jobs; reconcile any changed session.",
        );
      evidence.operator_session = sponsor.session_id;
    }
    if (!resume) {
      const wallet = await provider.viewAccount({
        accountId: config.account,
        blockQuery: { finality: "final" },
      });
      if (
        wallet.amount <
        (operator ? 150000000000000000000000n : 300000000000000000000000n)
      )
        throw new PublicError(
          "Fresh demo has insufficient testnet NEAR for this mode's transient reserves (0.15 operator-sponsored, 0.3 custody compute). No job was created or funded.",
        );
    }
  }
  mkdirSync(`${ROOT}runs`, { recursive: true });
  const file = resume ?? `${ROOT}runs/p6-demo-${randomUUID()}.json`;
  const save = () =>
    writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
  const near = async (accountId: string) =>
    (
      await provider.viewAccount({
        accountId,
        blockQuery: { finality: "final" },
      })
    ).amount;
  const lockPath = `${ROOT}runs/demo.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new PublicError(
      "Another demo or an unresolved prior run holds runs/demo.lock. Reconcile its evidence before removing the lock.",
    );
  }
  try {
    if (resume) evidence.resumed = true;
    const operatorTools = sponsor
      ? createOperatorDemoTools(
          (actor, name, args, dry) =>
            tool(actor, name, args, dry, evidence.operator_session),
          (value) => handoff(config.socket, value),
          evidence,
          sponsor,
          save,
          (hash, payer) => waitTransactionResult(provider, hash, payer),
        )
      : undefined;
    await runDemo({
      evidence,
      scenario: {
        parallel: operator,
        buyer: config.account!,
        check,
        reference,
        account(worker) {
          const identity = loadConfig(worker).account;
          if (!identity)
            throw new PublicError(
              "Run the owner-approved testnet setup before the scripted demo.",
            );
          return identity;
        },
        delivery: (worker) =>
          readFileSync(`${base}deliverable-${worker}.json`, "utf8"),
      },
      io: {
        tool: operatorTools?.tool ?? tool,
        begin: operatorTools?.begin,
        finish: operatorTools?.finish,
        provePayout: (id, hash, receiver, amount) =>
          nativePayoutProof(
            provider,
            id,
            hash,
            loadConfig("fake").account!,
            config.escrow,
            receiver,
            amount,
          ),
        balance: near,
        save,
        event: (text) => console.error(text),
        now: Date.now,
      },
    });
    console.log(JSON.stringify({ ...evidence, evidence_file: file }, null, 2));
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(publicMessage(error));
    process.exitCode = 1;
  });
