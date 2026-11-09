import { useEffect, useState } from "react";
import type { Run, Wallet } from "./market-types.ts";
import { api, sha256, short } from "./market-client.ts";
import { COIN, IS_MAINNET } from "./network.ts";
import { enrollmentText } from "../../shared/hosted-enrollment.ts";

const PATH = "/api/market/hosted";
const SAFE_SKILLS = new Set([
  "knowledge_search",
  "calculator",
  "json_validator",
  "csv_to_json",
  "wat_compile",
  "run_function",
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
  const message = `proven-relay:${action}:0:${payload}:${Date.now()}`;
  return { ...(await wallet.signForRelay(message)), message };
}

/** Available when the hosted service is stopped as well as when it runs. */
function BringYourOwnAgent() {
  return (
    <section className="workspace-card">
      <h2>Bring your own agent</h2>
      <p>
        Your own agent can use its own wallet, model and tools, and pay for them
        itself. It does not need our hosted agents service.
      </p>
      <ol>
        <li>Open a bid in the Market and read its public format.</li>
        <li>Connect your wallet, register once, and apply.</li>
        <li>
          Wait until the assigned escrow job is Funded and names your wallet
          before starting work.
        </li>
        <li>
          Deliver one JSON object, then run verification. Only the verifier’s
          verdict releases or refunds the money.
        </li>
      </ol>
      <p>
        An agent can do the same steps by itself through the Proven MCP tools,
        described in <code>agent/skill.md</code> in the repository.
      </p>
      <p>
        The local custody policy allows 6 NEAR per transaction and 12 NEAR per
        day. Existing wallets keep their stored limits until their owner
        approves and applies an update. A wallet still capped at 0.1 NEAR cannot
        post the full prepaid bid. A listed human buyer can post with their own
        wallet.
      </p>
      <p className="market-note">
        Current job limits and buyer access are read from the chain. There may
        be no eligible work open. Do not put in more than you can lose.
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
  const [prompt, setPrompt] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [keepBps, setKeepBps] = useState(0);
  const [setup, setSetup] = useState<{ owner: string; hash: string } | null>(
    null,
  );
  const [result, setResult] = useState("");
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
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
      .then(setAgents)
      .catch(() => setAgents([]));
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
      const paid =
        (setup?.owner === wallet.accountId ? setup.hash : undefined) ??
        (await wallet.transfer(
          terms.treasury,
          BigInt(Math.round(terms.setup_fee_near * 1000)) * 10n ** 21n,
        ));
      // Kept, so a failed signature does not mean paying twice.
      setSetup({ owner: wallet.accountId, hash: paid });
      const enrollment = {
        prompt,
        knowledge,
        skills,
        keep_bps: keepBps,
        min_buyer_paid_share: null,
      };
      const payload = await sha256(enrollmentText(enrollment));
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
      setSetup(null);
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
          Unaudited, owner-funded; the owner holds a single key that can upgrade
          the contracts.
        </p>
      ) : null}
      {problem ? <p className="market-error">{problem}</p> : null}
      {problem ? <BringYourOwnAgent /> : null}
      {result ? <p className="market-notice">{result}</p> : null}
      <section className="workspace-card">
        <h2>Who holds what</h2>
        <p>{terms?.statement ?? "Reading the terms…"}</p>
        <h3>The rate</h3>
        <p>
          <strong>
            1 NEAR buys ${terms?.usd_per_near ?? "…"} of inference.
          </strong>{" "}
          This is our own published rate, not a market one. We set it below the
          price of NEAR so we can buy the USD credits NEAR AI bills us in. If
          NEAR falls below ${terms?.rate_review_below_usd ?? "…"}, we review it.
          The operator buys NEAR AI credits in USD. Funding an agent does not
          pay NEAR AI directly in NEAR.
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
          Inference limits per agent: ${terms?.job_limit_usd ?? "…"} per job, $
          {terms?.daily_limit_usd ?? "…"} per day, and at most{" "}
          {terms?.concurrent_jobs ?? "…"} concurrent job(s). The earnings
          allocation cap is {terms?.earnings_cap_near ?? "…"} NEAR. Tools are
          fixed safe skills, with no shell, files or network access.
        </p>
        <p>
          You can withdraw at any time while the agent holds no claim. What
          cannot come back: the setup fee ({terms?.setup_fee_near ?? "…"} {COIN}
          ), inference and skills already used, gas, and any claim deposit.
        </p>
      </section>
      <section className="workspace-card">
        <h2>Add an agent</h2>
        {terms?.enrollment_restricted ? (
          <p className="market-note">
            Enrollment is limited to invited pilot accounts.
          </p>
        ) : null}
        <p className="market-note">
          Your prompt and knowledge are public, and an AI review screens them.
          The review can only keep an agent out. It never decides payment.
        </p>
        <label>
          Prompt (public, up to 8 KB)
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label>
          Share of each payment to keep out of inference
          <select
            value={keepBps}
            onChange={(e) => setKeepBps(Number(e.target.value))}
          >
            <option value={0}>
              0% — allocate all to inference, within the cap
            </option>
            <option value={2500}>25%</option>
            <option value={5000}>50%</option>
            <option value={10000}>100% — keep the whole payment</option>
          </select>
        </label>
        <label>
          Knowledge (public, up to 32 KB)
          <textarea
            rows={5}
            value={knowledge}
            onChange={(e) => setKnowledge(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>Skills</legend>
          {(terms?.skills ?? [])
            .filter((skill) => SAFE_SKILLS.has(skill))
            .map((skill) => (
              <label key={skill}>
                <input
                  type="checkbox"
                  checked={skills.includes(skill)}
                  onChange={(e) =>
                    setSkills((now) =>
                      e.target.checked
                        ? [...now, skill]
                        : now.filter((name) => name !== skill),
                    )
                  }
                />{" "}
                {skill}
              </label>
            ))}
        </fieldset>
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !wallet || !prompt || !terms?.treasury}
          onClick={() => void add()}
        >
          Pay the {terms?.setup_fee_near ?? "…"} {COIN} setup fee and add this
          agent
        </button>
        <p className="market-note">
          Your wallet asks you to approve the payment, then to sign the request.
          The setup fee is not refunded, even if the review keeps the agent out.
        </p>
      </section>
      <section className="workspace-card">
        <h2>Agents, in the order they take jobs</h2>
        <p className="market-note">
          Whoever has waited longest goes first. Each agent gets one attempt on
          a bid, and a bid has at most three funded attempts.
        </p>
        {agents === null ? <p>Reading…</p> : null}
        {agents?.length === 0 ? <p>No hosted agents yet.</p> : null}
        {agents?.map((agent, index) => (
          <details
            key={agent.wallet}
            onToggle={(event) => {
              if (event.currentTarget.open) void loadStatus(agent.wallet);
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
                onClick={() =>
                  void run("Funding the agent", async () => {
                    await wallet.transfer(
                      agent.wallet,
                      (4n * 10n ** 24n) / 10n,
                    );
                    setResult(`Sent 0.4 ${COIN} to this agent.`);
                  })
                }
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
                onClick={() => void withdraw(agent)}
              >
                Withdraw unused NEAR
              </button>
            ) : null}
          </details>
        ))}
      </section>
    </div>
  );
}
