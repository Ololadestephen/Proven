// The issue link on the posting form: what is accepted, what is read from GitHub, and every way
// the read can fail. No network: GitHub is a fake transport that records the requests.
import assert from "node:assert/strict";
import test from "node:test";
import {
  loadIssueMetadata,
  parseIssueLink,
  type MetadataFailure,
} from "../ui/github-issue.ts";

const LINK = "https://github.com/Ololadestephen/flop/issues/1";

const repoBody = (over: Record<string, unknown> = {}) => ({
  id: 1346702196,
  full_name: "Ololadestephen/flop",
  private: false,
  default_branch: "main",
  ...over,
});
const issueBody = (over: Record<string, unknown> = {}) => ({
  number: 1,
  title: "Proven testnet pilot A: merge and payout",
  state: "open",
  ...over,
});

interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: boolean;
  raw?: string;
}
function github(repo: Answer, issue: Answer) {
  const seen: string[] = [];
  const transport = (async (url: string) => {
    seen.push(url);
    const answer = url.includes("/issues/") ? issue : repo;
    if (answer.throws) throw new TypeError("network down");
    return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: answer.headers,
    });
  }) as typeof fetch;
  return { transport, seen };
}
const ok = (): [Answer, Answer] => [
  { body: repoBody() },
  { body: issueBody() },
];

async function failure(repo: Answer, issue: Answer, kind: MetadataFailure) {
  const result = await loadIssueMetadata(LINK, github(repo, issue).transport);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, kind, result.error.message);
  assert.ok(result.error.message.length > 0 && result.error.action.length > 0);
  return result.error;
}

test("a plain issue link gives the repository, the issue and the default branch", async () => {
  const { transport, seen } = github(...ok());
  const result = await loadIssueMetadata(`  ${LINK}/?x=1#top `, transport);
  assert.deepEqual(result, {
    ok: true,
    value: {
      repo: "Ololadestephen/flop",
      repo_id: 1346702196,
      issue: 1,
      title: "Proven testnet pilot A: merge and payout",
      html_url: LINK,
      default_branch: "main",
    },
  });
  assert.deepEqual(seen.sort(), [
    "https://api.github.com/repos/Ololadestephen/flop",
    "https://api.github.com/repos/Ololadestephen/flop/issues/1",
  ]);
});

test("the branch is the repository's default, not a guess", async () => {
  const { transport } = github(
    { body: repoBody({ default_branch: "develop" }) },
    { body: issueBody() },
  );
  const result = await loadIssueMetadata(LINK, transport);
  assert.equal(result.ok && result.value.default_branch, "develop");
});

test("the address is taken from GitHub's canonical name when only the case differs", async () => {
  const { transport } = github(...ok());
  const result = await loadIssueMetadata(
    "https://github.com/ololadestephen/FLOP/issues/1",
    transport,
  );
  assert.equal(result.ok && result.value.repo, "Ololadestephen/flop");
});

test("links that are not one issue are refused before anything is fetched", () => {
  const bad = [
    "",
    "flop",
    "http://github.com/o/r/issues/1",
    "https://gitlab.com/o/r/issues/1",
    "https://github.com.evil.example/o/r/issues/1",
    "https://user@github.com/o/r/issues/1",
    "https://github.com:444/o/r/issues/1",
    "https://github.com/o/r",
    "https://github.com/o/r/issues",
    "https://github.com/o/r/issues/0",
    "https://github.com/o/r/issues/12x",
    "https://github.com/o/r/issues/1/extra",
    "https://github.com/o/r/discussions/1",
    "https://github.com/-o/r/issues/1",
    "https://github.com/o/../issues/1",
    "https://github.com/o/r/issues/99999999999",
  ];
  for (const text of bad) {
    const parsed = parseIssueLink(text);
    assert.ok("kind" in parsed, `accepted ${JSON.stringify(text)}`);
    assert.equal(parsed.kind, "bad_link");
  }
  assert.deepEqual(parseIssueLink("https://github.com/o/r/issues/12"), {
    owner: "o",
    name: "r",
    number: 12,
  });
});

test("a pull request link is named as such", async () => {
  const parsed = parseIssueLink("https://github.com/o/r/pull/3");
  assert.ok("kind" in parsed && parsed.kind === "pull_request");
  // GitHub also serves pull requests under /issues/<n>.
  await failure(
    { body: repoBody() },
    { body: issueBody({ pull_request: { url: "x" } }) },
    "pull_request",
  );
});

test("a missing issue or repository is not found, and is not retriable", async () => {
  const error = await failure(
    { body: repoBody() },
    { status: 404 },
    "not_found",
  );
  assert.equal(error?.retriable, false);
  await failure({ status: 404 }, { status: 404 }, "not_found");
  await failure(
    { body: repoBody({ private: true }) },
    { body: issueBody() },
    "not_found",
  );
});

test("a renamed repository is never followed silently", async () => {
  const error = await failure(
    { body: repoBody({ full_name: "Someone/else" }) },
    { body: issueBody() },
    "renamed",
  );
  assert.match(error?.message ?? "", /Someone\/else/);
});

test("a closed issue is refused", async () => {
  await failure(
    { body: repoBody() },
    { body: issueBody({ state: "closed" }) },
    "closed",
  );
});

test("a repository without a default branch is refused, not given main", async () => {
  await failure(
    { body: repoBody({ default_branch: "" }) },
    { body: issueBody() },
    "no_branch",
  );
  await failure(
    { body: repoBody({ default_branch: undefined }) },
    { body: issueBody() },
    "no_branch",
  );
  await failure(
    { body: repoBody({ default_branch: "x\nmain" }) },
    { body: issueBody() },
    "unexpected",
  );
});

test("temporary failures are retriable and say what to do", async () => {
  const limited = await failure(
    { body: repoBody() },
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1793821703",
      },
    },
    "rate_limited",
  );
  assert.equal(limited?.retriable, true);
  assert.match(limited?.message ?? "", /resets at \d\d:\d\d UTC/);
  assert.equal(
    (await failure({ status: 429 }, { body: issueBody() }, "rate_limited"))
      ?.retriable,
    true,
  );
  assert.equal(
    (await failure({ status: 503 }, { body: issueBody() }, "unavailable"))
      ?.retriable,
    true,
  );
  const down = await failure(
    { throws: true },
    { body: issueBody() },
    "unreachable",
  );
  assert.equal(down?.retriable, true);
});

test("a forbidden answer that is not a rate limit is not retried blindly", async () => {
  const error = await failure(
    { status: 403 },
    { body: issueBody() },
    "unexpected",
  );
  assert.equal(error?.retriable, false);
});

test("answers that do not have the asked-for shape are errors, not guesses", async () => {
  await failure({ raw: "<html>" }, { body: issueBody() }, "unexpected");
  await failure(
    { body: repoBody({ id: "1346702196" }) },
    { body: issueBody() },
    "unexpected",
  );
  await failure(
    { body: repoBody({ id: 0 }) },
    { body: issueBody() },
    "unexpected",
  );
  await failure(
    { body: repoBody() },
    { body: issueBody({ number: 2 }) },
    "unexpected",
  );
  await failure(
    { body: repoBody() },
    { body: issueBody({ title: 7 }) },
    "unexpected",
  );
  await failure(
    { body: repoBody() },
    { body: issueBody({ title: " \n " }) },
    "unexpected",
  );
  await failure({ body: [] }, { body: issueBody() }, "unexpected");
});

test("the title is shown flat and cut to a displayable length", async () => {
  const long = `${"a".repeat(300)}`;
  const { transport } = github(
    { body: repoBody() },
    { body: issueBody({ title: `  Fix\nthe\u0000\u202e bug ` }) },
  );
  const flat = await loadIssueMetadata(LINK, transport);
  assert.equal(flat.ok && flat.value.title, "Fix the bug");
  const cut = await loadIssueMetadata(
    LINK,
    github({ body: repoBody() }, { body: issueBody({ title: long }) })
      .transport,
  );
  assert.ok(
    cut.ok && cut.value.title.length === 200 && cut.value.title.endsWith("…"),
  );
});
