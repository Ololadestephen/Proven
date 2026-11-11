// How the page shows settlements and vaults, from settlement views shaped like the bounty
// contract's (one withdrawal key per vault; the fixtures were reshaped by hand from the pilot's
// sandbox recordings, since the pilot's two-key views no longer exist). No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  STATUS_TEXT,
  deliveredFrom,
  latestWithdrawal,
  loadHistory,
  reconcileWindow,
  saveHistory,
  settlementDisplay,
  settlementStatus,
  vaultNumbers,
  type SettlementView,
  type StoredWithdrawal,
  type WithdrawalRecord,
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
        info: { key: "k", n: "0", fund: "5", available: "0" },
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

test("the recorded refunded bounty refunds exactly the reward to the maintainer's vault", () => {
  const b = recorded<{
    reward: string;
    refund: SettlementView;
    maintainer_key: string;
    maintainer_vault: string;
  }>("bounty-refunded");
  assert.equal(BigInt(b.refund.principal), BigInt(b.reward));
  assert.equal(b.refund.vault, b.maintainer_vault);
  assert.equal(b.refund.key, b.maintainer_key);
  assert.ok(!("budget" in b), "there is no check reserve any more");
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

// ---- Vault credit and wallet withdrawal are separate ----
type Outcome = StoredWithdrawal["outcome"];
const settlements: [string, SettlementView | null | undefined, string][] = [
  ["no settlement", null, "none"],
  ["read failed", undefined, "unknown"],
  ["unreadable state", { ...done, state: "Other" as never }, "unknown"],
  ["due", due, "sending"],
  ["in flight, no result", inFlight, "sending"],
  ["in flight, succeeded", { ...inFlight, outcome: "Succeeded" }, "sending"],
  ["in flight, failed", { ...inFlight, outcome: "Failed" }, "sending"],
  ["done", done, "in vault"],
];
const outcomes: [Outcome | null, string][] = [
  [null, "not withdrawn"],
  ["pending", "withdrawing"],
  ["delivered", "withdrawn"],
  ["returned", "returned to vault"],
  ["refused", "refused"],
];
const record = (outcome: Outcome): WithdrawalRecord => ({
  outcome,
  to: "payee.testnet",
  amount: "1",
});

test("every settlement and withdrawal combination shows each part on its own", () => {
  for (const [name, settlement, credit] of settlements)
    for (const [outcome, wallet] of outcomes) {
      const shown = settlementDisplay(
        settlement,
        outcome ? record(outcome) : null,
      );
      assert.equal(shown.vaultCredit, credit, `${name} / ${outcome}: credit`);
      assert.equal(shown.wallet, wallet, `${name} / ${outcome}: wallet`);
      assert.ok(
        shown.vaultCreditText.length > 20 && shown.walletText.length > 20,
      );
    }
});

test("a Done settlement never implies a wallet withdrawal", () => {
  const shown = settlementDisplay(done, null);
  assert.equal(shown.vaultCredit, "in vault");
  assert.equal(shown.wallet, "not withdrawn");
  assert.match(shown.vaultCreditText, /not a withdrawal to a wallet/);
  assert.match(shown.walletText, /Not withdrawn/);
  for (const outcome of ["pending", "returned", "refused"] as const)
    assert.notEqual(
      settlementDisplay(done, record(outcome)).wallet,
      "withdrawn",
      outcome,
    );
});

test("a withdrawn state never implies anything for the contract", () => {
  for (const [name, settlement, credit] of settlements) {
    const shown = settlementDisplay(settlement, record("delivered"));
    assert.equal(shown.wallet, "withdrawn", name);
    assert.equal(shown.vaultCredit, credit, name);
    assert.deepEqual(
      shown.vaultCreditText,
      settlementDisplay(settlement, null).vaultCreditText,
      `${name}: the contract's text does not change`,
    );
  }
  assert.match(
    settlementDisplay(done, record("delivered")).walletText,
    /Withdrawn to payee\.testnet.*contract does not track/,
  );
  assert.notEqual(
    settlementDisplay(due, record("delivered")).vaultCredit,
    "in vault",
  );
});

test("the texts name the account of a failed or pending withdrawal and tell what to do", () => {
  assert.match(
    settlementDisplay(done, record("returned")).walletText,
    /payee\.testnet failed.*came back to the vault.*another account/,
  );
  assert.match(
    settlementDisplay(done, record("pending")).walletText,
    /to payee\.testnet was submitted.*not final/,
  );
  assert.match(
    settlementDisplay(done, record("refused")).walletText,
    /nothing moved/,
  );
  // A record without a destination still reads.
  assert.match(
    settlementDisplay(done, { outcome: "delivered" }).walletText,
    /^Withdrawn: /,
  );
});

test("an in-flight attempt with no recorded result becomes unknown only after the party delay", () => {
  const sent = Number(BigInt(inFlight.sent_at) / 1_000_000_000n);
  const at = (nowSecs: number) =>
    settlementDisplay(inFlight, null, { nowSecs, partyDelaySecs: 900 })
      .vaultCredit;
  assert.equal(at(sent + 899), "sending");
  assert.equal(at(sent + 900), "unknown");
  // A recorded result, or a due or done settlement, is never "unknown" by age.
  const later = { nowSecs: sent + 10_000, partyDelaySecs: 900 };
  assert.equal(
    settlementDisplay({ ...inFlight, outcome: "Succeeded" }, null, later)
      .vaultCredit,
    "sending",
  );
  assert.equal(settlementDisplay(due, null, later).vaultCredit, "sending");
  assert.equal(settlementDisplay(done, null, later).vaultCredit, "in vault");
});

test("the latest recorded withdrawal of a vault is the one shown", () => {
  const first = {
    ...delivered(done.vault, "1"),
    n: "0",
    outcome: "returned" as const,
  };
  const second = { ...delivered(done.vault, "1"), n: "1" };
  const other = delivered("0s" + "0".repeat(40), "1");
  assert.equal(latestWithdrawal(done.vault, [first, second, other]), second);
  assert.equal(latestWithdrawal(done.vault, [other]), null);
  assert.equal(latestWithdrawal(done.vault, []), null);
});
