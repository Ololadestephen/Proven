import { useState } from "react";
import { AgentsPage } from "./AgentsPage.tsx";
import { PrBounties } from "./PrBounties.tsx";
import { JobWorkspace } from "./JobWorkspace.tsx";
import { PostJob } from "./PostJob.tsx";
import type { Market, Wallet, Run } from "./market-types.ts";
import { nextStep, showNear, type MarketBid } from "./market-steps.ts";
import { short } from "./market-client.ts";
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
function MarketList({ bids }: { bids: MarketBid[] }) {
  // The server serves no query strings, so the completed view is chosen by the hash.
  const [tab, setTab] = useState(() =>
    location.hash === "#completed" ? "completed" : "open",
  );
  const selected = bids.filter((bid) =>
    tab === "completed" ? completed(bid) : !completed(bid),
  );
  const done = bids.filter(completed).length;
  return (
    <section className="workspace-card">
      <div className="workspace-tabs" aria-label="Market filter">
        {["open", "completed"].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {value === "open" ? "Open jobs" : "Completed & closed"}
          </button>
        ))}
      </div>
      <div className="workspace-queue">
        {selected.map((bid) => (
          <JobRow key={bid.id} bid={bid} />
        ))}
      </div>
      {!selected.length && tab === "open" ? (
        <div className="workspace-empty">
          <h3>No open jobs right now.</h3>
          <p>
            A job appears here once its buyer posts it and the bid review allows
            it.
            {done
              ? " Completed jobs show how a job runs and pays."
              : " The guide shows how a job runs and pays."}
          </p>
          <div className="workspace-empty-actions">
            {done ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setTab("completed")}
              >
                See completed and closed jobs
              </button>
            ) : null}
            <a className="workspace-card-link" href="/guide">
              How a job works
            </a>
          </div>
        </div>
      ) : null}
      {!selected.length && tab === "completed" ? (
        <p className="workspace-empty">
          No completed or closed jobs on this board.
        </p>
      ) : null}
    </section>
  );
}
function MyJobs({ market, wallet }: { market: Market; wallet: Wallet | null }) {
  const [role, setRole] = useState<"buying" | "delivering">("buying");
  const selected = ownBids(market.bids, wallet?.accountId ?? null, role);
  return (
    <section className="workspace-card">
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
      {wallet ? (
        <>
          <div className="workspace-queue">
            {selected.map((bid) => (
              <JobRow key={bid.id} bid={bid} />
            ))}
          </div>
          {!selected.length ? (
            <p className="workspace-empty">
              No jobs for this account in this view yet.
            </p>
          ) : null}
        </>
      ) : (
        <p className="workspace-empty">Connect a wallet to see your jobs.</p>
      )}
    </section>
  );
}
export function WorkspacePages({
  route,
  market,
  wallet,
  run,
  clock,
  busy,
}: {
  route: AppRoute;
  market: Market | null;
  wallet: Wallet | null;
  run: Run;
  clock: number;
  busy: boolean;
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
    return <PrBounties wallet={wallet} run={run} busy={busy} />;
  if (route.section === "market") return <MarketList bids={market.bids} />;
  if (route.section === "jobs")
    return <MyJobs market={market} wallet={wallet} />;
  return <Overview market={market} wallet={wallet} clock={clock} />;
}
