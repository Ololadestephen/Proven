import { useEffect, useState } from "react";
import type { Run, Wallet } from "./market-types.ts";
import { api } from "./market-client.ts";
import { parseNearAmount } from "./near-amount.ts";
import {
  base64,
  ed25519Key,
  hex,
  signatureBytes,
  verifies,
} from "./bounty-keys.ts";
import {
  checkWithdrawal,
  chooseDeadline,
  cliCommand,
  mayAuthorizeAgain,
  sendWithdrawal,
  withdrawArgs,
  withdrawHash,
  withdrawMessage,
  withdrawNonce,
  type Refusal,
  type Withdrawal,
} from "./vault-client.ts";
import {
  loadHistory,
  saveHistory,
  vaultNumbers,
  type StoredWithdrawal,
  type VaultRead,
} from "./vault-view.ts";

const PATH = "/api/market/bounties";
export const BROWSER_WITHDRAWAL_SUPPORT =
  "Browser wallet withdrawal: pending. No real testnet wallet has completed a withdrawal through this page yet; the NEAR CLI command below does the same call.";

const REFUSAL_TEXT: Record<Refusal, string> = {
  bad_destination: "The destination is not a valid NEAR account id.",
  destination_is_vault: "The destination cannot be the vault itself.",
  destination_missing: "That named account does not exist on this network.",
  zero_amount: "Enter an amount above zero.",
  above_balance: "That is more than the vault can pay.",
  deadline_passed: "This authorization's deadline has passed. Sign a new one.",
  deadline_too_far: "The deadline is too far ahead.",
};

const storage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

interface Signed {
  w: Withdrawal;
  signature: Uint8Array;
}

export function VaultPanel({
  vault,
  network,
  wallet,
  run,
  busy,
  near,
  shared,
}: {
  vault: string;
  network: string;
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
  near: (yocto: string | bigint) => string;
  /** How many settlements on this page went into this vault. */
  shared: number;
}) {
  const [read, setRead] = useState<VaultRead | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [history, setHistory] = useState<StoredWithdrawal[]>(() =>
    loadHistory(vault, storage()),
  );
  const [to, setTo] = useState(wallet?.accountId ?? "");
  const [amount, setAmount] = useState("");
  const [pasted, setPasted] = useState("");
  const [draft, setDraft] = useState<Withdrawal | null>(null);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setReadFailed(false);
    api<VaultRead>(`${PATH}/vault/${vault}`)
      .then(setRead)
      .catch(() => {
        setRead(null);
        setReadFailed(true);
      });
  }, [vault, version]);
  const numbers = vaultNumbers(readFailed ? null : read, (y) => near(y));
  const info = read?.exists ? read.info : null;
  const keep = (next: StoredWithdrawal[]) => {
    setHistory(next);
    saveHistory(vault, next, storage());
  };
  const pending = history.findLast((h) => h.outcome === "pending") ?? null;

  async function blockSecs() {
    return (await api<{ block_secs: number }>(`${PATH}/block`)).block_secs;
  }
  /** Reads the vault and the destination now, and builds the authorization to sign. */
  async function prepare() {
    setError("");
    setSigned(null);
    if (!info) return setError("The vault could not be read.");
    const now = await blockSecs();
    if (
      !mayAuthorizeAgain(
        pending && {
          n: BigInt(pending.n),
          deadline: pending.deadline,
          outcome: pending.outcome,
        },
        BigInt(info.n),
        now,
      )
    )
      return setError(
        "An earlier withdrawal is still pending. Re-check it, or wait for its deadline, before signing a new one.",
      );
    let value: bigint;
    try {
      value = parseNearAmount(amount, BigInt(info.available));
    } catch {
      return setError("Enter an amount in NEAR, at most what the vault holds.");
    }
    const fresh = await api<VaultRead>(`${PATH}/vault/${vault}`);
    if (!fresh.info) return setError("The vault could not be read.");
    let exists: boolean | null = null;
    try {
      exists = (await api<{ exists: boolean }>(`${PATH}/account/${to}`)).exists;
    } catch {
      exists = null;
    }
    const w: Withdrawal = {
      chain: network,
      vault,
      to,
      amount: value,
      n: BigInt(fresh.info.n),
      deadline: chooseDeadline(now),
    };
    const refusal = checkWithdrawal(
      w,
      BigInt(fresh.info.available),
      exists,
      now,
    );
    if (refusal) return setError(REFUSAL_TEXT[refusal]);
    setDraft(w);
  }
  function accept(w: Withdrawal, publicKey: string, signature: string) {
    if (!info) return;
    if (publicKey !== info.primary && publicKey !== info.backup)
      return setError("That key is neither of this vault's keys.");
    let sig: Uint8Array;
    try {
      sig = signatureBytes(signature);
    } catch {
      return setError("The signature is malformed.");
    }
    if (!verifies(sig, withdrawHash(w), ed25519Key(publicKey)))
      return setError("The signature does not match this withdrawal.");
    setSigned({ w, signature: sig });
    setError("");
  }
  const signWithWallet = (w: Withdrawal) =>
    run("Signing the withdrawal", async () => {
      if (!wallet) return;
      const reply = await wallet.signNep413(
        withdrawMessage(w),
        vault,
        withdrawNonce(w.n),
      );
      accept(w, reply.public_key, reply.signature_base64);
    });
  const submit = (s: Signed) =>
    run("Withdrawing from the vault", async () => {
      if (!wallet) return;
      if (s.w.deadline <= (await blockSecs())) {
        setSigned(null);
        setDraft(null);
        return setError(REFUSAL_TEXT.deadline_passed);
      }
      const entry: StoredWithdrawal = {
        hash: null,
        sender: wallet.accountId,
        vault,
        to: s.w.to,
        amount: s.w.amount.toString(),
        n: s.w.n.toString(),
        deadline: s.w.deadline,
        outcome: "pending",
      };
      // Recorded before the wallet is asked, so a closed tab still blocks a second authorization.
      const before = [...history, entry];
      keep(before);
      setSigned(null);
      setDraft(null);
      const sent = await sendWithdrawal(wallet, s.w, s.signature);
      const recorded = { ...entry, hash: sent.hash };
      keep([...history, recorded]);
      setVersion((v) => v + 1);
      if (recorded.hash) await recheck(recorded);
      if (sent.error) throw sent.error;
    });
  async function recheck(entry: StoredWithdrawal) {
    if (!entry.hash) {
      setVersion((v) => v + 1);
      return;
    }
    const route = [
      entry.hash,
      entry.sender,
      entry.vault,
      entry.to,
      entry.amount,
      entry.n,
    ].join("/");
    const reply = await api<{ outcome: { kind: StoredWithdrawal["outcome"] } }>(
      `${PATH}/withdrawal/${route}`,
    );
    const next = loadHistory(vault, storage()).map((h) =>
      h.hash === entry.hash ? { ...h, outcome: reply.outcome.kind } : h,
    );
    keep(next);
    setVersion((v) => v + 1);
  }
  const args = signed ? withdrawArgs(signed.w, signed.signature) : "";
  return (
    <div className="bounty-vault">
      <h4>
        Vault <code>{vault}</code>
      </h4>
      <dl className="workspace-review">
        <dt>Withdrawable</dt>
        <dd>{numbers.available}</dd>
        <dt>Storage fund (kept by the vault)</dt>
        <dd>{numbers.fund}</dd>
        <dt>Next withdrawal number</dt>
        <dd>{numbers.n}</dd>
      </dl>
      {read && !read.exists ? (
        <p>
          This vault does not exist yet; it is created by its first deposit.
        </p>
      ) : null}
      {shared > 1 ? (
        <p>
          This vault holds {shared} settlements on this page. Withdrawals are
          shown for the vault as a whole, not per settlement.
        </p>
      ) : null}
      <p>{BROWSER_WITHDRAWAL_SUPPORT}</p>
      {history.length ? (
        <ul className="bounty-withdrawals">
          {history.map((h, i) => (
            <li key={`${h.n}-${i}`}>
              Withdrawal {h.n}: {near(h.amount)} to {h.to},{" "}
              {h.outcome === "delivered"
                ? "delivered"
                : h.outcome === "returned"
                  ? `the transfer failed and the amount returned to the vault; number ${h.n} is used, sign a new withdrawal`
                  : h.outcome === "refused"
                    ? "refused by the vault; nothing moved"
                    : "pending: not delivered and not returned until a finalized receipt shows which"}
              {h.hash ? ` (transaction ${h.hash})` : ""}
              {h.outcome === "pending" && h.hash ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void run("Re-checking", () => recheck(h))}
                >
                  Re-check
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {wallet && info ? (
        <div className="bounty-action">
          <label>
            Destination account
            <input
              value={to}
              onChange={(e) => setTo(e.target.value.trim())}
              spellCheck={false}
            />
          </label>
          <label>
            Amount (NEAR)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => void run("Preparing the withdrawal", prepare)}
          >
            Prepare a withdrawal
          </button>
          {error ? <p role="alert">{error}</p> : null}
          {draft && !signed ? (
            <>
              <p>
                Sign with either vault key. With the connected wallet, or with
                the other key as a NEP-413 message: recipient{" "}
                <code>{vault}</code>, nonce{" "}
                <code>{hex(withdrawNonce(draft.n))}</code> (base64{" "}
                <code>{base64(withdrawNonce(draft.n))}</code>), text:
              </p>
              <pre className="bounty-challenge">{withdrawMessage(draft)}</pre>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void signWithWallet(draft)}
              >
                Sign with {wallet.label}
              </button>
              <label>
                Or paste the other key's signature
                <input
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value.trim())}
                />
              </label>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || !pasted || !info}
                onClick={() =>
                  accept(
                    draft,
                    signatureKeyGuess(pasted, draft, info.primary, info.backup),
                    pasted,
                  )
                }
              >
                Check the pasted signature
              </button>
            </>
          ) : null}
          {signed ? (
            <>
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => void submit(signed)}
              >
                Withdraw {near(signed.w.amount)} to {signed.w.to} (you pay the
                gas)
              </button>
              <p>
                Or run the same call with the NEAR CLI, from any account that
                pays the gas:
              </p>
              <pre className="bounty-challenge">
                {cliCommand(signed.w, args, "<your-account>")}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A pasted signature names no key; try both vault keys and keep the one that verifies. */
function signatureKeyGuess(
  sig: string,
  w: Withdrawal,
  primary: string,
  backup: string,
): string {
  try {
    const bytes = signatureBytes(sig);
    if (verifies(bytes, withdrawHash(w), ed25519Key(primary))) return primary;
  } catch {
    return backup;
  }
  return backup;
}
