// The PR bounty page as a contributor and a maintainer see it, rendered to static markup with
// fake data, a fake wallet and no network: every status, the refund notice before the Claim
// button, the vault and wallet lines kept apart, signing switched off, and the key check text.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { Bounty, Config, Listing } from "../ui/bounty-types.ts";
import { SIGNING_OFF } from "../ui/bounty-actions.ts";
import { describeKeyCheck } from "../ui/wallet-keys.ts";
import { FEES_APPROVED } from "../ui/posting-review.ts";
import { hardRefundAt, utc } from "../ui/bounty-status.ts";
import type { SettlementView } from "../ui/vault-view.ts";

const bundle = async (entry: string) => {
  const path = new URL(entry, import.meta.url).pathname;
  const built = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(path)};
export { createElement } from "react";
export { renderToStaticMarkup } from "react-dom/server";`,
      resolveDir: new URL("..", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    banner: {
      js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(path)});`,
    },
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
  );
  return {
    ...module,
    render: (component: unknown, props: unknown) =>
      (
        module.renderToStaticMarkup(
          module.createElement(component, props),
        ) as string
      ).replaceAll("&#x27;", "'"),
  };
};
const page = await bundle("../ui/PrBounties.tsx");
const card = await bundle("../ui/BountyCard.tsx");
const link = await bundle("../ui/LinkPanel.tsx");
const vault = await bundle("../ui/VaultPanel.tsx");

const recorded = <T>(name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../test-fixtures/sandbox/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as T;
const config: Config = {
  ...recorded<Config>("config"),
  // The recording predates the contract's 0.030 NEAR record deposit and its link deposit.
  storage_deposit: "30000000000000000000000",
  link_storage_deposit: "7000000000000000000000",
};
const done = recorded<SettlementView>("settlement-done");
const due = recorded<SettlementView>("settlement-due");
const inFlight = recorded<SettlementView>("settlement-in-flight");

const NANOS = 1_000_000_000n;
const T0 = 1_800_000_000;
const KEY = "ed25519:6W6SaZv5FcUXp3G7SZP9o21hCudRJKTXqP9QZy4JhffW";
const MESSAGE_KEY = "ed25519:7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9";
const CONTRACT = "pr-bounty.proven-funding.testnet";
const MAINT = "maint.testnet";
const CONTRIB = "contrib.testnet";
const STRANGER = "stranger.testnet";
const VAULT = `0s${"ab".repeat(20)}`;
const bounty = (over: Partial<Bounty> = {}): Bounty => ({
  buyer: MAINT,
  reward: "100000000000000000000000",
  sponsored_runs: 1,
  repo: config.pilot_repo,
  repo_id: config.pilot_repo_id,
  issue: 12,
  base_ref: "main",
  posted_at: String(BigInt(T0) * NANOS),
  claim_by: String(T0 + 100_000),
  claim_secs: String(48 * 3600),
  merge_deadline: String(T0 + 500_000),
  grace_secs: String(24 * 3600),
  status: "Open",
  maintainer_key: KEY,
  maintainer_vault: VAULT,
  posting_nonce: "a".repeat(64),
  claim: null,
  binding: null,
  merge: null,
  live: null,
  last_check: null,
  definite_look: null,
  payout: null,
  refund: null,
  ...over,
});
const claim = (endsAt = T0 + 50_000) => ({
  wallet: CONTRIB,
  github_id: "583231",
  key: MESSAGE_KEY,
  vault: done.vault,
  claimed_at: String(BigInt(T0) * NANOS),
  ends_at: String(endsAt),
});
const binding = {
  pr_number: 34,
  pr_id: "77",
  author_id: "583231",
  wallet: CONTRIB,
  bound_at: String(BigInt(T0 + 100) * NANOS),
  request_id: "555",
};
const merge = {
  merged_at: String(T0 + 200),
  request_id: "556",
  checked_at: String(BigInt(T0 + 300) * NANOS),
};
const live = (kind: "Submit" | "Merge") => ({
  seq: "9",
  kind,
  requested_at: String(BigInt(T0 + 900) * NANOS),
  pr_number: 34,
  payer: CONTRIB,
  sponsored: false,
  gist_id: null,
});
const claimed = (over: Partial<Bounty> = {}) =>
  bounty({ status: "Claimed", claim: claim(), ...over });
const bound = (over: Partial<Bounty> = {}) =>
  bounty({ status: "Bound", claim: claim(), binding, ...over });
const payout: SettlementView = { ...done, kind: "Payout" };

const wallet = (accountId: string) => ({
  accountId,
  label: "Test wallet",
  call: async () => {},
  transfer: async () => "",
  signForRelay: async () => ({}),
  signNep413: async () => ({}),
  signOut: async () => {},
  assertIdle: () => {},
});
const linkReady = (githubId: string | null = "583231") => ({
  state: "ready",
  value: githubId
    ? {
        active: {
          github_id: githubId,
          gist_id: "aa5a315d61ae9438b18d",
          challenge: "proven-link:x",
          linked_at: "1",
        },
        pending: null,
      }
    : null,
});
const ctx = (over: Record<string, unknown> = {}) => ({
  contract: CONTRACT,
  config,
  now: T0 + 1000,
  approved: false,
  wallet: null,
  run: async () => {},
  busy: false,
  chain: {},
  done: () => {},
  link: { state: "none" },
  ...over,
});
const cardOf = (b: Bounty, over: Record<string, unknown> = {}) =>
  card.render(card.BountyCard, {
    id: 7,
    bounty: b,
    ctx: ctx(over),
    inVault: new Map(),
  }) as string;
const pill = (html: string) =>
  /<span class="status-pill">([^<]*)<\/span>/.exec(html)?.[1];
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    attrs: m[1] as string,
    text: (m[2] as string)
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    disabled: /disabled=""/.test(m[1] as string),
  }));
const button = (html: string, text: RegExp) => {
  const found = buttons(html).find((b) => text.test(b.text));
  assert.ok(found, `no button matching ${text}`);
  return found;
};

test("the shipped build keeps signing off", () => {
  assert.equal(FEES_APPROVED, false);
});

// ---- Status lines ----

test("every status has its own status line", () => {
  const lines: [Bounty, string][] = [
    [bounty(), "Open"],
    [claimed(), `Claimed, ends ${utc(T0 + 50_000)}`],
    [bound(), "PR submitted"],
    [bound({ live: live("Merge") }), "Verifying merge"],
    [bounty({ status: "Paid", claim: claim(), binding, merge }), "Paid"],
    [bounty({ status: "Refunded" }), "Refunded"],
    [bounty({ status: "Cancelled" }), "Cancelled"],
    [bounty({ status: "Ineligible", claim: claim(), binding }), "Ineligible"],
  ];
  for (const [b, line] of lines) assert.equal(pill(cardOf(b)), line, line);
});

test("the claim card shows when the claim ends, and a submission check running", () => {
  const html = cardOf(claimed({ live: live("Submit") }));
  assert.match(html, /Claimed, ends 2027-/);
  assert.match(html, /A check of pull request #34 is running/);
  assert.match(html, /The claim cannot end while it runs/);
});

test("a bound card says verifying while a merge check is live, and shows evidence links", () => {
  const html = cardOf(
    bound({
      live: live("Merge"),
      last_check: {
        seq: "8",
        kind: "merge",
        request_id: "557",
        resolved_at: "1",
        outcome: "no_result:stale",
      },
    }),
  );
  assert.match(html, /Verifying merge/);
  assert.match(html, /check of pull request #34 is running/);
  assert.match(html, /pull\/34/);
  // Each evidence link points at its own run's attestation, whatever the attribute order.
  assert.match(
    html,
    /<a href="[^"]*\/attestations\/by-request\/555"[^>]*>submission run 555<\/a>/,
  );
  assert.match(
    html,
    /<a href="[^"]*\/attestations\/by-request\/557"[^>]*>run 557<\/a>/,
  );
  assert.match(html, /<code>no_result:stale<\/code>/);
});

test("the settlement is shown apart from the status", () => {
  const html = cardOf(
    bounty({ status: "Paid", claim: claim(), binding, merge, payout }),
  );
  assert.equal(pill(html), "Paid");
  assert.match(html, /<dt>Settlement<\/dt>/);
  assert.match(html, /payout 0\.08 testnet NEAR to vault/);
  // The status line itself does not say anything about a vault.
  assert.doesNotMatch(
    /<p class="bounty-status">[\s\S]*?<\/p>/.exec(html)?.[0] ?? "",
    /vault/i,
  );
});

test("the failed-look warning appears on a submitted bounty", () => {
  const html = cardOf(
    bound({
      last_check: {
        seq: "8",
        kind: "merge",
        request_id: null,
        resolved_at: "1",
        outcome: "no_result:stale",
      },
    }),
    { wallet: wallet(STRANGER) },
  );
  assert.match(html, /could not read GitHub \(no_result:stale\)/);
  assert.match(html, /changes nothing/);
});

// ---- The role buttons ----

const open = (html: string, text: RegExp) => {
  const b = button(html, text);
  return !b.disabled;
};

test("Release for the claimant, Revoke for the maintainer, Expire for anyone after the end", () => {
  const during = claimed();
  const approved = { approved: true };
  const asClaimant = cardOf(during, { ...approved, wallet: wallet(CONTRIB) });
  const asMaintainer = cardOf(during, { ...approved, wallet: wallet(MAINT) });
  const asStranger = cardOf(during, { ...approved, wallet: wallet(STRANGER) });
  assert.ok(open(asClaimant, /^Release the claim/));
  assert.doesNotMatch(asClaimant, /Revoke the claim|Expire the claim/);
  assert.ok(open(asMaintainer, /^Revoke the claim/));
  assert.doesNotMatch(asMaintainer, /Release the claim|Expire the claim/);
  assert.doesNotMatch(asStranger, /Release the claim|Revoke|Expire/);
  // After the claim ends, anyone may expire it.
  const after = { ...approved, now: T0 + 50_001 };
  const expired = cardOf(during, { ...after, wallet: wallet(STRANGER) });
  assert.ok(open(expired, /^Expire the claim/));
  assert.doesNotMatch(expired, /Release the claim|Revoke/);
});

test("a maintainer can cancel only while no one holds a claim", () => {
  const w = { approved: true, wallet: wallet(MAINT) };
  assert.ok(open(cardOf(bounty(), w), /^Cancel and refund to your vault/));
  assert.doesNotMatch(cardOf(claimed(), w), /Cancel and refund/);
  assert.doesNotMatch(
    cardOf(bounty(), { approved: true, wallet: wallet(STRANGER) }),
    /Cancel and refund/,
  );
});

test("a contributor sees check buttons on a submitted bounty, and only the bound wallet sees the sponsored one", () => {
  const b = bound();
  const asBound = cardOf(b, { approved: true, wallet: wallet(CONTRIB) });
  assert.ok(
    open(asBound, /^Check the merge, paying 0\.01 testnet NEAR myself/),
  );
  assert.ok(open(asBound, /^Sponsored check \(2 left, free to you\)/));
  const asStranger = cardOf(b, { approved: true, wallet: wallet(STRANGER) });
  assert.ok(open(asStranger, /^Check the merge, paying/));
  assert.doesNotMatch(asStranger, /Sponsored check/);
  // After the grace the check buttons stay: an on-time merge can still be read and paid.
  assert.ok(
    open(
      cardOf(b, {
        approved: true,
        wallet: wallet(STRANGER),
        now: T0 + 500_000 + 24 * 3600 + 60,
      }),
      /^Check the merge, paying/,
    ),
  );
  // A live check or the hard cutoff turns the check buttons off altogether.
  assert.doesNotMatch(
    cardOf(bound({ live: live("Merge") }), {
      approved: true,
      wallet: wallet(CONTRIB),
    }),
    /Check the merge, paying/,
  );
  assert.doesNotMatch(
    cardOf(b, {
      approved: true,
      wallet: wallet(CONTRIB),
      now: hardRefundAt(b, config.refund_cap_secs),
    }),
    /Check the merge, paying/,
  );
});

test("the refund button appears when the contract would accept it", () => {
  const w = { approved: true, wallet: wallet(STRANGER) };
  assert.doesNotMatch(cardOf(bounty(), w), /Refund the maintainer/);
  assert.ok(
    open(
      cardOf(bounty(), { ...w, now: T0 + 100_001 }),
      /^Refund the maintainer's vault/,
    ),
  );
  assert.ok(
    open(
      cardOf(bounty({ status: "Ineligible", claim: claim(), binding }), w),
      /^Refund the maintainer's vault/,
    ),
  );
});

test("settlement recovery buttons follow the settlement's state", () => {
  const w = { approved: true, wallet: wallet(STRANGER), now: T0 + 1_000_000 };
  const html = cardOf(
    bounty({
      status: "Refunded",
      refund: { ...due },
      payout: { ...inFlight, kind: "Payout" },
    }),
    w,
  );
  assert.ok(open(html, /^Send the due settlement/));
  // Unknown outcome, long past the open delay: anyone may ask the vault.
  assert.ok(open(html, /^Ask the vault whether the payout arrived/));
  assert.doesNotMatch(html, /Record the payout's result/);
  const recorded = cardOf(
    bounty({
      status: "Paid",
      payout: { ...inFlight, kind: "Payout", outcome: "Succeeded" },
    }),
    w,
  );
  assert.ok(open(recorded, /^Record the payout's result/));
});

// ---- The claim step ----

const claimView = (over: Record<string, unknown> = {}) =>
  card.render(card.ClaimView, {
    bounty: bounty(),
    config,
    approved: true,
    busy: false,
    connected: true,
    githubId: "583231",
    barred: false,
    keyCheck: null,
    onCheckKey() {},
    onClaim() {},
    ...over,
  }) as string;

test("the refund notice stands above the Claim button, with the date and the finality", () => {
  const b = bounty();
  const html = claimView({ bounty: b });
  const notice = html.indexOf("refunded to the maintainer");
  const claimButton = html.indexOf(">Claim this bounty</button>");
  assert.ok(notice > 0 && claimButton > 0);
  assert.ok(notice < claimButton, "the notice comes before the Claim button");
  const date = utc(hardRefundAt(b, config.refund_cap_secs));
  assert.match(
    html,
    new RegExp(
      `Merge checks are accepted until ${date}\\. If no check can read GitHub before then, a pull request merged on time is refunded to the maintainer and the contributor is not paid\\. The refund is final\\.`,
    ),
  );
  // The notice is also above the key check button, so it is read before anything is signed.
  assert.ok(notice < html.indexOf("Check which key my wallet signs"));
});

test("the claim step shows the claim length and the merge deadline", () => {
  const html = claimView({});
  assert.match(html, /A claim lasts 2 days/);
  assert.match(html, /merged before 2027-/);
  assert.match(html, /cannot claim this bounty again/);
  assert.match(html, /Claiming\s+sends no NEAR/);
});

test("the claim step needs a key check, a GitHub link and a wallet, and says which is missing", () => {
  const claimOff = (html: string) => button(html, /^Claim this bounty$/);
  const ready = claimView({
    keyCheck: { text: "Key text.", key: MESSAGE_KEY, vault: VAULT },
  });
  assert.equal(claimOff(ready).disabled, false);
  assert.match(ready, new RegExp(`vault <code>${VAULT}</code>`));
  const noCheck = claimView({});
  assert.equal(claimOff(noCheck).disabled, true);
  assert.match(noCheck, /Check your wallet's key first\./);
  const noLink = claimView({ githubId: null });
  assert.equal(claimOff(noLink).disabled, true);
  assert.match(noLink, /Connect GitHub to this wallet first/);
  const noWallet = claimView({ connected: false });
  assert.equal(claimOff(noWallet).disabled, true);
  assert.match(noWallet, /Connect a wallet to claim\./);
  const barred = claimView({
    barred: true,
    keyCheck: { text: "Key text.", key: MESSAGE_KEY, vault: VAULT },
  });
  assert.equal(claimOff(barred).disabled, true);
  assert.match(barred, /earlier claim on this bounty ended/);
  const busy = claimView({
    busy: true,
    keyCheck: { text: "Key text.", key: MESSAGE_KEY, vault: VAULT },
  });
  assert.equal(claimOff(busy).disabled, true);
});

test("the claim step shows what the key check found, including a message key that differs", () => {
  const text = describeKeyCheck({
    messageKey: MESSAGE_KEY,
    transactionKey: KEY,
  }).text;
  const html = claimView({
    keyCheck: { text, key: MESSAGE_KEY, vault: VAULT },
  });
  assert.match(
    html,
    /This wallet signs messages with a different key than it signs transactions; payouts will be withdrawn with ed25519:7v54…VFi9/,
  );
  assert.match(html, /Keep the message-signing key/);
  const same = describeKeyCheck({
    messageKey: MESSAGE_KEY,
    transactionKey: MESSAGE_KEY,
  }).text;
  assert.match(
    claimView({ keyCheck: { text: same, key: MESSAGE_KEY, vault: VAULT } }),
    /signs messages and transactions with the same key/,
  );
});

test("a claim card for a connected contributor shows the notice, with signing off and every button disabled", () => {
  const html = cardOf(bounty(), {
    wallet: wallet(CONTRIB),
    link: linkReady(),
  });
  assert.match(html, /If no check can read GitHub before then/);
  assert.match(html, /Signing is off in this build/);
  for (const b of buttons(html)) assert.equal(b.disabled, true, b.text);
});

test("nothing on the claim step mentions a branch code or asks the user for a gist", () => {
  const html = claimView({});
  assert.doesNotMatch(html, /branch.?code|gist/i);
  const card1 = cardOf(bounty(), {
    wallet: wallet(CONTRIB),
    link: linkReady(),
  });
  assert.doesNotMatch(card1, /branch.?code|paste.*gist|gist.*(id|link)/i);
});

// ---- Submit ----

const submitView = (value: string, over: Record<string, unknown> = {}) =>
  card.render(card.SubmitView, {
    bounty: claimed(),
    value,
    approved: true,
    busy: false,
    onChange() {},
    onSubmit() {},
    ...over,
  }) as string;
const submitButton = (html: string) => button(html, /^Submit pull request/);

test("the submit button stays off until the input is a pull request of this repository", () => {
  assert.equal(submitButton(submitView("")).disabled, true);
  assert.equal(submitButton(submitView("42")).disabled, false);
  assert.equal(
    submitButton(submitView(`https://github.com/${config.pilot_repo}/pull/42`))
      .disabled,
    false,
  );
  const other = submitView("https://github.com/someone/else/pull/42");
  assert.equal(submitButton(other).disabled, true);
  assert.match(
    other,
    /role="alert"[^>]*>That pull request is in someone\/else/,
  );
  const issue = submitView(`https://github.com/${config.pilot_repo}/issues/1`);
  assert.equal(submitButton(issue).disabled, true);
  assert.match(issue, /That is an issue link/);
  const junk = submitView("forty two");
  assert.equal(submitButton(junk).disabled, true);
  assert.match(junk, /not a pull request number or a GitHub link/);
  assert.doesNotMatch(submitView(""), /role="alert"/);
});

test("the submit step says what it costs and what it records", () => {
  const html = submitView("42");
  assert.match(html, /attaches 0\.01 testnet NEAR/);
  assert.match(html, /unused\s+part comes back/);
  assert.match(
    html,
    /records the pull request, its author and your\s+payout key/,
  );
  assert.equal(
    submitButton(submitView("42", { approved: false })).disabled,
    true,
  );
  assert.match(submitView("42", { approved: false }), /Signing is off/);
  const changed = submitView("42", {
    linkProblem: "Your GitHub link changed after you claimed.",
  });
  assert.equal(submitButton(changed).disabled, true);
  assert.match(changed, /link changed after you claimed/);
});

test("a claimant sees the submit step on a claimed bounty, and nobody else does", () => {
  const b = claimed();
  const mine = cardOf(b, {
    approved: true,
    wallet: wallet(CONTRIB),
    link: linkReady(),
  });
  assert.match(mine, /Submit your pull request/);
  assert.doesNotMatch(
    cardOf(b, { approved: true, wallet: wallet(STRANGER), link: linkReady() }),
    /Submit your pull request/,
  );
  // After the claim's end there is nothing to submit to.
  assert.doesNotMatch(
    cardOf(b, {
      approved: true,
      wallet: wallet(CONTRIB),
      link: linkReady(),
      now: T0 + 50_001,
    }),
    /Submit your pull request/,
  );
  // A link that changed after the claim cannot submit; the page says to release and claim again.
  const changed = cardOf(b, {
    approved: true,
    wallet: wallet(CONTRIB),
    link: linkReady("900000009"),
  });
  assert.match(changed, /Release this claim and claim again/);
  assert.equal(submitButton(changed).disabled, true);
});

// ---- Your GitHub link ----

const linkView = (over: Record<string, unknown> = {}) =>
  link.render(link.LinkView, {
    wallet: CONTRIB,
    link: linkReady(null),
    config,
    now: T0,
    approved: true,
    busy: false,
    device: null,
    step: null,
    outcome: null,
    owner: null,
    error: "",
    onConnect() {},
    onCancelConnect() {},
    onActivate() {},
    onConfirm() {},
    onCancelChange() {},
    ...over,
  }) as string;

test("without a link the page offers one connection and says what it costs", () => {
  const html = linkView();
  assert.match(html, /Not linked\. Link once, before your first claim\./);
  assert.match(
    html,
    /one transaction of 0\.017 testnet NEAR \(\s*0\.01 testnet NEAR check/,
  );
  assert.match(html, /0\.007 testnet NEAR storage/);
  assert.equal(button(html, /^Connect GitHub$/).disabled, false);
  assert.doesNotMatch(html, /paste|branch/i);
});

test("while GitHub is waiting, the device code and the login link are shown", () => {
  const html = linkView({
    device: {
      deviceCode: "x".repeat(40),
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 899,
      interval: 5,
    },
    step: "approval",
  });
  assert.match(html, /href="https:\/\/github\.com\/login\/device"/);
  assert.match(html, />github\.com\/login\/device<\/a>/);
  assert.match(html, /WDJB-MJHT/);
  assert.match(html, /Waiting for you to approve the connection on GitHub/);
  assert.doesNotMatch(html, /Connect GitHub<\/button>/);
  // Cancel is a read-only control and stays available.
  assert.equal(button(html, /^Cancel$/).disabled, false);
});

test("an active link is shown, and the connect button is gone", () => {
  const html = linkView({ link: linkReady("583231") });
  assert.match(html, /<dt>GitHub id<\/dt><dd>583231<\/dd>/);
  assert.match(html, /aa5a315d61ae9438b18d/);
  assert.doesNotMatch(html, /Connect GitHub<\/button>/);
});

test("a change waiting for its delay shows its time, and the right buttons for each viewer", () => {
  const waiting = {
    state: "ready",
    value: {
      active: {
        github_id: "583231",
        gist_id: "aa5a315d61ae9438b18d",
        challenge: "c",
        linked_at: "1",
      },
      pending: {
        link: {
          github_id: "900000002",
          gist_id: "bb5a315d61ae9438b18d",
          challenge: "c",
          linked_at: "2",
        },
        activates_at: String(T0 + 72 * 3600),
      },
    },
  };
  const own = linkView({ link: waiting, owner: "holder.testnet" });
  assert.match(own, /GitHub account id 900000002/);
  assert.match(own, new RegExp(`applies ${utc(T0 + 72 * 3600)}`));
  assert.match(own, /use its earlier link/);
  // The asking wallet may cancel, but only the wallet holding the account may confirm early.
  assert.ok(open(own, /^Cancel the change/));
  assert.doesNotMatch(own, /Confirm the change now/);
  assert.doesNotMatch(own, /Apply the change now/);
  assert.match(own, /Only holder\.testnet can confirm/);
  // Nobody holds the id: the wallet itself can confirm.
  assert.ok(
    open(linkView({ link: waiting, owner: null }), /^Confirm the change now/),
  );
  // After the delay anyone may apply it.
  assert.ok(
    open(
      linkView({ link: waiting, owner: "holder.testnet", now: T0 + 72 * 3600 }),
      /^Apply the change now/,
    ),
  );
  // The incumbent, looking at another wallet's change, may confirm and cancel.
  const row = link.render(link.LinkChangeRow, {
    viewer: "holder.testnet",
    wallet: CONTRIB,
    pending: waiting.value.pending,
    owner: "holder.testnet",
    now: T0,
    approved: true,
    busy: false,
    onActivate() {},
    onConfirm() {},
    onCancel() {},
  }) as string;
  assert.ok(open(row, /^Confirm the change now/));
  assert.ok(open(row, /^Cancel the change/));
});

test("the contract's link outcome is shown as plain text", () => {
  const refused = linkView({ outcome: "mismatch:challenge" });
  assert.match(refused, /did not find this wallet's challenge/);
  assert.match(refused, /0\.007 NEAR storage deposit was returned/);
  assert.match(linkView({ outcome: "link_pending" }), /waits 72 hours/);
  assert.match(linkView({ outcome: "linked" }), /GitHub is connected/);
});

test("the link panel reads its states", () => {
  assert.match(
    linkView({ wallet: null, link: { state: "none" } }),
    /Connect a wallet to link/,
  );
  assert.match(linkView({ link: { state: "loading" } }), /Reading your link/);
  assert.match(linkView({ link: { state: "unavailable" } }), /unavailable/);
  assert.match(
    linkView({ error: "GitHub refused." }),
    /role="alert">GitHub refused\./,
  );
});

// ---- Vaults ----

const vaultView = (over: Record<string, unknown> = {}) =>
  vault.render(vault.VaultView, {
    vault: done.vault,
    read: {
      exists: true,
      info: {
        key: MESSAGE_KEY,
        n: "0",
        fund: "0",
        available: "80000000000000000000000",
      },
    },
    readFailed: false,
    entries: [{ label: "refund", settlement: done }],
    shared: 1,
    history: [],
    near: (y: string | bigint) => `${y} yocto`,
    now: T0,
    partyDelaySecs: 900,
    connected: true,
    approved: true,
    busy: false,
    to: CONTRIB,
    amount: "",
    error: "",
    keyCheck: "",
    onTo() {},
    onAmount() {},
    onWithdraw() {},
    onRecheck() {},
    ...over,
  }) as string;
const lineOf = (html: string, cls: string) =>
  (new RegExp(`<p class="${cls}">([\\s\\S]*?)</p>`).exec(html)?.[1] ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ");
const delivered = {
  hash: "H".repeat(44),
  sender: CONTRIB,
  vault: done.vault,
  to: CONTRIB,
  amount: "80000000000000000000000",
  n: "0",
  deadline: T0,
  outcome: "delivered",
};

test("the vault credit and the wallet withdrawal are two separate lines", () => {
  const html = vaultView();
  const credit = lineOf(html, "vault-credit");
  const wallet = lineOf(html, "wallet-withdrawal");
  assert.match(credit, /^Credit \(refund\): In the vault\./);
  assert.match(credit, /This is not a withdrawal to a wallet\./);
  assert.match(wallet, /^Withdrawal: Not withdrawn to a wallet\./);
  assert.match(
    wallet,
    /Nothing leaves the vault until the withdrawal key signs/,
  );
  // After a delivered withdrawal the wallet line changes and the credit line does not.
  const after = vaultView({ history: [delivered] });
  assert.equal(lineOf(after, "vault-credit"), credit);
  assert.match(
    lineOf(after, "wallet-withdrawal"),
    /^Withdrawal: Withdrawn to /,
  );
  assert.match(
    lineOf(after, "wallet-withdrawal"),
    /contract does not track this/,
  );
});

test("a settlement that is not in the vault yet never shows as withdrawn, and a withdrawal never marks it done", () => {
  const sending = vaultView({
    entries: [{ label: "payout", settlement: due }],
    history: [delivered],
  });
  assert.match(
    lineOf(sending, "vault-credit"),
    /Not confirmed in the vault yet\. The amount stays reserved in the contract/,
  );
  assert.match(lineOf(sending, "wallet-withdrawal"), /Withdrawn to /);
  const unknown = vaultView({
    entries: [{ label: "payout", settlement: { ...inFlight, sent_at: "1" } }],
    now: 2_000_000_000,
  });
  assert.match(
    lineOf(unknown, "vault-credit"),
    /Sent to the vault, but no result is recorded/,
  );
  assert.match(lineOf(unknown, "wallet-withdrawal"), /Not withdrawn/);
  const none = vaultView({ entries: [] });
  assert.match(
    lineOf(none, "vault-credit"),
    /^Credit: No payout or refund exists for this bounty yet\./,
  );
});

test("a vault shared by several settlements shows one wallet line for the whole vault", () => {
  const html = vaultView({
    entries: [
      { label: "payout", settlement: done },
      { label: "refund", settlement: done },
    ],
    shared: 2,
  });
  assert.equal((html.match(/class="vault-credit"/g) ?? []).length, 2);
  assert.equal((html.match(/class="wallet-withdrawal"/g) ?? []).length, 1);
  assert.match(html, /Shown for the whole vault\./);
});

test("the vault says money is not in the wallet until withdrawn, nothing is forwarded or swept, and a lost key loses the funds", () => {
  const text = vaultView()
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ");
  assert.match(
    text,
    /Money stays in the vault until you withdraw it; nothing is forwarded\./,
  );
  assert.match(
    text,
    /Only this vault's key can withdraw, and a lost key loses the money\./,
  );
});

test("withdrawing signs with the vault's key, and the destination defaults to the connected account and can be edited", () => {
  const html = vaultView();
  assert.match(html, /<input spellCheck="false" value="contrib\.testnet"\/>/);
  assert.match(
    html,
    /signs a message with the vault key, then sends the\s+withdrawal/,
  );
  assert.equal(button(html, /^Withdraw to contrib\.testnet$/).disabled, false);
  // The key check text of the last withdrawal is shown.
  const text = describeKeyCheck({
    messageKey: MESSAGE_KEY,
    transactionKey: KEY,
  }).text;
  assert.match(
    vaultView({ keyCheck: text }),
    /signs messages with a different key than it signs transactions/,
  );
});

test("a vault that cannot be read shows unavailable, never zero, and nothing to withdraw", () => {
  const html = vaultView({ read: null, readFailed: true });
  assert.equal((html.match(/unavailable/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Withdraw to/);
  const missing = vaultView({ read: { exists: false, info: null } });
  assert.match(missing, /Not created yet: its first deposit creates it\./);
  assert.doesNotMatch(missing, /Withdraw to/);
});

test("with signing off, the withdraw button is off and says why; Re-check stays available", () => {
  const html = vaultView({
    approved: false,
    history: [{ ...delivered, outcome: "pending" }],
  });
  assert.equal(button(html, /^Withdraw to/).disabled, true);
  assert.match(html, /Signing is off in this build/);
  assert.equal(button(html, /^Re-check$/).disabled, false);
  assert.match(html, /pending: not delivered and not returned/);
});

// ---- The whole page ----

const listing = (bounties: [number, Bounty][]): Listing => ({
  configured: true,
  contract: CONTRACT,
  config,
  bounties,
});
const pageProps = (over: Record<string, unknown> = {}) => ({
  listing: listing([
    [1, bounty()],
    [2, claimed()],
    [3, bound()],
    [4, bound({ live: live("Merge") })],
    [5, bounty({ status: "Paid", claim: claim(), binding, merge, payout })],
    [6, bounty({ status: "Refunded", refund: { ...done } })],
    [7, bounty({ status: "Cancelled" })],
    [8, bounty({ status: "Ineligible", claim: claim(), binding })],
  ]),
  error: "",
  poster: true,
  link: linkReady(),
  wallet: wallet(CONTRIB),
  run: async () => {},
  busy: false,
  pending: null,
  now: T0 + 1000,
  approved: false,
  chain: {},
  done: () => {},
  onCheckPending() {},
  onReleasePending() {},
  ...over,
});
const renderPage = (over: Record<string, unknown> = {}) =>
  page.render(page.PrBountiesView, pageProps(over)) as string;

test("with signing off, no button on the page can send a transaction", () => {
  const maintainer = renderPage({ wallet: wallet(MAINT) });
  const contributor = renderPage({ wallet: wallet(CONTRIB) });
  const stranger = renderPage({
    wallet: wallet(STRANGER),
    now: T0 + 1_000_000,
  });
  // Buttons that read only, and never sign or send, stay available.
  const reads = /^(Cancel|Check again|Look up|Re-check|Try again)$/;
  for (const html of [maintainer, contributor, stranger]) {
    assert.match(html, /Signing is off in this build/);
    for (const b of buttons(html))
      if (!reads.test(b.text)) assert.equal(b.disabled, true, b.text);
  }
});

test("the same page with signing on has buttons that work, so the switch is the only gate", () => {
  const html = renderPage({
    wallet: wallet(CONTRIB),
    approved: true,
    link: linkReady(null),
  });
  assert.doesNotMatch(html, /Signing is off in this build/);
  assert.equal(button(html, /^Connect GitHub$/).disabled, false);
  assert.equal(button(html, /^Release the claim/).disabled, false);
});

test("the page shows the link panel, the posting form and every bounty, newest first", () => {
  const html = renderPage();
  assert.match(html, /<h2>Your GitHub account<\/h2>/);
  assert.match(html, /<h2>Post a bounty<\/h2>/);
  const order = [...html.matchAll(/Bounty (\d+) ·/g)].map((m) => m[1]);
  assert.deepEqual(order, ["8", "7", "6", "5", "4", "3", "2", "1"]);
  const statuses = [
    ...html.matchAll(/<span class="status-pill">([^<]*)</g),
  ].map((m) => m[1]);
  assert.deepEqual(
    statuses.map((s) => s?.split(",")[0]),
    [
      "Ineligible",
      "Cancelled",
      "Refunded",
      "Paid",
      "Verifying merge",
      "PR submitted",
      "Claimed",
      "Open",
    ],
  );
  assert.doesNotMatch(html, /two keys|backup key|branch.?code|check budget/i);
});

test("the page header states the vault and sponsor rules without a check budget", () => {
  const html = renderPage();
  assert.match(
    html,
    /vaults controlled by one withdrawal key,\s+not to account names/,
  );
  assert.match(
    html,
    /<dt>Record deposit<\/dt><dd>0\.03 testnet NEAR per bounty, kept/,
  );
  assert.match(html, /paid from the owner's float/);
});

test("a pending bounty call shows one status line and asks the person nothing", () => {
  const pending = {
    account: CONTRIB,
    bountyId: 2,
    before: "[]",
    label: "Claiming",
    createdAt: Date.now(),
    call: { receiver: CONTRACT, method: "claim", args: {} },
  };
  const html = renderPage({ pending, now: Math.floor(Date.now() / 1000) });
  assert.match(html, /Claiming: confirming on chain…/);
  // No manual buttons: the page confirms or releases the action by itself.
  assert.doesNotMatch(html, /Check again|I cancelled it/);
  const unreadable = renderPage({
    pending: { account: "unknown", before: "", label: "x", createdAt: 0 },
  });
  assert.match(unreadable, /could not be read back/);
  assert.match(unreadable, />Clear it</);
});

test("the page reads its own states", () => {
  assert.match(renderPage({ listing: null }), /Reading the bounties…/);
  assert.match(renderPage({ error: "No route." }), /role="alert">No route\./);
  assert.match(
    renderPage({ listing: { configured: false } }),
    /No PR bounty contract is configured/,
  );
  assert.match(renderPage({ listing: listing([]) }), /No bounties yet\./);
  const paused = renderPage({
    listing: { ...listing([]), config: { ...config, paused: true } },
  });
  assert.match(paused, /posting paused/);
  assert.doesNotMatch(paused, /<h2>Post a bounty<\/h2>/);
});

test("the sponsor note carries no maintainer budget and names the sponsor account", () => {
  const note = card.render(card.SponsorNote, {
    config: { sponsor: "sponsor.testnet" },
  }) as string;
  assert.match(note, /paid from the owner's float/);
  assert.match(note, /<code>sponsor\.testnet<\/code>/);
  assert.doesNotMatch(note, /budget|reserve/i);
  assert.ok(SIGNING_OFF.length > 0);
});

test("an empty vault offers no withdrawal", () => {
  const empty = vaultView({
    read: {
      exists: true,
      info: { key: MESSAGE_KEY, n: "1", fund: "0", available: "0" },
    },
  });
  assert.doesNotMatch(empty, /Withdraw to/);
  assert.match(vaultView(), /Withdraw to contrib\.testnet/);
});
