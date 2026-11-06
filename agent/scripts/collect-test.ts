// Real test of the buyer collect route, with a real custody wallet signature against the running relay.
// It collects a Released job as its buyer, then checks the same collection is refused for a replayed
// signature, for any other account, and for a refunded job. Prints only hashes and outcomes.
//   node scripts/collect-test.ts <released-job-id> <refunded-job-id>
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { JsonRpcProvider } from "near-api-js";
import { loadConfig, ROOT } from "../src/config.ts";
import { custodySignForRelay, RELAY_RECIPIENT } from "../src/custody.ts";
import { handoff } from "../src/handoff.ts";
import { executeTool } from "../src/service.ts";
import type { Job } from "../src/types.ts";

const [releasedId, refundedId] = process.argv.slice(2).map(Number);
const env = parseEnv(readFileSync(`${ROOT}.env`, "utf8"));
const config = loadConfig("buyer");
const provider = new JsonRpcProvider({ url: config.rpc });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const job = async (id: number) =>
  (await provider.callFunction({
    contractId: config.escrow,
    method: "get_job",
    args: { job_id: id },
  })) as unknown as Job;
const outcome = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return "RELEASED";
  } catch {
    return "refused";
  }
};
const buyerAuth = async (id: number) => {
  const message = `proven-collect:${id}:${Date.now()}`;
  const signed = await custodySignForRelay(
    config.custodyApi,
    config.custodyKey!,
    message,
  );
  return { ...signed, message };
};
const raw = (id: number, auth: unknown) =>
  handoff(config.socket, { action: "collect", job_id: id, auth });

const released = await job(releasedId);
const refunded = await job(refundedId);
if (released.state !== "Released" || refunded.state !== "Refunded")
  throw new Error(
    `Need Released and Refunded: ${released.state}, ${refunded.state}`,
  );

const results: Record<string, unknown> = {
  released_job: releasedId,
  refunded_job: refundedId,
};

// 1. The buyer collects through the tool, and the bytes match the hash on chain.
const collected = (await executeTool(
  "collect_delivery",
  { job_id: releasedId },
  { actor: "buyer" },
)) as { deliverable: string };
results.buyer_collects = {
  matches_chain_hash: sha(collected.deliverable) === released.deliverable_hash,
  bytes: collected.deliverable.length,
};

// 2. The same signature cannot be used twice.
const once = await buyerAuth(releasedId);
await raw(releasedId, once);
results.replayed_signature = await outcome(() => raw(releasedId, once));

// 3. Any other account: a valid signature by a key that is not the buyer's.
const stranger = generateKeyPairSync("ed25519");
const strangerRaw = stranger.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32);
let value = BigInt(`0x${strangerRaw.toString("hex")}`);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let encoded = "";
while (value > 0n) {
  encoded = alphabet[Number(value % 58n)] + encoded;
  value /= 58n;
}
const nonce = randomBytes(32);
const message = `proven-collect:${releasedId}:${Date.now()}`;
const borsh = (text: string) => {
  const bytes = Buffer.from(text);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const tag = Buffer.alloc(4);
tag.writeUInt32LE(2147484061);
const digest = createHash("sha256")
  .update(
    Buffer.concat([
      tag,
      borsh(message),
      nonce,
      borsh(RELAY_RECIPIENT),
      Buffer.from([0]),
    ]),
  )
  .digest();
results.other_account_with_valid_signature = await outcome(() =>
  raw(releasedId, {
    public_key: `ed25519:${encoded}`,
    message,
    nonce_base64: nonce.toString("base64"),
    signature_base64: sign(null, digest, stranger.privateKey).toString(
      "base64",
    ),
  }),
);

// 4. Another real wallet: its policy will not sign for the relay at all.
results.agent_wallet_signing = await outcome(() =>
  custodySignForRelay(
    config.custodyApi,
    env.PROVEN_AGENT_B_CUSTODY_KEY!,
    `proven-collect:${releasedId}:${Date.now()}`,
  ),
);

// 5. The buyer's own wallet cannot sign for a different recipient.
const elsewhere = await fetch(`${config.custodyApi}/wallet/v1/sign-message`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${config.custodyKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ message: "probe", recipient: "not-the-relay" }),
});
results.buyer_wallet_other_recipient_status = elsewhere.status;

// 6. The refunded job: refused to the buyer, through the tool and with a real signature.
results.refunded_through_tool = await outcome(() =>
  executeTool("collect_delivery", { job_id: refundedId }, { actor: "buyer" }),
);
results.refunded_with_real_signature = await outcome(async () =>
  raw(refundedId, await buyerAuth(refundedId)),
);

writeFileSync(
  `${ROOT}runs/collect-test.json`,
  `${JSON.stringify({ at: new Date().toISOString(), ...results }, null, 2)}\n`,
);
console.log(JSON.stringify(results, null, 2));
