import { useEffect, useState } from "react";
import { AgentsPage } from "./AgentsPage.tsx";
import { PrBounties } from "./PrBounties.tsx";
import type { BountyActions } from "./use-bounty-actions.ts";
import { JobWorkspace } from "./JobWorkspace.tsx";
import { PostJob } from "./PostJob.tsx";
import type { Market, Wallet, Run } from "./market-types.ts";
import { nextStep, showNear, type MarketBid } from "./market-steps.ts";
import { api, short } from "./market-client.ts";
import type { Bounty, Listing } from "./bounty-types.ts";
import { bountyNextStep } from "./bounty-board.ts";
import { near } from "./bounty-text.ts";
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
function BountyRow(props: { id: number; bounty: Bounty; detail: string }) {
  const { id, bounty } = props;
  return (
    <a href={`/app/bounties/${id}`} className="workspace-list-row">
      <div>
        <span className="workspace-list-meta">
          Bounty {id} · {bounty.repo}#{bounty.issue}
        </span>
        <h3>{props.detail}</h3>
        <p>{bounty.status}</p>
      </div>
      <strong>{near(bounty.reward)}</strong>
    </a>
  );
}

/** The PR bounties that need this wallet now. Empty while loading or when bounties are off. */
function useBountyAttention(account: string | null, clock: number) {
  const [listing, setListing] = useState<Listing | null>(null);
  useEffect(() => {
    if (!account) return;
    api<Listing>("/api/market/bounties")
      .then(setListing)
      .catch(() => setListing(null));
  }, [account]);
  if (!account || !listing?.configured) return [];
  const now = Math.floor(clock / 1000);
  return listing.bounties.flatMap(([id, bounty]) => {
    const label = bountyNextStep(bounty, account, now, listing.config);
    return label ? [{ id, bounty, label }] : [];
  });
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
  const bounties = useBountyAttention(account ?? null, clock);
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
        ) : attention.length || bounties.length ? (
          <div className="workspace-queue">
            {attention.map(({ bid, label }) => (
              <JobRow key={bid.id} bid={bid} detail={label} />
            ))}
            {bounties.map(({ id, bounty, label }) => (
              <BountyRow
                key={`bounty-${id}`}
                id={id}
                bounty={bounty}
                detail={label}
              />
            ))}
          </div>
        ) : (
          <p>Nothing needs you right now.</p>
        )}
      </section>
      <div className="workspace-grid workspace-grid-3">
        <a className="workspace-card" href="/app/market">
          <h2>Find work</h2>
          <p>Browse open tasks.</p>
          <span className="workspace-card-link">Open the market</span>
        </a>
        <a className="workspace-card" href="/app/bounties">
          <h2>PR bounties</h2>
          <p>Get paid when your pull request merges.</p>
          <span className="workspace-card-link">See the bounties</span>
        </a>
        <a className="workspace-card" href="/docs">
          <h2>How it works</h2>
          <p>Read how a job runs and pays.</p>
          <span className="workspace-card-link">Read the docs</span>
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
type JobTab = "all" | "open" | "progress" | "paid" | "closed" | "mine";
const JOB_TABS: [JobTab, string][] = [
  ["all", "All"],
  ["open", "Open"],
  ["progress", "In progress"],
  ["paid", "Paid"],
  ["closed", "Closed"],
];
/** Which tab a job belongs to. A refund is never shown as paid. */
export function jobTab(bid: MarketBid): Exclude<JobTab, "all" | "mine"> {
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
  // Jobs this wallet buys or delivers, the way "Needs action" works on the bounty list.
  const mine = new Set(
    [
      ...ownBids(newest, viewer, "buying"),
      ...ownBids(newest, viewer, "delivering"),
    ].map((bid) => bid.id),
  );
  const inTab = (t: JobTab, bid: MarketBid) =>
    t === "all" || (t === "mine" ? mine.has(bid.id) : jobTab(bid) === t);
  // Mine shows with a wallet, and on /app/jobs so the tab it opens on is always visible.
  const tabs: [JobTab, string][] =
    viewer || initial === "mine" ? [...JOB_TABS, ["mine", "Mine"]] : JOB_TABS;
  const counts = Object.fromEntries(
    tabs.map(([t]) => [t, newest.filter((bid) => inTab(t, bid)).length]),
  ) as Record<JobTab, number>;
  const shown = newest.filter((bid) => inTab(tab, bid));
  return (
    <section className="bounty-board">
      <TileToolbar tabs={tabs} counts={counts} tab={tab} onTab={setTab} />
      {tab === "mine" && !viewer ? (
        <p className="workspace-empty">Connect a wallet to see your jobs.</p>
      ) : shown.length ? (
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
  // /app/jobs, the old My jobs address, opens on the Mine tab.
  const initial: JobTab =
    location.pathname === "/app/jobs"
      ? "mine"
      : location.hash === "#completed"
        ? "paid"
        : "open";
  return (
    <JobGrid
      bids={bids}
      viewer={viewer}
      initial={initial}
      empty="No jobs on this board yet."
    />
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
  // PR bounties read their own contract, so they do not wait for the job board.
  if (route.section === "bounties")
    return (
      <PrBounties
        actions={bounty}
        busy={bountyBusy}
        bountyId={route.bountyId}
      />
    );
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
  if (route.section === "market")
    return <MarketList bids={market.bids} viewer={wallet?.accountId ?? null} />;
  return <Overview market={market} wallet={wallet} clock={clock} />;
}
