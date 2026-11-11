// The PR bounty list (status tabs, search, a grid of cards) and one page per bounty (progress
// path, the next step for whoever is looking, parties, terms, on-chain records and activity).
// Every action on the page is the existing `Actions` and `VaultPanel`, unchanged.
import { useEffect, useRef, useState } from "react";
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
import { LinkPanel } from "./LinkPanel.tsx";
import { TileToolbar, WorkTile, type TileKind } from "./WorkTile.tsx";
import { kindLabel } from "./vault-view.ts";
import {
  stepFromHash,
  activity,
  inTab,
  progressPath,
  TABS,
  tabCounts,
  type Tab,
} from "./bounty-board.ts";

type TitleOf = (repo: string, issue: number) => string | undefined;
// Without a title from GitHub the heading is the issue number; the repository is on the line below.
const issueName = (b: Bounty, titleOf: TitleOf) =>
  titleOf(b.repo, b.issue) ?? `Issue #${b.issue}`;
const tileKind = (b: Bounty): TileKind =>
  b.status === "Paid"
    ? "paid"
    : ["Refunded", "Cancelled"].includes(b.status)
      ? "closed"
      : "open";
const dot = (b: Bounty) => `bounty-dot ${tileKind(b)}`;

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
    <WorkTile
      href={`/app/bounties/${id}`}
      status={status.line}
      kind={tileKind(bounty)}
      reward={near(bounty.reward)}
      title={issueName(bounty, props.titleOf)}
      sub={`${bounty.repo}#${bounty.issue}${role ? ` · ${role}` : ""}`}
      tag="Merge check · attested"
      parties={[
        ["Maintainer", short(bounty.buyer)],
        [
          "Contributor",
          bounty.claim ? short(bounty.claim.wallet) : "Unclaimed",
        ],
      ]}
      linkText="View bounty"
    />
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
  const [tab, setTab] = useState<Tab>("open");
  const newest = props.bounties.slice().reverse();
  const counts = tabCounts(
    newest.map(([, b]) => b),
    me,
    ctx.now,
    ctx.config,
  );
  const shown = newest.filter(([, b]) =>
    inTab(tab, b, me, ctx.now, ctx.config),
  );
  return (
    <section className="bounty-board">
      <TileToolbar
        tabs={TABS.filter(([t]) => t !== "action" || me)}
        counts={counts}
        tab={tab}
        onTab={setTab}
      />
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
  // A contributor links GitHub once, right where the claim asks for it.
  const linked =
    ctx.link.state === "ready" &&
    !!(ctx.link.value?.active || ctx.link.value?.pending);
  const needsLink =
    bounty.status === "Open" &&
    !!me &&
    !isBuyer &&
    ctx.link.state === "ready" &&
    !linked;
  const path = progressPath(bounty);
  // A step link (from the agent tools, for example /app/bounties/3#submit-12) opens the page on
  // its step. Nothing is sent: the person still presses the button and approves in their wallet.
  const step = stepFromHash(
    typeof location === "undefined" ? "" : location.hash,
  );
  const nextStep = useRef<HTMLElement>(null);
  useEffect(() => {
    if (step.name) nextStep.current?.scrollIntoView({ block: "center" });
  }, [step.name]);
  // Finished: nothing more can happen in the contract (withdrawals happen in the vault).
  const finished =
    ["Paid", "Refunded", "Cancelled"].includes(bounty.status) &&
    settlements.every(([, s]) => s.state === "Done" && !s.reconcile);
  return (
    <article className="bounty-page">
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
          <ol
            className="job-progress"
            data-steps={path.length}
            aria-label="Bounty progress"
          >
            {path.map((step) => (
              <li
                key={step.label}
                data-status={step.state === "todo" ? undefined : step.state}
                aria-current={step.state === "current" ? "step" : undefined}
              >
                <span aria-hidden="true" />
                {step.label}
              </li>
            ))}
          </ol>
          {status.detail ? <p className="post-hint">{status.detail}</p> : null}
          <section className="bounty-next" ref={nextStep}>
            <h3>Your next step</h3>
            {finished ? (
              <p className="post-hint">
                Nothing left to do: this bounty is {bounty.status.toLowerCase()}{" "}
                and its money has settled.
                {vaults.length ? " Withdraw from your vault below." : ""}
              </p>
            ) : (
              <Actions id={id} bounty={bounty} ctx={ctx} initialPr={step.pr} />
            )}
          </section>
          {needsLink ? (
            <LinkPanel
              contract={ctx.contract}
              config={config}
              wallet={ctx.wallet}
              run={ctx.run}
              chain={ctx.chain}
              approved={ctx.approved}
              busy={ctx.busy}
              now={now}
              link={ctx.link}
              done={ctx.done}
            />
          ) : null}
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
            {/* While the bounty is open the claim step shows this notice above its button. */}
            {bounty.status === "Open" ? null : (
              <RefundNotice bounty={bounty} config={config} />
            )}
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
