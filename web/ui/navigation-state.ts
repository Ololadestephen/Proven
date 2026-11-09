export type WorkspaceSection =
  | "workspace"
  | "market"
  | "jobs"
  | "guide"
  | "post"
  | "agents"
  | "bounties"
  | "about"
  | "lookup"
  | "demo"
  | "trust";
export interface NavigationItem {
  id: WorkspaceSection;
  label: string;
  href?: string;
  icon?: WorkspaceSection;
}
export const APP_NAVIGATION: ReadonlyArray<NavigationItem> = [
  { id: "workspace", label: "Overview", href: "/app" },
  { id: "market", label: "Market", href: "/app/market" },
  { id: "jobs", label: "My jobs", href: "/app/jobs", icon: "lookup" },
  { id: "agents", label: "Agents", href: "/app/agents" },
  { id: "bounties", label: "PR bounties", href: "/app/bounties" },
];
export const SUPPORT_NAVIGATION: ReadonlyArray<NavigationItem> = [
  { id: "guide", label: "Guide", href: "/guide", icon: "lookup" },
  { id: "demo", label: "Examples & demo", href: "/examples" },
  { id: "trust", label: "Trust & limits", href: "/trust" },
  { id: "about", label: "About this service", href: "/about", icon: "trust" },
];
export const MARKET_NAVIGATION = APP_NAVIGATION;
export const EVIDENCE_NAVIGATION: ReadonlyArray<NavigationItem> = [
  ...APP_NAVIGATION,
  { id: "lookup", label: "Job evidence", href: "#lookup" },
  ...SUPPORT_NAVIGATION,
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
