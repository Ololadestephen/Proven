import { useState } from "react";
import {
  nextStep,
  showNear,
  type MarketBid,
  type Step,
} from "./market-steps.ts";
import type { Market, Wallet, Run } from "./market-types.ts";
import { recall, short } from "./market-client.ts";
import { performJobAction } from "./job-actions.ts";
import { COIN, OUTLAYER_API } from "./network.ts";
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
  const step = nextStep(bid, viewer, registered, clock);
  const job = bid.job ?? bid.last_job;
  const worker = bid.claim?.agent ?? job?.worker;
  const savedCheck = recall(bid.check_hash);
  const savedReference = recall(bid.reference_hash);

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
    step?.id === "challenge" && (!savedCheck || !savedReference);
  return (
    <article className="market-bid" data-state={bid.state}>
      <header>
        <span className="market-id">Bid {bid.id}</span>
        <span className={`market-pill market-${bid.state.toLowerCase()}`}>
          {bid.state}
        </span>
        <strong>{showNear(bid.amount)}</strong>
      </header>
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
          <h2>{bid.description.split("\n")[0]}</h2>
          <p className="market-description">{bid.description}</p>
          <details open>
            <summary>Public format: every field a check may look at</summary>
            <pre className="market-pre">{bid.format}</pre>
          </details>
          <p>
            Bid ends{" "}
            {new Date(
              Number(BigInt(bid.expires_at) / 1_000_000n),
            ).toUTCString()}
            . {bid.funded_attempts} of 3 funded attempts used.
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
          <p>
            <strong>What a worker is protected from.</strong> A check cannot use
            a field outside this format. The buyer gets rejected work only
            through this relay’s operator, never through Proven. If well-formed
            work fails a rule, you keep the 0.015 NEAR attempt fee. The check is
            published when the bid closes, so unfair ones can be seen.
          </p>
          <p>
            <strong>What a worker is not protected from.</strong> A buyer can
            still write an unfair check using only published fields. Then you
            get the fee, not the full payment, and there is no dispute process.
            The relay’s operator can read your work, and could withhold a check.
            Reuse is blocked only for the exact same check hash. Do not start
            work before funding.
          </p>
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
                "Escrow job ID": bid.claim?.job_id ?? job?.id ?? "Not linked",
                "Check hash": bid.check_hash,
                "Reference hash": bid.reference_hash,
                "Verifier hash": bid.verifier_hash,
                "Format hash": bid.format_hash,
                "Attempt fee": bid.fee ? bid.fee.state : "None",
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
          <a
            href={
              job?.id !== undefined ? `/evidence#job-${job.id}` : "/evidence"
            }
          >
            Open the escrow evidence reader
          </a>
        </section>
      ) : null}
      {tab === "delivery" ? (
        <p>
          {job?.deliverable_hash
            ? "A delivery hash is recorded. Private delivery text is available only through the authorised collection flow."
            : "No delivery has been recorded yet."}
        </p>
      ) : null}
      {step?.id === "deliver" ? (
        <label>
          Your work, as one JSON object. The task text is the description above;
          show it in full below.
          <textarea
            rows={7}
            value={delivery}
            onChange={(e) => setDelivery(e.target.value)}
            spellCheck={false}
          />
        </label>
      ) : null}
      {step?.id === "deliver" || step?.id === "claim" ? (
        <details>
          <summary>Full task</summary>
          <pre className="market-pre">{bid.description}</pre>
        </details>
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
      {step && step.id !== "wait" ? (
        <p className="market-note">
          {step.id === "fund"
            ? `Funding sends ${showNear(bid.amount)} to ${market.escrow}. Only the fixed check controls settlement. An unfair check can reject honest work.`
            : step.id === "challenge" || step.id === "verify"
              ? `This call attaches 0.1 ${COIN} plus gas to ${market.escrow}. Unused compute deposit returns; failed runs may need recovery. The relay can read private texts.`
              : step.id === "claim"
                ? `Applying reserves this claim with 0.005 ${COIN} storage plus gas. Wait for buyer funding before working.`
                : step.id === "register"
                  ? `Registration attaches 0.02 ${COIN} storage plus gas. This does not prove a unique person or agent.`
                  : step.id === "create_job"
                    ? `Creates an escrow job with 0.02 ${COIN} storage plus gas. Recipient: ${market.escrow}.`
                    : "Review the recipient and action in your wallet before confirming."}
        </p>
      ) : null}
      {step ? (
        step.id === "wait" ? (
          <p className="market-wait">{step.label}</p>
        ) : (
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !wallet}
            onClick={() => void act(step)}
          >
            {step.label}
          </button>
        )
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
