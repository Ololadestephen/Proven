import test from "node:test";
import assert from "node:assert/strict";
import {
  createDemoSponsor,
  type SponsorJob,
  type SponsorRecord,
} from "./demo-sponsor.ts";

function fixture() {
  const jobs = new Map<number, SponsorJob>(
    [1, 2, 3].map((id) => [
      id,
      {
        state: "Draft",
        secrets_owner: "relay.testnet",
        buyer: "buyer.testnet",
        worker: id === 1 ? "honest.testnet" : "fake.testnet",
        token: null,
        amount: "10000000000000000000000",
        spec_hash: "a".repeat(64),
        fakes_hash: "b".repeat(64),
        verifier_hash: "c".repeat(64),
      },
    ]),
  );
  const saved: SponsorRecord[] = [];
  const calls: Array<[number, string]> = [];
  let tail = Promise.resolve<unknown>(undefined),
    reject = false;
  const wallet = <T>(action: () => Promise<T>): Promise<T> => {
    const next = tail.catch(() => undefined).then(action);
    tail = next;
    return next;
  };
  const config = {
    buyer: "buyer.testnet",
    workers: ["honest.testnet", "fake.testnet"],
    specHash: "a".repeat(64),
    referenceHash: "b".repeat(64),
    verifierHash: "c".repeat(64),
    async trigger(id: number, kind: "Challenge" | "Verify") {
      assert.ok(
        saved
          .at(-1)!
          .attempts.some(
            (a) => a.job_id === id && a.kind === kind && !a.transaction_hash,
          ),
      );
      calls.push([id, kind]);
      if (reject) throw new Error("Unknown outcome");
      return "1".repeat(44);
    },
  };
  const sponsor = createDemoSponsor(
    config,
    "relay.testnet",
    async (id) => jobs.get(id) ?? null,
    wallet,
    async (record) => {
      saved.push(structuredClone(record));
    },
  );
  return {
    jobs,
    saved,
    calls,
    sponsor,
    config,
    wallet,
    fail: () => {
      reject = true;
    },
  };
}

test("sponsorship is disabled by default and exact jobs/commitments must be registered first", async () => {
  const f = fixture();
  const disabled = createDemoSponsor(
    undefined,
    "relay.testnet",
    async () => null,
    f.wallet,
    async () => {},
  );
  assert.equal(disabled.status().enabled, false);
  await assert.rejects(disabled.register([1, 2], disabled.status().session_id));
  await assert.rejects(
    f.sponsor.trigger(
      1,
      "Challenge",
      f.sponsor.status().session_id,
      () => true,
    ),
  );
  for (const edit of [
    { buyer: "other.testnet" },
    { amount: "1" },
    { worker: "attacker.testnet" },
    { token: "token.testnet" },
    { spec_hash: "d".repeat(64) },
    { verifier_hash: "d".repeat(64) },
  ]) {
    const original = { ...f.jobs.get(1)! };
    Object.assign(f.jobs.get(1)!, edit);
    await assert.rejects(
      f.sponsor.register([1, 2], f.sponsor.status().session_id),
    );
    f.jobs.set(1, original);
  }
  await f.sponsor.register([1, 2], f.sponsor.status().session_id);
  await f.sponsor.register([1, 2], f.sponsor.status().session_id);
  await assert.rejects(
    f.sponsor.register([1, 3], f.sponsor.status().session_id),
  );
  await assert.rejects(
    f.sponsor.trigger(
      3,
      "Challenge",
      f.sponsor.status().session_id,
      () => true,
    ),
  );
  await assert.rejects(
    f.sponsor.trigger(
      1,
      "Challenge",
      f.sponsor.status().session_id,
      () => false,
    ),
  );
  assert.equal(f.calls.length, 0);
});

test("four distinct attempts reserve before submission; repeats and uncertain attempts cannot replay", async () => {
  const f = fixture();
  await f.sponsor.register([1, 2], f.sponsor.status().session_id);
  for (const id of [1, 2]) {
    await f.sponsor.trigger(
      id,
      "Challenge",
      f.sponsor.status().session_id,
      () => true,
    );
    await assert.rejects(
      f.sponsor.trigger(
        id,
        "Challenge",
        f.sponsor.status().session_id,
        () => true,
      ),
    );
    f.jobs.get(id)!.state = "Delivered";
    await f.sponsor.trigger(
      id,
      "Verify",
      f.sponsor.status().session_id,
      () => true,
    );
  }
  assert.equal(f.sponsor.status().remaining, 0);
  assert.equal(f.calls.length, 4);
  const failed = fixture();
  await failed.sponsor.register([1, 2], failed.sponsor.status().session_id);
  failed.fail();
  await assert.rejects(
    failed.sponsor.trigger(
      1,
      "Challenge",
      failed.sponsor.status().session_id,
      () => true,
    ),
  );
  await assert.rejects(
    failed.sponsor.trigger(
      1,
      "Challenge",
      failed.sponsor.status().session_id,
      () => true,
    ),
  );
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.sponsor.status().remaining, 3);
});

test("queued signing re-reads state and pins immediately before spending", async () => {
  const f = fixture();
  await f.sponsor.register([1, 2], f.sponsor.status().session_id);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = f.wallet(() => gate);
  let pinned = true;
  const attempt = f.sponsor.trigger(
    1,
    "Challenge",
    f.sponsor.status().session_id,
    () => pinned,
  );
  pinned = false;
  f.jobs.get(1)!.state = "Funded";
  release();
  await blocker;
  await assert.rejects(attempt);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sponsor.status().remaining, 4);
});

test("a stale client session cannot reserve or trigger a new operator session", async () => {
  const f = fixture();
  await f.sponsor.register([1, 2], f.sponsor.status().session_id);
  await assert.rejects(f.sponsor.register([1, 2], "old-session"));
  await assert.rejects(
    f.sponsor.trigger(1, "Challenge", "old-session", () => true),
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.sponsor.status().remaining, 4);
});
