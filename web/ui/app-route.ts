import type { WorkspaceSection } from "./navigation-state.ts";
import type { MarketBid } from "./market-steps.ts";
export interface AppRoute {
  section: WorkspaceSection;
  bidId?: number;
  title: string;
  subtitle: string;
}
export function appRoute(path: string, hash = ""): AppRoute {
  if (hash === "#post-job" || path === "/app/post")
    return {
      section: "post",
      title: "Post a job",
      subtitle: "",
    };
  if (path === "/app/market")
    return {
      section: "market",
      title: "Find your next job.",
      subtitle: "",
    };
  if (path === "/app/agents")
    return {
      section: "agents",
      title: "Agents",
      subtitle: "",
    };
  if (path === "/app/jobs")
    return {
      section: "jobs",
      title: "My jobs",
      subtitle: "",
    };
  const bid = /^\/app\/bids\/([0-9]{1,10})$/.exec(path);
  if (bid)
    return {
      section: "jobs",
      bidId: Number(bid[1]),
      title: "Job",
      subtitle: "",
    };
  return {
    section: "workspace",
    title: "Overview",
    subtitle: "",
  };
}
/** Ended on the board, or its escrow job has ended and the board has not been synced yet. A Released
 * or Refunded job never runs again, so its bid is not open work. */
export const completed = (bid: MarketBid) =>
  ["Done", "Closed", "Cancelled", "Blocked"].includes(bid.state) ||
  ["Released", "Refunded"].includes(bid.job?.state ?? "");
export function ownBids(
  bids: MarketBid[],
  account: string | null,
  role: "buying" | "delivering",
) {
  if (!account) return [];
  return bids.filter((bid) =>
    role === "buying"
      ? bid.buyer === account
      : bid.claim?.agent === account ||
        bid.job?.worker === account ||
        (bid.job?.history ?? []).some((attempt) => attempt.worker === account),
  );
}
/** The description's first line, as a title. A line that only introduces what follows ("…in this
 * format:") loses its colon. */
export function bidTitle(bid: MarketBid) {
  const line = bid.description
    .split("\n")
    .find((text) => text.trim())
    ?.trim()
    .replace(/\s*[:;,]+$/, "");
  if (!line) return `Bid ${bid.id}`;
  return line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line;
}
