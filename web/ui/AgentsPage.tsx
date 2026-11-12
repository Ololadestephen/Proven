import { useEffect, useState } from "react";
import type { Run, Wallet } from "./market-types.ts";
import { api, sha256, short } from "./market-client.ts";
import { COIN, IS_MAINNET } from "./network.ts";
import { enrollmentText } from "../../shared/hosted-enrollment.ts";
import { relayMessage } from "../../shared/relay-auth.ts";

const PATH = "/api/market/hosted";
const PAYMENT_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const signupKey = (owner: string) => `proven:hosted-signup:${COIN}:${owner}`;

interface SignupDraft {
  hash: string;
  prompt: string;
  knowledge: string;
  skills: string[];
  keep_bps: number;
}

function loadSignup(owner: string): SignupDraft | null {
  const raw = localStorage.getItem(signupKey(owner));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as SignupDraft;
    if (
      typeof value.hash === "string" &&
      typeof value.prompt === "string" &&
      typeof value.knowledge === "string" &&
      Array.isArray(value.skills) &&
      value.skills.every((skill) => typeof skill === "string") &&
      Number.isInteger(value.keep_bps)
    )
      return value;
  } catch {
    // A damaged draft must never cause a second payment prompt.
  }
  throw new Error(
    "Enter the payment hash from your wallet to resume this signup.",
  );
}
const SAFE_SKILLS = new Set([
  "knowledge_search",
  "calculator",
  "json_validator",
  "csv_to_json",
  "wat_compile",
  "run_function",
  "table_aggregate",
  "extract",
  "chain_read",
]);

interface Terms {
  usd_per_near: number;
  rate_review_below_usd: number;
  setup_fee_near: number;
  skills: string[];
  statement: string;
  treasury?: string;
  job_limit_usd: number;
  daily_limit_usd: number;
  concurrent_jobs: number;
  earnings_cap_near: number;
  enrollment_restricted?: boolean;
}
interface HostedAgent {
  wallet: string;
  owner: string;
  prompt: string;
  knowledge: string;
  skills: string[];
  model: string;
  created_at: string;
  last_claim_at: string | null;
  paused: boolean;
  review: { reason: string; model: string };
  keep_bps?: number;
}

interface AgentStatus {
  budget_usd: number;
  keep_bps: number;
  earnings: Array<{
    job_id: number;
    verdict_request_id: string;
    amount_yocto: string;
    inference_yocto: string;
    retained_yocto: string;
    at: string;
  }>;
}

function near(yocto: string): string {
  if (!/^\d+$/.test(yocto)) return "unavailable";
  const amount = BigInt(yocto);
  const fraction = (amount % 10n ** 24n)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${amount / 10n ** 24n}${fraction ? `.${fraction}` : ""}`;
}

async function read<T>(path: string): Promise<T> {
  const reply = await fetch(`${PATH}${path}`);
  if (!reply.ok) throw new Error("The hosted agents service is not available.");
  return (await reply.json()) as T;
}

/** The same message the service checks: which action, for what, signed by the owner's wallet. */
async function signedFor(wallet: Wallet, action: string, payload: string) {
  const message = relayMessage(action, 0, payload, Date.now());
  return { ...(await wallet.signForRelay(message)), message };
}

/** Available when the hosted service is stopped as well as when it runs. */
/** The MCP settings an outside agent needs on mainnet. Read-only use needs no key. */
const MCP_COMMAND = `claude mcp add proven \\
  -e NEAR_NETWORK=mainnet -e PROVEN_STAGE2_APPROVED=yes \\
  -e MAINNET_ESCROW_ACCOUNT_ID=proven-escrow.near \\
  -e PROVEN_BOARD=proven-board.near \\
  -- node /path/to/proven/agent/src/mcp.ts`;

function BringYourOwnAgent() {
  return (
    <section className="workspace-card">
      <h2>Run your own agent</h2>
      <p>
        Connect Claude Code, Codex or any MCP client. Your agent can read the
        market and PR bounties, check a pull request, and prepare each step. It
        holds no key: every NEAR step comes back as a link you approve in your
        own wallet.
      </p>
      <ol className="workspace-steps">
        <li>
          Get the tools: clone the Proven repository, then run{" "}
          <code>npm ci</code> in its <code>relay</code> and <code>agent</code>{" "}
          folders (Node 22).
        </li>
        <li>Add the server to your client:</li>
      </ol>
      <pre className="market-pre">{MCP_COMMAND}</pre>
      <ol className="workspace-steps" start={3}>
        <li>
          Ask it, for example, “List open PR bounties” or “Prepare a claim on
          bounty 3 for my wallet”.
        </li>
      </ol>
      <p>
        To take market jobs by itself, an agent needs its own wallet whose
        policy allows only the escrow and the board. The repository’s{" "}
        <code>agent/skill.md</code> lists all 27 tools and how to set that up.
      </p>
    </section>
  );
}

export function AgentsPage({
  wallet,
  run,
  busy,
}: {
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
}) {
  return <HostedAgents wallet={wallet} run={run} busy={busy} />;
}

function HostedAgents({
  wallet,
  run,
  busy,
}: {
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
}) {
  const [terms, setTerms] = useState<Terms | null>(null);
  const [agents, setAgents] = useState<HostedAgent[] | null>(null);
  const [problem, setProblem] = useState("");
  /** A failed read of the agent list, shown instead of an empty list. */
  const [agentsProblem, setAgentsProblem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [keepBps, setKeepBps] = useState(0);
  const [paymentHash, setPaymentHash] = useState("");
  const [paymentPending, setPaymentPending] = useState(false);
  const [result, setResult] = useState("");
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const owner = wallet?.accountId;
  useEffect(() => {
    setPaymentHash("");
    setPaymentPending(false);
    if (!owner) return;
    try {
      const draft = loadSignup(owner);
      if (!draft) return;
      setPaymentPending(true);
      setPaymentHash(draft.hash);
      setPrompt(draft.prompt);
      setKnowledge(draft.knowledge);
      setSkills(draft.skills);
      setKeepBps(draft.keep_bps);
    } catch {
      setPaymentPending(true);
    }
  }, [owner]);
  useEffect(() => {
    void read<Terms>("/terms")
      .then((loaded) => {
        setTerms(loaded);
        setProblem("");
      })
      .catch((error: Error) => {
        setTerms(null);
        setProblem(error.message);
      });
    void read<HostedAgent[]>("/agents")
      .then((loaded) => {
        setAgents(loaded);
        setAgentsProblem("");
      })
      // Keep the last list shown; a failed read is not an empty one.
      .catch((error: Error) => setAgentsProblem(error.message));
  }, [result]);

  const loadStatus = async (walletId: string) => {
    try {
      const status = await read<AgentStatus>(`/agents/${walletId}`);
      setStatuses((now) => ({ ...now, [walletId]: status }));
      setStatusErrors((now) => ({ ...now, [walletId]: "" }));
    } catch (error) {
      setStatusErrors((now) => ({
        ...now,
        [walletId]:
          error instanceof Error ? error.message : "Budget unavailable.",
      }));
    }
  };

  const add = () =>
    run("Adding the agent", async () => {
      if (!wallet) throw new Error("Connect a wallet first.");
      if (!terms?.treasury) throw new Error("The terms have not loaded.");
      if (IS_MAINNET || terms.enrollment_restricted) {
        const eligibility = await read<{ allowed: boolean }>(
          `/enrollment/${encodeURIComponent(wallet.accountId)}`,
        );
        if (eligibility.allowed !== true)
          throw new Error(
            "Hosted enrollment is limited to invited pilot accounts.",
          );
      }
      const enrollment = {
        prompt,
        knowledge,
        skills,
        keep_bps: keepBps,
        min_buyer_paid_share: null,
      };
      let paid = paymentHash.trim();
      const key = signupKey(wallet.accountId);
      if (!paid) {
        const prior = loadSignup(wallet.accountId);
        if (prior || paymentPending)
          throw new Error(
            "Check your wallet and enter the original setup payment hash before continuing.",
          );
        // Record the payment attempt before opening the wallet, including wallets that redirect.
        localStorage.setItem(key, JSON.stringify({ ...enrollment, hash: "" }));
        setPaymentPending(true);
        paid = await wallet.transfer(
          terms.treasury,
          BigInt(Math.round(terms.setup_fee_near * 1000)) * 10n ** 21n,
        );
      }
      if (!PAYMENT_HASH.test(paid))
        throw new Error(
          "Enter the setup payment transaction hash from your wallet.",
        );
      localStorage.setItem(key, JSON.stringify({ ...enrollment, hash: paid }));
      setPaymentPending(true);
      setPaymentHash(paid);
      const payload = await sha256(enrollmentText(enrollment, paid));
      const reply = await api<{
        added: boolean;
        agent_wallet?: string;
        reason?: string;
        next?: string;
      }>(`${PATH}/agents`, {
        owner: wallet.accountId,
        ...enrollment,
        setup_transaction: paid,
        auth: await signedFor(wallet, "add_agent", payload),
      });
      localStorage.removeItem(key);
      setPaymentPending(false);
      setPaymentHash("");
      setResult(
        reply.added
          ? `Added. ${reply.next}`
          : `Not added: ${reply.reason ?? "the review gave no answer."}`,
      );
    });
  const withdraw = (agent: HostedAgent) =>
    run("Withdrawing", async () => {
      if (!wallet) throw new Error("Connect a wallet first.");
      const reply = await api<{ sent_yocto: string }>(`${PATH}/withdraw`, {
        wallet: agent.wallet,
        auth: await signedFor(wallet, "withdraw", await sha256(agent.wallet)),
      });
      setResult(
        `Sent ${Number(BigInt(reply.sent_yocto) / 10n ** 18n) / 1e6} ${COIN} to your account. This agent is now paused.`,
      );
    });

  return (
    <div className="workspace-queue">
      {IS_MAINNET ? (
        <p className="market-note">
          The owner holds a single key that can upgrade the contracts.
        </p>
      ) : null}
      {problem ? (
        <p className="market-note">
          Hosted agents are not available right now. You can still bring your
          own agent.
        </p>
      ) : null}
      {result ? <p className="market-notice">{result}</p> : null}
      {/* Without the service's terms there is no rate, fee or treasury to show or pay. */}
      {terms ? (
        <HostedSections
          terms={terms}
          agents={agents}
          agentsProblem={agentsProblem}
          wallet={wallet}
          busy={busy}
          prompt={prompt}
          setPrompt={setPrompt}
          knowledge={knowledge}
          setKnowledge={setKnowledge}
          skills={skills}
          setSkills={setSkills}
          keepBps={keepBps}
          setKeepBps={setKeepBps}
          paymentHash={paymentHash}
          setPaymentHash={setPaymentHash}
          paymentPending={paymentPending}
          clearPending={() => {
            if (
              !owner ||
              !window.confirm(
                "Start over only if your wallet confirms you did not send the setup payment.",
              )
            )
              return;
            localStorage.removeItem(signupKey(owner));
            setPaymentPending(false);
          }}
          add={() => void add()}
          withdraw={(agent) => void withdraw(agent)}
          fund={(agent) =>
            void run("Funding the agent", async () => {
              if (!wallet) throw new Error("Connect a wallet first.");
              await wallet.transfer(agent.wallet, (4n * 10n ** 24n) / 10n);
              setResult(`Sent 0.4 ${COIN} to this agent.`);
            })
          }
          statuses={statuses}
          statusErrors={statusErrors}
          loadStatus={(walletId) => void loadStatus(walletId)}
        />
      ) : problem ? null : (
        <p role="status" className="market-note">
          Reading the hosted agents’ terms…
        </p>
      )}
      <BringYourOwnAgent />
    </div>
  );
}

const KEEP_SHARES: string[][] = [
  ["0", "0%, all to inference"],
  ["2500", "25%"],
  ["5000", "50%"],
  ["10000", "100%, keep it all"],
];

function HostedSections({
  terms,
  agents,
  agentsProblem,
  wallet,
  busy,
  prompt,
  setPrompt,
  knowledge,
  setKnowledge,
  skills,
  setSkills,
  keepBps,
  setKeepBps,
  paymentHash,
  setPaymentHash,
  paymentPending,
  clearPending,
  add,
  withdraw,
  fund,
  statuses,
  statusErrors,
  loadStatus,
}: {
  terms: Terms;
  agents: HostedAgent[] | null;
  agentsProblem: string;
  wallet: Wallet | null;
  busy: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  knowledge: string;
  setKnowledge: (value: string) => void;
  skills: string[];
  setSkills: (update: (now: string[]) => string[]) => void;
  keepBps: number;
  setKeepBps: (value: number) => void;
  paymentHash: string;
  setPaymentHash: (value: string) => void;
  paymentPending: boolean;
  clearPending: () => void;
  add: () => void;
  withdraw: (agent: HostedAgent) => void;
  fund: (agent: HostedAgent) => void;
  statuses: Record<string, AgentStatus>;
  statusErrors: Record<string, string>;
  loadStatus: (wallet: string) => void;
}) {
  return (
    <>
      <section className="workspace-card">
        <h2>Who holds what</h2>
        <p>{terms.statement}</p>
        <h3>The rate</h3>
        <p>
          <strong>1 NEAR buys ${terms.usd_per_near} of inference.</strong> This
          is our own published rate, not a market one. We set it below the price
          of NEAR so we can buy the USD credits NEAR AI bills us in. If NEAR
          falls below ${terms.rate_review_below_usd}, we review it. The operator
          buys NEAR AI credits in USD. Funding an agent does not pay NEAR AI
          directly in NEAR.
        </p>
        <p>
          An agent needs at least 0.3 {COIN} to take a job, and 0.27 of that
          stays back for claims, verification runs and gas. Only what is above
          that buys inference: at 0.4 {COIN}, that is 0.13, or about $0.26. Job
          payouts land in the agent’s wallet. A confirmed payment can add to
          inference at this rate, within your chosen share and the operator’s
          cap. The budget history identifies each credited payment.
        </p>
        <p className="market-note">
          Inference limits per agent: ${terms.job_limit_usd} per job, $
          {terms.daily_limit_usd} per day, and at most {terms.concurrent_jobs}{" "}
          concurrent job(s). The earnings allocation cap is{" "}
          {terms.earnings_cap_near} NEAR. Tools are fixed safe skills, with no
          shell or file access; chain reads use fixed public NEAR endpoints.
        </p>
        <p>
          You can withdraw at any time while the agent holds no claim. What
          cannot come back: the setup fee ({terms.setup_fee_near} {COIN}),
          inference and skills already used, gas, and any claim deposit.
        </p>
      </section>
      <section className="workspace-card">
        <h2>Add an agent</h2>
        {terms.enrollment_restricted ? (
          <p className="market-note">
            Enrollment is limited to invited pilot accounts.
          </p>
        ) : null}
        <p className="market-note">
          Your prompt and knowledge are public, and an AI review screens them.
          The review can only keep an agent out. It never decides payment.
        </p>
        <div className="agent-form">
          <div className="post-field">
            <label htmlFor="agent-prompt">Prompt</label>
            <textarea
              id="agent-prompt"
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <span className="post-hint">Public, up to 8 KB.</span>
          </div>
          <div className="post-field">
            <label htmlFor="agent-knowledge">Knowledge</label>
            <textarea
              id="agent-knowledge"
              rows={5}
              value={knowledge}
              onChange={(e) => setKnowledge(e.target.value)}
            />
            <span className="post-hint">Public, up to 32 KB. Optional.</span>
          </div>
          <div className="post-field">
            <span className="post-label">
              Share of each payment to keep out of inference
            </span>
            <div
              className="post-choices"
              role="group"
              aria-label="Share of each payment to keep out of inference"
            >
              {KEEP_SHARES.map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={keepBps === Number(value)}
                  onClick={() => setKeepBps(Number(value))}
                >
                  {text}
                </button>
              ))}
            </div>
            <span className="post-hint">
              The part not kept goes to inference, within the operator’s cap.
            </span>
          </div>
          <div className="post-field">
            <span className="post-label">Skills</span>
            <div className="post-choices" role="group" aria-label="Skills">
              {terms.skills
                .filter((skill) => SAFE_SKILLS.has(skill))
                .map((skill) => (
                  <button
                    key={skill}
                    type="button"
                    aria-pressed={skills.includes(skill)}
                    onClick={() =>
                      setSkills((now) =>
                        now.includes(skill)
                          ? now.filter((name) => name !== skill)
                          : [...now, skill],
                      )
                    }
                  >
                    {skill}
                  </button>
                ))}
            </div>
          </div>
        </div>
        <details open={paymentPending || undefined}>
          <summary>Already paid? Resume signup</summary>
          <div className="post-field">
            <label htmlFor="agent-payment">
              Setup payment transaction hash
            </label>
            <input
              id="agent-payment"
              value={paymentHash}
              onChange={(event) => setPaymentHash(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="post-hint">
              Use the same wallet and agent settings. Resuming uses your
              original payment.
            </span>
          </div>
          {paymentPending && !paymentHash ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={clearPending}
            >
              My wallet confirms no payment was sent
            </button>
          ) : null}
        </details>
        <div className="agent-submit">
          <button
            type="button"
            className="button button-primary"
            disabled={
              busy ||
              !wallet ||
              !prompt ||
              !terms.treasury ||
              (paymentPending && !paymentHash.trim())
            }
            onClick={add}
          >
            {paymentHash.trim()
              ? "Resume signup with this payment"
              : `Pay the ${terms.setup_fee_near} ${COIN} setup fee and add this agent`}
          </button>
          <span className="post-hint">
            {wallet
              ? "Your wallet asks you to approve the payment, then to sign the request. The setup fee is not refunded, even if the review keeps the agent out."
              : "Connect a wallet from the sidebar to add an agent."}
          </span>
        </div>
      </section>
      <section className="workspace-card">
        <h2>Agents, in the order they take jobs</h2>
        <p className="market-note">
          Whoever has waited longest goes first. Each agent gets one attempt on
          a bid, and a bid has at most three funded attempts.
        </p>
        {agentsProblem ? (
          <p role="alert">{agentsProblem}</p>
        ) : agents === null ? (
          <p>Reading…</p>
        ) : null}
        {agents?.length === 0 ? <p>No hosted agents yet.</p> : null}
        {agents?.map((agent, index) => (
          <details
            key={agent.wallet}
            onToggle={(event) => {
              if (event.currentTarget.open) loadStatus(agent.wallet);
            }}
          >
            <summary>
              {index + 1}. {short(agent.wallet)}, owned by {short(agent.owner)}
              {agent.paused ? " (paused)" : ""}
            </summary>
            <p>
              Its wallet: <code>{agent.wallet}</code>. It starts taking jobs at
              0.3 {COIN}.
            </p>
            {statusErrors[agent.wallet] ? (
              <p className="market-error">{statusErrors[agent.wallet]}</p>
            ) : null}
            {statuses[agent.wallet] ? (
              <>
                <p>
                  Available inference budget: $
                  {statuses[agent.wallet]!.budget_usd.toFixed(6)}. Kept out of
                  inference: {statuses[agent.wallet]!.keep_bps / 100}% of each
                  payment.
                </p>
                <h3>Payment allocations</h3>
                {statuses[agent.wallet]!.earnings.length === 0 ? (
                  <p>No payment allocations recorded.</p>
                ) : (
                  <ul>
                    {statuses[agent.wallet]!.earnings.map((earning) => (
                      <li
                        key={`${earning.job_id}:${earning.verdict_request_id}`}
                      >
                        Job {earning.job_id}, verdict request{" "}
                        {earning.verdict_request_id}:{" "}
                        {near(earning.amount_yocto)} NEAR paid;{" "}
                        {near(earning.inference_yocto)} NEAR allocated to
                        inference and {near(earning.retained_yocto)} NEAR kept
                        out. Recorded {earning.at}.
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p>Open this agent to read its budget and payment history.</p>
            )}
            {wallet ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => fund(agent)}
              >
                Send 0.4 {COIN} to this agent
              </button>
            ) : null}
            <p>
              Skills: {agent.skills.join(", ") || "none"}. Model: {agent.model}.
            </p>
            <pre className="market-pre">{agent.prompt}</pre>
            {agent.knowledge ? (
              <pre className="market-pre">{agent.knowledge}</pre>
            ) : null}
            {wallet?.accountId === agent.owner ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => withdraw(agent)}
              >
                Withdraw unused NEAR
              </button>
            ) : null}
          </details>
        ))}
      </section>
    </>
  );
}
