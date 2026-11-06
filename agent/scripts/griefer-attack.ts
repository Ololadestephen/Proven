// Testnet P7 probe on real OutLayer: trigger a challenge for a job whose private texts were never
// pinned. This is also what a relay withholding the texts looks like. Uses agent C's custody wallet,
// so the griefer pays. The job is unfunded and is cancelled at the end to return its storage.
//   node scripts/griefer-attack.ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { ROOT } from "../src/config.ts";
import { custodyCall } from "../src/custody.ts";
import { waitTransactionResult } from "../src/near.ts";
import type { Job } from "../src/types.ts";

const API = "https://testnet-api.outlayer.ai";
const ESCROW = "escrow-v4.proven.testnet";
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const key = env.PROVEN_AGENT_C_CUSTODY_KEY!;
const account = env.PROVEN_AGENT_C_ACCOUNT_ID!;
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const check = readFileSync(`${ROOT}examples/swarm-job/check.json`, "utf8");
const reference = readFileSync(
  `${ROOT}examples/swarm-job/reference.json`,
  "utf8",
);
const evidence: Record<string, unknown> = {
  at: new Date().toISOString(),
  griefer: account,
};
const save = () =>
  writeFileSync(
    `${ROOT}runs/p7-griefer-attack.json`,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );

const balance = async () =>
  (await provider.viewAccount({ accountId: account })).amount;
async function send(
  method_name: string,
  args: Record<string, unknown>,
  deposit: bigint,
  gas: bigint,
) {
  const tx = await custodyCall(API, key, account, ESCROW, {
    receiver_id: ESCROW,
    method_name,
    args,
    deposit: deposit.toString(),
    gas: gas.toString(),
  });
  const result = await waitTransactionResult(provider, tx, account);
  evidence[method_name] = {
    transaction_hash: tx,
    failed: Boolean(result.failed),
    pending: Boolean(result.pending),
    result: result.result,
  };
  save();
  console.log(
    method_name,
    tx,
    result.failed ? "failed" : result.pending ? "pending" : "ok",
  );
  return result;
}
const read = async (id: number) =>
  (await provider.callFunction({
    contractId: ESCROW,
    method: "get_job",
    args: { job_id: id },
  })) as unknown as Job | null;

const start = await balance();
evidence.balance_before = start.toString();
const block = await provider.viewBlock({ finality: "final" });
const created = await send(
  "create_job",
  {
    worker: env.PROVEN_HONEST_ACCOUNT_ID,
    spec_hash: sha(check),
    fakes_hash: sha(reference),
    amount: (10n ** 22n).toString(),
    token: null,
    deadline: (
      BigInt(block.header.timestamp_nanosec) + 3_600_000_000_000n
    ).toString(),
    verdict_window_secs: 1800,
    verifier_hash: (JSON.parse(check) as { verifier: string }).verifier,
  },
  5n * 10n ** 22n,
  70_000_000_000_000n,
);
const id = created.result as number;
evidence.job_id = id;
await send(
  "request_challenge",
  { job_id: id },
  10n ** 23n,
  150_000_000_000_000n,
);

let job = await read(id);
for (let poll = 0; poll < 12 && job?.state === "Challenging"; poll++) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  job = await read(id);
}
evidence.after_run = {
  state: job?.state,
  attempt: job?.attempt,
  challenge_request_id: job?.challenge_request_id,
  fakes_total: job?.fakes_total,
  report_hash: job?.challenge_report_hash,
};
save();
console.log(JSON.stringify(evidence.after_run));
if (job?.state === "Draft")
  await send("cancel", { job_id: id }, 0n, 70_000_000_000_000n);
evidence.balance_after = (await balance()).toString();
evidence.griefer_cost_yocto = (start - (await balance())).toString();
save();
console.log("griefer cost NEAR", Number(start - (await balance())) / 1e24);
