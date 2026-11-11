// The PR bounty network gate for every route, the read routes' validation and the views they ask
// the contract for. No network and no wallet.
import assert from "node:assert/strict";
import test from "node:test";
import { bountiesRoute, bountyContract } from "./bounties.ts";

const CONTRACT = "pr-bounty.proven-funding.testnet";
const VAULT = `0s${"ab".repeat(20)}`;
const KEY = `ed25519:${"1".repeat(32)}`;

const TERMS = {
  reward: "1000000000000000000000000",
  repo: "proven-test/bounty-pilot",
  repo_id: "800000001",
  issue: 9501,
  base_ref: "main",
  claim_by: "1794310019",
  claim_secs: "3600",
  merge_deadline: "1794313019",
  grace_secs: "600",
};
/** The terms part of a posting-message or posting-digest route. */
const termsPart = (extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      terms: TERMS,
      key: KEY,
      maintainer: "maint.testnet",
      nonce: "a".repeat(64),
      ...extra,
    }),
  ).toString("base64url");
const ROUTES = [
  "/api/market/bounties",
  "/api/market/bounties/poster/maint.testnet",
  "/api/market/bounties/bounty/3",
  "/api/market/bounties/link/contrib.testnet",
  "/api/market/bounties/link-challenge/contrib.testnet/1794300000",
  "/api/market/bounties/link-number/contrib.testnet",
  "/api/market/bounties/github-owner/900000001",
  `/api/market/bounties/claim-message/3/contrib.testnet/900000001/${KEY}/1794300000`,
  `/api/market/bounties/posting-message/${termsPart({ expires_at: "1794300000" })}`,
  `/api/market/bounties/posting-digest/${termsPart()}`,
  `/api/market/bounties/vault-of/${KEY}`,
  "/api/market/bounties/barred/3/contrib.testnet",
  `/api/market/bounties/posted/maint.testnet/${"0".repeat(64)}`,
  `/api/market/bounties/nonce/maint.testnet/${"0".repeat(64)}`,
  `/api/market/bounties/vault/${VAULT}`,
  `/api/market/bounties/slot/${VAULT}/3/Payout`,
  "/api/market/bounties/account/payee.testnet",
  "/api/market/bounties/block",
  `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet/${VAULT}/payee.testnet/1/0`,
];

test("off testnet, every bounty route answers not configured and reads nothing", async () => {
  let calls = 0;
  const transport = (async () => {
    calls++;
    throw new Error("no read expected");
  }) as unknown as typeof fetch;
  for (const network of ["mainnet", "", "betanet", "TESTNET"])
    for (const path of ROUTES)
      assert.deepEqual(
        await bountiesRoute(path, transport, bountyContract(CONTRACT, network)),
        { configured: false },
        `${String(network)} ${path}`,
      );
  assert.equal(calls, 0);
});

/** A fake RPC: `answer(body)` returns the whole JSON-RPC reply. */
function chain(
  answer: (body: {
    method: string;
    params: Record<string, unknown>;
  }) => unknown,
) {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const transport = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    asked.push(body);
    return new Response(JSON.stringify(answer(body)));
  }) as typeof fetch;
  return { asked, transport };
}
const bytes = (b: Uint8Array) => ({
  jsonrpc: "2.0",
  id: "x",
  result: { result: [...b] },
});
const missing = {
  jsonrpc: "2.0",
  id: "x",
  error: { cause: { name: "UNKNOWN_ACCOUNT" } },
};

test("a vault that does not exist yet reads as not existing, never as zero", async () => {
  const { asked, transport } = chain(() => missing);
  assert.deepEqual(
    await bountiesRoute(
      `/api/market/bounties/vault/${VAULT}`,
      transport,
      CONTRACT,
    ),
    { vault: VAULT, exists: false, info: null },
  );
  assert.equal(asked[0]?.params.account_id, VAULT);
  assert.equal(asked[0]?.params.method_name, "info");
  // Any other failure is an error, not an empty vault.
  const broken = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    error: { cause: { name: "TIMEOUT" } },
  }));
  await assert.rejects(
    bountiesRoute(
      `/api/market/bounties/vault/${VAULT}`,
      broken.transport,
      CONTRACT,
    ),
  );
});

test("the vault route decodes the vault's own info view", async () => {
  const info = new Uint8Array(73);
  info[33] = 2; // n = 2
  info[41] = 5; // fund = 5
  info[57] = 9; // available = 9
  const { transport } = chain(() => bytes(info));
  const reply = (await bountiesRoute(
    `/api/market/bounties/vault/${VAULT}`,
    transport,
    CONTRACT,
  )) as {
    info: Record<string, string>;
  };
  assert.deepEqual(
    { n: reply.info.n, fund: reply.info.fund, available: reply.info.available },
    { n: "2", fund: "5", available: "9" },
  );
  assert.equal(reply.info.key, `ed25519:${"1".repeat(32)}`);
  assert.deepEqual(Object.keys(reply.info).sort(), [
    "available",
    "fund",
    "key",
    "n",
  ]);
  // The pilot's two-key view is not this vault's.
  const old = chain(() => bytes(new Uint8Array(106)));
  await assert.rejects(
    bountiesRoute(
      `/api/market/bounties/vault/${VAULT}`,
      old.transport,
      CONTRACT,
    ),
  );
});

test("the slot route asks the vault for this contract's record", async () => {
  const record = new Uint8Array(25);
  record[0] = 1;
  record[1] = 2;
  record[5] = 7;
  const { asked, transport } = chain(() => bytes(record));
  assert.deepEqual(
    await bountiesRoute(
      `/api/market/bounties/slot/${VAULT}/3/Refund`,
      transport,
      CONTRACT,
    ),
    {
      vault: VAULT,
      exists: true,
      record: { deposited: true, attempt: 2, amount: "7", sealed_through: 0 },
    },
  );
  const args = Buffer.from(String(asked[0]?.params.args_base64), "base64");
  assert.equal(args.subarray(4, 4 + CONTRACT.length).toString(), CONTRACT);
  assert.equal(args.at(-1), 1, "kind Refund");
});

test("account, block and nonce routes", async () => {
  const exists = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    result: { amount: "1" },
  }));
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/account/payee.testnet",
      exists.transport,
      CONTRACT,
    ),
    { account: "payee.testnet", exists: true },
  );
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/account/ghost.testnet",
      chain(() => missing).transport,
      CONTRACT,
    ),
    { account: "ghost.testnet", exists: false },
  );
  const block = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    result: { header: { timestamp_nanosec: "1794300000123456789" } },
  }));
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/block",
      block.transport,
      CONTRACT,
    ),
    {
      block_secs: 1794300000,
    },
  );
  const nonce = chain(() => bytes(new TextEncoder().encode("true")));
  assert.deepEqual(
    await bountiesRoute(
      `/api/market/bounties/nonce/maint.testnet/${"a".repeat(64)}`,
      nonce.transport,
      CONTRACT,
    ),
    { used: true },
  );
});

test("malformed route parts are refused before any read", async () => {
  const { asked, transport } = chain(() => missing);
  for (const bad of [
    "/api/market/bounties/vault/0sXYZ",
    "/api/market/bounties/vault/maint.testnet",
    `/api/market/bounties/slot/${VAULT}/x/Payout`,
    `/api/market/bounties/slot/${VAULT}/3/Other`,
    "/api/market/bounties/account/Bad..Account",
    "/api/market/bounties/withdrawal/short/relayer.testnet",
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet`,
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet/${VAULT}/payee.testnet/x/0`,
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.testnet/maint.testnet/payee.testnet/1/0`,
    `/api/market/bounties/nonce/maint.testnet/${"A".repeat(64)}`,
    "/api/market/bounties/bounty/x",
    "/api/market/bounties/bounty/3/extra",
    "/api/market/bounties/link/Bad..Account",
    "/api/market/bounties/link-challenge/contrib.testnet/soon",
    "/api/market/bounties/link-challenge/contrib.testnet",
    "/api/market/bounties/link-number/Bad..Account",
    "/api/market/bounties/link-number/contrib.testnet/extra",
    "/api/market/bounties/github-owner/octocat",
    `/api/market/bounties/claim-message/3/contrib.testnet/900000001/secp256k1:abc/1794300000`,
    `/api/market/bounties/claim-message/3/contrib.testnet/900000001/${KEY}`,
    `/api/market/bounties/claim-message/x/contrib.testnet/900000001/${KEY}/1794300000`,
    "/api/market/bounties/vault-of/secp256k1:abc",
    "/api/market/bounties/barred/3",
    "/api/market/bounties/barred/x/contrib.testnet",
    "/api/market/bounties/posted/maint.testnet/short",
    "/api/market/bounties/posting-digest/not%20base64",
    "/api/market/bounties/posting-digest/e30",
    `/api/market/bounties/posting-digest/${termsPart({ key: "secp256k1:abc" })}`,
    `/api/market/bounties/posting-digest/${termsPart({ nonce: "A".repeat(64) })}`,
    `/api/market/bounties/posting-digest/${termsPart({ maintainer: "Bad Account" })}`,
    `/api/market/bounties/posting-digest/${termsPart({ terms: { ...TERMS, reward: "1e24" } })}`,
    `/api/market/bounties/posting-digest/${termsPart({ terms: { ...TERMS, repo: "no-slash" } })}`,
    `/api/market/bounties/posting-digest/${termsPart({ terms: { ...TERMS, issue: "1" } })}`,
    `/api/market/bounties/posting-digest/${termsPart({ terms: { ...TERMS, issue: 0 } })}`,
    `/api/market/bounties/posting-digest/${termsPart({ terms: { ...TERMS, base_ref: "a\nb" } })}`,
    `/api/market/bounties/posting-digest/${termsPart({ terms: { ...TERMS, contributor_github_id: undefined, claim_secs: undefined } })}`,
    `/api/market/bounties/posting-message/${termsPart()}`,
    "/api/market/bounties/block/extra",
  ])
    await assert.rejects(bountiesRoute(bad, transport, CONTRACT), bad);
  assert.equal(asked.length, 0);
});

test("a withdrawal route answer is classified against the signed fields", async () => {
  const { readFileSync } = await import("node:fs");
  const r = JSON.parse(
    readFileSync(
      new URL(
        "../test-fixtures/sandbox/withdrawal-returned.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const { transport } = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    result: r.status,
  }));
  const route = (fields: { to: string; amount: string; n: string }) =>
    `/api/market/bounties/withdrawal/${"1".repeat(44)}/relayer.test.near/${r.vault}/${fields.to}/${fields.amount}/${fields.n}`;
  const reply = (await bountiesRoute(route(r), transport, CONTRACT)) as {
    outcome: Record<string, string>;
  };
  assert.deepEqual(reply.outcome, {
    kind: "returned",
    amount: r.amount,
    n: "0",
    next: "1",
  });
  // The same transaction checked against another amount is not this withdrawal.
  const other = (await bountiesRoute(
    route({ ...r, amount: "1" }),
    transport,
    CONTRACT,
  )) as { outcome: Record<string, string> };
  assert.equal(other.outcome.kind, "pending");
  const none = chain(() => missing);
  assert.equal(
    (
      (await bountiesRoute(route(r), none.transport, CONTRACT)) as {
        outcome: { kind: string };
      }
    ).outcome.kind,
    "pending",
  );
});
// ---- Views and the arguments they are asked with ----
/** A fake contract whose views answer `answers[method]`, recording every call's arguments. */
function views(answers: Record<string, unknown>) {
  const asked: { method: string; account: string; args: unknown }[] = [];
  const transport = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const method = body.params.method_name as string;
    asked.push({
      method,
      account: body.params.account_id,
      args: JSON.parse(
        Buffer.from(body.params.args_base64, "base64").toString(),
      ),
    });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "x",
        result: { result: [...Buffer.from(JSON.stringify(answers[method]))] },
      }),
    );
  }) as typeof fetch;
  return { asked, transport };
}
const route = (
  path: string,
  answers: Record<string, unknown>,
): Promise<unknown> => {
  const fake = views(answers);
  return bountiesRoute(
    `/api/market/bounties/${path}`,
    fake.transport,
    CONTRACT,
  );
};
const lastAsk = async (path: string, answers: Record<string, unknown>) => {
  const fake = views(answers);
  const reply = await bountiesRoute(
    `/api/market/bounties/${path}`,
    fake.transport,
    CONTRACT,
  );
  assert.equal(fake.asked.length, 1, path);
  return { reply, ask: fake.asked[0]! };
};

test("each new route asks the contract's own view with the contract's argument names", async () => {
  const cases: [string, string, unknown, Record<string, unknown>, unknown][] = [
    [
      "bounty/3",
      "get_bounty",
      { status: "Open" },
      { bounty_id: 3 },
      { bounty: { status: "Open" } },
    ],
    [
      "link/contrib.testnet",
      "get_link",
      { active: null, pending: null },
      { wallet: "contrib.testnet" },
      {
        wallet: "contrib.testnet",
        link: { active: null, pending: null },
      },
    ],
    [
      "link-challenge/contrib.testnet/1794300000",
      "link_challenge",
      "proven-link:abc",
      { wallet: "contrib.testnet", expires_at: "1794300000" },
      { challenge: "proven-link:abc" },
    ],
    [
      "link-number/contrib.testnet",
      "get_link_number",
      "3",
      { wallet: "contrib.testnet" },
      { wallet: "contrib.testnet", number: "3" },
    ],
    [
      "github-owner/900000001",
      "github_owner_of",
      "owner.testnet",
      { github_id: "900000001" },
      { github_id: "900000001", wallet: "owner.testnet" },
    ],
    [
      `claim-message/3/contrib.testnet/900000001/${KEY}/1794300000`,
      "claim_key_message",
      "the text",
      {
        bounty_id: 3,
        wallet: "contrib.testnet",
        github_id: "900000001",
        key: KEY,
        expires_at: "1794300000",
      },
      { message: "the text" },
    ],
    [
      `vault-of/${KEY}`,
      "vault_of",
      VAULT,
      { key: KEY },
      { key: KEY, vault: VAULT },
    ],
    [
      "barred/3/contrib.testnet",
      "is_barred",
      true,
      { bounty_id: 3, wallet: "contrib.testnet" },
      { barred: true },
    ],
  ];
  for (const [path, method, answer, args, expected] of cases) {
    const { reply, ask } = await lastAsk(path, { [method]: answer });
    assert.equal(ask.method, method, path);
    assert.equal(ask.account, CONTRACT, path);
    assert.deepEqual(ask.args, args, path);
    assert.deepEqual(reply, expected, path);
  }
  // A GitHub id that no wallet holds is reported as no wallet, not as an error.
  assert.deepEqual(
    (await lastAsk("github-owner/900000001", { github_owner_of: null })).reply,
    { github_id: "900000001", wallet: null },
  );
});

test("posting views are asked with the exact terms, the key, the maintainer and the nonce", async () => {
  const wanted = {
    terms: TERMS,
    key: KEY,
    maintainer: "maint.testnet",
    nonce: "a".repeat(64),
  };
  const digest = await lastAsk(`posting-digest/${termsPart()}`, {
    posting_terms_digest: "d".repeat(64),
  });
  assert.equal(digest.ask.method, "posting_terms_digest");
  assert.deepEqual(digest.ask.args, wanted);
  assert.deepEqual(digest.reply, { digest: "d".repeat(64) });
  const message = await lastAsk(
    `posting-message/${termsPart({ expires_at: "1794300000" })}`,
    { posting_key_message: "the text" },
  );
  assert.equal(message.ask.method, "posting_key_message");
  assert.deepEqual(message.ask.args, { ...wanted, expires_at: "1794300000" });
  assert.deepEqual(message.reply, { message: "the text" });
  // Fields the contract does not take are dropped, never forwarded.
  const extra = await lastAsk(
    `posting-digest/${termsPart({ stray: "x", terms: { ...TERMS, stray: 1 } })}`,
    { posting_terms_digest: "d" },
  );
  assert.deepEqual(extra.ask.args, wanted);
  // The message needs its expiry.
  await assert.rejects(
    route(`posting-message/${termsPart()}`, { posting_key_message: "x" }),
  );
});

test("the old two-key claim challenge route no longer exists", async () => {
  const fake = views({});
  await assert.rejects(
    bountiesRoute(
      `/api/market/bounties/challenge/3/contrib.testnet/1794300000/${KEY}/${KEY}`,
      fake.transport,
      CONTRACT,
    ),
    /Route not found/,
  );
  assert.equal(fake.asked.length, 0);
});

test("a posted bounty is found by maintainer and nonce across pages, or reported as none", async () => {
  const nonce = "b".repeat(64);
  const row = (id: number, buyer: string, posting_nonce: string) => [
    id,
    { buyer, posting_nonce },
  ];
  const pages: unknown[][] = [
    Array.from({ length: 50 }, (_, i) =>
      row(i, "other.testnet", "0".repeat(64)),
    ),
    [row(50, "maint.testnet", "0".repeat(64)), row(51, "maint.testnet", nonce)],
  ];
  const fake = (() => {
    const asked: { from_id: number; limit: number }[] = [];
    const transport = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const args = JSON.parse(
        Buffer.from(body.params.args_base64, "base64").toString(),
      );
      asked.push(args);
      const answer = pages[args.from_id / 50] ?? [];
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: { result: [...Buffer.from(JSON.stringify(answer))] },
        }),
      );
    }) as typeof fetch;
    return { asked, transport };
  })();
  const path = (maintainer: string, n: string) =>
    `/api/market/bounties/posted/${maintainer}/${n}`;
  assert.deepEqual(
    await bountiesRoute(path("maint.testnet", nonce), fake.transport, CONTRACT),
    { id: 51 },
  );
  assert.deepEqual(fake.asked, [
    { from_id: 0, limit: 50 },
    { from_id: 50, limit: 50 },
  ]);
  // The same nonce under another maintainer is not this posting.
  assert.deepEqual(
    await bountiesRoute(
      path("other2.testnet", nonce),
      fake.transport,
      CONTRACT,
    ),
    { id: null },
  );
});

test("a failed view is an error, never an empty answer", async () => {
  const failing = chain(() => ({
    jsonrpc: "2.0",
    id: "x",
    error: { cause: { name: "TIMEOUT_ERROR" } },
  }));
  for (const path of [
    "bounty/3",
    "link/contrib.testnet",
    "barred/3/contrib.testnet",
    `vault-of/${KEY}`,
  ])
    await assert.rejects(
      bountiesRoute(
        `/api/market/bounties/${path}`,
        failing.transport,
        CONTRACT,
      ),
      path,
    );
});
