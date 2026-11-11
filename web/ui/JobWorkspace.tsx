import { useState } from "react";
import { CollectedWork } from "./CollectedWork.tsx";
import { BidReview } from "./BidReview.tsx";
import {
  nextStep,
  showNear,
  type MarketBid,
  type Step,
} from "./market-steps.ts";
import type { Market, Wallet, Run } from "./market-types.ts";
import { recall, short } from "./market-client.ts";
import { performJobAction, resendDelivery } from "./job-actions.ts";
import { jobProgress, workerProgress } from "./job-progress.ts";
import { noteFor, roleOf, stepForViewer } from "./role-steps.ts";
import { COIN, IS_MAINNET, NETWORK, OUTLAYER_API } from "./network.ts";
import { bidTitle } from "./app-route.ts";
export function JobWorkspace({
  bid,
  market,
  wallet,
  run,
  clock,
  busy,
}: {
  bid: MarketBid;
  market: Market;
  wallet: Wallet | null;
  run: Run;
  clock: number;
  busy: boolean;
}) {
  const [tab, setTab] = useState("brief");
  const [delivery, setDelivery] = useState("");
  const [collected, setCollected] = useState<string | null>(null);
  const [check, setCheck] = useState("");
  const [reference, setReference] = useState("");
  const viewer = wallet?.accountId ?? null;
  const registered = viewer ? market.agents.includes(viewer) : false;
  const role = roleOf(bid, viewer);
  const step = stepForViewer(
    nextStep(bid, viewer, registered, clock),
    bid,
    role,
    clock,
  );
  const job = bid.job ?? bid.last_job;
  const worker = bid.claim?.agent ?? job?.worker;
  const savedCheck = recall(bid.check_hash);
  const savedReference = recall(bid.reference_hash);
  const deliveredHash = bid.job?.deliverable_hash ?? null;
  const [resend, setResend] = useState("");
  const canResend =
    role === "worker" && !!deliveredHash && bid.job?.state === "Delivered";

  const act = (current: Step) =>
    run(
      current.label,
      async () => {
        const delivered = await performJobAction(current, {
          market,
          wallet,
          bid,
          clock,
          delivery,
          checkText: savedCheck ?? check,
          referenceText: savedReference ?? reference,
        });
        if (delivered !== undefined) setCollected(delivered);
      },
      current.id === "review" ? "Reviewing the job brief…" : undefined,
    );

  const record = market.buyer_records?.[bid.buyer];
  const workerRecord = worker ? market.agent_records?.[worker] : undefined;
  // The board counts an attempt in its worker's record only when a sync records it. Bids posted before
  // the board kept records start at zero, so a worker paid here can still show 0 paid.
  const uncounted =
    (bid.recorded_attempts ?? 0) <
    Math.max(bid.funded_attempts, job?.history?.length ?? 0);
  const ended = ["Done", "Closed", "Cancelled"].includes(bid.state);
  const revealed = ended ? (
    <p className="job-check-link">
      <a href={`/api/market/reveal/${bid.id}`}>Read the published check</a>. Its
      SHA-256 must equal <code>{bid.check_hash}</code>.
    </p>
  ) : null;

  const needsPrivate =
    step?.id === "send_check" && (!savedCheck || !savedReference);
  const note = step ? noteFor(step, role, market.escrow, bid.amount) : "";
  const resendBox = canResend ? (
    <details className="job-resend">
      <summary>Didn’t finish handing over your work? Send it again</summary>
      <textarea
        rows={5}
        value={resend || recall(deliveredHash!) || ""}
        onChange={(event) => setResend(event.target.value)}
        spellCheck={false}
        aria-label="The exact work you delivered"
      />
      <button
        type="button"
        className="button button-secondary"
        disabled={busy || !wallet}
        onClick={() =>
          void run("Send my work again", () =>
            resendDelivery(
              wallet,
              (bid.job_id ?? bid.job!.id)!,
              resend || recall(deliveredHash!) || "",
              deliveredHash!,
            ),
          )
        }
      >
        Send my work again
      </button>
    </details>
  ) : null;
  const actionCard = !step ? null : step.id === "wait" ? (
    <div className="job-action job-action-wait">
      <span className="job-action-kicker">Now</span>
      <p>{step.label}</p>
      {resendBox}
    </div>
  ) : (
    <div className="job-action">
      <span className="job-action-kicker">Your next step</span>
      {step.id === "deliver" ? (
        <label>
          Your work, as one JSON object
          <textarea
            rows={7}
            value={delivery}
            onChange={(e) => setDelivery(e.target.value)}
            spellCheck={false}
          />
        </label>
      ) : null}
      {needsPrivate ? (
        <div className="market-two">
          <label>
            Check used for this bid
            <textarea
              rows={4}
              value={check}
              onChange={(e) => setCheck(e.target.value)}
            />
          </label>
          <label>
            Reference used for this bid
            <textarea
              rows={4}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
        </div>
      ) : null}
      <button
        type="button"
        className="button button-primary"
        disabled={busy || !wallet}
        onClick={() => void act(step)}
      >
        {busy ? "Working…" : step.label}
      </button>
      {wallet ? null : <p className="post-hint">Connect a wallet first.</p>}
      <p className="post-hint">{note}</p>
      {resendBox}
    </div>
  );
  return (
    <article className="market-bid" data-state={bid.state}>
      <header className="job-head">
        <div>
          <span className="job-meta">
            {role === "visitor" ? (
              <a href="/app/market">Market</a>
            ) : (
              <a href="/app/jobs">My jobs</a>
            )}{" "}
            · Bid {bid.id}
          </span>
          <h1>{bidTitle(bid)}</h1>
        </div>
        <div className="job-head-side">
          <strong>{showNear(bid.amount)}</strong>
          <span className={`market-pill market-${bid.state.toLowerCase()}`}>
            {bid.state}
          </span>
        </div>
      </header>
      <ol
        className="job-progress"
        data-steps={role === "worker" ? 4 : 7}
        aria-label="Job progress"
      >
        {(role === "worker" ? workerProgress(bid) : jobProgress(bid)).map(
          (stage) => (
            <li
              key={stage.label}
              data-status={stage.status}
              aria-current={stage.status === "current" ? "step" : undefined}
            >
              <span aria-hidden="true" />
              {stage.label}
            </li>
          ),
        )}
      </ol>
      <JobResult bid={bid} />
      {actionCard}
      <div className="workspace-tabs" aria-label="Job sections">
        {["brief", "delivery", "evidence"].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      {tab === "brief" ? (
        <>
          <p className="market-description">{bid.description}</p>
          <BidReview review={bid.review} reason={bid.review_reason} />
          {bid.finished ? null : (
            <details>
              <summary>Public format: every field a check may look at</summary>
              <pre className="market-pre">{bid.format}</pre>
            </details>
          )}
          <dl className="market-facts">
            <div>
              <dt>{ended ? "Bid ended" : "Bid ends"}</dt>
              <dd>
                {new Date(
                  Number(BigInt(bid.expires_at) / 1_000_000n),
                ).toUTCString()}
              </dd>
            </div>
            <div>
              <dt>Attempts used</dt>
              <dd>
                {bid.funded_attempts} of {bid.max_attempts ?? 3}
              </dd>
            </div>
            <div>
              <dt>Buyer</dt>
              <dd title={bid.buyer}>{short(bid.buyer)}</dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd title={worker ?? undefined}>
                {worker ? short(worker) : "No worker has claimed this job."}
              </dd>
            </div>
            <div>
              <dt>Buyer’s record, from the chain</dt>
              <dd>
                {record?.paid ?? 0} paid, {record?.refunded ?? 0} refunded,{" "}
                {record?.expired ?? 0} expired
              </dd>
            </div>
            {workerRecord ? (
              <div>
                <dt>Worker’s record, from the chain</dt>
                <dd>
                  {workerRecord.paid} paid, {workerRecord.failed} failed the
                  check, {workerRecord.failed_format} did not fit the format,{" "}
                  {workerRecord.no_delivery} not delivered,{" "}
                  {workerRecord.no_verdict} with no verdict
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="post-hint">
            A buyer paying its own second account can inflate these records.
            {workerRecord && uncounted
              ? " This bid’s attempts are not in the worker’s record yet: the board counts them when the bid is next synced."
              : ""}
          </p>
          <details>
            <summary>Protections and limits</summary>
            <ul className="post-hint">
              <li>
                <strong>Worker, protected:</strong> checks use only this format;
                rejected work never reaches the buyer; well-formed work that
                fails keeps the 0.015 NEAR fee; the check is published at close.
              </li>
              <li>
                <strong>Worker, not protected:</strong> an unfair check pays
                only the fee, with no dispute process; the relay operator can
                read work or withhold a check; reuse is blocked only for the
                same check hash. Start work only after funding.
              </li>
              <li>
                <strong>Buyer, not protected:</strong> a worker who never
                delivers uses an attempt and locks the money until the deadline;
                on an open bid, junk that fits the format can take the fee.
                Listing allowed workers avoids both.
              </li>
            </ul>
          </details>
          {revealed}
        </>
      ) : null}
      {tab === "evidence" ? (
        <section>
          <h2>Job evidence</h2>
          {bid.finished ? (
            <p className="post-hint">
              Ended; storage returned to the buyer. The description and format
              are in the posting transaction (hashes below).
            </p>
          ) : null}
          <dl className="market-facts">
            <div>
              <dt>Buyer</dt>
              <dd>{short(bid.buyer)}</dd>
            </div>
            {bid.claim ? (
              <div>
                <dt>Claimed by</dt>
                <dd>{short(bid.claim.agent)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Claims / funded attempts</dt>
              <dd>
                {bid.claims_made} / {bid.funded_attempts}
              </dd>
            </div>
            {job ? (
              <div>
                <dt>Job state</dt>
                <dd>{job.state}</dd>
              </div>
            ) : null}
            {job?.fakes_total ? (
              <div>
                <dt>Fakes caught</dt>
                <dd>
                  {job.fakes_caught} of {job.fakes_total}
                </dd>
              </div>
            ) : null}
            {job?.failed_rule ? (
              <div>
                <dt>Failed rule</dt>
                <dd>{job.failed_rule}</dd>
              </div>
            ) : null}
            {job?.verdict_request_id ? (
              <div>
                <dt>Verdict attestation</dt>
                <dd>
                  <a
                    href={`${OUTLAYER_API}/attestations/by-request/${job.verdict_request_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Request {job.verdict_request_id}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
          <details>
            <summary>Technical details</summary>
            <dl className="market-facts">
              {Object.entries({
                Board: market.board,
                Escrow: market.escrow,
                "Bid ID": bid.id,
                "Escrow job ID": bid.job_id ?? "Being created",
                "Check hash": bid.check_hash,
                "Reference hash": bid.reference_hash,
                "Verifier hash": bid.verifier_hash,
                "Format hash": bid.format_hash,
                "Attempt fees": (bid.fees ?? []).join(", ") || "None",
                "Compute budget left": job?.compute_budget
                  ? showNear(job.compute_budget)
                  : "None",
                "Deliverable hash": job?.deliverable_hash ?? "Not delivered",
                "Challenge request": job?.challenge_request_id ?? "None",
              }).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
          <a href="/trust">How verification is trusted</a>{" "}
          {/* The evidence reader reads recorded testnet jobs only. Mainnet links its attestation above. */}
          {IS_MAINNET ? null : (
            <a
              href={
                job?.id !== undefined ? `/evidence#job-${job.id}` : "/evidence"
              }
            >
              Open the escrow evidence reader
            </a>
          )}
        </section>
      ) : null}
      {tab === "delivery" ? (
        <p>
          {job?.deliverable_hash
            ? "A delivery hash is recorded. Private delivery text is available only through the authorised collection flow."
            : "No delivery has been recorded yet."}
        </p>
      ) : null}
      {collected !== null && job ? (
        <CollectedWork bid={bid} job={job} text={collected} network={NETWORK} />
      ) : null}
    </article>
  );
}

/** The outcome in plain words, read from the escrow's own record. A refund is never shown as success. */
function JobResult({ bid }: { bid: MarketBid }) {
  const job = bid.job ?? bid.last_job;
  if (!job) return null;
  const last = job.history?.at(-1);
  const proof = (request: string | null | undefined) =>
    request ? (
      <a
        href={`${OUTLAYER_API}/attestations/by-request/${request}`}
        target="_blank"
        rel="noreferrer"
      >
        attested run {request}
      </a>
    ) : null;
  if (job.state === "Released")
    return (
      <div className="job-result job-result-pass" role="status">
        <strong>Passed and paid.</strong> {showNear(job.amount)} went to{" "}
        {short(last?.worker ?? job.worker ?? "the worker")}. Checked by{" "}
        {proof(job.verdict_request_id ?? last?.verdict_request_id)}. The unused
        checking budget and attempt fees go back to the buyer.
      </div>
    );
  if (job.state === "Passed")
    return (
      <div className="job-result job-result-pass" role="status">
        <strong>Passed.</strong> Checked by {proof(job.verdict_request_id)}. The
        payment is being sent.
      </div>
    );
  if (job.state === "Refunded")
    return (
      <div className="job-result job-result-fail" role="status">
        <strong>Not paid. Refunded to the buyer.</strong>{" "}
        {last?.outcome === "Failed"
          ? `The last work failed the rule “${last.failed_rule ?? "unknown"}”.`
          : "No work passed before the job ended."}
      </div>
    );
  if (job.state === "CheckRejected")
    return (
      <div className="job-result job-result-fail" role="status">
        <strong>The buyer’s check failed its own test</strong> (
        {job.fakes_caught} of {job.fakes_total} fakes caught), so this job
        cannot run. The buyer is refunded.
      </div>
    );
  if (last && last.outcome !== "Paid")
    return (
      <div className="job-result" role="status">
        <strong>The last attempt did not pass</strong>
        {last.outcome === "Failed"
          ? `: it failed the rule “${last.failed_rule ?? "unknown"}”, checked by `
          : last.outcome === "NoDelivery"
            ? ": nothing was delivered in time"
            : ": no verdict was recorded in time"}
        {last.outcome === "Failed" ? proof(last.verdict_request_id) : null}. The
        job is open for the next worker.
      </div>
    );
  return null;
}
