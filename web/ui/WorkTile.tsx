// One card in a grid of work: market jobs and PR bounties share it, so both lists look the same.
export type TileKind = "open" | "paid" | "closed";

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
  return (
    <a className="bounty-tile" href={props.href}>
      <div className="bounty-tile-top">
        <span>
          <i className={`bounty-dot ${props.kind}`} aria-hidden="true" />
          {props.status}
        </span>
        <strong className="bounty-tile-reward">{props.reward}</strong>
      </div>
      <h3>{props.title}</h3>
      <p className="bounty-tile-repo">{props.sub}</p>
      <span className="bounty-tag">{props.tag}</span>
      <dl className="bounty-tile-parties">
        {props.parties.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <span className="bounty-tile-link">{props.linkText} →</span>
    </a>
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
