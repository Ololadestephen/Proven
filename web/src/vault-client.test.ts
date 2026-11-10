// Withdrawal outcomes from EXPERIMENTAL_tx_status answers recorded in the sandbox
// (contracts/pr-bounty/tests/flow.rs with RECORD_WEB_FIXTURES=1), vault view codecs, and the
// checks made before any signature is requested. No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fromHex, hex } from "../ui/bounty-keys.ts";
import {
  checkWithdrawal,
  chooseDeadline,
  classifyWithdrawal,
  cliCommand,
  decodeInfo,
  decodeRecord,
  encodeInfo,
  encodeRecord,
  mayAuthorizeAgain,
  slotArgs,
  withdrawArgs,
  type Withdrawal,
} from "../ui/vault-client.ts";

const recorded = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../test-fixtures/sandbox/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as {
    vault: string;
    to: string;
    amount: string;
    n: string;
    status: unknown;
    info_after_hex?: string;
  };
const signed = (r: ReturnType<typeof recorded>) => ({
  to: r.to,
  amount: BigInt(r.amount),
  n: BigInt(r.n),
});

test("a succeeded transfer receipt is delivered, with amount and destination from the receipt", () => {
  const r = recorded("withdrawal-delivered");
  assert.deepEqual(classifyWithdrawal(r.status, r.vault, signed(r)), {
    kind: "delivered",
    to: r.to,
    amount: BigInt(r.amount),
    n: 1n,
  });
});

test("a failed transfer receipt is returned to the vault, and the next number is offered", () => {
  const r = recorded("withdrawal-returned");
  assert.deepEqual(classifyWithdrawal(r.status, r.vault, signed(r)), {
    kind: "returned",
    amount: BigInt(r.amount),
    n: 0n,
    next: 1n,
  });
});

test("a withdraw the vault refused keeps its number and names the reason", () => {
  const r = recorded("withdrawal-refused");
  const outcome = classifyWithdrawal(r.status, r.vault, signed(r));
  assert.equal(outcome.kind, "refused");
  assert.ok(
    outcome.kind === "refused" && outcome.reason.includes("bad signature"),
  );
  assert.ok(outcome.kind === "refused" && outcome.n === 0n);
});

test("a missing or partial outcome is unknown and blocks a new authorization", () => {
  const r = recorded("withdrawal-delivered");
  const status = r.status as {
    receipts_outcome: { outcome: { status: unknown } }[];
  };
  const partial = structuredClone(status);
  partial.receipts_outcome = partial.receipts_outcome.slice(0, 1);
  for (const answer of [null, {}, { receipts: [] }, partial])
    assert.deepEqual(classifyWithdrawal(answer, r.vault, signed(r)), {
      kind: "unknown",
    });
  const pending = structuredClone(status);
  (
    pending.receipts_outcome[1] as { outcome: { status: unknown } }
  ).outcome.status = {};
  assert.deepEqual(classifyWithdrawal(pending, r.vault, signed(r)), {
    kind: "unknown",
  });
  // Another contract's transaction is never read as this vault's withdrawal.
  assert.deepEqual(
    classifyWithdrawal(r.status, `0s${"0".repeat(40)}`, signed(r)),
    {
      kind: "unknown",
    },
  );
  // Unknown with the same number and an open deadline: no new authorization yet.
  assert.equal(
    mayAuthorizeAgain({ n: 1n, deadline: 2000, outcome: "unknown" }, 1n, 1999),
    false,
  );
  assert.equal(
    mayAuthorizeAgain({ n: 1n, deadline: 2000, outcome: "unknown" }, 2n, 1999),
    true,
  );
  assert.equal(
    mayAuthorizeAgain({ n: 1n, deadline: 2000, outcome: "unknown" }, 1n, 2000),
    true,
  );
  assert.equal(
    mayAuthorizeAgain({ n: 1n, deadline: 2000, outcome: "returned" }, 1n, 1999),
    true,
  );
  assert.equal(mayAuthorizeAgain(null, 0n, 0), true);
});

const base: Withdrawal = {
  chain: "testnet",
  vault: `0s${"ab".repeat(20)}`,
  to: "payee.testnet",
  amount: 10n,
  n: 3n,
  deadline: 1_000_600,
};

test("an authorization past its deadline is refused before submission, and so are bad inputs", () => {
  const now = 1_000_000;
  assert.equal(chooseDeadline(now), now + 600);
  assert.equal(checkWithdrawal(base, 10n, true, now), null);
  const cases: [Partial<Withdrawal>, bigint, boolean | null, number, string][] =
    [
      [{ deadline: now }, 10n, true, now, "deadline_passed"],
      [{ deadline: now - 1 }, 10n, true, now, "deadline_passed"],
      [{ deadline: now + 901 }, 10n, true, now, "deadline_too_far"],
      [{ to: "Bad Account" }, 10n, true, now, "bad_destination"],
      [{ to: "a" }, 10n, true, now, "bad_destination"],
      [{ to: base.vault }, 10n, true, now, "destination_is_vault"],
      [{}, 10n, false, now, "destination_missing"],
      [{}, 10n, null, now, "destination_missing"],
      [{ amount: 0n }, 10n, true, now, "zero_amount"],
      [{ amount: 11n }, 10n, true, now, "above_balance"],
    ];
  for (const [change, available, exists, at, expected] of cases)
    assert.equal(
      checkWithdrawal({ ...base, ...change }, available, exists, at),
      expected,
      JSON.stringify(change, (_, x) =>
        typeof x === "bigint" ? x.toString() : x,
      ),
    );
  // An implicit destination exists by name and needs no read.
  assert.equal(
    checkWithdrawal({ ...base, to: "a".repeat(64) }, 10n, null, now),
    null,
  );
});

test("vault views decode and encode back to the same bytes", () => {
  const r = recorded("withdrawal-delivered");
  const bytes = fromHex(r.info_after_hex as string);
  const info = decodeInfo(bytes);
  assert.equal(info.available, 0n);
  assert.equal(info.n, 2n);
  assert.ok(info.fund > 0n);
  assert.equal(hex(encodeInfo(info)), r.info_after_hex);
  assert.throws(() => decodeInfo(bytes.slice(1)));
  for (const record of [
    {
      deposited: true,
      attempt: 2,
      amount: 80_000_000_000_000_000_000_000n,
      sealedThrough: 1,
    },
    { deposited: false, attempt: 0, amount: 0n, sealedThrough: 0 },
    {
      deposited: true,
      attempt: 4_294_967_295,
      amount: (1n << 128n) - 1n,
      sealedThrough: 4_294_967_295,
    },
  ])
    assert.deepEqual(decodeRecord(encodeRecord(record)), record);
  const bad = encodeRecord({
    deposited: true,
    attempt: 1,
    amount: 1n,
    sealedThrough: 0,
  });
  bad[0] = 2;
  assert.throws(() => decodeRecord(bad));
  assert.equal(
    hex(slotArgs("bounty.test.near", 7, "Refund")),
    `10000000${hex(new TextEncoder().encode("bounty.test.near"))}070000000000000002`,
  );
});

test("the CLI fallback sends the same JSON arguments", () => {
  const args = withdrawArgs(base, new Uint8Array(64).fill(1));
  const command = cliCommand(base, args, "relayer.testnet");
  assert.ok(command.includes(`${base.vault} withdraw json-args '${args}'`));
  assert.ok(command.includes("network-config testnet"));
  assert.deepEqual(JSON.parse(args), {
    to: base.to,
    amount: "10",
    n: "3",
    deadline: "1000600",
    signature: "01".repeat(64),
  });
});
