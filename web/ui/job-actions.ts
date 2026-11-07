import type { MarketBid, Step } from "./market-steps.ts";
import { NEAR, TGAS, type Market, type Wallet } from "./market-types.ts";
import { api, remember, sha256, signed } from "./market-client.ts";

interface ActionContext {
  market: Market;
  wallet: Wallet | null;
  bid: MarketBid;
  clock: number;
  delivery: string;
  checkText: string;
  referenceText: string;
}
type SignedContext = Omit<ActionContext, "wallet"> & { wallet: Wallet };

function boardCall(
  context: SignedContext,
  method: string,
  args: Record<string, unknown>,
  deposit = 0n,
  gas = 150n * TGAS,
) {
  return context.wallet.call({
    receiver: context.market.board,
    method,
    args,
    deposit,
    gas,
  });
}

/** Escrow calls carry no deposit now: runs are paid from the job's budget, and payouts move held money. */
function escrowCall(
  context: SignedContext,
  method: string,
  args: Record<string, unknown>,
  gas = 100n * TGAS,
) {
  return context.wallet.call({
    receiver: context.market.escrow,
    method,
    args,
    deposit: 0n,
    gas,
  });
}

/** Sends the check and reference to the relay, which tests the check. Their hashes on chain prove they
 * are the buyer's, so no signature is needed. */
export async function sendCheck(
  jobId: number,
  check: string,
  reference: string,
): Promise<void> {
  if (!check || !reference)
    throw new Error("Paste the check and reference used for this bid.");
  await api("/api/market/relay", {
    action: "challenge",
    job_id: jobId,
    check,
    reference,
  });
}

/** Asks for the bid review. Anyone can; it costs the operator, not the caller. */
export async function requestReview(bidId: number): Promise<void> {
  await api(`/api/market/review/${bidId}`, {});
}

async function deliver(
  current: Extract<Step, { id: "deliver" }>,
  context: SignedContext,
) {
  const { wallet, delivery } = context;
  try {
    JSON.parse(delivery);
  } catch {
    throw new Error("Your delivery must be valid JSON. Nothing was submitted.");
  }
  const hash = await sha256(delivery);
  // Kept in this browser first, so the work can be handed over again if the second step fails.
  remember(hash, delivery);
  await escrowCall(
    context,
    "deliver",
    { job_id: current.jobId, deliverable_hash: hash },
    15n * TGAS,
  );
  try {
    await handOver(wallet, current.jobId, delivery);
  } catch {
    throw new Error(
      "Your work is recorded on the chain, but it did not reach the relay. Press “Send my work again” on this page.",
    );
  }
}

async function handOver(wallet: Wallet, jobId: number, delivery: string) {
  await api(
    "/api/market/relay",
    await signed(
      wallet,
      { action: "deliver", job_id: jobId, deliverable: delivery },
      jobId,
    ),
  );
}

/** Hands recorded work to the relay again. It must match the hash already on the chain. */
export async function resendDelivery(
  wallet: Wallet | null,
  jobId: number,
  delivery: string,
  expectedHash: string,
) {
  if (!wallet) throw new Error("Connect the worker's wallet first.");
  if ((await sha256(delivery)) !== expectedHash)
    throw new Error(
      "This is not the work recorded on the chain. Paste exactly what you delivered.",
    );
  await handOver(wallet, jobId, delivery);
}

/** Runs an explicitly selected action. Returned work remains untrusted display text. */
export async function performJobAction(
  current: Step,
  context: ActionContext,
): Promise<string | undefined> {
  if (current.id === "wait") return;
  // These two need no wallet.
  if (current.id === "review") {
    await requestReview(context.bid.id);
    return;
  }
  if (current.id === "send_check") {
    await sendCheck(current.jobId, context.checkText, context.referenceText);
    return;
  }
  const { wallet } = context;
  if (!wallet) throw new Error("Connect a wallet first.");
  const signedContext = { ...context, wallet };
  const { bid } = context;
  switch (current.id) {
    case "register":
      await boardCall(
        signedContext,
        "register_agent",
        {
          prompt_hash: await sha256(
            "A person or agent applying from the Proven market page.",
          ),
          knowledge_hash: await sha256(""),
          tools_hash: await sha256("[]"),
          model: "not-declared",
          owner: null,
        },
        (NEAR * 2n) / 100n,
        30n * TGAS,
      );
      return;
    case "claim":
      await boardCall(
        signedContext,
        "claim",
        { bid_id: bid.id },
        (NEAR * 5n) / 1000n,
        100n * TGAS,
      );
      return;
    case "sync":
      await boardCall(
        signedContext,
        "sync",
        { bid_id: bid.id },
        0n,
        200n * TGAS,
      );
      return;
    case "close":
      await boardCall(
        signedContext,
        "close_bid",
        { bid_id: bid.id },
        0n,
        150n * TGAS,
      );
      return;
    case "deliver":
      await deliver(current, signedContext);
      return;
    case "verify":
      await escrowCall(
        signedContext,
        "request_verification",
        { job_id: current.jobId },
        200n * TGAS,
      );
      return;
    case "settle":
      await escrowCall(signedContext, current.method, {
        job_id: current.jobId,
      });
      return;
    case "expire":
      await escrowCall(signedContext, "expire", { job_id: current.jobId });
      return;
    case "collect": {
      const reply = await api<{ deliverable: string }>(
        "/api/market/relay",
        await signed(
          wallet,
          { action: "collect", job_id: current.jobId },
          current.jobId,
        ),
      );
      return reply.deliverable;
    }
  }
}
