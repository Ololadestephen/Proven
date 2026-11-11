// The page's reads of the bounty contract through this server's read-only routes
// (src/bounties.ts), as a `BountyReader` for the journal and a `FlowChain` for the flows. A route
// that fails or answers something unexpected throws; nothing here turns a failed read into an
// empty answer. The fetcher is injected so tests need no network.
import { base64 } from "./bounty-keys.ts";
import type {
  ClaimRequest,
  FlowChain,
  PostingRequest,
} from "./bounty-actions.ts";
import type {
  BountyReader,
  BountyView,
  WalletLinkView,
} from "./bounty-reconcile.ts";
import type { VaultRead } from "./vault-view.ts";

export const BOUNTY_PATH = "/api/market/bounties";
export type Fetcher = <T>(path: string) => Promise<T>;

const part = (value: string | number) => encodeURIComponent(String(value));
/** base64url of UTF-8 JSON, which the posting routes take as one path part. */
export function base64Url(value: unknown): string {
  return base64(new TextEncoder().encode(JSON.stringify(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function text(reply: unknown, field: string): string {
  const value = (reply as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value === "")
    throw new Error(
      "The bounty contract returned an answer this page cannot use.",
    );
  return value;
}

export function bountyChain(get: Fetcher): BountyReader & FlowChain {
  return {
    async bounty(id) {
      const reply = await get<{ bounty: BountyView | null }>(
        `${BOUNTY_PATH}/bounty/${part(id)}`,
      );
      if (!("bounty" in reply))
        throw new Error("The bounty could not be read.");
      return reply.bounty;
    },
    async link(wallet) {
      const reply = await get<{ link: WalletLinkView | null }>(
        `${BOUNTY_PATH}/link/${part(wallet)}`,
      );
      if (!("link" in reply)) throw new Error("The link could not be read.");
      return reply.link;
    },
    async nonceUsed(maintainer, nonce) {
      const reply = await get<{ used: unknown }>(
        `${BOUNTY_PATH}/nonce/${part(maintainer)}/${part(nonce)}`,
      );
      if (typeof reply.used !== "boolean")
        throw new Error("The posting number could not be checked.");
      return reply.used;
    },
    async postedByNonce(maintainer, nonce) {
      const reply = await get<{ id: unknown }>(
        `${BOUNTY_PATH}/posted/${part(maintainer)}/${part(nonce)}`,
      );
      if (reply.id !== null && typeof reply.id !== "number")
        throw new Error("The posting could not be looked up.");
      return reply.id;
    },
    async vaultN(vault) {
      const reply = await get<VaultRead>(`${BOUNTY_PATH}/vault/${part(vault)}`);
      return reply.exists && reply.info ? reply.info.n : null;
    },
    async barred(id, wallet) {
      const reply = await get<{ barred: unknown }>(
        `${BOUNTY_PATH}/barred/${part(id)}/${part(wallet)}`,
      );
      if (typeof reply.barred !== "boolean")
        throw new Error("The claim record could not be read.");
      return reply.barred;
    },
    async nowSecs() {
      const reply = await get<{ block_secs: unknown }>(`${BOUNTY_PATH}/block`);
      if (!Number.isSafeInteger(reply.block_secs))
        throw new Error("The latest block could not be read.");
      return reply.block_secs as number;
    },
    async postingMessage(request: PostingRequest) {
      return text(
        await get(`${BOUNTY_PATH}/posting-message/${base64Url(request)}`),
        "message",
      );
    },
    async claimMessage(r: ClaimRequest) {
      const path = [r.bounty_id, r.wallet, r.github_id, r.key, r.expires_at]
        .map(part)
        .join("/");
      return text(await get(`${BOUNTY_PATH}/claim-message/${path}`), "message");
    },
    async linkChallenge(wallet, expiresAt) {
      return text(
        await get(
          `${BOUNTY_PATH}/link-challenge/${part(wallet)}/${part(expiresAt)}`,
        ),
        "challenge",
      );
    },
    async linkNumber(wallet) {
      const reply = await get<{ number: unknown }>(
        `${BOUNTY_PATH}/link-number/${part(wallet)}`,
      );
      const n = typeof reply.number === "string" ? Number(reply.number) : NaN;
      if (
        typeof reply.number !== "string" ||
        !/^[0-9]{1,15}$/.test(reply.number) ||
        !Number.isSafeInteger(n)
      )
        throw new Error("The wallet's link number could not be read.");
      return n;
    },
    vault: (vault) => get<VaultRead>(`${BOUNTY_PATH}/vault/${part(vault)}`),
    async accountExists(account) {
      const reply = await get<{ exists: unknown }>(
        `${BOUNTY_PATH}/account/${part(account)}`,
      );
      return typeof reply.exists === "boolean" ? reply.exists : null;
    },
  };
}
