import { useState } from "react";
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
import { COIN, IS_MAINNET, OUTLAYER_API } from "./network.ts";
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
    run(current.label, async () => {
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
    });

  const record = market.buyer_records?.[bid.buyer];
  const ended = ["Done", "Closed", "Cancelled"].includes(bid.state);
  const revealed = ended ? (
    <p>
      <a href={`/api/market/reveal/${bid.id}`}>Read the published check</a>. Its
      SHA-256 must equal {bid.check_hash}.
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
            <a href="/app/jobs">My jobs</a> · Bid {bid.id}
          </span>
          <h2>{bid.description.split("\n")[0]}</h2>
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
          <details>
            <summary>Public format: every field a check may look at</summary>
            <pre className="market-pre">{bid.format}</pre>
          </details>
          <p>
            Bid ends{" "}
            {new Date(
              Number(BigInt(bid.expires_at) / 1_000_000n),
            ).toUTCString()}
            . {bid.funded_attempts} of {bid.max_attempts ?? 3} attempts used.
          </p>
          <p>
            This buyer’s record, from the chain: {record?.paid ?? 0} paid,{" "}
            {record?.refunded ?? 0} refunded, {record?.expired ?? 0} expired. A
            buyer paying its own second account can inflate this.
          </p>
          <p>
            Buyer: {bid.buyer}.{" "}
            {worker ? `Worker: ${worker}.` : "No worker has claimed this job."}
          </p>
          <details>
            <summary>What each side is protected from</summary>
            <p>
              <strong>What a worker is protected from.</strong> A check cannot
              use a field outside this format. Proven never gives the buyer
              rejected work. If well-formed work fails a rule, you keep the
              0.015 NEAR attempt fee. The check is published when the bid
              closes, so unfair ones can be seen.
            </p>
            <p>
              <strong>What a worker is not protected from.</strong> A buyer can
              still write an unfair check using only published fields. Then you
              get the fee, not the full payment, and there is no dispute
              process. The relay’s operator can read your work, and could
              withhold a check. Reuse is blocked only for the exact same check
              hash. Do not start work before funding.
            </p>
            <p>
              <strong>What a buyer is not protected from.</strong> A worker who
              never delivers uses up a funded attempt, and your money is locked
              until the deadline. On an open bid, junk that fits the format can
              take the fee. Listing allowed workers avoids both.
            </p>
          </details>
          {revealed}
        </>
      ) : null}
      {tab === "evidence" ? (
        <section>
          <h2>Job evidence</h2>
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
      {collected !== null ? (
        <div className="market-collected">
          <strong>The delivered work, as untrusted text</strong>
          <pre className="market-pre">{collected}</pre>
        </div>
      ) : null}
    </article>
  );
}
