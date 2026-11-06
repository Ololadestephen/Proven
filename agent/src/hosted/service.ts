#!/usr/bin/env node
// The hosted agents service: a small local API and the runner loop. It listens on this machine only; the
// web server forwards to it. It holds hosted agents' custody keys, the treasury key and a NEAR AI key, and
// no relay key, buyer key or escrow owner key.
import { chainProvider } from "../rpc.ts";
import { createServer } from "node:http";
import {} from "near-api-js";
import { RelayVerifier } from "../../../relay/src/buyer-auth.ts";
import { BoardClient } from "../board.ts";
import { loadConfig, ROOT } from "../config.ts";
import { publicMessage } from "../errors.ts";
import { fetchPrices, Ledger, ModelClient } from "../inference.ts";
import { KeyPool, keysFrom } from "../key-pool.ts";
import { healthReport, nearPrice, telegramNotifier } from "./health.ts";
import { addAgent, agentStatus, terms, withdraw, type ApiDeps } from "./api.ts";
import {
  AGENT_LIMIT_NANO_USD,
  JOB_LIMIT_NANO_USD,
  PROJECT_LIMIT_NANO_USD,
} from "./limits.ts";
import { runnerPass, type RunnerDeps } from "./runner.ts";
import { sandboxClient } from "./sandbox.ts";
import { HostedStore, publicView } from "./store.ts";
import { sendFromWallet, treasuryAccount } from "./wallets.ts";

const PASS_EVERY_MS = 20_000;
const PORT = 4175;
const MAX_BODY = 128 * 1024;

export async function buildDeps(
  root = process.env.PROVEN_HOSTED_DATA ?? `${ROOT}runs/private/hosted`,
  env: Record<string, string | undefined> = process.env,
) {
  const config = loadConfig("agent");
  const treasuryId = env.HOSTED_TREASURY_ACCOUNT_ID;
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
  const balance = async (account: string) => {
    try {
      const view = await provider.viewAccount({
        accountId: account,
        blockQuery: { finality: "final" },
      });
      return BigInt(view.amount);
    } catch {
      return 0n; // An implicit account nobody has funded yet.
    }
  };
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
    key: keys[0]!.key,
    treasury,
    codeSkills: Boolean(env.SANDBOX_URL && env.SANDBOX_TOKEN),
    verifier: new RelayVerifier(async (accountId, publicKey) => {
      try {
        await provider.viewAccessKey({
          accountId,
          publicKey,
          finalityQuery: { finality: "final" },
        });
        return true;
      } catch {
        return false;
      }
    }),
    balance,
    hasActiveClaim,
    paidTreasury: async (hash, owner, amount) => {
      try {
        const outcome = await provider.viewTransactionStatus({
          txHash: hash,
          accountId: owner,
          waitUntil: "FINAL",
        });
        const tx = outcome.transaction as unknown as {
          signer_id: string;
          receiver_id: string;
          actions: Array<{ Transfer?: { deposit: string } } | string>;
        };
        const status = outcome.status as { SuccessValue?: string };
        const paid = tx.actions.reduce(
          (sum, action) =>
            sum +
            (typeof action === "object" && action.Transfer
              ? BigInt(action.Transfer.deposit)
              : 0n),
          0n,
        );
        return (
          status.SuccessValue !== undefined &&
          tx.signer_id === owner &&
          tx.receiver_id === treasuryId &&
          paid >= amount
        );
      } catch {
        return false;
      }
    },
  };
  const runner: RunnerDeps = {
    config,
    store,
    ledger,
    client,
    key: keys[0]!.key,
    balance,
    treasury: treasuryId,
    sandbox:
      env.SANDBOX_URL && env.SANDBOX_TOKEN
        ? sandboxClient(env.SANDBOX_URL, env.SANDBOX_TOKEN)
        : undefined,
    settle: async (agent, yocto) =>
      (await sendFromWallet(config, agent.custody_key, treasuryId, yocto)).join(
        ",",
      ),
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

if (import.meta.main) {
  const { api, runner } = await buildDeps();
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
        { name: "The treasury", account: treasuryId, minimum: 10n ** 23n },
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
    });
  serve(api, health).listen(PORT, "127.0.0.1", () =>
    console.log(`Hosted agents service on 127.0.0.1:${PORT}.`),
  );
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      await runnerPass(runner);
    } catch (error) {
      console.error(publicMessage(error));
    } finally {
      running = false;
    }
  };
  void pass();
  setInterval(() => void pass(), PASS_EVERY_MS);
  const check = () =>
    health()
      .then((report) => notify(report.alerts))
      .catch((error: unknown) => console.error(publicMessage(error)));
  void check();
  setInterval(() => void check(), 300_000);
}
