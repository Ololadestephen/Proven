import { NETWORK_LINES } from "./network.ts";
import type { ReactNode } from "react";
import { WorkspaceNavigation } from "./WorkspaceNavigation.tsx";
import {
  APP_NAVIGATION,
  SUPPORT_NAVIGATION,
  type WorkspaceSection,
} from "./navigation-state.ts";

export function MarketLayout({
  walletControls,
  children,
  title,
  subtitle,
  active,
  canPostJob,
}: {
  walletControls: ReactNode;
  children: ReactNode;
  title: string;
  subtitle?: string;
  active: WorkspaceSection;
  /** The board would accept a post from this visitor: the market is open, or they are a listed buyer. */
  canPostJob: boolean;
}) {
  const showPost = active !== "post" && canPostJob;
  return (
    <div className="app-frame workspace-app">
      <a className="skip-link" href="#workspace-content">
        Skip to workspace
      </a>
      <aside className="app-sidebar" aria-label="Workspace navigation">
        <a className="wordmark" href="/" aria-label="Proven home">
          <span className="brand-mark" aria-hidden="true">
            p.
          </span>
          Proven
        </a>
        <WorkspaceNavigation
          items={APP_NAVIGATION}
          defaultSection={active}
          activeSection={active}
          secondaryItems={SUPPORT_NAVIGATION}
        />
        <div className="sidebar-account">
          <p className="sidebar-status">
            {NETWORK_LINES.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
          {walletControls}
        </div>
      </aside>
      <div className="app-area">
        <main className="shell main-content market" id="workspace-content">
          {title || showPost ? (
            <header className="workspace-heading">
              <div className="workspace-heading-row">
                {title ? <h1>{title}</h1> : <span />}
                {showPost ? (
                  <a className="button button-primary" href="/app/post">
                    Post a job
                  </a>
                ) : null}
              </div>
              {subtitle && <p>{subtitle}</p>}
            </header>
          ) : null}
          <div className="workspace-content">{children}</div>
        </main>
      </div>
    </div>
  );
}
