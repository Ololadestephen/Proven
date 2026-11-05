import test from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { timed, type TimingEvent } from "./timing.ts";
import { relayAccount } from "./near.ts";
import type { Config } from "./config.ts";

test("timings retain phase/duration and a fixed failure category without private payloads", async () => {
  const rows: TimingEvent[] = [];
  const sink = async (row: TimingEvent) => {
    rows.push(row);
  };
  assert.equal(
    await timed("keystore_key", async () => "PRIVATE_VALUE", sink),
    "PRIVATE_VALUE",
  );
  const error = new Error("PRIVATE_KEY request=PRIVATE_DATA HTTP 503");
  await assert.rejects(
    timed(
      "compute_admit",
      async () => {
        throw error;
      },
      sink,
    ),
    (e) => e === error,
  );
  assert.equal(rows[1].failure, "503");
  assert.ok(
    rows.every(
      (row) => row.elapsed_ms >= 0 && !Number.isNaN(Date.parse(row.started_at)),
    ),
  );
  assert.ok(!JSON.stringify(rows).includes("PRIVATE"));
  const unknown = new Error("sensitive request text");
  await assert.rejects(
    timed(
      "secret_store",
      async () => {
        throw unknown;
      },
      sink,
    ),
  );
  assert.equal(rows[2].failure, "unclassified");
});

test("demo provider makes one HTTP attempt rather than hiding exponential retries", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("unavailable", { status: 503 });
  };
  const account = relayAccount(
    {
      rpcUrl: "https://test.rpc.fastnear.com",
      relayAccountId: "operator.testnet",
      relayPrivateKey: KeyPair.fromRandom("ed25519").toString(),
    } as Config,
    true,
  );
  await assert.rejects(account.provider.viewNodeStatus());
  assert.equal(requests, 1);
});
