// The two-field posting form as the maintainer sees it, for every state the GitHub read can be in.
// Rendered to static markup with its own React; no network, no wallet, no signing.
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import type { IssueMetadata, MetadataError } from "../ui/github-issue.ts";
import { ADVANCED_DEFAULTS, PREVIEW_FEES } from "../ui/posting-review.ts";

const NEAR = 10n ** 24n;
const META: IssueMetadata = {
  repo: "Ololadestephen/flop",
  repo_id: 1346702196,
  issue: 1,
  title: "Proven testnet pilot A: merge and payout",
  html_url: "https://github.com/Ololadestephen/flop/issues/1",
  default_branch: "main",
};
const bundle = async () => {
  const path = new URL("../ui/PostBountyForm.tsx", import.meta.url).pathname;
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
  return (props: Record<string, unknown>) =>
    (
      module.renderToStaticMarkup(
        module.createElement(module.PostFormView, {
          link: "",
          rewardText: "",
          advanced: ADVANCED_DEFAULTS,
          meta: { state: "idle" },
          limits: { max_reward: 2n * NEAR, room: 5n * NEAR },
          pilot: { repo: "Ololadestephen/flop", repo_id: 1346702196 },
          fees: PREVIEW_FEES,
          now: 1_793_000_000,
          connected: true,
          poster: true,
          onLink() {},
          onReward() {},
          onAdvanced() {},
          onRetry() {},
          ...props,
        }),
      ) as string
    ).replaceAll("&#x27;", "'");
};
const render = await bundle();
const ready = { state: "ready", value: META };
const error = (over: Partial<MetadataError>) => ({
  state: "error",
  error: {
    kind: "unreachable",
    message: "Could not reach GitHub.",
    action: "Check your connection and try again.",
    retriable: true,
    ...over,
  },
});
const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];

test("only the issue link and the reward are required inputs", () => {
  const html = render({});
  const labels = [...html.matchAll(/<label>([^<]*)</g)].map((m) =>
    m[1]!.trim(),
  );
  assert.deepEqual(labels.slice(0, 2), [
    "GitHub issue link",
    "Reward (testnet NEAR)",
  ]);
  assert.doesNotMatch(
    html,
    /GitHub user id|numeric|contributor|backup|wallet address|verifier|nominate/i,
  );
  // Everything else is under Advanced, collapsed by default.
  assert.match(
    html,
    /<details class="bounty-advanced"><summary>Advanced<\/summary>/,
  );
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  const advanced = html.slice(html.indexOf("<details"));
  for (const label of [
    "Target branch",
    "A claim lasts (hours)",
    "Open for claims (days)",
    "Merge deadline (days from now)",
    "Checking grace (hours)",
  ])
    assert.ok(advanced.includes(label), label);
});

test("before a link is read, nothing is previewed and posting is off", () => {
  const html = render({});
  assert.doesNotMatch(html, /Total locked/);
  assert.match(html, /Enter an issue link and a reward/);
  for (const b of buttons(html)) assert.match(b, /disabled=""/);
});

test("while GitHub is being read the form says so", () => {
  const html = render({ meta: { state: "loading" }, link: "https://x" });
  assert.match(html, /role="status">Reading the issue from GitHub/);
  assert.doesNotMatch(html, /Total locked/);
});

test("a GitHub failure says what happened and what to do, and a retry only if it can help", () => {
  const temporary = render({ meta: error({}) });
  assert.match(temporary, /role="alert"/);
  assert.match(temporary, /Could not reach GitHub\./);
  assert.match(temporary, /Check your connection and try again\./);
  assert.match(temporary, /Try again/);
  assert.doesNotMatch(temporary, /Total locked/);
  const permanent = render({
    meta: error({
      kind: "not_found",
      message: "GitHub has no public issue at this link.",
      action: "Check the link.",
      retriable: false,
    }),
  });
  assert.match(permanent, /GitHub has no public issue at this link\./);
  assert.doesNotMatch(permanent, /Try again/);
  // No repository or branch is shown for a link that could not be read.
  assert.doesNotMatch(permanent, /<code>main<\/code>/);
});

test("the review shows the repository, issue, suggested branch, deadlines, fees and total", () => {
  const html = render({ meta: ready, rewardText: "0.1" });
  assert.match(html, /Ololadestephen\/flop#1/);
  assert.match(html, /Proven testnet pilot A: merge and payout/);
  assert.match(html, /<dt>Branch<\/dt><dd><code>main<\/code><\/dd>/);
  assert.match(html, /Until 2026-[^<]*, each claim lasts 2 days/);
  assert.match(html, /<dt>Merge before<\/dt>/);
  assert.match(html, /Reward 0\.1 testnet NEAR/);
  assert.match(html, /record deposit 0\.03 testnet NEAR, kept/);
  assert.match(html, /<strong>0\.13 testnet NEAR<\/strong>/);
  assert.match(html, /0\.1 testnet NEAR back if nothing is merged/);
  assert.match(html, /Post and lock 0\.13 testnet NEAR/);
});

test("the review says that an on-time merge is refunded if verification stays unavailable", () => {
  const html = render({ meta: ready, rewardText: "0.1" });
  assert.match(html, /a failed check changes\s+nothing/);
  assert.match(html, /paid at the first check that\s+reads it/);
  assert.match(html, /If none reads GitHub before 2026-/);
  assert.match(html, /Checks run only when someone requests one/);
  assert.match(html, /From 2026-[^<]* if a check at least a minute after the/);
  assert.match(html, /refunded even if it was merged on time/);
  assert.match(html, /the refund is final/);
});

test("preview fees are labelled and the Post button cannot sign", () => {
  const html = render({ meta: ready, rewardText: "0.1" });
  assert.match(html, /Sandbox sample numbers for this preview/);
  assert.match(html, /not approved/);
  assert.match(html, /Preview only/);
  const post = buttons(html).find((b) => b.includes("post-blocked"));
  assert.ok(post && /disabled=""/.test(post));
  // Nothing in the markup submits anything.
  assert.doesNotMatch(html, /<form/);
});

test("a branch override is flagged and a bad override is shown beside its field", () => {
  const changed = render({
    meta: ready,
    rewardText: "0.1",
    advanced: { ...ADVANCED_DEFAULTS, branch: "proven-testnet-pilot" },
  });
  assert.match(
    changed,
    /<code>proven-testnet-pilot<\/code> \(default is main\)/,
  );
  const bad = render({
    meta: ready,
    rewardText: "0.1",
    advanced: { ...ADVANCED_DEFAULTS, branch: "a b", grace_hours: "99" },
  });
  assert.match(bad, /cannot contain spaces/);
  assert.match(bad, /between 10 minutes and 24 hours/);
  assert.doesNotMatch(bad, /Total locked/);
});

test("a repository outside the pilot is refused before any review", () => {
  const html = render({
    meta: {
      state: "ready",
      value: { ...META, repo: "someone/else", repo_id: 7 },
    },
    rewardText: "0.1",
  });
  assert.match(html, /This pilot only pays for issues in Ololadestephen\/flop/);
  assert.doesNotMatch(html, /Total locked/);
});

test("a missing reward or one over the cap is explained and nothing is previewed", () => {
  assert.match(render({ meta: ready, rewardText: "" }), /role="alert"/);
  assert.match(
    render({ meta: ready, rewardText: "9" }),
    /The payment can be at most 2 NEAR/,
  );
  assert.doesNotMatch(render({ meta: ready, rewardText: "" }), /Total locked/);
});

test("who is connected changes only the reason posting is off", () => {
  const approved = { ...PREVIEW_FEES, source: "contract", approved: true };
  const base = { meta: ready, rewardText: "0.1", fees: approved };
  assert.match(
    render({ ...base, connected: false }),
    /Connect a wallet to post/,
  );
  assert.match(
    render({ ...base, poster: false }),
    /not on the pilot's list of approved posters/,
  );
  // Even when allowed, this build has no signing path: the button stays disabled.
  for (const b of buttons(render(base))) assert.match(b, /disabled=""/);
});
