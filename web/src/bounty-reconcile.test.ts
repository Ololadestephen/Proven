// Whether a journaled PR bounty call took effect, decided from chain snapshots, and the signing
// guard around it. A fake chain applies calls; a fake wallet can throw after the chain applied
// one. No network and no real wallet.
import assert from "node:assert/strict";
import test from "node:test";
import {
  bountyReconciled,
  bountySnapshotText,
  parseBountySnapshot,
  readBountySnapshot,
  type BountyIntent,
  type BountyReader,
  type BountySnapshot,
  type BountyView,
  type WalletLinkView,
} from "../ui/bounty-reconcile.ts";
import {
  BOUNTY_PENDING_KEY,
  DefinitiveWalletFailure,
  IncompleteWalletOutcome,
  PENDING_KEY,
  bountyActionReconciled,
  journalCall,
  type PendingAction,
} from "../ui/action-guard.ts";
import {
  guardedBountyCall,
  readJournal,
  reconcileBountyPending,
  releaseUnappliedBounty,
} from "../ui/pending-actions.ts";
import type { Call } from "../ui/market-types.ts";

const ME = "contrib.testnet";
const MAINT = "maint.testnet";
const KEY = "ed25519:6W6SaZv5FcUXp3G7SZP9o21hCudRJKTXqP9QZy4JhffW";
const VAULT = `0s${"ab".repeat(20)}`;
const NONCE = "a".repeat(64);

const bounty = (over: Partial<BountyView> = {}): BountyView => ({
  buyer: MAINT,
  status: "Open",
  posting_nonce: NONCE,
  claim: null,
  binding: null,
  live: null,
  last_check: null,
  payout: null,
  refund: null,
  ...over,
});
const claimed = (over: Partial<BountyView> = {}) =>
  bounty({
    status: "Claimed",
    claim: { wallet: ME, key: KEY, claimed_at: "100" },
    ...over,
  });
const settlement = (over: Record<string, unknown> = {}) => ({
  state: "InFlight",
  attempt: 1,
  outcome: "Unknown",
  reconcile: null,
  done_by: null,
  ...over,
});
const snap = (over: Partial<BountySnapshot> = {}): BountySnapshot => ({
  bounty: null,
  link: null,
  nonceUsed: null,
  postedId: null,
  vaultN: null,
  barred: null,
  ...over,
});
const intent = (
  method: string,
  args: Record<string, unknown> = {},
  over: Partial<BountyIntent> = {},
): BountyIntent => ({
  account: ME,
  receiver: "pr-bounty.testnet",
  method,
  args,
  bountyId: 3,
  ...over,
});
const link = (gist: string, github = "900000001") => ({
  gist_id: gist,
  github_id: github,
});
const links = (
  active: ReturnType<typeof link> | null,
  pending: ReturnType<typeof link> | null = null,
): WalletLinkView => ({
  active,
  pending: pending && { link: pending, activates_at: "9" },
});

test("post_bounty took effect only when this nonce is newly used or a bounty carries it", () => {
  const i = intent(
    "post_bounty",
    { proof: { nonce: NONCE } },
    {
      account: MAINT,
      bountyId: null,
    },
  );
  const before = snap({ nonceUsed: false, postedId: null });
  assert.equal(bountyReconciled(i, before, before), false);
  assert.equal(
    bountyReconciled(i, before, snap({ nonceUsed: true, postedId: null })),
    true,
  );
  assert.equal(
    bountyReconciled(i, before, snap({ nonceUsed: false, postedId: 7 })),
    true,
  );
  // A nonce used before the call cannot have been this call.
  assert.equal(
    bountyReconciled(
      i,
      snap({ nonceUsed: true }),
      snap({ nonceUsed: true, postedId: 7 }),
    ),
    false,
  );
});

test("link took effect when its gist is the active or the waiting link", () => {
  const i = intent(
    "link",
    { gist_id: "abc123", expires_at: "9" },
    {
      bountyId: null,
    },
  );
  const none = snap({ link: null });
  assert.equal(bountyReconciled(i, none, none), false);
  assert.equal(
    bountyReconciled(i, none, snap({ link: links(link("abc123")) })),
    true,
  );
  assert.equal(
    bountyReconciled(
      i,
      snap({ link: links(link("old000")) }),
      snap({ link: links(link("old000"), link("abc123", "900000002")) }),
    ),
    true,
    "a changed link waiting for its delay is also an effect",
  );
  assert.equal(
    bountyReconciled(
      i,
      snap({ link: links(link("old000")) }),
      snap({ link: links(link("old000")) }),
    ),
    false,
  );
  // A gist that was already the link before cannot be this call's effect.
  const had = snap({ link: links(link("abc123")) });
  assert.equal(bountyReconciled(i, had, had), false);
  assert.equal(
    bountyReconciled(intent("link", {}, { bountyId: null }), none, had),
    false,
  );
});

test("activate_link, confirm_link_change and cancel_link_change are read from the link", () => {
  const waiting = snap({ link: links(link("old000"), link("new111", "2")) });
  const activated = snap({ link: links(link("new111", "2")) });
  const cancelled = snap({ link: links(link("old000")) });
  for (const method of ["activate_link", "confirm_link_change"]) {
    const i = intent(method, { wallet: ME }, { bountyId: null });
    assert.equal(bountyReconciled(i, waiting, waiting), false, method);
    assert.equal(bountyReconciled(i, waiting, activated), true, method);
    assert.equal(bountyReconciled(i, waiting, cancelled), false, method);
  }
  const cancel = intent(
    "cancel_link_change",
    { wallet: ME },
    { bountyId: null },
  );
  assert.equal(bountyReconciled(cancel, waiting, cancelled), true);
  assert.equal(bountyReconciled(cancel, waiting, activated), false);
  assert.equal(bountyReconciled(cancel, waiting, waiting), false);
  assert.equal(bountyReconciled(cancel, cancelled, cancelled), false);
});

test("claim took effect when this wallet holds the claim with this key, or has since been barred", () => {
  const i = intent("claim", { bounty_id: 3, key: KEY });
  const before = snap({ bounty: bounty(), barred: false });
  assert.equal(bountyReconciled(i, before, before), false);
  assert.equal(
    bountyReconciled(i, before, snap({ bounty: claimed(), barred: false })),
    true,
  );
  // Another wallet's claim, or a claim with another key, is not this call.
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: bounty({
          status: "Claimed",
          claim: { wallet: "other.testnet", key: KEY, claimed_at: "100" },
        }),
      }),
    ),
    false,
  );
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: bounty({
          status: "Claimed",
          claim: { wallet: ME, key: "ed25519:other", claimed_at: "100" },
        }),
      }),
    ),
    false,
  );
  // The claim already ended (released or expired) before the page looked again.
  assert.equal(
    bountyReconciled(i, before, snap({ bounty: bounty(), barred: true })),
    true,
  );
  // A claim that was already there before is not this call.
  const had = snap({ bounty: claimed(), barred: false });
  assert.equal(bountyReconciled(i, had, had), false);
});

test("release_claim, revoke_claim and expire_claim took effect when the claim is gone", () => {
  for (const method of ["release_claim", "revoke_claim", "expire_claim"]) {
    const i = intent(method, { bounty_id: 3 });
    const before = snap({ bounty: claimed() });
    assert.equal(bountyReconciled(i, before, before), false, method);
    assert.equal(
      bountyReconciled(i, before, snap({ bounty: bounty() })),
      true,
      method,
    );
    // Someone else claimed after: the earlier claim is gone all the same.
    assert.equal(
      bountyReconciled(
        i,
        before,
        snap({
          bounty: claimed({
            claim: { wallet: "next.testnet", key: KEY, claimed_at: "300" },
          }),
        }),
      ),
      false,
      "a status that is not Open is not this call",
    );
    assert.equal(
      bountyReconciled(
        i,
        snap({ bounty: bounty() }),
        snap({ bounty: bounty() }),
      ),
      false,
      "nothing to end",
    );
  }
});

test("submit_pr took effect when the pull request is bound, a run is live or a submit check is recorded", () => {
  const i = intent("submit_pr", { bounty_id: 3, pr_number: 12 });
  const before = snap({ bounty: claimed() });
  assert.equal(bountyReconciled(i, before, before), false);
  const bound = claimed({
    status: "Bound",
    binding: { pr_number: 12, wallet: ME },
  });
  assert.equal(bountyReconciled(i, before, snap({ bounty: bound })), true);
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: claimed({
          status: "Bound",
          binding: { pr_number: 13, wallet: ME },
        }),
      }),
    ),
    false,
    "another pull request",
  );
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: claimed({ live: { seq: "5", kind: "Submit", pr_number: 12 } }),
      }),
    ),
    true,
    "the check is running",
  );
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: claimed({
          last_check: {
            seq: "5",
            kind: "submit",
            outcome: "mismatch:author_id",
          },
        }),
      }),
    ),
    true,
    "the check came back with a mismatch",
  );
  // A check recorded before the call is not its effect.
  const old = snap({
    bounty: claimed({
      last_check: { seq: "4", kind: "submit", outcome: "no_result:stale" },
    }),
  });
  assert.equal(bountyReconciled(i, old, old), false);
  assert.equal(
    bountyReconciled(i, before, snap({ bounty: null })),
    false,
    "an unreadable bounty is not an effect",
  );
});

test("check_merge took effect when a run is live, last_check advanced or the status changed", () => {
  const i = intent("check_merge", { bounty_id: 3 });
  const bound = bounty({
    status: "Bound",
    binding: { pr_number: 12, wallet: ME },
    last_check: { seq: "5", kind: "submit", outcome: "bound" },
  });
  const before = snap({ bounty: bound });
  assert.equal(bountyReconciled(i, before, before), false);
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: { ...bound, live: { seq: "6", kind: "Merge", pr_number: 12 } },
      }),
    ),
    true,
  );
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: {
          ...bound,
          last_check: { seq: "6", kind: "merge", outcome: "pending" },
        },
      }),
    ),
    true,
  );
  assert.equal(
    bountyReconciled(i, before, snap({ bounty: { ...bound, status: "Paid" } })),
    true,
  );
  // The submit check that is still the last record is not a merge check.
  assert.equal(
    bountyReconciled(
      i,
      before,
      snap({
        bounty: { ...bound, live: { seq: "5", kind: "Merge", pr_number: 12 } },
      }),
    ),
    false,
  );
});

test("settle and cancel took effect when the status changed", () => {
  const settle = intent("settle", { bounty_id: 3 });
  const open = snap({ bounty: bounty() });
  assert.equal(bountyReconciled(settle, open, open), false);
  assert.equal(
    bountyReconciled(
      settle,
      open,
      snap({
        bounty: bounty({ status: "Refunded", refund: settlement() as never }),
      }),
    ),
    true,
  );
  const cancel = intent("cancel", { bounty_id: 3 }, { account: MAINT });
  assert.equal(bountyReconciled(cancel, open, open), false);
  assert.equal(
    bountyReconciled(
      cancel,
      open,
      snap({ bounty: bounty({ status: "Cancelled" }) }),
    ),
    true,
  );
  assert.equal(
    bountyReconciled(
      cancel,
      open,
      snap({ bounty: bounty({ status: "Refunded" }) }),
    ),
    false,
    "only Cancelled is cancel's effect",
  );
});

test("send_due, recover_settlement and reconcile took effect when the settlement moved", () => {
  const due = snap({
    bounty: bounty({
      status: "Paid",
      payout: settlement({
        state: "Due",
        attempt: 1,
        outcome: "Failed",
      }) as never,
    }),
  });
  const sent = snap({
    bounty: bounty({
      status: "Paid",
      payout: settlement({ state: "InFlight", attempt: 2 }) as never,
    }),
  });
  const send = intent("send_due", { bounty_id: 3 });
  assert.equal(bountyReconciled(send, due, due), false);
  assert.equal(bountyReconciled(send, due, sent), true);
  const done = snap({
    bounty: bounty({
      status: "Paid",
      payout: settlement({
        state: "Done",
        attempt: 2,
        outcome: "Succeeded",
      }) as never,
    }),
  });
  const reconcile = intent("reconcile", {
    bounty_id: 3,
    kind: "Payout",
    attempt: 2,
  });
  assert.equal(bountyReconciled(reconcile, sent, sent), false);
  assert.equal(bountyReconciled(reconcile, sent, done), true);
  const marked = snap({
    bounty: bounty({
      status: "Paid",
      payout: settlement({
        attempt: 2,
        reconcile: { attempt: 2, started_at: "9" },
      }) as never,
    }),
  });
  assert.equal(bountyReconciled(reconcile, sent, marked), true);
  const recover = intent("recover_settlement", {
    bounty_id: 3,
    kind: "Payout",
  });
  assert.equal(bountyReconciled(recover, sent, done), true);
  // The refund moving is not the payout's reconcile.
  const refundMoved = snap({
    bounty: bounty({
      status: "Paid",
      payout: sent.bounty!.payout,
      refund: settlement({ state: "Done" }) as never,
    }),
  });
  assert.equal(bountyReconciled(reconcile, sent, refundMoved), false);
  assert.equal(
    bountyReconciled(
      intent("reconcile", { bounty_id: 3, kind: "Other" }),
      sent,
      done,
    ),
    false,
  );
  assert.equal(bountyReconciled(send, snap(), done), false);
});

test("withdraw took effect when the vault's number advanced", () => {
  const i = intent(
    "withdraw",
    { to: "payee.testnet" },
    {
      receiver: VAULT,
      bountyId: null,
    },
  );
  assert.equal(
    bountyReconciled(i, snap({ vaultN: "2" }), snap({ vaultN: "2" })),
    false,
  );
  assert.equal(
    bountyReconciled(i, snap({ vaultN: "2" }), snap({ vaultN: "3" })),
    true,
  );
  assert.equal(
    bountyReconciled(i, snap({ vaultN: "2" }), snap({ vaultN: null })),
    false,
  );
  assert.equal(
    bountyReconciled(i, snap({ vaultN: "2" }), snap({ vaultN: "x" })),
    false,
  );
});

test("an unknown method is never taken as applied", () => {
  assert.equal(bountyReconciled(intent("transfer"), snap(), snap()), false);
});

test("snapshots round-trip through the journal text, and bad text is not a snapshot", () => {
  const s = snap({ bounty: claimed(), barred: false, vaultN: "4" });
  assert.deepEqual(parseBountySnapshot(bountySnapshotText(s)), s);
  for (const bad of ["", "not json", "{}", "[1,2]"])
    assert.equal(parseBountySnapshot(bad), null, bad);
});

// ---- A fake chain, reader and wallet ----
interface Chain {
  bounties: Record<number, BountyView>;
  links: Record<string, WalletLinkView>;
  nonces: Set<string>;
  posted: Record<string, number>;
  vaultN: Record<string, string>;
  barred: Set<string>;
  reads: number;
}
const chain = (): Chain => ({
  bounties: { 3: bounty() },
  links: {},
  nonces: new Set(),
  posted: {},
  vaultN: { [VAULT]: "0" },
  barred: new Set(),
  reads: 0,
});
const readerOf = (c: Chain): BountyReader => ({
  bounty: async (id) => (c.reads++, structuredClone(c.bounties[id] ?? null)),
  link: async (w) => (c.reads++, structuredClone(c.links[w] ?? null)),
  nonceUsed: async (m, n) => (c.reads++, c.nonces.has(`${m}/${n}`)),
  postedByNonce: async (m, n) => (c.reads++, c.posted[`${m}/${n}`] ?? null),
  vaultN: async (v) => (c.reads++, c.vaultN[v] ?? null),
  barred: async (id, w) => (c.reads++, c.barred.has(`${id}/${w}`)),
});
/** What the chain does with each call, as far as the views show it. */
function apply(c: Chain, who: string, call: Call) {
  const a = call.args;
  if (call.method === "claim")
    c.bounties[3] = claimed({
      claim: { wallet: who, key: String(a.key), claimed_at: "200" },
    });
  else if (call.method === "post_bounty") {
    const nonce = String((a.proof as { nonce: string }).nonce);
    c.nonces.add(`${who}/${nonce}`);
    c.posted[`${who}/${nonce}`] = 9;
  } else if (call.method === "withdraw") c.vaultN[call.receiver] = "1";
  else if (call.method === "release_claim") c.bounties[3] = bounty();
  else throw new Error(`the fake chain does not know ${call.method}`);
}
const store = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};
const lockManager = () => {
  let locked = false;
  return {
    request: async (
      _name: string,
      _options: unknown,
      callback: (value: object | null) => Promise<unknown>,
    ) => {
      if (locked) return callback(null);
      locked = true;
      try {
        return await callback({});
      } finally {
        locked = false;
      }
    },
  } as LockManager;
};
async function setup(
  who: string,
  method: string,
  args: Record<string, unknown>,
  over: { c?: Chain; bountyId?: number | null; receiver?: string } = {},
) {
  const c = over.c ?? chain();
  const reader = readerOf(c);
  const receiver = over.receiver ?? "pr-bounty.testnet";
  const bountyId = over.bountyId === undefined ? 3 : over.bountyId;
  const i: BountyIntent = { account: who, receiver, method, args, bountyId };
  const before = await readBountySnapshot(reader, i);
  const marker: PendingAction = {
    account: who,
    bountyId,
    before: bountySnapshotText(before),
    label: method,
    createdAt: 1,
  };
  const call: Call = { receiver, method, args, deposit: 0n, gas: 1n };
  const storage = store();
  const changes: (PendingAction | null)[] = [];
  const env = {
    locks: lockManager(),
    storage,
    marker,
    call,
    readSnapshot: () => readBountySnapshot(reader, i),
    onFresh: () => {},
    onPending: (p: PendingAction | null) => void changes.push(p),
  };
  return { c, reader, i, env, storage, changes, marker, call };
}

test("the reader reads only what the call can change, and a failed read stops the action", async () => {
  const c = chain();
  const reader = readerOf(c);
  const claim = await readBountySnapshot(reader, intent("claim", { key: KEY }));
  assert.equal(claim.bounty?.status, "Open");
  assert.equal(claim.barred, false);
  assert.equal(claim.vaultN, null);
  const post = await readBountySnapshot(
    reader,
    intent("post_bounty", { proof: { nonce: NONCE } }, { bountyId: null }),
  );
  assert.deepEqual(
    [post.bounty, post.nonceUsed, post.postedId],
    [null, false, null],
  );
  const withdraw = await readBountySnapshot(
    reader,
    intent("withdraw", {}, { receiver: VAULT, bountyId: null }),
  );
  assert.equal(withdraw.vaultN, "0");
  const linked = await readBountySnapshot(
    reader,
    intent("link", { gist_id: "a" }, { bountyId: null }),
  );
  assert.equal(linked.link, null);
  await assert.rejects(
    readBountySnapshot(reader, intent("claim", {}, { bountyId: null })),
    /bounty number/,
  );
  await assert.rejects(
    readBountySnapshot(reader, intent("post_bounty", {}, { bountyId: null })),
    /nonce/,
  );
  await assert.rejects(
    readBountySnapshot(reader, intent("transfer")),
    /Unknown/,
  );
  const broken: BountyReader = {
    ...reader,
    bounty: async () => {
      throw new Error("The bounty could not be read.");
    },
  };
  await assert.rejects(
    readBountySnapshot(broken, intent("settle")),
    /could not be read/,
  );
});

test("a wallet that throws after the chain applied the claim leaves the call journaled, and the chain read clears it", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  let sends = 0;
  const send = async (call: Call) => {
    sends++;
    apply(t.c, ME, call);
    throw new Error("The wallet lost its connection.");
  };
  await assert.rejects(
    guardedBountyCall({ ...t.env, send }),
    /lost its connection/,
  );
  assert.equal(sends, 1);
  const saved = readJournal(t.storage, BOUNTY_PENDING_KEY) as PendingAction;
  assert.equal(saved.call?.method, "claim");
  assert.equal(saved.bountyId, 3);
  assert.equal(
    t.storage.getItem(PENDING_KEY),
    null,
    "the job board journal is untouched",
  );
  // The journal is not cleared by the error, so a second click cannot send again.
  await assert.rejects(guardedBountyCall({ ...t.env, send }), /earlier action/);
  assert.equal(sends, 1);
  // Reading the chain finds the claim and clears the journal. Nothing was sent.
  const now = await readBountySnapshot(readerOf(t.c), t.i);
  assert.equal(bountyActionReconciled(saved, now), true);
  await reconcileBountyPending(t.env, saved, now);
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
  assert.equal(t.changes.at(-1), null);
  assert.equal(sends, 1);
});

test("an incomplete outcome and a hash-only result both stay journaled until the chain shows the effect", async () => {
  const t = await setup(
    MAINT,
    "post_bounty",
    { proof: { nonce: NONCE } },
    {
      bountyId: null,
    },
  );
  let sends = 0;
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      send: async (call) => {
        sends++;
        apply(t.c, MAINT, call);
        throw new IncompleteWalletOutcome("not confirmed", "H".repeat(44));
      },
    }),
    /not confirmed/,
  );
  const saved = readJournal(t.storage, BOUNTY_PENDING_KEY) as PendingAction;
  const now = await readBountySnapshot(readerOf(t.c), t.i);
  assert.equal(bountyActionReconciled(saved, now), true);
  await reconcileBountyPending(t.env, saved, now);
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
  assert.equal(sends, 1);
});

test("a wallet that throws before the chain applied anything stays journaled until a read shows no effect and the person releases it", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  let sends = 0;
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      send: async () => {
        sends++;
        throw new Error("timeout");
      },
    }),
    /timeout/,
  );
  const saved = readJournal(t.storage, BOUNTY_PENDING_KEY) as PendingAction;
  const now = await readBountySnapshot(readerOf(t.c), t.i);
  // Nothing happened on chain: reconcile keeps the journal.
  await reconcileBountyPending(t.env, saved, now);
  assert.ok(t.storage.getItem(BOUNTY_PENDING_KEY));
  // Only the person's explicit release clears it, and only when the chain shows no effect.
  assert.equal(await releaseUnappliedBounty(t.env, saved, now), true);
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
  assert.equal(sends, 1);
});

test("release refuses to clear a call whose effect is on chain", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      send: async (call) => {
        apply(t.c, ME, call);
        throw new Error("timeout");
      },
    }),
  );
  const saved = readJournal(t.storage, BOUNTY_PENDING_KEY) as PendingAction;
  const now = await readBountySnapshot(readerOf(t.c), t.i);
  assert.equal(await releaseUnappliedBounty(t.env, saved, now), false);
  assert.ok(t.storage.getItem(BOUNTY_PENDING_KEY));
});

test("a definite wallet failure clears the journal, so the person may try again", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      send: async () => {
        throw new DefinitiveWalletFailure("The account changed.");
      },
    }),
  );
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
  assert.equal(t.changes.at(-1), null);
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      send: async () => {
        throw { code: 4001 };
      },
    }),
  );
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
});

test("a second click while the first call is journaled is refused before the wallet is asked", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  const send = async (call: Call) => {
    asked++;
    await wait;
    apply(t.c, ME, call);
    return { transaction_hash: "A".repeat(44) };
  };
  const first = guardedBountyCall({ ...t.env, send });
  await new Promise((resolve) => setImmediate(resolve));
  // Same tab, first call still waiting on the wallet: the lock refuses.
  await assert.rejects(guardedBountyCall({ ...t.env, send }), /Another tab/);
  release();
  assert.deepEqual(await first, { transaction_hash: "A".repeat(44) });
  // The result is unobserved so far: the journal stays and refuses a second call.
  await assert.rejects(guardedBountyCall({ ...t.env, send }), /earlier action/);
  assert.equal(asked, 1);
});

test("a stale page does not reach the wallet", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  // Someone else claimed after the page was read.
  t.c.bounties[3] = bounty({
    status: "Claimed",
    claim: { wallet: "other.testnet", key: KEY, claimed_at: "150" },
  });
  let asked = 0;
  let fresh: BountySnapshot | null = null;
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      onFresh: (s) => (fresh = s),
      send: async () => {
        asked++;
      },
    }),
    /bounty changed/,
  );
  assert.equal(asked, 0);
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
  assert.equal((fresh as BountySnapshot | null)?.bounty?.status, "Claimed");
});

test("an unreadable chain stops the action before the journal is written", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  let asked = 0;
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      readSnapshot: async () => {
        throw new Error("The bounty could not be read.");
      },
      send: async () => {
        asked++;
      },
    }),
    /could not be read/,
  );
  assert.equal(asked, 0);
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
});

test("without Web Locks nothing is signed", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  let asked = 0;
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      locks: undefined as unknown as LockManager,
      send: async () => {
        asked++;
      },
    }),
    /cannot safely guard/,
  );
  assert.equal(asked, 0);
});

test("the withdrawal journal clears when the vault's number advanced, and not before", async () => {
  const t = await setup(
    ME,
    "withdraw",
    { to: "payee.testnet", n: "0" },
    {
      bountyId: null,
      receiver: VAULT,
    },
  );
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      send: async (call) => {
        apply(t.c, ME, call);
        throw new Error("The wallet closed.");
      },
    }),
  );
  const saved = readJournal(t.storage, BOUNTY_PENDING_KEY) as PendingAction;
  assert.equal(saved.call?.receiver, VAULT);
  const early = snap({ vaultN: "0" });
  await reconcileBountyPending(t.env, saved, early);
  assert.ok(t.storage.getItem(BOUNTY_PENDING_KEY));
  await reconcileBountyPending(t.env, saved, snap({ vaultN: "1" }));
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
});

test("a stale reconciliation cannot erase a newer bounty journal", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  const old = journalCall(t.marker, t.call);
  const next = { ...old, createdAt: 2 };
  t.storage.setItem(BOUNTY_PENDING_KEY, JSON.stringify(next));
  apply(t.c, ME, t.call);
  const now = await readBountySnapshot(readerOf(t.c), t.i);
  await reconcileBountyPending(t.env, old, now);
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), JSON.stringify(next));
  await reconcileBountyPending(t.env, next, now);
  assert.equal(t.storage.getItem(BOUNTY_PENDING_KEY), null);
});

test("a journal that cannot be read blocks new actions and is never treated as applied", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  t.storage.setItem(BOUNTY_PENDING_KEY, "{not json");
  const placeholder = readJournal(
    t.storage,
    BOUNTY_PENDING_KEY,
  ) as PendingAction;
  assert.equal(placeholder.account, "unknown");
  assert.equal(bountyActionReconciled(placeholder, snap()), false);
  let asked = 0;
  await assert.rejects(
    guardedBountyCall({
      ...t.env,
      send: async () => {
        asked++;
      },
    }),
    /earlier action/,
  );
  assert.equal(asked, 0);
  assert.equal(readJournal(store(), BOUNTY_PENDING_KEY), null);
});

test("the bounty journal and the job board journal do not block each other", async () => {
  const t = await setup(ME, "claim", { bounty_id: 3, key: KEY });
  t.storage.setItem(PENDING_KEY, JSON.stringify({ account: ME }));
  let asked = 0;
  await guardedBountyCall({
    ...t.env,
    send: async (call) => {
      asked++;
      apply(t.c, ME, call);
    },
  });
  assert.equal(asked, 1);
});
