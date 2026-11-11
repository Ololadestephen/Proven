import { useEffect, useMemo, useState } from "react";
import { NEAR } from "./market-types.ts";
import { COIN } from "./network.ts";
import {
  loadIssueMetadata,
  parseIssueLink,
  type IssueMetadata,
  type MetadataError,
} from "./github-issue.ts";
import {
  ADVANCED_DEFAULTS,
  REFUND_CAP_SECS,
  duration,
  reviewPosting,
  signingBlock,
  type Advanced,
  type FeeSchedule,
  type Field,
  type Limits,
  type Pilot,
  type Review,
} from "./posting-review.ts";

export type MetaState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; error: MetadataError }
  | { state: "ready"; value: IssueMetadata };

const near = (yocto: bigint): string => {
  const fraction = (yocto % NEAR)
    .toString()
    .padStart(24, "0")
    .replace(/0+$/, "");
  return `${yocto / NEAR}${fraction ? `.${fraction.slice(0, 6)}` : ""} ${COIN}`;
};
const utc = (secs: number) =>
  new Date(secs * 1000)
    .toISOString()
    .replace(".000Z", " UTC")
    .replace("T", " ");

export interface FormViewProps {
  link: string;
  rewardText: string;
  advanced: Advanced;
  meta: MetaState;
  limits: Limits;
  pilot: Pilot;
  fees: FeeSchedule;
  /** Seconds since the epoch, for the absolute deadlines. */
  now: number;
  connected: boolean;
  poster: boolean;
  onLink: (value: string) => void;
  onReward: (value: string) => void;
  onAdvanced: (key: keyof Advanced, value: string) => void;
  onRetry: () => void;
  /** An action is running, so nothing new may start. */
  busy?: boolean;
  /** What the wallet's message-key check said, once it has run. */
  keyCheck?: string | null;
  /** Asks the wallet which key it signs messages with. Absent: the page offers no key check. */
  onCheckKey?: () => void;
  /** Posts the reviewed bounty. Absent: the Post button stays off. */
  onPost?: (review: Review) => void;
}

function FieldError({
  problems,
  field,
}: {
  problems: { field: Field; message: string }[];
  field: Field;
}) {
  const own = problems.filter((p) => p.field === field);
  return own.length === 0 ? null : (
    <span role="alert" className="form-error">
      {own.map((p) => p.message).join(" ")}
    </span>
  );
}

function Summary({ review }: { review: Review }) {
  const d = review.deadlines;
  const { fees } = review;
  return (
    <dl className="workspace-review bounty-facts" aria-label="Review">
      <dt>Issue</dt>
      <dd>
        <a href={review.issue_url} target="_blank" rel="noreferrer">
          {review.repo}#{review.issue}
        </a>
        : {review.title}
      </dd>
      <dt>Target branch</dt>
      <dd>
        <code>{review.branch}</code>{" "}
        {review.branch_overridden
          ? `(you changed it; the repository's default is ${review.branch_suggested})`
          : "(the repository's default branch)"}
      </dd>
      <dt>Deadlines</dt>
      <dd>
        Open for claims until {utc(d.claim_by)}. A claim lasts{" "}
        {duration(d.claim_secs)}. The pull request must be merged before{" "}
        {utc(d.merge_deadline)}. Merges are checked until {utc(d.checks_until)}.
        A check after the deadline that finds it not merged lets you be refunded
        from {utc(d.grace_ends)} ({duration(d.grace_secs)} grace).
      </dd>
      <dt>If checks fail</dt>
      <dd>
        A check that cannot read GitHub (a timeout or no result) changes nothing
        and can be repeated. A merge before the deadline is paid at the first
        check that reads it, even after the grace. If no check reads GitHub
        before {utc(d.hard_refund_at)} ({duration(REFUND_CAP_SECS)} after the
        grace), the reward is refunded to you even if the pull request was
        merged on time, and the refund is final.
      </dd>
      <dt>Fees</dt>
      <dd>
        Reward {near(review.reward)}
        {fees.check_reserve > 0n
          ? `; check reserve ${near(fees.check_reserve)}, returned`
          : ""}
        ; record deposit {near(fees.storage_deposit)}, kept. Your wallet also
        pays the network fee when you sign. A contributor attaches{" "}
        {near(fees.submit_fee)} to submit a pull request and most of it comes
        back.
      </dd>
      <dt>Total locked</dt>
      <dd>
        <strong>{near(review.locked)}</strong>. If nothing is merged,{" "}
        {near(review.returned_on_refund)} comes back to you and{" "}
        {near(review.kept)} stays as the record.
      </dd>
      {fees.source === "preview" ? (
        <>
          <dt>Fee source</dt>
          <dd>
            Sandbox sample numbers for this preview. They are not the new
            contract's fees and are not approved.
          </dd>
        </>
      ) : null}
    </dl>
  );
}

const ADVANCED_FIELDS: [keyof Advanced, string, string][] = [
  ["branch", "Target branch", "numeric"],
  ["claim_hours", "A claim lasts (hours)", "decimal"],
  ["open_days", "Open for claims (days)", "decimal"],
  ["merge_days", "Merge deadline (days from now)", "decimal"],
  ["grace_hours", "Checking grace (hours)", "decimal"],
];

/** The two-field posting form and its review. It holds no state of its own. */
export function PostFormView(props: FormViewProps) {
  const { meta, advanced, fees } = props;
  const outcome = useMemo(
    () =>
      meta.state === "ready"
        ? reviewPosting({
            meta: meta.value,
            rewardText: props.rewardText,
            advanced,
            limits: props.limits,
            pilot: props.pilot,
            fees,
            now: props.now,
          })
        : null,
    [
      meta,
      props.rewardText,
      advanced,
      props.limits,
      props.pilot,
      fees,
      props.now,
    ],
  );
  const problems = outcome && !outcome.ok ? outcome.problems : [];
  const block = signingBlock({
    fees,
    connected: props.connected,
    poster: props.poster,
  });
  const review = outcome?.ok ? outcome.review : null;
  const idle = !block && !props.busy;
  const keyChecked = !!props.keyCheck;
  return (
    <section className="workspace-card">
      <h2>Post a bounty</h2>
      <p>
        Paste the GitHub issue and set the reward. Proven reads the repository,
        title and default branch from GitHub. The maintainer confirms the work
        by merging the pull request on GitHub.
      </p>
      <div className="bounty-form">
        <label>
          GitHub issue link
          <input
            type="url"
            value={props.link}
            placeholder="https://github.com/owner/repo/issues/12"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => props.onLink(e.target.value)}
          />
        </label>
        <label>
          Reward ({COIN})
          <input
            value={props.rewardText}
            inputMode="decimal"
            onChange={(e) => props.onReward(e.target.value)}
          />
          <FieldError problems={problems} field="reward" />
        </label>
      </div>
      <FieldError problems={problems} field="repository" />
      {meta.state === "loading" ? (
        <p role="status">Reading the issue from GitHub…</p>
      ) : null}
      {meta.state === "error" ? (
        <div role="alert" className="form-error">
          <p>
            <strong>{meta.error.message}</strong> {meta.error.action}
          </p>
          {meta.error.retriable ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={props.onRetry}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {review ? <Summary review={review} /> : null}
      <details className="bounty-advanced">
        <summary>Advanced</summary>
        <div className="bounty-form">
          {ADVANCED_FIELDS.map(([key, label, mode]) => (
            <label key={key}>
              {label}
              <input
                value={advanced[key]}
                placeholder={
                  key === "branch"
                    ? meta.state === "ready"
                      ? meta.value.default_branch
                      : "the repository's default branch"
                    : ADVANCED_DEFAULTS[key]
                }
                inputMode={mode === "numeric" ? undefined : "decimal"}
                spellCheck={false}
                onChange={(e) => props.onAdvanced(key, e.target.value)}
              />
              <FieldError problems={problems} field={key} />
            </label>
          ))}
        </div>
      </details>
      {props.onCheckKey ? (
        <>
          <button
            type="button"
            className="button button-secondary"
            disabled={!idle || !review}
            aria-describedby="post-blocked"
            onClick={props.onCheckKey}
          >
            Check which key my wallet signs messages with
          </button>
          {props.keyCheck ? <p role="status">{props.keyCheck}</p> : null}
        </>
      ) : null}
      <button
        type="button"
        className="button button-primary"
        disabled={!idle || !review || !keyChecked || !props.onPost}
        aria-describedby="post-blocked"
        onClick={() => review && props.onPost?.(review)}
      >
        {review ? `Post and lock ${near(review.locked)}` : "Post and lock"}
      </button>
      <p id="post-blocked" className="workspace-empty">
        {[
          review ? "" : "Enter an issue link and a reward to see the review.",
          block,
          review && !block && props.onCheckKey && !keyChecked
            ? "Check your wallet's key first. The money from a refund goes to a vault that this key alone controls."
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
      </p>
    </section>
  );
}

const DEBOUNCE_MS = 500;

/** Reads the issue when the link settles; a late answer for an older link is dropped. */
export function useIssueMetadata(
  link: string,
  transport: typeof fetch = fetch,
) {
  const [meta, setMeta] = useState<MetaState>({ state: "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Whatever was shown belongs to an older link: clear it before the new one is read.
    setMeta({ state: "idle" });
    const text = link.trim();
    if (text === "") return;
    let live = true;
    const timer = setTimeout(() => {
      const parsed = parseIssueLink(text);
      if ("kind" in parsed) {
        setMeta({ state: "error", error: parsed });
        return;
      }
      setMeta({ state: "loading" });
      void loadIssueMetadata(text, transport).then((result) => {
        if (live)
          setMeta(
            result.ok
              ? { state: "ready", value: result.value }
              : { state: "error", error: result.error },
          );
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [link, attempt, transport]);
  return { meta, retry: () => setAttempt((n) => n + 1) };
}

export function PostBountyForm(
  props: {
    limits: Limits;
    pilot: Pilot;
    fees: FeeSchedule;
    connected: boolean;
    poster: boolean;
  } & Pick<FormViewProps, "busy" | "keyCheck" | "onCheckKey" | "onPost">,
) {
  const [link, setLink] = useState("");
  const [rewardText, setRewardText] = useState("");
  const [advanced, setAdvanced] = useState<Advanced>(ADVANCED_DEFAULTS);
  const { meta, retry } = useIssueMetadata(link);
  return (
    <PostFormView
      {...props}
      link={link}
      rewardText={rewardText}
      advanced={advanced}
      meta={meta}
      now={Math.floor(Date.now() / 1000)}
      onLink={setLink}
      onReward={setRewardText}
      onAdvanced={(key, value) => setAdvanced({ ...advanced, [key]: value })}
      onRetry={retry}
    />
  );
}
