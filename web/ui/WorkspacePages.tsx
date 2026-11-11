import { useState } from "react";
import { AgentsPage } from "./AgentsPage.tsx";
import { PrBounties } from "./PrBounties.tsx";
import type { BountyActions } from "./use-bounty-actions.ts";
import { JobWorkspace } from "./JobWorkspace.tsx";
import { PostJob } from "./PostJob.tsx";
import type { Market, Wallet, Run } from "./market-types.ts";
import { nextStep, showNear, type MarketBid } from "./market-steps.ts";
import { short } from "./market-client.ts";
import { TileToolbar, WorkTile } from "./WorkTile.tsx";
import { bidTitle, completed, ownBids, type AppRoute } from "./app-route.ts";
function JobRow({ bid, detail }: { bid: MarketBid; detail?: string }) {
  return (
    <a href={`/app/bids/${bid.id}`} className="workspace-list-row">
      <div>
        <span className="workspace-list-meta">
          Bid {bid.id} · {bid.job?.state ?? bid.state}
        </span>
        <h3>{bidTitle(bid)}</h3>
        <p>{detail ?? `By ${short(bid.buyer)}`}</p>
      </div>
      <strong>{showNear(bid.amount)}</strong>
    </a>
  );
}
function Overview({
  market,
  wallet,
  clock,
}: {
  market: Market;
  wallet: Wallet | null;
  clock: number;
}) {
  const account = wallet?.accountId;
  const attention = account
    ? market.bids
        .filter((bid) => bid.buyer === account || bid.claim?.agent === account)
        .flatMap((bid) => {
          const step = nextStep(
            bid,
            account,
            market.agents.includes(account),
            clock,
          );
          return step && step.id !== "wait" ? [{ bid, label: step.label }] : [];
        })
    : [];
  return (
    <>
      <section className="workspace-card">
        <div className="workspace-section-heading">
          <h2>Needs your attention</h2>
          {wallet ? <a href="/app/jobs">All my jobs</a> : null}
        </div>
        {!wallet ? (
          <p>
            Connect a wallet from the sidebar to see your jobs and what each one
            needs next.
          </p>
        ) : attention.length ? (
          <div className="workspace-queue">
            {attention.map(({ bid, label }) => (
              <JobRow key={bid.id} bid={bid} detail={label} />
            ))}
          </div>
        ) : (
          <p>Nothing needs you right now.</p>
        )}
      </section>
      <div className="workspace-grid">
        <a className="workspace-card" href="/app/market">
          <h2>Find work</h2>
          <p>Browse open tasks.</p>
          <span className="workspace-card-link">Open the market</span>
        </a>
        <a className="workspace-card" href="/guide">
          <h2>How it works</h2>
          <p>Read how a job runs and pays.</p>
          <span className="workspace-card-link">Read the guide</span>
        </a>
      </div>
      <RecentResults bids={market.bids} />
    </>
  );
}
/** Finished jobs, newest first, so a first visit shows real outcomes from the chain. */
function RecentResults({ bids }: { bids: MarketBid[] }) {
  const finished = bids
    .filter(
      (bid) => completed(bid) && !["Cancelled", "Blocked"].includes(bid.state),
    )
    .sort((a, b) => b.id - a.id)
    .slice(0, RECENT_RESULTS);
  if (!finished.length) return null;
  return (
    <section className="workspace-card">
      <div className="workspace-section-heading">
        <h2>Recent results</h2>
        <a href="/app/market#completed">All completed jobs</a>
      </div>
      <div className="workspace-queue">
        {finished.map((bid) => (
          <JobRow key={bid.id} bid={bid} detail={outcome(bid)} />
        ))}
      </div>
    </section>
  );
}
const RECENT_RESULTS = 3;
/** The escrow's outcome in a few words. A refund is never shown as success. */
function outcome(bid: MarketBid) {
  const job = bid.job ?? bid.last_job;
  if (job?.state === "Released") return `Paid ${showNear(job.amount)}`;
  if (job?.state === "Refunded") return "Refunded to the buyer";
  return bid.state === "Done" ? "Done" : "Closed";
}
type JobTab = "all" | "open" | "progress" | "paid" | "closed";
const JOB_TABS: [JobTab, string][] = [
  ["all", "All"],
  ["open", "Open"],
  ["progress", "In progress"],
  ["paid", "Paid"],
  ["closed", "Closed"],
];
/** Which tab a job belongs to. A refund is never shown as paid. */
export function jobTab(bid: MarketBid): Exclude<JobTab, "all"> {
  const job = bid.job ?? bid.last_job;
  if (completed(bid)) return job?.state === "Released" ? "paid" : "closed";
  return bid.claim || bid.job ? "progress" : "open";
}
const jobKind = (bid: MarketBid) =>
  jobTab(bid) === "paid"
    ? "paid"
    : jobTab(bid) === "closed"
      ? "closed"
      : "open";
function JobTile({ bid, viewer }: { bid: MarketBid; viewer: string | null }) {
  const job = bid.job ?? bid.last_job;
  const worker = bid.claim?.agent ?? job?.worker;
  const role =
    viewer && viewer === bid.buyer
      ? " · Yours"
      : viewer && viewer === worker
        ? " · Your job"
        : "";
  return (
    <WorkTile
      href={`/app/bids/${bid.id}`}
      status={
        jobTab(bid) === "paid"
          ? "Paid"
          : jobTab(bid) === "closed"
            ? job?.state === "Refunded"
              ? "Refunded"
              : "Closed"
            : (bid.job?.state ?? bid.state)
      }
      kind={jobKind(bid)}
      reward={showNear(bid.amount)}
      title={bidTitle(bid)}
      sub={`Job ${bid.id}${role}`}
      tag="Executable check · attested"
      parties={[
        ["Buyer", short(bid.buyer)],
        ["Worker", worker ? short(worker) : "Unclaimed"],
      ]}
      linkText="View job"
    />
  );
}
/** Tabs with counts, a search box and a grid of jobs. */
function JobGrid({
  bids,
  viewer,
  initial = "open",
  empty,
}: {
  bids: MarketBid[];
  viewer: string | null;
  initial?: JobTab;
  empty: string;
}) {
  const [tab, setTab] = useState<JobTab>(initial);
  const newest = bids.slice().sort((a, b) => b.id - a.id);
  const counts = Object.fromEntries(
    JOB_TABS.map(([t]) => [
      t,
      newest.filter((bid) => t === "all" || jobTab(bid) === t).length,
    ]),
  ) as Record<JobTab, number>;
  const shown = newest.filter((bid) => tab === "all" || jobTab(bid) === tab);
  return (
    <section className="bounty-board">
      <TileToolbar tabs={JOB_TABS} counts={counts} tab={tab} onTab={setTab} />
      {shown.length ? (
        <div className="bounty-grid">
          {shown.map((bid) => (
            <JobTile key={bid.id} bid={bid} viewer={viewer} />
          ))}
        </div>
      ) : (
        <p className="workspace-empty">
          {bids.length ? "No jobs here." : empty}
        </p>
      )}
    </section>
  );
}
function MarketList({
  bids,
  viewer,
}: {
  bids: MarketBid[];
  viewer: string | null;
}) {
  // The server serves no query strings, so the completed view is chosen by the hash.
  const initial = location.hash === "#completed" ? "paid" : "open";
  return (
    <JobGrid
      bids={bids}
      viewer={viewer}
      initial={initial}
      empty="No jobs on this board yet."
    />
  );
}
function MyJobs({ market, wallet }: { market: Market; wallet: Wallet | null }) {
  const [role, setRole] = useState<"buying" | "delivering">("buying");
  const viewer = wallet?.accountId ?? null;
  const selected = ownBids(market.bids, viewer, role);
  if (!wallet)
    return (
      <p className="workspace-empty">Connect a wallet to see your jobs.</p>
    );
  return (
    <>
      <div className="workspace-tabs" aria-label="Your role">
        {(["buying", "delivering"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={role === value}
            onClick={() => setRole(value)}
          >
            {value === "buying" ? "Buying" : "Delivering"}
          </button>
        ))}
      </div>
      <JobGrid
        key={role}
        bids={selected}
        viewer={viewer}
        empty="No jobs for this account in this view yet."
      />
    </>
  );
}
export function WorkspacePages({
  route,
  market,
  wallet,
  run,
  clock,
  busy,
  bounty,
  bountyBusy,
}: {
  route: AppRoute;
  market: Market | null;
  wallet: Wallet | null;
  run: Run;
  clock: number;
  busy: boolean;
  /** The PR bounty page's wallet, run function and journal. */
  bounty: BountyActions;
  /** An action is running. The bounty page does not wait on the job board. */
  bountyBusy: boolean;
}) {
  if (!market) return <p role="status">Reading the board…</p>;
  if (route.bidId !== undefined) {
    const bid = market.bids.find((item) => item.id === route.bidId);
    return bid ? (
      <JobWorkspace
        bid={bid}
        market={market}
        wallet={wallet}
        run={run}
        clock={clock}
        busy={busy}
      />
    ) : (
      <section className="workspace-empty">
        <h2>Bid not found</h2>
        <a href="/app/market">Browse the market</a>
      </section>
    );
  }
  if (route.section === "post")
    return <PostJob market={market} wallet={wallet} run={run} busy={busy} />;
  if (route.section === "agents")
    return <AgentsPage wallet={wallet} run={run} busy={busy} />;
  if (route.section === "bounties")
    return (
      <PrBounties
        actions={bounty}
        busy={bountyBusy}
        bountyId={route.bountyId}
      />
    );
  if (route.section === "market")
    return <MarketList bids={market.bids} viewer={wallet?.accountId ?? null} />;
  if (route.section === "jobs")
    return <MyJobs market={market} wallet={wallet} />;
  return <Overview market={market} wallet={wallet} clock={clock} />;
}
