// Withdrawal outcomes from EXPERIMENTAL_tx_status answers recorded in the sandbox
// (contracts/pr-bounty/tests/flow.rs with RECORD_WEB_FIXTURES=1), vault view codecs, and the
// checks made before any signature is requested. No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fromHex, hex } from "../ui/bounty-keys.ts";
import { adaptWallet } from "../ui/wallet-adapter.ts";
import type { NearWalletBase } from "@hot-labs/near-connect";
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
  sendWithdrawal,
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
type Fixture = ReturnType<typeof recorded>;
const expected = (r: Fixture) => ({
  vault: r.vault,
  to: r.to,
  amount: BigInt(r.amount),
  n: BigInt(r.n),
});
type Tx = any;
const clone = (r: Fixture): Tx => structuredClone(r.status);
const pendingKind = (outcome: { kind: string }) => outcome.kind;
/** The transfer receipt from the vault to the destination, and the refund back to the vault. */
const transferOf = (r: Fixture, tx: Tx) =>
  tx.receipts.find(
    (x: Tx) => x.predecessor_id === r.vault && x.receiver_id === r.to,
  );
const refundOf = (r: Fixture, tx: Tx) =>
  tx.receipts.find(
    (x: Tx) => x.predecessor_id === "system" && x.receiver_id === r.vault,
  );
const outcomeOf = (tx: Tx, id: string) =>
  tx.receipts_outcome.find((o: Tx) => o.id === id);
const withArgs = (tx: Tx, args: Record<string, string>) => {
  tx.transaction.actions[0].FunctionCall.args = Buffer.from(
    JSON.stringify(args),
  ).toString("base64");
  return tx;
};

test("a finalized transfer tied to the exact withdraw call is delivered", () => {
  const r = recorded("withdrawal-delivered");
  assert.deepEqual(classifyWithdrawal(r.status, expected(r)), {
    kind: "delivered",
    to: r.to,
    amount: BigInt(r.amount),
    n: 1n,
  });
  assert.equal(
    classifyWithdrawal(r.status, {
      ...expected(r),
      sender: "relayer.test.near",
    }).kind,
    "delivered",
  );
});

test("a failed transfer is returned only with its finalized refund to the vault", () => {
  const r = recorded("withdrawal-returned");
  assert.deepEqual(classifyWithdrawal(r.status, expected(r)), {
    kind: "returned",
    amount: BigInt(r.amount),
    n: 0n,
    next: 1n,
  });
});

test("a withdraw the vault refused keeps its number and names the reason", () => {
  const r = recorded("withdrawal-refused");
  const outcome = classifyWithdrawal(r.status, expected(r));
  assert.equal(outcome.kind, "refused");
  assert.ok(
    outcome.kind === "refused" && outcome.reason.includes("bad signature"),
  );
  assert.ok(outcome.kind === "refused" && outcome.n === 0n);
  // A refusal that is not final yet is pending, not refused.
  const early = clone(r);
  early.final_execution_status = "EXECUTED_OPTIMISTIC";
  assert.equal(classifyWithdrawal(early, expected(r)).kind, "pending");
});

// Regression (review finding 1, first failure, reproduced on 5c72954): evidence that does not
// match the signed withdrawal, or is not final, was shown as delivered.
test("delivered needs final evidence matching the signed vault, destination and amount", () => {
  const r = recorded("withdrawal-delivered");
  const cases: [string, (tx: Tx) => Tx][] = [
    [
      "transfer of another amount",
      (tx) => {
        transferOf(r, tx).receipt.Action.actions[0].Transfer.deposit = "1";
        return tx;
      },
    ],
    [
      "optimistic answer",
      (tx) => ({ ...tx, final_execution_status: "EXECUTED_OPTIMISTIC" }),
    ],
    [
      "included only",
      (tx) => ({ ...tx, final_execution_status: "INCLUDED_FINAL" }),
    ],
    [
      "call arguments of another withdrawal",
      (tx) =>
        withArgs(tx, {
          to: r.to,
          amount: "1",
          n: "7",
          deadline: "1",
          signature: "00",
        }),
    ],
    [
      "call arguments to another destination",
      (tx) =>
        withArgs(tx, {
          to: "other.test.near",
          amount: r.amount,
          n: r.n,
          deadline: "1",
          signature: "00",
        }),
    ],
    [
      "another method",
      (tx) => {
        tx.transaction.actions[0].FunctionCall.method_name = "deposit";
        return tx;
      },
    ],
    [
      "transfer not created by the call",
      (tx) => {
        const call = outcomeOf(
          tx,
          tx.transaction_outcome.outcome.receipt_ids[0],
        );
        const id = transferOf(r, tx).receipt_id;
        call.outcome.receipt_ids = call.outcome.receipt_ids.filter(
          (x: string) => x !== id,
        );
        return tx;
      },
    ],
    [
      "transfer outcome missing",
      (tx) => {
        const id = transferOf(r, tx).receipt_id;
        tx.receipts_outcome = tx.receipts_outcome.filter(
          (o: Tx) => o.id !== id,
        );
        return tx;
      },
    ],
    [
      "transfer outcome without a final status",
      (tx) => {
        outcomeOf(tx, transferOf(r, tx).receipt_id).outcome.status = {
          Unknown: null,
        };
        return tx;
      },
    ],
    [
      "a second transfer from the call",
      (tx) => {
        const extra = structuredClone(transferOf(r, tx));
        extra.receipt_id = "Extra111111111111111111111111111111111111111";
        tx.receipts.push(extra);
        tx.receipts_outcome.push({
          ...structuredClone(outcomeOf(tx, transferOf(r, tx).receipt_id)),
          id: extra.receipt_id,
        });
        outcomeOf(
          tx,
          tx.transaction_outcome.outcome.receipt_ids[0],
        ).outcome.receipt_ids.push(extra.receipt_id);
        return tx;
      },
    ],
    [
      "call outcome on another account",
      (tx) => {
        outcomeOf(
          tx,
          tx.transaction_outcome.outcome.receipt_ids[0],
        ).outcome.executor_id = "other.test.near";
        return tx;
      },
    ],
    ["malformed receipts", (tx) => ({ ...tx, receipts: "x" })],
    [
      "malformed arguments",
      (tx) => {
        tx.transaction.actions[0].FunctionCall.args = "not base64 json";
        return tx;
      },
    ],
  ];
  for (const [label, mutate] of cases)
    assert.equal(
      pendingKind(classifyWithdrawal(mutate(clone(r)), expected(r))),
      "pending",
      label,
    );
  for (const wrong of [
    { ...expected(r), amount: BigInt(r.amount) - 1n },
    { ...expected(r), to: "other.test.near" },
    { ...expected(r), vault: `0s${"0".repeat(40)}` },
    { ...expected(r), n: 0n },
    { ...expected(r), sender: "stranger.test.near" },
  ])
    assert.equal(classifyWithdrawal(r.status, wrong).kind, "pending");
  for (const answer of [null, {}, { receipts: [] }, "text", []])
    assert.equal(classifyWithdrawal(answer, expected(r)).kind, "pending");
});

// Regression (review finding 1, second failure, reproduced on 5c72954): a failed transfer was
// shown as returned before the refund to the vault had finalized.
test("returned waits for the matching refund to the vault to finalize", () => {
  const r = recorded("withdrawal-returned");
  const cases: [string, (tx: Tx) => Tx][] = [
    [
      "refund not executed yet, answer optimistic",
      (tx) => {
        const id = refundOf(r, tx).receipt_id;
        tx.receipts_outcome = tx.receipts_outcome.filter(
          (o: Tx) => o.id !== id,
        );
        tx.receipts = tx.receipts.filter((x: Tx) => x.receipt_id !== id);
        tx.final_execution_status = "EXECUTED_OPTIMISTIC";
        return tx;
      },
    ],
    [
      "refund receipt without its outcome",
      (tx) => {
        const id = refundOf(r, tx).receipt_id;
        tx.receipts_outcome = tx.receipts_outcome.filter(
          (o: Tx) => o.id !== id,
        );
        return tx;
      },
    ],
    [
      "refund for another amount",
      (tx) => {
        refundOf(r, tx).receipt.Action.actions[0].Transfer.deposit = "1";
        return tx;
      },
    ],
    [
      "refund to another account",
      (tx) => {
        refundOf(r, tx).receiver_id = "other.test.near";
        return tx;
      },
    ],
    [
      "refund not created by the failed transfer",
      (tx) => {
        const t = outcomeOf(tx, transferOf(r, tx).receipt_id);
        const id = refundOf(r, tx).receipt_id;
        t.outcome.receipt_ids = t.outcome.receipt_ids.filter(
          (x: string) => x !== id,
        );
        return tx;
      },
    ],
    [
      "refund failed",
      (tx) => {
        outcomeOf(tx, refundOf(r, tx).receipt_id).outcome.status = {
          Failure: {},
        };
        return tx;
      },
    ],
    ["not final", (tx) => ({ ...tx, final_execution_status: "EXECUTED" })],
  ];
  for (const [label, mutate] of cases)
    assert.equal(
      classifyWithdrawal(mutate(clone(r)), expected(r)).kind,
      "pending",
      label,
    );
});

test("a pending withdrawal blocks a new authorization until its number moves or it expires", () => {
  assert.equal(
    mayAuthorizeAgain({ n: 1n, deadline: 2000, outcome: "pending" }, 1n, 1999),
    false,
  );
  assert.equal(
    mayAuthorizeAgain({ n: 1n, deadline: 2000, outcome: "pending" }, 2n, 1999),
    true,
  );
  assert.equal(
    mayAuthorizeAgain({ n: 1n, deadline: 2000, outcome: "pending" }, 1n, 2000),
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

// Regression (review finding 1): a wallet that reports a failure or an incomplete outcome still
// names the transaction it sent; the hash must survive so the page can re-check it.
const HASH = "8proHTW9m6xZGAYZ82PFx3CsuaNY7LadZNL1g8dfAuS2";
const fakeWallet = (outcome: unknown, thrown?: unknown) =>
  ({
    manifest: {
      name: "Fake wallet",
      features: { testnet: true, signMessage: true },
    },
    getAccounts: async () => [{ accountId: "relayer.testnet" }],
    signAndSendTransaction: async () => {
      if (thrown) throw thrown;
      return outcome;
    },
  }) as unknown as NearWalletBase;

test("a wallet failure that still returns a hash keeps the hash for the re-check", async () => {
  const w = { ...base, to: "payee.testnet" };
  const sig = new Uint8Array(64).fill(1);
  const cases: [string, NearWalletBase][] = [
    [
      "failure outcome",
      fakeWallet({
        status: { Failure: { ActionError: {} } },
        transaction: { hash: HASH },
      }),
    ],
    [
      "incomplete outcome",
      fakeWallet({ status: {}, transaction: { hash: HASH } }),
    ],
    ["outcome without a status", fakeWallet({ transaction: { hash: HASH } })],
    [
      "wallet error naming the hash",
      fakeWallet(null, { message: "timeout", transactionHash: HASH }),
    ],
  ];
  for (const [label, chosen] of cases) {
    const wallet = adaptWallet(chosen, "relayer.testnet", async () => {});
    const sent = await sendWithdrawal(wallet, w, sig);
    assert.equal(sent.hash, HASH, label);
    assert.ok(sent.error, `${label}: the failure is still reported`);
  }
  // A success keeps its hash and reports no error.
  const ok = adaptWallet(
    fakeWallet({ status: { SuccessValue: "" }, transaction: { hash: HASH } }),
    "relayer.testnet",
    async () => {},
  );
  assert.deepEqual(await sendWithdrawal(ok, w, sig), {
    hash: HASH,
    error: null,
  });
  // A wallet error with no usable hash gives none, and nothing is invented.
  const bare = adaptWallet(
    fakeWallet(null, { message: "rejected", transactionHash: "not-a-hash" }),
    "relayer.testnet",
    async () => {},
  );
  const none = await sendWithdrawal(bare, w, sig);
  assert.equal(none.hash, null);
  assert.ok(none.error);
});

test("the call sent is the vault's JSON withdraw with no deposit", async () => {
  const calls: unknown[] = [];
  const sent = await sendWithdrawal(
    {
      async call(c) {
        calls.push(c);
        return { transaction_hash: HASH };
      },
    },
    base,
    new Uint8Array(64).fill(2),
  );
  assert.equal(sent.hash, HASH);
  assert.deepEqual(calls, [
    {
      receiver: base.vault,
      method: "withdraw",
      args: JSON.parse(withdrawArgs(base, new Uint8Array(64).fill(2))),
      deposit: 0n,
      gas: 30n * 10n ** 12n,
    },
  ]);
});
