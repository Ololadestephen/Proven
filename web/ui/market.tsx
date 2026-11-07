import { createRoot } from "react-dom/client";
import { MarketLayout } from "./MarketLayout.tsx";
import { WorkspacePages } from "./WorkspacePages.tsx";
import { WalletControls } from "./WalletControls.tsx";
import { useMarket } from "./use-market.ts";
import { appRoute } from "./app-route.ts";
import { canPost } from "./network.ts";
import "../public/workspace.css";
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
    setError,
    clock,
    run,
    refresh,
    releasePending,
  } = state;
  return (
    <MarketLayout
      title={route.title}
      subtitle={route.subtitle}
      active={route.section}
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
      {busy ? (
        <p className="market-status" role="status">
          {busy}… review any request in your wallet.
        </p>
      ) : null}
      {/* The post page has its own success screen. */}
      {notice && route.section !== "post" ? (
        <p className="market-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="market-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending && !busy ? (
        <section className="workspace-card job-pending">
          <h2>Did that go through?</h2>
          <p>
            {pending.label}. We haven’t seen this on the chain yet, so other
            actions are paused to stop it being sent twice.
          </p>
          <div className="market-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={clock - pending.createdAt < 15000}
              onClick={() =>
                void releasePending().catch((reason) =>
                  setError(reason.message),
                )
              }
            >
              {clock - pending.createdAt < 15000
                ? "Checking the chain…"
                : "I cancelled it: check and continue"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() =>
                void refresh().catch((reason) => setError(reason.message))
              }
            >
              Check again
            </button>
          </div>
          <p className="post-hint">
            If you signed it, this clears by itself once it lands. Pressing
            “check and continue” reads the chain first.
          </p>
        </section>
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
      <WorkspacePages
        route={route}
        market={market}
        wallet={wallet}
        run={run}
        clock={clock}
        busy={!!busy || !!pending}
      />
    </MarketLayout>
  );
}
createRoot(document.getElementById("market")!).render(<App />);
