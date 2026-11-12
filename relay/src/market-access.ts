import { ContractMethodNotFoundError } from "near-api-js/rpc-errors";

/** The board is the authority for which buyers may start work. Only old boards lack this view. */
export interface BoardAccess {
  open: boolean;
  buyers: string[];
}
export interface ResolvedAccess extends BoardAccess {
  source: "board" | "legacy-env";
}
export class MarketAccessError extends Error {}

export function legacyAccess(
  setting: string | undefined,
  network: string | undefined,
): BoardAccess {
  return {
    open:
      setting === "open" || (setting === undefined && network !== "mainnet"),
    buyers:
      setting === "open"
        ? []
        : (setting ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
  };
}

/** An older contract without this view, as the relay's own RPC client reports it. */
export function missingView(error: unknown): boolean {
  return error instanceof ContractMethodNotFoundError;
}

function parseAccess(value: unknown): BoardAccess {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MarketAccessError(
      "The board returned an invalid buyer list. No new work was started.",
    );
  const access = value as Partial<BoardAccess>;
  if (
    typeof access.open !== "boolean" ||
    !Array.isArray(access.buyers) ||
    !access.buyers.every(
      (name) =>
        typeof name === "string" &&
        name.length >= 2 &&
        name.length <= 64 &&
        /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(name),
    )
  )
    throw new MarketAccessError(
      "The board returned an invalid buyer list. No new work was started.",
    );
  return { open: access.open, buyers: [...new Set(access.buyers)] };
}

export async function readBoardAccess(
  read: () => Promise<unknown>,
  fallback: () => BoardAccess,
): Promise<ResolvedAccess> {
  let value: unknown;
  try {
    value = await read();
  } catch (error) {
    if (missingView(error))
      return { ...parseAccess(fallback()), source: "legacy-env" };
    throw new MarketAccessError(
      "The board's buyer list could not be read. No new work was started.",
    );
  }
  return { ...parseAccess(value), source: "board" };
}
export function buyerAllowed(access: BoardAccess, buyer: string): boolean {
  return access.open || access.buyers.includes(buyer);
}

/** Missing configuration is never evidence of an older contract. */
export function configuredBoard(board: string | undefined): string {
  if (!board?.trim())
    throw new MarketAccessError(
      "The market board account is not configured. No new work was started.",
    );
  return board;
}
