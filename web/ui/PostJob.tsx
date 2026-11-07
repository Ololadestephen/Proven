import { canPost, COIN, NETWORK } from "./network.ts";
import { useRef, useState, type ChangeEvent } from "react";
import type { Market, Wallet } from "./market-types.ts";
import { api, remember, sha256 } from "./market-client.ts";

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const STAGES = ["The job", "The check", "Review"];

import { parseNearAmount } from "./near-amount.ts";
interface Draft {
  description: string;
  check: string;
  reference: string;
  amount: string;
  windowMins: string;
  workers: string;
  days: string;
  revealAgreed: boolean;
}
interface Prepared {
  check_hash: string;
  reference_hash: string;
  amount: bigint;
  claim_window_secs: number;
  allowed_workers: string[] | null;
  format: string;
  expires_at: string;
}

function terms(draft: Draft) {
  if (
    !draft.description.trim() ||
    new TextEncoder().encode(draft.description).length > 2048
  )
    throw new Error("The public description must contain 1 to 2,048 bytes.");
  const amount = parseNearAmount(draft.amount);
  if (!/^[1-7]$/.test(draft.days))
    throw new Error("A bid must end within 1 to 7 days.");
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

const DAYS = ["1", "3", "7"];
const WINDOWS = [
  ["15", "15 min"],
  ["30", "30 min"],
  ["60", "1 hour"],
  ["240", "4 hours"],
];
const jsonState = (text: string) => {
  if (!text.trim()) return "empty";
  try {
    JSON.parse(text);
    return "valid";
  } catch {
    return "invalid";
  }
};

function JsonField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const state = jsonState(value);
  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onChange(await file.text());
    event.target.value = "";
  };
  return (
    <div className="post-field">
      <div className="post-field-head">
        <label htmlFor={`field-${label}`}>{label}</label>
        <label className="post-file">
          Load file
          <input type="file" accept=".json,application/json" onChange={load} />
        </label>
      </div>
      <textarea
        id={`field-${label}`}
        rows={11}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      <span className={`post-hint post-json-${state}`}>
        {state === "valid"
          ? "Valid JSON"
          : state === "invalid"
            ? "This is not valid JSON yet"
            : hint}
      </span>
    </div>
  );
}

function Choices({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="post-choices" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option!)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Shown in place of the form, so a posted job cannot be posted twice. */
function PostSuccess({
  market,
  checkHash,
  title,
  onAnother,
}: {
  market: Market;
  checkHash: string;
  title: string;
  onAnother: () => void;
}) {
  const bid = market.bids.find((item) => item.check_hash === checkHash);
  return (
    <section className="market-card post-success" role="status">
      <span className={bid ? "post-tick" : "post-spinner"} aria-hidden="true" />
      <h2>{bid ? "Your job is posted" : "Confirming on the board…"}</h2>
      <p className="post-success-title">{title}</p>
      {bid ? (
        <>
          <ol className="post-next">
            <li>
              <strong>Run the bid review.</strong> Workers can apply once it
              passes. It costs you nothing.
            </li>
            <li>
              <strong>Wait for a worker to apply.</strong> Nothing is locked
              until you fund the job.
            </li>
            <li>
              <strong>Test your check, then fund.</strong> Your payment is held
              until the verifier decides.
            </li>
          </ol>
          <div className="market-actions">
            <a className="button button-primary" href={`/app/bids/${bid.id}`}>
              Open job and run the review
            </a>
            <button
              type="button"
              className="button button-secondary"
              onClick={onAnother}
            >
              Post another
            </button>
          </div>
        </>
      ) : (
        <p className="market-note">
          Your wallet accepted it. This usually takes a few seconds, and there
          is nothing more to press.
        </p>
      )}
    </section>
  );
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
    days: "3",
    revealAgreed: false,
    workers: "",
  });
  const [stage, setStage] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [limited, setLimited] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const samplePending = useRef(false);
  const locked = busy || preparing;
  const update = (key: keyof Draft, value: string | boolean) => {
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
      setLoaded(true);
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
      if (limited && !validated.allowed_workers)
        throw new Error("List at least one account, or choose Anyone.");
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
        const format = (check as { format?: unknown }).format;
        if (typeof format !== "string" || !format)
          throw new Error(
            "The check must carry its public format, the fields a delivery must have.",
          );
        if (!draft.revealAgreed)
          throw new Error(
            "Agree that the relay publishes your check when this bid closes.",
          );
        const expires_at = (
          (BigInt(Date.now()) + BigInt(draft.days) * 86_400_000n) *
          1_000_000n
        ).toString();
        setPrepared({
          ...validated,
          check_hash,
          reference_hash,
          format,
          expires_at,
        });
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
          format: prepared.format,
          expires_at: prepared.expires_at,
          reveal_agreed: true,
          claim_window_secs: prepared.claim_window_secs,
          allowed_workers: prepared.allowed_workers,
        },
        deposit: (NEAR * 8n) / 100n,
        gas: 30n * TGAS,
      });
      setPosted(prepared.check_hash);
    });
  };

  const alreadyPosted =
    prepared &&
    market.bids.find((bid) => bid.check_hash === prepared.check_hash);
  const bytes = new TextEncoder().encode(draft.description).length;

  if (posted)
    return (
      <PostSuccess
        market={market}
        checkHash={posted}
        title={draft.description.split("\n")[0] ?? ""}
        onAnother={() => location.assign("/app/post")}
      />
    );

  return (
    <section className="market-card workspace-post" aria-label="Post a job">
      <div className="post-top">
        <ol className="post-steps" aria-label="Posting steps">
          {STAGES.map((label, index) => (
            <li
              key={label}
              aria-current={index === stage ? "step" : undefined}
              data-done={index < stage}
            >
              <button
                type="button"
                disabled={index >= stage || locked}
                onClick={() => {
                  setStage(index);
                  setError("");
                }}
              >
                <span className="post-step-dot">
                  {index < stage ? "✓" : index + 1}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>
        {stage === 0 && (
          <button
            type="button"
            className="post-link"
            disabled={locked}
            onClick={() => void useSample()}
          >
            {loaded ? "Example loaded" : "Use an example"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="market-error">
          {error}
        </p>
      )}
      {canPost(wallet?.accountId) ? null : (
        <p role="alert" className="market-error">
          {wallet
            ? "Only listed buyers can post for now, so posting is off for this account."
            : "Connect a listed buyer’s wallet to post."}
        </p>
      )}
      <fieldset disabled={locked}>
        <legend className="sr-only">{STAGES[stage]}</legend>
        {stage === 0 && (
          <>
            <div className="post-field">
              <label htmlFor="post-brief">What needs doing?</label>
              <textarea
                id="post-brief"
                rows={7}
                value={draft.description}
                maxLength={2048}
                placeholder="Describe work a program can check. This is public."
                onChange={(event) => update("description", event.target.value)}
              />
              <span className="post-hint post-hint-split">
                <span>Public. Leave out anything private.</span>
                <span>{bytes} / 2,048</span>
              </span>
            </div>
            <div className="post-grid">
              <div className="post-field">
                <label htmlFor="post-amount">Payment</label>
                <div className="post-unit">
                  <input
                    id="post-amount"
                    value={draft.amount}
                    onChange={(event) => update("amount", event.target.value)}
                    inputMode="decimal"
                  />
                  <span>{COIN}</span>
                </div>
                <span className="post-hint">Up to 0.1 NEAR.</span>
              </div>
              <div className="post-field">
                <span className="post-label">Bid stays open for</span>
                <Choices
                  label="Bid stays open for"
                  value={draft.days}
                  options={DAYS.map((day) => [
                    day,
                    day === "1" ? "1 day" : `${day} days`,
                  ])}
                  onChange={(value) => update("days", value)}
                />
              </div>
              <div className="post-field">
                <span className="post-label">Time to claim and fund</span>
                <Choices
                  label="Time to claim and fund"
                  value={draft.windowMins}
                  options={WINDOWS}
                  onChange={(value) => update("windowMins", value)}
                />
              </div>
              <div className="post-field">
                <span className="post-label">Who can apply</span>
                <Choices
                  label="Who can apply"
                  value={limited ? "listed" : "anyone"}
                  options={[
                    ["anyone", "Anyone"],
                    ["listed", "Only these accounts"],
                  ]}
                  onChange={(value) => {
                    setLimited(value === "listed");
                    if (value === "anyone") update("workers", "");
                  }}
                />
                {limited ? (
                  <input
                    aria-label="Allowed worker accounts"
                    value={draft.workers}
                    onChange={(event) => update("workers", event.target.value)}
                    placeholder="alice.near, bob.near"
                  />
                ) : null}
              </div>
            </div>
          </>
        )}
        {stage === 1 && (
          <>
            <p className="post-lead">
              The check decides payment, and it must catch the planted fakes
              before you can fund. Both texts stay in this browser until the
              challenge sends them to the relay, so keep your own copies.
            </p>
            <div className="market-two">
              <JsonField
                label="Acceptance check"
                hint="Paste the check as JSON."
                value={draft.check}
                onChange={(value) => update("check", value)}
              />
              <JsonField
                label="Reference answer"
                hint="A correct answer, as JSON. It stays private."
                value={draft.reference}
                onChange={(value) => update("reference", value)}
              />
            </div>
            <label className="post-consent">
              <input
                type="checkbox"
                checked={draft.revealAgreed}
                onChange={(event) =>
                  update("revealAgreed", event.target.checked)
                }
              />
              <span>
                <strong>Publish my check when this bid closes.</strong> Anyone
                can compare it with its hash, and workers can see what they were
                judged by. The reference stays private.
              </span>
            </label>
          </>
        )}
        {stage === 2 && prepared && (
          <>
            <div className="post-summary">
              <div>
                <span className="post-label">You will pay on success</span>
                <strong className="post-amount">
                  {draft.amount} {COIN}
                </strong>
                <span className="post-hint">Not locked until you fund.</span>
              </div>
              <h3>{draft.description.split("\n")[0]}</h3>
            </div>
            <dl className="workspace-review">
              <dt>Who can apply</dt>
              <dd>{prepared.allowed_workers?.join(", ") ?? "Anyone"}</dd>
              <dt>Time to claim and fund</dt>
              <dd>{draft.windowMins} minutes</dd>
              <dt>Bid stays open for</dt>
              <dd>
                {draft.days === "1" ? "1 day" : `${draft.days} days`}, then your
                check is published
              </dd>
              <dt>Signing as</dt>
              <dd>{wallet?.accountId ?? "Connect a wallet to post"}</dd>
            </dl>
            <div className="post-costs">
              <h3>What it costs</h3>
              <dl>
                <dt>Now: posting deposit</dt>
                <dd>0.08 NEAR, unused part returns</dd>
                <dt>Each attempt: fee and record</dt>
                <dd>0.017 NEAR</dd>
                <dt>Each challenge and verification</dt>
                <dd>0.1 NEAR, mostly refunded</dd>
              </dl>
              <p className="post-hint">
                Network gas is extra. The worker keeps the 0.015 NEAR fee if
                well-formed work fails a rule. A pass, no delivery or no verdict
                returns it to you.
              </p>
            </div>
            <div className="post-risks">
              <h3>Before you post</h3>
              <ul>
                <li>
                  A worker who never delivers uses up one of your 3 funded
                  attempts. Your money comes back at the deadline, but is locked
                  until then.
                </li>
                <li>
                  On an open bid, junk that fits the format can take the fee, up
                  to 0.045 NEAR per bid.
                </li>
                <li>Listing allowed workers avoids both.</li>
                <li>
                  A failed run can still cost some of its compute deposit.
                </li>
              </ul>
            </div>
            <details className="post-technical">
              <summary>Technical details</summary>
              <dl className="workspace-review">
                <dt>Full brief</dt>
                <dd>
                  <pre className="market-pre">{draft.description}</pre>
                </dd>
                <dt>Public format</dt>
                <dd>
                  <code>{prepared.format}</code>
                </dd>
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
                <dt>Contract</dt>
                <dd>
                  {market.board} · {NETWORK}
                </dd>
              </dl>
            </details>
            {alreadyPosted ? (
              <p className="market-notice" role="status">
                This check is already on the board.{" "}
                <a href={`/app/bids/${alreadyPosted.id}`}>Open that job</a>
              </p>
            ) : null}
          </>
        )}
      </fieldset>
      <div className="market-actions post-actions">
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
            {preparing ? "Checking…" : "Continue"}
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary"
            disabled={
              locked ||
              !wallet ||
              !prepared ||
              market.paused ||
              !!alreadyPosted ||
              !canPost(wallet.accountId)
            }
            onClick={post}
          >
            {busy ? "Waiting for your wallet…" : "Post job · 0.08 NEAR deposit"}
          </button>
        )}
      </div>
      {market.paused && (
        <p className="market-note">New Market activity is paused.</p>
      )}
    </section>
  );
}
