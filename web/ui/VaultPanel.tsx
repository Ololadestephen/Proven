import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./market-client.ts";
import { parseNearAmount } from "./near-amount.ts";
import { bountyChain } from "./bounty-chain.ts";
import {
  FlowError,
  SIGNING_OFF,
  withdrawFlow,
  type FlowChain,
} from "./bounty-actions.ts";
import type { BountyRun, BountyWallet } from "./bounty-wallet.ts";
import { WalletKeyError } from "./wallet-keys.ts";
import {
  latestWithdrawal,
  loadHistory,
  saveHistory,
  settlementDisplay,
  vaultNumbers,
  type SettlementView,
  type StoredWithdrawal,
  type VaultRead,
} from "./vault-view.ts";

const PATH = "/api/market/bounties";

/** What the page tells a person about their vault, in one place. */
export const VAULT_RULES =
  "Money stays in the vault until you withdraw it; nothing is forwarded. Only this vault's key can withdraw, and a lost key loses the money.";

/** A yoctoNEAR amount as an exact decimal NEAR string, for the amount field. */
export function nearDecimal(yocto: string): string {
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const storage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/** One settlement paid into this vault, with the name the page uses for it. */
export interface VaultEntry {
  label: string;
  settlement: SettlementView | null | undefined;
}

export interface VaultViewProps {
  vault: string;
  read: VaultRead | null;
  readFailed: boolean;
  entries: VaultEntry[];
  /** How many settlements on this page went into this vault. */
  shared: number;
  history: StoredWithdrawal[];
  near: (yocto: string | bigint) => string;
  now: number;
  partyDelaySecs: number;
  connected: boolean;
  approved: boolean;
  busy: boolean;
  to: string;
  amount: string;
  error: string;
  keyCheck: string;
  onTo: (value: string) => void;
  onAmount: (value: string) => void;
  onWithdraw: () => void;
  onRecheck: (entry: StoredWithdrawal) => void;
}

/** A vault as the person sees it. It holds no state of its own. */
export function VaultView(props: VaultViewProps) {
  const { read, history, near } = props;
  const numbers = vaultNumbers(props.readFailed ? null : read, (y) => near(y));
  const info = read?.exists ? read.info : null;
  const latest = latestWithdrawal(props.vault, history);
  const clock = { nowSecs: props.now, partyDelaySecs: props.partyDelaySecs };
  const credits = props.entries.length
    ? props.entries
    : [{ label: "", settlement: null }];
  // One wallet line for the vault: a withdrawal is not attributed to one of several settlements.
  const wallet = settlementDisplay(credits[0]?.settlement, latest, clock);
  return (
    <div className="bounty-vault">
      <h4>
        {info ? `Your vault: ${numbers.available} to withdraw` : "Your vault"}
      </h4>
      {credits.map((entry, i) => {
        const shown = settlementDisplay(entry.settlement, latest, clock);
        return (
          <p key={`${entry.label}-${i}`} className="vault-credit post-hint">
            <strong>Credit</strong>
            {entry.label ? ` (${entry.label})` : ""}: {shown.vaultCreditText}
          </p>
        );
      })}
      <p className="wallet-withdrawal post-hint">
        <strong>Withdrawal</strong>: {wallet.walletText}
        {props.shared > 1 ? " Shown for the whole vault." : ""}
      </p>
      {read && !read.exists ? (
        <p className="post-hint">
          Not created yet: its first deposit creates it.
        </p>
      ) : null}
      <details className="bounty-terms">
        <summary>Vault details</summary>
        <p className="post-hint">{VAULT_RULES}</p>
        <dl className="workspace-review">
          <dt>Vault</dt>
          <dd>
            <code>{props.vault}</code>
          </dd>
          <dt>Withdrawable</dt>
          <dd>{numbers.available}</dd>
          <dt>Storage fund (kept by the vault)</dt>
          <dd>{numbers.fund}</dd>
          <dt>Next withdrawal number</dt>
          <dd>{numbers.n}</dd>
        </dl>
      </details>
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
                  disabled={props.busy}
                  onClick={() => props.onRecheck(h)}
                >
                  Re-check
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {props.connected && info && BigInt(info.available) > 0n ? (
        <div className="bounty-action">
          <label>
            Destination account
            <input
              value={props.to}
              onChange={(e) => props.onTo(e.target.value.trim())}
              spellCheck={false}
            />
          </label>
          <label>
            Amount (NEAR)
            <input
              value={props.amount}
              onChange={(e) => props.onAmount(e.target.value)}
              inputMode="decimal"
            />
          </label>
          <button
            type="button"
            className="button button-primary"
            disabled={props.busy || !props.approved}
            onClick={props.onWithdraw}
          >
            Withdraw to {props.to || "an account"}
          </button>
          <p className="post-hint">
            Your wallet signs with the vault key, then sends it. You pay gas.
          </p>
          {!props.approved ? (
            <p className="workspace-empty signing-off" role="note">
              {SIGNING_OFF}
            </p>
          ) : null}
          {props.keyCheck ? <p role="status">{props.keyCheck}</p> : null}
          {props.error ? <p role="alert">{props.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The vault panel: reads the vault, keeps this browser's withdrawal history, and withdraws with
 * the connected wallet, signing with the message key through `withdrawFlow`.
 */
export function VaultPanel({
  vault,
  network,
  wallet,
  run,
  busy,
  approved,
  near,
  entries,
  shared,
  now,
  partyDelaySecs,
  chain,
}: {
  vault: string;
  network: string;
  wallet: BountyWallet | null;
  run: BountyRun;
  busy: boolean;
  /** False in this build: the withdraw button stays off. */
  approved: boolean;
  near: (yocto: string | bigint) => string;
  entries: VaultEntry[];
  shared: number;
  now: number;
  partyDelaySecs: number;
  chain?: Pick<FlowChain, "nowSecs" | "vault" | "accountExists">;
}) {
  const [read, setRead] = useState<VaultRead | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [history, setHistory] = useState<StoredWithdrawal[]>(() =>
    loadHistory(vault, storage()),
  );
  const [to, setTo] = useState(wallet?.accountId ?? "");
  const [amount, setAmount] = useState("");
  const prefilled = useRef(false);
  const [error, setError] = useState("");
  const [keyCheck, setKeyCheck] = useState("");
  const reads = useMemo(() => chain ?? bountyChain(api), [chain]);
  useEffect(() => {
    if (wallet && to === "") setTo(wallet.accountId);
  }, [wallet?.accountId]);
  useEffect(() => {
    setReadFailed(false);
    api<VaultRead>(`${PATH}/vault/${vault}`)
      .then((value) => {
        setRead(value);
        // Prefill the whole withdrawable amount once; the person can still edit it.
        const available = value?.exists ? value.info?.available : undefined;
        if (!prefilled.current && available && BigInt(available) > 0n) {
          prefilled.current = true;
          setAmount(nearDecimal(available));
        }
      })
      .catch(() => {
        setRead(null);
        setReadFailed(true);
      });
  }, [vault, version]);
  const keep = (next: StoredWithdrawal[]) => {
    setHistory(next);
    saveHistory(vault, next, storage());
  };

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

  const withdraw = () =>
    wallet
      ? run(
          "Withdrawing from the vault",
          {
            bountyId: null,
            call: { receiver: vault, method: "withdraw", args: {} },
          },
          async () => {
            setError("");
            let value: bigint;
            try {
              value = parseNearAmount(amount, null);
            } catch {
              setError("Enter an amount in NEAR.");
              return;
            }
            const earlier = history.findLast((h) => h.outcome === "pending");
            const box: { entry: StoredWithdrawal | null } = { entry: null };
            let result: Awaited<ReturnType<typeof withdrawFlow>>;
            try {
              result = await withdrawFlow({
                approved,
                network,
                wallet,
                chain: reads,
                vault,
                to,
                amount: value,
                earlier: earlier
                  ? {
                      n: BigInt(earlier.n),
                      deadline: earlier.deadline,
                      outcome: earlier.outcome,
                    }
                  : null,
                beforeSend: (w) => {
                  // Recorded before the wallet is asked, so a closed tab still blocks a second
                  // authorization.
                  const entry: StoredWithdrawal = {
                    hash: null,
                    sender: wallet.accountId,
                    vault,
                    to: w.to,
                    amount: w.amount.toString(),
                    n: w.n.toString(),
                    deadline: w.deadline,
                    outcome: "pending",
                  };
                  box.entry = entry;
                  keep([...history, entry]);
                },
              });
            } catch (reason) {
              if (
                reason instanceof FlowError ||
                reason instanceof WalletKeyError
              )
                setError(reason.message);
              else throw reason;
              return;
            }
            setKeyCheck(result.keyCheck.text);
            if (box.entry) {
              const entry: StoredWithdrawal = {
                ...box.entry,
                hash: result.hash,
              };
              keep([...history, entry]);
              if (entry.hash) await recheck(entry);
            }
            setVersion((v) => v + 1);
            if (result.error) throw result.error;
          },
        )
      : undefined;

  return (
    <VaultView
      vault={vault}
      read={read}
      readFailed={readFailed}
      entries={entries}
      shared={shared}
      history={history}
      near={near}
      now={now}
      partyDelaySecs={partyDelaySecs}
      connected={!!wallet}
      approved={approved}
      busy={busy}
      to={to}
      amount={amount}
      error={error}
      keyCheck={keyCheck}
      onTo={setTo}
      onAmount={setAmount}
      onWithdraw={() => void withdraw()}
      onRecheck={(entry) =>
        void recheck(entry).catch((reason: Error) => setError(reason.message))
      }
    />
  );
}
