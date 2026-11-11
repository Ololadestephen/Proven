// The PR bounty list (status tabs, search, a grid of cards) and one page per bounty (progress
// path, the next step for whoever is looking, parties, terms, on-chain records and activity).
// Every action on the page is the existing `Actions` and `VaultPanel`, unchanged.
import { useState } from "react";
import { short } from "./market-client.ts";
import type { Bounty } from "./bounty-types.ts";
import { near } from "./bounty-text.ts";
import {
  bountyStatus,
  checksUntil,
  graceEnds,
  hardRefundAt,
  utc,
} from "./bounty-status.ts";
import { duration } from "./posting-review.ts";
import {
  Actions,
  Evidence,
  present,
  RefundNotice,
  type CardContext,
} from "./BountyCard.tsx";
import { VaultPanel } from "./VaultPanel.tsx";
import { kindLabel } from "./vault-view.ts";
import {
  activity,
  inTab,
  matches,
  progressPath,
  TABS,
  tabCounts,
  type Tab,
} from "./bounty-board.ts";

type TitleOf = (repo: string, issue: number) => string | undefined;
const issueName = (b: Bounty, titleOf: TitleOf) =>
  titleOf(b.repo, b.issue) ?? `${b.repo}#${b.issue}`;
const dot = (b: Bounty) =>
  b.status === "Paid"
    ? "bounty-dot paid"
    : ["Refunded", "Cancelled"].includes(b.status)
      ? "bounty-dot closed"
      : "bounty-dot open";

/** One bounty in the grid. */
export function BountyTile(props: {
  id: number;
  bounty: Bounty;
  ctx: CardContext;
  titleOf: TitleOf;
}) {
  const { id, bounty, ctx } = props;
  const status = bountyStatus(bounty, ctx.now);
  const me = ctx.wallet?.accountId;
  const role =
    me && me === bounty.buyer
      ? "Yours"
      : me && me === bounty.claim?.wallet
        ? "Your claim"
        : "";
  return (
    <a className="bounty-tile" href={`/app/bounties/${id}`}>
      <div className="bounty-tile-top">
        <span>
          <i className={dot(bounty)} aria-hidden="true" />
          {status.line}
        </span>
        <strong className="bounty-tile-reward">{near(bounty.reward)}</strong>
      </div>
      <h3>{issueName(bounty, props.titleOf)}</h3>
      <p className="bounty-tile-repo">
        {bounty.repo}#{bounty.issue}
        {role ? ` · ${role}` : ""}
      </p>
      <span className="bounty-tag">Merge check · attested</span>
      <dl className="bounty-tile-parties">
        <div>
          <dt>Maintainer</dt>
          <dd>{short(bounty.buyer)}</dd>
        </div>
        <div>
          <dt>Contributor</dt>
          <dd>{bounty.claim ? short(bounty.claim.wallet) : "Unclaimed"}</dd>
        </div>
      </dl>
      <span className="bounty-tile-link">View bounty →</span>
    </a>
  );
}

/** Status tabs with counts, a search box and the grid. */
export function BountyList(props: {
  bounties: [number, Bounty][];
  ctx: CardContext;
  titleOf: TitleOf;
}) {
  const { ctx } = props;
  const me = ctx.wallet?.accountId ?? null;
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const newest = props.bounties.slice().reverse();
  const counts = tabCounts(
    newest.map(([, b]) => b),
    me,
    ctx.now,
    ctx.config,
  );
  const shown = newest.filter(
    ([, b]) =>
      inTab(tab, b, me, ctx.now, ctx.config) &&
      matches(b, props.titleOf(b.repo, b.issue), query),
  );
  return (
    <section className="bounty-board">
      <div className="bounty-toolbar">
        <div className="bounty-tabs" role="tablist">
          {TABS.filter(([t]) => t !== "action" || me).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "bounty-tab active" : "bounty-tab"}
              onClick={() => setTab(t)}
            >
              {label} <span className="bounty-count">{counts[t]}</span>
            </button>
          ))}
        </div>
        <input
          className="bounty-search"
          type="search"
          placeholder="Search by title or repository"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search bounties"
        />
      </div>
      {shown.length ? (
        <div className="bounty-grid">
          {shown.map(([id, bounty]) => (
            <BountyTile
              key={id}
              id={id}
              bounty={bounty}
              ctx={ctx}
              titleOf={props.titleOf}
            />
          ))}
        </div>
      ) : (
        <p className="workspace-empty">
          {props.bounties.length ? "No bounties here." : "No bounties yet."}
        </p>
      )}
    </section>
  );
}

/** One bounty's page. */
export function BountyPage(props: {
  id: number;
  bounty: Bounty;
  ctx: CardContext;
  titleOf: TitleOf;
  inVault: Map<string, number>;
}) {
  const { id, bounty, ctx } = props;
  const { config, now } = ctx;
  const status = bountyStatus(bounty, now);
  const repo = `https://github.com/${bounty.repo}`;
  const me = ctx.wallet?.accountId;
  const isBuyer = !!me && me === bounty.buyer;
  const isClaimant = !!me && me === bounty.claim?.wallet;
  const settlements = present(bounty);
  const vaults = [
    ...new Set(
      settlements
        .map(([, s]) => s.vault)
        .filter(
          (v) =>
            (isBuyer && v === bounty.maintainer_vault) ||
            (isClaimant && v === bounty.claim?.vault),
        ),
    ),
  ];
  const events = activity(bounty);
  // Finished: nothing more can happen in the contract (withdrawals happen in the vault).
  const finished =
    ["Paid", "Refunded", "Cancelled"].includes(bounty.status) &&
    settlements.every(([, s]) => s.state === "Done" && !s.reconcile);
  return (
    <article className="bounty-page">
      <a className="bounty-back" href="/app/bounties">
        ← Bounties
      </a>
      <div className="bounty-page-grid">
        <div className="bounty-page-main">
          <p className="bounty-page-status">
            <i className={dot(bounty)} aria-hidden="true" />
            {status.line} ·{" "}
            <a
              href={`${repo}/issues/${bounty.issue}`}
              target="_blank"
              rel="noreferrer"
            >
              {bounty.repo}#{bounty.issue}
            </a>{" "}
            · bounty {id}
          </p>
          <h2 className="bounty-page-title">
            {issueName(bounty, props.titleOf)}
          </h2>
          <p className="bounty-page-reward">{near(bounty.reward)}</p>
          <ol className="bounty-path" aria-label="Progress">
            {progressPath(bounty).map((step) => (
              <li key={step.label} className={`bounty-step ${step.state}`}>
                <span aria-hidden="true" />
                {step.label}
              </li>
            ))}
          </ol>
          {status.detail ? <p className="post-hint">{status.detail}</p> : null}
          <section className="bounty-next">
            <h3>Your next step</h3>
            {finished ? (
              <p className="post-hint">
                Nothing left to do: this bounty is {bounty.status.toLowerCase()}{" "}
                and its money has settled.
                {vaults.length ? " Withdraw from your vault below." : ""}
              </p>
            ) : (
              <Actions id={id} bounty={bounty} ctx={ctx} />
            )}
          </section>
          {vaults.map((v) => (
            <VaultPanel
              key={v}
              vault={v}
              network={config.network}
              wallet={ctx.wallet}
              run={ctx.run}
              busy={ctx.busy}
              approved={ctx.approved}
              near={near}
              chain={ctx.chain}
              now={now}
              partyDelaySecs={config.party_reconcile_delay_secs}
              entries={settlements
                .filter(([, s]) => s.vault === v)
                .map(([kind, s]) => ({
                  label: kindLabel(kind),
                  settlement: s,
                }))}
              shared={props.inVault.get(v) ?? 0}
            />
          ))}
          <section>
            <h3>How it is judged</h3>
            <p className="post-hint">
              Paid when a pull request by the claimant is merged into{" "}
              <code>{bounty.base_ref}</code> before {utc(bounty.merge_deadline)}
              , as read from GitHub by Proven's verifier in an attested OutLayer
              run. Nobody's opinion decides it.
            </p>
            <RefundNotice bounty={bounty} config={config} />
          </section>
        </div>
        <aside className="bounty-page-side">
          <h4>Parties</h4>
          <dl>
            <dt>Maintainer</dt>
            <dd>{bounty.buyer}</dd>
            <dt>Contributor</dt>
            <dd>
              {bounty.claim
                ? `${bounty.claim.wallet} · GitHub id ${bounty.claim.github_id}`
                : "Unclaimed"}
            </dd>
          </dl>
          <h4>Terms</h4>
          <dl>
            <dt>Claims until</dt>
            <dd>{utc(bounty.claim_by)}</dd>
            <dt>A claim lasts</dt>
            <dd>{duration(Number(bounty.claim_secs))}</dd>
            <dt>Merge before</dt>
            <dd>{utc(bounty.merge_deadline)}</dd>
            <dt>Refund from</dt>
            <dd>{utc(graceEnds(bounty))}, if checked not merged</dd>
            <dt>Checks until</dt>
            <dd>{utc(checksUntil(bounty, config.refund_cap_secs))}</dd>
          </dl>
          <h4>On chain</h4>
          <dl>
            <dt>Contract</dt>
            <dd>
              <code>{ctx.contract}</code>
            </dd>
            {bounty.binding ? (
              <>
                <dt>Pull request</dt>
                <dd>
                  <a
                    href={`${repo}/pull/${bounty.binding.pr_number}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{bounty.binding.pr_number}
                  </a>{" "}
                  <Evidence id={bounty.binding.request_id} label="run" />
                </dd>
              </>
            ) : null}
            {bounty.merge ? (
              <>
                <dt>Merge check</dt>
                <dd>
                  <Evidence id={bounty.merge.request_id} label="run" />
                </dd>
              </>
            ) : null}
            {settlements.map(([kind, s]) => (
              <span key={kind}>
                <dt>{kind === "Payout" ? "Payout" : "Refund"}</dt>
                <dd>
                  {near(s.principal)} to <code>{short(s.vault)}</code>,{" "}
                  {s.state === "Done" ? "confirmed" : s.state.toLowerCase()}
                </dd>
              </span>
            ))}
            <dt>Refund if never read</dt>
            <dd>{utc(hardRefundAt(bounty, config.refund_cap_secs))}</dd>
          </dl>
          <h4>Activity</h4>
          <ol className="bounty-activity">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                {e.text}
                <time>{utc(e.at)}</time>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </article>
  );
}
