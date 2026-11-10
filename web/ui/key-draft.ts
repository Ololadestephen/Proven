// Key proofs in progress, kept in this browser so both keys can sign through browser wallets: the
// primary account prepares the proofs, the backup key's account connects and signs its proof, and
// the primary account reconnects to sign and submit. Only public keys, signatures and the exact
// texts are stored, never a private key. A draft is ignored once its proofs have expired.
import type { KeyConfirmState } from "./key-confirm-state.ts";

export interface KeyDraft {
  contract: string;
  /** "post" for a posting, "claim:<bounty id>" for a claim. */
  scope: string;
  role: "maintainer" | "contributor";
  state: KeyConfirmState;
  /** The exact key-proof texts, present once the proofs are prepared. */
  messages: { primary: string; backup: string } | null;
  /** For a posting: the fixed terms and the hex nonce the texts cover. */
  frozen: { terms: unknown; nonce: string } | null;
}

export interface BackupCandidate {
  account: string;
  key: string;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key"> & {
  readonly length: number;
};

const PREFIX = "proven:key-draft:";
const draftKey = (contract: string, scope: string) =>
  `${PREFIX}${contract}:${scope}`;
const candidatesKey = (contract: string) => `proven:backup-keys:${contract}`;

export function browserStore(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function read(store: Store | null, key: string): unknown {
  try {
    return JSON.parse(store?.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

const live = (d: KeyDraft, nowSecs: number) =>
  d.state.expiresAt === null || d.state.expiresAt > nowSecs;

function isDraft(v: unknown): v is KeyDraft {
  const d = v as KeyDraft;
  return (
    !!d &&
    typeof d.contract === "string" &&
    typeof d.scope === "string" &&
    !!d.state &&
    typeof d.state === "object" &&
    typeof d.state.proofs === "object"
  );
}

export function loadDraft(
  store: Store | null,
  contract: string,
  scope: string,
  nowSecs: number,
): KeyDraft | null {
  const d = read(store, draftKey(contract, scope));
  return isDraft(d) &&
    d.contract === contract &&
    d.scope === scope &&
    live(d, nowSecs)
    ? { ...d, state: { ...d.state, error: null } }
    : null;
}

export function saveDraft(store: Store | null, draft: KeyDraft) {
  try {
    store?.setItem(
      draftKey(draft.contract, draft.scope),
      JSON.stringify({ ...draft, state: { ...draft.state, error: null } }),
    );
  } catch {
    /* Without storage the proofs live only in this page. */
  }
}

export function clearDraft(
  store: Store | null,
  contract: string,
  scope: string,
) {
  try {
    store?.removeItem(draftKey(contract, scope));
  } catch {
    /* Nothing to clear. */
  }
}

export function listDrafts(
  store: Store | null,
  contract: string,
  nowSecs: number,
): KeyDraft[] {
  const out: KeyDraft[] = [];
  for (let i = 0; store && i < store.length; i++) {
    const k = store.key(i);
    if (!k?.startsWith(`${PREFIX}${contract}:`)) continue;
    const d = read(store, k);
    if (isDraft(d) && d.contract === contract && live(d, nowSecs)) out.push(d);
  }
  return out;
}

/** Drafts whose backup proof the connected account may sign: prepared, backup still missing,
 * and prepared by another account (the backup key belongs to a different account). */
export function backupProofsToSign(
  drafts: KeyDraft[],
  connected: string,
): KeyDraft[] {
  return drafts.filter(
    (d) =>
      !!d.messages &&
      !!d.state.backup &&
      !d.state.proofs.backup &&
      !!d.state.actor &&
      d.state.actor !== connected,
  );
}

export function loadCandidates(
  store: Store | null,
  contract: string,
): BackupCandidate[] {
  const v = read(store, candidatesKey(contract));
  return Array.isArray(v)
    ? v.filter(
        (c): c is BackupCandidate =>
          !!c && typeof c.account === "string" && typeof c.key === "string",
      )
    : [];
}

export function addCandidate(
  store: Store | null,
  contract: string,
  c: BackupCandidate,
) {
  const rest = loadCandidates(store, contract).filter(
    (x) => x.account !== c.account,
  );
  try {
    store?.setItem(
      candidatesKey(contract),
      JSON.stringify([...rest, c].slice(-10)),
    );
  } catch {
    /* The key can still be pasted. */
  }
}

/**
 * Adds the proofs a stored draft holds for exactly the same keys, actor and expiry (so for the
 * same texts) to the page's state. Returns the same object when there is nothing to add.
 */
export function withStoredProofs(
  state: KeyConfirmState,
  stored: KeyDraft | null,
): KeyConfirmState {
  if (!stored || !state.actor) return state;
  const s = stored.state;
  if (
    s.actor !== state.actor ||
    s.expiresAt !== state.expiresAt ||
    s.primary !== state.primary ||
    s.backup !== state.backup
  )
    return state;
  const missing = (["primary", "backup"] as const).filter(
    (k) => !state.proofs[k] && s.proofs[k],
  );
  if (!missing.length) return state;
  const proofs = { ...state.proofs };
  for (const k of missing) proofs[k] = s.proofs[k];
  return { ...state, proofs };
}
