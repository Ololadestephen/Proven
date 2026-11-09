import {
  marketDescription,
  marketStatusLines,
  parseMarketSettings,
  type MarketSettings,
} from "./network-status.ts";

/** Presentation only: textContent cannot turn chain data into executable page content. A label marked
 * `data-market-summary="lines"` gets the full status as short lines, `"network"` gets only the
 * network's name, and any other gets the one-line summary. */
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
    const mode = label.dataset?.marketSummary;
    if (mode !== "lines" && mode !== "network") {
      label.textContent = description;
      continue;
    }
    const shown = mode === "network" ? lines.slice(0, 1) : lines;
    label.replaceChildren(
      ...shown.map((line) => {
        const span = label.ownerDocument.createElement("span");
        span.textContent = line;
        return span;
      }),
    );
  }
}

/** Static pages' three-dots menu closes on a click outside it, or Escape. */
function closeMenusOutside(document: Document) {
  const close = (event: Event) => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>(
      "details.sidebar-more[open]",
    )) {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") continue;
        menu.open = false;
        menu.querySelector("summary")?.focus();
      } else if (!menu.contains(event.target as Node)) menu.open = false;
    }
  };
  document.addEventListener("pointerdown", close);
  document.addEventListener("keydown", close);
}

if (typeof document !== "undefined") {
  void showMarketStatus(document);
  closeMenusOutside(document);
}
