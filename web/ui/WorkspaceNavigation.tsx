import { useRef, useState, type KeyboardEvent } from "react";
import { AnimatedList } from "./react-bits/AnimatedList.tsx";
import "./WorkspaceNavigation.css";
import {
  EVIDENCE_NAVIGATION,
  type NavigationItem,
  type WorkspaceSection,
} from "./navigation-state.ts";

/** A mobile disclosure, with the same always-visible desktop navigation. */
export function WorkspaceNavigation({
  items = EVIDENCE_NAVIGATION,
  defaultSection = "lookup",
  activeSection,
}: {
  items?: ReadonlyArray<NavigationItem>;
  defaultSection?: WorkspaceSection;
  activeSection?: WorkspaceSection;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    if (window.matchMedia("(max-width: 760px)").matches)
      toggle.current?.focus({ preventScroll: true });
  }
  function escape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    close();
  }
  return (
    <div
      className="workspace-navigation-panel"
      data-open={open}
      onKeyDown={escape}
    >
      <button
        ref={toggle}
        type="button"
        className="workspace-menu-toggle"
        aria-expanded={open}
        aria-controls="workspace-menu-content"
        onClick={() => setOpen(!open)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          {open ? (
            <path d="m6 6 12 12M6 18 18 6" />
          ) : (
            <path d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
        <span>{open ? "Close menu" : "Menu"}</span>
      </button>
      <div id="workspace-menu-content" className="workspace-menu-content">
        <AnimatedList
          onNavigate={close}
          items={items}
          defaultSection={defaultSection}
          activeSection={activeSection}
        />
      </div>
    </div>
  );
}
