import { useRef, useState } from "react";
import type { Market, Wallet } from "./market-types.ts";
import { api, remember, sha256 } from "./market-client.ts";

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const STAGES = ["Brief & terms", "Acceptance check", "Review"];

import { parseNearAmount } from "./near-amount.ts";
interface Draft {
  description: string;
  check: string;
  reference: string;
  amount: string;
  windowMins: string;
  workers: string;
}
interface Prepared {
  check_hash: string;
  reference_hash: string;
  amount: bigint;
  claim_window_secs: number;
  allowed_workers: string[] | null;
}

function terms(draft: Draft) {
  if (
    !draft.description.trim() ||
    new TextEncoder().encode(draft.description).length > 2048
  )
    throw new Error("The public description must contain 1 to 2,048 bytes.");
  const amount = parseNearAmount(draft.amount);
  if (
    !/^\d+$/.test(draft.windowMins) ||
    Number(draft.windowMins) < 1 ||
    Number(draft.windowMins) > 1440
  )
    throw new Error(
      "The claim window must be a whole number from 1 to 1,440 minutes.",
    );
  const allowed = [...new Set(draft.workers.split(/[\s,]+/).filter(Boolean))];
  if (
    allowed.length > 20 ||
    allowed.some(
      (account) =>
        account.length < 2 ||
        account.length > 64 ||
        !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(account),
    )
  )
    throw new Error(
      "Enter up to 20 valid NEAR account IDs, separated by commas or spaces.",
    );
  return {
    amount,
    claim_window_secs: Number(draft.windowMins) * 60,
    allowed_workers: allowed.length ? allowed : null,
  };
}

export function PostJob({
  market,
  wallet,
  run,
  busy,
}: {
  market: Market;
  wallet: Wallet | null;
  run: (label: string, task: () => Promise<void>) => Promise<void>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<Draft>({
    description: "",
    check: "",
    reference: "",
    amount: "0.01",
    windowMins: "30",
    workers: "",
  });
  const [stage, setStage] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const samplePending = useRef(false);
  const locked = busy || preparing;
  const update = (key: keyof Draft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setPrepared(null);
    setError("");
  };

  async function useSample() {
    if (samplePending.current || locked) return;
    samplePending.current = true;
    setPreparing(true);
    setError("");
    try {
      const sample = await api<{
        description: string;
        check: string;
        reference: string;
      }>("/api/market/sample");
      setDraft((current) => ({ ...current, ...sample }));
      setPrepared(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The example could not be loaded.",
      );
    } finally {
      samplePending.current = false;
      setPreparing(false);
    }
  }

  async function next() {
    if (locked) return;
    setError("");
    setPreparing(true);
    try {
      const validated = terms(draft);
      if (stage === 1) {
        let check: { verifier?: unknown };
        try {
          check = JSON.parse(draft.check) as { verifier?: unknown };
          JSON.parse(draft.reference);
        } catch {
          throw new Error(
            "The acceptance check and reference answer must be valid JSON.",
          );
        }
        if (!check || check.verifier !== market.verifier_hash)
          throw new Error(
            "The check must name the verifier build this escrow runs.",
          );
        const [check_hash, reference_hash] = await Promise.all([
          sha256(draft.check),
          sha256(draft.reference),
        ]);
        setPrepared({ ...validated, check_hash, reference_hash });
      }
      setStage((current) => Math.min(current + 1, 2));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Check the job details.",
      );
    } finally {
      setPreparing(false);
    }
  }

  const post = () => {
    if (locked || !prepared) return;
    void run("Posting the bid", async () => {
      if (!wallet) throw new Error("Connect a wallet first.");
      if (market.paused)
        throw new Error("The Market is paused. No bid was posted.");
      remember(prepared.check_hash, draft.check);
      remember(prepared.reference_hash, draft.reference);
      await wallet.call({
        receiver: market.board,
        method: "post_bid",
        args: {
          description: draft.description,
          amount: prepared.amount.toString(),
          check_hash: prepared.check_hash,
          reference_hash: prepared.reference_hash,
          verifier_hash: market.verifier_hash,
          claim_window_secs: prepared.claim_window_secs,
          allowed_workers: prepared.allowed_workers,
        },
        deposit: (NEAR * 6n) / 100n,
        gas: 30n * TGAS,
      });
    });
  };

  return (
    <section
      className="market-card workspace-post"
      aria-labelledby="post-heading"
    >
      <div className="market-card-head">
        <h2 id="post-heading">Set the terms before work starts.</h2>
        {stage === 0 && (
          <button
            type="button"
            className="button button-secondary"
            disabled={locked}
            onClick={() => void useSample()}
          >
            Load example
          </button>
        )}
      </div>
      <ol className="workspace-tabs" aria-label="Posting steps">
        {STAGES.map((label, index) => (
          <li key={label} aria-current={index === stage ? "step" : undefined}>
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="market-error">
          {error}
        </p>
      )}
      <fieldset disabled={locked}>
        <legend className="sr-only">{STAGES[stage]}</legend>
        {stage === 0 && (
          <>
            <p className="market-note">
              Describe work a program can check. Your brief and payment terms
              will be public on testnet.
            </p>
            <label>
              Public brief
              <textarea
                rows={6}
                value={draft.description}
                maxLength={2048}
                onChange={(event) => update("description", event.target.value)}
              />
              <span className="market-note">
                Up to 2,048 bytes. Do not include private information.
              </span>
            </label>
            <div className="market-three">
              <label>
                Payment in NEAR
                <input
                  value={draft.amount}
                  onChange={(event) => update("amount", event.target.value)}
                  inputMode="decimal"
                />
                <span className="market-note">
                  Above 0, up to 0.1 testnet NEAR.
                </span>
              </label>
              <label>
                Claim window in minutes
                <input
                  value={draft.windowMins}
                  onChange={(event) => update("windowMins", event.target.value)}
                  inputMode="numeric"
                />
                <span className="market-note">
                  1–1,440 minutes for the worker’s claim.
                </span>
              </label>
              <label>
                Allowed workers (optional)
                <input
                  value={draft.workers}
                  onChange={(event) => update("workers", event.target.value)}
                  placeholder="Empty means anyone"
                />
                <span className="market-note">
                  NEAR account IDs, separated by commas.
                </span>
              </label>
            </div>
          </>
        )}
        {stage === 1 && (
          <>
            <p className="market-note">
              The check must reject the planted fakes before payment can be
              funded. These texts stay in this browser until you send them to
              the relay for the challenge. Save your own copies.
            </p>
            <div className="market-two">
              <label>
                Acceptance check (private JSON)
                <textarea
                  rows={12}
                  value={draft.check}
                  onChange={(event) => update("check", event.target.value)}
                  spellCheck={false}
                />
              </label>
              <label>
                Reference answer (private JSON)
                <textarea
                  rows={12}
                  value={draft.reference}
                  onChange={(event) => update("reference", event.target.value)}
                  spellCheck={false}
                />
              </label>
            </div>
          </>
        )}
        {stage === 2 && prepared && (
          <>
            <h3>{draft.description.split("\n")[0]}</h3>
            <details>
              <summary>Read the full public brief</summary>
              <pre className="market-pre">{draft.description}</pre>
            </details>
            <dl className="workspace-review">
              <dt>Payment</dt>
              <dd>{draft.amount} testnet NEAR, funded in a later step</dd>
              <dt>Claim window</dt>
              <dd>{draft.windowMins} minutes</dd>
              <dt>Workers</dt>
              <dd>
                {prepared.allowed_workers?.join(", ") ?? "Anyone may apply"}
              </dd>
              <dt>Posting deposit</dt>
              <dd>
                0.06 NEAR for storage; the unused part returns. Network gas is
                additional.
              </dd>
              <dt>Signing account</dt>
              <dd>{wallet?.accountId ?? "Connect a wallet to post"}</dd>
              <dt>Contract</dt>
              <dd>{market.board} · testnet</dd>
            </dl>
            <details>
              <summary>Acceptance check commitments</summary>
              <dl className="workspace-review">
                <dt>Check SHA-256</dt>
                <dd>
                  <code>{prepared.check_hash}</code>
                </dd>
                <dt>Reference SHA-256</dt>
                <dd>
                  <code>{prepared.reference_hash}</code>
                </dd>
                <dt>Verifier SHA-256</dt>
                <dd>
                  <code>{market.verifier_hash}</code>
                </dd>
              </dl>
            </details>
            <p className="market-note">
              Posting does not lock the payment. Challenge and verification each
              require a separate 0.1 NEAR compute deposit and gas. Unused
              compute deposit returns; execution failures can still incur costs.
              This Market is testnet only.
            </p>
          </>
        )}
      </fieldset>
      <div className="market-actions">
        {stage > 0 && (
          <button
            type="button"
            className="button button-secondary"
            disabled={locked}
            onClick={() => {
              setStage(stage - 1);
              setError("");
            }}
          >
            Back
          </button>
        )}
        {stage < 2 ? (
          <button
            type="button"
            className="button button-primary"
            disabled={locked}
            onClick={() => void next()}
          >
            {preparing
              ? "Checking…"
              : `Continue to ${STAGES[stage + 1]?.toLowerCase()}`}
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary"
            disabled={locked || !wallet || !prepared || market.paused}
            onClick={post}
          >
            {busy ? "Posting…" : "Post job · 0.06 NEAR deposit"}
          </button>
        )}
      </div>
      {market.paused && (
        <p className="market-note">New Market activity is paused.</p>
      )}
    </section>
  );
}
