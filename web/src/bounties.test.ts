import assert from "node:assert/strict";
import test from "node:test";
import { bountiesRoute, bountyContract } from "./bounties.ts";

const CONTRACT = "pr-bounty.proven-funding.testnet";
const KEY = "ed25519:6W6SaZv5FcUXp3G7SZP9o21hCudRJKTXqP9QZy4JhffW";

/** A fake RPC that answers each view with `answers[method]` and records what was asked. */
function chain(answers: Record<string, unknown>) {
  const asked: { method: string; args: unknown; account: string }[] = [];
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
    const bytes = [...Buffer.from(JSON.stringify(answers[method]))];
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: bytes } }),
    );
  }) as typeof fetch;
  return { asked, transport };
}

test("the page is off unless a testnet contract is named", () => {
  assert.equal(bountyContract(undefined, "testnet"), null);
  // A contract on another network than the site's is refused, not read.
  assert.throws(() => bountyContract(CONTRACT, "mainnet"), /different network/);
  assert.equal(
    bountyContract("proven-bounties.near", "mainnet"),
    "proven-bounties.near",
  );
  assert.throws(() => bountyContract("proven-bounties.near", "testnet"));
  assert.equal(bountyContract(CONTRACT, "testnet"), CONTRACT);
  assert.throws(() => bountyContract("Not An Account", "testnet"));
});

test("an unconfigured page reads nothing", async () => {
  const { asked, transport } = chain({});
  assert.deepEqual(
    await bountiesRoute("/api/market/bounties", transport, null),
    { configured: false },
  );
  assert.equal(asked.length, 0);
});

test("the listing reads the config and the first fifty bounties from the named contract", async () => {
  const { asked, transport } = chain({
    get_config: { paused: false },
    get_bounties: [[0, { status: "Open" }]],
  });
  const reply = (await bountiesRoute(
    "/api/market/bounties",
    transport,
    CONTRACT,
  )) as Record<string, unknown>;
  assert.deepEqual(reply, {
    configured: true,
    contract: CONTRACT,
    config: { paused: false },
    bounties: [[0, { status: "Open" }]],
  });
  assert.deepEqual(
    asked.map((a) => [a.account, a.method, a.args]),
    [
      [CONTRACT, "get_config", {}],
      [CONTRACT, "get_bounties", { from_id: 0, limit: 50 }],
    ],
  );
});

test("the link challenge and poster routes take only validated path parts", async () => {
  const { asked, transport } = chain({
    link_challenge: "proven-link:ab",
    is_poster: true,
  });
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/link-challenge/contrib.testnet/1794300000",
      transport,
      CONTRACT,
    ),
    { challenge: "proven-link:ab" },
  );
  assert.deepEqual(asked[0]?.args, {
    wallet: "contrib.testnet",
    expires_at: "1794300000",
  });
  assert.deepEqual(
    await bountiesRoute(
      "/api/market/bounties/poster/maint.testnet",
      transport,
      CONTRACT,
    ),
    {
      account: "maint.testnet",
      poster: true,
    },
  );
  for (const bad of [
    "/api/market/bounties/link-challenge/Bad..Account/1",
    "/api/market/bounties/link-challenge/contrib.testnet",
    "/api/market/bounties/link-challenge/contrib.testnet/x",
    `/api/market/bounties/challenge/3/contrib.testnet/1794300000/${KEY}/${KEY}`,
    "/api/market/bounties/poster/",
    "/api/market/bounties/other",
  ])
    await assert.rejects(bountiesRoute(bad, transport, CONTRACT), bad);
  assert.equal(asked.length, 2, "nothing invalid reached the chain");
});
