import { createRoot } from "react-dom/client";
import { SpotlightCard } from "./react-bits/SpotlightCard.tsx";
import { AnimatedList } from "./react-bits/AnimatedList.tsx";
import { StarBorder } from "./react-bits/StarBorder.tsx";
import "./ui.css";

function JobCard({
  id,
  fake = false,
  landing = false,
}: {
  id: number;
  fake?: boolean;
  landing?: boolean;
}) {
  function inspect() {
    document.dispatchEvent(new CustomEvent("proven-job", { detail: id }));
    document.getElementById("lookup")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }
  return (
    <SpotlightCard className={`record-card ${fake ? "record-fake" : ""}`}>
      <div className="record-top">
        <span className="record-icon" aria-hidden="true">
          {fake ? "×" : "✓"}
        </span>
        <span className={`record-status ${fake ? "refund" : "released"}`}>
          {fake ? "Refunded" : "Released"}
        </span>
      </div>
      <p className="record-kicker">Recorded testnet example · #{id}</p>
      <h3>{fake ? "The convincing fake" : "The honest delivery"}</h3>
      <p className="record-description">
        {fake
          ? "The delivery failed its fixed check. Escrow returned the payment to the buyer."
          : "Invoice totals passed the fixed check. Escrow paid the recorded worker."}
      </p>
      <div className="record-details">
        <span>
          Native payment<strong>0.01 NEAR</strong>
        </span>
        <span>
          Check challenge<strong>13 of 13 fakes</strong>
        </span>
      </div>
      {landing ? (
        <span className="record-open record-preview-label">
          Recorded evidence
        </span>
      ) : (
        <button type="button" className="record-open" onClick={inspect}>
          Open job {id}
        </button>
      )}
    </SpotlightCard>
  );
}
function RecordedJobs() {
  return (
    <div className="record-grid">
      <JobCard id={35} />
      <JobCard id={36} fake />
    </div>
  );
}
function LandingPreview() {
  return (
    <div className="product-preview">
      <aside className="preview-sidebar" aria-label="Workspace preview">
        <span className="preview-p">p.</span>
        <AnimatedList preview />
      </aside>
      <div className="preview-main">
        <div className="preview-toolbar">
          <span>Proven workspace</span>
          <span className="preview-network">
            <i /> NEAR testnet
          </span>
        </div>
        <div className="preview-content">
          <div className="preview-title">
            <div>
              <p className="record-kicker">
                A recorded run. Evidence you can open.
              </p>
              <h2>Good work gets paid.</h2>
            </div>
            <span className="preview-small-label">
              Jobs 35 &amp; 36 · November 6
            </span>
          </div>
          <div className="record-grid">
            <JobCard id={35} landing />
            <JobCard id={36} fake landing />
          </div>
          <div className="preview-foot">
            <span>✓ Check challenged</span>
            <span>◇ Attestation linked</span>
            <span> Payment recorded</span>
          </div>
        </div>
      </div>
    </div>
  );
}
const preview = document.getElementById("landing-preview");
if (preview) createRoot(preview).render(<LandingPreview />);
const jobs = document.getElementById("workspace-cards");
if (jobs) createRoot(jobs).render(<RecordedJobs />);
const cta = document.getElementById("reactbits-cta");
if (cta)
  createRoot(cta).render(
    <StarBorder href="/app#demo">Explore the demo</StarBorder>,
  );

const navigation = document.getElementById("workspace-navigation");
if (navigation) createRoot(navigation).render(<AnimatedList />);
