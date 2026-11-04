import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import test from "node:test";
import {
  createHandoffHandler,
  MAX_HANDOFF_BYTES,
  startHandoffServer,
} from "./handoff.ts";
import type { HandoffDependencies, HandoffReply } from "./handoff.ts";
import { sha256Hex } from "./hash.ts";

const verifier = "a".repeat(64);
const check = JSON.stringify({ verifier, private_rules: "PRIVATE_CHECK" });
const reference = '{"private":"PRIVATE_REFERENCE"}';
const deliverable = '{"private":"PRIVATE_DELIVERY"}';

async function fixture() {
  const directory = await mkdtemp("/private/tmp/proven-handoff-");
  const job = {
    state: "Draft",
    spec_hash: sha256Hex(check),
    fakes_hash: sha256Hex(reference),
    verifier_hash: verifier,
    secrets_owner: "relay.testnet",
    deliverable_hash: sha256Hex(deliverable),
    challenge_request_id: null as string | null,
    verdict_request_id: null as string | null,
    run_started_at: null as string | null,
  };
  const stores: {
    hash: string;
    profile: string;
    variables: Record<string, string>;
  }[] = [];
  const deletions: string[] = [];
  const deps: HandoffDependencies = {
    accountId: "relay.testnet",
    escrow: "escrow.testnet",
    getJob: async () => job,
    storeSecret: async (hash, profile, variables) => {
      stores.push({ hash, profile, variables });
      return { transactionHash: "pinned", ciphertextBytes: 256 };
    },
    deleteSecret: async (_hash, profile) => {
      deletions.push(profile);
      return "deleted";
    },
  };
  const records = join(directory, `jobs-${sha256Hex(deps.escrow)}`);
  return {
    directory,
    job,
    stores,
    deletions,
    deps,
    records,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
const challenge = (job_id = 1) => ({
  action: "challenge",
  job_id,
  check,
  reference,
});
const delivery = (job_id = 1) => ({ action: "deliver", job_id, deliverable });
const pin = (job_id = 1) => ({ action: "pin_verification", job_id });
const cleanup = (kind: "Challenge" | "Verify" = "Challenge") => ({
  action: "cleanup",
  job_id: 1,
  kind,
});

function publicOnly(reply: HandoffReply) {
  for (const secret of [
    "PRIVATE_CHECK",
    "PRIVATE_REFERENCE",
    "PRIVATE_DELIVERY",
    "PRIVATE_EXCEPTION",
  ]) {
    assert.equal(JSON.stringify(reply).includes(secret), false);
  }
}

test("challenge pins only hash-matched private inputs and writes owner-only local state", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    const reply = await handle(challenge());
    assert.equal(reply.ok, true);
    publicOnly(reply);
    assert.deepEqual(f.stores, [
      {
        hash: verifier,
        profile: `c1-${sha256Hex(reference).slice(0, 12)}`,
        variables: { PROVEN_CHECK: check, PROVEN_REFERENCE: reference },
      },
    ]);
    assert.equal((await lstat(f.records)).mode & 0o777, 0o700);
    const file = join(f.records, "1.check.json");
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { text: check });
    assert.deepEqual(await readdir(f.records), ["1.check.json"]);
  } finally {
    await f.cleanup();
  }
});

test("mismatched hashes, verifier builds, owners, and states cannot pin", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    for (const request of [
      { ...challenge(), check: "PRIVATE_CHECK wrong" },
      { ...challenge(), reference: "wrong" },
    ]) {
      const reply = await handle(request);
      assert.equal(reply.ok, false);
      publicOnly(reply);
    }
    f.job.verifier_hash = "b".repeat(64);
    assert.equal((await handle(challenge())).ok, false);
    f.job.verifier_hash = verifier;
    f.job.secrets_owner = "other.testnet";
    assert.equal((await handle(challenge())).ok, false);
    f.job.secrets_owner = f.deps.accountId;
    f.job.state = "Funded";
    assert.equal((await handle(challenge())).ok, false);
    assert.equal(f.stores.length, 0);
    assert.deepEqual(await readdir(f.records), []);
  } finally {
    await f.cleanup();
  }
});

test("delivery never opens the saved check and verification rechecks both saved hashes", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    const target = join(f.directory, "never-read");
    await writeFile(target, "PRIVATE_CHECK", { mode: 0o600 });
    await symlink(target, join(f.records, "1.check.json"));
    f.job.state = "Delivered";
    assert.equal((await handle(delivery())).ok, true);
    assert.equal(f.stores.length, 0);
    assert.equal((await handle(pin())).ok, false);
    await rm(join(f.records, "1.check.json"));
    f.job.state = "Draft";
    await handle(challenge());
    f.job.state = "Verifying";
    const reply = await handle(pin());
    assert.equal(reply.ok, true);
    publicOnly(reply);
    assert.deepEqual(f.stores[1]?.variables, {
      PROVEN_CHECK: check,
      PROVEN_DELIVERABLE: deliverable,
    });
    await writeFile(
      join(f.records, "1.deliverable.json"),
      JSON.stringify({ text: "tampered" }),
      { mode: 0o600 },
    );
    assert.equal((await handle(pin())).ok, false);
    assert.equal(f.stores.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("delivery rejects the wrong state and wrong delivery hash without storing anything", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    assert.equal((await handle(delivery())).ok, false);
    f.job.state = "Delivered";
    assert.equal(
      (await handle({ ...delivery(), deliverable: "PRIVATE_DELIVERY wrong" }))
        .ok,
      false,
    );
    assert.deepEqual(await readdir(f.records), []);
  } finally {
    await f.cleanup();
  }
});

test("exact request keys, safe job ids, and byte bounds are enforced", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    for (const value of [
      null,
      [],
      {},
      { ...challenge(), actor: "owner" },
      { ...challenge(), job_id: -1 },
      { ...challenge(), job_id: 0.5 },
      { ...challenge(), job_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...challenge(), reference: 1 },
      { action: "toString", job_id: 1 },
      { ...cleanup(), kind: "anything" },
      { ...challenge(), check: "é".repeat(MAX_HANDOFF_BYTES) },
    ]) {
      const reply = await handle(value);
      assert.equal(reply.ok, false);
      publicOnly(reply);
    }
    assert.equal(f.stores.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("cleanup refuses pending runs and keeps checks between challenge and verification", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    await handle(challenge());
    assert.equal((await handle(cleanup())).ok, false);
    f.job.challenge_request_id = "12";
    for (const state of ["Challenging", "Verifying"]) {
      f.job.state = state;
      assert.equal((await handle(cleanup())).ok, false);
    }
    f.job.state = "Challenged";
    f.job.run_started_at = "123";
    assert.equal((await handle(cleanup())).ok, false);
    f.job.run_started_at = null;
    assert.equal((await handle(cleanup())).ok, true);
    assert.equal((await lstat(join(f.records, "1.check.json"))).isFile(), true);
    f.job.state = "Delivered";
    await handle(delivery());
    assert.equal((await handle(pin())).ok, true);
    f.job.state = "Released";
    assert.equal((await handle(cleanup("Verify"))).ok, true);
    assert.deepEqual(await readdir(f.records), []);
    assert.equal(f.deletions.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("missing jobs and private service exceptions produce the same fixed refusal", async () => {
  const f = await fixture();
  try {
    let handle = await createHandoffHandler(
      { ...f.deps, getJob: async () => null },
      f.directory,
    );
    const missing = await handle(cleanup());
    assert.equal(missing.ok, false);
    handle = await createHandoffHandler(
      {
        ...f.deps,
        storeSecret: async () => {
          throw new Error("PRIVATE_EXCEPTION");
        },
      },
      f.directory,
    );
    const failed = await handle(challenge());
    assert.deepEqual(failed, missing);
    publicOnly(failed);
  } finally {
    await f.cleanup();
  }
});

test("symlink files, unsafe file modes, unsafe directories, and symlink directories are refused", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    const outside = join(f.directory, "outside");
    await writeFile(outside, "untouched", { mode: 0o600 });
    await symlink(outside, join(f.records, "1.check.json"));
    assert.equal((await handle(challenge())).ok, false);
    assert.equal(await readFile(outside, "utf8"), "untouched");
    await rm(join(f.records, "1.check.json"));
    await handle(challenge());
    await chmod(join(f.records, "1.check.json"), 0o644);
    f.job.state = "Delivered";
    await handle(delivery());
    assert.equal((await handle(pin())).ok, false);
    const unsafe = join(f.directory, "unsafe");
    await mkdir(unsafe, { mode: 0o755 });
    await assert.rejects(createHandoffHandler(f.deps, unsafe));
    await symlink(f.records, join(f.directory, "link"));
    await assert.rejects(
      createHandoffHandler(f.deps, join(f.directory, "link")),
    );
  } finally {
    await f.cleanup();
  }
});

test("operations serialize per job while separate jobs can proceed", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: number[] = [];
    let first = true;
    const handle = await createHandoffHandler(
      {
        ...f.deps,
        getJob: async (id) => {
          seen.push(id);
          if (id === 1 && first) {
            first = false;
            await gate;
          }
          return f.job;
        },
      },
      f.directory,
    );
    f.job.state = "Delivered";
    const a = handle(delivery(1));
    const b = handle(delivery(1));
    assert.equal((await handle(delivery(2))).ok, true);
    assert.deepEqual(seen, [1, 2]);
    release();
    assert.equal((await a).ok, true);
    assert.equal((await b).ok, true);
    assert.deepEqual(seen, [1, 2, 1]);
  } finally {
    await f.cleanup();
  }
});

function exchange(
  path: string,
  input: Uint8Array | string,
): Promise<HandoffReply> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path);
    let text = "";
    client.setTimeout(5000, () => client.destroy(new Error("test timeout")));
    client.on("connect", () => client.end(input));
    client.on("data", (chunk) => {
      text += chunk.toString();
    });
    client.on("error", reject);
    client.on("end", () => {
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}
const close = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

test("real Unix socket supports asynchronous responses after the client half-closes", async () => {
  const f = await fixture();
  let server: Server | undefined;
  try {
    const path = join(f.directory, "relay.sock");
    server = await startHandoffServer(
      {
        ...f.deps,
        getJob: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return f.job;
        },
      },
      path,
    );
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await exchange(path, JSON.stringify(challenge()))).ok, true);
    publicOnly(await exchange(path, `${JSON.stringify(challenge())}\n`));
    await assert.rejects(startHandoffServer(f.deps, path));
    assert.equal(
      (await exchange(path, `${JSON.stringify(challenge())}\n`)).ok,
      true,
    );
  } finally {
    if (server) await close(server);
    await f.cleanup();
  }
});

test("Unix framing rejects malformed, invalid UTF-8, oversized, and multiple requests", async () => {
  const f = await fixture();
  let server: Server | undefined;
  try {
    const path = join(f.directory, "relay.sock");
    server = await startHandoffServer(f.deps, path);
    for (const input of [
      '{"PRIVATE_CHECK":',
      Buffer.from([0xff]),
      Buffer.alloc(MAX_HANDOFF_BYTES + 1, 120),
      `${JSON.stringify(challenge())}\n${JSON.stringify(challenge())}\n`,
    ]) {
      const reply = await exchange(path, input);
      assert.equal(reply.ok, false);
      publicOnly(reply);
    }
    assert.equal(f.stores.length, 0);
  } finally {
    if (server) await close(server);
    await f.cleanup();
  }
});
