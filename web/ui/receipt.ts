import { showNear, type MarketBid, type MarketJob } from "./market-steps.ts";
import { sha256 } from "./market-client.ts";

export type ReceiptNetwork = "mainnet" | "testnet";

export function displayWork(text: string): { isJson: boolean; pretty: string } {
  try {
    return { isJson: true, pretty: JSON.stringify(JSON.parse(text), null, 2) };
  } catch {
    return { isJson: false, pretty: text };
  }
}

/** Hash the original UTF-8 text, never the pretty-printed copy. Missing commitments fail closed. */
export async function matchesDelivery(
  text: string,
  expectedHash: string | null,
): Promise<boolean> {
  return expectedHash !== null && (await sha256(text)) === expectedHash;
}

export function escrowJobId(bid: MarketBid, job: MarketJob): number | null {
  return job.id ?? bid.job_id ?? null;
}

export function deliveryFilename(
  bid: MarketBid,
  job: MarketJob,
  text: string,
): string {
  const id = escrowJobId(bid, job);
  if (id === null) throw new Error("The escrow job ID is not recorded.");
  return `bid-${bid.id}-job-${id}-delivery.${displayWork(text).isJson ? "json" : "txt"}`;
}

function backtickFence(text: string, minimum: number): string {
  let longest = minimum;
  for (const run of text.matchAll(/`+/g))
    longest = Math.max(longest, run[0].length);
  return "`".repeat(longest + 1);
}

/** Variable delimiters keep chain-supplied rule names from changing the Markdown structure. */
function inline(value: string | number | null | undefined): string {
  const text = String(value ?? "Not recorded")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  const fence = backtickFence(text, 0);
  return `${fence} ${text} ${fence}`;
}

function result(job: MarketJob): string {
  const last = job.history?.at(-1);
  if (job.state === "Released") return "Paid";
  if (job.state === "Refunded") return "Refunded";
  if (job.state === "Failed")
    return `Failed with rule ${inline(job.failed_rule ?? (last?.outcome === "Failed" ? last.failed_rule : null))}`;
  if (job.state === "Passed") return "Passed; payment is not recorded as paid";
  return `No final payment result recorded (job state: ${inline(job.state)})`;
}

/** Pure formatter. The caller supplies the local creation date and verified original text.
 * The optional timestamp keeps four-argument use deterministic; it never invents chain time. */
export function buildReceipt(
  bid: MarketBid,
  job: MarketJob,
  collectedText: string,
  network: ReceiptNetwork,
  madeAt = "Not supplied",
): string {
  const last = job.history?.at(-1);
  const api =
    network === "mainnet"
      ? "https://api.outlayer.ai"
      : "https://testnet-api.outlayer.ai";
  const verdictId = job.verdict_request_id ?? last?.verdict_request_id;
  const work = displayWork(collectedText);
  // Even non-JSON text containing closing fences must remain inside the work block.
  const fence = backtickFence(work.pretty, 2);
  const lines = [
    `Network: ${network}${network === "mainnet" ? ". The owner holds a single key that can upgrade the contracts" : ""}`,
    `Bid ID: ${inline(bid.id)}`,
    `Escrow job ID: ${inline(escrowJobId(bid, job))}`,
    `Buyer: ${inline(job.buyer)}`,
    `Worker: ${inline(job.worker ?? last?.worker)}`,
    `Amount: ${showNear(job.amount)}`,
    `Result: ${result(job)}`,
  ];
  if (job.state !== "Failed" && last?.outcome === "Failed") {
    lines.push(
      `Last completed attempt: Failed with rule ${inline(last.failed_rule)}`,
    );
  }
  if (
    job.state === "Refunded" &&
    job.failed_rule &&
    last?.outcome !== "Failed"
  ) {
    lines.push(`Recorded failure: Failed with rule ${inline(job.failed_rule)}`);
  }
  if (job.challenge_request_id)
    lines.push(
      `Challenge attestation: ${api}/attestations/by-request/${encodeURIComponent(job.challenge_request_id)}`,
    );
  if (verdictId)
    lines.push(
      `${job.verdict_request_id ? "Verdict attestation" : "Last completed attempt verdict attestation"}: ${api}/attestations/by-request/${encodeURIComponent(verdictId)}`,
    );
  lines.push(
    `Check hash: ${inline(bid.check_hash)}`,
    `Reference hash: ${inline(bid.reference_hash)}`,
    `Format hash: ${inline(bid.format_hash)}`,
    `Deliverable hash: ${inline(job.deliverable_hash)}`,
    `Receipt made (local UTC, not chain time): ${inline(madeAt)}`,
  );
  return [
    "# Proven job receipt",
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "## Delivered work",
    "",
    `${fence}${work.isJson ? "json" : "text"}`,
    work.pretty,
    fence,
    "",
    `The downloaded .${work.isJson ? "json" : "txt"} file, not this ${work.isJson ? "pretty " : "receipt "}copy, is the exact text the fingerprint proves.`,
    "",
  ].join("\n");
}
