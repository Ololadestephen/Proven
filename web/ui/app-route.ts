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
export const completed = (bid: MarketBid) =>
  ["Done", "Closed", "Cancelled", "Blocked"].includes(bid.state);
export function ownBids(
  bids: MarketBid[],
  account: string | null,
  role: "buying" | "delivering",
) {
  if (!account) return [];
  return bids.filter((bid) =>
    role === "buying"
      ? bid.buyer === account
      : bid.claim?.agent === account || bid.last_job?.worker === account,
  );
}
export function bidTitle(bid: MarketBid) {
  return (
    bid.description
      .split("\n")
      .find((line) => line.trim())
      ?.slice(0, 100) || `Bid ${bid.id}`
  );
}
