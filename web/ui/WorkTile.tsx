import type { MouseEvent } from "react";
// One card in a grid of work: market jobs and PR bounties share it, so both lists look the same.
export type TileKind = "open" | "paid" | "closed";

const ICON: Record<TileKind, string> = { open: "→", paid: "✓", closed: "×" };

/** The same card as the recorded examples: icon, status pill, kicker, title, two details and a link,
 * with the soft spotlight that follows the cursor. The whole card opens the item. */
export function WorkTile(props: {
  href: string;
  status: string;
  kind: TileKind;
  reward: string;
  title: string;
  sub: string;
  tag: string;
  parties: [string, string][];
  linkText: string;
}) {
  const [poster, worker] = props.parties;
  // The spotlight follows the cursor, as on the recorded-example cards (style in market.css).
  const move = (event: MouseEvent<HTMLDivElement>) => {
    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
    card.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
  };
  return (
    <div className={`work-card work-card-${props.kind}`} onMouseMove={move}>
      <div className="work-card-top">
        <span className="work-card-icon" aria-hidden="true">
          {ICON[props.kind]}
        </span>
        <span className={`work-card-status ${props.kind}`}>{props.status}</span>
      </div>
      <p className="work-card-kicker">{props.sub}</p>
      <h3>
        <a className="work-card-link" href={props.href}>
          {props.title}
        </a>
      </h3>
      <p className="work-card-description">
        {poster ? `${poster[0]} ${poster[1]} · ` : ""}
        {props.tag}
      </p>
      <div className="work-card-details">
        <span>
          Reward<strong>{props.reward}</strong>
        </span>
        {worker ? (
          <span>
            {worker[0]}
            <strong>{worker[1]}</strong>
          </span>
        ) : null}
      </div>
      <span className="work-card-open" aria-hidden="true">
        {props.linkText}
        <span>→</span>
      </span>
    </div>
  );
}

/** Tabs with counts and a search box, the same on every list. */
export function TileToolbar<T extends string>(props: {
  tabs: [T, string][];
  counts: Record<T, number>;
  tab: T;
  onTab: (tab: T) => void;
}) {
  return (
    <div className="bounty-toolbar">
      <div className="bounty-tabs" role="tablist">
        {props.tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={props.tab === t}
            className={props.tab === t ? "bounty-tab active" : "bounty-tab"}
            onClick={() => props.onTab(t)}
          >
            {label} <span className="bounty-count">{props.counts[t]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
