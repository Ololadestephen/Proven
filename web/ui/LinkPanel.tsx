import { useEffect, useRef, useState } from "react";
import { api, short } from "./market-client.ts";
import type { Config, WalletLink } from "./bounty-types.ts";
import {
  LINK_DEPOSIT,
  LINK_STORAGE_DEPOSIT,
  RUN_DEPOSIT,
  activateLinkCall,
  cancelLinkChangeCall,
  confirmLinkChangeCall,
  linkChangeRoles,
  linkFlow,
  linkOutcomeOf,
  linkOutcomeStoresNothing,
  linkOutcomeText,
  sendFlow,
  type FlowChain,
} from "./bounty-actions.ts";
import { BOUNTY_PATH } from "./bounty-chain.ts";
import { SigningNote, TxButton, type LinkLoad } from "./BountyCard.tsx";
import { utc } from "./bounty-status.ts";
import { near } from "./bounty-text.ts";
import { linkErrorMessage, type DeviceStart } from "./github-link.ts";
import type { BountyRun, BountyWallet } from "./bounty-wallet.ts";

const STEP_TEXT: Record<string, string> = {
  code: "Asking GitHub for a code…",
  approval: "Waiting for you to approve the connection on GitHub…",
  account: "Reading your GitHub account…",
  gist: "Creating the secret gist…",
};

/** A link change that is waiting for its delay, with the buttons this viewer may use. */
export function LinkChangeRow(props: {
  viewer: string;
  wallet: string;
  pending: NonNullable<WalletLink["pending"]>;
  /** The wallet that holds the new GitHub id today, or null when nobody does. */
  owner: string | null;
  now: number;
  approved: boolean;
  busy: boolean;
  onActivate: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { pending, wallet } = props;
  const roles = linkChangeRoles({
    viewer: props.viewer,
    wallet,
    owner: props.owner,
    activatesAt: Number(pending.activates_at),
    now: props.now,
  });
  const incumbent = props.owner ?? wallet;
  return (
    <div className="bounty-action">
      <p>
        A link change for {short(wallet)} is waiting: GitHub account id{" "}
        {pending.link.github_id} (gist <code>{pending.link.gist_id}</code>). It
        applies {utc(pending.activates_at)}. Until then, claims and submissions
        by this wallet use its earlier link. Only {short(incumbent)} can confirm
        it earlier; the wallet itself or the wallet that holds that GitHub
        account can cancel it.
      </p>
      <div className="market-actions">
        {roles.canActivate ? (
          <TxButton
            approved={props.approved}
            busy={props.busy}
            onClick={props.onActivate}
          >
            Apply the change now (anyone, its delay has passed)
          </TxButton>
        ) : null}
        {roles.canConfirm ? (
          <TxButton
            approved={props.approved}
            busy={props.busy}
            onClick={props.onConfirm}
          >
            Confirm the change now (skip the wait)
          </TxButton>
        ) : null}
        {roles.canCancel ? (
          <TxButton
            approved={props.approved}
            busy={props.busy}
            onClick={props.onCancel}
          >
            Cancel the change
          </TxButton>
        ) : null}
      </div>
      {!roles.canActivate && !roles.canConfirm && !roles.canCancel ? (
        <p className="workspace-empty">
          The connected account cannot act on this change.
        </p>
      ) : null}
      <SigningNote approved={props.approved} />
    </div>
  );
}

export interface LinkViewProps {
  wallet: string | null;
  link: LinkLoad;
  config: Config;
  now: number;
  approved: boolean;
  busy: boolean;
  /** Set while GitHub's device flow runs. */
  device: DeviceStart | null;
  step: string | null;
  /** What the contract said about the last attempt, when it stored nothing or just stored. */
  outcome: string | null;
  /** The wallet that holds the waiting change's GitHub id today. */
  owner: string | null;
  error: string;
  onConnect: () => void;
  onCancelConnect: () => void;
  onActivate: (wallet: string) => void;
  onConfirm: (wallet: string) => void;
  onCancelChange: (wallet: string) => void;
}

/** Your GitHub link as the contributor sees it. It holds no state of its own. */
export function LinkView(props: LinkViewProps) {
  const { wallet, link, config } = props;
  const value = link.state === "ready" ? link.value : null;
  return (
    <section className="workspace-card bounty-link">
      <h2>Your GitHub link</h2>
      {!wallet ? (
        <p className="workspace-empty">
          Connect a wallet to link a GitHub account to it.
        </p>
      ) : link.state === "loading" ? (
        <p role="status">Reading your link…</p>
      ) : link.state === "unavailable" ? (
        <p role="alert">
          Your link is unavailable: it could not be read. Reload the page.
        </p>
      ) : (
        <>
          {value?.active ? (
            <p>
              Connected: GitHub account id {value.active.github_id} is linked to{" "}
              {short(wallet)} (gist <code>{value.active.gist_id}</code>). A
              claim records this account and cannot be changed afterwards.
            </p>
          ) : (
            <p>
              No GitHub account is connected to {short(wallet)}. You connect one
              once, before your first claim.
            </p>
          )}
          {value?.pending ? (
            <LinkChangeRow
              viewer={wallet}
              wallet={wallet}
              pending={value.pending}
              owner={props.owner}
              now={props.now}
              approved={props.approved}
              busy={props.busy}
              onActivate={() => props.onActivate(wallet)}
              onConfirm={() => props.onConfirm(wallet)}
              onCancel={() => props.onCancelChange(wallet)}
            />
          ) : null}
          {props.outcome ? (
            <p role="status">
              {linkOutcomeText(props.outcome, config.relink_delay_secs)}
            </p>
          ) : null}
          {props.device ? (
            <div className="bounty-action" role="status">
              <p>
                On GitHub, open{" "}
                <a
                  href={props.device.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/login/device
                </a>{" "}
                and enter this code:
              </p>
              <pre className="bounty-challenge">{props.device.userCode}</pre>
              <p>{props.step ? (STEP_TEXT[props.step] ?? "") : ""}</p>
              <button
                type="button"
                className="button button-secondary"
                onClick={props.onCancelConnect}
              >
                Cancel
              </button>
            </div>
          ) : null}
          {!value?.active && !props.device ? (
            <div className="bounty-action">
              <p>
                Connecting asks you to approve a GitHub app whose only
                permission is to write your gists. The page then creates one
                secret gist that holds a challenge naming this wallet, drops the
                permission, and sends one transaction that attaches{" "}
                {near(LINK_DEPOSIT)}: {near(RUN_DEPOSIT)} pays the check, and
                the unused part comes back; {near(LINK_STORAGE_DEPOSIT)} pays
                for storing the link, and comes back if the link is not
                recorded. The permission is never stored. Keep the gist: the
                check of your submitted pull request reads it again.
              </p>
              <TxButton
                variant="primary"
                approved={props.approved}
                busy={props.busy}
                onClick={props.onConnect}
              >
                Connect GitHub
              </TxButton>
              <SigningNote approved={props.approved} />
            </div>
          ) : null}
          {props.error ? <p role="alert">{props.error}</p> : null}
        </>
      )}
    </section>
  );
}

/** Looks up another wallet's waiting link change, for the wallet that holds its GitHub id. */
function LinkReview({
  viewer,
  now,
  approved,
  busy,
  onAct,
}: {
  viewer: string;
  now: number;
  approved: boolean;
  busy: boolean;
  onAct: (action: "activate" | "confirm" | "cancel", wallet: string) => void;
}) {
  const [account, setAccount] = useState("");
  const [found, setFound] = useState<{
    wallet: string;
    pending: NonNullable<WalletLink["pending"]> | null;
    owner: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const look = async () => {
    setError("");
    setFound(null);
    try {
      const link = await api<{ link: WalletLink | null }>(
        `${BOUNTY_PATH}/link/${encodeURIComponent(account)}`,
      );
      const pending = link.link?.pending ?? null;
      const owner = pending
        ? (
            await api<{ wallet: string | null }>(
              `${BOUNTY_PATH}/github-owner/${pending.link.github_id}`,
            )
          ).wallet
        : null;
      setFound({ wallet: account, pending, owner });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read it.");
    }
  };
  return (
    <section className="workspace-card">
      <h3>Review a link change for another wallet</h3>
      <p>
        If another wallet asked to link your GitHub account, you can confirm or
        cancel that change here before its delay ends.
      </p>
      <label>
        Wallet to look up
        <input
          value={account}
          onChange={(e) => setAccount(e.target.value.trim())}
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="button button-secondary"
        disabled={!account}
        onClick={() => void look()}
      >
        Look up
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {found && !found.pending ? (
        <p>No link change is waiting for {short(found.wallet)}.</p>
      ) : null}
      {found?.pending ? (
        <LinkChangeRow
          viewer={viewer}
          wallet={found.wallet}
          pending={found.pending}
          owner={found.owner}
          now={now}
          approved={approved}
          busy={busy}
          onActivate={() => onAct("activate", found.wallet)}
          onConfirm={() => onAct("confirm", found.wallet)}
          onCancel={() => onAct("cancel", found.wallet)}
        />
      ) : null}
    </section>
  );
}

/** Connects GitHub (device flow, one gist, `link`) and shows the link and any change waiting. */
export function LinkPanel({
  contract,
  config,
  wallet,
  run,
  chain,
  approved,
  busy,
  now,
  link,
  done,
}: {
  contract: string;
  config: Config;
  wallet: BountyWallet | null;
  run: BountyRun;
  chain: Pick<FlowChain, "nowSecs" | "linkChallenge" | "linkNumber">;
  approved: boolean;
  busy: boolean;
  now: number;
  link: LinkLoad;
  done: () => void;
}) {
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const pendingId =
    link.state === "ready"
      ? (link.value?.pending?.link.github_id ?? null)
      : null;
  useEffect(() => {
    setOwner(null);
    if (!pendingId) return;
    let live = true;
    api<{ wallet: string | null }>(`${BOUNTY_PATH}/github-owner/${pendingId}`)
      .then((reply) => live && setOwner(reply.wallet))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pendingId]);

  const connect = () =>
    wallet
      ? run(
          "Connecting GitHub",
          {
            bountyId: null,
            call: { receiver: contract, method: "link", args: {} },
          },
          async () => {
            setError("");
            setOutcome(null);
            const controller = new AbortController();
            abort.current = controller;
            try {
              const result = await linkFlow({
                approved,
                network: config.network,
                contract,
                wallet,
                chain,
                github: {
                  signal: controller.signal,
                  onDeviceCode: setDevice,
                  onStep: setStep,
                },
              });
              const said = linkOutcomeOf(result.result);
              setOutcome(said);
              done();
              // A link the contract refused stored nothing; the chain read confirms it.
              if (said && linkOutcomeStoresNothing(said))
                return { release: true };
            } catch (reason) {
              const code =
                reason instanceof Error
                  ? reason.message
                  : linkErrorMessage("cancelled");
              setError(code);
              throw reason;
            } finally {
              abort.current = null;
              setDevice(null);
              setStep(null);
            }
          },
          "Connecting GitHub. Follow the steps on this page.",
        )
      : undefined;

  const change = (
    label: string,
    method: "activate" | "confirm" | "cancel",
    target: string,
  ) => {
    const built = {
      activate: activateLinkCall,
      confirm: confirmLinkChangeCall,
      cancel: cancelLinkChangeCall,
    }[method](contract, target);
    return wallet
      ? run(
          label,
          {
            bountyId: null,
            call: {
              receiver: built.receiver,
              method: built.method,
              args: built.args,
            },
          },
          async () => {
            await sendFlow({ approved, wallet, call: built });
            done();
          },
        )
      : undefined;
  };
  const labels = {
    activate: "Applying the link change",
    confirm: "Confirming the link change",
    cancel: "Cancelling the link change",
  } as const;
  return (
    <>
      <LinkView
        wallet={wallet?.accountId ?? null}
        link={link}
        config={config}
        now={now}
        approved={approved}
        busy={busy}
        device={device}
        step={step}
        outcome={outcome}
        owner={owner}
        error={error}
        onConnect={() => void connect()}
        onCancelConnect={() => abort.current?.abort()}
        onActivate={(w) => void change(labels.activate, "activate", w)}
        onConfirm={(w) => void change(labels.confirm, "confirm", w)}
        onCancelChange={(w) => void change(labels.cancel, "cancel", w)}
      />
      {wallet ? (
        <LinkReview
          viewer={wallet.accountId}
          now={now}
          approved={approved}
          busy={busy}
          onAct={(action, target) =>
            void change(labels[action], action, target)
          }
        />
      ) : null}
    </>
  );
}
