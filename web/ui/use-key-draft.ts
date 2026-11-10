// Keeps one form's key proofs in this browser while both keys sign, and picks up a backup proof
// the backup key's account signed here (see key-draft.ts and BackupSigner in KeyConfirm.tsx).
import { useEffect, useReducer, useRef, useState } from "react";
import {
  initialKeyState,
  keyReducer,
  type KeyConfirmState,
} from "./key-confirm-state.ts";
import {
  browserStore,
  clearDraft,
  loadDraft,
  saveDraft,
  withStoredProofs,
  type KeyDraft,
} from "./key-draft.ts";

const nowSecs = () => Math.floor(Date.now() / 1000);

export function useKeyDraft(opts: {
  contract: string;
  scope: string;
  role: KeyDraft["role"];
  connected: string;
  messages: (state: KeyConfirmState) => KeyDraft["messages"];
  frozen: KeyDraft["frozen"];
}) {
  const { contract, scope, role, connected } = opts;
  // A draft is picked up only by the account that prepared it.
  const [initial] = useState(() => {
    const d = loadDraft(browserStore(), contract, scope, nowSecs());
    return d && d.state.actor === connected ? d : null;
  });
  const [state, dispatch] = useReducer(
    keyReducer,
    initial?.state ?? initialKeyState,
  );
  const latest = useRef(opts);
  latest.current = opts;
  const frozenKey = JSON.stringify(opts.frozen);
  useEffect(() => {
    const sync = () => {
      const store = browserStore();
      const merged = withStoredProofs(
        state,
        loadDraft(store, contract, scope, nowSecs()),
      );
      if (merged !== state) return dispatch({ type: "restore", state: merged });
      saveDraft(store, {
        contract,
        scope,
        role,
        state,
        messages: latest.current.messages(state),
        frozen: latest.current.frozen,
      });
    };
    sync();
    const timer = setInterval(sync, 3000);
    return () => clearInterval(timer);
  }, [state, frozenKey, contract, scope, role]);
  const finish = () => {
    clearDraft(browserStore(), contract, scope);
    dispatch({ type: "reset" });
  };
  return { state, dispatch, initial, finish };
}
