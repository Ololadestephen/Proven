// Private local transport only. The relay pins texts; it cannot decide a verdict.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  open,
  rename,
  unlink,
  readFile,
} from "node:fs/promises";
import { createDemoSponsor, type DemoCompute } from "./demo-sponsor.ts";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CollectVerifier, type CollectAuth } from "./buyer-auth.ts";
import { isHash, sha256Hex } from "./hash.ts";
import type { Job, RunKind } from "./near.ts";
import type { TimingEvent, TimingSink } from "./timing.ts";
import type { SecretJournal } from "./secret-call.ts";

export const MAX_HANDOFF_BYTES = 512 * 1024;
export const DEFAULT_SOCKET = fileURLToPath(
  new URL("../../runs/private/relay.sock", import.meta.url),
);
const FAILURE =
  "Private relay refused the handoff. Check job hashes, state, and local permissions.";
const UID = process.getuid?.();

type HandoffJob = Pick<
  Job,
  | "state"
  | "spec_hash"
  | "fakes_hash"
  | "verifier_hash"
  | "secrets_owner"
  | "deliverable_hash"
  | "challenge_request_id"
  | "verdict_request_id"
> & {
  run_started_at?: string | null;
  buyer?: string;
  worker?: string;
  token?: string | null;
  amount?: string;
};

export interface HandoffDependencies {
  accountId: string;
  escrow: string;
  getJob(jobId: number): Promise<HandoffJob | null>;
  storeSecret(
    verifierHash: string,
    profile: string,
    variables: Record<string, string>,
  ): Promise<{ transactionHash: string; ciphertextBytes: number }>;
  deleteSecret(verifierHash: string, profile: string): Promise<string>;
  /** Whether this key is on the account, per the chain. */
  isAccessKey(account: string, publicKey: string): Promise<boolean>;
  demoCompute?: DemoCompute;
  isSigningSuspended?: () => boolean;
}

type Request =
  | { action: "challenge"; job_id: number; check: string; reference: string }
  | { action: "deliver"; job_id: number; deliverable: string }
  | { action: "pin_verification"; job_id: number }
  | { action: "cleanup"; job_id: number; kind: RunKind }
  | { action: "collect"; job_id: number; auth: CollectAuth };
type DemoRequest = { action: "trigger"; job_id: number; kind: RunKind };
export type HandoffReply =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string };
const refused = (): HandoffReply => ({ ok: false, error: FAILURE });

class Refused extends Error {}
function requireSafe(condition: unknown): asserts condition {
  if (!condition) throw new Refused();
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseRequest(value: unknown): Request | DemoRequest {
  requireSafe(
    object(value) &&
      Number.isSafeInteger(value.job_id) &&
      (value.job_id as number) >= 0,
  );
  const fields: Record<string, readonly string[]> = {
    challenge: ["action", "job_id", "check", "reference"],
    deliver: ["action", "job_id", "deliverable"],
    pin_verification: ["action", "job_id"],
    cleanup: ["action", "job_id", "kind"],
    collect: ["action", "job_id", "auth"],
    trigger: ["action", "job_id", "kind"],
  };
  requireSafe(
    typeof value.action === "string" && Object.hasOwn(fields, value.action),
  );
  const allowed = fields[value.action]!;
  requireSafe(
    Object.keys(value).length === allowed.length &&
      Object.keys(value).every((key) => allowed.includes(key)),
  );
  if (value.action === "challenge")
    requireSafe(
      typeof value.check === "string" && typeof value.reference === "string",
    );
  if (value.action === "deliver")
    requireSafe(typeof value.deliverable === "string");
  if (value.action === "collect") {
    const auth = value.auth;
    requireSafe(
      object(auth) &&
        ["public_key", "signature_base64", "nonce_base64", "message"].every(
          (field) => typeof auth[field] === "string",
        ),
    );
  }
  if (value.action === "cleanup" || value.action === "trigger")
    requireSafe(value.kind === "Challenge" || value.kind === "Verify");
  requireSafe(Buffer.byteLength(JSON.stringify(value)) <= MAX_HANDOFF_BYTES);
  return value as Request | DemoRequest;
}

/** Every path component is checked before traversal; the final directory is owner-only. */
async function privateDirectory(path: string): Promise<void> {
  requireSafe(UID !== undefined && isAbsolute(path));
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute
    .slice(root.length)
    .split("/")
    .filter(Boolean)) {
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    requireSafe(info.isDirectory() && !info.isSymbolicLink());
    // System-owned sticky directories such as /tmp are safe ancestors, never storage roots.
    requireSafe(
      (info.mode & 0o022) === 0 ||
        (info.uid === 0 && (info.mode & 0o1000) !== 0),
    );
    requireSafe(info.uid === UID || info.uid === 0);
  }
  const info = await lstat(absolute);
  requireSafe(info.uid === UID && (info.mode & 0o777) === 0o700);
}

async function safeExistingFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    requireSafe(
      info.isFile() &&
        info.uid === UID &&
        (info.mode & 0o777) === 0o600 &&
        info.nlink === 1,
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writePrivate(path: string, text: string): Promise<void> {
  await safeExistingFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify({ text }));
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function readPrivate(path: string): Promise<string> {
  requireSafe(await safeExistingFile(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    requireSafe(
      info.isFile() &&
        info.uid === UID &&
        (info.mode & 0o777) === 0o600 &&
        info.nlink === 1 &&
        info.size <= MAX_HANDOFF_BYTES * 2,
    );
    const record: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile()),
    );
    requireSafe(
      object(record) &&
        Object.keys(record).length === 1 &&
        typeof record.text === "string",
    );
    return record.text;
  } finally {
    await file.close();
  }
}

function validateCheck(job: HandoffJob, check: string): void {
  requireSafe(sha256Hex(check) === job.spec_hash);
  const parsed: unknown = JSON.parse(check);
  requireSafe(object(parsed) && parsed.verifier === job.verifier_hash);
}
function profile(job: HandoffJob, jobId: number, kind: RunKind): string {
  return kind === "Challenge"
    ? `c${jobId}-${job.fakes_hash.slice(0, 12)}`
    : `v${jobId}-${job.deliverable_hash!.slice(0, 12)}`;
}

/** Paid work is kept this long after delivery for the buyer to collect, then deleted. */
export const COLLECT_RETENTION_MS = 30 * 24 * 3_600_000;
const SWEEP_EVERY_MS = 3_600_000;

/** Deletes refunded, expired and cancelled work, paid work past retention, and every private check
 * once its job has ended. A failed read deletes nothing. Returns the deleted deliverables' job ids. */
export async function sweepDeliveries(
  deps: Pick<HandoffDependencies, "getJob" | "escrow">,
  directory: string,
  now = Date.now(),
): Promise<number[]> {
  const records = join(directory, `jobs-${sha256Hex(deps.escrow)}`);
  const deleted: number[] = [];
  const names = await readdir(records).catch(() => [] as string[]);
  for (const name of names) {
    const parts = /^(\d+)\.(deliverable|check)\.json$/.exec(name);
    if (!parts) continue;
    const jobId = Number(parts[1]);
    const file = join(records, name);
    try {
      const job = await deps.getJob(jobId);
      const refused =
        job === null || ["Refunded", "Expired"].includes(job.state);
      if (parts[2] === "check") {
        if (
          refused ||
          job?.state === "Released" ||
          job?.state === "CheckRejected"
        )
          await unlink(file);
        continue;
      }
      const old = now - (await lstat(file)).mtimeMs > COLLECT_RETENTION_MS;
      if (refused || (job?.state === "Released" && old)) {
        await unlink(file);
        deleted.push(jobId);
      }
    } catch {
      /* Try again on the next sweep. */
    }
  }
  return deleted;
}

export async function createHandoffHandler(
  deps: HandoffDependencies,
  directory: string,
): Promise<(value: unknown) => Promise<HandoffReply>> {
  await privateDirectory(directory);
  const records = join(directory, `jobs-${sha256Hex(deps.escrow)}`);
  await privateDirectory(records);
  const queues = new Map<number, Promise<unknown>>();
  const collectVerifier = new CollectVerifier(deps.isAccessKey);
  const pinned = new Set<string>();
  let walletQueue = Promise.resolve<unknown>(undefined);
  function wallet<T>(action: () => Promise<T>): Promise<T> {
    const next = walletQueue
      .catch(() => undefined)
      .then(() => {
        requireSafe(!deps.isSigningSuspended?.());
        return action();
      });
    walletQueue = next;
    return next;
  }
  const sponsor = createDemoSponsor(
    deps.demoCompute,
    deps.accountId,
    deps.getJob,
    wallet,
    (record) =>
      writePrivate(
        join(directory, `demo-sponsor-${record.session_id}.json`),
        JSON.stringify(record),
      ),
  );
  const path = (jobId: number, kind: "check" | "deliverable") =>
    join(records, `${jobId}.${kind}.json`);

  async function perform(
    request: Request | DemoRequest,
    session?: string,
  ): Promise<Record<string, unknown>> {
    const job = await deps.getJob(request.job_id);
    requireSafe(
      job &&
        job.secrets_owner === deps.accountId &&
        isHash(job.spec_hash) &&
        isHash(job.fakes_hash) &&
        isHash(job.verifier_hash),
    );
    if (request.action === "collect") {
      // Only the job's buyer, and only once the chain shows the worker has been paid.
      requireSafe(job.state === "Released" && typeof job.buyer === "string");
      requireSafe(
        await collectVerifier.verify(
          request.auth,
          job.buyer as string,
          request.job_id,
        ),
      );
      const text = await readPrivate(path(request.job_id, "deliverable"));
      requireSafe(sha256Hex(text) === job.deliverable_hash);
      return { deliverable: text, deliverable_hash: job.deliverable_hash };
    }
    if (request.action === "trigger") {
      return sponsor.trigger(request.job_id, request.kind, session ?? "", () =>
        pinned.has(`${request.job_id}:${request.kind}`),
      );
    }
    if (request.action === "deliver") {
      requireSafe(
        ["Delivered", "Verifying"].includes(job.state) &&
          sha256Hex(request.deliverable) === job.deliverable_hash,
      );
      // Delivery never opens the buyer's saved check or asks OutLayer to read a secret.
      await writePrivate(
        path(request.job_id, "deliverable"),
        request.deliverable,
      );
      return { deliverable_hash: job.deliverable_hash };
    }
    if (request.action === "cleanup") {
      requireSafe(
        !["Challenging", "Verifying"].includes(job.state) &&
          job.run_started_at == null,
      );
      const terminal = ["Released", "Refunded", "Expired"].includes(job.state);
      const recorded =
        request.kind === "Challenge"
          ? job.challenge_request_id
          : job.verdict_request_id;
      requireSafe(
        terminal || (typeof recorded === "string" && /^\d+$/.test(recorded)),
      );
      if (request.kind === "Verify") requireSafe(isHash(job.deliverable_hash));
      const name = profile(job, request.job_id, request.kind);
      const transactionHash = await wallet(async () => {
        const fresh = await deps.getJob(request.job_id);
        requireSafe(
          fresh &&
            !["Challenging", "Verifying"].includes(fresh.state) &&
            fresh.run_started_at == null,
        );
        return deps.deleteSecret(job.verifier_hash, name);
      });
      pinned.delete(`${request.job_id}:${request.kind}`);
      if (terminal) {
        // Paid work stays until the buyer can collect it; see sweepDeliveries for how long.
        const kinds =
          job.state === "Released"
            ? (["check"] as const)
            : (["check", "deliverable"] as const);
        for (const kind of kinds) {
          const file = path(request.job_id, kind);
          if (await safeExistingFile(file)) await unlink(file);
        }
      }
      return { profile: name, transaction_hash: transactionHash };
    }
    const challenge = request.action === "challenge";
    requireSafe(
      (challenge
        ? ["Draft", "Challenging"]
        : ["Delivered", "Verifying"]
      ).includes(job.state),
    );
    const check = challenge
      ? request.check
      : await readPrivate(path(request.job_id, "check"));
    validateCheck(job, check);
    const other = challenge
      ? request.reference
      : await readPrivate(path(request.job_id, "deliverable"));
    requireSafe(
      sha256Hex(other) === (challenge ? job.fakes_hash : job.deliverable_hash),
    );
    if (challenge) await writePrivate(path(request.job_id, "check"), check);
    const name = profile(
      job,
      request.job_id,
      challenge ? "Challenge" : "Verify",
    );
    const stored = await wallet(async () => {
      const fresh = await deps.getJob(request.job_id);
      requireSafe(
        fresh &&
          (challenge
            ? ["Draft", "Challenging"]
            : ["Delivered", "Verifying"]
          ).includes(fresh.state),
      );
      return deps.storeSecret(job.verifier_hash, name, {
        PROVEN_CHECK: check,
        [challenge ? "PROVEN_REFERENCE" : "PROVEN_DELIVERABLE"]: other,
      });
    });
    pinned.add(`${request.job_id}:${challenge ? "Challenge" : "Verify"}`);
    return {
      profile: name,
      transaction_hash: stored.transactionHash,
      ciphertext_bytes: stored.ciphertextBytes,
      check_hash: job.spec_hash,
      [challenge ? "reference_hash" : "deliverable_hash"]: sha256Hex(other),
    };
  }

  return async (value) => {
    if (
      object(value) &&
      value.action === "demo_status" &&
      Object.keys(value).length === 1
    )
      return { ok: true, result: { ...sponsor.status(), escrow: deps.escrow } };
    let session: string | undefined;
    if (deps.demoCompute) {
      if (!object(value) || value.session_id !== sponsor.status().session_id)
        return refused();
      session = value.session_id as string;
      const { session_id: _session, ...payload } = value;
      value = payload;
    }
    if (
      object(value) &&
      value.action === "register_demo" &&
      Object.keys(value).length === 2 &&
      "job_ids" in value
    ) {
      try {
        await sponsor.register(value.job_ids, session ?? "");
        return { ok: true, result: sponsor.status() };
      } catch {
        return refused();
      }
    }
    let request: Request | DemoRequest;
    try {
      request = parseRequest(value);
      requireSafe(
        !deps.demoCompute || sponsor.status().jobs.includes(request.job_id),
      );
    } catch {
      return refused();
    }
    const previous = queues.get(request.job_id) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => perform(request, session));
    queues.set(request.job_id, pending);
    try {
      return { ok: true, result: await pending };
    } catch {
      return refused();
    } finally {
      if (queues.get(request.job_id) === pending) queues.delete(request.job_id);
    }
  };
}

function connection(
  socket: Socket,
  handle: (value: unknown) => Promise<HandoffReply>,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let complete = false;
  socket.setTimeout(120_000, () => socket.destroy());
  socket.on("error", () => undefined);
  const respond = (reply: HandoffReply) => {
    if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
  };
  const finish = async () => {
    if (complete) return;
    complete = true;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      respond(await handle(JSON.parse(text)));
    } catch {
      respond(refused());
    }
  };
  socket.on("data", (chunk: Buffer) => {
    if (complete) return;
    bytes += chunk.length;
    if (bytes > MAX_HANDOFF_BYTES) {
      complete = true;
      respond(refused());
      return;
    }
    const newline = chunk.indexOf(10);
    if (newline !== -1) {
      if (
        chunk
          .subarray(newline + 1)
          .some(
            (byte) => byte !== 13 && byte !== 10 && byte !== 32 && byte !== 9,
          )
      ) {
        complete = true;
        respond(refused());
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      void finish();
    } else {
      chunks.push(chunk);
    }
  });
  socket.on("end", () => {
    void finish();
  });
}

export async function startHandoffServer(
  deps: HandoffDependencies,
  socketPath = DEFAULT_SOCKET,
): Promise<Server> {
  requireSafe(isAbsolute(socketPath));
  const directory = dirname(socketPath);
  await privateDirectory(directory);
  try {
    await lstat(socketPath);
    throw new Refused();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await createHandoffHandler(deps, directory);
  void sweepDeliveries(deps, directory);
  setInterval(
    () => void sweepDeliveries(deps, directory),
    SWEEP_EVERY_MS,
  ).unref();
  const server = createServer({ allowHalfOpen: true }, (socket) =>
    connection(socket, handle),
  );
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  try {
    await chmod(socketPath, 0o600);
    const info = await lstat(socketPath);
    requireSafe(
      info.isSocket() && info.uid === UID && (info.mode & 0o777) === 0o600,
    );
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  requireSafe(
    args.length === 0 || (args.length === 1 && args[0] === "--demo-compute"),
  );
  const [{ loadConfig, TESTNET_RPC_URLS }, near, secret] = await Promise.all([
    import("./config.ts"),
    import("./near.ts"),
    import("./secret.ts"),
  ]);
  const config = loadConfig();
  const onTestnet =
    process.env.NEAR_NETWORK === "testnet" &&
    config.escrowContract.endsWith(".testnet") &&
    config.outlayerContract === "outlayer.testnet" &&
    config.outlayerApi === "https://testnet-api.outlayer.ai" &&
    TESTNET_RPC_URLS.includes(config.rpcUrl) &&
    TESTNET_RPC_URLS.includes(config.broadcastRpcUrl ?? config.rpcUrl);
  const onMainnet =
    process.env.NEAR_NETWORK === "mainnet" &&
    process.env.PROVEN_STAGE2_APPROVED === "yes" &&
    config.escrowContract.endsWith(".near") &&
    config.outlayerContract === "outlayer.near" &&
    config.outlayerApi === "https://api.outlayer.ai" &&
    args[0] !== "--demo-compute";
  if (!onTestnet && !onMainnet) throw new Refused();
  let timing: TimingSink | undefined;
  if (args[0] === "--demo-compute") {
    const directory = dirname(DEFAULT_SOCKET);
    await privateDirectory(directory);
    const path = join(directory, `demo-timing-${randomUUID()}.json`);
    const events: TimingEvent[] = [];
    let recording = Promise.resolve();
    timing = async (event) => {
      events.push(event);
      recording = recording.then(() =>
        writePrivate(path, JSON.stringify(events)),
      );
      await recording;
    };
    process.stderr.write(`Private timing evidence: ${path}\n`);
  }
  const account = near.relayAccount(config, !!timing);
  const secretJournal = (
    profile: string,
    operation: string,
  ): SecretJournal | undefined =>
    timing
      ? async (transaction_hash, submission) => {
          await writePrivate(
            join(
              dirname(DEFAULT_SOCKET),
              `secret-submission-${randomUUID()}.json`,
            ),
            JSON.stringify({
              profile,
              operation,
              transaction_hash,
              submission,
            }),
          );
        }
      : undefined;
  let demoCompute: HandoffDependencies["demoCompute"];
  let signingSuspended = false;
  async function signing<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      signingSuspended = true;
      throw error;
    }
  }
  if (args[0] === "--demo-compute") {
    const buyer = process.env.PROVEN_BUYER_ACCOUNT_ID;
    const workers = [
      process.env.PROVEN_HONEST_ACCOUNT_ID,
      process.env.PROVEN_FAKE_ACCOUNT_ID,
    ];
    requireSafe(
      buyer && workers.every((id) => id && /^[a-z0-9._-]{2,64}$/.test(id)),
    );
    const balance = await account.provider.viewAccount({
      accountId: account.accountId,
      blockQuery: { finality: "final" },
    });
    requireSafe(balance.amount >= 500000000000000000000000n);
    const example = fileURLToPath(
      new URL("../../examples/data-job/", import.meta.url),
    );
    const check = await readFile(join(example, "check-strong.json"), "utf8");
    const reference = await readFile(join(example, "reference.json"), "utf8");
    const parsed: unknown = JSON.parse(check);
    requireSafe(object(parsed) && isHash(parsed.verifier));
    demoCompute = {
      buyer,
      workers: workers as string[],
      specHash: sha256Hex(check),
      referenceHash: sha256Hex(reference),
      verifierHash: parsed.verifier,
      trigger: (id, kind, beforeBroadcast) =>
        near.submitDemoRun(
          account,
          config,
          id,
          kind,
          beforeBroadcast,
          () => {
            signingSuspended = true;
          },
          timing,
        ),
    };
  }
  await startHandoffServer({
    accountId: account.accountId,
    escrow: config.escrowContract,
    getJob: (jobId) => near.readJob(account, config, jobId, timing),
    isAccessKey: (accountId, publicKey) =>
      near.isAccessKey(account, accountId, publicKey),
    storeSecret: (hash, name, variables) =>
      signing(() =>
        secret.storeSecret(
          account,
          config,
          hash,
          name,
          variables,
          timing,
          secretJournal(name, "store"),
        ),
      ),
    deleteSecret: (hash, name) =>
      signing(() =>
        secret.deleteSecret(
          account,
          config,
          hash,
          name,
          timing,
          secretJournal(name, "delete"),
        ),
      ),
    demoCompute,
    isSigningSuspended: () => signingSuspended,
  });
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  });
}
