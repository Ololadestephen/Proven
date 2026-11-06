// Testnet: one job with the agent's side done only through the MCP server, the way Claude or Codex would
// use it. A scripted client speaks the real protocol; a model call stands in for the assistant's own work.
// The buyer's side uses the buyer's tools.
//   node scripts/mcp-agent-test.ts
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { loadConfig, ROOT } from "../src/config.ts";
import { fetchPrices, Ledger, ModelClient, usd } from "../src/inference.ts";
import { doWork } from "../src/llm-work.ts";
import { createRuntime } from "../src/near.ts";
import { createService, executeTool } from "../src/service.ts";
import { postBid, runReview } from "../src/swarm.ts";
import type { Job } from "../src/types.ts";

const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const wallet = env.PROVEN_AGENT_ACCOUNT_ID;
if (!wallet || !env.PROVEN_AGENT_CUSTODY_KEY)
  throw new Error(
    "Set PROVEN_AGENT_ACCOUNT_ID and PROVEN_AGENT_CUSTODY_KEY in .env.",
  );
const evidence: Record<string, unknown> = {
  at: new Date().toISOString(),
  wallet,
  note: "A scripted client speaking the real MCP protocol. A model call stands in for the assistant's work.",
  steps: [],
};
const log = (step: string, detail: unknown) => {
  (evidence.steps as unknown[]).push({ step, detail });
  writeFileSync(
    `${ROOT}runs/mcp-agent-test.json`,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify({ step, detail }).slice(0, 280));
};

const server = spawn(process.execPath, ["src/mcp.ts"], {
  cwd: `${ROOT}agent`,
  env: { ...process.env, PROVEN_ACTOR: "agent" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buffer = "";
const waiting = new Map<number, (value: unknown) => void>();
server.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  }
});
let nextId = 1;
const rpc = (method: string, params: unknown) =>
  new Promise<{
    result?: Record<string, unknown>;
    error?: { message: string };
  }>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve as (value: unknown) => void);
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });
async function tool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const reply = await rpc("tools/call", { name, arguments: args });
  const result = reply.result as
    | {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: unknown;
      }
    | undefined;
  const text = result?.content?.[0]?.text ?? "";
  if (reply.error || result?.isError)
    throw new Error(`${name}: ${reply.error?.message ?? text}`);
  const parsed = JSON.parse(text) as { result?: T };
  return (
    parsed &&
    typeof parsed === "object" &&
    "result" in parsed &&
    Object.keys(parsed).length === 1
      ? parsed.result
      : parsed
  ) as T;
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "proven-mcp-test", version: "1" },
});
log("initialize", (init.result as { serverInfo?: unknown })?.serverInfo);
server.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
);
const listed = await rpc("tools/list", {});
log(
  "tools",
  (listed.result as { tools: Array<{ name: string }> }).tools.map(
    (t) => t.name,
  ),
);

// The buyer posts, separately.
const existing = process.argv[2];
const posted = existing ? null : await postBid("examples/swarm-job");
const bidId = existing ? Number(existing) : (posted?.bid_id as number);
if (!existing) {
  const reviewed = await runReview(bidId, "NEARAI_KEY_REVIEW");
  log("buyer_post_and_review", { bid: bidId, state: reviewed.state });
}

// The agent finds the work, registers if new, and claims.
const bids = await tool<
  Array<[number, { state: string; description: string }]>
>("list_bids", { from_id: bidId, limit: 1 });
log(
  "agent_lists_bids",
  bids.map(([id, bid]) => ({ id, state: bid.state })),
);
const agents = await tool<Array<{ wallet: string }>>("list_agents", {
  limit: 50,
});
if (!agents.some((agent) => agent.wallet === wallet)) {
  const done = await tool("register_agent", {
    prompt: "An AI assistant working through MCP.",
    tools: JSON.stringify(["deliver"]),
    model: "assistant-over-mcp",
  });
  log("agent_registers", done.transaction_hash);
}
log(
  "agent_claims",
  (await tool("claim_bid", { bid_id: bidId })).transaction_hash,
);

// The buyer's side: the worker and amount come from the chain.
const config = loadConfig("buyer");
const check = readFileSync(`${ROOT}examples/swarm-job/check.json`, "utf8");
const reference = readFileSync(
  `${ROOT}examples/swarm-job/reference.json`,
  "utf8",
);
const job = (await executeTool(
  "post_job_for_claim",
  { bid_id: bidId, check, reference },
  { actor: "buyer" },
)) as { result: number; transaction_hash: string };
const jobId = job.result;
log("buyer_post_job_for_claim", {
  job_id: jobId,
  transaction_hash: job.transaction_hash,
});
log(
  "buyer_link",
  (
    (await executeTool(
      "link_job",
      { bid_id: bidId, job_id: jobId },
      { actor: "buyer" },
    )) as { transaction_hash: string }
  ).transaction_hash,
);
const buyer = createService(createRuntime(config));
const challenged = await buyer("challenge_check", {
  job_id: jobId,
  check,
  reference,
}).catch(() => null);
log(
  "buyer_challenge",
  (challenged as { transaction_hash?: string } | null)?.transaction_hash ??
    "custody error, read chain",
);
const read = () => buyer("job_status", { job_id: jobId }) as Promise<Job>;
const until = async (leave: string[]) => {
  for (let i = 0; i < 40; i++) {
    const current = await read();
    if (!leave.includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Timed out.");
};
await until(["Draft", "Challenging"]);
log(
  "buyer_funds",
  (
    (await executeTool(
      "fund_linked_job",
      { bid_id: bidId, job_id: jobId },
      { actor: "buyer" },
    )) as { transaction_hash: string }
  ).transaction_hash,
);

// The agent checks it is funded and names it, reads the task, works, delivers and triggers verification.
const status = await tool<Job>("job_status", { job_id: jobId });
if (status.state !== "Funded" || status.worker !== wallet)
  throw new Error("Not funded for this agent.");
const bid = await tool<{ description: string }>("bid_status", {
  bid_id: bidId,
});
const work = await doWork(
  new ModelClient(
    new Ledger(`${ROOT}runs/inference-ledger.jsonl`),
    await fetchPrices(),
  ),
  {
    id: "mcp-agent",
    prompt: "Follow the task's rules exactly.",
    knowledge: "",
    key: env.NEARAI_KEY_AGENT_B ?? "",
    limitNanoUsd: 30_000_000,
  },
  bid.description,
  "mcp-agent-work",
  `bid-${bidId}`,
);
log("work_stand_in", {
  usd: usd(work.call.costNanoUsd),
  refusal: work.refusal,
});
if (work.deliverable === null) throw new Error("No usable delivery.");
const delivered = await tool("deliver", {
  job_id: jobId,
  deliverable: work.deliverable,
});
log("agent_delivers", {
  transaction_hash: delivered.transaction_hash,
  private_handoff: Boolean(delivered.private_handoff),
});
const verified = await tool<{ transaction_hash?: string; job?: Job }>(
  "request_verification",
  { job_id: jobId },
);
log("agent_verifies", {
  transaction_hash: verified.transaction_hash,
  state: verified.job?.state,
  request: verified.job?.verdict_request_id,
});
const verdict = await until(["Delivered", "Verifying"]);
log(
  "agent_settles",
  (await tool("release_or_refund", { job_id: jobId })).transaction_hash,
);
const final = await until(["Passed", "Failed", "Releasing", "Refunding"]);
log(
  "agent_syncs",
  (await tool("sync_bid", { bid_id: bidId })).transaction_hash,
);
log("final", {
  bid: bidId,
  job: jobId,
  verdict: verdict.state,
  job_state: final.state,
  failed_rule: final.failed_rule,
});
if (final.state === "Released") {
  const got = (await executeTool(
    "collect_delivery",
    { job_id: jobId },
    { actor: "buyer" },
  )) as { deliverable: string };
  log("buyer_collects", { bytes: got.deliverable.length });
}
server.kill();
