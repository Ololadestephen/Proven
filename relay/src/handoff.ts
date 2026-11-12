// Private local transport only. The relay pins texts; it cannot decide a verdict.
import {
  boardBehind,
  nextNudge,
  createStorageFinisher,
  type KeptBid,
  type KeptJob,
} from "./keeper.ts";
import {
  configuredBoard,
  legacyAccess,
  readBoardAccess,
} from "./market-access.ts";
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
import { relayPayload, RelayVerifier, type RelayAuth } from "./buyer-auth.ts";
import {
  JsonInputError,
  parseJson,
  parseJsonObject,
  verifierFromCheck,
} from "./json.ts";
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
  worker?: string | null;
  token?: string | null;
  amount?: string;
  compute_budget?: string;
  deadline?: string;
  delivered_at?: string | null;
  verdict_window_secs?: number;
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
  /** Set while the market is limited: only these buyers can start a job. Unset, anyone can. Nothing else
   * depends on it, so a job already running can always finish. */
  allowedBuyers?: Set<string>;
  /** Re-read the board before each new challenge; an RPC failure never opens the market. */
  getAllowedBuyers?: () => Promise<Set<string> | undefined>;
  /** The bid a check belongs to, for publishing a check once its bid has ended. */
  getBid?(bidId: number): Promise<RevealBid | null>;
  /** On for a relay reachable from the internet: every action needs the right account's signature. */
  requireSignatures?: boolean;
  demoCompute?: DemoCompute;
  isSigningSuspended?: () => boolean;
  /** Checks a signed transaction whose outcome was unknown, and resumes signing once it is settled. */
  reconcile?: () => Promise<void>;
  /** Starts a run the escrow pays for from the job's budget. Set where the relay drives jobs itself. */
  trigger?(jobId: number, kind: RunKind): Promise<string>;
  /** Moves a job on once the chain allows it: pays out, expires, returns budget, syncs the board. */
  keep?(jobId: number, job: HandoffJob): Promise<void>;
  /** Returns unused storage of bids and jobs that have ended. Anyone may; nothing is decided. */
  finish?(): Promise<void>;
}

/** Re-read permission at the signing point, including keeper retries of pinned Draft jobs. */
export async function triggerHandoffRun(
  deps: Pick<HandoffDependencies, "allowedBuyers" | "getAllowedBuyers"> & {
    trigger: NonNullable<HandoffDependencies["trigger"]>;
  },
  jobId: number,
  job: Pick<HandoffJob, "buyer">,
  kind: RunKind,
): Promise<string> {
  if (kind === "Challenge") await requireChallengeAccess(deps, job);
  return deps.trigger(jobId, kind);
}

async function requireChallengeAccess(
  deps: Pick<HandoffDependencies, "allowedBuyers" | "getAllowedBuyers">,
  job: Pick<HandoffJob, "buyer">,
): Promise<void> {
  const allowed = deps.getAllowedBuyers
    ? await deps.getAllowedBuyers()
    : deps.allowedBuyers;
  if (allowed)
    requireSafe(typeof job.buyer === "string" && allowed.has(job.buyer));
}

interface PinRecord {
  verifier_hash: string;
  profile: string;
  buyer: string;
  at: number;
  stored: boolean;
}

function parsePinRecord(text: string): PinRecord {
  const record = parseJsonObject(text, "Private pin record");
  if (
    !isHash(record.verifier_hash) ||
    typeof record.profile !== "string" ||
    !/^[cv]\d+-[a-f0-9]{12}$/.test(record.profile) ||
    typeof record.buyer !== "string" ||
    !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(record.buyer) ||
    !Number.isSafeInteger(record.at) ||
    (record.at as number) < 0 ||
    typeof record.stored !== "boolean"
  )
    throw new JsonInputError(
      "Private pin record has invalid fields. No signing was allowed.",
    );
  return record as unknown as PinRecord;
}

export function suspendedTransaction(text: string): {
  hash: string;
  at: number;
} {
  const record = parseJsonObject(text, "Suspended transaction record");
  if (
    typeof record.hash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.hash) ||
    !Number.isSafeInteger(record.at) ||
    (record.at as number) < 0
  )
    throw new JsonInputError(
      "Suspended transaction record has invalid fields. Signing remains paused.",
    );
  return { hash: record.hash, at: record.at as number };
}

/** What the reveal rule reads about a bid. */
export interface RevealBid {
  check_hash: string;
  state: string;
  expires_at: string;
  claim: { job_id: number | null } | null;
}

/** A bid's check becomes public when the bid has ended, or has expired with nothing in progress. */
export function revealAllowed(bid: RevealBid, nowNanos: bigint): boolean {
  if (["Done", "Closed", "Cancelled"].includes(bid.state)) return true;
  return nowNanos >= BigInt(bid.expires_at) && bid.claim?.job_id == null;
}

type Request =
  | { action: "challenge"; job_id: number; check: string; reference: string }
  | { action: "deliver"; job_id: number; deliverable: string }
  | { action: "pin_verification"; job_id: number }
  | { action: "cleanup"; job_id: number; kind: RunKind }
  | { action: "collect"; job_id: number };
type DemoRequest = { action: "trigger"; job_id: number; kind: RunKind };
export type HandoffReply =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string };
const refused = (): HandoffReply => ({ ok: false, error: FAILURE });

class Refused extends Error {}
function requireSafe(condition: unknown): asserts condition {
  if (!condition) throw new Refused();
}
/** A folder's names. Only a folder that does not exist yet is empty; a read failure is thrown. */
async function listOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
/** A short, text-free description of a failure for the keeper's log. */
const failure = (error: unknown) =>
  String(error instanceof Error ? error.message : "request failed").slice(
    0,
    200,
  );
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
    collect: ["action", "job_id"],
    trigger: ["action", "job_id", "kind"],
  };
  requireSafe(
    typeof value.action === "string" && Object.hasOwn(fields, value.action),
  );
  const allowed = fields[value.action]!;
  const named = Object.keys(value).filter((key) => key !== "auth");
  requireSafe(
    named.length === allowed.length &&
      named.every((key) => allowed.includes(key)),
  );
  if (value.action === "challenge")
    requireSafe(
      typeof value.check === "string" && typeof value.reference === "string",
    );
  if (value.action === "deliver")
    requireSafe(typeof value.deliverable === "string");
  if (value.auth !== undefined) {
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
    const record = parseJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile()),
      "Private file record",
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
  requireSafe(verifierFromCheck(check) === job.verifier_hash);
}
function profile(job: HandoffJob, jobId: number, kind: RunKind): string {
  return kind === "Challenge"
    ? `c${jobId}-${job.fakes_hash.slice(0, 12)}`
    : `v${jobId}-${job.deliverable_hash!.slice(0, 12)}`;
}

/** Paid work is kept this long after delivery for the buyer to collect, then deleted. */
export const COLLECT_RETENTION_MS = 30 * 24 * 3_600_000;
const SWEEP_EVERY_MS = 300_000;
/** Each pin locks a deposit of the relay's, so a pin nobody ran is given back after this long. */
const PIN_MAX_AGE_MS = 3_600_000;
/** For a relay reachable from the internet: limits on what one account or job can make it sign. */
const MAX_CHALLENGE_BYTES = 64 * 1024;
const MAX_OPEN_PINS_PER_BUYER = 5;
const MAX_SIGNINGS_PER_JOB_PER_DAY = 8;

/** A check that a job was run against, kept to publish when its bid ends. Named by its own hash, so what
 * comes back can be checked by anyone. */
async function keepForReveal(directory: string, text: string): Promise<void> {
  const dir = join(directory, "reveal");
  await privateDirectory(dir);
  await writePrivate(join(dir, `${sha256Hex(text)}.json`), text);
}

/** Deletes refunded, expired and cancelled work, paid work past retention, and every private check
 * once its job has ended. A failed read deletes nothing. Returns the deleted deliverables' job ids. */
export async function sweepDeliveries(
  deps: Pick<HandoffDependencies, "getJob" | "escrow">,
  directory: string,
  now = Date.now(),
): Promise<number[]> {
  const records = join(directory, `jobs-${sha256Hex(deps.escrow)}`);
  const deleted: number[] = [];
  const names = await listOrEmpty(records);
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
        ) {
          // A job that reached a worker keeps its check for the reveal. One never run has no one to answer to.
          if (job?.challenge_request_id != null)
            await keepForReveal(directory, await readPrivate(file));
          await unlink(file);
        }
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

/** Moves on every job this relay holds texts for, where the chain allows it. Never decides anything:
 * each step is one anyone could take, and the escrow refuses it if it is not due. */
export async function keepJobs(
  deps: Pick<HandoffDependencies, "getJob" | "escrow" | "keep">,
  directory: string,
): Promise<number[]> {
  if (!deps.keep) return [];
  const records = join(directory, `jobs-${sha256Hex(deps.escrow)}`);
  const ids = new Set<number>();
  for (const name of await listOrEmpty(records)) {
    const parts = /^(\d+)\.(deliverable|check)\.json$/.exec(name);
    if (parts) ids.add(Number(parts[1]));
  }
  const kept: number[] = [];
  for (const jobId of ids) {
    try {
      const job = await deps.getJob(jobId);
      if (job) {
        await deps.keep(jobId, job);
        kept.push(jobId);
      }
    } catch {
      /* Try again on the next sweep. */
    }
  }
  return kept;
}

/** Who may ask for each action: the job's own parties, read from the chain. */
function signersFor(action: string, job: HandoffJob): string[] {
  const buyer = typeof job.buyer === "string" ? [job.buyer] : [];
  const worker = typeof job.worker === "string" ? [job.worker] : [];
  if (action === "challenge" || action === "collect") return buyer;
  if (action === "deliver") return worker;
  if (action === "pin_verification" || action === "cleanup")
    return [...buyer, ...worker];
  return [];
}

/** The chain answered no, so nothing was left unknown. */
export function isDefiniteRefusal(error: unknown): boolean {
  return /Smart contract panicked|Secret transaction failed/.test(
    String(error),
  );
}

/** Deleting a secret that is already gone has done what was asked. */
export async function deleteOnce(
  remove: () => Promise<string>,
): Promise<string> {
  try {
    return await remove();
  } catch (error) {
    if (/Secrets not found/.test(String(error))) return "already-deleted";
    throw error;
  }
}

/** Deletes each run's private texts from OutLayer once its result is recorded, so nobody has to ask or
 * sign for it. Whatever fails is simply tried again on the next sweep. */
export async function sweepSecrets(
  deps: Pick<HandoffDependencies, "getJob" | "escrow">,
  directory: string,
  handle: (value: unknown, internal?: boolean) => Promise<HandoffReply>,
  cleaned: Set<string>,
): Promise<void> {
  const records = join(directory, `jobs-${sha256Hex(deps.escrow)}`);
  const names = await listOrEmpty(records);
  for (const name of names) {
    const parts = /^(\d+)\.check\.json$/.exec(name);
    if (!parts) continue;
    const jobId = Number(parts[1]);
    try {
      const job = await deps.getJob(jobId);
      if (!job) continue;
      const kinds: RunKind[] = [];
      if (job.challenge_request_id) kinds.push("Challenge");
      if (job.verdict_request_id) kinds.push("Verify");
      for (const kind of kinds) {
        const key = `${jobId}:${kind}`;
        if (cleaned.has(key)) continue;
        const reply = await handle(
          { action: "cleanup", job_id: jobId, kind },
          true,
        );
        if (reply.ok) cleaned.add(key);
      }
    } catch {
      /* Try again on the next sweep. */
    }
  }
}

export async function createHandoffHandler(
  deps: HandoffDependencies,
  directory: string,
): Promise<(value: unknown, internal?: boolean) => Promise<HandoffReply>> {
  await privateDirectory(directory);
  const records = join(directory, `jobs-${sha256Hex(deps.escrow)}`);
  await privateDirectory(records);
  const pins = join(directory, `pins-${sha256Hex(deps.escrow)}`);
  await privateDirectory(pins);
  const pinPath = (jobId: number, kind: RunKind) =>
    join(pins, `${jobId}.${kind}.json`);
  // Counted per job and per signing key, so one party can never use up the other's allowance.
  const signings = new Map<string, { since: number; count: number }>();
  function allowSigning(
    jobId: number,
    auth: RelayAuth | undefined,
    now = Date.now(),
  ): boolean {
    const key = `${jobId}:${auth?.public_key}`;
    let entry = signings.get(key);
    if (!entry || now - entry.since > 86_400_000) {
      if (signings.size > 10_000) signings.clear();
      entry = { since: now, count: 0 };
      signings.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= MAX_SIGNINGS_PER_JOB_PER_DAY;
  }
  async function openPins(buyer: string | undefined): Promise<number> {
    let count = 0;
    for (const name of await readdir(pins)) {
      if (!name.endsWith(".json")) continue;
      // A corrupt record could conceal this buyer's locked deposit; never undercount it.
      const record = parsePinRecord(await readPrivate(join(pins, name)));
      if (record.buyer === buyer) count += 1;
    }
    return count;
  }
  const queues = new Map<number, Promise<unknown>>();
  const verifier = new RelayVerifier(deps.isAccessKey);
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
    auth?: RelayAuth,
    internal = false,
  ): Promise<Record<string, unknown>> {
    const job = await deps.getJob(request.job_id);
    requireSafe(
      job &&
        job.secrets_owner === deps.accountId &&
        isHash(job.spec_hash) &&
        isHash(job.fakes_hash) &&
        isHash(job.verifier_hash),
    );
    // The challenge's texts are proven by the job's hashes on chain, so they need no signature.
    if (
      !internal &&
      request.action !== "challenge" &&
      (deps.requireSignatures || request.action === "collect")
    ) {
      const signers = signersFor(request.action, job);
      requireSafe(
        signers.length > 0 &&
          (await verifier.verify(
            auth,
            signers,
            request.action,
            request.job_id,
            relayPayload(request as unknown as Record<string, unknown>),
          )),
      );
    }
    if (request.action === "collect") {
      // Only the job's buyer, and only once the chain shows the worker has been paid.
      requireSafe(job.state === "Released");
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
      // The relay starts verification itself, so neither side has to.
      const started = deps.trigger
        ? await perform(
            { action: "pin_verification", job_id: request.job_id },
            undefined,
            undefined,
            true,
          )
            .then(() => wallet(() => deps.trigger!(request.job_id, "Verify")))
            .then((hash) => ({ verification: hash }))
            .catch((error: unknown) => {
              // The delivery is kept either way; the keeper's sweep starts the run later.
              console.error(
                `relay: job ${request.job_id} verification did not start: ${failure(error)}`,
              );
              return {
                verification: null,
                verification_note:
                  error instanceof Refused
                    ? "Verification was refused for now. The relay's keeper tries again."
                    : "Verification did not start. The relay's keeper tries again.",
              };
            })
        : {};
      return { deliverable_hash: job.deliverable_hash, ...started };
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
      if (!internal && deps.requireSignatures)
        requireSafe(allowSigning(request.job_id, auth));
      const name = profile(job, request.job_id, request.kind);
      const transactionHash = await wallet(async () => {
        const fresh = await deps.getJob(request.job_id);
        requireSafe(
          fresh &&
            !["Challenging", "Verifying"].includes(fresh.state) &&
            fresh.run_started_at == null,
        );
        return deleteOnce(() => deps.deleteSecret(job.verifier_hash, name));
      });
      pinned.delete(`${request.job_id}:${request.kind}`);
      await unlink(pinPath(request.job_id, request.kind)).catch(
        () => undefined,
      );
      if (terminal) {
        // Paid work stays until the buyer can collect it; see sweepDeliveries for how long.
        const kinds =
          job.state === "Released"
            ? (["check"] as const)
            : (["check", "deliverable"] as const);
        for (const kind of kinds) {
          const file = path(request.job_id, kind);
          if (await safeExistingFile(file)) {
            if (kind === "check" && job.challenge_request_id != null)
              await keepForReveal(directory, await readPrivate(file));
            await unlink(file);
          }
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
    const kind: RunKind = challenge ? "Challenge" : "Verify";
    const pinFile = pinPath(request.job_id, kind);
    if (challenge) await requireChallengeAccess(deps, job);
    if (!internal && deps.requireSignatures) {
      if (challenge) {
        requireSafe(
          Buffer.byteLength(check) + Buffer.byteLength(other) <=
            MAX_CHALLENGE_BYTES,
        );
        requireSafe(
          (await safeExistingFile(pinFile)) ||
            (await openPins(job.buyer)) < MAX_OPEN_PINS_PER_BUYER,
        );
      }
    }
    // A check file is kept only once its secret is stored, but a bad path is refused before signing.
    if (challenge) await safeExistingFile(path(request.job_id, "check"));
    const name = profile(job, request.job_id, kind);
    const reply = (transactionHash: string, ciphertextBytes: number) => ({
      profile: name,
      transaction_hash: transactionHash,
      ciphertext_bytes: ciphertextBytes,
      check_hash: job.spec_hash,
      [challenge ? "reference_hash" : "deliverable_hash"]: sha256Hex(other),
    });
    const hadPin = await safeExistingFile(pinFile);
    if (!internal && deps.requireSignatures) {
      // The same texts are already pinned under this name: nothing to sign, and nothing to count.
      if (hadPin) {
        const earlier = parsePinRecord(await readPrivate(pinFile));
        if (earlier.stored === true) {
          pinned.add(`${request.job_id}:${kind}`);
          return reply("already-pinned", 0);
        }
      }
      requireSafe(allowSigning(request.job_id, auth));
    }
    const pinRecord = {
      verifier_hash: job.verifier_hash,
      profile: name,
      buyer: job.buyer,
      at: Date.now(),
    };
    // Written first, so a deposit can always be found and returned, even if the job is later cancelled.
    await writePrivate(
      pinFile,
      JSON.stringify({ ...pinRecord, stored: false }),
    );
    let stored: { transactionHash: string; ciphertextBytes: number };
    try {
      stored = await wallet(async () => {
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
    } catch (error) {
      // Refused for certain, so no deposit was locked. Anything else stays listed for the sweep.
      // A record from an earlier store stays, because that secret and its deposit are still there.
      if (!hadPin && (error instanceof Refused || isDefiniteRefusal(error)))
        await unlink(pinFile).catch(() => undefined);
      throw error;
    }
    await writePrivate(pinFile, JSON.stringify({ ...pinRecord, stored: true }));
    if (challenge) await writePrivate(path(request.job_id, "check"), check);
    pinned.add(`${request.job_id}:${kind}`);
    // The relay starts the challenge itself. A failed start is retried by the keeper's sweep.
    const run =
      challenge && deps.trigger
        ? await wallet(() =>
            triggerHandoffRun(
              { ...deps, trigger: deps.trigger! },
              request.job_id,
              job,
              "Challenge",
            ),
          ).catch((error: Error) => {
            console.error(
              `relay: challenge for job ${request.job_id} did not start: ${String(error.message).slice(0, 200)}`,
            );
            return null;
          })
        : undefined;
    return {
      ...reply(stored.transactionHash, stored.ciphertextBytes),
      ...(run === undefined ? {} : { challenge_run: run }),
    };
  }

  /** One action at a time per job, including the sweep's. */
  function inJobQueue<T>(jobId: number, action: () => Promise<T>): Promise<T> {
    const pending = (queues.get(jobId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(action);
    queues.set(jobId, pending);
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (queues.get(jobId) === pending) queues.delete(jobId);
      });
    return pending;
  }

  /** Returns the deposit of every pin whose run is over, whose job is gone, or that nobody ran in time.
   * A failed read or delete changes nothing and is tried again on the next sweep. */
  async function expirePins(now = Date.now()): Promise<void> {
    for (const name of await readdir(pins)) {
      const parts = /^(\d+)\.(Challenge|Verify)\.json$/.exec(name);
      if (!parts) continue;
      const jobId = Number(parts[1]);
      const kind = parts[2] as RunKind;
      try {
        await inJobQueue(jobId, async () => {
          const file = join(pins, name);
          const record = parsePinRecord(await readPrivate(file));
          const shouldExpire = (job: HandoffJob | null) => {
            if (!job) return true;
            if (
              ["Challenging", "Verifying"].includes(job.state) ||
              job.run_started_at != null
            )
              return false;
            if (["Released", "Refunded", "Expired"].includes(job.state))
              return true;
            if (now - record.at > PIN_MAX_AGE_MS) return true;
            // A result is on chain and the job has moved on, so this run can never need the pin.
            return kind === "Challenge"
              ? job.challenge_request_id != null && job.state !== "Draft"
              : job.verdict_request_id != null && job.state !== "Delivered";
          };
          const job = await deps.getJob(jobId);
          if (!shouldExpire(job)) return;
          await wallet(async () => {
            // Read again: the wait for the signer can outlast what was read above.
            requireSafe(shouldExpire(await deps.getJob(jobId)));
            return deleteOnce(() =>
              deps.deleteSecret(record.verifier_hash, record.profile),
            );
          });
          await unlink(file);
          pinned.delete(`${jobId}:${kind}`);
          if (!job || job.state === "Draft")
            await unlink(path(jobId, "check")).catch(() => undefined);
        });
      } catch (error) {
        // Tried again on the next sweep. A refusal is the expected "not yet", so only other causes are logged.
        if (!(error instanceof Refused))
          console.error(`keeper: pin ${name} expiry failed: ${failure(error)}`);
      }
    }
  }

  /** Anyone. Needs no signature and no cooperation from the buyer: only the chain's word that the bid ended.
   * The relay could still withhold this, and that is stated wherever reveal is described. */
  async function reveal(bidId: unknown): Promise<HandoffReply> {
    if (!deps.getBid || !Number.isSafeInteger(bidId) || (bidId as number) < 0)
      return refused();
    try {
      const bid = await deps.getBid(bidId as number);
      if (!bid || !isHash(bid.check_hash)) return refused();
      const now = BigInt(Date.now()) * 1_000_000n;
      if (!revealAllowed(bid, now))
        return {
          ok: true,
          result: { revealed: false, reason: "The bid has not ended." },
        };
      const file = join(directory, "reveal", `${bid.check_hash}.json`);
      if (!(await safeExistingFile(file)))
        return {
          ok: true,
          result: {
            revealed: false,
            reason: "No job was run against this check.",
          },
        };
      const check = await readPrivate(file);
      requireSafe(sha256Hex(check) === bid.check_hash);
      return {
        ok: true,
        result: { revealed: true, check, check_hash: bid.check_hash },
      };
    } catch {
      return refused();
    }
  }

  return async (value, internal = false) => {
    if (
      object(value) &&
      value.action === "reveal" &&
      Object.keys(value).length === 2 &&
      "bid_id" in value
    )
      return reveal(value.bid_id);
    if (internal && object(value) && value.action === "expire_pins") {
      await expirePins();
      return { ok: true, result: {} };
    }
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
    try {
      return {
        ok: true,
        result: await inJobQueue(request.job_id, () =>
          perform(
            request,
            session,
            (value as { auth?: RelayAuth }).auth,
            internal,
          ),
        ),
      };
    } catch (error) {
      // The reason stays on the operator's terminal. No private text is in these errors.
      console.error(
        `relay refused ${request.action} on job ${request.job_id}: ${String(error).slice(0, 200)}`,
      );
      return refused();
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
      respond(await handle(parseJson(text, "Handoff request")));
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
  /** Where private texts live. On a hosted server this is apart from the socket, which another service
   * reaches through a shared group. Locally the socket sits in the same owner-only folder. */
  dataDirectory?: string,
): Promise<Server> {
  requireSafe(isAbsolute(socketPath));
  const directory = dataDirectory ?? dirname(socketPath);
  const shared = dataDirectory !== undefined;
  await privateDirectory(directory);
  try {
    await lstat(socketPath);
    throw new Refused();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await createHandoffHandler(deps, directory);
  const cleaned = new Set<string>();
  // Each step runs even when an earlier one fails, and a failure is logged and retried next sweep.
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      console.error(`keeper sweep: ${name} failed: ${failure(error)}`);
    }
  };
  const sweep = async () => {
    await step("reconcile", async () => deps.reconcile?.());
    await step("keep jobs", () => keepJobs(deps, directory));
    await step("secrets", () => sweepSecrets(deps, directory, handle, cleaned));
    await step("expire pins", () => handle({ action: "expire_pins" }, true));
    await step("deliveries", () => sweepDeliveries(deps, directory));
    await step("finish storage", async () => deps.finish?.());
  };
  void sweep();
  setInterval(() => void sweep(), SWEEP_EVERY_MS).unref();
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
    const mode = shared ? 0o660 : 0o600;
    await chmod(socketPath, mode);
    const info = await lstat(socketPath);
    requireSafe(
      info.isSocket() && info.uid === UID && (info.mode & 0o777) === mode,
    );
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}

/** The one setting that opens the market. `open`, or a comma-separated list of buyers. Mainnet has no
 * default, so forgetting it leaves the market closed to everyone. */
export function marketAccess(
  setting: string | undefined,
  network = process.env.NEAR_NETWORK,
): Set<string> | undefined {
  if (setting === "open") return undefined;
  if (setting === undefined && network !== "mainnet") return undefined;
  return new Set(
    (setting ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
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
  // The transaction being sent, known only once it is signed and about to go out.
  let inFlight: string | null = null;
  const secretJournal =
    (profile: string, operation: string): SecretJournal =>
    async (transaction_hash, submission) => {
      inFlight = transaction_hash;
      if (!timing) return;
      await writePrivate(
        join(dirname(DEFAULT_SOCKET), `secret-submission-${randomUUID()}.json`),
        JSON.stringify({
          profile,
          operation,
          transaction_hash,
          submission,
        }),
      );
    };
  let demoCompute: HandoffDependencies["demoCompute"];
  // Kept on disk, so a restart cannot forget a transaction whose outcome is still unknown.
  const socketPath = process.env.PROVEN_RELAY_SOCKET ?? DEFAULT_SOCKET;
  const dataDirectory = process.env.PROVEN_RELAY_DATA;
  const suspendedFile = join(
    dataDirectory ?? dirname(socketPath),
    "signing-suspended.json",
  );
  await privateDirectory(dataDirectory ?? dirname(socketPath));
  let unknownTransaction: { hash: string; at: number } | null = null;
  if (await safeExistingFile(suspendedFile)) {
    try {
      unknownTransaction = suspendedTransaction(
        await readPrivate(suspendedFile),
      );
    } catch {
      // Unreadable: stay paused for the full lifetime of any transaction it could have named.
      console.error(
        "relay: suspended transaction record is invalid or unreadable; signing remains paused.",
      );
      unknownTransaction = { hash: "", at: Date.now() };
    }
  }
  let signingSuspended = unknownTransaction !== null;
  // The board's bids, by the job they hold, filled in as the keeper finds them.
  const board = configuredBoard(process.env.PROVEN_BOARD);
  const getAllowedBuyers = async () => {
    const access = await readBoardAccess(
      () =>
        account.provider.callFunction({
          contractId: board,
          method: "get_access",
          args: {},
        }),
      () =>
        legacyAccess(
          process.env.PROVEN_MARKET_ACCESS,
          process.env.NEAR_NETWORK,
        ),
    );
    return access.open ? undefined : new Set(access.buyers);
  };
  const bidForJob = new Map<number, number>();
  let scannedBids = 0;
  async function findBid(jobId: number): Promise<number | undefined> {
    if (!board) return undefined;
    if (!bidForJob.has(jobId)) {
      for (;;) {
        const page = (await account.provider.callFunction({
          contractId: board,
          method: "get_bids",
          args: { from_id: scannedBids, limit: 50 },
        })) as Array<[number, { job_id: number | null }]>;
        for (const [id, bid] of page)
          if (bid.job_id !== null) bidForJob.set(bid.job_id, id);
        if (page.length < 50) {
          scannedBids = page.length ? page[page.length - 1]![0] : scannedBids;
          break;
        }
        scannedBids = page[page.length - 1]![0] + 1;
      }
    }
    return bidForJob.get(jobId);
  }
  async function keepOne(jobId: number, job: KeptJob | null) {
    if (!job) return;
    const records = join(
      dataDirectory ?? dirname(socketPath),
      `jobs-${sha256Hex(config.escrowContract)}`,
    );
    const has = (kind: string) =>
      lstat(join(records, `${jobId}.${kind}.json`)).then(
        () => true,
        () => false,
      );
    const step = nextNudge(job, BigInt(Date.now()) * 1_000_000n, {
      check: await has("check"),
      deliverable: await has("deliverable"),
    });
    // A failed step is retried next sweep, and logged so a cause like a low balance is seen.
    const failed = (what: string) => (error: Error) =>
      console.error(
        `keeper: job ${jobId} ${what} failed: ${String(error.message).slice(0, 200)}`,
      );
    if (step && "run" in step)
      await triggerHandoffRun(
        {
          getAllowedBuyers,
          trigger: (id, kind) => near.triggerRun(account, config, id, kind),
        },
        jobId,
        job,
        step.run,
      ).catch(failed(step.run));
    else if (step)
      await near
        .nudge(account, config.escrowContract, step.method, { job_id: jobId })
        .catch(failed(step.method));
    const bidId = await findBid(jobId).catch(() => undefined);
    if (bidId === undefined || !board) return;
    const bid = (await account.provider.callFunction({
      contractId: board,
      method: "get_bid",
      args: { bid_id: bidId },
    })) as KeptBid | null;
    const fresh = await near.readJob(account, config, jobId);
    if (bid && fresh && boardBehind(bid, fresh))
      await near
        .nudge(account, board, "sync", { bid_id: bidId })
        .catch(() => undefined);
  }

  const finishEnded = createStorageFinisher({
    readBids: (from, limit) =>
      board
        ? (account.provider.callFunction({
            contractId: board,
            method: "get_bids",
            args: { from_id: from, limit },
          }) as Promise<Array<[number, KeptBid]>>)
        : Promise.resolve([]),
    finishJob: (jobId) =>
      near.nudge(account, config.escrowContract, "finish_storage", {
        job_id: jobId,
      }),
    finishBid: (bidId) =>
      near.nudge(account, board, "finish_bid", { bid_id: bidId }),
    suspended: () => signingSuspended,
    report: (bidId, error) =>
      console.error(`keeper: bid ${bidId} storage: ${failure(error)}`),
  });

  async function signing<T>(call: () => Promise<T>): Promise<T> {
    inFlight = null;
    try {
      return await call();
    } catch (error) {
      // Stop signing only when something was sent and its outcome is unknown.
      if (inFlight && !isDefiniteRefusal(error)) {
        signingSuspended = true;
        unknownTransaction = { hash: inFlight, at: Date.now() };
        await writePrivate(suspendedFile, JSON.stringify(unknownTransaction));
        console.error(`relay paused signing: ${inFlight} is unknown`);
      }
      throw error;
    }
  }
  /** Resumes once the chain has settled the transaction, or once it is too old to ever be included. */
  async function reconcile(): Promise<void> {
    if (!unknownTransaction) return;
    let settled = false;
    try {
      const outcome = await account.provider.viewTransactionStatus({
        txHash: unknownTransaction.hash,
        accountId: account.accountId,
        waitUntil: "NONE",
      });
      settled = ["EXECUTED", "FINAL"].includes(outcome.final_execution_status);
    } catch {
      // A signed transaction is valid for about a day after its block, so by now it can never land.
      settled = Date.now() - unknownTransaction.at > 25 * 3_600_000;
    }
    if (!settled) return;
    await unlink(suspendedFile);
    unknownTransaction = null;
    signingSuspended = false;
    console.error("relay resumed signing");
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
    const verifierHash = verifierFromCheck(check);
    demoCompute = {
      buyer,
      workers: workers as string[],
      specHash: sha256Hex(check),
      referenceHash: sha256Hex(reference),
      verifierHash,
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
  await startHandoffServer(
    {
      accountId: account.accountId,
      escrow: config.escrowContract,
      getJob: (jobId) => near.readJob(account, config, jobId, timing),
      getBid: process.env.PROVEN_BOARD
        ? (bidId) =>
            account.provider.callFunction({
              contractId: process.env.PROVEN_BOARD!,
              method: "get_bid",
              args: { bid_id: bidId },
            }) as Promise<RevealBid | null>
        : undefined,
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
      trigger: (jobId, kind) => near.triggerRun(account, config, jobId, kind),
      keep: (jobId, job) => keepOne(jobId, job),
      finish: () => finishEnded(),
      getAllowedBuyers,
      isSigningSuspended: () => signingSuspended,
      reconcile,
      requireSignatures: process.env.PROVEN_RELAY_REQUIRE_SIGNATURES === "yes",
    },
    socketPath,
    dataDirectory,
  );
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  });
}
