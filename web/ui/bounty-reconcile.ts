// Decides from chain state, never from a wallet's answer, whether a journaled bounty call took
// effect. A wallet can throw after its transaction landed, and a transaction can land without the
// wallet ever saying so; the only safe recovery is to read the contract again and compare with
// what it showed before the call. These are pure functions over views the page already reads:
// `readBountySnapshot` takes an injected reader, and `bountyReconciled` compares two snapshots.
// Nothing here signs or sends.

/** The parts of the bounty contract's `Bounty` view this module compares. */
export interface BountyView {
  buyer?: string;
  status: string;
  posting_nonce?: string;
  claim: { wallet: string; key: string; claimed_at: string } | null;
  binding: { pr_number: number; wallet: string } | null;
  live: { seq: string; kind: string; pr_number: number } | null;
  last_check: { seq: string; kind: string; outcome: string } | null;
  payout: SettlementProgress | null;
  refund: SettlementProgress | null;
}
/** The parts of a settlement that move when a send or a reconcile took effect. */
export interface SettlementProgress {
  state: string;
  attempt: number;
  outcome: string;
  reconcile: { attempt: number; started_at: string } | null;
  done_by: string | null;
}
export interface LinkRecord {
  gist_id: string;
  github_id: string;
}
/** The contract's `get_link`: the active link and a change waiting for its delay. */
export interface WalletLinkView {
  active: LinkRecord | null;
  pending: { link: LinkRecord; activates_at: string } | null;
}

/** Everything a call may change, as read from the chain. Fields a method does not need are null. */
export interface BountySnapshot {
  bounty: BountyView | null;
  link: WalletLinkView | null;
  /** `is_nonce_used` for a posting's nonce. */
  nonceUsed: boolean | null;
  /** The id of a bounty this maintainer posted with this nonce, if one exists. */
  postedId: number | null;
  /** The vault's withdrawal number (`info`), as decimal text. */
  vaultN: string | null;
  /** `is_barred`: a claim by this wallet on this bounty has ended. */
  barred: boolean | null;
}

/** How the page reads the chain. Each function throws when the read fails; a failure is never an empty answer. */
export interface BountyReader {
  bounty(id: number): Promise<BountyView | null>;
  link(wallet: string): Promise<WalletLinkView | null>;
  nonceUsed(maintainer: string, nonce: string): Promise<boolean>;
  postedByNonce(maintainer: string, nonce: string): Promise<number | null>;
  vaultN(vault: string): Promise<string | null>;
  barred(id: number, wallet: string): Promise<boolean>;
}

/** What a journaled call was, enough to decide what to read and what its effect is. */
export interface BountyIntent {
  /** The connected account that signs. */
  account: string;
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  bountyId: number | null;
}

export const BOUNTY_METHODS = [
  "post_bounty",
  "cancel",
  "link",
  "activate_link",
  "confirm_link_change",
  "cancel_link_change",
  "claim",
  "release_claim",
  "revoke_claim",
  "expire_claim",
  "submit_pr",
  "check_merge",
  "settle",
  "send_due",
  "recover_settlement",
  "reconcile",
  "withdraw",
] as const;
export type BountyMethod = (typeof BOUNTY_METHODS)[number];
export const isBountyMethod = (method: string): method is BountyMethod =>
  (BOUNTY_METHODS as readonly string[]).includes(method);

const empty = (): BountySnapshot => ({
  bounty: null,
  link: null,
  nonceUsed: null,
  postedId: null,
  vaultN: null,
  barred: null,
});
const text = (v: unknown) => (typeof v === "string" ? v : "");
const nonceOf = (args: Record<string, unknown>) => {
  const proof = args.proof;
  return typeof proof === "object" && proof !== null
    ? text((proof as Record<string, unknown>).nonce)
    : "";
};
/** The wallet whose link a link method changes. */
const linkWalletOf = (i: BountyIntent) =>
  i.method === "link" ? i.account : text(i.args.wallet);

/** Reads exactly what this call can change. Throws when a read fails, so no action starts on a guess. */
export async function readBountySnapshot(
  reader: BountyReader,
  intent: BountyIntent,
): Promise<BountySnapshot> {
  const out = empty();
  const { method } = intent;
  if (!isBountyMethod(method))
    throw new Error(`Unknown bounty action: ${method}.`);
  if (method === "post_bounty") {
    const nonce = nonceOf(intent.args);
    if (!nonce) throw new Error("A posting needs its proof nonce.");
    [out.nonceUsed, out.postedId] = await Promise.all([
      reader.nonceUsed(intent.account, nonce),
      reader.postedByNonce(intent.account, nonce),
    ]);
    return out;
  }
  if (method === "withdraw") {
    out.vaultN = await reader.vaultN(intent.receiver);
    return out;
  }
  if (
    method === "link" ||
    method === "activate_link" ||
    method === "confirm_link_change" ||
    method === "cancel_link_change"
  ) {
    const wallet = linkWalletOf(intent);
    if (!wallet) throw new Error("A link change needs its wallet.");
    out.link = await reader.link(wallet);
    return out;
  }
  if (intent.bountyId === null)
    throw new Error("This action needs a bounty number.");
  out.bounty = await reader.bounty(intent.bountyId);
  if (method === "claim")
    out.barred = await reader.barred(intent.bountyId, intent.account);
  return out;
}

/** The text a journal keeps as "before", and the guard compares a fresh read against. */
export const bountySnapshotText = (s: BountySnapshot) =>
  JSON.stringify([
    s.bounty,
    s.link,
    s.nonceUsed,
    s.postedId,
    s.vaultN,
    s.barred,
  ]);
export function parseBountySnapshot(value: string): BountySnapshot | null {
  try {
    const v = JSON.parse(value);
    if (!Array.isArray(v) || v.length !== 6) return null;
    const [bounty, link, nonceUsed, postedId, vaultN, barred] = v;
    return { bounty, link, nonceUsed, postedId, vaultN, barred };
  } catch {
    return null;
  }
}

const progress = (s: SettlementProgress | null) =>
  s === null
    ? null
    : JSON.stringify([s.state, s.attempt, s.outcome, s.reconcile, s.done_by]);
const sameLink = (a: LinkRecord | null | undefined, b: LinkRecord | null) =>
  !!a && !!b && a.gist_id === b.gist_id;

/** Whether the call took effect, going only by the two snapshots. False means "no effect seen". */
export function bountyReconciled(
  intent: BountyIntent,
  before: BountySnapshot,
  now: BountySnapshot,
): boolean {
  const { method, args, account } = intent;
  const b = before.bounty;
  const n = now.bounty;
  switch (method) {
    case "post_bounty":
      return (
        before.nonceUsed !== true &&
        before.postedId === null &&
        (now.nonceUsed === true || now.postedId !== null)
      );
    case "cancel":
      return !!b && !!n && b.status === "Open" && n.status === "Cancelled";
    case "link": {
      const gist = text(args.gist_id);
      if (!gist) return false;
      const seen = (s: BountySnapshot) =>
        s.link?.active?.gist_id === gist ||
        s.link?.pending?.link.gist_id === gist;
      return !seen(before) && seen(now);
    }
    case "activate_link":
    case "confirm_link_change": {
      const waiting = before.link?.pending?.link;
      return (
        !!waiting &&
        now.link?.pending === null &&
        sameLink(now.link.active, waiting)
      );
    }
    case "cancel_link_change": {
      const waiting = before.link?.pending;
      return (
        !!waiting &&
        now.link?.pending === null &&
        !sameLink(now.link.active, waiting.link)
      );
    }
    case "claim": {
      if (now.barred === true && before.barred !== true) return true;
      const claim = n?.claim;
      return (
        !!claim &&
        claim.wallet === account &&
        claim.key === text(args.key) &&
        claim.claimed_at !== b?.claim?.claimed_at
      );
    }
    case "release_claim":
    case "revoke_claim":
    case "expire_claim": {
      const had = b?.claim;
      return (
        !!had &&
        !!n &&
        n.status === "Open" &&
        (n.claim === null ||
          n.claim.wallet !== had.wallet ||
          n.claim.claimed_at !== had.claimed_at)
      );
    }
    case "submit_pr": {
      if (!n) return false;
      const pr = Number(args.pr_number);
      if (n.binding && !b?.binding)
        return n.binding.wallet === account && n.binding.pr_number === pr;
      const run = n.live;
      if (run && run.kind === "Submit" && run.pr_number === pr)
        return run.seq !== b?.live?.seq && run.seq !== b?.last_check?.seq;
      return (
        !!n.last_check &&
        n.last_check.kind === "submit" &&
        n.last_check.seq !== b?.last_check?.seq
      );
    }
    case "check_merge": {
      if (!n) return false;
      const run = n.live;
      if (run && run.kind === "Merge")
        return run.seq !== b?.live?.seq && run.seq !== b?.last_check?.seq;
      return (
        (!!n.last_check && n.last_check.seq !== b?.last_check?.seq) ||
        (!!b && n.status !== b.status)
      );
    }
    case "settle":
      return (
        !!b &&
        !!n &&
        (n.status !== b.status || (b.refund === null && n.refund !== null))
      );
    case "send_due":
    case "recover_settlement":
    case "reconcile": {
      if (!b || !n) return false;
      const kinds =
        method === "send_due"
          ? (["payout", "refund"] as const)
          : args.kind === "Payout"
            ? (["payout"] as const)
            : args.kind === "Refund"
              ? (["refund"] as const)
              : [];
      return kinds.some((k) => progress(b[k]) !== progress(n[k]));
    }
    case "withdraw": {
      const [was, is] = [before.vaultN, now.vaultN];
      if (was === null || is === null) return false;
      if (!/^[0-9]{1,20}$/.test(was) || !/^[0-9]{1,20}$/.test(is)) return false;
      return BigInt(is) > BigInt(was);
    }
    default:
      return false;
  }
}
