// Hosted startup is explicit and does not read private files. Validation precedes keys and clients.
import type { Config } from "../config.ts";
import { PublicError } from "../errors.ts";
import { networkSettings } from "../network.ts";
import { accountId, yocto } from "../validation.ts";
import { isAbsolute } from "node:path";

type Environment = Record<string, string | undefined>;

export interface HostedSettings {
  network: "mainnet" | "testnet";
  config: Config;
  board: string;
  treasury: string;
  earningsCapYocto: string;
  enrollmentOwners?: ReadonlySet<string>;
  dataDirectory?: string;
  port: number;
}

function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value) throw new PublicError(`${name} must be set explicitly.`);
  return value;
}

export function hostedSettings(
  env: Environment,
  importedBoard: string,
): HostedSettings {
  // This check must run before even accessing a credential property of env.
  const net = networkSettings(env.NEAR_NETWORK, env.PROVEN_STAGE2_APPROVED);
  const mainnet = net.network === "mainnet";
  const enrollment = mainnet
    ? required(env, "PROVEN_HOSTED_ENROLLMENT_OWNERS")
    : env.PROVEN_HOSTED_ENROLLMENT_OWNERS;
  const enrollmentOwners = enrollment
    ? new Set(enrollment.split(",").map((owner) => accountId(owner.trim())))
    : undefined;
  const dataDirectory = mainnet
    ? required(env, "PROVEN_HOSTED_DATA")
    : env.PROVEN_HOSTED_DATA;
  if (dataDirectory && !isAbsolute(dataDirectory))
    throw new PublicError(
      "PROVEN_HOSTED_DATA must be an absolute private directory.",
    );
  const escrow = accountId(
    mainnet
      ? required(env, "MAINNET_ESCROW_ACCOUNT_ID")
      : (env.ESCROW_CONTRACT ?? "escrow-v5.proven.testnet"),
  );
  const board = accountId(
    mainnet
      ? required(env, "PROVEN_BOARD")
      : (env.PROVEN_BOARD ?? "board-v4.proven.testnet"),
  );
  const treasury = accountId(required(env, "HOSTED_TREASURY_ACCOUNT_ID"));
  if (
    !escrow.endsWith(net.suffix) ||
    !board.endsWith(net.suffix) ||
    !treasury.endsWith(net.suffix) ||
    board !== importedBoard
  )
    throw new PublicError(
      "Hosted contracts and treasury must use the selected network and board.",
    );
  if (
    mainnet &&
    (escrow !== "proven-escrow.near" ||
      board !== "proven-board.near" ||
      treasury !== "proven-treasury.near")
  )
    throw new PublicError(
      "Use the approved Proven mainnet contracts and dedicated treasury.",
    );
  const rpc = mainnet
    ? required(env, "MAINNET_RPC_URL")
    : (env.NEAR_RPC_URL ?? net.rpcs[0]);
  const custodyApi = mainnet
    ? required(env, "PROVEN_CUSTODY_API")
    : (env.PROVEN_CUSTODY_API ?? net.custodyApi);
  if (
    !(net.rpcs as readonly string[]).includes(rpc) ||
    custodyApi !== net.custodyApi
  )
    throw new PublicError(
      "Use the selected network's approved RPC and custody endpoints.",
    );
  if (env.SANDBOX_URL || env.SANDBOX_TOKEN)
    throw new PublicError(
      "Hosted agents use fixed safe skills only; sandbox settings must be absent.",
    );
  const earningsCapYocto = yocto(
    mainnet
      ? required(env, "HOSTED_EARNINGS_CAP_NEAR")
      : (env.HOSTED_EARNINGS_CAP_NEAR ?? "0.5"),
  );
  if (BigInt(earningsCapYocto) > 5n * 10n ** 24n)
    throw new PublicError("HOSTED_EARNINGS_CAP_NEAR must not exceed 5 NEAR.");
  const relayUrl = env.PROVEN_RELAY_URL;
  if (mainnet && !relayUrl && !env.PROVEN_RELAY_SOCKET)
    throw new PublicError(
      "Set PROVEN_RELAY_URL or PROVEN_RELAY_SOCKET explicitly for mainnet.",
    );
  if (relayUrl) {
    let url: URL;
    try {
      url = new URL(relayUrl);
    } catch {
      throw new PublicError("Invalid hosted relay URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new PublicError(
        "The hosted relay must use HTTPS without credentials or query parameters.",
      );
  }
  const portText = mainnet
    ? required(env, "PROVEN_HOSTED_PORT")
    : (env.PROVEN_HOSTED_PORT ?? "4175");
  const port = Number(portText);
  if (!/^\d{4,5}$/.test(portText) || port < 1024 || port > 65535)
    throw new PublicError(
      "PROVEN_HOSTED_PORT must be a loopback port from 1024 to 65535.",
    );
  return {
    network: net.network,
    port,
    board,
    treasury,
    earningsCapYocto,
    enrollmentOwners,
    dataDirectory,
    config: {
      actor: "agent",
      escrow,
      rpc,
      custodyApi,
      socket: env.PROVEN_RELAY_SOCKET ?? "runs/private/relay.sock",
      relayUrl,
    },
  };
}

/** A description of all write categories; generating it never loads a signer or calls a service. */
export function hostedWritePlan(settings: HostedSettings) {
  const { config, board, treasury } = settings;
  return {
    dry_run: true,
    network: settings.network,
    disclosure:
      settings.network === "mainnet"
        ? "the owner holds a single key that can upgrade the contracts"
        : "testnet preparation only",
    escrow: config.escrow,
    board,
    treasury,
    listen: `127.0.0.1:${settings.port}`,
    rpc: config.rpc,
    custody_api: config.custodyApi,
    earnings_cap_yocto: settings.earningsCapYocto,
    data_directory:
      settings.dataDirectory ?? "default private testnet directory",
    writes: [
      {
        action:
          "register custody wallet and encrypt/sign its restricted policy",
        receiver: config.custodyApi,
        deposit: "none; external registration",
      },
      {
        action: "store_wallet_policy",
        receiver:
          settings.network === "mainnet" ? "outlayer.near" : "outlayer.testnet",
        maximum_deposit_yocto: "50000000000000000000000",
      },
      {
        action: "register_agent",
        receiver: board,
        deposit_yocto: "20000000000000000000000",
      },
      {
        action: "claim_bid",
        receiver: board,
        deposit_yocto: "5000000000000000000000",
      },
      {
        action: "deliver and request_verification",
        receiver: config.escrow,
        deposit_yocto: "0",
        note: "verification uses the job's prepaid budget",
      },
      { action: "sync", receiver: board, deposit_yocto: "0" },
      {
        action: "release or refund",
        receiver: config.escrow,
        deposit_yocto: "0",
        note: "contract-recorded outcome only; the runner cannot set a verdict",
      },
      {
        action: "private relay handoff and collection",
        receiver: config.relayUrl ?? "local private relay socket",
        note: "authenticated messages; no buyer transaction",
      },
      {
        action: "NEAR AI inference",
        receiver: "https://cloud-api.near.ai/v1",
        note: "operator USD credits, bounded by the inference ledger",
      },
      {
        action: "settle inference charges or owner withdrawal",
        receiver: `${treasury} or the authenticated agent owner`,
        maximum_transfer_yocto: "100000000000000000000000",
        note: "only if the stored restricted hosted policy permits it",
      },
      {
        action: "private local agent, delivery and inference records",
        receiver: "operator-only data directory",
        note: "no credentials are printed by this plan",
      },
      {
        action: "optional operator-configured health notifications",
        receiver: "Telegram Bot API when configured",
        note: "disabled without operator-provided notification settings",
      },
    ],
    starts_runner: false,
    starts_http_server: false,
  };
}
