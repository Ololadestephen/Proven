import type { MarketBid, Step } from "./market-steps.ts";
import { NEAR, TGAS, type Market, type Wallet } from "./market-types.ts";
import { api, sha256, signed } from "./market-client.ts";

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
type BoardStep = Extract<
  Step,
  { id: "register" | "claim" | "sync" | "link_job" | "settle_fee" | "close" }
>;
type RelayStep = Extract<Step, { id: "review" | "collect" }>;
type ComputeStep = Extract<Step, { id: "challenge" | "verify" }>;
type EscrowStep = Exclude<Step, BoardStep | RelayStep | { id: "wait" }>;

function boardCall(
  context: SignedContext,
  method: string,
  args: Record<string, unknown>,
  deposit = 0n,
  gas = 90n * TGAS,
) {
  return context.wallet.call({
    receiver: context.market.board,
    method,
    args,
    deposit,
    gas,
  });
}

function escrowCall(
  context: SignedContext,
  method: string,
  args: Record<string, unknown>,
  deposit = 0n,
  gas = 70n * TGAS,
) {
  return context.wallet.call({
    receiver: context.market.escrow,
    method,
    args,
    deposit,
    gas,
  });
}

async function boardAction(current: BoardStep, context: SignedContext) {
  const { bid } = context;
  switch (current.id) {
    case "register":
      await boardCall(
        context,
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
        context,
        "claim",
        { bid_id: bid.id },
        (NEAR * 5n) / 1000n,
        30n * TGAS,
      );
      return;
    case "sync":
      await boardCall(context, "sync", { bid_id: bid.id });
      return;
    case "link_job":
      // The attempt fee and its record. The board returns all of it if the job does not fit.
      await boardCall(
        context,
        "link_job",
        { bid_id: bid.id, job_id: current.jobId },
        (NEAR * 17n) / 1000n,
      );
      return;
    case "settle_fee":
      await boardCall(context, "settle_fee", { job_id: current.jobId });
      return;
    case "close":
      await boardCall(context, "close_bid", { bid_id: bid.id });
  }
}

async function relayAction(current: RelayStep, context: SignedContext) {
  const { wallet, bid } = context;
  if (current.id === "review") {
    await api(
      `/api/market/review/${bid.id}`,
      await signed(wallet, { action: "review" }, bid.id),
    );
    return;
  }
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

async function requestCompute(current: ComputeStep, context: SignedContext) {
  const { wallet, checkText, referenceText } = context;
  if (current.id === "challenge" && (!checkText || !referenceText))
    throw new Error("Paste the check and reference used for this bid.");
  const request =
    current.id === "challenge"
      ? {
          action: "challenge",
          job_id: current.jobId,
          check: checkText,
          reference: referenceText,
        }
      : { action: "pin_verification", job_id: current.jobId };
  await api("/api/market/relay", await signed(wallet, request, current.jobId));
  await escrowCall(
    context,
    current.id === "challenge" ? "request_challenge" : "request_verification",
    { job_id: current.jobId },
    NEAR / 10n,
    150n * TGAS,
  );
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
  await escrowCall(
    context,
    "deliver",
    { job_id: current.jobId, deliverable_hash: await sha256(delivery) },
    0n,
    15n * TGAS,
  );
  await api(
    "/api/market/relay",
    await signed(
      wallet,
      { action: "deliver", job_id: current.jobId, deliverable: delivery },
      current.jobId,
    ),
  );
}

async function escrowAction(current: EscrowStep, context: SignedContext) {
  const { bid, clock } = context;
  switch (current.id) {
    case "create_job":
      if (!bid.claim) throw new Error("The job has no worker claim to create.");
      await escrowCall(
        context,
        "create_job",
        {
          worker: bid.claim.agent,
          spec_hash: bid.check_hash,
          fakes_hash: bid.reference_hash,
          format_hash: bid.format_hash,
          amount: bid.amount,
          token: null,
          deadline: ((BigInt(clock) + 3_600_000n) * 1_000_000n).toString(),
          verdict_window_secs: 1800,
          verifier_hash: bid.verifier_hash,
        },
        (NEAR * 2n) / 100n,
      );
      return;
    case "challenge":
    case "verify":
      await requestCompute(current, context);
      return;
    case "fund":
      await escrowCall(
        context,
        "fund",
        { job_id: current.jobId },
        BigInt(bid.amount),
      );
      return;
    case "deliver":
      await deliver(current, context);
      return;
    case "settle":
      await escrowCall(context, current.method, { job_id: current.jobId });
      return;
    case "expire":
      await escrowCall(context, "expire", { job_id: current.jobId });
  }
}

/** Runs an explicitly selected action. Returned work remains untrusted display text. */
export async function performJobAction(
  current: Step,
  context: ActionContext,
): Promise<string | undefined> {
  if (current.id === "wait") return;
  const { wallet } = context;
  if (!wallet) throw new Error("Connect a wallet first.");
  const signedContext = { ...context, wallet };
  switch (current.id) {
    case "review":
    case "collect":
      return relayAction(current, signedContext);
    case "register":
    case "claim":
    case "sync":
    case "link_job":
    case "settle_fee":
    case "close":
      await boardAction(current, signedContext);
      return;
    default:
      await escrowAction(current, signedContext);
  }
}
