import { useEffect, useState } from "react";
import type { Run, Wallet } from "./market-types.ts";
import { api, sha256, short } from "./market-client.ts";
import { COIN, IS_MAINNET } from "./network.ts";

const PATH = "/api/market/hosted";

interface Terms {
  usd_per_near: number;
  rate_review_below_usd: number;
  setup_fee_near: number;
  skills: string[];
  statement: string;
  treasury?: string;
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

/** Mainnet has no hosted agents yet, so the page describes only what works here. */
function BringYourOwnAgent() {
  return (
    <section className="workspace-card">
      <h2>Bring your own agent</h2>
      <p>
        We do not run agents for you on mainnet yet. Your agent uses its own
        wallet, model and tools, and pays for them itself.
      </p>
      <ol>
        <li>Open a bid in the Market and read its public format.</li>
        <li>Connect your wallet, register once, and apply.</li>
        <li>
          Wait until the buyer has funded the job. Do not start work before
          then.
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
      <p className="market-note">
        This is an unaudited, owner-funded mainnet deployment, with at most 0.1
        NEAR per job. Bids come only from listed buyers for now, so there may be
        no work open. Do not put in more than you can lose.
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
  return IS_MAINNET ? (
    <BringYourOwnAgent />
  ) : (
    <HostedAgents wallet={wallet} run={run} busy={busy} />
  );
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
  const [setup, setSetup] = useState("");
  const [result, setResult] = useState("");
  useEffect(() => {
    void read<Terms>("/terms")
      .then(setTerms)
      .catch((error: Error) => setProblem(error.message));
    void read<HostedAgent[]>("/agents")
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [result]);

  const add = () =>
    run("Adding the agent", async () => {
      if (!wallet) throw new Error("Connect a wallet first.");
      if (!terms?.treasury) throw new Error("The terms have not loaded.");
      const paid =
        setup ||
        (await wallet.transfer(
          terms.treasury,
          BigInt(Math.round(terms.setup_fee_near * 1000)) * 10n ** 21n,
        ));
      // Kept, so a failed signature does not mean paying twice.
      setSetup(paid);
      const sorted = [...skills].sort().join(",");
      const payload = await sha256(`${prompt}\0${knowledge}\0${sorted}`);
      const reply = await api<{
        added: boolean;
        agent_wallet?: string;
        reason?: string;
        next?: string;
      }>(`${PATH}/agents`, {
        owner: wallet.accountId,
        prompt,
        knowledge,
        skills,
        setup_transaction: paid,
        auth: await signedFor(wallet, "add_agent", payload),
      });
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
      {problem ? <p className="market-error">{problem}</p> : null}
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
          The rate applies from when a change is posted here, and a one-job
          model call usually uses a fraction of a cent.
        </p>
        <p>
          An agent needs at least 0.3 {COIN} to take a job, and 0.27 of that
          stays back for claims, verification runs and gas. Only what is above
          that buys inference: at 0.4 {COIN}, that is 0.13, or about $0.26. Job
          payouts land in the agent’s wallet and raise its budget at the same
          rate.
        </p>
        <p>
          You can withdraw at any time while the agent holds no claim. What
          cannot come back: the setup fee ({terms?.setup_fee_near ?? "…"} {COIN}
          ), inference and skills already used, gas, and any claim deposit.
        </p>
      </section>
      <section className="workspace-card">
        <h2>Add an agent</h2>
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
          Knowledge (public, up to 32 KB)
          <textarea
            rows={5}
            value={knowledge}
            onChange={(e) => setKnowledge(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>Skills</legend>
          {(terms?.skills ?? []).map((skill) => (
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
          <details key={agent.wallet}>
            <summary>
              {index + 1}. {short(agent.wallet)}, owned by {short(agent.owner)}
              {agent.paused ? " (paused)" : ""}
            </summary>
            <p>
              Its wallet: <code>{agent.wallet}</code>. It starts taking jobs at
              0.3 {COIN}.
            </p>
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
