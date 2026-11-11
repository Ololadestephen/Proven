// The page's reads of the bounty contract, through a fake fetcher. Each route is the one
// src/bounties.ts serves, and a reply the page cannot use is an error, never an empty answer.
import assert from "node:assert/strict";
import test from "node:test";
import { BOUNTY_PATH, base64Url, bountyChain } from "../ui/bounty-chain.ts";

function fetcher(replies: Record<string, unknown>) {
  const asked: string[] = [];
  const get = (async (path: string) => {
    asked.push(path);
    if (!(path in replies)) throw new Error(`unexpected route: ${path}`);
    const reply = replies[path];
    if (reply instanceof Error) throw reply;
    return reply;
  }) as <T>(path: string) => Promise<T>;
  return { asked, get };
}
const P = BOUNTY_PATH;

test("each read asks the route the server serves and returns the field it needs", async () => {
  const f = fetcher({
    [`${P}/bounty/3`]: { bounty: { status: "Open" } },
    [`${P}/link/alice.testnet`]: { link: { active: null, pending: null } },
    [`${P}/nonce/alice.testnet/${"ab".repeat(32)}`]: { used: true },
    [`${P}/posted/alice.testnet/${"ab".repeat(32)}`]: { id: 9 },
    [`${P}/vault/0sabc`]: {
      exists: true,
      info: { key: "k", n: "4", fund: "0", available: "5" },
    },
    [`${P}/barred/3/alice.testnet`]: { barred: false },
    [`${P}/block`]: { block_secs: 1_793_000_000 },
    [`${P}/link-challenge/alice.testnet/1793001800`]: {
      challenge: "proven-link:x",
    },
    [`${P}/link-number/alice.testnet`]: { number: "2" },
    [`${P}/claim-message/3/alice.testnet/583231/ed25519%3Akey/1793001800`]: {
      message: "claim text",
    },
    [`${P}/account/payee.testnet`]: { exists: true },
  });
  const c = bountyChain(f.get);
  assert.deepEqual(await c.bounty(3), { status: "Open" });
  assert.deepEqual(await c.link("alice.testnet"), {
    active: null,
    pending: null,
  });
  assert.equal(await c.nonceUsed("alice.testnet", "ab".repeat(32)), true);
  assert.equal(await c.postedByNonce("alice.testnet", "ab".repeat(32)), 9);
  assert.equal(await c.vaultN("0sabc"), "4");
  assert.equal((await c.vault("0sabc")).exists, true);
  assert.equal(await c.barred(3, "alice.testnet"), false);
  assert.equal(await c.nowSecs(), 1_793_000_000);
  assert.equal(
    await c.linkChallenge("alice.testnet", 1793001800),
    "proven-link:x",
  );
  assert.equal(await c.linkNumber("alice.testnet"), 2);
  assert.equal(
    await c.claimMessage({
      bounty_id: 3,
      wallet: "alice.testnet",
      github_id: "583231",
      key: "ed25519:key",
      expires_at: "1793001800",
    }),
    "claim text",
  );
  assert.equal(await c.accountExists("payee.testnet"), true);
});

test("a missing bounty is null, a missing vault has no number, and no match is null", async () => {
  const c = bountyChain(
    fetcher({
      [`${P}/bounty/3`]: { bounty: null },
      [`${P}/link/a.testnet`]: { link: null },
      [`${P}/vault/0sabc`]: { vault: "0sabc", exists: false, info: null },
      [`${P}/posted/a.testnet/${"cd".repeat(32)}`]: { id: null },
    }).get,
  );
  assert.equal(await c.bounty(3), null);
  assert.equal(await c.link("a.testnet"), null);
  assert.equal(await c.vaultN("0sabc"), null);
  assert.equal(await c.postedByNonce("a.testnet", "cd".repeat(32)), null);
});

test("an answer the page cannot use is an error, not an empty answer", async () => {
  const c = bountyChain(
    fetcher({
      [`${P}/bounty/3`]: { nothing: 1 },
      [`${P}/nonce/a.testnet/${"ab".repeat(32)}`]: { used: "yes" },
      [`${P}/barred/3/a.testnet`]: {},
      [`${P}/block`]: { block_secs: "soon" },
      [`${P}/link-challenge/a.testnet/5`]: { challenge: "" },
      [`${P}/link-number/a.testnet`]: { number: "-1" },
      [`${P}/link-number/b.testnet`]: { number: 2 },
      [`${P}/vault/0sabc`]: new Error("The vault could not be read."),
    }).get,
  );
  await assert.rejects(c.bounty(3), /could not be read/);
  await assert.rejects(
    c.nonceUsed("a.testnet", "ab".repeat(32)),
    /could not be checked/,
  );
  await assert.rejects(c.barred(3, "a.testnet"), /could not be read/);
  await assert.rejects(c.nowSecs(), /latest block/);
  await assert.rejects(c.linkChallenge("a.testnet", 5), /cannot use/);
  await assert.rejects(
    c.linkNumber("a.testnet"),
    /link number could not be read/,
  );
  await assert.rejects(
    c.linkNumber("b.testnet"),
    /link number could not be read/,
  );
  await assert.rejects(c.vaultN("0sabc"), /could not be read/);
});

test("the posting terms travel as one base64url JSON part the server decodes", () => {
  const request = { terms: { base_ref: "main/é", issue: 1 }, n: "~?>" };
  const part = base64Url(request);
  assert.match(part, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(
    JSON.parse(Buffer.from(part, "base64url").toString("utf8")),
    request,
  );
});
