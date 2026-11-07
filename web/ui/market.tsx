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
        <section className="workspace-card">
          <h2>Confirm the previous action</h2>
          <p>
            {pending.label}. Further actions are paused until the board reflects
            the expected change. A wallet error can still mean a transaction
            reached the chain.
          </p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              void refresh().catch((reason) => setError(reason.message))
            }
          >
            Check the board again
          </button>
          <p className="workspace-note">
            If you rejected the request or it failed, check your wallet’s
            transaction history before asking support to reconcile this
            browser’s pending action. Nothing is resubmitted automatically.
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
