// The opt-in dev signer behind --dev-wallet, kept apart from the market routes.
import { parseEnv } from "node:util";
import { Account, KeyPair, KeyPairSigner, actions } from "near-api-js";
import { nep413Digest } from "../../relay/src/buyer-auth.ts";
import { postedBidFromOutcome } from "../../shared/post-result.ts";
import { BOARD, MARKET_ESCROW, provider } from "./market.ts";
import { ReadError } from "./model.ts";

/** The dev signer: for testing this page without a wallet app. It needs the --dev-wallet flag, signs only
 * with two testnet keys on this machine, and can reach only the board and the escrow. */
export function createDevWallet({
  envText,
  outsider,
}: {
  /** The .env text, read once at startup; this flag is never used on a hosted server. */
  envText: string;
  /** The outsider worker's key file. */
  outsider: { account?: unknown; key?: unknown };
}) {
  const env = parseEnv(envText);
  if (!env.WORKER_HONEST_ACCOUNT_ID || !env.WORKER_HONEST_PRIVATE_KEY)
    throw new Error(
      "The dev signer needs WORKER_HONEST_ACCOUNT_ID and WORKER_HONEST_PRIVATE_KEY in .env.",
    );
  if (typeof outsider.account !== "string" || typeof outsider.key !== "string")
    throw new Error(
      "The dev signer needs the outsider worker's account and key.",
    );
  const accounts: Record<string, { id: string; key: string }> = {
    buyer: {
      id: env.WORKER_HONEST_ACCOUNT_ID,
      key: env.WORKER_HONEST_PRIVATE_KEY,
    },
    worker: { id: outsider.account, key: outsider.key },
  };
  for (const account of Object.values(accounts))
    if (!account.id.endsWith(".testnet") && !/^[a-f0-9]{64}$/.test(account.id))
      throw new Error("The dev signer is for testnet accounts only.");
  const signer = (as: string) => {
    const account = accounts[as];
    if (!account) throw new ReadError("No such dev account.", 400);
    return account;
  };
  return {
    list: () =>
      Object.fromEntries(
        Object.entries(accounts).map(([role, account]) => [role, account.id]),
      ),
    async call(body: {
      as: string;
      receiver: string;
      method: string;
      args: Record<string, unknown>;
      deposit: string;
      gas: string;
    }) {
      if (body.receiver !== BOARD && body.receiver !== MARKET_ESCROW)
        throw new ReadError(
          "The dev signer reaches only these contracts.",
          403,
        );
      const { id, key } = signer(body.as);
      const account = new Account(
        id,
        provider,
        new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
      );
      try {
        const outcome = await account.callFunctionRaw({
          contractId: body.receiver,
          methodName: body.method,
          args: body.args,
          deposit: body.deposit,
          gas: BigInt(body.gas),
        });
        let result: unknown = null;
        if (
          typeof outcome.status === "object" &&
          "SuccessValue" in outcome.status
        ) {
          try {
            result = JSON.parse(
              Buffer.from(outcome.status.SuccessValue, "base64").toString(
                "utf8",
              ),
            );
          } catch {
            // Non-JSON results cannot identify a posted bid. Preserve the transaction for reconciliation.
          }
        }
        const postedBid =
          body.method === "post_bid"
            ? postedBidFromOutcome(outcome, body.receiver, id)
            : null;
        return {
          transaction_hash: outcome.transaction.hash,
          result,
          ...(postedBid === null ? {} : { posted_bid_id: postedBid }),
        };
      } catch {
        throw new ReadError(
          "The transaction outcome is unknown. Reconcile wallet history and the chain before retrying.",
          502,
        );
      }
    },
    async transfer(body: { as: string; receiver: string; yocto: string }) {
      const { id, key } = signer(body.as);
      const account = new Account(
        id,
        provider,
        new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)),
      );
      try {
        const outcome = await account.signAndSendTransaction({
          receiverId: body.receiver,
          actions: [actions.transfer(BigInt(body.yocto))],
        });
        return { transaction_hash: outcome.transaction.hash };
      } catch {
        throw new ReadError(
          "The transaction outcome is unknown. Reconcile wallet history and the chain before retrying.",
          502,
        );
      }
    },
    sign(body: {
      as: string;
      message: string;
      nonce_base64: string;
      recipient: string;
    }) {
      const { key } = signer(body.as);
      const pair = KeyPair.fromString(key as `ed25519:${string}`);
      const digest = nep413Digest(
        body.message,
        Buffer.from(body.nonce_base64, "base64"),
        body.recipient,
      );
      return {
        public_key: pair.getPublicKey().toString(),
        signature_base64: Buffer.from(pair.sign(digest).signature).toString(
          "base64",
        ),
      };
    },
  };
}
