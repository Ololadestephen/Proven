// Reads the repository, issue title and default branch for a GitHub issue link, so the maintainer
// pastes one link and never types a repository, a branch or a numeric id. Nothing is guessed: any
// answer that is not exactly the issue that was asked for is an error that says what to do next.
// Public reads only (no token): GitHub allows 60 per hour per network address, and the answer is
// shown to the maintainer before anything is signed.

export interface IssueMetadata {
  /** GitHub's canonical `owner/name`. */
  repo: string;
  repo_id: number;
  issue: number;
  title: string;
  html_url: string;
  default_branch: string;
}

export type MetadataFailure =
  | "bad_link"
  | "pull_request"
  | "not_found"
  | "renamed"
  | "closed"
  | "no_branch"
  | "rate_limited"
  | "unreachable"
  | "unavailable"
  | "unexpected";

export interface MetadataError {
  kind: MetadataFailure;
  /** What happened, in one sentence. */
  message: string;
  /** What the maintainer can do about it. */
  action: string;
  /** Trying the same link again later may work. */
  retriable: boolean;
}

export type MetadataResult =
  { ok: true; value: IssueMetadata } | { ok: false; error: MetadataError };

export interface IssueRef {
  owner: string;
  name: string;
  number: number;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const MAX_TITLE = 200;

const fail = (
  kind: MetadataFailure,
  message: string,
  action: string,
  retriable = false,
): MetadataResult => ({
  ok: false,
  error: { kind, message, action, retriable },
});

/** `https://github.com/<owner>/<name>/issues/<number>`, nothing else. */
export function parseIssueLink(input: string): IssueRef | MetadataError {
  const text = input.trim();
  const bad = (message: string): MetadataError => ({
    kind: "bad_link",
    message,
    action:
      "Paste the issue's address from your browser, like https://github.com/owner/repo/issues/12.",
    retriable: false,
  });
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return bad("That is not a web address.");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com")
    return bad("Only https://github.com links are supported.");
  if (url.username || url.password || url.port)
    return bad("The link has parts that GitHub issue links never have.");
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner = "", name = "", kind = "", number = "", ...rest] = parts;
  if (kind === "pull" || kind === "pulls")
    return {
      kind: "pull_request",
      message: "That is a pull request, not an issue.",
      action:
        "Paste the link of the issue the reward is for. The contributor opens the pull request later.",
      retriable: false,
    };
  if (kind !== "issues" || rest.length > 0 || !/^[0-9]{1,10}$/.test(number))
    return bad("The link does not point at one issue.");
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..")
    return bad("The repository in the link is not a valid GitHub name.");
  const value = Number(number);
  if (value < 1 || value > 0xffff_ffff)
    return bad("The issue number is out of range.");
  return { owner, name, number: value };
}

type Fetch = typeof fetch;

interface Reply {
  status: number;
  headers: Headers;
  body: unknown;
}

async function get(
  path: string,
  transport: Fetch,
): Promise<Reply | MetadataError> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await transport(`${API}${path}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: abort.signal,
      redirect: "follow",
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, headers: response.headers, body };
  } catch {
    return {
      kind: "unreachable",
      message: abort.signal.aborted
        ? "GitHub did not answer in time."
        : "Could not reach GitHub.",
      action: "Check your connection and try again.",
      retriable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

function statusFailure(reply: Reply, what: string): MetadataError | null {
  const { status, headers } = reply;
  if (status === 200) return null;
  if (status === 404 || status === 410)
    return {
      kind: "not_found",
      message: `GitHub has no public ${what} at this link.`,
      action:
        "Check the link. Private repositories and deleted issues cannot carry a bounty.",
      retriable: false,
    };
  const limited =
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" ||
        headers.has("retry-after")));
  if (limited) {
    const reset = Number(headers.get("x-ratelimit-reset"));
    const when =
      Number.isFinite(reset) && reset > 0
        ? ` It resets at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC.`
        : "";
    return {
      kind: "rate_limited",
      message: `GitHub's limit for this network address is used up.${when}`,
      action: "Wait a few minutes and try again.",
      retriable: true,
    };
  }
  if (status >= 500)
    return {
      kind: "unavailable",
      message: "GitHub is not available right now.",
      action: "Try again in a few minutes.",
      retriable: true,
    };
  return {
    kind: "unexpected",
    message: `GitHub answered with status ${status}.`,
    action: "Check the link, then try again.",
    retriable: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const unexpected = (what: string): MetadataResult =>
  fail(
    "unexpected",
    `GitHub's answer about the ${what} was not in the expected form.`,
    "Try again. If it keeps happening, post nothing and tell Proven.",
  );

/**
 * Control characters and text-direction overrides become spaces (an issue's author can put them
 * in a title to make the review read differently from what is signed), runs of space collapse,
 * and the result is cut to a displayable length.
 */
export function cleanTitle(title: string): string {
  const flat = title
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g,
      " ",
    )
    .replace(/ {2,}/g, " ")
    .trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

export async function loadIssueMetadata(
  input: string,
  transport: Fetch = fetch,
): Promise<MetadataResult> {
  const ref = parseIssueLink(input);
  if ("kind" in ref) return { ok: false, error: ref };
  const base = `/repos/${ref.owner}/${ref.name}`;
  const [repoReply, issueReply] = await Promise.all([
    get(base, transport),
    get(`${base}/issues/${ref.number}`, transport),
  ]);
  for (const [reply, what] of [
    [repoReply, "repository"],
    [issueReply, "issue"],
  ] as const) {
    if ("kind" in reply) return { ok: false, error: reply };
    const failure = statusFailure(reply, what);
    if (failure) return { ok: false, error: failure };
  }
  const repo = (repoReply as Reply).body;
  const issue = (issueReply as Reply).body;
  if (
    !isRecord(repo) ||
    typeof repo.full_name !== "string" ||
    !positive(repo.id)
  )
    return unexpected("repository");
  if (
    !isRecord(issue) ||
    !positive(issue.number) ||
    typeof issue.title !== "string"
  )
    return unexpected("issue");
  // GitHub follows a renamed repository silently. The verifier does not, so the bounty must name
  // the current name, and the maintainer has to see that it changed.
  if (repo.full_name.toLowerCase() !== `${ref.owner}/${ref.name}`.toLowerCase())
    return fail(
      "renamed",
      `This repository is now called ${repo.full_name}.`,
      `Paste the issue's link from ${repo.full_name}.`,
    );
  if (issue.number !== ref.number) return unexpected("issue");
  if (issue.pull_request !== undefined)
    return fail(
      "pull_request",
      "That link is a pull request, not an issue.",
      "Paste the link of the issue the reward is for.",
    );
  if (repo.private === true)
    return fail(
      "not_found",
      "This repository is private.",
      "Only public repositories can carry a bounty.",
    );
  if (issue.state !== "open")
    return fail(
      "closed",
      "This issue is closed.",
      "Reopen it on GitHub, or pick an open issue.",
    );
  if (typeof repo.default_branch !== "string" || repo.default_branch === "")
    return fail(
      "no_branch",
      "This repository has no default branch yet.",
      "Push a first commit to the repository, then try again.",
    );
  // The branch is shown and signed as is; anything the contract would refuse is refused here.
  if (
    repo.default_branch.length > 255 ||
    [...repo.default_branch].some((c) => c < " " || c === "\u007f")
  )
    return unexpected("repository");
  const title = cleanTitle(issue.title);
  if (title === "") return unexpected("issue");
  return {
    ok: true,
    value: {
      repo: repo.full_name,
      repo_id: repo.id,
      issue: issue.number,
      title,
      html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
      default_branch: repo.default_branch,
    },
  };
}
