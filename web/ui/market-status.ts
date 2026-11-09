import {
  marketDescription,
  marketStatusLines,
  parseMarketSettings,
  type MarketSettings,
} from "./network-status.ts";

/** Presentation only: textContent cannot turn chain data into executable page content. A label marked
 * `data-market-summary="lines"` gets the sidebar's short lines; any other gets the one-line summary. */
export async function showMarketStatus(
  root: Pick<Document, "querySelectorAll">,
  read: typeof fetch = fetch,
): Promise<void> {
  const labels = Array.from(
    root.querySelectorAll<HTMLElement>("[data-market-summary]"),
  );
  if (!labels.length) return;
  let settings: MarketSettings | null = null;
  try {
    const reply = await read("/api/market/config", {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    settings = reply.ok ? parseMarketSettings(await reply.json()) : null;
  } catch {
    settings = null;
  }
  const description = marketDescription(settings);
  const lines = marketStatusLines(settings);
  for (const label of labels) {
    if (label.dataset?.marketSummary !== "lines") {
      label.textContent = description;
      continue;
    }
    label.replaceChildren(
      ...lines.map((line) => {
        const span = label.ownerDocument.createElement("span");
        span.textContent = line;
        return span;
      }),
    );
  }
}

if (typeof document !== "undefined") void showMarketStatus(document);
