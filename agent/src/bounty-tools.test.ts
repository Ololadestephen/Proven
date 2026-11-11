import assert from "node:assert/strict";
import test from "node:test";
import {
  bountyEnv,
  bountyTools,
  executeBountyTool,
  isBountyTool,
  nearText,
  type BountyEnv,
} from "./bounty-tools.ts";
import { tools } from "./service.ts";

const NOW = 1_800_000_000;
const WALLET = "alice.near";
const bounty = (over: Record<string, unknown> = {}) => ({
  buyer: "maint.near",
  reward: "50000000000000000000000",
  sponsored_runs: 0,
  repo: "acme/widgets",
  repo_id: "777",
  issue: 12,
  base_ref: "main",
  claim_by: String(NOW + 3600),
  merge_deadline: String(NOW + 86_400),
  grace_secs: "3600",
  status: "Open",
  claim: null,
  binding: null,
  merge: null,
  live: null,
  last_check: null,
  ...over,
});
const claimed = {
  wallet: WALLET,
  github_id: "42",
  claimed_at: "0",
  ends_at: String(NOW + 7200),
};
const bound = {
  pr_number: 9,
  pr_id: "5",
  author_id: "42",
  wallet: WALLET,
  request_id: "21183",
};

interface World {
  bounties?: Record<number, unknown>;
  link?: unknown;
  barred?: boolean;
  github?: { status?: number; body?: unknown };
}
function fakeEnv(world: World): { env: BountyEnv; urls: string[] } {
  const urls: string[] = [];
  const reply = (value: unknown) =>
    new Response(
      JSON.stringify({
        result: { result: [...Buffer.from(JSON.stringify(value))] },
      }),
    );
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    if (String(url).startsWith("https://api.github.com")) {
      return new Response(JSON.stringify(world.github?.body ?? {}), {
        status: world.github?.status ?? 200,
      });
    }
    const params = JSON.parse(String(init?.body)).params;
    const args = JSON.parse(
      Buffer.from(params.args_base64, "base64").toString(),
    );
    switch (params.method_name) {
      case "get_bounties": {
        const rows = Object.entries(world.bounties ?? {})
          .map(([k, v]) => [Number(k), v] as const)
          .filter(([k]) => k >= args.from_id)
          .slice(0, args.limit);
        return reply(rows);
      }
      case "get_bounty":
        return reply(world.bounties?.[args.bounty_id] ?? null);
      case "get_link":
        return reply(world.link ?? null);
      case "is_barred":
        return reply(world.barred ?? false);
      case "get_config":
        return reply({ sponsored_runs_per_bounty: 3 });
      default:
        throw new Error("unexpected view");
    }
  };
  const env = bountyEnv({}, { fetch: fake as typeof fetch, now: () => NOW });
  return { env, urls };
}
const linked = {
  active: { github_id: "42", gist_id: "g", linked_at: "1700000000000000000" },
  pending: null,
};

test("tools are registered in the shared service and recognised", () => {
  assert.equal(bountyTools.length, 9);
  for (const tool of bountyTools) {
    assert.ok(isBountyTool(tool.name));
    assert.ok(tools.some((t) => t.name === tool.name));
  }
  assert.equal(isBountyTool("post_bid"), false);
});

test("environment defaults to mainnet and configures contract, rpc and web", () => {
  const env = bountyEnv({});
  assert.equal(env.contract, "proven-bounties.near");
  assert.equal(env.network, "mainnet");
  assert.match(env.rpc, /mainnet/);
  assert.equal(env.webUrl, "https://useproven.xyz");
  const custom = bountyEnv({
    NEAR_NETWORK: "testnet",
    PROVEN_PR_BOUNTY_CONTRACT: "b.testnet",
    PROVEN_BOUNTY_RPC_URL: "https://rpc.example/",
    PROVEN_WEB_URL: "https://web.example/",
  });
  assert.equal(custom.contract, "b.testnet");
  assert.equal(custom.webUrl, "https://web.example");
  assert.throws(() => bountyEnv({ NEAR_NETWORK: "testnet" }), /contract/);
  assert.throws(() => bountyEnv({ NEAR_NETWORK: "dev" }), /network/);
  assert.throws(() => bountyEnv({ PROVEN_BOUNTY_RPC_URL: "http://x.example" }));
});

test("nearText prints exact amounts", () => {
  assert.equal(nearText("50000000000000000000000"), "0.05");
  assert.equal(nearText("2000000000000000000000000"), "2");
});

test("bounty_list shows open bounties by default, with UTC deadlines and links", async () => {
  const { env } = fakeEnv({
    bounties: { 0: bounty(), 1: bounty({ status: "Paid" }), 2: bounty() },
  });
  const out = (await executeBountyTool("bounty_list", {}, env)) as {
    bounties: Record<string, unknown>[];
  };
  assert.deepEqual(
    out.bounties.map((b) => b.bounty_id),
    [0, 2],
  );
  assert.equal(out.bounties[0]!.reward_near, "0.05");
  assert.equal(out.bounties[0]!.page, "https://useproven.xyz/app/bounties/0");
  assert.match(String(out.bounties[0]!.merge_deadline_utc), /Z$/);
  const hard = Date.parse(String(out.bounties[0]!.hard_cutoff_utc)) / 1000;
  assert.equal(hard, NOW + 86_400 + 3600 + 14 * 86_400);
  const all = (await executeBountyTool(
    "bounty_list",
    { status: "all" },
    env,
  )) as {
    bounties: unknown[];
  };
  assert.equal(all.bounties.length, 3);
  await assert.rejects(
    executeBountyTool("bounty_list", { status: "Nope" }, env),
    /Invalid status/,
  );
});

test("bounty_list pages through more than one chain page", async () => {
  const many: Record<number, unknown> = {};
  for (let i = 0; i < 60; i++) many[i] = bounty();
  const { env } = fakeEnv({ bounties: many });
  const out = (await executeBountyTool("bounty_list", { limit: 200 }, env)) as {
    bounties: unknown[];
  };
  assert.equal(out.bounties.length, 60);
});

test("bounty_get returns terms and evidence", async () => {
  const { env } = fakeEnv({
    bounties: {
      3: bounty({
        status: "Bound",
        claim: claimed,
        binding: bound,
        last_check: {
          kind: "Merge",
          request_id: "22923",
          resolved_at: "1700000000000000000",
          outcome: "NotMerged",
        },
      }),
    },
  });
  const out = (await executeBountyTool(
    "bounty_get",
    { bounty_id: 3 },
    env,
  )) as any;
  assert.equal(out.pull_request.number, 9);
  assert.equal(out.pull_request.submit_outlayer_request_id, "21183");
  assert.equal(out.last_check.outlayer_request_id, "22923");
  await assert.rejects(
    executeBountyTool("bounty_get", { bounty_id: 99 }, env),
    /not found/,
  );
});

const goodPr = {
  state: "open",
  merged: false,
  base: { ref: "main", repo: { id: 777 } },
  user: { id: 42, login: "Alice" },
};
test("bounty_check_pr reports eligibility and reads only GitHub's pull request route", async () => {
  const { env, urls } = fakeEnv({
    bounties: { 0: bounty({ status: "Claimed", claim: claimed }) },
    github: { body: goodPr },
  });
  const out = (await executeBountyTool(
    "bounty_check_pr",
    {
      bounty_id: 0,
      pull: "https://github.com/acme/widgets/pull/9",
      github_login: "alice",
    },
    env,
  )) as any;
  assert.equal(out.looks_eligible_to_submit, true);
  assert.equal(out.author_github_id, "42");
  assert.ok(urls.includes("https://api.github.com/repos/acme/widgets/pulls/9"));
});

test("bounty_check_pr flags a merged pull request, wrong branch, wrong repository and wrong author", async () => {
  const { env } = fakeEnv({
    bounties: { 0: bounty({ status: "Claimed", claim: claimed }) },
    github: {
      body: {
        state: "closed",
        merged: true,
        base: { ref: "dev", repo: { id: 1 } },
        user: { id: 7, login: "bob" },
      },
    },
  });
  const out = (await executeBountyTool(
    "bounty_check_pr",
    { bounty_id: 0, pull: 9, github_id: 42 },
    env,
  )) as any;
  assert.equal(out.looks_eligible_to_submit, false);
  assert.deepEqual(out.problems.sort(), [
    "author_matches_claim",
    "author_matches_given_id",
    "in_bounty_repository",
    "open_and_unmerged",
    "targets_base_branch",
  ]);
});

test("bounty_check_pr refuses another repository's URL and reports a missing pull request", async () => {
  const { env } = fakeEnv({
    bounties: { 0: bounty() },
    github: { status: 404 },
  });
  await assert.rejects(
    executeBountyTool(
      "bounty_check_pr",
      { bounty_id: 0, pull: "https://github.com/evil/widgets/pull/9" },
      env,
    ),
    /different repository/,
  );
  await assert.rejects(
    executeBountyTool("bounty_check_pr", { bounty_id: 0, pull: 9 }, env),
    /no such pull request/,
  );
  await assert.rejects(
    executeBountyTool("bounty_check_pr", { bounty_id: 0, pull: "../9" }, env),
    /Invalid pull/,
  );
});

test("bounty_my_status shows the link and the wallet's claims", async () => {
  const { env } = fakeEnv({
    link: linked,
    bounties: {
      0: bounty({ status: "Bound", claim: claimed, binding: bound }),
      1: bounty(),
    },
  });
  const out = (await executeBountyTool(
    "bounty_my_status",
    { wallet: WALLET },
    env,
  )) as any;
  assert.equal(out.github_link.state, "linked");
  assert.equal(out.claims.length, 1);
  assert.equal(out.claims[0].pull_request, 9);
  const none = fakeEnv({});
  const empty = (await executeBountyTool(
    "bounty_my_status",
    { wallet: "bob.near" },
    none.env,
  )) as any;
  assert.equal(empty.github_link.state, "not linked");
});

test("prepare_link describes the step and attaches 0.017 NEAR", async () => {
  const { env } = fakeEnv({});
  const out = (await executeBountyTool(
    "bounty_prepare_link",
    { wallet: WALLET },
    env,
  )) as any;
  assert.equal(out.ready, true);
  assert.equal(out.sent, false);
  assert.match(out.amount_attached, /^0\.017 NEAR/);
  assert.equal(out.approve_here, "https://useproven.xyz/app/bounties#link");
});

test("prepare_claim needs an Open bounty, a link and no bar", async () => {
  const open = { bounties: { 0: bounty() } };
  const ok = (await executeBountyTool(
    "bounty_prepare_claim",
    { bounty_id: 0, wallet: WALLET },
    fakeEnv({ ...open, link: linked }).env,
  )) as any;
  assert.equal(ok.ready, true);
  assert.match(ok.amount_attached, /0\.0001 NEAR/);
  assert.match(ok.message_signature, /NEP-413/);
  assert.equal(ok.approve_here, "https://useproven.xyz/app/bounties/0#claim");

  const unlinked = (await executeBountyTool(
    "bounty_prepare_claim",
    { bounty_id: 0, wallet: WALLET },
    fakeEnv(open).env,
  )) as any;
  assert.equal(unlinked.ready, false);
  assert.equal(unlinked.approve_here, null);

  const barred = (await executeBountyTool(
    "bounty_prepare_claim",
    { bounty_id: 0, wallet: WALLET },
    fakeEnv({ ...open, link: linked, barred: true }).env,
  )) as any;
  assert.match(barred.problems[0], /cannot claim/);

  const taken = (await executeBountyTool(
    "bounty_prepare_claim",
    { bounty_id: 0, wallet: WALLET },
    fakeEnv({
      bounties: { 0: bounty({ status: "Claimed", claim: claimed }) },
      link: linked,
    }).env,
  )) as any;
  assert.match(taken.problems[0], /not Open/);
});

test("prepare_submit is only for the claimant of a Claimed bounty", async () => {
  const world = {
    bounties: { 0: bounty({ status: "Claimed", claim: claimed }) },
  };
  const ok = (await executeBountyTool(
    "bounty_prepare_submit",
    { bounty_id: 0, wallet: WALLET, pull: "9" },
    fakeEnv(world).env,
  )) as any;
  assert.equal(ok.ready, true);
  assert.match(ok.amount_attached, /^0\.01 NEAR/);
  assert.equal(
    ok.approve_here,
    "https://useproven.xyz/app/bounties/0#submit-9",
  );
  const other = (await executeBountyTool(
    "bounty_prepare_submit",
    { bounty_id: 0, wallet: "bob.near", pull: 9 },
    fakeEnv(world).env,
  )) as any;
  assert.equal(other.ready, false);
  await assert.rejects(
    executeBountyTool(
      "bounty_prepare_submit",
      { bounty_id: 0, wallet: WALLET },
      fakeEnv(world).env,
    ),
    /Invalid pull/,
  );
});

test("prepare_check is for Bound bounties and says when it is free", async () => {
  const world = {
    bounties: {
      0: bounty({ status: "Bound", claim: claimed, binding: bound }),
      1: bounty({
        status: "Bound",
        claim: claimed,
        binding: bound,
        sponsored_runs: 3,
      }),
      2: bounty({ status: "Claimed", claim: claimed }),
    },
  };
  const { env } = fakeEnv(world);
  const free = (await executeBountyTool(
    "bounty_prepare_check",
    { bounty_id: 0, wallet: WALLET },
    env,
  )) as any;
  assert.equal(free.free_check, true);
  assert.match(free.amount_attached, /^Nothing/);
  assert.equal(free.approve_here, "https://useproven.xyz/app/bounties/0#check");
  const paid = (await executeBountyTool(
    "bounty_prepare_check",
    { bounty_id: 0, wallet: "bob.near" },
    env,
  )) as any;
  assert.equal(paid.free_check, false);
  assert.match(paid.amount_attached, /^0\.01 NEAR/);
  const used = (await executeBountyTool(
    "bounty_prepare_check",
    { bounty_id: 1, wallet: WALLET },
    env,
  )) as any;
  assert.equal(used.free_check, false);
  const wrong = (await executeBountyTool(
    "bounty_prepare_check",
    { bounty_id: 2, wallet: WALLET },
    env,
  )) as any;
  assert.equal(wrong.ready, false);
});

test("prepare_withdraw needs a settled bounty and the right recipient", async () => {
  const world = {
    bounties: {
      0: bounty({ status: "Paid", claim: claimed, binding: bound }),
      1: bounty({ status: "Refunded" }),
      2: bounty(),
      3: bounty({ status: "Cancelled" }),
    },
  };
  const { env } = fakeEnv(world);
  const paid = (await executeBountyTool(
    "bounty_prepare_withdraw",
    { bounty_id: 0, wallet: WALLET },
    env,
  )) as any;
  assert.equal(paid.ready, true);
  assert.equal(paid.amount_attached, "Nothing; gas only");
  assert.equal(
    paid.approve_here,
    "https://useproven.xyz/app/bounties/0#withdraw",
  );
  const refund = (await executeBountyTool(
    "bounty_prepare_withdraw",
    { bounty_id: 1, wallet: "maint.near" },
    env,
  )) as any;
  assert.equal(refund.ready, true);
  const cancelled = (await executeBountyTool(
    "bounty_prepare_withdraw",
    { bounty_id: 3, wallet: "maint.near" },
    env,
  )) as any;
  assert.equal(cancelled.ready, true);
  for (const [bounty_id, who] of [
    [0, "bob.near"],
    [2, WALLET],
  ] as const) {
    const out = (await executeBountyTool(
      "bounty_prepare_withdraw",
      { bounty_id, wallet: who },
      env,
    )) as any;
    assert.equal(out.ready, false);
    assert.equal(out.sent, false);
  }
});

test("unknown fields and bad accounts are refused", async () => {
  const { env } = fakeEnv({});
  await assert.rejects(
    executeBountyTool("bounty_get", { bounty_id: 0, key: "x" }, env),
    /Unknown field/,
  );
  await assert.rejects(
    executeBountyTool("bounty_my_status", { wallet: "Bad Wallet" }, env),
    /Invalid account/,
  );
});
