import { marketDescription, parseMarketSettings } from "./network-status.ts";

/** Presentation only: textContent cannot turn chain data into executable page content. */
export async function showMarketStatus(
  root: Pick<Document, "querySelectorAll">,
  read: typeof fetch = fetch,
): Promise<void> {
  const labels = root.querySelectorAll<HTMLElement>("[data-market-summary]");
  if (!labels.length) return;
  let description: string;
  try {
    const reply = await read("/api/market/config", {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    description = marketDescription(
      reply.ok ? parseMarketSettings(await reply.json()) : null,
    );
  } catch {
    description = marketDescription(null);
  }
  for (const label of labels) label.textContent = description;
}

if (typeof document !== "undefined") void showMarketStatus(document);
