// Read-only routes for the PR merge bounty page: the bounty contract's configuration and bounties,
// a maintainer's posting permission, a wallet's claim challenge, a vault's balance and deposit
// records, whether an account exists, the latest block time, and a withdrawal's classified
// outcome. Testnet only for the pilot; the contract is named by PROVEN_PR_BOUNTY_CONTRACT. Nothing
// here signs or sends a transaction, and with no contract configured nothing is read at all.
import { rpc, rpcAnswer } from "./read.ts";
import { ReadError } from "./model.ts";
import {
  classifyWithdrawal,
  decodeInfo,
  type ExpectedWithdrawal,
  decodeRecord,
  slotArgs,
  SETTLEMENT_KIND,
  type SettlementKindName,
} from "../ui/vault-client.ts";
import { base58 } from "../ui/bounty-keys.ts";

const ACCOUNT =
  /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
const DECIMAL = /^[0-9]{1,20}$/;
const VAULT = /^0s[0-9a-f]{40}$/;
const KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE = /^[0-9a-f]{64}$/;
const decoded = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
};
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

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

/** A view's raw bytes, or null when the account does not exist (a vault not created yet). */
async function rawView(
  account: string,
  method: string,
  args: Uint8Array,
  transport: typeof fetch,
): Promise<Uint8Array | null> {
  const answer = await rpcAnswer(
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(args).toString("base64"),
    },
    transport,
  );
  const error = answer.error as { cause?: { name?: string } } | undefined;
  if (error?.cause?.name === "UNKNOWN_ACCOUNT") return null;
  const result = answer.result as { result?: unknown } | undefined;
  if (
    error ||
    !result ||
    !Array.isArray(result.result) ||
    result.result.length > 1024 ||
    result.result.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new ReadError(
      "The vault could not be read. No transaction was sent.",
    );
  return Uint8Array.from(result.result as number[]);
}

const keyText = (bytes: Uint8Array) => {
  if (bytes[0] !== 0)
    throw new ReadError("The vault holds a key that is not ed25519.");
  return `ed25519:${base58(bytes.slice(1))}`;
};

async function vaultRoute(vault: string, transport: typeof fetch) {
  const bytes = await rawView(vault, "info", new Uint8Array(), transport);
  if (!bytes) return { vault, exists: false, info: null };
  let info;
  try {
    info = decodeInfo(bytes);
  } catch {
    throw new ReadError("The vault returned an unreadable view.");
  }
  return {
    vault,
    exists: true,
    info: {
      primary: keyText(info.primary),
      backup: keyText(info.backup),
      n: info.n.toString(),
      fund: info.fund.toString(),
      available: info.available.toString(),
    },
  };
}

async function slotRoute(
  contract: string,
  vault: string,
  bounty: number,
  kind: SettlementKindName,
  transport: typeof fetch,
) {
  const bytes = await rawView(
    vault,
    "slot",
    slotArgs(contract, bounty, kind),
    transport,
  );
  if (!bytes) return { vault, exists: false, record: null };
  let r;
  try {
    r = decodeRecord(bytes);
  } catch {
    throw new ReadError("The vault returned an unreadable record.");
  }
  return {
    vault,
    exists: true,
    record: {
      deposited: r.deposited,
      attempt: r.attempt,
      amount: r.amount.toString(),
      sealed_through: r.sealedThrough,
    },
  };
}

async function accountRoute(account: string, transport: typeof fetch) {
  const answer = await rpcAnswer(
    "query",
    { request_type: "view_account", finality: "final", account_id: account },
    transport,
  );
  const error = answer.error as { cause?: { name?: string } } | undefined;
  if (error?.cause?.name === "UNKNOWN_ACCOUNT")
    return { account, exists: false };
  if (error || !answer.result)
    throw new ReadError(
      "The account could not be read. No transaction was sent.",
    );
  return { account, exists: true };
}

async function blockRoute(transport: typeof fetch) {
  const block = await rpc("block", { finality: "final" }, transport);
  const header = block.header as { timestamp_nanosec?: string } | undefined;
  if (
    !header?.timestamp_nanosec ||
    !/^[0-9]{1,20}$/.test(header.timestamp_nanosec)
  )
    throw new ReadError("The latest block could not be read.");
  return {
    block_secs: Number(BigInt(header.timestamp_nanosec) / 1_000_000_000n),
  };
}

/**
 * The finalized outcome of one withdrawal, classified against the fields the page signed: the
 * vault, destination, amount and withdrawal number, and the account that submitted it.
 */
async function withdrawalRoute(
  hash: string,
  expected: ExpectedWithdrawal & { sender: string },
  transport: typeof fetch,
) {
  let outcome;
  try {
    const answer = await rpcAnswer(
      "EXPERIMENTAL_tx_status",
      {
        tx_hash: hash,
        sender_account_id: expected.sender,
        wait_until: "FINAL",
      },
      transport,
    );
    outcome = answer.error
      ? { kind: "pending", why: "not found yet" }
      : classifyWithdrawal(answer.result, expected);
  } catch {
    outcome = { kind: "pending", why: "unreadable" };
  }
  return {
    hash,
    vault: expected.vault,
    outcome: JSON.parse(
      JSON.stringify(outcome, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    ),
  };
}

/**
 * GET /api/market/bounties, …/poster/<account>,
 * …/challenge/<bounty>/<wallet>/<expires_at>/<primary>/<backup>, …/nonce/<maintainer>/<nonce>,
 * …/vault/<vault>, …/slot/<vault>/<bounty>/<kind>, …/account/<account>, …/block and
 * …/withdrawal/<tx_hash>/<sender>/<vault>/<to>/<amount>/<n>.
 */
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
  if (parts[0] === "challenge" && parts.length === 6) {
    const [
      ,
      bounty = "",
      wallet = "",
      expires = "",
      primary = "",
      backup = "",
    ] = parts.map(decoded);
    if (
      !DECIMAL.test(bounty) ||
      !ACCOUNT.test(wallet) ||
      !DECIMAL.test(expires) ||
      !KEY.test(primary) ||
      !KEY.test(backup)
    )
      throw new ReadError(
        "Name the bounty, the wallet, expires_at and both public keys.",
      );
    return {
      challenge: await view(
        contract,
        "claim_challenge",
        {
          bounty_id: Number(bounty),
          wallet,
          expires_at: expires,
          primary,
          backup,
        },
        transport,
      ),
    };
  }
  if (parts[0] === "nonce" && parts.length === 3) {
    const [, maintainer = "", nonce = ""] = parts;
    if (!ACCOUNT.test(maintainer) || !NONCE.test(nonce))
      throw new ReadError("Name the maintainer and a 64-hex-digit nonce.");
    return {
      used: await view(
        contract,
        "is_nonce_used",
        { maintainer, nonce },
        transport,
      ),
    };
  }
  if (parts[0] === "vault" && parts.length === 2) {
    const vault = parts[1] ?? "";
    if (!VAULT.test(vault)) throw new ReadError("Name a vault account.");
    return vaultRoute(vault, transport);
  }
  if (parts[0] === "slot" && parts.length === 4) {
    const [, vault = "", bounty = "", kind = ""] = parts;
    if (
      !VAULT.test(vault) ||
      !DECIMAL.test(bounty) ||
      !(kind in SETTLEMENT_KIND)
    )
      throw new ReadError(
        "Name the vault, the bounty and the settlement kind.",
      );
    return slotRoute(
      contract,
      vault,
      Number(bounty),
      kind as SettlementKindName,
      transport,
    );
  }
  if (parts[0] === "account" && parts.length === 2) {
    const account = parts[1] ?? "";
    if (!ACCOUNT.test(account)) throw new ReadError("Name a NEAR account.");
    return accountRoute(account, transport);
  }
  if (parts[0] === "block" && parts.length === 1) return blockRoute(transport);
  if (parts[0] === "withdrawal" && parts.length === 7) {
    const [, hash = "", sender = "", vault = "", to = "", amount = "", n = ""] =
      parts;
    if (
      !TX_HASH.test(hash) ||
      !ACCOUNT.test(sender) ||
      !VAULT.test(vault) ||
      !ACCOUNT.test(to) ||
      !/^[0-9]{1,40}$/.test(amount) ||
      !DECIMAL.test(n)
    )
      throw new ReadError(
        "Name the transaction, its sender, the vault, the destination, the amount and the number.",
      );
    return withdrawalRoute(
      hash,
      { sender, vault, to, amount: BigInt(amount), n: BigInt(n) },
      transport,
    );
  }
  throw new ReadError("Route not found.", 404);
}
