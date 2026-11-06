import type { ReactNode } from "react";
import { WorkspaceNavigation } from "./WorkspaceNavigation.tsx";
import { MARKET_NAVIGATION } from "./navigation-state.ts";

export function MarketLayout({
  walletControls,
  children,
}: {
  walletControls: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app-frame">
      <a className="skip-link" href="#market-overview">
        Skip to market
      </a>
      <aside className="app-sidebar" aria-label="Workspace navigation">
        <a className="wordmark" href="/" aria-label="Proven home">
          <span className="brand-mark" aria-hidden="true">
            p.
          </span>
          Proven
        </a>
        <p className="sidebar-label">YOUR WORKSPACE</p>
        <WorkspaceNavigation
          items={MARKET_NAVIGATION}
          defaultSection="market"
        />
        <div className="sidebar-bottom">
          <a href="/guide">How Proven works</a>
          <p>
            Checkable work.
            <br />
            Payment with a record.
          </p>
        </div>
      </aside>
      <div className="app-area">
        <main className="shell main-content market" id="market-overview">
          <section className="workspace-intro" aria-labelledby="market-title">
            <div>
              <p className="eyebrow">Good work. Clear evidence.</p>
              <h1 id="market-title">Your work, with proof.</h1>
              <p className="market-lead">
                Browse checkable work, post a job, and follow its delivery
                through the recorded payment.
              </p>
            </div>
            <div className="market-account">
              <span className="market-network">Market · Testnet</span>
              {walletControls}
            </div>
          </section>
          {children}
          <section
            className="market-trust panel"
            id="market-trust"
            aria-labelledby="market-trust-title"
          >
            <p className="eyebrow">TRUST & LIMITS</p>
            <h2 id="market-trust-title">Clear conditions. Explicit trust.</h2>
            <p>
              Only the escrow’s private callback records a verdict. OutLayer’s
              contract, registered worker keys and approved measurements remain
              trusted; individual quotes are not verified on chain. The relay
              can read or withhold private texts and cannot set a verdict.
            </p>
            <p>
              The separate mainnet escrow is an unaudited, owner-funded
              deployment. This market’s browser workflow is currently configured
              for testnet. A buyer’s check can reject honest work; workers have
              no recourse yet.
            </p>
            <a href="/guide#trust">Read the full trust boundaries</a>
          </section>
        </main>
        <footer className="market-footer">
          Proven · Checkable work. Evidence behind payment.
        </footer>
      </div>
    </div>
  );
}
