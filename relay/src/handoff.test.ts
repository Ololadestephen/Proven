import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  nep413Digest,
  RELAY_RECIPIENT,
  relayMessage,
  relayPayload,
} from "./buyer-auth.ts";
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
  COLLECT_RETENTION_MS,
  createHandoffHandler,
  marketAccess,
  revealAllowed,
  deleteOnce,
  isDefiniteRefusal,
  sweepDeliveries,
  sweepSecrets,
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
    buyer: "buyer.testnet",
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
    isAccessKey: async () => false,
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
const collectRequest = (auth: Record<string, string>, job_id = 1) => ({
  action: "collect",
  job_id,
  auth,
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

test("operator sponsorship binds incoming sessions before pinning or spending", async () => {
  const f = await fixture();
  let triggers = 0;
  try {
    const original = f.job;
    f.deps.getJob = async (id) => ({
      ...original,
      buyer: "buyer.testnet",
      worker: id === 1 ? "honest.testnet" : "fake.testnet",
      amount: "10000000000000000000000",
      token: null,
    });
    f.deps.demoCompute = {
      buyer: "buyer.testnet",
      workers: ["honest.testnet", "fake.testnet"],
      specHash: sha256Hex(check),
      referenceHash: sha256Hex(reference),
      verifierHash: verifier,
      trigger: async () => {
        triggers++;
        return "1".repeat(44);
      },
    };
    const handle = await createHandoffHandler(f.deps, f.directory);
    const status = await handle({ action: "demo_status" });
    assert.ok(status.ok);
    const session = status.result.session_id;
    assert.equal(
      (
        await handle({
          action: "register_demo",
          job_ids: [1, 2],
          session_id: "old-session",
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await handle({
          action: "register_demo",
          job_ids: [1, 2],
          session_id: session,
        })
      ).ok,
      true,
    );
    assert.equal(
      (await handle({ ...challenge(), session_id: "old-session" })).ok,
      false,
    );
    assert.equal(f.stores.length, 0);
    assert.equal(
      (await handle({ ...challenge(), session_id: session })).ok,
      true,
    );
    assert.equal(
      (
        await handle({
          action: "trigger",
          job_id: 1,
          kind: "Challenge",
          session_id: "old-session",
        })
      ).ok,
      false,
    );
    assert.equal(triggers, 0);
    assert.equal(
      (
        await handle({
          action: "trigger",
          job_id: 1,
          kind: "Challenge",
          session_id: session,
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await handle({
          action: "trigger",
          job_id: 1,
          kind: "Challenge",
          session_id: session,
        })
      ).ok,
      false,
    );
    assert.equal(triggers, 1);
  } finally {
    await f.cleanup();
  }
});

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
    f.job.state = "Delivered";
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
    // Paid work stays for the buyer to collect.
    assert.deepEqual(await readdir(f.records), ["1.deliverable.json"]);
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

test("suspended operator refuses every queued signing action while public status remains readable", async () => {
  const f = await fixture();
  try {
    let suspended = false;
    f.deps.isSigningSuspended = () => suspended;
    const handle = await createHandoffHandler(f.deps, f.directory);
    suspended = true;
    const pin = await handle({
      action: "challenge",
      job_id: 1,
      check,
      reference,
    });
    assert.equal(pin.ok, false);
    assert.equal(f.stores.length, 0);
    f.job.challenge_request_id = "1";
    const cleanup = await handle({
      action: "cleanup",
      job_id: 1,
      kind: "Challenge",
    });
    assert.equal(cleanup.ok, false);
    assert.equal(f.deletions.length, 0);
    assert.equal((await handle({ action: "demo_status" })).ok, true);
  } finally {
    await f.cleanup();
  }
});

test("a deliverable goes only to its buyer, only once Released, and paid work survives cleanup", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    const pair = generateKeyPairSync("ed25519");
    const raw = pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    let value = BigInt(`0x${raw.toString("hex")}`);
    const alphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let encoded = "";
    while (value > 0n) {
      encoded = alphabet[Number(value % 58n)] + encoded;
      value /= 58n;
    }
    const signed = () => {
      const nonce = randomBytes(32);
      const message = relayMessage(
        "collect",
        1,
        relayPayload({ action: "collect" }),
        Date.now(),
      );
      return {
        public_key: `ed25519:${encoded}`,
        message,
        nonce_base64: nonce.toString("base64"),
        signature_base64: sign(
          null,
          nep413Digest(message, nonce, RELAY_RECIPIENT),
          pair.privateKey,
        ).toString("base64"),
      };
    };
    f.job.buyer = raw.toString("hex");
    f.job.state = "Delivered";
    assert.equal((await handle(delivery())).ok, true);

    for (const state of [
      "Delivered",
      "Passed",
      "Failed",
      "Refunded",
      "Expired",
    ]) {
      f.job.state = state;
      assert.equal((await handle(collectRequest(signed()))).ok, false, state);
    }
    f.job.state = "Released";
    f.job.run_started_at = null;
    assert.equal(
      (await handle(collectRequest({ ...signed(), public_key: "ed25519:1" })))
        .ok,
      false,
    );
    f.job.buyer = "someone-else.testnet";
    assert.equal(
      (await handle(collectRequest(signed()))).ok,
      false,
      "not the buyer",
    );
    f.job.buyer = raw.toString("hex");

    assert.equal((await handle(cleanup("Verify"))).ok, true);
    const reply = await handle(collectRequest(signed()));
    assert.equal(reply.ok, true);
    assert.equal(reply.ok && reply.result.deliverable, deliverable);

    // Retention, then deletion. Nothing is deleted while a job is still open.
    assert.deepEqual(await sweepDeliveries(f.deps, f.directory), []);
    assert.deepEqual(
      await sweepDeliveries(
        f.deps,
        f.directory,
        Date.now() + COLLECT_RETENTION_MS + 1000,
      ),
      [1],
    );
    assert.equal((await handle(collectRequest(signed()))).ok, false, "deleted");
  } finally {
    await f.cleanup();
  }
});

test("refunded work is deleted by cleanup and by the sweep", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    f.job.state = "Delivered";
    assert.equal((await handle(delivery())).ok, true);
    f.job.state = "Refunded";
    assert.deepEqual(await sweepDeliveries(f.deps, f.directory), [1]);
    f.job.state = "Delivered";
    assert.equal((await handle(delivery())).ok, true);
    f.job.state = "Failed";
    assert.deepEqual(await sweepDeliveries(f.deps, f.directory), []);
    f.job.state = "Refunded";
    f.job.run_started_at = null;
    assert.equal((await handle(cleanup("Verify"))).ok, true);
    assert.deepEqual(await sweepDeliveries(f.deps, f.directory), []);
  } finally {
    await f.cleanup();
  }
});

test("the sweep deletes a private check once its job has ended, and not before", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    assert.equal((await handle(challenge())).ok, true);
    for (const state of [
      "Challenged",
      "Funded",
      "Delivered",
      "Passed",
      "Failed",
    ]) {
      f.job.state = state;
      await sweepDeliveries(f.deps, f.directory);
      assert.deepEqual(await readdir(f.records), ["1.check.json"], state);
    }
    f.job.state = "Released";
    await sweepDeliveries(f.deps, f.directory);
    assert.deepEqual(await readdir(f.records), []);
  } finally {
    await f.cleanup();
  }
});

test("a failed read deletes nothing", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    assert.equal((await handle(challenge())).ok, true);
    const failing = {
      ...f.deps,
      getJob: async () => {
        throw new Error("rpc down");
      },
    };
    await sweepDeliveries(failing, f.directory);
    assert.deepEqual(await readdir(f.records), ["1.check.json"]);
  } finally {
    await f.cleanup();
  }
});

test("only a definite refusal leaves signing on", () => {
  assert.equal(
    isDefiniteRefusal(new Error("Smart contract panicked: Secrets not found")),
    true,
  );
  assert.equal(
    isDefiniteRefusal(new Error("Secret transaction failed: abc")),
    true,
  );
  assert.equal(
    isDefiniteRefusal(new Error("Secret transaction remains unconfirmed: abc")),
    false,
  );
  assert.equal(isDefiniteRefusal(new Error("fetch failed")), false);
});

test("deleting a secret twice is fine, and other failures still surface", async () => {
  assert.equal(
    await deleteOnce(async () => {
      throw new Error("Smart contract panicked: Secrets not found");
    }),
    "already-deleted",
  );
  await assert.rejects(
    deleteOnce(async () => {
      throw new Error("fetch failed");
    }),
  );
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(
      {
        ...f.deps,
        deleteSecret: async () => {
          throw new Error("Smart contract panicked: Secrets not found");
        },
      },
      f.directory,
    );
    await handle(challenge());
    f.job.challenge_request_id = "12";
    f.job.state = "Challenged";
    assert.equal((await handle(cleanup())).ok, true);
  } finally {
    await f.cleanup();
  }
});

test("with signatures required, only the job's own parties can act", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(
      { ...f.deps, requireSignatures: true },
      f.directory,
    );
    const buyer = generateKeyPairSync("ed25519");
    const worker = generateKeyPairSync("ed25519");
    const raw = (pair: typeof buyer) =>
      pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const encode = (bytes: Buffer) => {
      let value = BigInt(`0x${bytes.toString("hex")}`);
      const alphabet =
        "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let out = "";
      while (value > 0n) {
        out = alphabet[Number(value % 58n)] + out;
        value /= 58n;
      }
      return `ed25519:${out}`;
    };
    const signed = (request: Record<string, unknown>, pair: typeof buyer) => {
      const nonce = randomBytes(32);
      const message = relayMessage(
        String(request.action),
        1,
        relayPayload(request),
        Date.now(),
      );
      return {
        ...request,
        auth: {
          public_key: encode(raw(pair)),
          message,
          nonce_base64: nonce.toString("base64"),
          signature_base64: sign(
            null,
            nep413Digest(message, nonce, RELAY_RECIPIENT),
            pair.privateKey,
          ).toString("base64"),
        },
      };
    };
    (f.job as { buyer: string }).buyer = raw(buyer).toString("hex");
    (f.job as { worker?: string }).worker = raw(worker).toString("hex");

    assert.equal((await handle(challenge())).ok, false, "unsigned");
    assert.equal(
      (await handle(signed(challenge(), worker))).ok,
      false,
      "worker",
    );
    assert.equal((await handle(signed(challenge(), buyer))).ok, true, "buyer");
    // A signature for one text cannot carry another.
    const swapped = signed(challenge(), buyer);
    assert.equal(
      (await handle({ ...swapped, reference: "{}" })).ok,
      false,
      "changed text",
    );
    f.job.state = "Delivered";
    assert.equal((await handle(delivery())).ok, false, "unsigned delivery");
    assert.equal(
      (await handle(signed(delivery(), buyer))).ok,
      false,
      "buyer delivers",
    );
    assert.equal((await handle(signed(delivery(), worker))).ok, true, "worker");
    assert.equal((await handle(pin())).ok, false, "unsigned pin");
    assert.equal((await handle(signed(pin(), worker))).ok, true, "worker pins");
    // The relay's own sweep needs no signature.
    f.job.challenge_request_id = "12";
    f.job.state = "Delivered";
    assert.equal((await handle(cleanup(), true)).ok, true, "internal");
    assert.equal((await handle(cleanup())).ok, false, "unsigned cleanup");
  } finally {
    await f.cleanup();
  }
});

test("the sweep deletes a run's secret once its result is recorded, once", async () => {
  const f = await fixture();
  try {
    const handle = await createHandoffHandler(f.deps, f.directory);
    await handle(challenge());
    const cleaned = new Set<string>();
    await sweepSecrets(f.deps, f.directory, handle, cleaned);
    assert.equal(f.deletions.length, 0, "no result yet");
    f.job.challenge_request_id = "12";
    f.job.state = "Challenged";
    await sweepSecrets(f.deps, f.directory, handle, cleaned);
    assert.equal(f.deletions.length, 1);
    await sweepSecrets(f.deps, f.directory, handle, cleaned);
    assert.equal(f.deletions.length, 1, "once");
  } finally {
    await f.cleanup();
  }
});

test("returns the deposit of a pin whose job was cancelled, without any request", async () => {
  const f = await fixture();
  const handle = await createHandoffHandler(f.deps, f.directory);
  assert.equal((await handle(challenge())).ok, true);
  const original = f.deps.getJob;
  f.deps.getJob = async () => null;
  assert.equal((await handle({ action: "expire_pins" }, true)).ok, true);
  f.deps.getJob = original;
  assert.equal(f.deletions.length, 1);
  assert.deepEqual(await readdir(f.records), []);
  await handle({ action: "expire_pins" }, true);
  assert.equal(f.deletions.length, 1);
  await f.cleanup();
});

test("keeps a pin while its job is waiting, and refuses expire_pins from outside", async () => {
  const f = await fixture();
  const handle = await createHandoffHandler(f.deps, f.directory);
  assert.equal((await handle(challenge())).ok, true);
  await handle({ action: "expire_pins" }, true);
  assert.equal(f.deletions.length, 0);
  assert.equal((await handle({ action: "expire_pins" })).ok, false);
  await f.cleanup();
});

test("leaves no check file or pin behind when the chain refuses the store", async () => {
  const f = await fixture();
  f.deps.storeSecret = async () => {
    throw new Error("Secret transaction failed: abc");
  };
  const handle = await createHandoffHandler(f.deps, f.directory);
  assert.equal((await handle(challenge())).ok, false);
  assert.deepEqual(await readdir(f.records), []);
  await handle({ action: "expire_pins" }, true);
  assert.equal(f.deletions.length, 0);
  await f.cleanup();
});

function signer() {
  const pair = generateKeyPairSync("ed25519");
  const bytes = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return {
    account: bytes.toString("hex"),
    sign(request: Record<string, unknown>) {
      const nonce = randomBytes(32);
      const message = relayMessage(
        String(request.action),
        Number(request.job_id),
        relayPayload(request),
        Date.now(),
      );
      return {
        ...request,
        auth: {
          public_key: `ed25519:${encoded}`,
          message,
          nonce_base64: nonce.toString("base64"),
          signature_base64: sign(
            null,
            nep413Digest(message, nonce, RELAY_RECIPIENT),
            pair.privateKey,
          ).toString("base64"),
        },
      };
    },
  };
}

test("a repeat pin signs nothing, and a refused repin keeps the record of the good one", async () => {
  const f = await fixture();
  const buyer = signer();
  Object.assign(f.job, { buyer: buyer.account });
  const handle = await createHandoffHandler(
    { ...f.deps, requireSignatures: true },
    f.directory,
  );
  assert.equal((await handle(buyer.sign(challenge()))).ok, true);
  assert.equal((await handle(buyer.sign(challenge()))).ok, true);
  assert.equal(f.stores.length, 1);
  await f.cleanup();
});

test("one party using up its signings cannot stop the other from pinning", async () => {
  const f = await fixture();
  const buyer = signer();
  const worker = signer();
  Object.assign(f.job, {
    buyer: buyer.account,
    worker: worker.account,
    state: "Draft",
  });
  let refuse = false;
  const deps = {
    ...f.deps,
    requireSignatures: true,
    storeSecret: async (
      hash: string,
      profile: string,
      variables: Record<string, string>,
    ) => {
      if (refuse) throw new Error("Secret transaction failed: abc");
      return f.deps.storeSecret(hash, profile, variables);
    },
  };
  const handle = await createHandoffHandler(deps, f.directory);
  assert.equal((await handle(buyer.sign(challenge()))).ok, true);
  await writeFile(
    join(f.records, "1.deliverable.json"),
    JSON.stringify({ text: deliverable }),
    { mode: 0o600 },
  );
  Object.assign(f.job, { state: "Delivered" });
  refuse = true;
  const attempts = [];
  for (let i = 0; i < 10; i++)
    attempts.push((await handle(worker.sign(pin()))).ok);
  assert.ok(attempts.every((ok) => ok === false));
  refuse = false;
  const before = f.stores.length;
  assert.equal((await handle(worker.sign(pin()))).ok, false);
  assert.equal(f.stores.length, before, "the worker's allowance is used up");
  assert.equal((await handle(buyer.sign(pin()))).ok, true);
  assert.equal(f.stores.length, before + 1);
  await f.cleanup();
});

test("a refused repin keeps the record of the earlier good pin", async () => {
  const f = await fixture();
  const handle = await createHandoffHandler(f.deps, f.directory);
  assert.equal((await handle(challenge())).ok, true);
  const pins = (await readdir(f.directory)).find((n) => n.startsWith("pins-"))!;
  f.deps.storeSecret = async () => {
    throw new Error("Secret transaction failed: abc");
  };
  const refusing = await createHandoffHandler(f.deps, f.directory);
  assert.equal((await refusing(challenge())).ok, false);
  assert.deepEqual(await readdir(join(f.directory, pins)), [
    "1.Challenge.json",
  ]);
  await f.cleanup();
});

test("the sweep leaves a pin alone when the job moved back to running before signing", async () => {
  const f = await fixture();
  const handle = await createHandoffHandler(f.deps, f.directory);
  assert.equal((await handle(challenge())).ok, true);
  let reads = 0;
  f.deps.getJob = async () =>
    reads++ === 0 ? null : ({ ...f.job, state: "Challenging" } as typeof f.job);
  await handle({ action: "expire_pins" }, true);
  assert.equal(f.deletions.length, 0);
  await f.cleanup();
});

test("a new pin stays while its job can still use it, even with an older result recorded", async () => {
  const f = await fixture();
  const handle = await createHandoffHandler(f.deps, f.directory);
  assert.equal((await handle(challenge())).ok, true);
  (f.job as { challenge_request_id: string | null }).challenge_request_id = "9";
  await handle({ action: "expire_pins" }, true);
  assert.equal(f.deletions.length, 0);
  await f.cleanup();
});

test("a check is published only once its bid has ended, and is provably the one on chain", async () => {
  const f = await fixture();
  let bid = {
    check_hash: sha256Hex(check),
    state: "Open",
    expires_at: (BigInt(Date.now() + 3_600_000) * 1_000_000n).toString(),
    claim: null as { job_id: number | null } | null,
  };
  const handle = await createHandoffHandler(
    { ...f.deps, getBid: async () => bid },
    f.directory,
  );
  const read = () => handle({ action: "reveal", bid_id: 0 });
  // A job has run and ended, but the bid is still open: the next worker must not see the check.
  assert.equal((await handle(challenge())).ok, true);
  Object.assign(f.job, { challenge_request_id: "9", state: "Refunded" });
  assert.equal(
    (await handle({ action: "cleanup", job_id: 1, kind: "Challenge" }, true))
      .ok,
    true,
  );
  let reply = await read();
  assert.ok(reply.ok && reply.result.revealed === false);
  // Ended: no signature, and no help from the buyer.
  bid = { ...bid, state: "Closed" };
  reply = await read();
  assert.ok(reply.ok && reply.result.revealed === true);
  assert.equal(reply.result.check, check);
  assert.equal(sha256Hex(String(reply.result.check)), bid.check_hash);
  // Nothing else is reachable this way.
  assert.equal((await handle({ action: "reveal", bid_id: -1 })).ok, false);
  assert.equal(
    (await handle({ action: "reveal", bid_id: 0, extra: 1 })).ok,
    false,
  );
  await f.cleanup();
});

test("an expired bid reveals only when nothing is in progress", () => {
  const past = "1";
  const future = (BigInt(Date.now() + 3_600_000) * 1_000_000n).toString();
  const now = BigInt(Date.now()) * 1_000_000n;
  const bid = (state: string, expires_at: string, job: number | null) => ({
    check_hash: "x",
    state,
    expires_at,
    claim: job === null ? null : { job_id: job },
  });
  assert.equal(revealAllowed(bid("Open", future, null), now), false);
  assert.equal(revealAllowed(bid("Claimed", future, 1), now), false);
  assert.equal(revealAllowed(bid("Open", past, null), now), true);
  assert.equal(revealAllowed(bid("Claimed", past, 1), now), false);
  for (const ended of ["Done", "Closed", "Cancelled"])
    assert.equal(revealAllowed(bid(ended, future, null), now), true);
});

test("while the market is limited, only allowed buyers can start a job, and running jobs can finish", async () => {
  const f = await fixture();
  const handle = await createHandoffHandler(
    { ...f.deps, allowedBuyers: new Set(["someone-else.testnet"]) },
    f.directory,
  );
  assert.equal((await handle(challenge())).ok, false);
  assert.equal(f.stores.length, 0);
  const open = await createHandoffHandler(
    { ...f.deps, allowedBuyers: new Set(["buyer.testnet"]) },
    f.directory,
  );
  assert.equal((await open(challenge())).ok, true);
  // A delivery for a job already running is not affected by who is allowed to start new ones.
  Object.assign(f.job, { state: "Delivered" });
  const limited = await createHandoffHandler(
    { ...f.deps, allowedBuyers: new Set() },
    f.directory,
  );
  assert.equal((await limited(delivery())).ok, true);
  await f.cleanup();
});

test("mainnet stays closed unless the one setting says otherwise", () => {
  assert.deepEqual(marketAccess(undefined, "mainnet"), new Set());
  assert.deepEqual(marketAccess("", "mainnet"), new Set());
  assert.deepEqual(
    marketAccess("a.near, b.near", "mainnet"),
    new Set(["a.near", "b.near"]),
  );
  assert.equal(marketAccess("open", "mainnet"), undefined);
  assert.equal(marketAccess(undefined, "testnet"), undefined);
});
