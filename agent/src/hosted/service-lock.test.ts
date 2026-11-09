import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostedLock, bindHostedData } from "./service-lock.ts";

test("one service owns a data directory until its lock is released", () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-lock-"));
  try {
    const release = acquireHostedLock(root);
    assert.throws(() => acquireHostedLock(root), /already owns/);
    release();
    release();
    const next = acquireHostedLock(root);
    next();
    assert.equal(existsSync(join(root, ".service.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale or uncheckable locks require reconciliation and are never automatically removed", () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-lock-"));
  try {
    const path = join(root, ".service.lock");
    writeFileSync(path, "1234\n");
    for (const code of ["ESRCH", "EPERM", "EIO"])
      assert.throws(
        () =>
          acquireHostedLock(root, () => {
            throw Object.assign(new Error("probe"), { code });
          }),
        /reconcile|Reconcile/,
      );
    assert.equal(readFileSync(path, "utf8"), "1234\n");
    writeFileSync(path, "damaged");
    assert.throws(() => acquireHostedLock(root), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release never removes a replacement lock and a symlink cannot stand in for a lock", () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-lock-"));
  try {
    const path = join(root, ".service.lock");
    const release = acquireHostedLock(root);
    rmSync(path);
    const other = join(root, "replacement");
    writeFileSync(other, "1234\n");
    symlinkSync(other, path);
    release();
    assert.equal(existsSync(path), true);
    assert.throws(() => acquireHostedLock(root), /invalid/);
    assert.equal(readFileSync(other, "utf8"), "1234\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const settings = {
  network: "testnet" as const,
  config: { escrow: "escrow-v5.proven.testnet" },
  board: "board-v4.proven.testnet",
  treasury: "treasury.proven.testnet",
};

test("an empty locked directory is bound once and matching restarts preserve its manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-network-"));
  try {
    const release = acquireHostedLock(root);
    bindHostedData(root, settings);
    const path = join(root, ".network.json");
    const before = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(before), {
      network: "testnet",
      escrow: settings.config.escrow,
      board: settings.board,
      treasury: settings.treasury,
    });
    bindHostedData(root, settings);
    assert.equal(readFileSync(path, "utf8"), before);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("network, contracts and treasury mismatches cannot adopt an existing manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-network-"));
  try {
    bindHostedData(root, settings);
    const before = readFileSync(join(root, ".network.json"), "utf8");
    for (const over of [
      { network: "mainnet" as const },
      { config: { escrow: "other.proven.testnet" } },
      { board: "other.proven.testnet" },
      { treasury: "other.proven.testnet" },
    ])
      assert.throws(
        () => bindHostedData(root, { ...settings, ...over }),
        /network manifest/,
      );
    assert.equal(readFileSync(join(root, ".network.json"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nonempty unbound, corrupt and symlinked data are refused without adopting or following them", () => {
  const root = mkdtempSync(join(tmpdir(), "proven-hosted-network-"));
  try {
    const record = join(root, "existing-record.json");
    writeFileSync(record, "existing");
    assert.throws(() => bindHostedData(root, settings), /network manifest/);
    assert.equal(existsSync(join(root, ".network.json")), false);
    const manifest = join(root, ".network.json");
    writeFileSync(manifest, "corrupt", { mode: 0o600 });
    assert.throws(() => bindHostedData(root, settings), /network manifest/);
    rmSync(manifest);
    symlinkSync(record, manifest);
    assert.throws(() => bindHostedData(root, settings), /network manifest/);
    assert.equal(readFileSync(record, "utf8"), "existing");
    chmodSync(root, 0o770);
    assert.throws(() => acquireHostedLock(root), /owner-only directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
