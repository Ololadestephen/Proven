#!/usr/bin/env node
// The hosted agents service: a small local API and the runner loop. It listens on this machine only; the
// web server forwards to it. It holds hosted agents' custody keys, the treasury key and a NEAR AI key, and
// no relay key, buyer key or escrow owner key.
import { chainProvider } from "../rpc.ts";
import { createServer } from "node:http";
import { AccountDoesNotExistError } from "near-api-js/rpc-errors";
import { isAbsentAccount, keyOnAccount } from "../../../relay/src/rpc.ts";
import { RelayVerifier } from "../../../relay/src/buyer-auth.ts";
import { BoardClient } from "../board.ts";
import { ROOT } from "../config.ts";
import { BOARD } from "../custody.ts";
import { PublicError, publicMessage } from "../errors.ts";
import { fetchPrices, Ledger, ModelClient } from "../inference.ts";
import { KeyPool, keysFrom } from "../key-pool.ts";
import { healthReport, nearPrice, telegramNotifier } from "./health.ts";
import {
  addAgent,
  agentStatus,
  canEnroll,
  terms,
  withdraw,
  type ApiDeps,
} from "./api.ts";
import {
  AGENT_LIMIT_NANO_USD,
  JOB_LIMIT_NANO_USD,
  PROJECT_LIMIT_NANO_USD,
} from "./limits.ts";
import { chainEndpoints, chainReader } from "./chain-read.ts";
import { functionSkillsInstalled } from "./function-skill.ts";
import { runnerPass, type RunnerDeps } from "./runner.ts";
import { hostedSettings, hostedWritePlan } from "./network.ts";
import { acquireHostedLock, bindHostedData } from "./service-lock.ts";
import { HostedStore, publicView } from "./store.ts";
import { confirmedTransfer } from "./transfer-proof.ts";
import { sendFromWallet, treasuryAccount } from "./wallets.ts";

const PASS_EVERY_MS = 20_000;
const MAX_BODY = 128 * 1024;

/** Only a confirmed absent account is unfunded. An RPC outage must stop admission and spending. */
export async function hostedBalance(
  read: () => Promise<{ amount: bigint | string }>,
): Promise<bigint> {
  try {
    const view = await read();
    return BigInt(view.amount);
  } catch (error) {
    if (error instanceof AccountDoesNotExistError || isAbsentAccount(error))
      return 0n;
    throw new PublicError(
      "The agent balance is unavailable. No work can start from this read.",
    );
  }
}

export async function buildDeps(
  root = process.env.PROVEN_HOSTED_DATA ?? `${ROOT}runs/private/hosted`,
  env: Record<string, string | undefined> = process.env,
) {
  const settings = hostedSettings(env, BOARD);
  if (settings.dataDirectory && settings.dataDirectory !== root)
    throw new PublicError(
      "The hosted data path must match PROVEN_HOSTED_DATA.",
    );
  bindHostedData(root, settings);
  const config = settings.config;
  const treasuryId = settings.treasury;
  const treasuryKey = env.HOSTED_TREASURY_PRIVATE_KEY;
  if (!treasuryId || !treasuryKey)
    throw new Error("The treasury account is not set.");
  const keys = keysFrom(env, ["NEARAI_KEY_HOSTED"]);
  if (keys.length === 0) throw new Error("NEARAI_KEY_HOSTED is not set.");
  const ledger = new Ledger(`${root}/inference-ledger.jsonl`);
  const client = new KeyPool(
    new ModelClient(ledger, await fetchPrices()),
    ledger,
    keys,
    {
      agentNanoUsd: AGENT_LIMIT_NANO_USD,
      projectNanoUsd: PROJECT_LIMIT_NANO_USD,
      jobNanoUsd: JOB_LIMIT_NANO_USD,
    },
    `${root}/key-events.jsonl`,
  );
  const provider = chainProvider(config.rpc);
  const store = new HostedStore(root);
  const treasury = treasuryAccount(config, treasuryId, treasuryKey);
  const balance = (account: string) =>
    hostedBalance(() =>
      provider.viewAccount({
        accountId: account,
        blockQuery: { finality: "final" },
      }),
    );
  const board = new BoardClient(config.rpc);
  const hasActiveClaim = async (wallet: string) => {
    for (let from = 0; ; from += 50) {
      const page = await board.bids(from, 50);
      if (page.some(([, bid]) => bid.claim?.agent === wallet)) return true;
      if (page.length < 50) return false;
    }
  };
  const api: ApiDeps = {
    config,
    store,
    ledger,
    client,
    treasury,
    earningsCapYocto: settings.earningsCapYocto,
    enrollmentOwners: settings.enrollmentOwners,
    codeSkills: false,
    verifier: new RelayVerifier((accountId, publicKey) =>
      keyOnAccount(provider, accountId, publicKey),
    ),
    balance,
    hasActiveClaim,
    paidTreasury: async (hash, owner, amount) => {
      try {
        const outcome = await provider.viewTransactionStatus({
          txHash: hash,
          accountId: owner,
          waitUntil: "FINAL",
        });
        return confirmedTransfer(outcome, {
          hash,
          from: owner,
          to: treasuryId,
          amount: amount.toString(),
        });
      } catch {
        return false;
      }
    },
  };
  const runner: RunnerDeps = {
    verifyTries: new Map(),
    config,
    store,
    ledger,
    client,
    balance,
    treasury: treasuryId,
    // Free endpoints only. The archival node is severely rate limited, so it stays off unless the
    // operator sets PROVEN_CHAIN_READ_ARCHIVAL=yes.
    chain: chainReader(
      chainEndpoints(
        settings.network,
        env.PROVEN_CHAIN_READ_ARCHIVAL === "yes",
      ),
    ),
    earningsCapYocto: settings.earningsCapYocto,
    settle: async (agent, yocto) =>
      (
        await sendFromWallet(
          config,
          agent.custody_key,
          treasuryId,
          yocto,
          agent.wallet,
        )
      ).join(","),
    log: (line, detail) =>
      console.log(
        JSON.stringify({ at: new Date().toISOString(), line, detail }),
      ),
  };
  return { api, runner };
}

function json(
  res: import("node:http").ServerResponse,
  code: number,
  body: unknown,
) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function serve(api: ApiDeps, health: () => Promise<unknown>) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://hosted");
      if (req.method === "GET") {
        if (url.pathname === "/terms") return json(res, 200, terms(api));
        if (url.pathname === "/health") return json(res, 200, await health());
        if (url.pathname === "/agents")
          return json(res, 200, api.store.inOrder().map(publicView));
        const enrollment = /^\/enrollment\/([a-z0-9._-]{2,64})$/.exec(
          url.pathname,
        );
        if (enrollment)
          return json(res, 200, { allowed: canEnroll(api, enrollment[1]!) });
        const agent = /^\/agents\/([a-z0-9._-]{2,64})$/.exec(url.pathname);
        if (agent) return json(res, 200, await agentStatus(api, agent[1]!));
        const log = /^\/jobs\/(\d+)\/log$/.exec(url.pathname);
        if (log) return json(res, 200, api.store.readLog(Number(log[1])));
        return json(res, 404, { error: "Not found." });
      }
      if (req.method !== "POST")
        return json(res, 405, { error: "Use GET or POST." });
      let text = "";
      for await (const chunk of req) {
        text += String(chunk);
        if (text.length > MAX_BODY)
          return json(res, 413, { error: "Too large." });
      }
      const body = JSON.parse(text) as never;
      if (url.pathname === "/agents")
        return json(res, 200, await addAgent(api, body));
      if (url.pathname === "/withdraw")
        return json(res, 200, await withdraw(api, body));
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      json(res, 400, { error: publicMessage(error) });
    }
  });
}

export async function startHostedService() {
  const settings = hostedSettings(process.env, BOARD);
  const root = settings.dataDirectory ?? `${ROOT}runs/private/hosted`;
  const release = acquireHostedLock(root);
  try {
    const { api, runner } = await buildDeps(root);
    const treasuryId = process.env.HOSTED_TREASURY_ACCOUNT_ID!;
    const notify = telegramNotifier(
      process.env.HOSTED_TELEGRAM_TOKEN,
      process.env.HOSTED_TELEGRAM_CHAT,
    );
    const health = async () =>
      healthReport({
        config: api.config,
        balance: api.balance,
        balances: [
          {
            name: "The treasury",
            account: treasuryId,
            minimum: 2n * 10n ** 23n,
          },
          ...(process.env.RELAY_ACCOUNT_ID
            ? [
                {
                  name: "The relay",
                  account: process.env.RELAY_ACCOUNT_ID,
                  minimum: 15n * 10n ** 22n,
                },
              ]
            : []),
        ],
        spentNanoUsd: api.ledger
          .rows()
          .reduce((sum, row) => sum + row.cost_nano_usd, 0),
        limitNanoUsd: PROJECT_LIMIT_NANO_USD,
        nearPriceUsd: nearPrice,
        monitorInferenceCredit: true,
        creditSnapshot:
          process.env.HOSTED_CREDIT_USD && process.env.HOSTED_CREDIT_AS_OF
            ? {
                usd: Number(process.env.HOSTED_CREDIT_USD),
                asOf: process.env.HOSTED_CREDIT_AS_OF,
                spentSinceUsd:
                  api.ledger
                    .rows()
                    .filter(
                      (row) =>
                        Date.parse(row.at) >=
                        Date.parse(process.env.HOSTED_CREDIT_AS_OF!),
                    )
                    .reduce((sum, row) => sum + row.cost_nano_usd, 0) / 1e9,
              }
            : null,
      });
    let stopping = false;
    let activePass: Promise<void> | null = null;
    const server = serve(api, health);
    const pass = () => {
      if (stopping || activePass) return;
      activePass = runnerPass(runner)
        .catch((error: unknown) => console.error(publicMessage(error)))
        .finally(() => {
          activePass = null;
        });
    };
    const check = () => {
      if (stopping) return;
      void health()
        .then((report) => (stopping ? 0 : notify(report.alerts)))
        .catch((error: unknown) => console.error(publicMessage(error)));
    };
    let passTimer: ReturnType<typeof setInterval> | undefined;
    let checkTimer: ReturnType<typeof setInterval> | undefined;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(passTimer);
      clearInterval(checkTimer);
      // Stop admitting API calls and wait for existing writes before releasing runner ownership.
      await Promise.all([
        activePass ?? Promise.resolve(),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
      release();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    server.once("error", (error) => {
      process.exitCode = 1;
      void stop().then(() => console.error(publicMessage(error)));
    });
    server.listen(settings.port, "127.0.0.1", () => {
      const disclosure =
        settings.network === "mainnet"
          ? "mainnet: the owner holds a single key that can upgrade the contracts"
          : "testnet preparation only";
      console.log(
        `Hosted agents service on 127.0.0.1:${settings.port}; ${disclosure}.`,
      );
      if (!functionSkillsInstalled())
        console.error(
          "The function skills (wat_compile, run_function) are not installed: run `npm run build:skills` in agent/. Until then every use is refused and not charged.",
        );
      pass();
      check();
      passTimer = setInterval(pass, PASS_EVERY_MS);
      checkTimer = setInterval(check, 300_000);
    });
  } catch (error) {
    release();
    throw error;
  }
}

if (import.meta.main) {
  if (process.argv.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        hostedWritePlan(hostedSettings(process.env, BOARD)),
        null,
        2,
      ),
    );
  } else {
    await startHostedService();
  }
}
