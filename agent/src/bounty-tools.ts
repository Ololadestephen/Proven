// CLI and MCP tools for PR merge bounties. Reads use public NEAR RPC and GitHub's public API.
// The prepare tools only validate chain state and describe a step; nothing here signs, sends a
// transaction, or holds a key. The person approves every NEAR step in their own wallet.
import { PublicError } from "./errors.ts";
import {
  accountId,
  fields,
  integer,
  object,
  text,
  type Args,
} from "./validation.ts";

const NEAR = 10n ** 24n;
const CONTRACT_DEFAULT = "proven-bounties.near";
const WEB_DEFAULT = "https://useproven.xyz";
const RPC_DEFAULT = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
} as const;
const GITHUB_API = "https://api.github.com";
const MAX_BODY = 512 * 1024;
const PAGE = 50;
const MAX_PAGES = 40;
const HARD_CUTOFF_EXTRA_SECS = 14 * 86_400;
const STATUSES = [
  "Open",
  "Claimed",
  "Bound",
  "Paid",
  "Refunded",
  "Cancelled",
  "Ineligible",
] as const;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** What the tools read from, kept apart from the process so tests can fake all of it. */
export interface BountyEnv {
  contract: string;
  network: "mainnet" | "testnet";
  rpc: string;
  webUrl: string;
  fetch: typeof fetch;
  /** Unix seconds. */
  now: () => number;
}

const string = { type: "string" };
const id = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const wallet = { type: "string", description: "The NEAR account id." };
const pull = {
  type: ["integer", "string"],
  description: "A pull request number or its github.com URL.",
};

const definitions: Array<[string, string, Record<string, unknown>, string[]]> =
  [
    [
      "bounty_list",
      "Read PR merge bounties. Open ones by default; status filters (Open, Claimed, Bound, Paid, Refunded, Cancelled, Ineligible) or all.",
      { status: string, from_id: id, limit: { ...id, minimum: 1 } },
      [],
    ],
    [
      "bounty_get",
      "Read one bounty with its terms, deadlines and evidence (pull request number, OutLayer request ids).",
      { bounty_id: id },
      ["bounty_id"],
    ],
    [
      "bounty_check_pr",
      "Read GitHub's public API and report whether a pull request looks eligible for a bounty. Advice only; the contract's verifier decides.",
      {
        bounty_id: id,
        pull,
        github_login: string,
        github_id: { type: ["integer", "string"] },
      },
      ["bounty_id", "pull"],
    ],
    [
      "bounty_my_status",
      "Read a wallet's GitHub link and its bounty claims with their states.",
      { wallet },
      ["wallet"],
    ],
    [
      "bounty_prepare_link",
      "Describe the one-time GitHub link step and give the page to approve it in the wallet. Sends nothing.",
      { wallet },
      ["wallet"],
    ],
    [
      "bounty_prepare_claim",
      "Check a wallet can claim a bounty and describe the step. Sends nothing.",
      { bounty_id: id, wallet },
      ["bounty_id", "wallet"],
    ],
    [
      "bounty_prepare_submit",
      "Check the claimant can submit a pull request and describe the step. Sends nothing.",
      { bounty_id: id, wallet, pull },
      ["bounty_id", "wallet", "pull"],
    ],
    [
      "bounty_prepare_check",
      "Check a merge check can start and describe its cost. Sends nothing.",
      { bounty_id: id, wallet },
      ["bounty_id", "wallet"],
    ],
    [
      "bounty_prepare_withdraw",
      "Check a wallet has a settled bounty to withdraw and describe the step. Sends nothing.",
      { bounty_id: id, wallet },
      ["bounty_id", "wallet"],
    ],
  ];

export const bountyTools = definitions.map(
  ([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    } as Record<string, unknown>,
  }),
);
export const isBountyTool = (name: string) =>
  definitions.some(([key]) => key === name);

/** Settings come from the process environment only, never from a file, and need no key. */
export function bountyEnv(
  source: Record<string, string | undefined> = process.env,
  overrides: Partial<Pick<BountyEnv, "fetch" | "now">> = {},
): BountyEnv {
  const network = source.NEAR_NETWORK ?? "mainnet";
  if (network !== "mainnet" && network !== "testnet")
    throw new PublicError("Unknown network.");
  const contract = source.PROVEN_PR_BOUNTY_CONTRACT;
  if (network === "testnet" && !contract)
    throw new PublicError(
      "Name the testnet bounty contract in PROVEN_PR_BOUNTY_CONTRACT.",
    );
  const rpc = source.PROVEN_BOUNTY_RPC_URL ?? RPC_DEFAULT[network];
  const webUrl = (source.PROVEN_WEB_URL ?? WEB_DEFAULT).replace(/\/+$/, "");
  for (const [name, url] of [
    ["PROVEN_BOUNTY_RPC_URL", rpc],
    ["PROVEN_WEB_URL", webUrl],
  ] as const) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PublicError(`${name} is not a URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
      throw new PublicError(`${name} must be an https address.`);
  }
  return {
    contract: accountId(contract ?? CONTRACT_DEFAULT),
    network,
    rpc,
    webUrl,
    fetch: overrides.fetch ?? fetch,
    now: overrides.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}

// ---- chain shapes (contracts/pr-bounty views); only the fields used here ----
interface Bounty {
  buyer: string;
  reward: string;
  sponsored_runs: number;
  repo: string;
  repo_id: string;
  issue: number;
  base_ref: string;
  claim_by: string;
  merge_deadline: string;
  grace_secs: string;
  status: string;
  claim: {
    wallet: string;
    github_id: string;
    claimed_at: string;
    ends_at: string;
  } | null;
  binding: {
    pr_number: number;
    pr_id: string;
    author_id: string;
    wallet: string;
    request_id: string;
  } | null;
  merge: { merged_at: string; request_id: string; checked_at: string } | null;
  live: { kind: string; pr_number: number; requested_at: string } | null;
  last_check: {
    kind: string;
    request_id: string | null;
    resolved_at: string;
    outcome: string;
  } | null;
}
interface LinkRecord {
  github_id: string;
  gist_id: string;
  linked_at: string;
}
interface WalletLink {
  active: LinkRecord | null;
  pending: { link: LinkRecord; activates_at: string } | null;
}
interface ChainConfig {
  sponsored_runs_per_bounty: number;
  paused?: boolean;
}

async function bounded(response: Response): Promise<string> {
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_BODY)
    throw new PublicError("A response was too large to read.");
  return body;
}

async function view<T>(
  env: BountyEnv,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await env.fetch(env.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "proven",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: env.contract,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PublicError("The NEAR RPC could not be reached.");
  }
  let body: { result?: { result?: unknown }; error?: unknown };
  try {
    body = JSON.parse(await bounded(response));
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError("The NEAR RPC returned unreadable data.");
  }
  const bytes = body.result?.result;
  if (
    body.error ||
    !Array.isArray(bytes) ||
    bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new PublicError(`The bounty contract view ${method} failed.`);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(bytes as number[]),
      ),
    ) as T;
  } catch {
    throw new PublicError("The bounty contract returned invalid JSON.");
  }
}

async function page(env: BountyEnv, fromId: number, limit: number) {
  const rows = await view<[number, Bounty][]>(env, "get_bounties", {
    from_id: fromId,
    limit,
  });
  if (!Array.isArray(rows)) throw new PublicError("Unreadable bounty list.");
  return rows;
}

async function allBounties(env: BountyEnv): Promise<[number, Bounty][]> {
  const out: [number, Bounty][] = [];
  let from = 0;
  for (let n = 0; n < MAX_PAGES; n++) {
    const rows = await page(env, from, PAGE);
    out.push(...rows);
    if (rows.length < PAGE) break;
    from = rows[rows.length - 1]![0] + 1;
  }
  return out;
}

async function bountyById(env: BountyEnv, bountyId: number): Promise<Bounty> {
  const bounty = await view<Bounty | null>(env, "get_bounty", {
    bounty_id: bountyId,
  });
  if (!bounty) throw new PublicError("Bounty was not found.");
  return bounty;
}

// ---- formatting ----
export function nearText(yocto: string): string {
  if (!/^[0-9]{1,40}$/.test(yocto)) return yocto;
  const value = BigInt(yocto);
  const fraction = (value % NEAR)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${value / NEAR}${fraction ? `.${fraction}` : ""}`;
}
const iso = (secs: number) => new Date(secs * 1000).toISOString();
const isoSecs = (value: string) => iso(Number(value));
const isoNanos = (value: string) => iso(Number(BigInt(value) / 1_000_000_000n));
const link = (env: BountyEnv, bountyId: number, step?: string) =>
  `${env.webUrl}/app/bounties/${bountyId}${step ? `#${step}` : ""}`;

function summary(env: BountyEnv, bountyId: number, b: Bounty) {
  const mergeDeadline = Number(b.merge_deadline);
  const hardCutoff =
    mergeDeadline + Number(b.grace_secs) + HARD_CUTOFF_EXTRA_SECS;
  return {
    bounty_id: bountyId,
    status: b.status,
    repo: b.repo,
    issue: b.issue,
    issue_url: `https://github.com/${b.repo}/issues/${b.issue}`,
    base_branch: b.base_ref,
    reward_near: nearText(b.reward),
    claim_by_utc: isoSecs(b.claim_by),
    merge_deadline_utc: isoSecs(b.merge_deadline),
    grace_ends_utc: iso(mergeDeadline + Number(b.grace_secs)),
    hard_cutoff_utc: iso(hardCutoff),
    claimant: b.claim?.wallet ?? null,
    page: link(env, bountyId),
  };
}

// ---- pull request references ----
function pullNumber(value: unknown, repo?: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new PublicError("Invalid pull request number.");
    return value;
  }
  if (typeof value !== "string") throw new PublicError("Invalid pull.");
  const trimmed = value.trim().replace(/^#/, "");
  if (/^[1-9][0-9]{0,9}$/.test(trimmed)) return Number(trimmed);
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([1-9][0-9]{0,9})\/?(?:[?#].*)?$/.exec(
      trimmed,
    );
  if (!match) throw new PublicError("Invalid pull request number or URL.");
  if (repo && match[1]!.toLowerCase() !== repo.toLowerCase())
    throw new PublicError("That pull request is in a different repository.");
  return Number(match[2]);
}

function idText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !/^[1-9][0-9]{0,19}$/.test(s))
    throw new PublicError("Invalid github_id.");
  return s;
}

async function checkPr(env: BountyEnv, args: Args) {
  const bountyId = integer(args, "bounty_id", 0, Number.MAX_SAFE_INTEGER);
  const bounty = await bountyById(env, bountyId);
  if (!REPO.test(bounty.repo))
    throw new PublicError("The bounty names an unreadable repository.");
  const number = pullNumber(args.pull, bounty.repo);
  const login =
    args.github_login === undefined
      ? undefined
      : text(args, "github_login", 39);
  if (login !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(login))
    throw new PublicError("Invalid github_login.");
  const contributorId = idText(args.github_id);
  let response: Response;
  try {
    response = await env.fetch(
      `${GITHUB_API}/repos/${bounty.repo}/pulls/${number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "proven-agent",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw new PublicError("GitHub could not be reached.");
  }
  if (response.status === 404)
    throw new PublicError(
      "GitHub has no such pull request in that repository.",
    );
  if (!response.ok)
    throw new PublicError(`GitHub answered with status ${response.status}.`);
  let pr: {
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    base?: { ref?: string; repo?: { id?: number } | null };
    user?: { id?: number; login?: string } | null;
  };
  try {
    pr = JSON.parse(await bounded(response));
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError("GitHub returned unreadable data.");
  }
  const authorId = pr.user?.id === undefined ? null : String(pr.user.id);
  const repoId =
    pr.base?.repo?.id === undefined ? null : String(pr.base.repo.id);
  const checks: Record<string, boolean | null> = {
    open_and_unmerged: pr.state === "open" && pr.merged === false,
    targets_base_branch: pr.base?.ref === bounty.base_ref,
    in_bounty_repository: repoId === bounty.repo_id,
    author_matches_given_login:
      login === undefined
        ? null
        : pr.user?.login?.toLowerCase() === login.toLowerCase(),
    author_matches_given_id:
      contributorId === undefined ? null : authorId === contributorId,
    author_matches_claim:
      bounty.claim === null ? null : authorId === bounty.claim.github_id,
  };
  const failed = Object.entries(checks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  return {
    advice_only:
      "This reads GitHub's public API once. The contract's verifier decides on submit and on the merge check.",
    bounty_id: bountyId,
    pull_request: number,
    pull_request_url: `https://github.com/${bounty.repo}/pull/${number}`,
    bounty_status: bounty.status,
    bounty_base_branch: bounty.base_ref,
    bounty_repository_id: bounty.repo_id,
    pull_request_base_branch: pr.base?.ref ?? null,
    pull_request_repository_id: repoId,
    author_github_id: authorId,
    author_github_login: pr.user?.login ?? null,
    state: pr.state ?? null,
    merged: pr.merged ?? null,
    checks,
    looks_eligible_to_submit: failed.length === 0,
    problems: failed,
    note: "Proven checks the merge, not the quality of the work.",
  };
}

// ---- reads ----
async function list(env: BountyEnv, args: Args) {
  const wanted = args.status === undefined ? "Open" : text(args, "status", 16);
  if (wanted !== "all" && !(STATUSES as readonly string[]).includes(wanted))
    throw new PublicError(`Invalid status. Use ${STATUSES.join(", ")} or all.`);
  const limit = integer(args, "limit", 1, 200, 50);
  const from = integer(args, "from_id", 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = (await allBounties(env)).filter(
    ([bountyId, b]) =>
      bountyId >= from && (wanted === "all" || b.status === wanted),
  );
  return {
    contract: env.contract,
    network: env.network,
    status_filter: wanted,
    bounties: rows.slice(0, limit).map(([n, b]) => summary(env, n, b)),
    more: rows.length > limit,
  };
}

async function get(env: BountyEnv, args: Args) {
  const bountyId = integer(args, "bounty_id", 0, Number.MAX_SAFE_INTEGER);
  const b = await bountyById(env, bountyId);
  return {
    ...summary(env, bountyId, b),
    poster: b.buyer,
    claim: b.claim && {
      wallet: b.claim.wallet,
      github_id: b.claim.github_id,
      claim_ends_utc: isoSecs(b.claim.ends_at),
    },
    pull_request: b.binding && {
      number: b.binding.pr_number,
      url: `https://github.com/${b.repo}/pull/${b.binding.pr_number}`,
      author_github_id: b.binding.author_id,
      wallet: b.binding.wallet,
      submit_outlayer_request_id: b.binding.request_id,
    },
    merge: b.merge && {
      merged_at_utc: isoNanos(b.merge.merged_at),
      outlayer_request_id: b.merge.request_id,
    },
    live_run: b.live && {
      kind: b.live.kind,
      pull_request: b.live.pr_number,
      requested_utc: isoNanos(b.live.requested_at),
    },
    last_check: b.last_check && {
      kind: b.last_check.kind,
      outcome: b.last_check.outcome,
      resolved_utc: isoNanos(b.last_check.resolved_at),
      outlayer_request_id: b.last_check.request_id,
    },
    free_checks_used: b.sponsored_runs,
    note: "Proven checks the merge, not the quality of the work. Verify each OutLayer request id on OutLayer's attestation API.",
  };
}

async function myStatus(env: BountyEnv, args: Args) {
  const who = accountId(text(args, "wallet", 64));
  const [github, rows] = await Promise.all([
    view<WalletLink | null>(env, "get_link", { wallet: who }),
    allBounties(env),
  ]);
  const claims = rows
    .filter(([, b]) => b.claim?.wallet === who || b.binding?.wallet === who)
    .map(([n, b]) => ({
      ...summary(env, n, b),
      role: "contributor",
      pull_request: b.binding?.pr_number ?? null,
      claim_ends_utc: b.claim ? isoSecs(b.claim.ends_at) : null,
    }));
  const posted = rows
    .filter(([, b]) => b.buyer === who)
    .map(([n, b]) => ({ ...summary(env, n, b), role: "poster" }));
  return {
    wallet: who,
    github_link: github?.active
      ? {
          state: "linked",
          github_id: github.active.github_id,
          linked_utc: isoNanos(github.active.linked_at),
        }
      : { state: "not linked" },
    pending_link_change: github?.pending
      ? {
          github_id: github.pending.link.github_id,
          activates_utc: isoNanos(github.pending.activates_at),
        }
      : null,
    claims,
    posted,
    link_page: `${env.webUrl}/app/bounties#link`,
  };
}

// ---- prepare: validate, describe, link; never send ----
function step(
  env: BountyEnv,
  base: Record<string, unknown>,
  opts: {
    problems: string[];
    summary: string;
    attach: string;
    signature: string | null;
    url: string;
    extra?: Record<string, unknown>;
  },
) {
  return {
    ...base,
    network: env.network,
    contract: env.contract,
    ready: opts.problems.length === 0,
    problems: opts.problems,
    summary: opts.summary,
    amount_attached: opts.attach,
    message_signature: opts.signature,
    approve_here: opts.problems.length === 0 ? opts.url : null,
    sent: false,
    note: "Nothing has been sent. The person opens the link and approves in their own wallet; this tool holds no key.",
    ...opts.extra,
  };
}

async function activeLink(env: BountyEnv, who: string) {
  const l = await view<WalletLink | null>(env, "get_link", { wallet: who });
  return l?.active ?? null;
}

async function prepareLink(env: BountyEnv, args: Args) {
  const who = accountId(text(args, "wallet", 64));
  const current = await view<WalletLink | null>(env, "get_link", {
    wallet: who,
  });
  const problems: string[] = [];
  let note = "";
  if (current?.active)
    note = `This wallet is already linked to GitHub id ${current.active.github_id}. Linking a different GitHub account waits 72 hours and only affects later claims.`;
  if (current?.pending)
    problems.push("A GitHub link change is already waiting for its delay.");
  return step(
    env,
    { step: "link", wallet: who },
    {
      problems,
      summary:
        `Link ${who} to one GitHub account, once. You sign in to GitHub with the page, which creates one secret gist holding a challenge, then you send the link transaction. The GitHub permission is not stored. Keep the gist: the submission check reads it again. ${note}`.trim(),
      attach:
        "0.017 NEAR (0.01 for the check run, unused part returned; 0.007 for storing the link)",
      signature: null,
      url: `${env.webUrl}/app/bounties#link`,
    },
  );
}

async function prepareClaim(env: BountyEnv, args: Args) {
  const bountyId = integer(args, "bounty_id", 0, Number.MAX_SAFE_INTEGER);
  const who = accountId(text(args, "wallet", 64));
  const [b, linked, barred] = await Promise.all([
    bountyById(env, bountyId),
    activeLink(env, who),
    view<boolean>(env, "is_barred", { bounty_id: bountyId, wallet: who }),
  ]);
  const problems: string[] = [];
  if (b.status !== "Open")
    problems.push(`The bounty is ${b.status}, not Open.`);
  if (b.status === "Open" && env.now() >= Number(b.claim_by))
    problems.push("The claim window has closed.");
  if (!linked)
    problems.push("This wallet has no GitHub link. Link GitHub first.");
  if (barred)
    problems.push(
      "This wallet cannot claim this bounty again (an earlier claim ended).",
    );
  return step(
    env,
    { step: "claim", bounty: summary(env, bountyId, b), wallet: who },
    {
      problems,
      summary: `Claim bounty ${bountyId} (${nearText(b.reward)} NEAR for a merged pull request into ${b.base_ref} of ${b.repo}) as ${who}${linked ? `, pinned to GitHub id ${linked.github_id}` : ""}. Open the pull request with that GitHub account. A claim lasts the time the poster set, capped by the merge deadline.`,
      attach: "0.0001 NEAR fee",
      signature:
        "A NEP-413 message naming the network, contract, account and bounty. The key that signs becomes the key of your payout vault; if it is lost, the money is lost.",
      url: link(env, bountyId, "claim"),
    },
  );
}

async function prepareSubmit(env: BountyEnv, args: Args) {
  const bountyId = integer(args, "bounty_id", 0, Number.MAX_SAFE_INTEGER);
  const who = accountId(text(args, "wallet", 64));
  const b = await bountyById(env, bountyId);
  const number = pullNumber(args.pull, b.repo);
  const problems: string[] = [];
  if (b.status !== "Claimed")
    problems.push(`The bounty is ${b.status}, not Claimed.`);
  else if (b.claim?.wallet !== who)
    problems.push("Only the wallet holding the claim can submit.");
  else if (env.now() >= Number(b.claim.ends_at))
    problems.push("The claim has ended.");
  if (b.live) problems.push("A run is already live on this bounty.");
  return step(
    env,
    {
      step: `submit-${number}`,
      bounty: summary(env, bountyId, b),
      wallet: who,
      pull_request: number,
    },
    {
      problems,
      summary: `Submit pull request #${number} (https://github.com/${b.repo}/pull/${number}) for bounty ${bountyId}. One run reads the pull request: it must be open, unmerged, into ${b.base_ref}, in ${b.repo}, authored by the GitHub id pinned at your claim, and never bound before. Use bounty_check_pr first.`,
      attach: "0.01 NEAR (the run; unused part returned)",
      signature: null,
      url: link(env, bountyId, `submit-${number}`),
    },
  );
}

async function prepareCheck(env: BountyEnv, args: Args) {
  const bountyId = integer(args, "bounty_id", 0, Number.MAX_SAFE_INTEGER);
  const who = accountId(text(args, "wallet", 64));
  const [b, config] = await Promise.all([
    bountyById(env, bountyId),
    view<ChainConfig>(env, "get_config", {}),
  ]);
  const problems: string[] = [];
  if (b.status !== "Bound")
    problems.push(`The bounty is ${b.status}, not Bound.`);
  if (b.live) problems.push("A check is already live for this bounty.");
  const remaining = Math.max(
    0,
    (config.sponsored_runs_per_bounty ?? 3) - b.sponsored_runs,
  );
  const free = b.binding?.wallet === who && remaining > 0;
  return step(
    env,
    { step: "check", bounty: summary(env, bountyId, b), wallet: who },
    {
      problems,
      summary: `Ask the contract to read GitHub and check whether pull request #${b.binding?.pr_number ?? "?"} was merged before ${isoSecs(b.merge_deadline)}. A "not merged" answer counts only if requested at least 60 seconds after the deadline. If nobody checks before ${summary(env, bountyId, b).hard_cutoff_utc}, an on-time merge is refunded to the poster and the refund is final.`,
      attach: free
        ? `Nothing: a free check paid by the sponsor (${remaining} of ${config.sponsored_runs_per_bounty} left for the bound contributor)`
        : "0.01 NEAR (the run; unused part returned)",
      signature: null,
      url: link(env, bountyId, "check"),
      extra: { free_check: free },
    },
  );
}

async function prepareWithdraw(env: BountyEnv, args: Args) {
  const bountyId = integer(args, "bounty_id", 0, Number.MAX_SAFE_INTEGER);
  const who = accountId(text(args, "wallet", 64));
  const b = await bountyById(env, bountyId);
  const problems: string[] = [];
  const owed =
    b.status === "Paid"
      ? b.claim?.wallet === who || b.binding?.wallet === who
      : b.status === "Refunded" || b.status === "Cancelled"
        ? b.buyer === who
        : false;
  if (!["Paid", "Refunded", "Cancelled"].includes(b.status))
    problems.push(`The bounty is ${b.status}; nothing has settled yet.`);
  else if (!owed)
    problems.push("This wallet is not the recipient of this settlement.");
  return step(
    env,
    { step: "withdraw", bounty: summary(env, bountyId, b), wallet: who },
    {
      problems,
      summary: `Withdraw from your vault for bounty ${bountyId}: ${nearText(b.reward)} NEAR was settled into it, less a small storage fund the vault keeps from its first deposit. Your vault key signs a message with the destination, amount and a deadline at most 15 minutes ahead; the page then submits a transaction that costs gas only. Only that key can withdraw.`,
      attach: "Nothing; gas only",
      signature:
        "A message signature by your vault key (proven-vault-withdraw) with destination, amount, withdrawal number and a deadline within 15 minutes.",
      url: link(env, bountyId, "withdraw"),
    },
  );
}

export async function executeBountyTool(
  name: string,
  input: unknown,
  env: BountyEnv = bountyEnv(),
): Promise<unknown> {
  const definition = definitions.find(([key]) => key === name);
  if (!definition) throw new PublicError("Unknown tool.");
  const args: Args = object(input);
  fields(args, Object.keys(definition[2]));
  switch (name) {
    case "bounty_list":
      return list(env, args);
    case "bounty_get":
      return get(env, args);
    case "bounty_check_pr":
      return checkPr(env, args);
    case "bounty_my_status":
      return myStatus(env, args);
    case "bounty_prepare_link":
      return prepareLink(env, args);
    case "bounty_prepare_claim":
      return prepareClaim(env, args);
    case "bounty_prepare_submit":
      return prepareSubmit(env, args);
    case "bounty_prepare_check":
      return prepareCheck(env, args);
    default:
      return prepareWithdraw(env, args);
  }
}
