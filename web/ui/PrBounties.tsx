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
    }),
    [config.max_reward, config.max_held, config.held],
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
        wallet && key
          ? (review) =>
              void props.run(
                "Posting the bounty",
                { bountyId: null },
                async () => {
                  await postFlow({
                    approved,
                    contract: props.contract,
                    network: config.network,
                    wallet,
                    chain: props.chain,
                    review,
                    key,
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
  const waiting = props.now - Math.floor(pending.createdAt / 1000) < 15;
  return (
    <section className="workspace-card job-pending">
      <h2>Did that go through?</h2>
      {unreadable ? (
        <p>
          An earlier action was not finished, and this page cannot read what it
          was. Other actions on this page are paused so nothing is sent twice.
          Check your wallet's history. Clear this record only when you are sure
          that action did not go through.
        </p>
      ) : (
        <p>
          {pending.label}. The chain does not show this yet, so other actions on
          this page are paused to stop it being sent twice. If you signed it,
          this clears by itself once it lands.
        </p>
      )}
      <div className="market-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={props.onCheck}
        >
          Check again
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={!unreadable && waiting}
          onClick={props.onRelease}
        >
          {unreadable
            ? "I checked my wallet history: clear this record"
            : waiting
              ? "Checking the chain…"
              : "I cancelled it: check and continue"}
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
}

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
  return (
    <>
      <section className="workspace-card">
        <h2>PR bounties: payout after an attested GitHub merge check</h2>
        <p>
          GitHub supplies the facts. The maintainer decides by merging. The
          contract <code>{contract}</code> relies on OutLayer's authenticated
          result and its approved workers, running Proven's verifier pinned at{" "}
          <code>{config.verifier_hash.slice(0, 12)}…</code>. Anyone can check a
          run's Intel quote independently from its attestation link. Proven
          checks the merge, not the quality of the work or whether the pull
          request solves the issue.
        </p>
        <p>
          Payouts and refunds go to vaults that one withdrawal key controls, not
          to account names. Each check attaches {near(config.run_deposit)}; the
          unused part comes back to whoever paid. A bounty locks its reward and{" "}
          {near(config.storage_deposit)} for its record.{" "}
          <SponsorNote config={config} /> Pilot: one public repository,{" "}
          <code>{config.pilot_repo}</code> (id {config.pilot_repo_id}),
          maintainers on the owner's allowlist
          {config.paused ? "; posting is paused" : ""}. A contributor proves
          their GitHub account once, with a gist they own.
        </p>
      </section>
      {props.pending ? (
        <PendingNotice
          pending={props.pending}
          now={props.now}
          onCheck={props.onCheckPending}
          onRelease={props.onReleasePending}
        />
      ) : null}
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
      {!config.paused ? (
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
      {bounties.length === 0 ? (
        <p className="workspace-empty">No bounties yet.</p>
      ) : null}
      {bounties
        .slice()
        .reverse()
        .map(([id, bounty]: [number, Bounty]) => (
          <BountyCard
            key={id}
            id={id}
            bounty={bounty}
            ctx={ctx}
            inVault={inVault}
          />
        ))}
    </>
  );
}

export function PrBounties({
  actions,
  busy,
}: {
  actions: BountyActions;
  busy: boolean;
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
    />
  );
}
