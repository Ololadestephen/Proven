import { useEffect, useMemo, useState } from "react";
import { api } from "./market-client.ts";
import { randomNonce } from "./market-client.ts";
import type { PendingAction } from "./action-guard.ts";
import { bountyChain } from "./bounty-chain.ts";
import {
  discoverMessageKey,
  postFlow,
  type FlowChain,
} from "./bounty-actions.ts";
import type { BountyReader } from "./bounty-reconcile.ts";
import type { Bounty, Config, Listing, WalletLink } from "./bounty-types.ts";
import { fromBase58, vaultAddress } from "./bounty-keys.ts";
import type { BountyRun, BountyWallet } from "./bounty-wallet.ts";
import { near } from "./bounty-text.ts";
import { BountyList, BountyPage } from "./BountyBoard.tsx";
import { useIssueTitles } from "./issue-titles.ts";
import { BountyCard, SponsorNote, type LinkLoad } from "./BountyCard.tsx";
import { LinkPanel } from "./LinkPanel.tsx";
import { PostBountyForm } from "./PostBountyForm.tsx";
import {
  FEES_APPROVED,
  PREVIEW_FEES,
  type FeeSchedule,
} from "./posting-review.ts";
import type { BountyActions } from "./use-bounty-actions.ts";

export { SponsorNote };
const PATH = "/api/market/bounties";
const nowSecs = () => Math.floor(Date.now() / 1000);

/** The fees the posting review shows: the samples while signing is off, the contract's once it is on. */
export function feeSchedule(config: Config, approved: boolean): FeeSchedule {
  return approved
    ? {
        storage_deposit: BigInt(config.storage_deposit),
        check_reserve: 0n,
        submit_fee: BigInt(config.run_deposit),
        source: "contract",
        approved: true,
      }
    : PREVIEW_FEES;
}

/** The two-field posting form, with the wallet's key check and the post flow behind it. */
function PostPreview(props: {
  contract: string;
  config: Config;
  wallet: BountyWallet | null;
  run: BountyRun;
  chain: FlowChain;
  approved: boolean;
  busy: boolean;
  poster: boolean;
  done: () => void;
}) {
  const { config, wallet, approved } = props;
  const [key, setKey] = useState<string | null>(null);
  const [keyText, setKeyText] = useState<string | null>(null);
  useEffect(() => {
    setKey(null);
    setKeyText(null);
  }, [wallet?.accountId]);
  const limits = useMemo(
    () => ({
      max_reward: BigInt(config.max_reward),
      room: BigInt(config.max_held) - BigInt(config.held),
      refund_cap_secs: config.refund_cap_secs,
    }),
    [config.max_reward, config.max_held, config.held, config.refund_cap_secs],
  );
  const pilot = useMemo(
    () => ({ repo: config.pilot_repo, repo_id: Number(config.pilot_repo_id) }),
    [config.pilot_repo, config.pilot_repo_id],
  );
  const fees = useMemo(() => feeSchedule(config, approved), [config, approved]);
  return (
    <PostBountyForm
      limits={limits}
      pilot={pilot}
      fees={fees}
      connected={!!wallet}
      poster={props.poster}
      busy={props.busy}
      keyCheck={keyText}
      onCheckKey={
        wallet
          ? () =>
              void props.run(
                "Checking your wallet's key",
                { bountyId: null },
                async () => {
                  const found = await discoverMessageKey({
                    approved,
                    contract: props.contract,
                    wallet,
                  });
                  const vault = vaultAddress(
                    fromBase58(config.vault_code_hash),
                    found.key,
                  );
                  setKey(found.key);
                  setKeyText(
                    `${found.keyCheck.text} A refund goes to vault ${vault}.`,
                  );
                },
              )
          : undefined
      }
      onPost={
        wallet
          ? (review) =>
              void props.run(
                "Posting the bounty",
                { bountyId: null },
                async () => {
                  let use = key;
                  if (!use) {
                    const found = await discoverMessageKey({
                      approved,
                      contract: props.contract,
                      wallet,
                    });
                    use = found.key;
                    setKey(use);
                    setKeyText(
                      `Refunds go to vault ${vaultAddress(fromBase58(config.vault_code_hash), use)}.`,
                    );
                  }
                  await postFlow({
                    approved,
                    contract: props.contract,
                    network: config.network,
                    wallet,
                    chain: props.chain,
                    review,
                    key: use,
                    nonce: randomNonce(),
                  });
                  setKey(null);
                  setKeyText(null);
                  props.done();
                },
              )
          : undefined
      }
    />
  );
}

/**
 * Shown while a bounty call is journaled and the chain does not show it yet. Nothing else on the
 * page can send until this clears, so a call that landed is never sent a second time.
 */
export function PendingNotice(props: {
  pending: PendingAction;
  /** Unix seconds. */
  now: number;
  onCheck: () => void;
  onRelease: () => void;
}) {
  const { pending } = props;
  const unreadable = !pending.call;
  if (!unreadable)
    return (
      <p className="market-note" role="status">
        {pending.label}: confirming on chain…
      </p>
    );
  return (
    <section className="workspace-card job-pending">
      <p>
        An earlier action could not be read back. Check your wallet's history,
        then clear it.
      </p>
      <div className="market-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={props.onRelease}
        >
          Clear it
        </button>
      </div>
    </section>
  );
}

export interface PageProps {
  listing: Listing | null;
  error: string;
  poster: boolean;
  link: LinkLoad;
  wallet: BountyWallet | null;
  run: BountyRun;
  busy: boolean;
  pending: PendingAction | null;
  /** Unix seconds. */
  now: number;
  /** False in the shipped build: nothing on the page may sign or send. */
  approved: boolean;
  chain: BountyReader & FlowChain;
  done: () => void;
  onCheckPending: () => void;
  onReleasePending: () => void;
  /** Set on a bounty's own page (/app/bounties/:id). */
  bountyId?: number;
  /** The issue's title when GitHub has given it; the page shows "owner/repo#12" otherwise. */
  titleOf?: (repo: string, issue: number) => string | undefined;
}

/** Statuses after which nothing more can happen to a bounty's money in the contract. */
const CLOSED = new Set(["Paid", "Refunded", "Cancelled"]);

/** The whole PR bounty page for one reading of the chain. State lives in `PrBounties`. */
export function PrBountiesView(props: PageProps) {
  const { listing } = props;
  if (props.error) return <p role="alert">{props.error}</p>;
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
  // How many settlements on this page went into each vault.
  const inVault = new Map<string, number>();
  for (const [, b] of bounties)
    for (const s of [b.payout, b.refund])
      if (s) inVault.set(s.vault, (inVault.get(s.vault) ?? 0) + 1);
  const ctx = {
    contract,
    config,
    now: props.now,
    approved: props.approved,
    wallet: props.wallet,
    run: props.run,
    busy: props.busy,
    chain: props.chain,
    done: props.done,
    link: props.link,
  };
  const titleOf = props.titleOf ?? (() => undefined);
  const pendingNotice = props.pending ? (
    <PendingNotice
      pending={props.pending}
      now={props.now}
      onCheck={props.onCheckPending}
      onRelease={props.onReleasePending}
    />
  ) : null;
  if (props.bountyId !== undefined) {
    const found = bounties.find(([id]) => id === props.bountyId);
    return (
      <>
        {pendingNotice}
        {found ? (
          <BountyPage
            id={found[0]}
            bounty={found[1]}
            ctx={ctx}
            titleOf={titleOf}
            inVault={inVault}
          />
        ) : (
          <p className="workspace-empty">
            There is no bounty {props.bountyId}.{" "}
            <a href="/app/bounties">See all bounties</a>
          </p>
        )}
      </>
    );
  }
  return (
    <>
      {pendingNotice}
      <BountyList bounties={bounties} ctx={ctx} titleOf={titleOf} />
      {!config.paused && props.poster ? (
        <PostPreview
          contract={contract}
          config={config}
          wallet={props.wallet}
          run={props.run}
          chain={props.chain}
          approved={props.approved}
          busy={props.busy}
          poster={props.poster}
          done={props.done}
        />
      ) : null}
      {!props.wallet ||
      (props.poster &&
        !(props.link.state === "ready" && props.link.value?.active)) ? null : (
        <LinkPanel
          contract={contract}
          config={config}
          wallet={props.wallet}
          run={props.run}
          chain={props.chain}
          approved={props.approved}
          busy={props.busy}
          now={props.now}
          link={props.link}
          done={props.done}
        />
      )}
      <details className="bounty-terms bounty-about">
        <summary>How payment is decided</summary>
        <p>
          Repository <code>{config.pilot_repo}</code>. Each check attaches{" "}
          {near(config.run_deposit)}; the unused part comes back.
          {config.paused ? " Posting is paused." : ""}
        </p>
        <p>
          Proven's verifier (<code>{config.verifier_hash.slice(0, 12)}…</code>)
          runs on OutLayer and reads GitHub. It checks the merge only, not the
          quality of the work. Anyone can verify a run from its attestation
          link.
        </p>
        <p>
          Payouts and refunds go to vaults controlled by one withdrawal key, not
          to account names. <SponsorNote config={config} /> Contributors prove
          their GitHub account once, with a gist they own. A bounty keeps{" "}
          {near(config.storage_deposit)} as its record. Contract{" "}
          <code>{contract}</code>.
        </p>
      </details>
    </>
  );
}

export function PrBounties({
  actions,
  busy,
  bountyId,
}: {
  actions: BountyActions;
  busy: boolean;
  bountyId?: number;
}) {
  const { wallet, run, pending } = actions;
  const chain = useMemo(() => bountyChain(api), []);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [poster, setPoster] = useState(false);
  const [link, setLink] = useState<LinkLoad>({ state: "none" });
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    api<Listing>(PATH)
      .then(setListing)
      .catch((reason: Error) => setError(reason.message));
  }, [version, pending]);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSecs()), 5000);
    return () => clearInterval(timer);
  }, []);
  const account = wallet?.accountId ?? null;
  const configured = !!listing?.configured;
  useEffect(() => {
    setPoster(false);
    setLink(account ? { state: "loading" } : { state: "none" });
    if (!account || !configured) return;
    let live = true;
    void api<{ poster: boolean }>(`${PATH}/poster/${account}`)
      .then((reply) => live && setPoster(reply.poster))
      .catch(() => undefined);
    void api<{ link: WalletLink | null }>(`${PATH}/link/${account}`)
      .then((reply) => live && setLink({ state: "ready", value: reply.link }))
      .catch(() => live && setLink({ state: "unavailable" }));
    return () => {
      live = false;
    };
  }, [account, configured, version, pending]);
  const titleOf = useIssueTitles(
    listing?.configured
      ? listing.bounties.map(([, b]) => ({ repo: b.repo, issue: b.issue }))
      : [],
  );
  return (
    <PrBountiesView
      listing={listing}
      error={error}
      poster={poster}
      link={link}
      wallet={wallet}
      run={run}
      busy={busy || !!pending}
      pending={pending}
      now={now}
      approved={FEES_APPROVED}
      chain={chain}
      done={() => setVersion((v) => v + 1)}
      onCheckPending={() => void actions.check().catch(() => undefined)}
      onReleasePending={() => void actions.release()}
      bountyId={bountyId}
      titleOf={titleOf}
    />
  );
}
