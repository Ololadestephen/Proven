import { useEffect, useState } from "react";
import type { Run, Wallet } from "./market-types.ts";
import { NEAR } from "./market-types.ts";
import { api, short } from "./market-client.ts";
import { parseNearAmount } from "./near-amount.ts";
import { COIN, OUTLAYER_API } from "./network.ts";

const TGAS = 10n ** 12n;
const RUN_GAS = 300n * TGAS;
const PATH = "/api/market/bounties";

type TransferKind = "Reward" | "Budget";
interface Transfer {
  to: string;
  amount: string;
  state: "Due" | "Sending" | "Done";
  attempt: number;
  outcome: "Unknown" | "Succeeded" | "Failed";
}
const GIST_ID = /^[0-9a-f]{1,64}$/;
interface Bounty {
  buyer: string;
  reward: string;
  budget: string;
  budget_runs_left: number;
  repo: string;
  repo_id: string;
  issue: number;
  base_ref: string;
  contributor_github_id: string;
  claim_by: string;
  bind_by: string;
  merge_deadline: string;
  grace_secs: string;
  status:
    | "Open"
    | "Claimed"
    | "Bound"
    | "Paid"
    | "Ineligible"
    | "Refunded"
    | "Cancelled";
  claim: {
    wallet: string;
    github_id: string;
    gist_id: string;
    request_id: string;
  } | null;
  binding: {
    pr_number: number;
    pr_id: string;
    bound_at: string;
    request_id: string;
  } | null;
  merge: { merged_at: string; request_id: string } | null;
  live: { seq: string; kind: string; requested_at: string } | null;
  last_check: {
    kind: string;
    outcome: string;
    request_id: string | null;
    resolved_at: string;
  } | null;
  reward_transfer: Transfer | null;
  budget_transfer: Transfer | null;
}
interface Config {
  owner: string;
  network: string;
  verifier_url: string;
  verifier_hash: string;
  pilot_repo: string;
  pilot_repo_id: string;
  paused: boolean;
  max_reward: string;
  max_held: string;
  held: string;
  run_deposit: string;
  budget_runs: number;
  storage_deposit: string;
}
type Listing =
  | { configured: false }
  | {
      configured: true;
      contract: string;
      config: Config;
      bounties: [number, Bounty][];
    };

function near(yocto: string | bigint): string {
  const value = BigInt(yocto);
  const fraction = (value % NEAR)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${value / NEAR}${fraction ? `.${fraction.slice(0, 6)}` : ""} ${COIN}`;
}
const utc = (secs: string | number) =>
  new Date(Number(secs) * 1000)
    .toISOString()
    .replace(".000Z", " UTC")
    .replace("T", " ");
const attestation = (id: string) =>
  `${OUTLAYER_API}/attestations/by-request/${id}`;
const nowSecs = () => Math.floor(Date.now() / 1000);

function Evidence({
  id,
  label,
}: {
  id: string | null | undefined;
  label: string;
}) {
  if (!id) return null;
  return (
    <a href={attestation(id)} target="_blank" rel="noreferrer">
      {label} {id}
    </a>
  );
}

function costs(config: Config) {
  const run = BigInt(config.run_deposit);
  return {
    run,
    budget: run * BigInt(config.budget_runs),
    storage: BigInt(config.storage_deposit),
  };
}

function PostBounty({
  contract,
  config,
  wallet,
  run,
  busy,
  done,
}: {
  contract: string;
  config: Config;
  wallet: Wallet;
  run: Run;
  busy: boolean;
  done: () => void;
}) {
  const [form, setForm] = useState({
    reward: "0.1",
    issue: "",
    base_ref: "main",
    github_id: "",
    claim_hours: "24",
    bind_hours: "48",
    merge_hours: "168",
    grace_minutes: "60",
  });
  const set =
    (key: keyof typeof form) => (event: { target: { value: string } }) =>
      setForm({ ...form, [key]: event.target.value });
  const { budget, storage } = costs(config);
  const room = BigInt(config.max_held) - BigInt(config.held);
  let reward = 0n;
  try {
    reward = parseNearAmount(form.reward, BigInt(config.max_reward));
  } catch {
    reward = 0n;
  }
  const submit = () =>
    run("Posting the bounty", async () => {
      const now = nowSecs();
      const hours = (h: string) => String(now + Math.round(Number(h) * 3600));
      await wallet.call({
        receiver: contract,
        method: "post_bounty",
        args: {
          reward: reward.toString(),
          repo: config.pilot_repo,
          repo_id: config.pilot_repo_id,
          issue: Number(form.issue),
          base_ref: form.base_ref.trim(),
          contributor_github_id: form.github_id.trim(),
          claim_by: hours(form.claim_hours),
          bind_by: hours(form.bind_hours),
          merge_deadline: hours(form.merge_hours),
          grace_secs: String(Math.round(Number(form.grace_minutes) * 60)),
        },
        deposit: reward + budget + storage,
        gas: 100n * TGAS,
      });
      done();
    });
  return (
    <section className="workspace-card">
      <h2>Post a bounty</h2>
      <p>
        You are the maintainer. You choose the contributor by their numeric
        GitHub id, nominate their pull request, and decide whether to merge it.
        The contract pays them if a check finds it merged into{" "}
        <code>{form.base_ref || "the branch"}</code> before the deadline.
      </p>
      <p>
        This pilot pays only for issues of{" "}
        <a
          href={`https://github.com/${config.pilot_repo}`}
          target="_blank"
          rel="noreferrer"
        >
          {config.pilot_repo}
        </a>{" "}
        (GitHub repository id {config.pilot_repo_id}), fixed when the contract
        was deployed.
      </p>
      <div className="bounty-form">
        <label>
          Issue number
          <input
            value={form.issue}
            onChange={set("issue")}
            inputMode="numeric"
          />
        </label>
        <label>
          Target branch
          <input value={form.base_ref} onChange={set("base_ref")} />
        </label>
        <label>
          Contributor's GitHub user id
          <input
            value={form.github_id}
            onChange={set("github_id")}
            inputMode="numeric"
          />
        </label>
        <label>
          Reward ({COIN}, at most {near(config.max_reward)})
          <input
            value={form.reward}
            onChange={set("reward")}
            inputMode="decimal"
          />
        </label>
        <label>
          Claim within (hours)
          <input
            value={form.claim_hours}
            onChange={set("claim_hours")}
            inputMode="decimal"
          />
        </label>
        <label>
          Nominate within (hours)
          <input
            value={form.bind_hours}
            onChange={set("bind_hours")}
            inputMode="decimal"
          />
        </label>
        <label>
          Merge before (hours from now)
          <input
            value={form.merge_hours}
            onChange={set("merge_hours")}
            inputMode="decimal"
          />
        </label>
        <label>
          Grace for checking (minutes, 10 to 1440)
          <input
            value={form.grace_minutes}
            onChange={set("grace_minutes")}
            inputMode="numeric"
          />
        </label>
      </div>
      <p>
        You attach {near(reward + budget + storage)}: the reward {near(reward)},{" "}
        {near(budget)} reserved for the contributor's merge checks (what is left
        comes back to you), and {near(storage)} for the record, which is kept as
        evidence and not returned. The contract can reserve{" "}
        {near(room > 0n ? room : 0n)} more; payouts and refunds count until
        their transfer is confirmed.
      </p>
      <button
        type="button"
        className="button button-primary"
        disabled={busy || reward === 0n || reward + budget > room}
        onClick={() => void submit()}
      >
        Post and lock {near(reward + budget + storage)}
      </button>
    </section>
  );
}

/** The gist id from an id or a gist link such as https://gist.github.com/<user>/<id>. */
function gistId(input: string): string {
  const path = input.trim().split(/[?#]/)[0] ?? "";
  return (path.split("/").filter(Boolean).pop() ?? "").toLowerCase();
}

function challengeKey(contract: string, id: number, wallet: string) {
  return `proven:pr-bounty-claim:${contract}:${id}:${wallet}`;
}

function ClaimAction({
  contract,
  id,
  bounty,
  wallet,
  run,
  busy,
  config,
  done,
}: {
  contract: string;
  id: number;
  bounty: Bounty;
  wallet: Wallet;
  run: Run;
  busy: boolean;
  config: Config;
  done: () => void;
}) {
  const key = challengeKey(contract, id, wallet.accountId);
  const [expires, setExpires] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem(key));
    return saved > nowSecs() + 60 ? saved : null;
  });
  const [challenge, setChallenge] = useState("");
  const [gist, setGist] = useState("");
  useEffect(() => {
    if (!expires) return;
    void api<{ challenge: string }>(
      `${PATH}/challenge/${id}/${wallet.accountId}/${expires}`,
    ).then((reply) => setChallenge(reply.challenge));
  }, [expires, id, wallet.accountId]);
  const start = () => {
    const value = nowSecs() + 50 * 60;
    localStorage.setItem(key, String(value));
    setExpires(value);
  };
  const prove = () =>
    run("Checking your claim gist", async () => {
      await wallet.call({
        receiver: contract,
        method: "prove_claim",
        args: {
          bounty_id: id,
          gist_id: gistId(gist),
          expires_at: String(expires),
        },
        deposit: BigInt(config.run_deposit),
        gas: RUN_GAS,
      });
      done();
    });
  return (
    <div className="bounty-action">
      <h4>
        Claim, as the contributor (GitHub id {bounty.contributor_github_id})
      </h4>
      {!expires || !challenge ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={start}
        >
          Get my claim challenge
        </button>
      ) : (
        <>
          <p>
            Signed in to GitHub as the account with id{" "}
            {bounty.contributor_github_id}, create a{" "}
            <a href="https://gist.github.com/" target="_blank" rel="noreferrer">
              gist
            </a>{" "}
            (secret or public) with exactly one file whose whole text is the
            line below, and prove it before {utc(expires)}. Only you can edit
            your gist, so repository writers cannot claim for you. The challenge
            names this wallet, {short(wallet.accountId)}, which becomes the only
            payout address, and this bounty, repository and issue. Keep the gist
            until the claim is proved.
          </p>
          <pre className="bounty-challenge">{challenge}</pre>
          <label>
            The gist's id or link (the hex id at the end of its address)
            <input
              value={gist}
              onChange={(e) => setGist(e.target.value)}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || !GIST_ID.test(gistId(gist))}
            onClick={() => void prove()}
          >
            Prove the claim ({near(config.run_deposit)}, unused compute
            returned)
          </button>
        </>
      )}
    </div>
  );
}

function Actions({
  contract,
  id,
  bounty,
  wallet,
  run,
  busy,
  config,
  done,
}: {
  contract: string;
  id: number;
  bounty: Bounty;
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
  config: Config;
  done: () => void;
}) {
  const [pr, setPr] = useState("");
  if (!wallet)
    return (
      <p className="workspace-empty">Connect a wallet to act on this bounty.</p>
    );
  const call = (
    label: string,
    method: string,
    args: Record<string, unknown>,
    deposit: bigint,
  ) =>
    run(label, async () => {
      await wallet.call({
        receiver: contract,
        method,
        args,
        deposit,
        gas: RUN_GAS,
      });
      done();
    });
  const isBuyer = wallet.accountId === bounty.buyer;
  const isContributor = wallet.accountId === bounty.claim?.wallet;
  const runCost = BigInt(config.run_deposit);
  const now = nowSecs();
  const due = [bounty.reward_transfer, bounty.budget_transfer].some(
    (t) => t?.state === "Due",
  );
  const recoverable = (
    [
      ["Reward", bounty.reward_transfer],
      ["Budget", bounty.budget_transfer],
    ] as [TransferKind, Transfer | null][]
  ).filter(([, t]) => t?.state === "Sending" && t.outcome !== "Unknown");
  const ended =
    bounty.status === "Ineligible" ||
    (bounty.status === "Open" && now >= Number(bounty.claim_by) + 15 * 60) ||
    (bounty.status === "Claimed" && now >= Number(bounty.bind_by)) ||
    (bounty.status === "Bound" &&
      now >= Number(bounty.merge_deadline) + Number(bounty.grace_secs));
  return (
    <div className="bounty-actions">
      {bounty.status === "Open" && now < Number(bounty.claim_by) ? (
        <ClaimAction
          {...{ contract, id, bounty, wallet, run, busy, config, done }}
        />
      ) : null}
      {bounty.status === "Open" && isBuyer ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call("Cancelling", "cancel", { bounty_id: id }, 0n)
          }
        >
          Cancel and refund (maintainer, before any claim)
        </button>
      ) : null}
      {bounty.status === "Claimed" &&
      isBuyer &&
      now < Number(bounty.bind_by) ? (
        <div className="bounty-action">
          <h4>Nominate the pull request, as the maintainer</h4>
          <p>
            Nominating is your decision that this pull request is the work for
            issue #{bounty.issue}. The check binds it only if it is open,
            unmerged, targets <code>{bounty.base_ref}</code> and was opened by
            GitHub id {bounty.claim?.github_id}.
          </p>
          <label>
            Pull request number
            <input
              value={pr}
              onChange={(e) => setPr(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || !/^[0-9]{1,10}$/.test(pr)}
            onClick={() =>
              void call(
                "Checking the pull request",
                "nominate",
                { bounty_id: id, pr_number: Number(pr) },
                runCost,
              )
            }
          >
            Nominate ({near(runCost)}, unused compute returned)
          </button>
        </div>
      ) : null}
      {bounty.status === "Bound" &&
      now < Number(bounty.merge_deadline) + Number(bounty.grace_secs) ? (
        <div className="bounty-action">
          <h4>Check the merge, as anyone</h4>
          <p>
            A merge into <code>{bounty.base_ref}</code> before{" "}
            {utc(bounty.merge_deadline)} pays{" "}
            {short(bounty.claim?.wallet ?? "")} automatically. An open pull
            request stays pending.
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !!bounty.live}
            onClick={() =>
              void call(
                "Checking the merge",
                "check_merge",
                { bounty_id: id },
                runCost,
              )
            }
          >
            Check, paying {near(runCost)} myself
          </button>
          {isContributor && bounty.budget_runs_left > 0 ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !!bounty.live}
              onClick={() =>
                void call(
                  "Checking the merge",
                  "check_merge",
                  { bounty_id: id },
                  0n,
                )
              }
            >
              Check from the bounty's budget ({bounty.budget_runs_left} left,
              free to you)
            </button>
          ) : null}
        </div>
      ) : null}
      {ended &&
      ["Open", "Claimed", "Bound", "Ineligible"].includes(bounty.status) ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call(
              "Refunding the maintainer",
              "settle",
              { bounty_id: id },
              0n,
            )
          }
        >
          Refund the maintainer (anyone, no cost)
        </button>
      ) : null}
      {due ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call("Resending", "send_due", { bounty_id: id }, 0n)
          }
        >
          Resend the failed transfer (anyone, same recipient)
        </button>
      ) : null}
      {recoverable.map(([kind, t]) => (
        <button
          key={kind}
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call(
              "Recording the transfer's result",
              "recover_transfer",
              { bounty_id: id, kind },
              0n,
            )
          }
        >
          Record the {kind === "Reward" ? "transfer" : "budget transfer"}{" "}
          {t?.outcome === "Succeeded" ? "as paid" : "as failed, to resend"}{" "}
          (anyone, no cost, sends nothing)
        </button>
      ))}
    </div>
  );
}

function transferText(t: Transfer): string {
  if (t.state === "Done") return "done";
  if (t.state === "Due") return "failed, can be resent";
  if (t.outcome === "Succeeded") return "sent; its result needs recording";
  if (t.outcome === "Failed") return "failed; its result needs recording";
  return "sent, awaiting its result (still reserved)";
}

function BountyCard(props: {
  contract: string;
  id: number;
  bounty: Bounty;
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
  config: Config;
  done: () => void;
}) {
  const { id, bounty } = props;
  const repo = `https://github.com/${bounty.repo}`;
  const transfers = [bounty.reward_transfer, bounty.budget_transfer].filter(
    (t): t is Transfer => !!t,
  );
  return (
    <article className="workspace-card bounty-card">
      <div className="workspace-section-heading">
        <h3>
          Bounty {id}:{" "}
          <a
            href={`${repo}/issues/${bounty.issue}`}
            target="_blank"
            rel="noreferrer"
          >
            {bounty.repo}#{bounty.issue}
          </a>
        </h3>
        <span className="status-pill">{bounty.status}</span>
      </div>
      <dl className="workspace-review bounty-facts">
        <dt>Reward</dt>
        <dd>{near(bounty.reward)}</dd>
        <dt>Maintainer</dt>
        <dd>{short(bounty.buyer)}</dd>
        <dt>Contributor</dt>
        <dd>
          GitHub id {bounty.contributor_github_id}
          {bounty.claim
            ? `, wallet ${short(bounty.claim.wallet)}`
            : ", not claimed"}
        </dd>
        <dt>Branch</dt>
        <dd>
          <code>{bounty.base_ref}</code> (repository id {bounty.repo_id})
        </dd>
        <dt>Deadlines</dt>
        <dd>
          claim by {utc(bounty.claim_by)}; nominate by {utc(bounty.bind_by)};
          merge before {utc(bounty.merge_deadline)}; checks until{" "}
          {utc(Number(bounty.merge_deadline) + Number(bounty.grace_secs))}
        </dd>
        <dt>Evidence</dt>
        <dd className="bounty-evidence">
          {bounty.claim ? (
            <>
              <a
                href={`https://gist.github.com/${bounty.claim.gist_id}`}
                target="_blank"
                rel="noreferrer"
              >
                claim gist
              </a>
              <Evidence id={bounty.claim.request_id} label="claim run" />
            </>
          ) : null}
          {bounty.binding ? (
            <>
              <a
                href={`${repo}/pull/${bounty.binding.pr_number}`}
                target="_blank"
                rel="noreferrer"
              >
                PR #{bounty.binding.pr_number}
              </a>
              <Evidence id={bounty.binding.request_id} label="binding run" />
            </>
          ) : null}
          {bounty.merge ? (
            <>
              <span>merged {utc(bounty.merge.merged_at)}</span>
              <Evidence id={bounty.merge.request_id} label="merge run" />
            </>
          ) : null}
          {bounty.last_check ? (
            <span>
              last check: {bounty.last_check.kind} →{" "}
              <code>{bounty.last_check.outcome}</code>{" "}
              <Evidence id={bounty.last_check.request_id} label="run" />
            </span>
          ) : null}
          {bounty.live ? (
            <span>a {bounty.live.kind.toLowerCase()} check is running</span>
          ) : null}
          {transfers.map((t) => (
            <span key={`${t.to}-${t.amount}`}>
              {near(t.amount)} to {short(t.to)}, attempt {t.attempt}:{" "}
              {transferText(t)}
            </span>
          ))}
        </dd>
      </dl>
      <Actions {...props} />
    </article>
  );
}

export function PrBounties({
  wallet,
  run,
  busy,
}: {
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [poster, setPoster] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api<Listing>(PATH)
      .then(setListing)
      .catch((reason: Error) => setError(reason.message));
  }, [version]);
  useEffect(() => {
    setPoster(false);
    if (!wallet || !listing?.configured) return;
    void api<{ poster: boolean }>(`${PATH}/poster/${wallet.accountId}`).then(
      (reply) => setPoster(reply.poster),
    );
  }, [wallet, listing]);
  const done = () => setVersion((v) => v + 1);
  if (error) return <p role="alert">{error}</p>;
  if (!listing) return <p role="status">Reading the bounties…</p>;
  if (!listing.configured)
    return (
      <section className="workspace-card">
        <h2>PR bounties</h2>
        <p className="workspace-empty">
          No PR bounty contract is configured on this network yet.
        </p>
      </section>
    );
  const { contract, config, bounties } = listing;
  const { run: runCost, budget, storage } = costs(config);
  return (
    <>
      <section className="workspace-card">
        <h2>
          PR bounties: automatic payout after an attested GitHub merge check
        </h2>
        <p>
          GitHub supplies the facts. The maintainer decides whether to merge.
          The contract <code>{contract}</code> relies on OutLayer's
          authenticated result and its approved workers, running Proven's
          verifier pinned at <code>{config.verifier_hash.slice(0, 12)}…</code>.
          Anyone can check a run's Intel quote independently from its
          attestation link. Proven checks the merge, not the quality of the work
          or whether the pull request solves the issue: the maintainer's
          nomination says that. This job type does not use the check challenge
          of Proven's data and function jobs.
        </p>
        <p>
          Every check attaches {near(runCost)}; OutLayer keeps about 0.0011 and
          returns the rest to whoever paid. A bounty locks its reward,{" "}
          {near(budget)} reserved for the contributor's own checks, and{" "}
          {near(storage)} of storage. Pilot: one public repository,{" "}
          <code>{config.pilot_repo}</code> (id {config.pilot_repo_id}),
          maintainers on the owner's allowlist
          {config.paused ? "; posting is paused" : ""}. A contributor proves
          their GitHub account with a gist they own, not with a comment.
        </p>
      </section>
      {wallet && poster && !config.paused ? (
        <PostBounty
          contract={contract}
          config={config}
          wallet={wallet}
          run={run}
          busy={busy}
          done={done}
        />
      ) : null}
      {bounties.length === 0 ? (
        <p className="workspace-empty">No bounties yet.</p>
      ) : null}
      {bounties
        .slice()
        .reverse()
        .map(([id, bounty]) => (
          <BountyCard
            key={id}
            {...{ contract, id, bounty, wallet, run, busy, config, done }}
          />
        ))}
    </>
  );
}
