# NEP-616 vault settlement: disposable sandbox prototype

Sandbox only. Nothing here is used by the production PR bounty contract or the web page, and nothing is published or deployed. It tests one question: can an escrow settle a payout or refund into a recipient's deterministic vault, and still reconcile that exact settlement after both of its callbacks fail?

## Pieces

- `vault/`: the vault. Its address is derived (NEP-616) from its code, used as a global contract by hash, and a state that names one recipient.
  - Anyone may send it NEAR. Only the recipient can withdraw, and a withdrawal sends everything above the vault's storage stake.
  - `deposit(bounty, kind, attempt)` keeps one durable record per issuer and slot: the attempt and the exact attached amount.
  - `seal(bounty, kind, attempt)` answers with that record. If there is no deposit, it first marks every attempt up to `attempt` as sealed and refuses later deposits for them.
  - The vault has no keys and never deploys code, adds keys or deletes itself.
- `escrow/`: a minimal escrow.
  - `reserve` locks an amount for a recipient.
  - `settle` sends one receipt to the vault, `StateInit` plus `deposit`, followed by two callbacks.
  - `reconcile` sends `StateInit` plus `seal` and applies the answer in its own callback: a deposit for this attempt and amount releases the reservation once; a sealed attempt with no deposit makes it due again.
  - Fault switches make both callbacks fail, make the funding receipt fail, make the reconcile callback fail, or hold the funding receipt back behind self-calls.
- `actor/`: a test helper that sends the actions near-workspaces 0.24 cannot (global deploy, third-party `StateInit`, forbidden actions on a vault, withdraw-then-delete).
- `harness/`: near-workspaces tests.

## Run

```bash
cd prototypes/nep616-vault
./build.sh                                                   # prints each WASM's size and SHA-256
cargo test -p proven-proto-harness -- --nocapture --test-threads 1
```

The sandbox is neard 2.14.0 (commit bc4e9e8c), protocol 88. Each test prints the receipt trace of its fault cases.
