import { useEffect, useRef } from "react";
import {
  SUPPORT_NAVIGATION,
  type WorkspaceSection,
} from "./navigation-state.ts";

/** The three-dots menu at the foot of the sidebar, for the help pages. */
export function SidebarMore({ active }: { active?: WorkspaceSection }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const details = menu.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        details.open = false;
        details.querySelector("summary")?.focus();
        return;
      }
      if (!details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details className="sidebar-more" ref={menu}>
      <summary
        className="button button-secondary"
        aria-label="More: guide, examples, trust and limits"
        title="More"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </summary>
      <div className="sidebar-more-menu">
        <nav aria-label="Help and information">
          {SUPPORT_NAVIGATION.map((item) => (
            <a
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </details>
  );
}
