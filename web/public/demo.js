"use strict";

(() => {
  const start = document.getElementById("demo-start");
  const check = document.getElementById("demo-check");
  const status = document.getElementById("demo-status");
  const elapsed = document.getElementById("demo-elapsed");
  const jobs = document.getElementById("demo-jobs");
  const states = new Set([
    "disabled",
    "ready",
    "running",
    "completed",
    "stopped",
    "consumed",
  ]);
  const messages = {
    disabled:
      "Live demo is disabled. The operator must enable one run locally.",
    ready: "One live scripted testnet run is available.",
    running:
      "The scripted agents are working. Progress is supplied by the operator; open a job for its on-chain snapshot.",
    completed:
      "The run completed. Open each job to inspect its verdict and payment evidence.",
    stopped:
      "The run stopped. The operator must inspect its saved evidence before any further attempt.",
    consumed:
      "This demo allowance has already been used. The operator must reconcile its evidence before enabling another run.",
  };
  const phases = new Map([
    ["waiting", "Waiting"],
    ["created", "Job created"],
    ["challenge", "Challenging the acceptance check"],
    ["fund", "Funding escrow"],
    ["delivery", "Submitting delivery"],
    ["verification", "Verifying delivery"],
    ["payout", "Settling payment"],
    ["Released", "Released to honest worker"],
    ["Refunded", "Refunded to buyer"],
  ]);
  let current = "disabled";
  let active = null;
  let poll = null;
  let away = false;
  let uncertain = false;

  function buttons() {
    start.disabled = Boolean(active) || current !== "ready" || uncertain;
    check.disabled = Boolean(active);
  }

  function normalize(data) {
    if (
      !data ||
      !states.has(data.state) ||
      !Number.isSafeInteger(data.elapsed_ms) ||
      data.elapsed_ms < 0 ||
      !Array.isArray(data.jobs) ||
      data.jobs.length > 2
    )
      throw new Error("Invalid demo status");
    const workers = new Set();
    for (const job of data.jobs) {
      if (
        !["honest", "fake"].includes(job.worker) ||
        workers.has(job.worker) ||
        !Number.isSafeInteger(job.id) ||
        job.id < 0 ||
        typeof job.phase !== "string" ||
        job.phase.length > 40
      )
        throw new Error("Invalid demo job");
      workers.add(job.worker);
    }
    return data;
  }

  function render(data) {
    current = data.state;
    status.textContent = messages[current];
    status.dataset.state = current;
    elapsed.textContent =
      data.elapsed_ms > 0
        ? `Run elapsed: ${(data.elapsed_ms / 1000).toFixed(1)} seconds. This is a progress timer, not the full-command benchmark.`
        : "No new run has started in this page session.";
    jobs.replaceChildren();
    for (const job of data.jobs) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = `${job.worker === "honest" ? "Honest" : "Fake"} case · Job #${job.id}`;
      const phase = document.createElement("span");
      phase.textContent =
        phases.get(job.phase) ?? "In progress; inspect the job snapshot.";
      const open = document.createElement("a");
      open.className = "button button-quiet";
      open.textContent = `Inspect job ${job.id}`;
      open.href = `/evidence#job-${job.id}`;
      item.append(title, phase, open);
      jobs.append(item);
    }
  }

  function schedulePoll() {
    clearTimeout(poll);
    poll = null;
    if (!away && !document.hidden && current === "running")
      poll = setTimeout(() => void request(false), 2000);
  }

  async function request(begin) {
    if (active || away || document.hidden) return;
    if (begin && (current !== "ready" || uncertain)) return;
    clearTimeout(poll);
    const controller = new AbortController();
    active = controller;
    if (begin) uncertain = true;
    buttons();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(begin ? "/api/demo/start" : "/api/demo", {
        method: begin ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: begin
          ? { Accept: "application/json", "Content-Type": "application/json" }
          : { Accept: "application/json" },
        ...(begin ? { body: "{}" } : {}),
      });
      if (!response.ok) throw new Error("Demo status unavailable");
      const data = normalize(await response.json());
      if (away || active !== controller) return;
      if (!begin) uncertain = false;
      render(data);
    } catch {
      if (away) return;
      if (begin) {
        current = "stopped";
        status.textContent =
          "The start response is unknown. Check status before doing anything else. This page will not submit another start automatically.";
      } else {
        status.textContent =
          "Demo status is unavailable. Check status again; this does not send a transaction or repeat the demo.";
      }
      status.dataset.state = "unavailable";
    } finally {
      clearTimeout(timeout);
      if (active === controller) active = null;
      buttons();
      schedulePoll();
    }
  }

  start.addEventListener("click", () => void request(true));
  check.addEventListener("click", () => void request(false));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(poll);
      active?.abort();
    } else {
      void request(false);
    }
  });
  window.addEventListener("pagehide", () => {
    away = true;
    clearTimeout(poll);
    active?.abort();
  });
  window.addEventListener("pageshow", () => {
    if (!away) return;
    away = false;
    void request(false);
  });
  void request(false);
})();
