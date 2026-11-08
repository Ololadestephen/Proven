import { canPost, COIN, MAX_JOB, NETWORK } from "./network.ts";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { requestReview, sendCheck } from "./job-actions.ts";
import type { Market, Wallet, WalletCallResult } from "./market-types.ts";
import { api, remember, sha256 } from "./market-client.ts";

import {
  resolvePostedBid,
  postedBidId,
  startPostingFollowup,
} from "./posting.ts";
import type { MarketBid } from "./market-steps.ts";

const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const STAGES = ["The job", "The check", "Review"];

import { parseNearAmount } from "./near-amount.ts";
interface Draft {
  description: string;
  check: string;
  reference: string;
  amount: string;
  deliverHours: string;
  attempts: string;
  workers: string;
  days: string;
  revealAgreed: boolean;
}
interface Prepared {
  check_hash: string;
  reference_hash: string;
  amount: bigint;
  deliver_secs: number;
  max_attempts: number;
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
  const amount = parseNearAmount(draft.amount, MAX_JOB);
  if (!/^[1-7]$/.test(draft.days))
    throw new Error("A bid must end within 1 to 7 days.");
  if (!["1", "4", "12", "24"].includes(draft.deliverHours))
    throw new Error("Choose how long a worker has to deliver.");
  if (!["1", "2", "3"].includes(draft.attempts))
    throw new Error("Choose 1 to 3 attempts.");
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
    deliver_secs: Number(draft.deliverHours) * 3_600,
    max_attempts: Number(draft.attempts),
    allowed_workers: allowed.length ? allowed : null,
  };
}

const DAYS = ["1", "3", "7"];
const HOURS = [
  ["1", "1 hour"],
  ["4", "4 hours"],
  ["12", "12 hours"],
  ["24", "1 day"],
];
const ATTEMPTS = [
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
];
/** Storage for the bid and the escrow job, at their largest. What is not used comes back. */
const STORAGE_MARGIN = (NEAR * 7n) / 100n;
const FEE_PER_ATTEMPT = (NEAR * 17n) / 1000n;
const POST_RESERVE = NEAR / 100n;

/** Everything a posting attaches, by part. */
export function postingCost(
  amount: bigint,
  attempts: number,
  runDeposit: bigint,
) {
  const budget = runDeposit * BigInt(2 + 2 * attempts);
  const fees = FEE_PER_ATTEMPT * BigInt(attempts);
  const storage = STORAGE_MARGIN + POST_RESERVE;
  return {
    amount,
    budget,
    fees,
    storage,
    total: amount + budget + fees + storage,
  };
}
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

/** Shown in place of the form, so a posted job cannot be posted twice. It sends the check for testing
 * and starts the review straight away; neither needs a signature. */
function PostSuccess({
  market,
  posted,
  title,
  check,
  reference,
  onAnother,
}: {
  market: Market;
  posted: {
    receipt: WalletCallResult | void;
    buyer: string;
    check_hash: string;
    reference_hash: string;
    verifier_hash: string;
  };
  title: string;
  check: string;
  reference: string;
  onAnother: () => void;
}) {
  const [bid, setBid] = useState<MarketBid | null>(null);
  const [resolving, setResolving] = useState(true);
  const lookup = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    let live = true;
    setResolving(true);
    void resolvePostedBid({
      bids: market.bids,
      receipt: posted.receipt,
      expected: posted,
      board: market.board,
      readOutcome: (hash, buyer) => {
        lookup.current ??= api("/api/market/posting", { hash, buyer }).catch(
          () => null,
        );
        return lookup.current;
      },
    }).then((found) => {
      if (live) {
        setBid(found);
        setResolving(false);
      }
    });
    return () => {
      live = false;
    };
  }, [market.bids, market.board, posted]);
  const exactId = postedBidId(posted.receipt?.posted_bid_id);
  const jobId = bid?.job_id ?? null;
  const [sent, setSent] = useState<"" | "sending" | "done" | string>("");
  const [reviewed, setReviewed] = useState<"" | "asking" | "done" | string>("");
  const started = useRef(false);
  useEffect(() => {
    const followup = startPostingFollowup(
      started,
      bid,
      (id) => sendCheck(id, check, reference),
      requestReview,
    );
    if (!followup) return;
    setSent("sending");
    void followup.check
      .then(() => setSent("done"))
      .catch((error: Error) => setSent(error.message));
    setReviewed("asking");
    void followup.review
      .then(() => setReviewed("done"))
      .catch((error: Error) => setReviewed(error.message));
  }, [bid, jobId, check, reference]);
  const line = (value: string, doing: string, done: string) =>
    value === "done"
      ? `✓ ${done}`
      : value === "" || value === doing
        ? "…"
        : `Not yet: ${value}`;
  return (
    <section className="market-card post-success" role="status">
      <span className={bid ? "post-tick" : "post-spinner"} aria-hidden="true" />
      <h2>{bid ? "Your job is posted" : "Confirming on the board…"}</h2>
      <p className="post-success-title">{title}</p>
      {bid ? (
        <>
          <ol className="post-next">
            <li>
              <strong>Payment held.</strong>{" "}
              {jobId === null ? "…" : "✓ The escrow is holding it."}
            </li>
            <li>
              <strong>Check sent for testing.</strong>{" "}
              {line(sent, "sending", "It is tested against planted fakes.")}
            </li>
            <li>
              <strong>Bid review.</strong>{" "}
              {line(reviewed, "asking", "Workers can now see it.")}
            </li>
          </ol>
          <p className="market-note">
            There is nothing more to sign. If a step says “Not yet”, the job
            page lets you try it again.
          </p>
          <div className="market-actions">
            <a className="button button-primary" href={`/app/bids/${bid.id}`}>
              Open the job
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
          {resolving
            ? "Finding your bid on the chain…"
            : exactId === null
              ? "The posting result needs reconciliation. Check the transaction in wallet history before doing anything else. Do not post again."
              : `Waiting for confirmed bid ${exactId} to appear on the board. Do not post again.`}
          {posted.receipt?.transaction_hash
            ? ` Transaction: ${posted.receipt.transaction_hash}`
            : ""}
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
    deliverHours: "4",
    attempts: "3",
    days: "3",
    revealAgreed: false,
    workers: "",
  });
  const [stage, setStage] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [limited, setLimited] = useState(false);
  const [posted, setPosted] = useState<{
    receipt: WalletCallResult | void;
    buyer: string;
    check_hash: string;
    reference_hash: string;
    verifier_hash: string;
  } | null>(null);
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
      const receipt = await wallet.call({
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
          deliver_secs: prepared.deliver_secs,
          max_attempts: prepared.max_attempts,
          allowed_workers: prepared.allowed_workers,
        },
        deposit: cost!.total,
        gas: 150n * TGAS,
      });
      setPosted({
        receipt,
        buyer: wallet.accountId,
        check_hash: prepared.check_hash,
        reference_hash: prepared.reference_hash,
        verifier_hash: market.verifier_hash,
      });
    });
  };

  const cost = prepared
    ? postingCost(
        prepared.amount,
        prepared.max_attempts,
        BigInt(market.run_deposit ?? "10000000000000000000000"),
      )
    : null;
  const nearText = (value: bigint) =>
    `${(Number(value / 10n ** 18n) / 1e6).toString()} NEAR`;
  const alreadyPosted =
    prepared &&
    market.bids.find((bid) => bid.check_hash === prepared.check_hash);
  const bytes = new TextEncoder().encode(draft.description).length;

  if (posted)
    return (
      <PostSuccess
        market={market}
        posted={posted}
        title={draft.description.split("\n")[0] ?? ""}
        check={draft.check}
        reference={draft.reference}
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
                {MAX_JOB !== null ? (
                  <span className="post-hint">
                    Up to {Number(MAX_JOB / 10n ** 18n) / 1e6} {COIN}.
                  </span>
                ) : null}
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
                <span className="post-label">Time to deliver</span>
                <Choices
                  label="Time to deliver"
                  value={draft.deliverHours}
                  options={HOURS}
                  onChange={(value) => update("deliverHours", value)}
                />
              </div>
              <div className="post-field">
                <span className="post-label">
                  Workers who can try, one after another
                </span>
                <Choices
                  label="Attempts"
                  value={draft.attempts}
                  options={ATTEMPTS}
                  onChange={(value) => update("attempts", value)}
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
                <span className="post-hint">
                  Held from posting until the verdict, or returned.
                </span>
              </div>
              <h3>{draft.description.split("\n")[0]}</h3>
            </div>
            <dl className="workspace-review">
              <dt>Who can apply</dt>
              <dd>{prepared.allowed_workers?.join(", ") ?? "Anyone"}</dd>
              <dt>Time to deliver</dt>
              <dd>
                {HOURS.find(([value]) => value === draft.deliverHours)?.[1]} for
                each worker
              </dd>
              <dt>Attempts</dt>
              <dd>
                Up to {draft.attempts}: if a worker fails, the next can try
              </dd>
              <dt>Bid stays open for</dt>
              <dd>
                {draft.days === "1" ? "1 day" : `${draft.days} days`}, then your
                check is published
              </dd>
              <dt>Signing as</dt>
              <dd>{wallet?.accountId ?? "Connect a wallet to post"}</dd>
            </dl>
            <div className="post-costs">
              <h3>You sign once, for {cost ? nearText(cost.total) : "…"}</h3>
              <dl>
                <dt>Payment, held until the verdict</dt>
                <dd>{cost ? nearText(cost.amount) : "…"}</dd>
                <dt>Checking runs, unused part returns</dt>
                <dd>{cost ? nearText(cost.budget) : "…"}</dd>
                <dt>Attempt fees, unused ones return</dt>
                <dd>{cost ? nearText(cost.fees) : "…"}</dd>
                <dt>Storage, unused part returns</dt>
                <dd>{cost ? nearText(cost.storage) : "…"}</dd>
              </dl>
              <p className="post-hint">
                Nothing else to sign: the check is tested, the job is given to
                the first worker who applies, the work is checked and the money
                moves by itself. Network gas is extra. The worker keeps a 0.015
                NEAR fee if well-formed work fails a rule.
              </p>
            </div>
            <div className="post-risks">
              <h3>Before you post</h3>
              <ul>
                <li>
                  Your payment is held from now. You can close the bid while no
                  worker is on it and get everything back.
                </li>
                <li>
                  A worker who never delivers uses up one attempt, and the job
                  waits until their deadline before the next can try.
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
            {busy
              ? "Waiting for your wallet…"
              : `Post and pay · ${cost ? nearText(cost.total) : ""}`}
          </button>
        )}
      </div>
      {market.paused && (
        <p className="market-note">New Market activity is paused.</p>
      )}
    </section>
  );
}
