import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
test("browser controls prevent duplicate POSTs and reconcile unknown starts through reads", async () => {
  const nodes = new Map(),
    windowEvents = new Map(),
    documentEvents = new Map(),
    timers = new Map();
  let timerId = 0;
  class Node {
    constructor() {
      this.handlers = new Map();
      this.children = [];
      this.dataset = {};
      this.disabled = false;
      this.textContent = "";
    }
    addEventListener(k, v) {
      this.handlers.set(k, v);
    }
    append(...n) {
      this.children.push(...n);
    }
    replaceChildren(...n) {
      this.children = n;
    }
    scrollIntoView() {}
  }
  const doc = {
    hidden: false,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Node());
      return nodes.get(id);
    },
    createElement() {
      return new Node();
    },
    addEventListener(k, v) {
      documentEvents.set(k, v);
    },
    dispatchEvent(e) {
      documentEvents.get(e.type)?.(e);
    },
  };
  let pendingPost,
    reply = { state: "ready", elapsed_ms: 0, jobs: [] };
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, ...opts });
    if (opts.method === "POST")
      return new Promise(
        (resolve, reject) => (pendingPost = { resolve, reject }),
      );
    return { ok: true, json: async () => reply };
  };
  const context = {
    document: doc,
    window: {
      addEventListener(k, v) {
        windowEvents.set(k, v);
      },
    },
    CustomEvent: class {
      constructor(type, opts) {
        this.type = type;
        Object.assign(this, opts);
      }
    },
    AbortController,
    fetch,
    Set,
    Map,
    Number,
    Error,
    setTimeout(fn, ms) {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/demo.js", import.meta.url), "utf8"),
    context,
  );
  const flush = () => new Promise((resolve) => setImmediate(resolve)),
    click = (id) => doc.getElementById(id).handlers.get("click")();
  await flush();
  assert.equal(nodes.get("demo-start").disabled, false);
  click("demo-start");
  click("demo-start");
  assert.equal(calls.filter((x) => x.method === "POST").length, 1);
  assert.equal(nodes.get("demo-start").disabled, true);
  assert.equal(calls.at(-1).body, "{}");
  pendingPost.reject(Error("PRIVATE TOKEN"));
  await flush();
  assert.equal(nodes.get("demo-start").disabled, true);
  assert.match(nodes.get("demo-status").textContent, /unknown/);
  assert.ok(!nodes.get("demo-status").textContent.includes("PRIVATE"));
  reply = { state: "consumed", elapsed_ms: 1, jobs: [] };
  click("demo-check");
  await flush();
  assert.equal(nodes.get("demo-start").disabled, true);
  assert.equal(calls.filter((x) => x.method === "POST").length, 1);
  reply = { state: "ready", elapsed_ms: 0, jobs: [] };
  click("demo-check");
  await flush();
  assert.equal(nodes.get("demo-start").disabled, false);
  click("demo-start");
  pendingPost.resolve({
    ok: true,
    json: async () => ({
      state: "running",
      elapsed_ms: 4100,
      jobs: [{ worker: "honest", id: 35, phase: "challenge" }],
    }),
  });
  await flush();
  assert.equal(nodes.get("demo-start").disabled, true);
  assert.equal(nodes.get("demo-jobs").children.length, 1);
  assert.match(nodes.get("demo-elapsed").textContent, /4.1 seconds/);
  reply = {
    state: "completed",
    elapsed_ms: 110000,
    jobs: [
      { worker: "honest", id: 35, phase: "Released" },
      { worker: "fake", id: 36, phase: "Refunded" },
    ],
  };
  const poll = [...timers.values()].find((t) => t.ms === 2000);
  assert.ok(poll);
  poll.fn();
  await flush();
  assert.equal(nodes.get("demo-jobs").children.length, 2);
  assert.equal(nodes.get("demo-start").disabled, true);
  assert.equal(calls.filter((x) => x.method === "POST").length, 2);
  reply = {
    state: "ready",
    elapsed_ms: 0,
    jobs: [{ worker: "honest", id: -2, phase: "payout" }],
    message: "PRIVATE TOKEN",
  };
  click("demo-check");
  await flush();
  assert.match(nodes.get("demo-status").textContent, /unavailable/);
  assert.ok(!nodes.get("demo-status").textContent.includes("PRIVATE"));
  windowEvents.get("pagehide")();
  assert.equal(timers.size, 0);
});
