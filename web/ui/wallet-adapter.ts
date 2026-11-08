import type {
  NearWalletBase,
  NearConnectorOptions,
} from "@hot-labs/near-connect";
import { DefinitiveWalletFailure } from "./action-guard.ts";
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
      if (
        outcome &&
        outcome.status !== null &&
        typeof outcome.status === "object" &&
        "Failure" in outcome.status
      )
        throw new DefinitiveWalletFailure(
          "The transaction reported failure. Refresh the job and check wallet history before retrying.",
        );
      if (call.method === "post_bid")
        return postingReceipt(outcome, call.receiver, accountId);
      if (
        !outcome ||
        !outcome.status ||
        typeof outcome.status !== "object" ||
        !("SuccessValue" in outcome.status)
      )
        throw new Error(
          "The wallet did not confirm a successful transaction. Check the chain before retrying.",
        );
      return {
        transaction_hash: outcome.transaction?.hash ?? "",
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
      await checkAccount();
      const nonce = randomNonce();
      const result = await chosen.signMessage({
        network: NETWORK,
        signerId: accountId,
        message,
        recipient: RELAY_RECIPIENT,
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
      return {
        public_key: result.publicKey,
        signature_base64: result.signature,
        nonce_base64: b64(nonce),
      };
    },
  };
}
