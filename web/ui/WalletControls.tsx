import type { Wallet } from "./market-types.ts";
import { short } from "./market-client.ts";
export function WalletControls({
  wallet,
  connect,
  connecting,
  dev,
  useDev,
  onError,
  busy,
}: {
  wallet: Wallet | null;
  connect: () => Promise<void>;
  connecting: boolean;
  dev: Record<string, string>;
  useDev: (role: string) => void;
  onError: (message: string) => void;
  busy: boolean;
}) {
  return (
    <div className="market-wallet">
      {wallet ? (
        <details>
          <summary className="button button-secondary">
            {short(wallet.accountId)}
          </summary>
          <p>{wallet.label} · Testnet</p>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() =>
              void wallet.signOut().catch((reason) => onError(reason.message))
            }
          >
            Disconnect
          </button>
        </details>
      ) : (
        <>
          <button
            type="button"
            className="button button-secondary"
            disabled={connecting}
            onClick={() =>
              void connect().catch((reason) => onError(reason.message))
            }
          >
            {connecting ? "Opening wallets…" : "Connect wallet"}
          </button>
          {Object.keys(dev).map((role) => (
            <button
              key={role}
              type="button"
              className="button button-secondary"
              onClick={() => useDev(role)}
            >
              Dev {role}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
