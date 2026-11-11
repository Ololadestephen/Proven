import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarketLayout } from "./MarketLayout.tsx";
import { WorkspacePages } from "./WorkspacePages.tsx";
import { WalletControls } from "./WalletControls.tsx";
import { useMarket } from "./use-market.ts";
import { appRoute } from "./app-route.ts";
import { canPost } from "./network.ts";
import "../public/workspace.css";
function ProgressToast({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timer);
  }, []);
  return visible ? (
    <div className="market-toast market-toast-progress">
      <p role="status">{message}</p>
    </div>
  ) : null;
}

function App() {
  const route = appRoute(location.pathname, location.hash);
  const state = useMarket(route.bidId);
  const {
    market,
    wallet,
    connect,
    connecting,
    dev,
    useDev,
    busy,
    pending,
    notice,
    error,
    boardUnavailable,
    setError,
    clock,
    run,
    refresh,
    releasePending,
    bounty,
  } = state;
  return (
    <MarketLayout
      title={route.title}
      subtitle={route.subtitle}
      active={route.section}
      canPostJob={canPost(wallet?.accountId)}
      walletControls={
        <WalletControls
          wallet={wallet}
          connect={connect}
          connecting={connecting}
          dev={dev}
          useDev={useDev}
          onError={setError}
          busy={!!busy}
        />
      }
    >
      {error ? (
        <div className="market-toast">
          <p role="alert">{error}</p>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      ) : busy ? (
        <ProgressToast key={busy} message={busy} />
      ) : notice ? (
        <div className="market-toast market-toast-success">
          <p role="status">{notice}</p>
        </div>
      ) : null}
      {pending && !busy && route.section !== "bounties" ? (
        <p className="market-note" role="status">
          {pending.label}: confirming on chain…
        </p>
      ) : null}
      {route.section === "market" && !canPost(wallet?.accountId) ? (
        <p className="market-note">
          Only listed buyers can post for now. Anyone can apply to work.
        </p>
      ) : null}
      {market?.paused ? (
        <p className="market-error">
          New jobs and funding are paused on this escrow.
        </p>
      ) : null}
      {boardUnavailable ? (
        <section className="workspace-card">
          <p role="status">
            {market
              ? "Showing the last loaded jobs. Actions will resume when the board reconnects."
              : "The job board is temporarily unavailable. We’ll retry automatically."}
          </p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void refresh().catch(() => undefined)}
          >
            Try again
          </button>
        </section>
      ) : null}
      {market || !boardUnavailable ? (
        <WorkspacePages
          route={route}
          market={market}
          wallet={wallet}
          run={run}
          clock={clock}
          busy={!!busy || !!pending || boardUnavailable}
          bounty={bounty}
          bountyBusy={!!busy}
        />
      ) : null}
    </MarketLayout>
  );
}
createRoot(document.getElementById("market")!).render(<App />);
