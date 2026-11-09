import { createRoot } from "react-dom/client";
import { SpotlightCard } from "./react-bits/SpotlightCard.tsx";
import { WorkspaceNavigation } from "./WorkspaceNavigation.tsx";
import { AnimatedList } from "./react-bits/AnimatedList.tsx";
import { StarBorder } from "./react-bits/StarBorder.tsx";
import "./ui.css";
import {
  APP_NAVIGATION,
  SUPPORT_NAVIGATION,
  type WorkspaceSection,
} from "./navigation-state.ts";

/** What each recorded job showed, read from its escrow record. Mainnet jobs 0 and 1 settled on
 * November 6 on proven-escrow.near; testnet jobs 35 and 36 are the ones the evidence reader opens. */
const RECORDED = {
  mainnet: {
    label: "Recorded mainnet job",
    honest:
      "A model's invoice totals passed the fixed check. Escrow paid the worker.",
    fake: "A scripted wrong delivery failed the reconcile rule. Escrow returned the payment to the buyer.",
  },
  testnet: {
    label: "Recorded testnet example",
    honest:
      "Invoice totals passed the fixed check. Escrow paid the recorded worker.",
    fake: "The delivery failed its fixed check. Escrow returned the payment to the buyer.",
  },
};

function JobCard({
  id,
  fake = false,
  landing = false,
  network = "testnet",
}: {
  id: number;
  fake?: boolean;
  landing?: boolean;
  network?: keyof typeof RECORDED;
}) {
  const recorded = RECORDED[network];
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
      <p className="record-kicker">
        {recorded.label} · #{id}
      </p>
      <h3>{fake ? "The convincing fake" : "The honest delivery"}</h3>
      <p className="record-description">
        {fake ? recorded.fake : recorded.honest}
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
        <a className="record-open" href={`/evidence#job-${id}`}>
          Open job {id}
        </a>
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
            <i /> Recorded example
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
              Mainnet jobs 0 &amp; 1 · November 6
            </span>
          </div>
          <div className="record-grid">
            <JobCard id={0} landing network="mainnet" />
            <JobCard id={1} fake landing network="mainnet" />
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
    <StarBorder href="/examples">Explore the demo</StarBorder>,
  );

const navigation = document.getElementById("workspace-navigation");
if (navigation)
  createRoot(navigation).render(
    <WorkspaceNavigation
      items={APP_NAVIGATION}
      secondaryItems={SUPPORT_NAVIGATION}
      activeSection={
        (navigation.dataset.workspaceSection as WorkspaceSection) || "lookup"
      }
    />,
  );

// Keep public headers in their original layout slots while navigation floats on scroll.
const publicHeader = document.querySelector<HTMLElement>(
  ".landing-page > .lp-header, .guide-page > .lp-header",
);
if (publicHeader) {
  const syncHeader = () =>
    publicHeader.classList.toggle("is-scrolled", window.scrollY > 40);
  syncHeader();
  window.addEventListener("scroll", syncHeader, { passive: true });
  window.addEventListener("pageshow", syncHeader);
}
