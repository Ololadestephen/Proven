export interface NearCaps {
  max_job: string;
  max_held: string;
  max_held_per_buyer: string;
}
export interface MarketSettings {
  network: "mainnet" | "testnet";
  open: boolean;
  buyers?: string[];
  caps: NearCaps | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unknown or malformed settings never open posting or invent contract limits. */
export function parseMarketSettings(value: unknown): MarketSettings | null {
  if (
    !record(value) ||
    !["mainnet", "testnet"].includes(String(value.network)) ||
    typeof value.open !== "boolean"
  )
    return null;
  if (
    !value.open &&
    (!Array.isArray(value.buyers) ||
      !value.buyers.every(
        (buyer) => typeof buyer === "string" && buyer.length > 0,
      ))
  )
    return null;
  let caps: NearCaps | null = null;
  if (value.caps !== undefined && value.caps !== null) {
    const supplied = value.caps;
    if (!record(supplied)) return null;
    const names = ["max_job", "max_held", "max_held_per_buyer"] as const;
    if (
      !names.every(
        (name) =>
          typeof supplied[name] === "string" &&
          /^\d{1,39}$/.test(supplied[name] as string),
      )
    )
      return null;
    caps = {
      max_job: supplied.max_job as string,
      max_held: supplied.max_held as string,
      max_held_per_buyer: supplied.max_held_per_buyer as string,
    };
  }
  return {
    network: value.network as MarketSettings["network"],
    open: value.open,
    ...(value.open ? {} : { buyers: value.buyers as string[] }),
    caps,
  };
}

function near(yocto: string): string {
  const value = BigInt(yocto);
  const fraction = (value % 10n ** 24n)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${value / 10n ** 24n}${fraction ? `.${fraction}` : ""}`;
}

export function networkDescription(network: "mainnet" | "testnet"): string {
  return network === "mainnet"
    ? "Mainnet. The owner holds a single key that can upgrade the contracts"
    : "Testnet preparation only";
}

/** Only published chain settings supply the access and numeric caps in this label. */
export function marketDescription(settings: MarketSettings | null): string {
  if (!settings)
    return "Market access and limits are unavailable. Posting is disabled until the board can be read.";
  const access = settings.open ? "open to buyers" : "closed to listed buyers";
  const caps = settings.caps;
  const limits = caps
    ? `at most ${near(caps.max_job)} NEAR per job, ${near(caps.max_held_per_buyer)} NEAR per buyer and ${near(caps.max_held)} NEAR held in total`
    : "limits unavailable until read from the escrow";
  return `${networkDescription(settings.network)} · ${access} · ${limits}`;
}

/** The same facts as marketDescription, as short lines for the sidebar. Mainnet always names its
 * risk in full, so a narrow column never shortens the disclosure. */
export function marketStatusLines(settings: MarketSettings | null): string[] {
  if (!settings)
    return [
      "Market status unavailable",
      "Posting is disabled until the board can be read.",
    ];
  const lines =
    settings.network === "mainnet"
      ? [
          "Mainnet",
          "The owner holds a single key that can upgrade the contracts.",
        ]
      : ["Testnet", "Preparation only."];
  lines.push(settings.open ? "Open to buyers" : "Closed to listed buyers");
  const caps = settings.caps;
  lines.push(
    caps
      ? `${near(caps.max_job)} NEAR per job · ${near(caps.max_held_per_buyer)} per buyer · ${near(caps.max_held)} held in total`
      : "Limits unavailable until read from the escrow",
  );
  return lines;
}

export function startupMessage(
  port: number,
  network: "mainnet" | "testnet",
): string {
  return `Proven market: http://127.0.0.1:${port} · ${networkDescription(network)}. Access and limits are read from the board and escrow at /api/market/config.`;
}
