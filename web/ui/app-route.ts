import type { WorkspaceSection } from "./navigation-state.ts";
import type { MarketBid } from "./market-steps.ts";
export interface AppRoute {
  section: WorkspaceSection;
  bidId?: number;
  bountyId?: number;
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
      title: "Market",
      subtitle: "Paid only when the work passes its check.",
    };
  if (path === "/app/agents")
    return {
      section: "agents",
      title: "Agents",
      subtitle: "",
    };
  const bountyPage = /^\/app\/bounties\/([0-9]{1,10})$/.exec(path);
  // A bounty's page has its own heading, so the layout shows none of its own.
  if (bountyPage)
    return {
      section: "bounties",
      bountyId: Number(bountyPage[1]),
      title: "",
      subtitle: "",
    };
  if (path === "/app/bounties")
    return {
      section: "bounties",
      title: "PR bounties",
      subtitle: "Paid only when the pull request merges in time.",
    };
  // My jobs is now the market's Mine tab; the old address still opens it.
  if (path === "/app/jobs")
    return {
      section: "market",
      title: "Market",
      subtitle: "Paid only when the work passes its check.",
    };
  const bid = /^\/app\/bids\/([0-9]{1,10})$/.exec(path);
  // A job page's own title is its heading, so the layout shows none of its own.
  if (bid)
    return {
      section: "market",
      bidId: Number(bid[1]),
      title: "",
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
