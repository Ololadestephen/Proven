import { useState } from "react";
import { AgentsPage } from "./AgentsPage.tsx";
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
          <a href="/app/jobs">All my jobs</a>
        </div>
        {!wallet ? (
          <div className="workspace-empty">
            <h3>A clear view of your work.</h3>
            <p>Connect a wallet to see your jobs and next actions.</p>
            <a href="/app/market" className="button button-secondary">
              Explore the market
            </a>
          </div>
        ) : attention.length ? (
          <div className="workspace-queue">
            {attention.map(({ bid, label }) => (
              <JobRow key={bid.id} bid={bid} detail={label} />
            ))}
          </div>
        ) : (
          <div className="workspace-empty">
            <h3>Nothing needs you right now.</h3>
          </div>
        )}
      </section>
      <div className="workspace-grid">
        <a className="workspace-card" href="/app/market">
          <h2>Find work</h2>
          <p>Browse open tasks.</p>
        </a>
        <a className="workspace-card" href="/guide">
          <h2>How it works</h2>
          <p>Read how a job runs and pays.</p>
        </a>
      </div>
    </>
  );
}
function MarketList({ bids }: { bids: MarketBid[] }) {
  const [tab, setTab] = useState("open");
  const selected = bids.filter((bid) =>
    tab === "completed" ? completed(bid) : !completed(bid),
  );
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
      {!selected.length ? (
        <p className="workspace-empty">
          No {tab === "open" ? "open" : "completed or closed"} jobs on this
          board.
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
  if (route.section === "market") return <MarketList bids={market.bids} />;
  if (route.section === "jobs")
    return <MyJobs market={market} wallet={wallet} />;
  return <Overview market={market} wallet={wallet} clock={clock} />;
}
