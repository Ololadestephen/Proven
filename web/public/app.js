"use strict";

const form = document.getElementById("job-form");
const input = document.getElementById("job-id");
const results = document.getElementById("job-results");
const empty = document.getElementById("empty-state");
const feedback = document.getElementById("feedback");
const feedbackText = document.getElementById("feedback-text");
const controls = [...document.querySelectorAll("button")];
let loadedId = null;
let activeRequest = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function present(value, fallback = "Not recorded") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

function detail(label, value) {
  const group = element("dl", undefined, "detail");
  group.append(element("dt", label), element("dd", present(value)));
  return group;
}

function secureLink(label, address, className) {
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const link = element("a", label, className);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${label} (opens a new tab)`);
    return link;
  } catch {
    return null;
  }
}

function nativeNear(amount) {
  if (typeof amount !== "string" || !/^\d{1,78}$/.test(amount))
    throw new Error("Invalid amount");
  const value = BigInt(amount);
  const scale = 10n ** 24n;
  const remainder = (value % scale)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${value / scale}${remainder ? `.${remainder}` : ""} NEAR`;
}

function timestamp(value) {
  if (value === null || value === undefined) return "Not recorded";
  try {
    if (!/^\d{1,20}$/.test(String(value))) return "Invalid chain timestamp";
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime())
      ? date.toISOString().replace("T", " ").replace(".000Z", " UTC")
      : "Invalid chain timestamp";
  } catch {
    return "Invalid chain timestamp";
  }
}

function metric(label, value, note, tone = "") {
  const card = element("article", undefined, "metric");
  card.append(
    element("p", label, "metric-label"),
    element("p", value, `metric-value ${tone}`),
    element("p", note, "metric-detail"),
  );
  return card;
}

function renderSummary(data) {
  const { job, progress } = data;
  const token = job.token;
  const amount =
    token === null
      ? nativeNear(job.amount)
      : `${present(job.amount)} base units`;
  const tone = ["Passed", "Released"].includes(job.state)
    ? "tone-good"
    : ["Failed", "Refunded", "Expired"].includes(job.state)
      ? "tone-bad"
      : "";
  document
    .getElementById("summary")
    .replaceChildren(
      metric(
        "Recorded job amount",
        amount,
        `${present(job.amount)} base units · ${token === null ? "native NEAR · 24 decimals" : present(token)}`,
        "mono",
      ),
      metric("Contract state", present(job.state), progress.funds, tone),
      metric(
        "Check challenge",
        `${present(job.fakes_caught, "0")} of ${present(job.fakes_total, "0")}`,
        "Planted fakes caught. Counts alone do not establish an accepted challenge.",
        "mono",
      ),
      metric(
        "Verdict",
        job.verdict_request_id === null
          ? "No recorded result"
          : ["Failed", "Refunded"].includes(job.state)
            ? "Fail recorded"
            : ["Passed", "Released"].includes(job.state)
              ? "Pass recorded"
              : "Result recorded",
        progress.verdict,
      ),
    );
}

function renderProgress(data) {
  const cards = [];
  for (const [label, value] of [
    ["Run / current attempt", data.progress.run],
    ["Retry / stale attempt", data.progress.retry],
    ["Expiry / recovery", data.progress.expiry],
  ]) {
    const card = element("article", undefined, "progress-item");
    card.append(element("h4", label), element("p", present(value)));
    cards.push(card);
  }
  document.getElementById("progress").replaceChildren(...cards);
  const job = data.job;
  document
    .getElementById("timing")
    .replaceChildren(
      detail("Attempt number", job.attempt),
      detail("Run started · UTC", timestamp(job.run_started_at)),
      detail("Delivery deadline · UTC", timestamp(job.deadline)),
      detail("Delivered · UTC", timestamp(job.delivered_at)),
      detail("Verdict window", `${present(job.verdict_window_secs)} seconds`),
      detail("Failed rule", job.failed_rule),
    );
}

function renderCommitments(data) {
  const accounts = [
    ["Escrow", data.escrow],
    ["Buyer", data.job.buyer],
    ["Worker", data.job.worker],
  ].map(([label, account]) => {
    const group = detail(label, account);
    const link = secureLink(
      present(account),
      `https://testnet.nearblocks.io/address/${encodeURIComponent(account)}`,
    );
    if (link) group.querySelector("dd").replaceChildren(link);
    return group;
  });
  document.getElementById("accounts").replaceChildren(...accounts);
  const hashes = [
    ["Check / spec hash", data.job.spec_hash],
    ["Reference / fakes hash", data.job.fakes_hash],
    ["Verifier build hash", data.job.verifier_hash],
    ["Deliverable hash", data.job.deliverable_hash],
    ["Challenge output hash", data.job.challenge_report_hash],
    ["Verdict output hash", data.job.report_hash],
  ].map(([label, hash]) => {
    const group = detail(label, hash);
    group.className = "commitment";
    return group;
  });
  document.getElementById("commitments").replaceChildren(...hashes);
}

function auditList(title, items, fallback) {
  const section = element("section", undefined, "audit-group");
  section.append(element("h5", title));
  const list = element("ul");
  const values = Array.isArray(items) && items.length ? items : [fallback];
  for (const item of values) list.append(element("li", item));
  section.append(list);
  return section;
}

function renderAudit(title, audit) {
  const status = [
    "matched",
    "mismatch",
    "unavailable",
    "not_recorded",
  ].includes(audit.status)
    ? audit.status
    : "unavailable";
  const labels = {
    matched: "Bindings matched",
    mismatch: "Binding mismatch",
    unavailable: "Audit unavailable",
    not_recorded: "No recorded result",
  };
  const card = element("article", undefined, "panel audit");
  const heading = element("div", undefined, "audit-header");
  heading.append(
    element("h4", title),
    element("span", labels[status], `badge ${status}`),
  );
  card.append(
    heading,
    detail("Stored request ID", audit.request_id),
    element("p", present(audit.message), "audit-message"),
  );
  card.append(
    auditList(
      "Checks reported by this audit",
      audit.checks,
      "No successful checks reported.",
    ),
  );
  const notChecked = Array.isArray(audit.not_checked)
    ? [...audit.not_checked]
    : [];
  notChecked.push(
    "Independent Intel signature-chain verification by this page.",
  );
  card.append(
    auditList(
      "Not verified by this page",
      notChecked,
      "Independent signature verification is not performed.",
    ),
  );
  const link = secureLink(
    "Open attestation evidence ↗",
    audit.url,
    "audit-link",
  );
  if (link) card.append(link);
  return card;
}

function render(data) {
  if (
    !data ||
    data.network !== "testnet" ||
    !data.job ||
    !data.progress ||
    !data.attestations?.challenge ||
    !data.attestations?.verify
  )
    throw new Error("Invalid snapshot");
  document.getElementById("job-title").textContent = `Job #${data.job_id}`;
  document.getElementById("snapshot-meta").textContent =
    `Testnet · block ${present(data.block_height)} · observed ${present(data.observed_at)} · manual snapshot`;
  renderSummary(data);
  renderProgress(data);
  renderCommitments(data);
  document
    .getElementById("attestations")
    .replaceChildren(
      renderAudit("Check challenge", data.attestations.challenge),
      renderAudit("Delivery verification", data.attestations.verify),
    );
}

function setFeedback(message, state) {
  feedbackText.textContent = message;
  feedback.dataset.state = state;
  feedback.setAttribute("role", state === "error" ? "alert" : "status");
}

function clearResults() {
  results.hidden = true;
  for (const id of [
    "summary",
    "progress",
    "timing",
    "accounts",
    "commitments",
    "attestations",
  ])
    document.getElementById(id).replaceChildren();
  document.getElementById("job-title").textContent = "Job";
  document.getElementById("snapshot-meta").textContent = "";
}

async function loadJob(rawId) {
  const id = String(rawId).trim();
  activeRequest?.abort();
  activeRequest = null;
  clearResults();
  results.setAttribute("aria-busy", "false");
  controls.forEach((button) => {
    button.disabled = false;
  });
  loadedId = null;
  if (!/^\d{1,16}$/.test(id) || BigInt(id) > 9_007_199_254_740_991n) {
    empty.hidden = false;
    setFeedback(
      "Enter a non-negative decimal job ID within the viewer’s safe integer range.",
      "error",
    );
    return;
  }
  const canonicalId = BigInt(id).toString();
  input.value = canonicalId;
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 45_000);
  activeRequest = request;
  empty.hidden = true;
  results.setAttribute("aria-busy", "true");
  controls.forEach((button) => {
    button.disabled = true;
  });
  setFeedback(
    `Reading job #${canonicalId} from testnet. Previous results have been cleared.`,
    "loading",
  );
  try {
    const response = await fetch(`/api/jobs/${canonicalId}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: request.signal,
      headers: { Accept: "application/json" },
    });
    const data = await response.json();
    if (activeRequest !== request) return;
    if (!response.ok) {
      setFeedback(
        typeof data?.error === "string"
          ? data.error
          : "The job could not be loaded. Please try again.",
        "error",
      );
      empty.hidden = false;
      return;
    }
    if (String(data.job_id) !== canonicalId)
      throw new Error("Wrong job response");
    render(data);
    loadedId = canonicalId;
    results.hidden = false;
    setFeedback(
      `Loaded job #${canonicalId}. This snapshot will not refresh automatically.`,
      "success",
    );
  } catch (error) {
    if (activeRequest !== request) return;
    clearResults();
    empty.hidden = false;
    setFeedback(
      request.signal.aborted
        ? "The read timed out after 45 seconds. Try loading the job again. No transaction was sent."
        : "Unable to read a valid job snapshot. Check the local server and try again. No transaction was sent.",
      "error",
    );
  } finally {
    clearTimeout(timeout);
    if (activeRequest === request) {
      results.setAttribute("aria-busy", "false");
      controls.forEach((button) => {
        button.disabled = false;
      });
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadJob(input.value);
});
document.querySelectorAll("[data-job-id]").forEach((button) => {
  button.addEventListener("click", () => {
    void loadJob(button.dataset.jobId);
  });
});
document.getElementById("refresh-button").addEventListener("click", () => {
  if (loadedId !== null) void loadJob(loadedId);
});
