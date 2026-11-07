// Testnet run of one-signature jobs on the upgraded escrow and board, through a real relay and the real
// OutLayer. The buyer signs once to post. A scripted wrong delivery (labelled) fails and reopens the job,
// a scripted correct delivery (labelled) passes and is paid, a second bid is closed and refunded, and a
// few calls that must fail are refused. Testnet only. Needs the relay running with PROVEN_BOARD set:
//   PROVEN_RELAY_SOCKET=<socket> node scripts/one-signature-gate.ts
import { createHash, randomBytes, sign as edSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { postingDeposit } from "../src/board.ts";
import { ROOT } from "../src/config.ts";
import { handoff } from "../src/handoff.ts";

const ESCROW = "escrow-v5.proven.testnet";
const BOARD = "board-v4.proven.testnet";
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const AMOUNT = NEAR / 100n;
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const socket = process.env.PROVEN_RELAY_SOCKET!;
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const signer = (id: string, key: string) =>
  new Account(
    id,
    provider,
    new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
  );
const buyer = signer(env.NEAR_ACCOUNT_ID!, env.NEAR_PRIVATE_KEY!);
const fake = signer(env.WORKER_FAKE_ACCOUNT_ID!, env.WORKER_FAKE_PRIVATE_KEY!);
const honest = signer(
  env.WORKER_HONEST_ACCOUNT_ID!,
  env.WORKER_HONEST_PRIVATE_KEY!,
);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const evidence: Record<string, unknown> = {
  at: new Date().toISOString(),
  steps: [],
};
const log = (step: string, detail: unknown) => {
  (evidence.steps as unknown[]).push({ step, detail });
  writeFileSync(
    `${ROOT}runs/one-signature-gate.json`,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify({ step, detail }).slice(0, 300));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(
  who: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
  gas = 150n * TGAS,
) {
  const outcome = await who
    .callFunctionRaw({ contractId, methodName, args, deposit, gas })
    .catch((error: Error) => error);
  // A refusal comes back as an error: kept as the outcome, so the run can record it and go on.
  if (outcome instanceof Error)
    return {
      hash: null,
      ok: false,
      failure: outcome.message.slice(0, 200),
      value: undefined,
    };
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  return {
    hash: outcome.transaction.hash,
    ok: status.SuccessValue !== undefined,
    failure: status.Failure
      ? JSON.stringify(status.Failure).slice(0, 200)
      : null,
    value: status.SuccessValue,
  };
}
const view = <T>(
  contractId: string,
  method: string,
  args: Record<string, unknown>,
) => provider.callFunction({ contractId, method, args }) as Promise<T>;
const job = (id: number) =>
  view<Record<string, unknown> & { state: string; history: unknown[] }>(
    ESCROW,
    "get_job",
    {
      job_id: id,
    },
  );
const bid = (id: number) =>
  view<
    Record<string, unknown> & { state: string; job_id: number; fees: string[] }
  >(BOARD, "get_bid", { bid_id: id });
const balance = async (who: Account) =>
  BigInt((await provider.viewAccount({ accountId: who.accountId })).amount);

async function until(
  id: number,
  done: (state: string) => boolean,
  label: string,
  mins = 8,
) {
  for (let i = 0; i < mins * 6; i++) {
    const current = await job(id);
    if (done(current.state)) return current;
    await sleep(10_000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The worker's NEP-413 signature over the relay message, as a browser wallet would make it. */
function relayAuth(
  key: string,
  action: string,
  jobId: number,
  payload: string,
) {
  const pair = KeyPair.fromString(key as `ed25519:${string}`);
  const message = `proven-relay:${action}:${jobId}:${sha(payload)}:${Date.now()}`;
  const borsh = (text: string) => {
    const bytes = Buffer.from(text);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061);
  const nonce = randomBytes(32);
  const digest = createHash("sha256")
    .update(
      Buffer.concat([
        tag,
        borsh(message),
        nonce,
        borsh("proven-relay"),
        Buffer.from([0]),
      ]),
    )
    .digest();
  void edSign;
  return {
    public_key: pair.getPublicKey().toString(),
    message,
    nonce_base64: nonce.toString("base64"),
    signature_base64: Buffer.from(pair.sign(digest).signature).toString(
      "base64",
    ),
  };
}

async function post(attempts: number, label: string) {
  const dir = `${ROOT}examples/swarm-job`;
  const unique = Array.from(randomBytes(8), (b) =>
    b.toString(2).replace(/0/g, " ").replace(/1/g, "\t"),
  ).join("");
  const check = `${readFileSync(`${dir}/check.json`, "utf8")}${unique}`;
  const reference = readFileSync(`${dir}/reference.json`, "utf8");
  const { verifier, format } = JSON.parse(check) as {
    verifier: string;
    format: string;
  };
  const { run_deposit } = await view<{ run_deposit: string }>(
    ESCROW,
    "get_config",
    {},
  );
  const deposit = postingDeposit(AMOUNT, attempts, BigInt(run_deposit));
  const now = BigInt(Date.now()) * 1_000_000n;
  const before = await balance(buyer);
  const posted = await call(
    buyer,
    BOARD,
    "post_bid",
    {
      description: readFileSync(`${dir}/task.txt`, "utf8"),
      amount: AMOUNT.toString(),
      check_hash: sha(check),
      reference_hash: sha(reference),
      verifier_hash: verifier,
      format,
      expires_at: (now + 24n * 3_600n * 1_000_000_000n).toString(),
      reveal_agreed: true,
      deliver_secs: 3_600,
      max_attempts: attempts,
      allowed_workers: [fake.accountId, honest.accountId],
    },
    deposit,
  );
  const bids = await view<
    Array<[number, { check_hash: string; job_id: number }]>
  >(BOARD, "get_bids", { from_id: 0, limit: 50 });
  const [bidId, found] = bids.find(([, b]) => b.check_hash === sha(check))!;
  log(`${label}_posted`, {
    one_transaction: posted.hash,
    ok: posted.ok,
    attached_near: Number(deposit) / 1e24,
    spent_so_far_near: Number(before - (await balance(buyer))) / 1e24,
    bid: bidId,
    job: found.job_id,
  });
  // No signature: the texts match the hashes on chain. The relay tests the check itself.
  const handed = await handoff(socket, {
    action: "challenge",
    job_id: found.job_id,
    check,
    reference,
  });
  log(`${label}_check_sent`, handed);
  return { bidId, jobId: found.job_id, reference, before };
}

// ---- Bid A: a failed attempt reopens the job, the next worker is paid ----
const a = await post(2, "a");
const open = await until(
  a.jobId,
  (s) => !["Draft", "Challenging"].includes(s),
  "the challenge",
);
log("a_challenge", {
  state: open.state,
  fakes: `${open.fakes_caught} of ${open.fakes_total}`,
  request: open.challenge_request_id,
});
log(
  "a_review",
  await call(
    buyer,
    BOARD,
    "record_review",
    {
      bid_id: a.bidId,
      allow: true,
      review_hash: sha("gate"),
      model: "gate",
      chat_id: "gate",
    },
    0n,
    30n * TGAS,
  ),
);

// Refused calls on a live job.
const refused: Record<string, unknown> = {};
refused.stranger_assign = (
  await call(fake, ESCROW, "assign", {
    job_id: a.jobId,
    worker: fake.accountId,
  })
).failure;
refused.buyer_claims_own_bid = (
  await call(
    buyer,
    BOARD,
    "claim",
    { bid_id: a.bidId },
    (5n * NEAR) / 1000n,
    100n * TGAS,
  )
).ok;

for (const [who, key] of [
  [fake, env.WORKER_FAKE_PRIVATE_KEY!],
  [honest, env.WORKER_HONEST_PRIVATE_KEY!],
] as const) {
  const registered = await view<unknown>(BOARD, "get_agent", {
    wallet: who.accountId,
  });
  if (!registered)
    log(
      "register",
      await call(
        who,
        BOARD,
        "register_agent",
        {
          prompt_hash: sha(who.accountId),
          knowledge_hash: sha(""),
          tools_hash: sha("[]"),
          model: "scripted",
          owner: null,
        },
        (2n * NEAR) / 100n,
        30n * TGAS,
      ),
    );
  void key;
}

log(
  "a_fake_claims",
  await call(
    fake,
    BOARD,
    "claim",
    { bid_id: a.bidId },
    (5n * NEAR) / 1000n,
    100n * TGAS,
  ),
);
log("a_assigned", {
  job_worker: (await job(a.jobId)).worker,
  bid_state: (await bid(a.bidId)).state,
});
refused.buyer_starts_verification = (
  await call(
    buyer,
    ESCROW,
    "request_verification",
    { job_id: a.jobId },
    0n,
    200n * TGAS,
  )
).failure;

const wrong = JSON.stringify({ rows: [] });
log(
  "a_fake_delivers_scripted_wrong_work",
  await call(
    fake,
    ESCROW,
    "deliver",
    { job_id: a.jobId, deliverable_hash: sha(wrong) },
    0n,
    15n * TGAS,
  ),
);
log(
  "a_fake_hands_over",
  await handoff(socket, {
    action: "deliver",
    job_id: a.jobId,
    deliverable: wrong,
    auth: relayAuth(env.WORKER_FAKE_PRIVATE_KEY!, "deliver", a.jobId, wrong),
  }),
);
const failed = await until(
  a.jobId,
  (s) => ["Failed", "Open", "RefundDue", "Refunded"].includes(s),
  "the fake's verdict",
);
log("a_fake_verdict", {
  state: failed.state,
  failed_rule: failed.failed_rule,
  request: failed.verdict_request_id,
});
if (failed.state === "Failed")
  log(
    "a_close_failed_attempt",
    await call(fake, ESCROW, "refund", { job_id: a.jobId }, 0n, 100n * TGAS),
  );
const reopened = await job(a.jobId);
log("a_reopened", { state: reopened.state, history: reopened.history });
log(
  "a_sync",
  await call(fake, BOARD, "sync", { bid_id: a.bidId }, 0n, 200n * TGAS),
);
await sleep(5_000);
log("a_bid_after_fake", {
  state: (await bid(a.bidId)).state,
  fees: (await bid(a.bidId)).fees,
});

log(
  "a_honest_claims",
  await call(
    honest,
    BOARD,
    "claim",
    { bid_id: a.bidId },
    (5n * NEAR) / 1000n,
    100n * TGAS,
  ),
);
const right = a.reference.trim();
log(
  "a_honest_delivers_scripted_correct_work",
  await call(
    honest,
    ESCROW,
    "deliver",
    { job_id: a.jobId, deliverable_hash: sha(right) },
    0n,
    15n * TGAS,
  ),
);
log(
  "a_honest_hands_over",
  await handoff(socket, {
    action: "deliver",
    job_id: a.jobId,
    deliverable: right,
    auth: relayAuth(env.WORKER_HONEST_PRIVATE_KEY!, "deliver", a.jobId, right),
  }),
);
const passed = await until(
  a.jobId,
  (s) => ["Passed", "Released", "Failed"].includes(s),
  "the honest verdict",
);
log("a_honest_verdict", {
  state: passed.state,
  request: passed.verdict_request_id,
});
// The relay's keeper pays out within its sweep; nobody presses anything.
const paid = await until(
  a.jobId,
  (s) => s === "Released",
  "the keeper's payout",
  8,
);
log("a_paid_by_keeper", {
  state: paid.state,
  compute_budget_left: paid.compute_budget,
});
const synced = await (async () => {
  for (let i = 0; i < 48; i++) {
    const b = await bid(a.bidId);
    const j = await job(a.jobId);
    if (
      b.state === "Done" &&
      j.compute_budget === "0" &&
      !b.fees.includes("Held") &&
      !b.fees.includes("Paying")
    )
      return { bid: b.state, fees: b.fees, budget: j.compute_budget };
    await sleep(10_000);
  }
  return {
    bid: (await bid(a.bidId)).state,
    fees: (await bid(a.bidId)).fees,
    budget: (await job(a.jobId)).compute_budget,
    note: "keeper did not finish",
  };
})();
log("a_settled_by_keeper", synced);
log("a_buyer_net_cost_near", Number(a.before - (await balance(buyer))) / 1e24);

// ---- Bid B: closed by the buyer before anyone applies, everything comes back ----
const b = await post(1, "b");
await until(
  b.jobId,
  (s) => !["Draft", "Challenging"].includes(s),
  "b's challenge",
);
log("b_close", await call(buyer, BOARD, "close_bid", { bid_id: b.bidId }));
await sleep(5_000);
log("b_job", { state: (await job(b.jobId)).state });
log(
  "b_sync",
  await call(buyer, BOARD, "sync", { bid_id: b.bidId }, 0n, 200n * TGAS),
);
await sleep(5_000);
log("b_bid", {
  state: (await bid(b.bidId)).state,
  fees: (await bid(b.bidId)).fees,
});
log("b_buyer_net_cost_near", Number(b.before - (await balance(buyer))) / 1e24);
log("refused", refused);
