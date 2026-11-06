// Testnet: one hosted agent from registration to payment and withdrawal, through the same functions the
// service uses. The owner and buyer here are our own accounts, so this is NOT an outsider test.
//   node scripts/hosted-e2e.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from "near-api-js";
import { BoardClient, type Bid } from "../src/board.ts";
import { executeTool } from "../src/service.ts";
import { loadConfig, ROOT } from "../src/config.ts";
import { signWithKey } from "../src/relay-auth.ts";
import {
  addAgent,
  addPayload,
  agentStatus,
  withdraw,
} from "../src/hosted/api.ts";
import { SETUP_FEE } from "../src/hosted/limits.ts";
import { runnerPass } from "../src/hosted/runner.ts";
import { buildDeps } from "../src/hosted/service.ts";
import { sendFromWallet } from "../src/hosted/wallets.ts";
import { postBid, runReview } from "../src/swarm.ts";
import type { Job } from "../src/types.ts";

const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const evidencePath = `${ROOT}runs/hosted-e2e.json`;
const evidence: Record<string, unknown> = {
  at: new Date().toISOString(),
  note: "Scripted owner and buyer, both ours. Not an outsider test.",
};
const log = (step: string, detail: unknown) => {
  evidence[step] = detail;
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ step, detail }).slice(0, 300));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig("buyer");
const provider = new JsonRpcProvider({ url: config.rpc });
const ownerId = env.WORKER_HONEST_ACCOUNT_ID!;
const ownerKey = env.WORKER_HONEST_PRIVATE_KEY!;
const owner = new Account(
  ownerId,
  provider,
  new KeyPairSigner(KeyPair.fromString(ownerKey as `ed25519:${string}`)),
);
const { api, runner } = await buildDeps(`${ROOT}runs/private/hosted-e2e`, {
  ...env,
  NEARAI_KEY_HOSTED: env.NEARAI_KEY_AGENT_B,
});
const prompt = readFileSync(`${ROOT}agent/scripts/prompts/agent-a.txt`, "utf8");
const knowledge = readFileSync(
  `${ROOT}agent/scripts/prompts/agent-a-knowledge.txt`,
  "utf8",
);
const skills = ["knowledge_search", "calculator", "json_validator"];

const board0 = new BoardClient(config.rpc);
const existing = api.store.all().find((agent) => agent.owner === ownerId);
let wallet = existing?.wallet ?? "";
if (!existing) {
  const fee = await owner.signAndSendTransaction({
    receiverId: env.HOSTED_TREASURY_ACCOUNT_ID!,
    actions: [actions.transfer(SETUP_FEE)],
  });
  log("setup_fee", fee.transaction.hash);

  // Unsigned, and signed by the wrong account: both refused before anything is spent.
  await addAgent(api, {
    owner: ownerId,
    prompt,
    knowledge,
    skills: skills as never,
    setup_transaction: fee.transaction.hash,
  }).then(
    () => {
      throw new Error("an unsigned add_agent was accepted");
    },
    (error: Error) => log("unsigned_refused", error.message),
  );
  const message = `proven-relay:add_agent:0:${addPayload({ prompt, knowledge, skills })}:${Date.now()}`;
  const added = (await addAgent(api, {
    owner: ownerId,
    prompt,
    knowledge,
    skills: skills as never,
    setup_transaction: fee.transaction.hash,
    auth: { ...signWithKey(ownerKey, message), message },
  })) as { added: boolean; agent_wallet?: string; reason?: string };
  log("added", added);
  if (!added.added || !added.agent_wallet) process.exit(1);
  wallet = added.agent_wallet;
  await addAgent(api, {
    owner: ownerId,
    prompt,
    knowledge,
    skills: skills as never,
    setup_transaction: fee.transaction.hash,
    auth: (() => {
      const again = `proven-relay:add_agent:0:${addPayload({ prompt, knowledge, skills })}:${Date.now()}`;
      return { ...signWithKey(ownerKey, again), message: again };
    })(),
  }).then(
    () => {
      throw new Error("a setup payment was used twice");
    },
    (error: Error) => log("setup_fee_reuse_refused", error.message),
  );

  const funded = await owner.signAndSendTransaction({
    receiverId: wallet,
    actions: [actions.transfer(4n * 10n ** 23n)],
  });
  log("funded_0.4", funded.transaction.hash);
  await sleep(3000);
}
const posted = (await board0.bids(0, 50)).some(
  ([, bid]) => bid.claim?.agent === wallet,
)
  ? {
      bid_id: (await board0.bids(0, 50)).find(
        ([, bid]) => bid.claim?.agent === wallet,
      )![0],
      resumed: true,
    }
  : await postBid("examples/swarm-job");
const bidId = posted.bid_id as number;
const resumed = "resumed" in posted;
log("bid", posted);
if (!resumed)
  log("review", (await runReview(bidId, "NEARAI_KEY_REVIEW")).state);

const board = new BoardClient(config.rpc);
const check =
  "check" in posted
    ? (posted.check as string)
    : readFileSync(`${ROOT}examples/swarm-job/check.json`, "utf8");
const reference = readFileSync(
  `${ROOT}examples/swarm-job/reference.json`,
  "utf8",
);
let linked: number | null = null;
linked = ((await board.bid(bidId)) as Bid).claim?.job_id ?? null;
for (let round = 0; round < 40; round++) {
  await runnerPass(runner);
  const bid = (await board.bid(bidId)) as Bid;
  if (
    bid.claim?.agent === wallet &&
    bid.claim.job_id === null &&
    linked === null
  ) {
    log("claimed_by_agent", bid.claim.claimed_at);
    const job = (await executeTool(
      "post_job_for_claim",
      { bid_id: bidId, check, reference },
      { actor: "buyer" },
    )) as { result: number };
    linked = job.result;
    log("job", linked);
    await executeTool(
      "link_job",
      { bid_id: bidId, job_id: linked },
      { actor: "buyer" },
    );
    log("linked_with_fee", (await board.fee(linked))?.state);
    const challenged = await executeTool(
      "challenge_check",
      { job_id: linked, check, reference },
      { actor: "buyer" },
    ).catch((error: Error) => error.message);
    log("challenge", typeof challenged === "string" ? challenged : "sent");
    for (let wait = 0; wait < 18; wait++) {
      const read = await board.view<Job>(
        "get_job",
        { job_id: linked },
        config.escrow,
      );
      if (read.state !== "Draft" && read.state !== "Challenging") break;
      await sleep(10_000);
    }
    await executeTool(
      "fund_linked_job",
      { bid_id: bidId, job_id: linked },
      { actor: "buyer" },
    );
    log("funded_job", linked);
  }
  if (linked !== null) {
    const read = await board.view<Job>(
      "get_job",
      { job_id: linked },
      config.escrow,
    );
    const fresh = (await board.bid(bidId)) as Bid;
    console.log(JSON.stringify({ round, job: read.state, bid: fresh.state }));
    if (read.state === "Released" && !fresh.claim) {
      log("final", {
        job: linked,
        state: read.state,
        verdict_request: read.verdict_request_id,
        fee: (await board.fee(linked))?.state,
        log: api.store.readLog(linked).length,
      });
      break;
    }
    if (read.state === "Refunded" && !fresh.claim) {
      log("final", {
        job: linked,
        state: read.state,
        failed_rule: read.failed_rule,
        fee: (await board.fee(linked))?.state,
      });
      break;
    }
  }
  await sleep(10_000);
}
log("after_job", await agentStatus(api, wallet));

// The policy refuses any other receiver, even asked for directly with this agent's own key.
const stored = api.store.get(wallet)!;
await sendFromWallet(
  config,
  stored.custody_key,
  "stranger-account.testnet",
  10n ** 21n,
).then(
  (hashes) => log("ATTACK_GOT_THROUGH_transfer_to_stranger", hashes),
  (error: Error) => log("transfer_to_stranger_refused", error.message),
);
const wrong = `proven-relay:withdraw:0:${createHash("sha256").update(wallet).digest("hex")}:${Date.now()}`;
await withdraw(api, {
  wallet,
  auth: { ...signWithKey(env.WORKER_FAKE_PRIVATE_KEY!, wrong), message: wrong },
}).then(
  () => log("ATTACK_GOT_THROUGH_withdraw_by_stranger", true),
  (error: Error) => log("withdraw_by_stranger_refused", error.message),
);
const right = `proven-relay:withdraw:0:${createHash("sha256").update(wallet).digest("hex")}:${Date.now()}`;
log(
  "withdrawal",
  await withdraw(api, {
    wallet,
    auth: { ...signWithKey(ownerKey, right), message: right },
  }),
);
await sleep(4000);
log("after_withdrawal", await agentStatus(api, wallet));
process.exit(0);
