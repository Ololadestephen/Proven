// One hosted runner per data directory. A crash keeps the lock until an operator reconciles it.
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PublicError } from "../errors.ts";

interface HostedDataNetwork {
  network: "mainnet" | "testnet";
  config: { escrow: string };
  board: string;
  treasury: string;
}

function privateDirectory(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new PublicError(
      "Hosted data must be a real owner-only directory, not a symlink.",
    );
}

/** Existing records must already identify their network. Never adopt unknown state by guessing. */
export function bindHostedData(
  root: string,
  settings: HostedDataNetwork,
): void {
  privateDirectory(root);
  const path = join(root, ".network.json");
  const expected = {
    network: settings.network,
    escrow: settings.config.escrow,
    board: settings.board,
    treasury: settings.treasury,
  };
  const refusal =
    "The hosted data network manifest is missing, invalid or does not match this service. Reconcile the directory before starting.";
  let exists: boolean;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 2048 || (stat.mode & 0o077) !== 0)
      throw new PublicError(refusal);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new PublicError(refusal);
    exists = false;
  }
  if (!exists) {
    if (readdirSync(root).some((name) => name !== ".service.lock"))
      throw new PublicError(refusal);
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch {
      // No signer has been constructed. A competing initialization requires a fresh start/read.
      throw new PublicError(refusal);
    }
    try {
      writeFileSync(fd, JSON.stringify(expected) + "\n");
      fsyncSync(fd);
    } catch {
      throw new PublicError(refusal);
    } finally {
      closeSync(fd);
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2048) throw new Error(refusal);
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(refusal);
    const actual = value as Record<string, unknown>;
    if (
      Object.keys(actual).length !== 4 ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)
    )
      throw new Error(refusal);
  } catch {
    throw new PublicError(refusal);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function occupiedLock(path: string, probe: (pid: number) => void): never {
  const message =
    "Hosted service lock is unreadable or invalid. Reconcile it before restarting.";
  let pid: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 128) throw new Error(message);
    const text = readFileSync(path, "utf8");
    if (!/^[1-9]\d{0,9}\n$/.test(text)) throw new Error(message);
    pid = Number(text.trim());
    if (!Number.isSafeInteger(pid) || pid > 2147483647)
      throw new Error(message);
  } catch {
    throw new PublicError(message);
  }
  try {
    probe(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH")
      throw new PublicError(
        `Hosted service process ${pid} is no longer running. Reconcile its transactions and spending, then remove the stale lock manually.`,
      );
    throw new PublicError(
      "The existing hosted process cannot be checked. Keep its lock and reconcile before restarting.",
    );
  }
  throw new PublicError(
    `Hosted service process ${pid} already owns this data directory.`,
  );
}

export function acquireHostedLock(
  root: string,
  probe: (pid: number) => void = (pid) => process.kill(pid, 0),
): () => void {
  privateDirectory(root);
  const path = join(root, ".service.lock");
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return occupiedLock(path, probe);
    throw new PublicError("The hosted service lock could not be created.");
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
  } catch {
    closeSync(fd);
    // Keep an uncertain lock in place; do not proceed after a persistence failure.
    throw new PublicError(
      "The hosted service lock could not be saved. Reconcile before restarting.",
    );
  }
  const owned = fstatSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = lstatSync(path);
      if (current.dev === owned.dev && current.ino === owned.ino)
        unlinkSync(path);
    } catch {
      // An inaccessible or replaced lock stays closed to future starts.
    } finally {
      closeSync(fd);
    }
  };
}
