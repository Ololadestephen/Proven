// The gate's OutLayer run, sent straight from the operator account with no escrow. One run with a
// private check and reference held in a WASM-hash-bound secret, and one deliberately failed run with a
// wrong build hash, to see what OutLayer keeps. Measures the real cost of both. Works on testnet as a
// rehearsal; on mainnet it needs NEAR_NETWORK=mainnet and PROVEN_STAGE2_APPROVED=yes.
//   node --env-file=../.env src/outlayer-gate.ts [--dry-run]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { actions } from "near-api-js";
import { loadConfig } from "./config.ts";
import { verifierFromCheck } from "./json.ts";
import { relayAccount } from "./near.ts";
import { deleteSecret, storeSecret } from "./secret.ts";

const RUN_DEPOSIT = 100_000_000_000_000_000_000_000n; // 0.1 NEAR.
const RUN_GAS = 250_000_000_000_000n;
const LIMITS = {
  max_instructions: 50_000_000_000,
  max_memory_mb: 128,
  max_execution_seconds: 60,
};
const ROOT = new URL("../../", import.meta.url).pathname;
const dry = process.argv.includes("--dry-run");
const check = readFileSync(`${ROOT}examples/swarm-job/check.json`, "utf8");
const reference = readFileSync(
  `${ROOT}examples/swarm-job/reference.json`,
  "utf8",
);
const verifier = verifierFromCheck(check);
const base = loadConfig();
const onMainnet = base.outlayerContract === "outlayer.near";
const account = relayAccount(base);
// The secret may be read only by runs this account requests, since no escrow is involved here.
const config = { ...base, escrowContract: account.accountId };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const url = `https://${onMainnet ? "main" : "test"}.fastfs.io/${account.accountId}/${config.outlayerContract}/${verifier}.wasm`;
const profile = `gate-${sha(reference).slice(0, 12)}`;
const evidence: Record<string, unknown> = {
  at: new Date().toISOString(),
  network: onMainnet ? "mainnet" : "testnet",
  label: onMainnet ? "unaudited, owner-funded mainnet deployment" : "rehearsal",
  account: account.accountId,
  outlayer: config.outlayerContract,
  verifier_url: url,
  dry_run: dry,
};
const path = `${ROOT}runs/outlayer-gate-${evidence.network as string}${dry ? "-dry" : ""}.json`;
const save = () =>
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
const near = (yocto: bigint) => Number(yocto) / 1e24;
const balance = async () =>
  BigInt(
    (await account.provider.viewAccount({ accountId: account.accountId }))
      .amount,
  );

const request = (hash: string) => ({
  source: { WasmUrl: { url, hash, build_target: "wasm32-wasip1" } },
  input_data: JSON.stringify({
    mode: "challenge",
    check_hash: sha(check),
    reference_hash: sha(reference),
  }),
  resource_limits: LIMITS,
  secrets_ref: { profile, account_id: account.accountId },
  response_format: "Json",
  payer_account_id: account.accountId,
});

async function run(label: string, hash: string) {
  const before = await balance();
  const outcome = await account.signAndSendTransaction({
    receiverId: config.outlayerContract,
    actions: [
      actions.functionCall(
        "request_execution",
        request(hash),
        RUN_GAS,
        RUN_DEPOSIT,
      ),
    ],
    throwOnFailure: false,
  });
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  const events = outcome.receipts_outcome
    .flatMap((receipt) => receipt.outcome.logs)
    .filter((log) =>
      /execution_completed|execution_requested|EVENT_JSON/.test(log),
    )
    .map((log) => log.slice(0, 400));
  const output =
    status.SuccessValue !== undefined
      ? Buffer.from(status.SuccessValue, "base64")
          .toString("utf8")
          .slice(0, 700)
      : null;
  // Refunds arrive as their own receipts, so wait for them before measuring.
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const row = {
    label,
    transaction_hash: outcome.transaction.hash,
    succeeded: status.SuccessValue !== undefined,
    failure: status.Failure
      ? JSON.stringify(status.Failure).slice(0, 300)
      : null,
    output,
    events,
    total_cost_near: near(before - (await balance())),
  };
  evidence[label] = row;
  save();
  console.log(JSON.stringify(row, null, 1).slice(0, 1400));
  return row;
}

async function main() {
  const start = await balance();
  evidence.balance_before_near = near(start);
  const estimate = await account.provider.callFunction({
    contractId: config.outlayerContract,
    method: "estimate_execution_cost",
    args: {
      resource_limits: LIMITS,
      input_len: request(verifier).input_data.length,
    },
  });
  evidence.estimate_yocto = estimate;
  const hosted = await fetch(url, { headers: { range: "bytes=0-10" } }).catch(
    () => null,
  );
  evidence.verifier_hosted_status = hosted?.status ?? "unreachable";
  console.log(JSON.stringify(evidence, null, 1));
  if (dry) {
    evidence.planned = [
      `store_secrets ${profile}, about 0.1 NEAR, refunded when deleted`,
      "request_execution real build, 0.1 NEAR attached, unused part refunded",
      "request_execution wrong hash, 0.1 NEAR attached, to see what a failed run keeps",
      "delete_secrets",
    ];
    save();
    console.log(evidence.planned);
    return;
  }
  if (hosted?.status !== 200 && hosted?.status !== 206)
    throw new Error("Publish the verifier for this account first.");

  const stored = await storeSecret(account, config, verifier, profile, {
    PROVEN_CHECK: check,
    PROVEN_REFERENCE: reference,
  });
  evidence.secret_store_tx = stored.transactionHash;
  save();
  try {
    const good = await run("good_run", verifier);
    await run("failed_run_wrong_hash", "0".repeat(64));
    evidence.good_run_worked = /"accepted":\s*true/.test(good.output ?? "");
  } finally {
    evidence.secret_delete_tx = await deleteSecret(
      account,
      config,
      verifier,
      profile,
    );
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    evidence.balance_after_near = near(await balance());
    evidence.total_spent_near = near(start - (await balance()));
    save();
  }
  console.log(
    JSON.stringify({
      good_run_worked: evidence.good_run_worked,
      total_spent_near: evidence.total_spent_near,
    }),
  );
  if (!evidence.good_run_worked) process.exitCode = 1;
}

main().catch((error) => {
  evidence.error = String(error).slice(0, 400);
  save();
  console.error(evidence.error);
  process.exitCode = 1;
});
