import type {
  NearWalletBase,
  NearConnectorOptions,
} from "@hot-labs/near-connect";
import {
  DefinitiveWalletFailure,
  IncompleteWalletOutcome,
} from "./action-guard.ts";
import type { Wallet } from "./market-types.ts";
import { IS_MAINNET, NETWORK } from "./network.ts";
import { b64, randomNonce, RELAY_RECIPIENT } from "./market-client.ts";
import { decodeCallResult, postingReceipt } from "./posting.ts";

export function connectorOptions(cspNonce: string): NearConnectorOptions {
  return {
    network: NETWORK,
    autoConnect: false,
    cspNonce,
    features: {
      ...(IS_MAINNET ? {} : { testnet: true }),
      signMessage: true,
      signAndSendTransaction: true,
      signInWithoutAddKey: true,
    },
  };
}
/** The selected account and network are explicit on every signing request. Connecting adds no access key. */
export function adaptWallet(
  chosen: NearWalletBase,
  accountId: string,
  signOut: () => Promise<void>,
): Wallet {
  if (
    (!IS_MAINNET && !chosen.manifest.features.testnet) ||
    !chosen.manifest.features.signMessage
  )
    throw new Error(
      "Choose a wallet that supports this network and message signing.",
    );
  async function checkAccount() {
    const accounts = await chosen.getAccounts({ network: NETWORK });
    if (!accounts.some((account) => account.accountId === accountId))
      throw new DefinitiveWalletFailure(
        "Your wallet account changed. Reconnect before continuing.",
      );
  }
  return {
    accountId,
    label: chosen.manifest.name,
    signOut,
    async call(call) {
      await checkAccount();
      const outcome = await chosen.signAndSendTransaction({
        network: NETWORK,
        signerId: accountId,
        receiverId: call.receiver,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: call.method,
              args: call.args,
              gas: call.gas.toString(),
              deposit: call.deposit.toString(),
            },
          },
        ],
      });
      // Keep the hash whatever the outcome, so the page can re-check the transaction itself.
      const hash = outcome?.transaction?.hash ?? null;
      if (
        outcome &&
        outcome.status !== null &&
        typeof outcome.status === "object" &&
        "Failure" in outcome.status
      )
        throw new DefinitiveWalletFailure(
          "The transaction reported failure. Refresh the job and check wallet history before retrying.",
          hash,
        );
      if (call.method === "post_bid")
        return postingReceipt(outcome, call.receiver, accountId);
      if (
        !outcome ||
        !outcome.status ||
        typeof outcome.status !== "object" ||
        !("SuccessValue" in outcome.status)
      )
        throw new IncompleteWalletOutcome(
          "The wallet did not confirm a successful transaction. Check the chain before retrying.",
          hash,
        );
      return {
        transaction_hash: hash ?? "",
        result: decodeCallResult(outcome.status.SuccessValue),
      };
    },
    async transfer(receiver, yocto) {
      await checkAccount();
      const outcome = await chosen.signAndSendTransaction({
        network: NETWORK,
        signerId: accountId,
        receiverId: receiver,
        actions: [{ type: "Transfer", params: { deposit: yocto.toString() } }],
      });
      const hash = outcome?.transaction?.hash;
      if (!hash)
        throw new Error(
          "The wallet did not confirm this payment. Check its history.",
        );
      return hash;
    },
    async signForRelay(message) {
      const nonce = randomNonce();
      return {
        ...(await signNep413(message, RELAY_RECIPIENT, nonce)),
        nonce_base64: b64(nonce),
      };
    },
    signNep413,
  };
  async function signNep413(
    message: string,
    recipient: string,
    nonce: Uint8Array,
  ) {
    await checkAccount();
    const result = await chosen.signMessage({
      network: NETWORK,
      signerId: accountId,
      message,
      recipient,
      nonce,
    });
    if (
      !result ||
      result.accountId !== accountId ||
      !result.publicKey ||
      !result.signature
    )
      throw new Error(
        "The wallet returned a signature for a different or missing account.",
      );
    return { public_key: result.publicKey, signature_base64: result.signature };
  }
}
