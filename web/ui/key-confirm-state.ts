// The two-key confirmation before a funded posting or claim, as a pure state machine. The page
// keeps one of these per form; KeyConfirm.tsx renders it. A proof is kept only after it verifies
// locally: an ed25519 signature by the key its message names, over that message's NEP-413 hash
// for the bounty contract. Nothing here touches a private key.
import {
  ed25519Key,
  keyProofHash,
  signatureBytes,
  verifies,
  type KeyPair,
  type Signing,
} from "./bounty-keys.ts";

/** Shown before any funded transaction (Requirements 8.11 to 8.14). */
export const KEY_STATEMENTS = [
  "Either the primary key or the backup key alone can move all funds in the vault.",
  "If you lose both keys, the vault cannot be opened and no operator can recover the funds.",
  "The vault is controlled by these two keys, not by your NEAR account name. Deleting or rotating the account access key that is your primary or backup key removes your ability to sign with that key through that account; it does not change the vault's keys.",
  "The contract can check only that the two keys differ. It cannot check that you hold them separately.",
] as const;
/** Requirement 8.17: wallets whose NEP-413 signing test through the connector has passed. */
export const TESTED_WALLETS = "none yet";
/** Requirement 8.18. */
export const LEDGER_NOTE = "Ledger support is unverified.";
export const SEPARATE_CONFIRMATION =
  "I hold the backup key separately from the primary key.";

export interface Proof {
  signature: string;
  expiresAt: number;
  actor: string;
}

export interface KeyConfirmState {
  primary: string | null;
  backup: string | null;
  /** The actor and expiry the messages were built for. */
  actor: string | null;
  expiresAt: number | null;
  proofs: Partial<Record<Signing, Proof>>;
  separate: boolean;
  error: string | null;
}

export const initialKeyState: KeyConfirmState = {
  primary: null,
  backup: null,
  actor: null,
  expiresAt: null,
  proofs: {},
  separate: false,
  error: null,
};

export type KeyAction =
  | { type: "primary"; key: string }
  | { type: "backup"; key: string }
  | { type: "start"; actor: string; expiresAt: number }
  | {
      type: "signed";
      signing: Signing;
      publicKey: string;
      signature: string;
      message: string;
      contract: string;
    }
  | { type: "rejected"; signing: Signing }
  | { type: "separate"; value: boolean }
  | { type: "error"; text: string }
  /** The signed terms changed: the proofs no longer cover them. */
  | { type: "clear" }
  | { type: "refused"; check: SubmitCheck }
  | { type: "reset" };

const label = (s: Signing) => (s === "primary" ? "primary key" : "backup key");

function isEd25519(text: string): boolean {
  try {
    ed25519Key(text);
    return true;
  } catch {
    return false;
  }
}

export function keyReducer(
  state: KeyConfirmState,
  action: KeyAction,
): KeyConfirmState {
  switch (action.type) {
    case "reset":
      return initialKeyState;
    case "primary": {
      if (!isEd25519(action.key))
        return { ...state, error: "The primary key is not an ed25519 key." };
      if (action.key === state.backup)
        return {
          ...state,
          backup: null,
          proofs: {},
          error:
            "The backup key must differ from the primary key. Choose another backup key.",
        };
      // A new key pair needs new proofs.
      return { ...state, primary: action.key, proofs: {}, error: null };
    }
    case "backup": {
      if (!isEd25519(action.key))
        return { ...state, error: "The backup key is not an ed25519 key." };
      if (action.key === state.primary)
        return {
          ...state,
          backup: null,
          proofs: { primary: state.proofs.primary },
          error:
            "The backup key must differ from the primary key. Choose another backup key.",
        };
      return { ...state, backup: action.key, proofs: {}, error: null };
    }
    case "start":
      return {
        ...state,
        actor: action.actor,
        expiresAt: action.expiresAt,
        proofs: {},
        error: null,
      };
    case "rejected":
      return {
        ...state,
        error: `The ${label(action.signing)} proof was not signed. Sign it to continue.`,
      };
    case "separate":
      return { ...state, separate: action.value };
    case "error":
      return { ...state, error: action.text };
    case "clear":
      return { ...state, actor: null, expiresAt: null, proofs: {} };
    case "refused":
      return afterRefusedSubmit(state, action.check);
    case "signed": {
      const named = action.signing === "primary" ? state.primary : state.backup;
      const keep = { ...state.proofs };
      delete keep[action.signing];
      const fail = (why: string) => ({
        ...state,
        proofs: keep,
        error: `The ${label(action.signing)} proof was refused: ${why} Sign it again.`,
      });
      if (!named || !state.actor || !state.expiresAt)
        return fail("the keys are not chosen yet.");
      if (!isEd25519(action.publicKey))
        return fail("the signing key is not ed25519.");
      if (action.publicKey !== named)
        return fail(`it was signed by ${action.publicKey}, not by ${named}.`);
      let sig: Uint8Array;
      try {
        sig = signatureBytes(action.signature);
      } catch {
        return fail("the signature is malformed.");
      }
      const ok = verifies(
        sig,
        keyProofHash(action.message, action.contract),
        ed25519Key(named),
      );
      if (!ok) return fail("the signature does not match the message.");
      return {
        ...state,
        proofs: {
          ...state.proofs,
          [action.signing]: {
            signature: action.signature,
            expiresAt: state.expiresAt,
            actor: state.actor,
          },
        },
        error: null,
      };
    }
  }
}

export function keyPair(state: KeyConfirmState): KeyPair | null {
  return state.primary && state.backup && state.primary !== state.backup
    ? { primary: state.primary, backup: state.backup }
    : null;
}

export type SubmitCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "separate" | "actor" | "expired" };

/** Checked when the user submits: proofs present, actor matches, not expired, held separately. */
export function submitCheck(
  state: KeyConfirmState,
  connected: string,
  nowSecs: number,
): SubmitCheck {
  const { primary, backup } = state.proofs;
  if (!keyPair(state) || !primary || !backup)
    return { ok: false, reason: "missing" };
  if (primary.actor !== connected || backup.actor !== connected)
    return { ok: false, reason: "actor" };
  if (primary.expiresAt <= nowSecs || backup.expiresAt <= nowSecs)
    return { ok: false, reason: "expired" };
  if (!state.separate) return { ok: false, reason: "separate" };
  return { ok: true };
}

/** What a refused submit does to the state: actor mismatch drops both proofs, expiry drops them. */
export function afterRefusedSubmit(
  state: KeyConfirmState,
  check: SubmitCheck,
): KeyConfirmState {
  if (check.ok) return state;
  if (check.reason === "actor")
    return {
      ...state,
      proofs: {},
      error:
        "The connected account is not the account these proofs name. Sign new proofs as the connected account.",
    };
  if (check.reason === "expired")
    return {
      ...state,
      proofs: {},
      error: "A key proof expired. Sign the proofs again.",
    };
  if (check.reason === "separate")
    return {
      ...state,
      error: "Confirm that you hold the backup key separately.",
    };
  return { ...state, error: "Both key proofs are needed." };
}
