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

/** Whether a click on this link can move inside the app without reloading the page. */
function inAppLink(event: MouseEvent): HTMLAnchorElement | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return null;
  const link = (event.target as Element | null)?.closest?.("a");
  if (!link || link.target || link.hasAttribute("download")) return null;
  const url = new URL(link.href, location.href);
  return url.origin === location.origin && url.pathname.startsWith("/app")
    ? link
    : null;
}

/** The app's address. Links inside /app change it without a page reload, so the wallet, the loaded
 * market and the scripts stay in place; back and forward work as before. */
function useAppPath(): string {
  const [path, setPath] = useState(location.pathname + location.hash);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const link = inAppLink(event);
      if (!link) return;
      const url = new URL(link.href, location.href);
      event.preventDefault();
      if (url.pathname + url.hash !== location.pathname + location.hash)
        history.pushState(null, "", url.pathname + url.hash);
      setPath(url.pathname + url.hash);
      if (url.hash)
        document.getElementById(url.hash.slice(1))?.scrollIntoView();
      else window.scrollTo(0, 0);
    };
    const onPop = () => setPath(location.pathname + location.hash);
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);
  return path;
}

function App() {
  const path = useAppPath();
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
          // Each address starts its page fresh, as a full load did.
          key={path}
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
