import { NETWORK_LABEL } from "./network.ts";
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
}: {
  walletControls: ReactNode;
  children: ReactNode;
  title: string;
  subtitle?: string;
  active: WorkspaceSection;
}) {
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
      </aside>
      <div className="app-area">
        <main className="shell main-content market" id="workspace-content">
          <div className="workspace-toolbar">
            <span className="workspace-network">{NETWORK_LABEL}</span>
            <div className="workspace-toolbar-actions">
              <div className="workspace-wallet">{walletControls}</div>
              {active !== "post" && (
                <a className="button button-primary" href="/app/post">
                  Post a job
                </a>
              )}
            </div>
          </div>
          <header className="workspace-heading">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </header>
          <div className="workspace-content">{children}</div>
        </main>
        <footer className="workspace-footer">
          Proven · {NETWORK_LABEL} · <a href="/about">About this service</a>
        </footer>
      </div>
    </div>
  );
}
