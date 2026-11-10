// How the page shows settlements and vaults, from contract views recorded in the sandbox
// (contracts/pr-bounty/tests/recovery.rs with RECORD_WEB_FIXTURES=1). No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  STATUS_TEXT,
  deliveredFrom,
  loadHistory,
  reconcileWindow,
  saveHistory,
  settlementStatus,
  vaultNumbers,
  type SettlementView,
  type StoredWithdrawal,
} from "../ui/vault-view.ts";

const recorded = <T>(name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../test-fixtures/sandbox/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as T;
const inFlight = recorded<SettlementView>("settlement-in-flight");
const due = recorded<SettlementView>("settlement-due");
const done = recorded<SettlementView>("settlement-done");

const delivered = (vault: string, amount: string): StoredWithdrawal => ({
  hash: "h",
  sender: "relayer.testnet",
  vault,
  to: "payee.testnet",
  amount,
  n: "0",
  deadline: 0,
  outcome: "delivered",
});

test("each recorded settlement shows as due, in flight or in the vault", () => {
  assert.equal(settlementStatus(due, 1, 0n), "due");
  assert.equal(settlementStatus(inFlight, 1, 0n), "in_flight");
  assert.equal(settlementStatus(done, 1, 0n), "in_vault");
  assert.equal(
    settlementStatus({ ...inFlight, outcome: "Succeeded" }, 1, 0n),
    "needs_recording",
  );
  assert.match(STATUS_TEXT.due, /still reserved/);
  assert.match(STATUS_TEXT.in_flight, /still reserved/);
});

test("withdrawn needs a delivered receipt from an unshared vault", () => {
  const history = [delivered(done.vault, done.principal)];
  const got = deliveredFrom(done.vault, history);
  assert.equal(got, BigInt(done.principal));
  assert.equal(settlementStatus(done, 1, got), "withdrawn");
  // A shared vault shows withdrawals only for the vault as a whole.
  assert.equal(settlementStatus(done, 2, got), "in_vault");
  // A returned or unknown withdrawal is never counted as delivered.
  assert.equal(
    deliveredFrom(done.vault, [
      { ...history[0]!, outcome: "returned" },
      { ...history[0]!, outcome: "pending" },
    ]),
    0n,
  );
  assert.equal(
    deliveredFrom("0s" + "0".repeat(40), history),
    0n,
    "another vault's receipts do not count",
  );
});

test("failed reads are unavailable, never zero", () => {
  assert.equal(settlementStatus(null, 1, 0n), "unavailable");
  assert.equal(
    settlementStatus(
      { ...done, state: "Other" as unknown as SettlementView["state"] },
      1,
      0n,
    ),
    "unavailable",
  );
  const near = (y: string) => `${y} yocto`;
  for (const read of [null, { exists: false, info: null }])
    assert.deepEqual(vaultNumbers(read, near), {
      available: "unavailable",
      fund: "unavailable",
      n: "unavailable",
    });
  assert.deepEqual(
    vaultNumbers(
      {
        exists: true,
        info: { primary: "k", backup: "b", n: "0", fund: "5", available: "0" },
      },
      near,
    ),
    { available: "0 yocto", fund: "5 yocto", n: "0" },
  );
});

test("the reconcile window counts from the attempt's send time", () => {
  const sent = Number(BigInt(inFlight.sent_at) / 1_000_000_000n);
  assert.deepEqual(reconcileWindow(inFlight, sent, 900, 86_400), {
    party: 900,
    anyone: 86_400,
  });
  assert.deepEqual(reconcileWindow(inFlight, sent + 900, 900, 86_400), {
    party: 0,
    anyone: 85_500,
  });
  assert.equal(reconcileWindow(done, sent, 900, 86_400), null);
});

test("the recorded refunded bounty carries the full refund principal", () => {
  const b = recorded<{
    reward: string;
    budget: string;
    refund: SettlementView;
    maintainer_vault: string;
  }>("bounty-refunded");
  assert.equal(BigInt(b.refund.principal), BigInt(b.reward) + BigInt(b.budget));
  assert.equal(b.refund.vault, b.maintainer_vault);
});

test("withdrawal history survives in local storage and ignores bad data", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  const entry = delivered(done.vault, "1");
  saveHistory(done.vault, [entry], storage);
  assert.deepEqual(loadHistory(done.vault, storage), [entry]);
  map.set(`proven:vault-withdrawals:${done.vault}`, "not json");
  assert.deepEqual(loadHistory(done.vault, storage), []);
  assert.deepEqual(loadHistory(done.vault, null), []);
});
