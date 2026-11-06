export type WorkspaceSection =
  "workspace" | "market" | "post" | "lookup" | "demo" | "trust";
export interface NavigationItem {
  id: WorkspaceSection;
  label: string;
  href?: string;
  icon?: WorkspaceSection;
}
/** The market is the app at /app. Finished work and the demo are one page further, at /evidence.
 * Both pages show the same list in the same order, so the sidebar never moves under the reader. */
export const MARKET_NAVIGATION: ReadonlyArray<NavigationItem> = [
  { id: "market", label: "Market", href: "#market-overview", icon: "market" },
  { id: "post", label: "Post a job", href: "#post-job", icon: "post" },
  { id: "lookup", label: "Job evidence", href: "/evidence#lookup" },
  { id: "demo", label: "Live demo", href: "/evidence#demo" },
  { id: "trust", label: "Trust & limits", href: "#market-trust" },
];
export const EVIDENCE_NAVIGATION: ReadonlyArray<NavigationItem> = [
  { id: "market", label: "Market", href: "/app", icon: "market" },
  { id: "post", label: "Post a job", href: "/app#post-job", icon: "post" },
  { id: "lookup", label: "Job evidence", href: "#lookup" },
  { id: "demo", label: "Live demo", href: "#demo" },
  { id: "trust", label: "Trust & limits", href: "#trust" },
];
/** Fragments select visible sections only; they never invoke demo actions. */
export function sectionFromHash(
  hash: string,
  items?: ReadonlyArray<NavigationItem>,
  defaultSection: WorkspaceSection = "workspace",
): WorkspaceSection {
  if (items) {
    const selected = items.find((item) => item.href === hash);
    if (selected) return selected.id;
    if (
      /^#job-[0-9]{1,16}$/.test(hash) &&
      items.some((item) => item.href === "#lookup")
    )
      return "lookup";
    return defaultSection;
  }
  if (/^#job-[0-9]{1,16}$/.test(hash)) return "lookup";
  const value = hash.slice(1);
  return value === "lookup" || value === "demo" || value === "trust"
    ? value
    : "workspace";
}

/** Navigation focus wraps within the list; Tab retains native browser behavior. */
export function navigationIndex(
  key: string,
  index: number,
  count: number,
): number | null {
  if (index < 0 || count < 1) return null;
  switch (key) {
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowUp":
      return (index + count - 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
