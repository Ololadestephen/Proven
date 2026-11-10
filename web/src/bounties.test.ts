import assert from "node:assert/strict";
import test from "node:test";
import { bountiesRoute, bountyContract } from "./bounties.ts";

const CONTRACT = "pr-bounty.proven-funding.testnet";
const PRIMARY = "ed25519:6W6SaZv5FcUXp3G7SZP9o21hCudRJKTXqP9QZy4JhffW";
const BACKUP = "ed25519:67EWBuiksjZ1e5ipLwNj3t6eb3aNu7pAjx7XucQcoFMU";

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
  assert.equal(bountyContract(CONTRACT, "mainnet"), null);
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

test("the challenge and poster routes take only validated path parts", async () => {
  const { asked, transport } = chain({
    claim_challenge: "proven-claim:ab",
    is_poster: true,
  });
  assert.deepEqual(
    await bountiesRoute(
      `/api/market/bounties/challenge/3/contrib.testnet/1794300000/${PRIMARY}/${encodeURIComponent(BACKUP)}`,
      transport,
      CONTRACT,
    ),
    { challenge: "proven-claim:ab" },
  );
  assert.deepEqual(asked[0]?.args, {
    bounty_id: 3,
    wallet: "contrib.testnet",
    expires_at: "1794300000",
    primary: PRIMARY,
    backup: BACKUP,
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
    "/api/market/bounties/challenge/x/contrib.testnet/1",
    "/api/market/bounties/challenge/3/Bad..Account/1",
    "/api/market/bounties/challenge/3/contrib.testnet",
    "/api/market/bounties/challenge/3/contrib.testnet/1794300000",
    "/api/market/bounties/poster/",
    "/api/market/bounties/other",
  ])
    await assert.rejects(bountiesRoute(bad, transport, CONTRACT), bad);
  assert.equal(asked.length, 2, "nothing invalid reached the chain");
});
