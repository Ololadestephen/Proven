import { useEffect, useState, type ReactNode } from "react";
import { short } from "./market-client.ts";
import type { Call } from "./market-types.ts";
import type { Bounty, Config, WalletLink } from "./bounty-types.ts";
import type { FlowChain } from "./bounty-actions.ts";
import {
  SIGNING_OFF,
  cancelCall,
  checkMergeCall,
  claimFlow,
  discoverMessageKey,
  expireClaimCall,
  parsePullRequestInput,
  recoverSettlementCall,
  reconcileCall,
  releaseClaimCall,
  revokeClaimCall,
  sendDueCall,
  sendFlow,
  settleCall,
  submitPrCall,
  RUN_DEPOSIT,
} from "./bounty-actions.ts";
import {
  bountyStatus,
  checksUntil,
  graceEnds,
  claimEndable,
  claimExpirable,
  failedLookWarning,
  hardRefundAt,
  mergeCheckable,
  refundDue,
  utc,
} from "./bounty-status.ts";
import { attestationUrl, near } from "./bounty-text.ts";
import { fromBase58, vaultAddress } from "./bounty-keys.ts";
import type { BountyReader } from "./bounty-reconcile.ts";
import type { BountyRun, BountyWallet } from "./bounty-wallet.ts";
import { duration } from "./posting-review.ts";
import { VaultPanel } from "./VaultPanel.tsx";
import {
  kindLabel,
  reconcileWindow,
  type SettlementKind,
  type SettlementView,
} from "./vault-view.ts";

/** What the viewer's own wallet link is, as far as the page has read it. */
export type LinkLoad =
  | { state: "none" }
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; value: WalletLink | null };

export interface CardContext {
  contract: string;
  config: Config;
  /** Unix seconds. */
  now: number;
  /** False in this build: no button may sign or send. */
  approved: boolean;
  wallet: BountyWallet | null;
  run: BountyRun;
  busy: boolean;
  chain: BountyReader & FlowChain;
  /** Called after an action, so the page reads the bounties again. */
  done: () => void;
  link: LinkLoad;
}

/** A button that would ask the wallet to sign or send. Off while signing is off or an action runs. */
export function TxButton(props: {
  approved: boolean;
  busy: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`button button-${props.variant ?? "secondary"}`}
      disabled={props.busy || !props.approved || !!props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** Says why the buttons next to it are off, while signing is off. */
export function SigningNote({ approved }: { approved: boolean }) {
  return approved ? null : (
    <p className="workspace-empty signing-off" role="note">
      {SIGNING_OFF}
    </p>
  );
}

/** The refund rule, in one line, for a contributor who is about to claim. */
export function RefundNotice({
  bounty,
  config,
}: {
  bounty: Bounty;
  config: Config;
}) {
  return (
    <p className="bounty-refund-notice">
      Merge checks are accepted until{" "}
      {utc(hardRefundAt(bounty, config.refund_cap_secs))}. If no check can read
      GitHub before then, a pull request merged on time is refunded to the
      maintainer and the contributor is not paid. The refund is final.
    </p>
  );
}

function Evidence({
  id,
  label,
}: {
  id: string | null | undefined;
  label: string;
}) {
  if (!id) return null;
  return (
    <a href={attestationUrl(id)} target="_blank" rel="noreferrer">
      {label} {id}
    </a>
  );
}

// ---- Claim ----

export interface KeyCheckState {
  text: string;
  /** The vault this key's money will go to. */
  vault: string;
  key: string;
}

/** The claim step as the contributor sees it. It holds no state of its own. */
export function ClaimView(props: {
  bounty: Bounty;
  config: Config;
  approved: boolean;
  busy: boolean;
  connected: boolean;
  /** The GitHub id of the wallet's active link, or null when it has none. */
  githubId: string | null;
  /** `is_barred` for this wallet, or null when it was not read. */
  barred: boolean | null;
  keyCheck: KeyCheckState | null;
  onCheckKey: () => void;
  onClaim: () => void;
}) {
  const { bounty, config, keyCheck } = props;
  const blocked = !props.connected
    ? "Connect a wallet to claim."
    : props.barred === true
      ? "This wallet's earlier claim on this bounty ended, so it cannot claim it again."
      : props.githubId === null
        ? "Connect GitHub to this wallet first (see Your GitHub link above). A claim needs it."
        : !keyCheck
          ? "Check your wallet's key first."
          : "";
  return (
    <div className="bounty-action">
      <h4>Claim</h4>
      <RefundNotice bounty={bounty} config={config} />
      <p>
        A claim lasts {duration(Number(bounty.claim_secs))}, or until the merge
        deadline if that comes first. The pull request must be merged before{" "}
        {utc(bounty.merge_deadline)}. If you release the claim or it ends, this
        wallet cannot claim this bounty again. Claiming sends no NEAR.
      </p>
      <p>
        The money for this claim goes to a vault controlled by one key, the key
        your wallet signs messages with. Nobody can replace that key, and if it
        is lost the money cannot be recovered.
      </p>
      <TxButton
        approved={props.approved}
        busy={props.busy}
        disabled={!props.connected || props.barred === true}
        onClick={props.onCheckKey}
      >
        Check which key my wallet signs messages with
      </TxButton>
      {keyCheck ? (
        <>
          <p role="status">{keyCheck.text}</p>
          <p>
            Payouts for this claim go to vault <code>{keyCheck.vault}</code>.
          </p>
        </>
      ) : null}
      <TxButton
        variant="primary"
        approved={props.approved}
        busy={props.busy}
        disabled={blocked !== ""}
        onClick={props.onClaim}
      >
        Claim this bounty
      </TxButton>
      <SigningNote approved={props.approved} />
      {blocked ? <p className="workspace-empty">{blocked}</p> : null}
    </div>
  );
}

function ClaimSection({
  id,
  bounty,
  ctx,
}: {
  id: number;
  bounty: Bounty;
  ctx: CardContext;
}) {
  const { wallet, config, contract, approved } = ctx;
  const [keyCheck, setKeyCheck] = useState<KeyCheckState | null>(null);
  const [barred, setBarred] = useState<boolean | null>(null);
  const account = wallet?.accountId ?? "";
  useEffect(() => {
    setKeyCheck(null);
    setBarred(null);
    if (!account) return;
    let live = true;
    ctx.chain
      .barred(id, account)
      .then((value) => live && setBarred(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, account]);
  const githubId =
    ctx.link.state === "ready"
      ? (ctx.link.value?.active?.github_id ?? null)
      : null;
  const target = {
    bountyId: id,
    call: { receiver: contract, method: "claim", args: {} },
  };
  const checkKey = () =>
    wallet
      ? ctx.run("Checking your wallet's key", { bountyId: id }, async () => {
          const found = await discoverMessageKey({
            approved,
            contract,
            wallet,
          });
          setKeyCheck({
            text: found.keyCheck.text,
            key: found.key,
            vault: vaultAddress(fromBase58(config.vault_code_hash), found.key),
          });
        })
      : undefined;
  const claim = () =>
    wallet && keyCheck && githubId
      ? ctx.run("Claiming", target, async () => {
          await claimFlow({
            approved,
            contract,
            network: config.network,
            wallet,
            chain: ctx.chain,
            bountyId: id,
            githubId,
            key: keyCheck.key,
          });
          ctx.done();
        })
      : undefined;
  return (
    <ClaimView
      bounty={bounty}
      config={config}
      approved={approved}
      busy={ctx.busy}
      connected={!!wallet}
      githubId={githubId}
      barred={barred}
      keyCheck={keyCheck}
      onCheckKey={() => void checkKey()}
      onClaim={() => void claim()}
    />
  );
}

// ---- Submit ----

export function SubmitView(props: {
  bounty: Bounty;
  /** Why this wallet's link no longer matches its claim, or null. */
  linkProblem?: string | null;
  value: string;
  approved: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: (number: number) => void;
}) {
  const parsed = parsePullRequestInput(props.value, props.bounty.repo);
  return (
    <div className="bounty-action">
      <h4>Submit your pull request</h4>
      <p>
        Open the pull request on GitHub from the GitHub account you connected,
        against <code>{props.bounty.base_ref}</code> in {props.bounty.repo}.
        Then enter its number or its link here. One check reads the pull request
        and your link gist, and records the pull request, its author and your
        payout key. Submitting attaches {near(RUN_DEPOSIT)} for that check; the
        unused part comes back.
      </p>
      <label>
        Pull request number or link
        <input
          value={props.value}
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
        />
      </label>
      {props.linkProblem ? (
        <p role="alert" className="form-error">
          {props.linkProblem}
        </p>
      ) : null}
      {props.value.trim() !== "" && !parsed.ok ? (
        <p role="alert" className="form-error">
          {parsed.message}
        </p>
      ) : null}
      <TxButton
        variant="primary"
        approved={props.approved}
        busy={props.busy}
        disabled={!parsed.ok || !!props.linkProblem}
        onClick={() => parsed.ok && props.onSubmit(parsed.number)}
      >
        Submit pull request ({near(RUN_DEPOSIT)}, unused part returned)
      </TxButton>
      <SigningNote approved={props.approved} />
    </div>
  );
}

// ---- Actions ----

type SettlementSlot = [SettlementKind, SettlementView | null];
const slots = (b: Bounty): SettlementSlot[] => [
  ["Payout", b.payout],
  ["Refund", b.refund],
];
const present = (b: Bounty) =>
  slots(b).filter((s): s is [SettlementKind, SettlementView] => !!s[1]);

/** One text for the sponsored-check note, wherever it appears. */
export function sponsoredLeft(bounty: Bounty, config: Config): number {
  return Math.max(0, config.sponsored_runs_per_bounty - bounty.sponsored_runs);
}

export function Actions({
  id,
  bounty,
  ctx,
}: {
  id: number;
  bounty: Bounty;
  ctx: CardContext;
}) {
  const { wallet, config, contract, now, approved, busy } = ctx;
  const [pr, setPr] = useState("");
  const me = wallet?.accountId ?? "";
  const isBuyer = me !== "" && me === bounty.buyer;
  const isClaimant = me !== "" && me === bounty.claim?.wallet;
  const send = (label: string, built: Call, then?: () => void) =>
    wallet
      ? ctx.run(
          label,
          {
            bountyId: id,
            call: {
              receiver: built.receiver,
              method: built.method,
              args: built.args,
            },
          },
          async () => {
            await sendFlow({ approved, wallet, call: built });
            ctx.done();
            then?.();
          },
        )
      : undefined;
  const sponsored = sponsoredLeft(bounty, config);
  const due = present(bounty).some(([, s]) => s.state === "Due");
  const recoverable = present(bounty).filter(
    ([, s]) => s.state === "InFlight" && s.outcome !== "Unknown",
  );
  const reconcilable = present(bounty).filter(([, s]) => {
    const w = reconcileWindow(
      s,
      now,
      config.party_reconcile_delay_secs,
      config.open_reconcile_delay_secs,
    );
    if (!w || s.outcome !== "Unknown") return false;
    return (isBuyer || isClaimant ? w.party : w.anyone) === 0;
  });
  const canSubmit =
    bounty.status === "Claimed" &&
    isClaimant &&
    bounty.claim &&
    now < Number(bounty.claim.ends_at) &&
    claimEndable(bounty, now);
  const activeGithub =
    ctx.link.state === "ready"
      ? (ctx.link.value?.active?.github_id ?? null)
      : null;
  const linkProblem =
    ctx.link.state === "ready" &&
    bounty.claim &&
    activeGithub !== bounty.claim.github_id
      ? "Your GitHub link changed after you claimed, so this claim cannot submit. Release this claim and claim again."
      : null;
  const open = bounty.status === "Open" && now < Number(bounty.claim_by);
  const buttons: ReactNode[] = [];
  const add = (key: string, node: ReactNode) =>
    buttons.push(<span key={key}>{node}</span>);
  if (isBuyer && bounty.status === "Open")
    add(
      "cancel",
      <TxButton
        approved={approved}
        busy={busy}
        onClick={() => void send("Cancelling", cancelCall(contract, id))}
      >
        Cancel and refund to your vault (maintainer, only before a claim)
      </TxButton>,
    );
  if (isClaimant && claimEndable(bounty, now))
    add(
      "release",
      <TxButton
        approved={approved}
        busy={busy}
        onClick={() =>
          void send("Releasing the claim", releaseClaimCall(contract, id))
        }
      >
        Release the claim (this wallet cannot claim this bounty again)
      </TxButton>,
    );
  if (isBuyer && claimEndable(bounty, now))
    add(
      "revoke",
      <TxButton
        approved={approved}
        busy={busy}
        onClick={() =>
          void send("Revoking the claim", revokeClaimCall(contract, id))
        }
      >
        Revoke the claim (maintainer, no pull request is submitted)
      </TxButton>,
    );
  if (wallet && claimExpirable(bounty, now))
    add(
      "expire",
      <TxButton
        approved={approved}
        busy={busy}
        onClick={() =>
          void send("Ending the claim", expireClaimCall(contract, id))
        }
      >
        Expire the claim (anyone, its time has passed)
      </TxButton>,
    );
  if (
    wallet &&
    bounty.status === "Bound" &&
    mergeCheckable(bounty, now, config.refund_cap_secs)
  ) {
    add(
      "check",
      <TxButton
        variant="primary"
        approved={approved}
        busy={busy}
        onClick={() =>
          void send("Checking the merge", checkMergeCall(contract, id, false))
        }
      >
        Check the merge, paying {near(RUN_DEPOSIT)} myself (unused part
        returned)
      </TxButton>,
    );
    if (me === bounty.binding?.wallet && sponsored > 0)
      add(
        "sponsored",
        <TxButton
          approved={approved}
          busy={busy}
          disabled={config.sponsor_float === "0"}
          onClick={() =>
            void send("Checking the merge", checkMergeCall(contract, id, true))
          }
        >
          Sponsored check ({sponsored} left, free to you)
        </TxButton>,
      );
  }
  if (wallet && refundDue(bounty, now, config.refund_cap_secs))
    add(
      "settle",
      <TxButton
        approved={approved}
        busy={busy}
        onClick={() =>
          void send("Refunding the maintainer", settleCall(contract, id))
        }
      >
        Refund the maintainer's vault (anyone, no cost)
      </TxButton>,
    );
  if (wallet && due)
    add(
      "send-due",
      <TxButton
        approved={approved}
        busy={busy}
        onClick={() => void send("Sending", sendDueCall(contract, id))}
      >
        Send the due settlement (anyone, same vault, same amount)
      </TxButton>,
    );
  if (wallet)
    for (const [kind] of recoverable)
      add(
        `recover-${kind}`,
        <TxButton
          approved={approved}
          busy={busy}
          onClick={() =>
            void send(
              "Recording the settlement's result",
              recoverSettlementCall(contract, id, kind),
            )
          }
        >
          Record the {kindLabel(kind)}'s result (anyone, no cost, sends nothing)
        </TxButton>,
      );
  if (wallet)
    for (const [kind, s] of reconcilable)
      add(
        `reconcile-${kind}`,
        <TxButton
          approved={approved}
          busy={busy}
          onClick={() =>
            void send(
              "Asking the vault",
              reconcileCall(contract, id, kind, s.attempt),
            )
          }
        >
          Ask the vault whether the {kindLabel(kind)} arrived (attach{" "}
          {near(config.reconcile_deposit)}; what the vault does not keep comes
          back)
        </TxButton>,
      );
  const warning = failedLookWarning(bounty, config.refund_cap_secs);
  return (
    <div className="bounty-actions">
      {!wallet ? (
        <p className="workspace-empty">
          Connect a wallet to act on this bounty.
        </p>
      ) : null}
      {open ? <ClaimSection id={id} bounty={bounty} ctx={ctx} /> : null}
      {canSubmit ? (
        <SubmitView
          bounty={bounty}
          linkProblem={linkProblem}
          value={pr}
          approved={approved}
          busy={busy}
          onChange={setPr}
          onSubmit={(number) =>
            wallet &&
            void ctx.run(
              "Submitting the pull request",
              {
                bountyId: id,
                call: { receiver: contract, method: "submit_pr", args: {} },
              },
              async () => {
                await sendFlow({
                  approved,
                  wallet,
                  call: submitPrCall(contract, id, number),
                });
                ctx.done();
              },
            )
          }
        />
      ) : null}
      {bounty.status === "Bound" ? (
        <p>
          Check the merge: a merge into <code>{bounty.base_ref}</code> before{" "}
          {utc(bounty.merge_deadline)} pays the vault{" "}
          <code>{short(bounty.claim?.vault ?? "")}</code>. Checks are accepted
          until {utc(checksUntil(bounty, config.refund_cap_secs))}, so a merge
          before the deadline is still paid when it is read after the grace. An
          open pull request stays pending, and a check that cannot read GitHub
          changes nothing.
        </p>
      ) : null}
      {warning ? <p role="alert">{warning}</p> : null}
      {bounty.status === "Bound" && me === bounty.binding?.wallet ? (
        <p>
          <SponsorNote config={config} /> {sponsored} of{" "}
          {config.sponsored_runs_per_bounty} sponsored checks are left for this
          bounty.
          {config.sponsor_float === "0"
            ? " The sponsor float is empty now, so only checks you pay for run; refunds, recovery and withdrawals still work."
            : ""}
        </p>
      ) : null}
      {buttons.length ? (
        <>
          <div className="market-actions">{buttons}</div>
          <SigningNote approved={approved} />
        </>
      ) : null}
    </div>
  );
}

/** Wherever sponsored checks appear. There is no maintainer check budget in this contract. */
export function SponsorNote({ config }: { config: Pick<Config, "sponsor"> }) {
  return (
    <>
      Sponsored checks are paid from the owner's float, and unused compute
      returns to <code>{config.sponsor}</code>; the contributor attaches
      nothing.
    </>
  );
}

// ---- The card ----

export function BountyCard({
  id,
  bounty,
  ctx,
  inVault,
}: {
  id: number;
  bounty: Bounty;
  ctx: CardContext;
  /** How many settlements on this page went into each vault. */
  inVault: Map<string, number>;
}) {
  const { config, now } = ctx;
  const status = bountyStatus(bounty, now);
  const repo = `https://github.com/${bounty.repo}`;
  const settlements = present(bounty);
  const me = ctx.wallet?.accountId;
  const vaults = [
    ...new Set(
      [
        me === bounty.buyer ? bounty.maintainer_vault : null,
        me && me === bounty.claim?.wallet ? bounty.claim.vault : null,
      ].filter(Boolean),
    ),
  ] as string[];
  return (
    <article className="workspace-card bounty-card">
      <div className="workspace-section-heading">
        <h3>
          Bounty {id} ·{" "}
          <a
            href={`${repo}/issues/${bounty.issue}`}
            target="_blank"
            rel="noreferrer"
          >
            {bounty.repo}#{bounty.issue}
          </a>
        </h3>
        <span className="status-pill">{status.line}</span>
      </div>
      {status.detail ? <p className="bounty-status">{status.detail}</p> : null}
      <dl className="workspace-review bounty-facts">
        <dt>Reward</dt>
        <dd>{near(bounty.reward)}</dd>
        <dt>Branch</dt>
        <dd>
          <code>{bounty.base_ref}</code>
        </dd>
        <dt>Maintainer</dt>
        <dd>{short(bounty.buyer)}</dd>
        <dt>Contributor</dt>
        <dd>
          {bounty.claim
            ? `${short(bounty.claim.wallet)} (GitHub id ${bounty.claim.github_id})`
            : "Unclaimed"}
        </dd>
        <dt>Claims until</dt>
        <dd>
          {utc(bounty.claim_by)}, each claim lasts{" "}
          {duration(Number(bounty.claim_secs))}
        </dd>
        <dt>Merge before</dt>
        <dd>{utc(bounty.merge_deadline)}</dd>
        <dt>Refund</dt>
        <dd>
          From {utc(graceEnds(bounty))} if a check at least a minute after the
          deadline finds it not merged; otherwise from{" "}
          {utc(hardRefundAt(bounty, config.refund_cap_secs))}
        </dd>
        <dt>Evidence</dt>
        <dd className="bounty-evidence">
          {bounty.binding ? (
            <>
              <a
                href={`${repo}/pull/${bounty.binding.pr_number}`}
                target="_blank"
                rel="noreferrer"
              >
                PR #{bounty.binding.pr_number}
              </a>
              <Evidence id={bounty.binding.request_id} label="submission run" />
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
          {!bounty.binding && !bounty.merge && !bounty.last_check ? (
            <span>none yet</span>
          ) : null}
        </dd>
        {settlements.length ? (
          <>
            <dt>Settlement</dt>
            <dd>
              {settlements.map(([kind, s]) => (
                <span key={kind}>
                  {kindLabel(kind)} {near(s.principal)} to vault{" "}
                  <code>{short(s.vault)}</code>
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      <Actions id={id} bounty={bounty} ctx={ctx} />
      {vaults.map((v) => (
        <VaultPanel
          key={v}
          vault={v}
          network={config.network}
          wallet={ctx.wallet}
          run={ctx.run}
          busy={ctx.busy}
          approved={ctx.approved}
          near={near}
          chain={ctx.chain}
          now={now}
          partyDelaySecs={config.party_reconcile_delay_secs}
          entries={settlements
            .filter(([, s]) => s.vault === v)
            .map(([kind, s]) => ({ label: kindLabel(kind), settlement: s }))}
          shared={inVault.get(v) ?? 0}
        />
      ))}
    </article>
  );
}
