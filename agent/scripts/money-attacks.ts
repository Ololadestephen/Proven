// Real testnet attacks on the new escrow, for the mainnet gate. Each is a call that must fail, sent by
// a real account, and is reported with the contract's own refusal. It also shows the pause and the
// caps refusing real calls, then lifts the pause. Testnet only.
//   node scripts/money-attacks.ts <released-job> <refunded-job> <job-in-any-open-state>
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { ROOT } from "../src/config.ts";
import { parseJson } from "../src/json.ts";

const ESCROW = "escrow-v5.proven.testnet";
const [released, refunded, open] = process.argv.slice(2).map(Number);
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const signer = (id: string, key: string) =>
  new Account(
    id,
    provider,
    new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
  );
const stranger = signer(
  env.WORKER_FAKE_ACCOUNT_ID!,
  env.WORKER_FAKE_PRIVATE_KEY!,
);
const owner = signer(env.NEAR_ACCOUNT_ID!, env.NEAR_PRIVATE_KEY!);

const job = async (id: number) =>
  (await provider.callFunction({
    contractId: ESCROW,
    method: "get_job",
    args: { job_id: id },
  })) as { state: string; worker: string; deliverable_hash: string | null };
const config = async () =>
  (await provider.callFunction({
    contractId: ESCROW,
    method: "get_config",
    args: {},
  })) as { paused: boolean; caps: Array<{ held: string }> };

const rows: Array<Record<string, unknown>> = [];
async function refused(
  id: string,
  who: Account,
  method: string,
  args: Record<string, unknown>,
  deposit = 0n,
) {
  let outcome: string;
  try {
    const result = await who.callFunctionRaw({
      contractId: ESCROW,
      methodName: method,
      args,
      deposit,
      gas: 100_000_000_000_000n,
    });
    outcome = JSON.stringify(result.status).slice(0, 180);
  } catch (error) {
    outcome = String(error).slice(0, 180);
  }
  const held = /panicked|private|MethodNotFound|Failure/i.test(outcome);
  const row = { id, by: who.accountId, method, refused: held, outcome };
  rows.push(row);
  console.log(JSON.stringify(row));
}

const before = { released: await job(released), refunded: await job(refunded) };
const hash = "a".repeat(64);
const now = (await provider.viewBlock({ finality: "final" })).header
  .timestamp_nanosec;
const newJob = (amount: bigint) => ({
  worker: stranger.accountId,
  spec_hash: hash,
  fakes_hash: hash,
  format_hash: hash,
  amount: amount.toString(),
  token: null,
  deadline: (BigInt(now) + 3_600_000_000_000n).toString(),
  verdict_window_secs: 1800,
  verifier_hash: (
    parseJson(
      readFileSync(`${ROOT}examples/swarm-job/check.json`, "utf8"),
      "examples/swarm-job/check.json",
    ) as { verifier: string }
  ).verifier,
});
const forged = { job_id: open, attempt: 1, kind: "Verify" };

await refused("forged-callback-stranger", stranger, "on_run_result", forged);
await refused("forged-callback-owner", owner, "on_run_result", forged);
await refused("replayed-challenge-callback", stranger, "on_run_result", {
  job_id: released,
  attempt: 1,
  kind: "Challenge",
});
await refused("forged-payout-callback", stranger, "on_payout", {
  job_id: refunded,
  done: "Released",
  revert_to: "Failed",
});
await refused("old-verdict-method", owner, "record_verdict", {
  job_id: open,
  pass: true,
});
await refused("double-release", stranger, "release", { job_id: released });
await refused("refund-after-release", stranger, "refund", { job_id: released });
await refused("double-refund", stranger, "refund", { job_id: refunded });
await refused("release-after-refund", stranger, "release", {
  job_id: refunded,
});
await refused("expire-after-release", stranger, "expire", { job_id: released });
await refused("unauthorised-delivery", stranger, "deliver", {
  job_id: open,
  deliverable_hash: hash,
});
await refused("change-delivery-after-delivering", stranger, "deliver", {
  job_id: released,
  deliverable_hash: hash,
});
await refused("stranger-pauses", stranger, "set_paused", { paused: true });
await refused("stranger-raises-caps", stranger, "set_caps", {
  token: null,
  max_job: "1",
  max_held: "1",
  max_held_per_buyer: "1",
});
await refused("stranger-changes-verifier", stranger, "set_verifier", {
  verifier_url: "https://example.test/x.wasm",
  verifier_hash: hash,
});
await refused(
  "over-the-per-job-cap",
  owner,
  "create_job",
  newJob(110_000_000_000_000_000_000_000n),
  50_000_000_000_000_000_000_000n,
);

// The pause, for real: new jobs are refused, then lifted.
await owner.callFunctionRaw({
  contractId: ESCROW,
  methodName: "set_paused",
  args: { paused: true },
  gas: 30_000_000_000_000n,
});
const paused = (await config()).paused;
await refused(
  "new-job-while-paused",
  owner,
  "create_job",
  newJob(10_000_000_000_000_000_000_000n),
  50_000_000_000_000_000_000_000n,
);
await owner.callFunctionRaw({
  contractId: ESCROW,
  methodName: "set_paused",
  args: { paused: false },
  gas: 30_000_000_000_000n,
});

const after = { released: await job(released), refunded: await job(refunded) };
const finalConfig = await config();
const summary = {
  at: new Date().toISOString(),
  escrow: ESCROW,
  all_refused: rows.every((row) => row.refused),
  attempts: rows.length,
  released_job_unchanged:
    JSON.stringify(before.released) === JSON.stringify(after.released),
  refunded_job_unchanged:
    JSON.stringify(before.refunded) === JSON.stringify(after.refunded),
  was_paused: paused,
  paused_now: finalConfig.paused,
  held_now: finalConfig.caps[0]?.held,
  rows,
};
writeFileSync(
  `${ROOT}runs/p7-money-attacks.json`,
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ ...summary, rows: undefined }));
