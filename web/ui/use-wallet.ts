import { NearConnector, type EventMap } from "@hot-labs/near-connect";
import { useEffect, useState } from "react";
import { api, randomNonce, b64, RELAY_RECIPIENT } from "./market-client.ts";
import type { Wallet, Call, WalletCallResult } from "./market-types.ts";
import { adaptWallet, connectorOptions } from "./wallet-adapter.ts";
let connector: NearConnector | undefined;
function getConnector() {
  if (!connector) {
    const nonce = document.querySelector<HTMLMetaElement>(
      'meta[name="wallet-csp-nonce"]',
    )?.content;
    if (!nonce)
      throw new Error(
        "Wallet security configuration is missing. Reload this page.",
      );
    connector = new NearConnector(connectorOptions(nonce));
  }
  return connector;
}
export function useWallet() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [dev, setDev] = useState<Record<string, string>>({});
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    let live = true;
    const client = getConnector();
    const out = () => {
      if (live) setWallet(null);
    };
    const adopt = (event: EventMap["wallet:signIn"]) => {
      if (!live || !event.success || !event.accounts[0]) return;
      try {
        setWallet(
          adaptWallet(event.wallet, event.accounts[0].accountId, () =>
            client.disconnect(event.wallet),
          ),
        );
      } catch {
        out();
      }
    };
    client.on("wallet:signIn", adopt);
    client.on("wallet:signOut", out);
    // Resume only the account; no transaction or sign-in is initiated on page load.
    void client
      .getConnectedWallet()
      .then(({ wallet, accounts }) =>
        adopt({ wallet, accounts, success: true, source: "signIn" }),
      )
      .catch(() => undefined);
    void api<Record<string, string>>("/api/market/dev")
      .then((value) => {
        if (live) setDev(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      client.off("wallet:signIn", adopt);
      client.off("wallet:signOut", out);
    };
  }, []);
  async function connect() {
    if (connecting) return;
    setConnecting(true);
    try {
      await getConnector().connect();
    } finally {
      setConnecting(false);
    }
  }
  function useDev(role: string) {
    const accountId = dev[role];
    if (!accountId) return;
    setWallet({
      accountId,
      label: `Dev signer: ${role}`,
      signOut: async () => setWallet(null),
      call: async (call: Call) => {
        return await api<WalletCallResult>("/api/market/dev/call", {
          as: role,
          ...call,
          deposit: call.deposit.toString(),
          gas: call.gas.toString(),
        });
      },
      transfer: async (receiver, yocto) =>
        (
          await api<{ transaction_hash: string }>("/api/market/dev/transfer", {
            as: role,
            receiver,
            yocto: yocto.toString(),
          })
        ).transaction_hash,
      signForRelay: async (message) => {
        const nonce_base64 = b64(randomNonce());
        return {
          ...(await api<{ public_key: string; signature_base64: string }>(
            "/api/market/dev/sign",
            { as: role, message, nonce_base64, recipient: RELAY_RECIPIENT },
          )),
          nonce_base64,
        };
      },
    });
  }
  return { wallet, connect, connecting, dev, useDev };
}
