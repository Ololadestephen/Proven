export type WorkspaceSection = "workspace" | "lookup" | "demo" | "trust";
/** Fragments select visible sections only; they never invoke demo actions. */
export function sectionFromHash(hash: string): WorkspaceSection {
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
