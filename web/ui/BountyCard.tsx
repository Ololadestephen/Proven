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
    <p className="bounty-refund-notice post-hint">
      If no check reads GitHub before{" "}
      {utc(hardRefundAt(bounty, config.refund_cap_secs))}, an on-time merge is
      refunded to the maintainer, not paid. Final.
    </p>
  );
}

export function Evidence({
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
      ? "This wallet already claimed this bounty once."
      : props.githubId === null
        ? "Link GitHub first (below)."
        : "";
  return (
    <div className="bounty-action">
      <RefundNotice bounty={bounty} config={config} />
      <p className="post-hint">
        Lasts {duration(Number(bounty.claim_secs))}; free; one claim per wallet.
        Your wallet signs a message first: the payout goes to a vault only that
        key controls.
      </p>
      <TxButton
        variant="primary"
        approved={props.approved}
        busy={props.busy}
        disabled={blocked !== ""}
        onClick={props.onClaim}
      >
        Claim
      </TxButton>
      {keyCheck ? (
        <p role="status" className="post-hint">
          {keyCheck.text} Payout vault <code>{keyCheck.vault}</code>.
        </p>
      ) : null}
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
  // One click: the wallet signs the key message, then the claim. The vault is shown as soon as
  // the key is known.
  const claim = () =>
    wallet && githubId
      ? ctx.run("Claiming", target, async () => {
          const found = await discoverMessageKey({
            approved,
            contract,
            wallet,
          });
          const key = {
            text: found.keyCheck.text,
            key: found.key,
            vault: vaultAddress(fromBase58(config.vault_code_hash), found.key),
          };
          setKeyCheck(key);
          await claimFlow({
            approved,
            contract,
            network: config.network,
            wallet,
            chain: ctx.chain,
            bountyId: id,
            githubId,
            key: key.key,
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
      <label>
        Your pull request into <code>{props.bounty.base_ref}</code> (number or
        link)
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
        Submit ({near(RUN_DEPOSIT)}, unused part returned)
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
export const present = (b: Bounty) =>
  slots(b).filter((s): s is [SettlementKind, SettlementView] => !!s[1]);

/** One text for the sponsored-check note, wherever it appears. */
export function sponsoredLeft(bounty: Bounty, config: Config): number {
  return Math.max(0, config.sponsored_runs_per_bounty - bounty.sponsored_runs);
}

export function Actions({
  id,
  bounty,
  ctx,
  initialPr = "",
}: {
  id: number;
  bounty: Bounty;
  ctx: CardContext;
  /** A pull request number from a step link (#submit-12), filled in for the person to check. */
  initialPr?: string;
}) {
  const { wallet, config, contract, now, approved, busy } = ctx;
  const [pr, setPr] = useState(initialPr);
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
        Cancel bounty
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
        Release claim
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
        Revoke claim
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
        Expire claim
      </TxButton>,
    );
  if (
    wallet &&
    bounty.status === "Bound" &&
    mergeCheckable(bounty, now, config.refund_cap_secs)
  ) {
    const free =
      me === bounty.binding?.wallet &&
      sponsored > 0 &&
      config.sponsor_float !== "0";
    if (free)
      add(
        "sponsored",
        <TxButton
          variant="primary"
          approved={approved}
          busy={busy}
          onClick={() =>
            void send("Checking the merge", checkMergeCall(contract, id, true))
          }
        >
          Check merge, free ({sponsored} left)
        </TxButton>,
      );
    add(
      "check",
      <TxButton
        variant={free ? undefined : "primary"}
        approved={approved}
        busy={busy}
        onClick={() =>
          void send("Checking the merge", checkMergeCall(contract, id, false))
        }
      >
        Check merge ({near(RUN_DEPOSIT)})
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
        Refund maintainer
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
        Send settlement
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
          Record {kindLabel(kind)} result
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
          Ask vault about {kindLabel(kind)} ({near(config.reconcile_deposit)})
        </TxButton>,
      );
  const warning = failedLookWarning(bounty, config.refund_cap_secs);
  return (
    <div className="bounty-actions">
      {!wallet ? (
        <p className="workspace-empty">Connect a wallet to act.</p>
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
      {bounty.status === "Bound" && (isBuyer || isClaimant) ? (
        <p className="post-hint">
          Checks run when someone asks; a merge before{" "}
          {utc(bounty.merge_deadline)} is paid at the first check that reads it,
          until {utc(checksUntil(bounty, config.refund_cap_secs))}.
        </p>
      ) : null}
      {warning ? <p role="alert">{warning}</p> : null}
      {bounty.status === "Bound" &&
      me === bounty.binding?.wallet &&
      config.sponsor_float === "0" ? (
        <p className="post-hint">
          Free checks are paused (sponsor float empty).
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
  // A party sees its own vault once this bounty has paid into it.
  const vaults = [
    ...new Set(
      settlements
        .map(([, s]) => s.vault)
        .filter(
          (v) =>
            (me === bounty.buyer && v === bounty.maintainer_vault) ||
            (!!me && me === bounty.claim?.wallet && v === bounty.claim.vault),
        ),
    ),
  ] as string[];
  const isBuyer = !!me && me === bounty.buyer;
  const isClaimant = !!me && me === bounty.claim?.wallet;
  const party = isBuyer || isClaimant;
  const ended = ["Paid", "Refunded", "Cancelled", "Ineligible"].includes(
    bounty.status,
  );
  return (
    <details
      className="workspace-card bounty-card"
      open={party && !ended ? true : undefined}
    >
      <summary className="bounty-summary">
        <span className="bounty-title">
          #{id} ·{" "}
          <a
            href={`${repo}/issues/${bounty.issue}`}
            target="_blank"
            rel="noreferrer"
          >
            {bounty.repo}#{bounty.issue}
          </a>
          {isBuyer ? " · yours" : isClaimant ? " · your claim" : ""}
        </span>
        <span className="bounty-reward">{near(bounty.reward)}</span>
        <span className="status-pill">{status.line}</span>
      </summary>
      {status.detail ? <p className="bounty-status">{status.detail}</p> : null}
      <dl className="workspace-review bounty-facts">
        <dt>Branch</dt>
        <dd>
          <code>{bounty.base_ref}</code>
        </dd>
        {bounty.status === "Open" ? (
          <>
            <dt>Claims until</dt>
            <dd>{utc(bounty.claim_by)}</dd>
          </>
        ) : null}
        <dt>Merge before</dt>
        <dd>{utc(bounty.merge_deadline)}</dd>
        {isBuyer && bounty.claim ? (
          <>
            <dt>Contributor</dt>
            <dd>
              {short(bounty.claim.wallet)} (GitHub id {bounty.claim.github_id})
            </dd>
          </>
        ) : null}
        {isBuyer && !ended ? (
          <>
            <dt>Refund</dt>
            <dd>
              From {utc(graceEnds(bounty))} if not merged; otherwise from{" "}
              {utc(hardRefundAt(bounty, config.refund_cap_secs))}
            </dd>
          </>
        ) : null}
        {bounty.binding || bounty.merge || bounty.last_check ? (
          <>
            <dt>Evidence</dt>
            <dd className="bounty-evidence">
              {bounty.binding ? (
                <a
                  href={`${repo}/pull/${bounty.binding.pr_number}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  PR #{bounty.binding.pr_number}
                </a>
              ) : null}
              <Evidence
                id={bounty.binding?.request_id}
                label="submission run"
              />
              {bounty.merge ? (
                <span>merged {utc(bounty.merge.merged_at)}</span>
              ) : null}
              <Evidence id={bounty.merge?.request_id} label="merge run" />
              {bounty.last_check &&
              !["bound", "paid"].includes(bounty.last_check.outcome) ? (
                <span>
                  last check <code>{bounty.last_check.outcome}</code>{" "}
                  <Evidence id={bounty.last_check.request_id} label="run" />
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
        {party && settlements.length ? (
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
    </details>
  );
}
