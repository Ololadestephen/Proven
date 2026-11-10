import { useEffect, useState, type Dispatch } from "react";
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
  initialKeyState,
  keyPair,
  keyReducer,
  type KeyAction,
  type KeyConfirmState,
} from "./key-confirm-state.ts";
import { randomNonce } from "./market-client.ts";
import {
  addCandidate,
  backupProofsToSign,
  browserStore,
  listDrafts,
  loadCandidates,
  saveDraft,
  type BackupCandidate,
} from "./key-draft.ts";

/** A key proof stays valid 50 minutes, inside the contract's one-hour limit (OD-8). */
export const PROOF_SECS = 50 * 60;

export const canSignProofs = (wallet: Partial<Wallet> | null) =>
  !!wallet && typeof wallet.signNep413 === "function";

/**
 * Asks the connected wallet which key it signs with: it signs a fixed text naming the account and
 * the contract with a random nonce, and the answer must verify locally by the key it names.
 */
export async function discoverKey(
  wallet: Wallet,
  contract: string,
): Promise<string> {
  const nonce = randomNonce();
  const message = `Proven PR bounty: show the public key of ${wallet.accountId} for ${contract}`;
  const reply = await wallet.signNep413(message, contract, nonce);
  let ok = false;
  try {
    ok = verifies(
      signatureBytes(reply.signature_base64),
      nep413Hash(message, nonce, contract),
      ed25519Key(reply.public_key),
    );
  } catch {
    ok = false;
  }
  if (!ok)
    throw new Error(
      "The wallet's answer did not verify as an ed25519 signature by the key it named.",
    );
  return reply.public_key;
}

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
  /** Backup keys other accounts in this browser offered (public keys only). */
  candidates?: BackupCandidate[];
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
      dispatch({ type: "primary", key: await discoverKey(wallet, contract) });
    } catch (error) {
      dispatch({
        type: "error",
        text:
          error instanceof Error && error.message.includes("did not verify")
            ? error.message
            : "The primary key was not shown. Sign the request to continue.",
      });
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
          {(props.candidates ?? [])
            .filter((c) => c.account !== wallet.accountId)
            .map((c) => (
              <button
                key={c.account}
                type="button"
                className="button button-secondary"
                disabled={disabled}
                onClick={() => {
                  setBackupInput(c.key);
                  dispatch({ type: "backup", key: c.key });
                }}
              >
                Use the key {c.account} offered
              </button>
            ))}
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
                  connect the backup key's account in your browser wallet and
                  sign it from this page (your progress is kept in this
                  browser), or sign this text with the backup key as a NEP-413
                  message, recipient <code>{contract}</code>, nonce{" "}
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

/**
 * For the account that holds a backup key: offer this wallet's key as a backup key, and sign the
 * backup proofs another account prepared in this browser. Each signature is checked locally
 * against the key the draft names before it is kept.
 */
export function BackupSigner({
  wallet,
  contract,
  busy,
}: {
  wallet: Wallet;
  contract: string;
  busy: boolean;
}) {
  // Re-render on a timer and after each action, so drafts saved by other pages show up.
  const [, setVersion] = useState(0);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setVersion((v) => v + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  const store = browserStore();
  const now = Math.floor(Date.now() / 1000);
  const open = backupProofsToSign(
    listDrafts(store, contract, now),
    wallet.accountId,
  );
  const offered = loadCandidates(store, contract).find(
    (c) => c.account === wallet.accountId,
  );
  if (!canSignProofs(wallet)) return null;
  async function offer() {
    setWorking(true);
    try {
      const key = await discoverKey(wallet, contract);
      addCandidate(store, contract, { account: wallet.accountId, key });
      setNote(`Offered ${key} as a backup key in this browser.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Not offered.");
    } finally {
      setWorking(false);
      setVersion((v) => v + 1);
    }
  }
  async function sign(draft: (typeof open)[number]) {
    const message = draft.messages?.backup ?? "";
    setWorking(true);
    try {
      const reply = await wallet.signNep413(
        message,
        contract,
        keyProofNonce(message),
      );
      const next = keyReducer(
        { ...initialKeyState, ...draft.state },
        {
          type: "signed",
          signing: "backup",
          publicKey: reply.public_key,
          signature: reply.signature_base64,
          message,
          contract,
        },
      );
      if (next.proofs.backup) {
        saveDraft(store, { ...draft, state: next });
        setNote(
          `Backup proof signed. Reconnect ${draft.state.actor} to finish.`,
        );
      } else setNote(next.error ?? "The backup proof was refused.");
    } catch {
      setNote("The backup proof was not signed.");
    } finally {
      setWorking(false);
      setVersion((v) => v + 1);
    }
  }
  return (
    <section className="workspace-card bounty-backup-signer">
      <h3>Backup key signing, as {wallet.accountId}</h3>
      <p>
        If this account holds a backup key, offer its key here, then sign the
        backup proofs another account prepared in this browser. Only the public
        key and the signature are kept.
      </p>
      <button
        type="button"
        className="button button-secondary"
        disabled={busy || working}
        onClick={() => void offer()}
      >
        {offered
          ? `Offer ${wallet.label}'s key again`
          : `Offer ${wallet.label}'s key as a backup key`}
      </button>
      {open.map((d) => (
        <div key={d.scope} className="bounty-action">
          <p>
            Backup proof for the {d.role}{" "}
            {d.scope === "post" ? "posting" : d.scope.replace(":", " ")} by{" "}
            {d.state.actor}, backup key <code>{d.state.backup}</code>:
          </p>
          <pre className="bounty-challenge">{d.messages?.backup}</pre>
          <button
            type="button"
            className="button"
            disabled={busy || working}
            onClick={() => void sign(d)}
          >
            Sign this backup proof with {wallet.label}
          </button>
        </div>
      ))}
      {note ? <p role="status">{note}</p> : null}
    </section>
  );
}
