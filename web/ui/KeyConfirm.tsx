import { useState, type Dispatch } from "react";
import type { Wallet } from "./market-types.ts";
import {
  base64,
  ed25519Key,
  fromBase58,
  hex,
  keyProofNonce,
  nep413Hash,
  signatureBytes,
  vaultAddress,
  verifies,
  type KeyPair,
  type Signing,
} from "./bounty-keys.ts";
import {
  KEY_STATEMENTS,
  LEDGER_NOTE,
  SEPARATE_CONFIRMATION,
  TESTED_WALLETS,
  keyPair,
  type KeyAction,
  type KeyConfirmState,
} from "./key-confirm-state.ts";
import { randomNonce } from "./market-client.ts";

/** A key proof stays valid 50 minutes, inside the contract's one-hour limit (OD-8). */
export const PROOF_SECS = 50 * 60;

export const canSignProofs = (wallet: Partial<Wallet> | null) =>
  !!wallet && typeof wallet.signNep413 === "function";

const utc = (secs: number) =>
  new Date(secs * 1000)
    .toISOString()
    .replace(".000Z", " UTC")
    .replace("T", " ");

export interface KeyConfirmProps {
  wallet: Wallet;
  contract: string;
  vaultCodeHash: string;
  /** The key-proof text for one key, built from the confirmed keys, actor and expiry. */
  message: (
    keys: KeyPair,
    signing: Signing,
    actor: string,
    expiresAt: number,
  ) => string;
  state: KeyConfirmState;
  dispatch: Dispatch<KeyAction>;
  busy: boolean;
  role: "maintainer" | "contributor";
  /** Whether the form the proofs cover is complete. */
  canPrepare?: boolean;
  /** Called before new proofs are prepared, to fix what they cover (and check a fresh nonce). */
  onPrepare?: () => Promise<boolean> | boolean;
}

export function KeyConfirm(props: KeyConfirmProps) {
  const { wallet, contract, state, dispatch, busy, role } = props;
  const [backupInput, setBackupInput] = useState(state.backup ?? "");
  const [pasted, setPasted] = useState("");
  const [working, setWorking] = useState(false);
  const able = canSignProofs(wallet);
  const keys = keyPair(state);
  const prepared = keys && state.actor && state.expiresAt;
  const text = (signing: Signing) =>
    prepared
      ? props.message(
          keys,
          signing,
          state.actor as string,
          state.expiresAt as number,
        )
      : "";
  let vault = "";
  try {
    vault = keys ? vaultAddress(fromBase58(props.vaultCodeHash), keys) : "";
  } catch {
    vault = "";
  }
  async function discoverPrimary() {
    setWorking(true);
    try {
      const nonce = randomNonce();
      const message = `Proven PR bounty: show the public key of ${wallet.accountId} for ${contract}`;
      const reply = await wallet.signNep413(message, contract, nonce);
      const ok = (() => {
        try {
          return verifies(
            signatureBytes(reply.signature_base64),
            nep413Hash(message, nonce, contract),
            ed25519Key(reply.public_key),
          );
        } catch {
          return false;
        }
      })();
      if (ok) dispatch({ type: "primary", key: reply.public_key });
      else
        dispatch({
          type: "error",
          text: "The wallet's answer did not verify as an ed25519 signature by the key it named.",
        });
    } catch {
      dispatch({ type: "rejected", signing: "primary" });
    } finally {
      setWorking(false);
    }
  }
  async function signPrimary() {
    const message = text("primary");
    setWorking(true);
    try {
      const reply = await wallet.signNep413(
        message,
        contract,
        keyProofNonce(message),
      );
      dispatch({
        type: "signed",
        signing: "primary",
        publicKey: reply.public_key,
        signature: reply.signature_base64,
        message,
        contract,
      });
    } catch {
      dispatch({ type: "rejected", signing: "primary" });
    } finally {
      setWorking(false);
    }
  }
  const disabled = busy || working || !able;
  const backupMessage = text("backup");
  return (
    <div className="bounty-keys">
      <h4>Your vault keys ({role})</h4>
      <p>
        The {role === "maintainer" ? "refund and budget return" : "payout"} go
        to a vault that two keys control, not to an account name. Wallets that
        passed a key-proof signing test: {TESTED_WALLETS}. {LEDGER_NOTE}
      </p>
      {!able ? (
        <p role="alert">
          {wallet.label} cannot sign key proofs (it has no message signing), so
          posting and claiming stay disabled.
        </p>
      ) : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      <ol className="bounty-key-steps">
        <li>
          Primary key:{" "}
          {state.primary ? (
            <code>{state.primary}</code>
          ) : (
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled}
              onClick={() => void discoverPrimary()}
            >
              Use {wallet.label}'s key as the primary key
            </button>
          )}
        </li>
        <li>
          <label>
            Backup public key (ed25519:…), from a second wallet or key you hold
            separately. Paste only the public key, never a private key or seed
            phrase.
            <input
              value={backupInput}
              onChange={(e) => setBackupInput(e.target.value.trim())}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled || !backupInput}
            onClick={() => dispatch({ type: "backup", key: backupInput })}
          >
            Use this backup key
          </button>
        </li>
        <li>
          <button
            type="button"
            className="button button-secondary"
            disabled={disabled || !keys || props.canPrepare === false}
            onClick={() =>
              void (async () => {
                if (props.onPrepare && !(await props.onPrepare())) return;
                dispatch({
                  type: "start",
                  actor: wallet.accountId,
                  expiresAt: Math.floor(Date.now() / 1000) + PROOF_SECS,
                });
              })()
            }
          >
            {prepared ? "Prepare new proofs" : "Prepare the two key proofs"}
          </button>
        </li>
        {prepared ? (
          <>
            <li>
              Backup proof:{" "}
              {state.proofs.backup ? (
                "verified"
              ) : (
                <>
                  sign this text with the backup key as a NEP-413 message,
                  recipient <code>{contract}</code>, nonce{" "}
                  <code>{hex(keyProofNonce(backupMessage))}</code> (base64{" "}
                  <code>{base64(keyProofNonce(backupMessage))}</code>), then
                  paste the signature.
                  <pre className="bounty-challenge">{backupMessage}</pre>
                  <label>
                    Backup signature (base64, ed25519:… or hex)
                    <input
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value.trim())}
                      spellCheck={false}
                    />
                  </label>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={disabled || !pasted}
                    onClick={() =>
                      dispatch({
                        type: "signed",
                        signing: "backup",
                        publicKey: state.backup as string,
                        signature: pasted,
                        message: backupMessage,
                        contract,
                      })
                    }
                  >
                    Check the backup signature
                  </button>
                </>
              )}
            </li>
            <li>
              Primary proof:{" "}
              {state.proofs.primary ? (
                "verified"
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={disabled}
                  onClick={() => void signPrimary()}
                >
                  Sign the primary proof with {wallet.label}
                </button>
              )}
            </li>
          </>
        ) : null}
      </ol>
      {keys && state.proofs.primary && state.proofs.backup ? (
        <div className="bounty-key-summary">
          <dl className="workspace-review">
            <dt>Primary key</dt>
            <dd>
              <code>{keys.primary}</code>, proof valid until{" "}
              {utc(state.proofs.primary.expiresAt)}
            </dd>
            <dt>Backup key</dt>
            <dd>
              <code>{keys.backup}</code>, proof valid until{" "}
              {utc(state.proofs.backup.expiresAt)}
            </dd>
            <dt>Vault</dt>
            <dd>
              <code>{vault || "unavailable"}</code>
            </dd>
          </dl>
        </div>
      ) : null}
      <ul className="bounty-key-statements">
        {KEY_STATEMENTS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <label className="bounty-key-separate">
        <input
          type="checkbox"
          checked={state.separate}
          disabled={disabled}
          onChange={(e) =>
            dispatch({ type: "separate", value: e.target.checked })
          }
        />{" "}
        {SEPARATE_CONFIRMATION}
      </label>
    </div>
  );
}
