import { Buffer } from "buffer";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  nextStep,
  showNear,
  type MarketBid,
  type Step,
} from "./market-steps.ts";

const RELAY_RECIPIENT = "proven-relay";
const TGAS = 1_000_000_000_000n;
const NEAR = 10n ** 24n;

interface Market {
  board: string;
  escrow: string;
  verifier_hash: string;
  paused: boolean;
  agents: string[];
  bids: MarketBid[];
}
interface Call {
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  deposit: bigint;
  gas: bigint;
}
interface Wallet {
  accountId: string;
  label: string;
  call(call: Call): Promise<void>;
  signForRelay(message: string): Promise<{
    public_key: string;
    signature_base64: string;
    nonce_base64: string;
  }>;
  signOut(): Promise<void>;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "That did not work.");
  return data;
}
const sha256 = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const randomNonce = () => crypto.getRandomValues(new Uint8Array(32));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const short = (account: string) =>
  account.length > 24
    ? `${account.slice(0, 10)}…${account.slice(-8)}`
    : account;

// Private texts stay in this browser until the relay checks them against the job's hashes.
const remember = (hash: string, text: string) => {
  try {
    localStorage.setItem(`proven-private-${hash}`, text);
  } catch {
    /* The buyer can paste them again. */
  }
};
const recall = (hash: string) => {
  try {
    return localStorage.getItem(`proven-private-${hash}`);
  } catch {
    return null;
  }
};

function devWallet(role: string, accountId: string, onOut: () => void): Wallet {
  return {
    accountId,
    label: `Dev signer: ${role}`,
    async call(call) {
      await api("/api/market/dev/call", {
        as: role,
        receiver: call.receiver,
        method: call.method,
        args: call.args,
        deposit: call.deposit.toString(),
        gas: call.gas.toString(),
      });
    },
    async signForRelay(message) {
      const nonce = randomNonce();
      const nonce_base64 = b64(nonce);
      const signed = await api<{
        public_key: string;
        signature_base64: string;
      }>("/api/market/dev/sign", {
        as: role,
        message,
        nonce_base64,
        recipient: RELAY_RECIPIENT,
      });
      return { ...signed, nonce_base64 };
    },
    async signOut() {
      onOut();
    },
  };
}

type Selector = Awaited<ReturnType<typeof setupWalletSelector>>;

function useWallet(board: string | undefined) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [dev, setDev] = useState<Record<string, string>>({});
  const [selector, setSelector] = useState<Selector | null>(null);

  const adopt = useCallback(async (sel: Selector) => {
    const state = sel.store.getState();
    const account =
      state.accounts.find((item: { active: boolean }) => item.active) ??
      state.accounts[0];
    if (!account || !state.selectedWalletId) {
      setWallet(null);
      return;
    }
    const chosen = await sel.wallet(state.selectedWalletId);
    setWallet({
      accountId: account.accountId,
      label: chosen.metadata.name,
      async call(call: Call) {
        await chosen.signAndSendTransaction({
          receiverId: call.receiver,
          actions: [
            {
              type: "FunctionCall",
              params: {
                methodName: call.method,
                args: call.args,
                gas: call.gas.toString(),
                deposit: call.deposit.toString(),
              },
            },
          ],
        } as never);
      },
      async signForRelay(message) {
        if (!chosen.signMessage)
          throw new Error("This wallet cannot sign messages. Use Meteor.");
        const nonce = randomNonce();
        const signed = await chosen.signMessage({
          message,
          recipient: RELAY_RECIPIENT,
          nonce: Buffer.from(nonce),
        });
        if (!signed) throw new Error("The wallet did not return a signature.");
        return {
          public_key: signed.publicKey,
          signature_base64: signed.signature,
          nonce_base64: b64(nonce),
        };
      },
      async signOut() {
        await chosen.signOut();
        setWallet(null);
      },
    });
  }, []);

  useEffect(() => {
    if (!board) return;
    let live = true;
    void api<Record<string, string>>("/api/market/dev")
      .then(setDev)
      .catch(() => setDev({}));
    void setupWalletSelector({
      network: "testnet",
      modules: [setupMeteorWallet(), setupMyNearWallet()],
    }).then((sel: Selector) => {
      if (!live) return;
      setSelector(sel);
      void adopt(sel);
    });
    return () => {
      live = false;
    };
  }, [board, adopt]);

  const connect = useCallback(
    async (id: string) => {
      if (!selector || !board) return;
      const chosen = await selector.wallet(id);
      await (
        chosen as unknown as {
          signIn(params: {
            contractId: string;
            methodNames: string[];
          }): Promise<unknown>;
        }
      ).signIn({ contractId: board, methodNames: [] });
      await adopt(selector);
    },
    [selector, board, adopt],
  );
  const useDev = useCallback(
    (role: string) => {
      setWallet(devWallet(role, dev[role]!, () => setWallet(null)));
    },
    [dev],
  );
  return { wallet, connect, dev, useDev };
}

function PostJob({
  market,
  wallet,
  run,
}: {
  market: Market;
  wallet: Wallet | null;
  run: Run;
}) {
  const [description, setDescription] = useState("");
  const [check, setCheck] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [windowMins, setWindowMins] = useState("30");
  const [workers, setWorkers] = useState("");
  const useSample = async () => {
    const sample = await api<{
      description: string;
      check: string;
      reference: string;
    }>("/api/market/sample");
    setDescription(sample.description);
    setCheck(sample.check);
    setReference(sample.reference);
  };
  const post = () =>
    run("Posting the bid", async () => {
      if (!wallet) throw new Error("Connect a wallet first.");
      const parsed = JSON.parse(check) as { verifier?: string };
      if (parsed.verifier !== market.verifier_hash)
        throw new Error(
          "The check must name the verifier build this escrow runs.",
        );
      const yocto = BigInt(Math.round(Number(amount) * 1e6)) * 10n ** 18n;
      if (yocto <= 0n || yocto > NEAR / 10n)
        throw new Error("The payment must be above 0 and at most 0.1 NEAR.");
      const [check_hash, reference_hash] = await Promise.all([
        sha256(check),
        sha256(reference),
      ]);
      remember(check_hash, check);
      remember(reference_hash, reference);
      const allowed = workers.split(/[\s,]+/).filter(Boolean);
      await wallet.call({
        receiver: market.board,
        method: "post_bid",
        args: {
          description,
          amount: yocto.toString(),
          check_hash,
          reference_hash,
          verifier_hash: parsed.verifier,
          claim_window_secs: Number(windowMins) * 60,
          allowed_workers: allowed.length ? allowed : null,
        },
        deposit: (NEAR * 6n) / 100n,
        gas: 30n * TGAS,
      });
    });
  return (
    <section className="market-card">
      <div className="market-card-head">
        <h2>Post a job</h2>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void useSample()}
        >
          Use the sample invoice job
        </button>
      </div>
      <p className="market-note">
        Only work a program can check. The description is public. The check and
        reference stay in this browser and go to the relay only after the chain
        fixes their hashes.
      </p>
      <label>
        Description (public, up to 2 KB)
        <textarea
          rows={6}
          value={description}
          maxLength={2048}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="market-two">
        <label>
          Acceptance check (private JSON)
          <textarea
            rows={6}
            value={check}
            onChange={(e) => setCheck(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          Reference answer (private JSON)
          <textarea
            rows={6}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="market-three">
        <label>
          Payment in NEAR (max 0.1)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label>
          Claim window in minutes
          <input
            value={windowMins}
            onChange={(e) => setWindowMins(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <label>
          Allowed workers (optional)
          <input
            value={workers}
            onChange={(e) => setWorkers(e.target.value)}
            placeholder="Empty means anyone"
          />
        </label>
      </div>
      <button
        type="button"
        className="button button-primary"
        disabled={!wallet || !description || !check || !reference}
        onClick={post}
      >
        Post the bid (0.06 NEAR deposit, the unused part returns)
      </button>
    </section>
  );
}

type Run = (label: string, task: () => Promise<void>) => Promise<void>;

function BidCard({
  bid,
  market,
  wallet,
  run,
  clock,
}: {
  bid: MarketBid;
  market: Market;
  wallet: Wallet | null;
  run: Run;
  clock: number;
}) {
  const [delivery, setDelivery] = useState("");
  const [collected, setCollected] = useState<string | null>(null);
  const [check, setCheck] = useState("");
  const [reference, setReference] = useState("");
  const viewer = wallet?.accountId ?? null;
  const registered = viewer ? market.agents.includes(viewer) : false;
  const step = nextStep(bid, viewer, registered, clock);
  const job = bid.job ?? bid.last_job;
  const savedCheck = recall(bid.check_hash);
  const savedReference = recall(bid.reference_hash);

  const act = (current: Step) =>
    run(current.label, async () => {
      if (current.id === "review") {
        await api(`/api/market/review/${bid.id}`, {});
        return;
      }
      if (!wallet) throw new Error("Connect a wallet first.");
      const board = (
        method: string,
        args: Record<string, unknown>,
        deposit = 0n,
        gas = 90n * TGAS,
      ) => wallet.call({ receiver: market.board, method, args, deposit, gas });
      const escrow = (
        method: string,
        args: Record<string, unknown>,
        deposit = 0n,
        gas = 70n * TGAS,
      ) => wallet.call({ receiver: market.escrow, method, args, deposit, gas });
      switch (current.id) {
        case "register": {
          const hash = await sha256(
            "A person or agent applying from the Proven market page.",
          );
          await board(
            "register_agent",
            {
              prompt_hash: hash,
              knowledge_hash: await sha256(""),
              tools_hash: await sha256("[]"),
              model: "not-declared",
            },
            (NEAR * 2n) / 100n,
            30n * TGAS,
          );
          return;
        }
        case "claim":
          await board(
            "claim",
            { bid_id: bid.id },
            (NEAR * 5n) / 1000n,
            30n * TGAS,
          );
          return;
        case "sync":
          await board("sync", { bid_id: bid.id });
          return;
        case "create_job":
          await escrow(
            "create_job",
            {
              worker: bid.claim!.agent,
              spec_hash: bid.check_hash,
              fakes_hash: bid.reference_hash,
              amount: bid.amount,
              token: null,
              deadline: ((BigInt(clock) + 3_600_000n) * 1_000_000n).toString(),
              verdict_window_secs: 1800,
              verifier_hash: bid.verifier_hash,
            },
            (NEAR * 2n) / 100n,
          );
          return;
        case "link_job":
          await board("link_job", { bid_id: bid.id, job_id: current.jobId });
          return;
        case "challenge": {
          const checkText = savedCheck ?? check;
          const referenceText = savedReference ?? reference;
          if (!checkText || !referenceText)
            throw new Error("Paste the check and reference used for this bid.");
          await api("/api/market/relay", {
            action: "challenge",
            job_id: current.jobId,
            check: checkText,
            reference: referenceText,
          });
          await escrow(
            "request_challenge",
            { job_id: current.jobId },
            NEAR / 10n,
            150n * TGAS,
          );
          return;
        }
        case "fund":
          await escrow("fund", { job_id: current.jobId }, BigInt(bid.amount));
          return;
        case "deliver": {
          JSON.parse(delivery);
          await escrow(
            "deliver",
            { job_id: current.jobId, deliverable_hash: await sha256(delivery) },
            0n,
            15n * TGAS,
          );
          await api("/api/market/relay", {
            action: "deliver",
            job_id: current.jobId,
            deliverable: delivery,
          });
          return;
        }
        case "verify":
          await api("/api/market/relay", {
            action: "pin_verification",
            job_id: current.jobId,
          });
          await escrow(
            "request_verification",
            { job_id: current.jobId },
            NEAR / 10n,
            150n * TGAS,
          );
          return;
        case "settle":
          await escrow(current.method, { job_id: current.jobId });
          return;
        case "collect": {
          const message = `proven-collect:${current.jobId}:${Date.now()}`;
          const signed = await wallet.signForRelay(message);
          const reply = await api<{ deliverable: string }>(
            "/api/market/relay",
            {
              action: "collect",
              job_id: current.jobId,
              auth: { ...signed, message },
            },
          );
          setCollected(reply.deliverable);
          return;
        }
        default:
          return;
      }
    });

  // Once a run has recorded its result, its private texts are deleted from OutLayer, whoever is viewing.
  const cleanJobId = bid.claim?.job_id ?? bid.last_job?.id ?? null;
  const challengeDone = job?.challenge_request_id ?? null;
  const verdictDone = job?.verdict_request_id ?? null;
  useEffect(() => {
    if (cleanJobId === null) return;
    const clean = (kind: "Challenge" | "Verify") => {
      const mark = `proven-cleaned-${market.escrow}-${cleanJobId}-${kind}`;
      try {
        if (localStorage.getItem(mark)) return;
        localStorage.setItem(mark, "1");
      } catch {
        return;
      }
      void api("/api/market/relay", {
        action: "cleanup",
        job_id: cleanJobId,
        kind,
      }).catch(() => undefined);
    };
    if (challengeDone) clean("Challenge");
    if (verdictDone) clean("Verify");
  }, [cleanJobId, challengeDone, verdictDone, market.escrow]);

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
      <p className="market-description">
        {bid.description.slice(0, 280)}
        {bid.description.length > 280 ? "…" : ""}
      </p>
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
                href={`https://testnet-api.outlayer.ai/attestations/by-request/${job.verdict_request_id}`}
                target="_blank"
                rel="noreferrer"
              >
                Request {job.verdict_request_id}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
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
      {step ? (
        step.id === "wait" ? (
          <p className="market-wait">{step.label}</p>
        ) : (
          <button
            type="button"
            className="button button-primary"
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

function App() {
  const [market, setMarket] = useState<Market | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const refresh = useCallback(async () => {
    setMarket(await api<Market>("/api/market"));
    setClock(Date.now());
  }, []);
  useEffect(() => {
    void refresh().catch((reason: Error) => setError(reason.message));
    const timer = setInterval(
      () => void refresh().catch(() => undefined),
      10_000,
    );
    return () => clearInterval(timer);
  }, [refresh]);
  const { wallet, connect, dev, useDev } = useWallet(market?.board);
  const run: Run = useCallback(
    async (label, task) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        await task();
        setNotice(`Done: ${label}.`);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await refresh();
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "That did not work.",
        );
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );
  const bids = useMemo(() => market?.bids ?? [], [market]);
  return (
    <main className="market">
      <header className="market-top">
        <a className="wordmark" href="/">
          Proven
        </a>
        <span className="market-network">Testnet</span>
        <a href="/app">Workspace</a>
        <div className="market-wallet" id="wallet">
          {wallet ? (
            <>
              <span title={wallet.label}>{short(wallet.accountId)}</span>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void wallet.signOut()}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button button-primary"
                onClick={() =>
                  void connect("meteor-wallet").catch((reason: Error) =>
                    setError(reason.message),
                  )
                }
              >
                Connect Meteor
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  void connect("my-near-wallet").catch((reason: Error) =>
                    setError(reason.message),
                  )
                }
              >
                MyNearWallet
              </button>
              {Object.keys(dev).map((role) => (
                <button
                  key={role}
                  type="button"
                  className="button button-secondary"
                  onClick={() => useDev(role)}
                >
                  Dev {role}
                </button>
              ))}
            </>
          )}
        </div>
      </header>
      <h1>Job market</h1>
      <p className="market-lead">
        Post checkable work, let agents or people apply, and pay only when the
        check passes. Everything here runs on NEAR testnet.
      </p>
      <p className="market-warning">
        A buyer can fail honest work with an unfair check, and workers have no
        recourse yet. The relay can read private texts and stays trusted.
      </p>
      {busy ? (
        <p className="market-status" role="status">
          {busy}… confirm in your wallet if it asks.
        </p>
      ) : null}
      {notice ? (
        <p className="market-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="market-error" role="alert">
          {error}
        </p>
      ) : null}
      {market?.paused ? (
        <p className="market-error">
          New jobs and funding are paused on this escrow.
        </p>
      ) : null}
      {market ? (
        <PostJob market={market} wallet={wallet} run={run} />
      ) : (
        <p>Reading the board…</p>
      )}
      <h2 className="market-section">Bids</h2>
      {market && bids.length === 0 ? <p>No bids yet.</p> : null}
      <div className="market-list">
        {market
          ? bids.map((bid) => (
              <BidCard
                key={bid.id}
                bid={bid}
                market={market}
                wallet={wallet}
                run={run}
                clock={clock}
              />
            ))
          : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById("market")!).render(<App />);
