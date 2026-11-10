import { useEffect, useState } from "react";
import type { Run, Wallet } from "./market-types.ts";
import { NEAR } from "./market-types.ts";
import { api, randomNonce, short } from "./market-client.ts";
import { parseNearAmount } from "./near-amount.ts";
import { COIN, OUTLAYER_API } from "./network.ts";
import {
  base64,
  challenge as claimChallenge,
  claimMessage,
  fromHex,
  hex,
  postingMessage,
  signatureBytes,
  type KeyPair,
  type PostTerms,
  type Signing,
} from "./bounty-keys.ts";
import {
  keyPair,
  submitCheck,
  type KeyConfirmState,
} from "./key-confirm-state.ts";
import { BackupSigner, KeyConfirm } from "./KeyConfirm.tsx";
import { browserStore, loadCandidates, loadDraft } from "./key-draft.ts";
import { useKeyDraft } from "./use-key-draft.ts";
import { postingAttachment } from "./bounty-costs.ts";
import { VaultPanel } from "./VaultPanel.tsx";
import {
  STATUS_TEXT,
  deliveredFrom,
  kindLabel,
  loadHistory,
  reconcileWindow,
  settlementStatus,
  type SettlementView,
} from "./vault-view.ts";

const TGAS = 10n ** 12n;
const RUN_GAS = 300n * TGAS;
const PATH = "/api/market/bounties";

const GIST_ID = /^[0-9a-f]{1,64}$/;
interface Bounty {
  buyer: string;
  reward: string;
  budget: string;
  sponsored_runs: number;
  repo: string;
  repo_id: string;
  issue: number;
  base_ref: string;
  contributor_github_id: string;
  claim_by: string;
  bind_by: string;
  merge_deadline: string;
  grace_secs: string;
  status:
    | "Open"
    | "Claimed"
    | "Bound"
    | "Paid"
    | "Ineligible"
    | "Refunded"
    | "Cancelled";
  maintainer_keys: KeyPair;
  maintainer_vault: string;
  claim: {
    wallet: string;
    github_id: string;
    gist_id: string;
    request_id: string;
    keys: KeyPair;
    vault: string;
  } | null;
  binding: {
    pr_number: number;
    pr_id: string;
    bound_at: string;
    request_id: string;
  } | null;
  merge: { merged_at: string; request_id: string } | null;
  live: { seq: string; kind: string; requested_at: string } | null;
  last_check: {
    kind: string;
    outcome: string;
    request_id: string | null;
    resolved_at: string;
  } | null;
  payout: SettlementView | null;
  budget_return: SettlementView | null;
  refund: SettlementView | null;
}
interface Config {
  owner: string;
  network: string;
  verifier_url: string;
  verifier_hash: string;
  pilot_repo: string;
  pilot_repo_id: string;
  vault_code_hash: string;
  sponsor: string;
  paused: boolean;
  max_reward: string;
  max_held: string;
  held: string;
  run_deposit: string;
  budget: string;
  sponsored_runs_per_bounty: number;
  sponsor_float: string;
  storage_deposit: string;
  reconcile_deposit: string;
  party_reconcile_delay_secs: number;
  open_reconcile_delay_secs: number;
}
type Listing =
  | { configured: false }
  | {
      configured: true;
      contract: string;
      config: Config;
      bounties: [number, Bounty][];
    };

function near(yocto: string | bigint): string {
  const value = BigInt(yocto);
  const fraction = (value % NEAR)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${value / NEAR}${fraction ? `.${fraction.slice(0, 6)}` : ""} ${COIN}`;
}
const utc = (secs: string | number) =>
  new Date(Number(secs) * 1000)
    .toISOString()
    .replace(".000Z", " UTC")
    .replace("T", " ");
const attestation = (id: string) =>
  `${OUTLAYER_API}/attestations/by-request/${id}`;
const nowSecs = () => Math.floor(Date.now() / 1000);
/** The contract takes base64 signatures; a pasted one may be base58 or hex. */
const sigB64 = (text: string) => base64(signatureBytes(text));

function Evidence({
  id,
  label,
}: {
  id: string | null | undefined;
  label: string;
}) {
  if (!id) return null;
  return (
    <a href={attestation(id)} target="_blank" rel="noreferrer">
      {label} {id}
    </a>
  );
}

/** Wherever sponsored checks or the merge-check budget appear (Requirement 2.13, 5.4). */
export function SponsorNote({ config }: { config: Config }) {
  return (
    <>
      Sponsored checks are paid by the owner's sponsor float, and their unused
      compute returns to the owner's sponsor account{" "}
      <code>{config.sponsor}</code>. The maintainer's {near(config.budget)}{" "}
      returns in full to the maintainer's vault.
    </>
  );
}

function PostBounty({
  contract,
  config,
  wallet,
  run,
  busy,
  done,
}: {
  contract: string;
  config: Config;
  wallet: Wallet;
  run: Run;
  busy: boolean;
  done: () => void;
}) {
  const [form, setForm] = useState({
    reward: "0.1",
    issue: "",
    base_ref: "main",
    github_id: "",
    claim_hours: "24",
    bind_hours: "48",
    merge_hours: "168",
    grace_minutes: "60",
  });
  // Proofs prepared before the backup account signed come back with the terms they cover.
  const [frozen, setFrozen] = useState<{
    terms: PostTerms;
    nonce: Uint8Array;
  } | null>(() => {
    const d = loadDraft(browserStore(), contract, "post", nowSecs());
    return d && d.state.actor === wallet.accountId && d.frozen
      ? { terms: d.frozen.terms as PostTerms, nonce: fromHex(d.frozen.nonce) }
      : null;
  });
  const postingText = (state: KeyConfirmState, signing: Signing) => {
    const pair = keyPair(state);
    return frozen && pair && state.actor && state.expiresAt
      ? postingMessage(
          config.network,
          contract,
          state.actor,
          frozen.nonce,
          frozen.terms,
          pair,
          state.expiresAt,
          signing,
        )
      : "";
  };
  const draft = useKeyDraft({
    contract,
    scope: "post",
    role: "maintainer",
    connected: wallet.accountId,
    messages: (state) =>
      postingText(state, "primary")
        ? {
            primary: postingText(state, "primary"),
            backup: postingText(state, "backup"),
          }
        : null,
    frozen: frozen ? { terms: frozen.terms, nonce: hex(frozen.nonce) } : null,
  });
  const { state: keys, dispatch } = draft;
  const set =
    (key: keyof typeof form) => (event: { target: { value: string } }) => {
      setForm({ ...form, [key]: event.target.value });
      setFrozen(null);
      dispatch({ type: "clear" });
    };
  const budget = BigInt(config.budget);
  const storage = BigInt(config.storage_deposit);
  const room = BigInt(config.max_held) - BigInt(config.held);
  let reward = 0n;
  try {
    reward = parseNearAmount(form.reward, BigInt(config.max_reward));
  } catch {
    reward = 0n;
  }
  const complete =
    reward > 0n &&
    reward + budget <= room &&
    /^[0-9]{1,10}$/.test(form.issue) &&
    /^[0-9]{1,20}$/.test(form.github_id.trim()) &&
    form.base_ref.trim() !== "";
  /** Fixes the terms with absolute deadlines and a fresh nonce that the contract has not seen. */
  async function freeze() {
    const now = nowSecs();
    const hours = (h: string) => String(now + Math.round(Number(h) * 3600));
    const nonce = randomNonce();
    const { used } = await api<{ used: boolean }>(
      `${PATH}/nonce/${wallet.accountId}/${hex(nonce)}`,
    );
    if (used) return false;
    setFrozen({
      nonce,
      terms: {
        reward: reward.toString(),
        repo: config.pilot_repo,
        repo_id: config.pilot_repo_id,
        issue: Number(form.issue),
        base_ref: form.base_ref.trim(),
        contributor_github_id: form.github_id.trim(),
        claim_by: hours(form.claim_hours),
        bind_by: hours(form.bind_hours),
        merge_deadline: hours(form.merge_hours),
        grace_secs: String(Math.round(Number(form.grace_minutes) * 60)),
      },
    });
    return true;
  }
  const check = submitCheck(keys, wallet.accountId, nowSecs());
  const submit = () =>
    run("Posting the bounty", async () => {
      const now = submitCheck(keys, wallet.accountId, nowSecs());
      const pair = keyPair(keys);
      if (!now.ok || !frozen || !pair) {
        if (!now.ok) dispatch({ type: "refused", check: now });
        return;
      }
      const { primary, backup } = keys.proofs;
      await wallet.call({
        receiver: contract,
        method: "post_bounty",
        args: {
          terms: frozen.terms,
          keys: pair,
          proof: {
            nonce: hex(frozen.nonce),
            expires_at: String(keys.expiresAt),
            primary_signature: sigB64(primary?.signature ?? ""),
            backup_signature: sigB64(backup?.signature ?? ""),
          },
        },
        deposit: postingAttachment(config, BigInt(frozen.terms.reward)).total,
        gas: 100n * TGAS,
      });
      draft.finish();
      setFrozen(null);
      done();
    });
  return (
    <section className="workspace-card">
      <h2>Post a bounty</h2>
      <p>
        You are the maintainer. You choose the contributor by their numeric
        GitHub id, nominate their pull request, and decide whether to merge it.
        The contract pays their vault if a check finds it merged into{" "}
        <code>{form.base_ref || "the branch"}</code> before the deadline.
      </p>
      <p>
        This pilot pays only for issues of{" "}
        <a
          href={`https://github.com/${config.pilot_repo}`}
          target="_blank"
          rel="noreferrer"
        >
          {config.pilot_repo}
        </a>{" "}
        (GitHub repository id {config.pilot_repo_id}), fixed when the contract
        was deployed.
      </p>
      <div className="bounty-form">
        <label>
          Issue number
          <input
            value={form.issue}
            onChange={set("issue")}
            inputMode="numeric"
          />
        </label>
        <label>
          Target branch
          <input value={form.base_ref} onChange={set("base_ref")} />
        </label>
        <label>
          Contributor's GitHub user id
          <input
            value={form.github_id}
            onChange={set("github_id")}
            inputMode="numeric"
          />
        </label>
        <label>
          Reward ({COIN}, at most {near(config.max_reward)})
          <input
            value={form.reward}
            onChange={set("reward")}
            inputMode="decimal"
          />
        </label>
        <label>
          Claim within (hours)
          <input
            value={form.claim_hours}
            onChange={set("claim_hours")}
            inputMode="decimal"
          />
        </label>
        <label>
          Nominate within (hours)
          <input
            value={form.bind_hours}
            onChange={set("bind_hours")}
            inputMode="decimal"
          />
        </label>
        <label>
          Merge before (hours from now)
          <input
            value={form.merge_hours}
            onChange={set("merge_hours")}
            inputMode="decimal"
          />
        </label>
        <label>
          Grace for checking (minutes, 10 to 1440)
          <input
            value={form.grace_minutes}
            onChange={set("grace_minutes")}
            inputMode="numeric"
          />
        </label>
      </div>
      <KeyConfirm
        wallet={wallet}
        contract={contract}
        vaultCodeHash={config.vault_code_hash}
        role="maintainer"
        state={keys}
        dispatch={dispatch}
        busy={busy}
        canPrepare={complete}
        onPrepare={freeze}
        candidates={loadCandidates(browserStore(), contract)}
        message={(pair, signing, actor, expiresAt) =>
          postingText(
            {
              ...keys,
              primary: pair.primary,
              backup: pair.backup,
              actor,
              expiresAt,
            },
            signing,
          )
        }
      />
      {frozen ? (
        <p>
          The proofs cover issue #{frozen.terms.issue} on{" "}
          <code>{frozen.terms.base_ref}</code>, reward{" "}
          {near(frozen.terms.reward)}, claim by {utc(frozen.terms.claim_by)},
          merge before {utc(frozen.terms.merge_deadline)}. Editing the form asks
          for new proofs.
        </p>
      ) : null}
      <p>
        You attach {near(reward + budget + storage)}: the reward {near(reward)},{" "}
        {near(budget)} reserved for merge checks, which returns in full to your
        vault (<SponsorNote config={config} />
        ), and {near(storage)} for storage, which pays for the record and the
        vaults and is not returned. The contract can reserve{" "}
        {near(room > 0n ? room : 0n)} more; payouts and refunds count until
        their deposit into the vault is confirmed.
      </p>
      <button
        type="button"
        className="button button-primary"
        disabled={busy || !frozen || !check.ok}
        onClick={() => void submit()}
      >
        Post and lock{" "}
        {near(
          postingAttachment(
            config,
            frozen ? BigInt(frozen.terms.reward) : reward,
          ).total,
        )}
      </button>
    </section>
  );
}

/** The gist id from an id or a gist link such as https://gist.github.com/<user>/<id>. */
function gistId(input: string): string {
  const path = input.trim().split(/[?#]/)[0] ?? "";
  return (path.split("/").filter(Boolean).pop() ?? "").toLowerCase();
}

function ClaimAction({
  contract,
  id,
  bounty,
  wallet,
  run,
  busy,
  config,
  done,
}: {
  contract: string;
  id: number;
  bounty: Bounty;
  wallet: Wallet;
  run: Run;
  busy: boolean;
  config: Config;
  done: () => void;
}) {
  const claimText = (state: KeyConfirmState, signing: Signing) => {
    const p = keyPair(state);
    return p && state.actor && state.expiresAt
      ? claimMessage(
          config.network,
          contract,
          state.actor,
          id,
          bounty.contributor_github_id,
          p,
          state.expiresAt,
          signing,
        )
      : "";
  };
  const draft = useKeyDraft({
    contract,
    scope: `claim:${id}`,
    role: "contributor",
    connected: wallet.accountId,
    messages: (state) =>
      claimText(state, "primary")
        ? {
            primary: claimText(state, "primary"),
            backup: claimText(state, "backup"),
          }
        : null,
    frozen: null,
  });
  const { state: keys, dispatch } = draft;
  const [challenge, setChallenge] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [gist, setGist] = useState("");
  const pair = keyPair(keys);
  const proved = !!(keys.proofs.primary && keys.proofs.backup);
  useEffect(() => {
    setChallenge("");
    setMismatch(false);
    if (!pair || !proved || !keys.expiresAt) return;
    const local = claimChallenge(
      {
        network: config.network,
        contract,
        bounty: id,
        repo: bounty.repo,
        repo_id: bounty.repo_id,
        issue: bounty.issue,
        wallet: wallet.accountId,
        github_id: bounty.contributor_github_id,
        expires_at: keys.expiresAt,
      },
      pair,
    );
    const route = [
      id,
      wallet.accountId,
      keys.expiresAt,
      pair.primary,
      pair.backup,
    ]
      .map((p) => encodeURIComponent(String(p)))
      .join("/");
    void api<{ challenge: string }>(`${PATH}/challenge/${route}`).then(
      (reply) => {
        // The page and the contract must agree before anyone publishes a gist.
        if (reply.challenge === local) setChallenge(local);
        else setMismatch(true);
      },
    );
  }, [
    pair?.primary,
    pair?.backup,
    proved,
    keys.expiresAt,
    id,
    wallet.accountId,
  ]);
  const check = submitCheck(keys, wallet.accountId, nowSecs());
  const prove = () =>
    run("Checking your claim gist", async () => {
      const now = submitCheck(keys, wallet.accountId, nowSecs());
      if (!now.ok || !pair) {
        if (!now.ok) dispatch({ type: "refused", check: now });
        return;
      }
      await wallet.call({
        receiver: contract,
        method: "prove_claim",
        args: {
          bounty_id: id,
          gist_id: gistId(gist),
          expires_at: String(keys.expiresAt),
          keys: pair,
          primary_signature: sigB64(keys.proofs.primary?.signature ?? ""),
          backup_signature: sigB64(keys.proofs.backup?.signature ?? ""),
        },
        deposit: BigInt(config.run_deposit),
        gas: RUN_GAS,
      });
      draft.finish();
      done();
    });
  return (
    <div className="bounty-action">
      <h4>
        Claim, as the contributor (GitHub id {bounty.contributor_github_id})
      </h4>
      <KeyConfirm
        wallet={wallet}
        contract={contract}
        vaultCodeHash={config.vault_code_hash}
        role="contributor"
        state={keys}
        dispatch={dispatch}
        busy={busy}
        candidates={loadCandidates(browserStore(), contract)}
        message={(p, signing, actor, expiresAt) =>
          claimMessage(
            config.network,
            contract,
            actor,
            id,
            bounty.contributor_github_id,
            p,
            expiresAt,
            signing,
          )
        }
      />
      {mismatch ? (
        <p role="alert">
          The page and the contract computed different claim challenges. Do not
          publish a gist; reload the page.
        </p>
      ) : null}
      {challenge && keys.expiresAt ? (
        <>
          <p>
            Signed in to GitHub as the account with id{" "}
            {bounty.contributor_github_id}, create a{" "}
            <a href="https://gist.github.com/" target="_blank" rel="noreferrer">
              gist
            </a>{" "}
            (secret or public) with exactly one file whose whole text is the
            line below, and prove it before {utc(keys.expiresAt)}. Only you can
            edit your gist, so repository writers cannot claim for you. The
            challenge names this wallet, {short(wallet.accountId)}, this bounty,
            repository and issue, and your two keys; the payout goes to their
            vault. Keep the gist until the claim is proved.
          </p>
          <pre className="bounty-challenge">{challenge}</pre>
          <label>
            The gist's id or link (the hex id at the end of its address)
            <input
              value={gist}
              onChange={(e) => setGist(e.target.value)}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || !GIST_ID.test(gistId(gist)) || !check.ok}
            onClick={() => void prove()}
          >
            Prove the claim ({near(config.run_deposit)}, unused compute
            returned)
          </button>
        </>
      ) : null}
    </div>
  );
}

type SettlementSlot = [
  "Payout" | "BudgetReturn" | "Refund",
  SettlementView | null,
];
const slots = (b: Bounty): SettlementSlot[] => [
  ["Payout", b.payout],
  ["BudgetReturn", b.budget_return],
  ["Refund", b.refund],
];

function Actions({
  contract,
  id,
  bounty,
  wallet,
  run,
  busy,
  config,
  done,
}: {
  contract: string;
  id: number;
  bounty: Bounty;
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
  config: Config;
  done: () => void;
}) {
  const [pr, setPr] = useState("");
  if (!wallet)
    return (
      <p className="workspace-empty">Connect a wallet to act on this bounty.</p>
    );
  const call = (
    label: string,
    method: string,
    args: Record<string, unknown>,
    deposit: bigint,
    gas = RUN_GAS,
  ) =>
    run(label, async () => {
      await wallet.call({
        receiver: contract,
        method,
        args,
        deposit,
        gas,
      });
      done();
    });
  const isBuyer = wallet.accountId === bounty.buyer;
  const isContributor = wallet.accountId === bounty.claim?.wallet;
  const runCost = BigInt(config.run_deposit);
  const sponsoredLeft =
    config.sponsored_runs_per_bounty - bounty.sponsored_runs;
  const now = nowSecs();
  const present = slots(bounty).filter(
    (s): s is [SettlementSlot[0], SettlementView] => !!s[1],
  );
  const due = present.some(([, s]) => s.state === "Due");
  const recoverable = present.filter(
    ([, s]) => s.state === "InFlight" && s.outcome !== "Unknown",
  );
  const reconcilable = present.filter(([, s]) => {
    const w = reconcileWindow(
      s,
      now,
      config.party_reconcile_delay_secs,
      config.open_reconcile_delay_secs,
    );
    if (!w || s.outcome !== "Unknown") return false;
    return (isBuyer || isContributor ? w.party : w.anyone) === 0;
  });
  const ended =
    bounty.status === "Ineligible" ||
    (bounty.status === "Open" && now >= Number(bounty.claim_by) + 15 * 60) ||
    (bounty.status === "Claimed" && now >= Number(bounty.bind_by)) ||
    (bounty.status === "Bound" &&
      now >= Number(bounty.merge_deadline) + Number(bounty.grace_secs));
  return (
    <div className="bounty-actions">
      {bounty.status === "Open" && now < Number(bounty.claim_by) ? (
        <ClaimAction
          key={wallet.accountId}
          {...{ contract, id, bounty, wallet, run, busy, config, done }}
        />
      ) : null}
      {bounty.status === "Open" && isBuyer ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call("Cancelling", "cancel", { bounty_id: id }, 0n)
          }
        >
          Cancel and refund to your vault (maintainer, before any claim)
        </button>
      ) : null}
      {bounty.status === "Claimed" &&
      isBuyer &&
      now < Number(bounty.bind_by) ? (
        <div className="bounty-action">
          <h4>Nominate the pull request, as the maintainer</h4>
          <p>
            Nominating is your decision that this pull request is the work for
            issue #{bounty.issue}. The check binds it only if it is open,
            unmerged, targets <code>{bounty.base_ref}</code> and was opened by
            GitHub id {bounty.claim?.github_id}.
          </p>
          <label>
            Pull request number
            <input
              value={pr}
              onChange={(e) => setPr(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            className="button"
            disabled={busy || !/^[0-9]{1,10}$/.test(pr)}
            onClick={() =>
              void call(
                "Checking the pull request",
                "nominate",
                { bounty_id: id, pr_number: Number(pr) },
                runCost,
              )
            }
          >
            Nominate ({near(runCost)}, unused compute returned)
          </button>
        </div>
      ) : null}
      {bounty.status === "Bound" &&
      now < Number(bounty.merge_deadline) + Number(bounty.grace_secs) ? (
        <div className="bounty-action">
          <h4>Check the merge, as anyone</h4>
          <p>
            A merge into <code>{bounty.base_ref}</code> before{" "}
            {utc(bounty.merge_deadline)} pays the contributor's vault{" "}
            {short(bounty.claim?.vault ?? "")} automatically. An open pull
            request stays pending.
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !!bounty.live}
            onClick={() =>
              void call(
                "Checking the merge",
                "check_merge",
                { bounty_id: id },
                runCost,
              )
            }
          >
            Check, paying {near(runCost)} myself
          </button>
          {isContributor && sponsoredLeft > 0 ? (
            <>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || !!bounty.live || config.sponsor_float === "0"}
                onClick={() =>
                  void call(
                    "Checking the merge",
                    "check_merge",
                    { bounty_id: id },
                    0n,
                  )
                }
              >
                Sponsored check ({sponsoredLeft} left, free to you)
              </button>
              <p>
                <SponsorNote config={config} />
                {config.sponsor_float === "0"
                  ? " The sponsor float is empty now, so only self-paid checks run; refunds, recovery and withdrawals still work."
                  : ""}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      {ended &&
      ["Open", "Claimed", "Bound", "Ineligible"].includes(bounty.status) ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call(
              "Refunding the maintainer",
              "settle",
              { bounty_id: id },
              0n,
            )
          }
        >
          Refund the maintainer's vault (anyone, no cost)
        </button>
      ) : null}
      {due ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call("Resending", "send_due", { bounty_id: id }, 0n)
          }
        >
          Send the due settlement (anyone, same vault, same amount)
        </button>
      ) : null}
      {recoverable.map(([kind]) => (
        <button
          key={kind}
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call(
              "Recording the settlement's result",
              "recover_settlement",
              { bounty_id: id, kind },
              0n,
            )
          }
        >
          Record the {kindLabel(kind)}'s result (anyone, no cost, sends nothing)
        </button>
      ))}
      {reconcilable.map(([kind, s]) => (
        <button
          key={`reconcile-${kind}`}
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() =>
            void call(
              "Asking the vault",
              "reconcile",
              { bounty_id: id, kind, attempt: s.attempt },
              BigInt(config.reconcile_deposit),
              100n * TGAS,
            )
          }
        >
          Ask the vault whether the {kindLabel(kind)} arrived (attach{" "}
          {near(config.reconcile_deposit)}; what the vault does not keep comes
          back)
        </button>
      ))}
    </div>
  );
}

function BountyCard(props: {
  contract: string;
  id: number;
  bounty: Bounty;
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
  config: Config;
  done: () => void;
  inVault: Map<string, number>;
}) {
  const { id, bounty, config, inVault } = props;
  const repo = `https://github.com/${bounty.repo}`;
  const present = slots(bounty).filter(
    (s): s is [SettlementSlot[0], SettlementView] => !!s[1],
  );
  const vaults = [
    ...new Set([bounty.maintainer_vault, bounty.claim?.vault].filter(Boolean)),
  ] as string[];
  return (
    <article className="workspace-card bounty-card">
      <div className="workspace-section-heading">
        <h3>
          Bounty {id}:{" "}
          <a
            href={`${repo}/issues/${bounty.issue}`}
            target="_blank"
            rel="noreferrer"
          >
            {bounty.repo}#{bounty.issue}
          </a>
        </h3>
        <span className="status-pill">{bounty.status}</span>
      </div>
      <dl className="workspace-review bounty-facts">
        <dt>Reward</dt>
        <dd>{near(bounty.reward)}</dd>
        <dt>Maintainer</dt>
        <dd>
          {short(bounty.buyer)}, vault{" "}
          <code>{short(bounty.maintainer_vault)}</code>
        </dd>
        <dt>Contributor</dt>
        <dd>
          GitHub id {bounty.contributor_github_id}
          {bounty.claim
            ? `, wallet ${short(bounty.claim.wallet)}, vault ${short(bounty.claim.vault)}`
            : ", not claimed"}
        </dd>
        <dt>Branch</dt>
        <dd>
          <code>{bounty.base_ref}</code> (repository id {bounty.repo_id})
        </dd>
        <dt>Deadlines</dt>
        <dd>
          claim by {utc(bounty.claim_by)}; nominate by {utc(bounty.bind_by)};
          merge before {utc(bounty.merge_deadline)}; checks until{" "}
          {utc(Number(bounty.merge_deadline) + Number(bounty.grace_secs))}
        </dd>
        <dt>Merge checks</dt>
        <dd>
          {bounty.sponsored_runs} of {config.sponsored_runs_per_bounty}{" "}
          sponsored checks used. <SponsorNote config={config} />
        </dd>
        <dt>Evidence</dt>
        <dd className="bounty-evidence">
          {bounty.claim ? (
            <>
              <a
                href={`https://gist.github.com/${bounty.claim.gist_id}`}
                target="_blank"
                rel="noreferrer"
              >
                claim gist
              </a>
              <Evidence id={bounty.claim.request_id} label="claim run" />
            </>
          ) : null}
          {bounty.binding ? (
            <>
              <a
                href={`${repo}/pull/${bounty.binding.pr_number}`}
                target="_blank"
                rel="noreferrer"
              >
                PR #{bounty.binding.pr_number}
              </a>
              <Evidence id={bounty.binding.request_id} label="binding run" />
            </>
          ) : null}
          {bounty.merge ? (
            <>
              <span>merged {utc(bounty.merge.merged_at)}</span>
              <Evidence id={bounty.merge.request_id} label="merge run" />
            </>
          ) : null}
          {bounty.last_check ? (
            <span>
              last check: {bounty.last_check.kind} →{" "}
              <code>{bounty.last_check.outcome}</code>{" "}
              <Evidence id={bounty.last_check.request_id} label="run" />
            </span>
          ) : null}
          {bounty.live ? (
            <span>a {bounty.live.kind.toLowerCase()} check is running</span>
          ) : null}
          {present.map(([kind, s]) => {
            const status = settlementStatus(
              s,
              inVault.get(s.vault) ?? 1,
              deliveredFrom(s.vault, loadHistory(s.vault, safeStorage())),
            );
            return (
              <span key={kind}>
                {kindLabel(kind)} {near(s.principal)} to vault {short(s.vault)},
                attempt {s.attempt}: {STATUS_TEXT[status]}
              </span>
            );
          })}
        </dd>
      </dl>
      <Actions {...props} />
      {vaults.map((v) => (
        <VaultPanel
          key={v}
          vault={v}
          network={config.network}
          wallet={props.wallet}
          run={props.run}
          busy={props.busy}
          near={near}
          shared={inVault.get(v) ?? 0}
        />
      ))}
    </article>
  );
}

const safeStorage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function PrBounties({
  wallet,
  run,
  busy,
}: {
  wallet: Wallet | null;
  run: Run;
  busy: boolean;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [poster, setPoster] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api<Listing>(PATH)
      .then(setListing)
      .catch((reason: Error) => setError(reason.message));
  }, [version]);
  useEffect(() => {
    setPoster(false);
    if (!wallet || !listing?.configured) return;
    void api<{ poster: boolean }>(`${PATH}/poster/${wallet.accountId}`).then(
      (reply) => setPoster(reply.poster),
    );
  }, [wallet, listing]);
  const done = () => setVersion((v) => v + 1);
  if (error) return <p role="alert">{error}</p>;
  if (!listing) return <p role="status">Reading the bounties…</p>;
  if (!listing.configured)
    return (
      <section className="workspace-card">
        <h2>PR bounties</h2>
        <p className="workspace-empty">
          No PR bounty contract is configured on this network yet.
        </p>
      </section>
    );
  const { contract, config, bounties } = listing;
  const runCost = BigInt(config.run_deposit);
  const budget = BigInt(config.budget);
  const storage = BigInt(config.storage_deposit);
  // How many settlements on this page went into each vault (a shared key pair shares a vault).
  const inVault = new Map<string, number>();
  for (const [, b] of bounties)
    for (const [, s] of slots(b))
      if (s) inVault.set(s.vault, (inVault.get(s.vault) ?? 0) + 1);
  return (
    <>
      <section className="workspace-card">
        <h2>
          PR bounties: automatic payout after an attested GitHub merge check
        </h2>
        <p>
          GitHub supplies the facts. The maintainer decides whether to merge.
          The contract <code>{contract}</code> relies on OutLayer's
          authenticated result and its approved workers, running Proven's
          verifier pinned at <code>{config.verifier_hash.slice(0, 12)}…</code>.
          Anyone can check a run's Intel quote independently from its
          attestation link. Proven checks the merge, not the quality of the work
          or whether the pull request solves the issue: the maintainer's
          nomination says that. This job type does not use the check challenge
          of Proven's data and function jobs.
        </p>
        <p>
          Payouts and refunds go to vaults that two keys control, not to account
          names; either key alone can withdraw. Every check attaches{" "}
          {near(runCost)}; OutLayer keeps about 0.0011 and returns the rest to
          whoever paid. A bounty locks its reward, {near(budget)} reserved for
          merge checks, and {near(storage)} of storage.{" "}
          <SponsorNote config={config} /> Pilot: one public repository,{" "}
          <code>{config.pilot_repo}</code> (id {config.pilot_repo_id}),
          maintainers on the owner's allowlist
          {config.paused ? "; posting is paused" : ""}. A contributor proves
          their GitHub account with a gist they own, not with a comment.
        </p>
      </section>
      {wallet ? (
        <BackupSigner wallet={wallet} contract={contract} busy={busy} />
      ) : null}
      {wallet && poster && !config.paused ? (
        <PostBounty
          key={wallet.accountId}
          contract={contract}
          config={config}
          wallet={wallet}
          run={run}
          busy={busy}
          done={done}
        />
      ) : null}
      {bounties.length === 0 ? (
        <p className="workspace-empty">No bounties yet.</p>
      ) : null}
      {bounties
        .slice()
        .reverse()
        .map(([id, bounty]) => (
          <BountyCard
            key={id}
            {...{
              contract,
              id,
              bounty,
              wallet,
              run,
              busy,
              config,
              done,
              inVault,
            }}
          />
        ))}
    </>
  );
}
