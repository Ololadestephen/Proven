// Read-only routes for the PR merge bounty page: the bounty contract's configuration and bounties,
// a maintainer's posting permission, and a wallet's claim challenge. Testnet only for the pilot;
// the contract is named by PROVEN_PR_BOUNTY_CONTRACT. Nothing here signs or sends a transaction.
import { rpc } from "./read.ts";
import { ReadError } from "./model.ts";

const ACCOUNT =
  /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
const DECIMAL = /^[0-9]{1,20}$/;

export function bountyContract(
  setting = process.env.PROVEN_PR_BOUNTY_CONTRACT,
  network = process.env.NEAR_NETWORK ?? "testnet",
): string | null {
  if (network !== "testnet" || !setting) return null;
  if (!ACCOUNT.test(setting))
    throw new ReadError("PROVEN_PR_BOUNTY_CONTRACT is not a NEAR account id.");
  return setting;
}

async function view(
  contract: string,
  method: string,
  args: Record<string, unknown>,
  transport: typeof fetch,
): Promise<unknown> {
  const data = await rpc(
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    transport,
  );
  if (
    !Array.isArray(data.result) ||
    data.result.length > 256 * 1024 ||
    data.result.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new ReadError("The bounty contract returned an unreadable view.");
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(data.result as number[]),
      ),
    );
  } catch {
    throw new ReadError("The bounty contract returned invalid JSON.");
  }
}

/** GET /api/market/bounties, …/poster/<account>, …/challenge/<bounty>/<wallet>/<expires_at>. */
export async function bountiesRoute(
  path: string,
  transport: typeof fetch = fetch,
  contract = bountyContract(),
): Promise<unknown> {
  if (!contract) return { configured: false };
  if (path === "/api/market/bounties") {
    const [config, bounties] = await Promise.all([
      view(contract, "get_config", {}, transport),
      view(contract, "get_bounties", { from_id: 0, limit: 50 }, transport),
    ]);
    return { configured: true, contract, config, bounties };
  }
  const parts = path.slice("/api/market/bounties/".length).split("/");
  if (parts[0] === "poster" && parts.length === 2) {
    const account = parts[1] ?? "";
    if (!ACCOUNT.test(account)) throw new ReadError("Name a NEAR account.");
    return {
      account,
      poster: await view(contract, "is_poster", { account }, transport),
    };
  }
  if (parts[0] === "challenge" && parts.length === 4) {
    const [, bounty = "", wallet = "", expires = ""] = parts;
    if (
      !DECIMAL.test(bounty) ||
      !ACCOUNT.test(wallet) ||
      !DECIMAL.test(expires)
    )
      throw new ReadError("Name the bounty, the wallet and expires_at.");
    return {
      challenge: await view(
        contract,
        "claim_challenge",
        { bounty_id: Number(bounty), wallet, expires_at: expires },
        transport,
      ),
    };
  }
  throw new ReadError("Route not found.", 404);
}
