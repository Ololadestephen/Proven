# NEP-616 vault settlement: disposable sandbox prototype

Sandbox only. Nothing here is used by the production PR bounty contract or the web page, and nothing is published or deployed. It answers two questions:

- Can an escrow settle a payout or refund into a recipient's deterministic vault, and still reconcile that exact settlement after both of its callbacks fail?
- Can the recipient be a key rather than an account name, so that re-registering a deleted name gains nothing?

## Pieces

- `vault/`: the vault, about 9 KB, no dependencies, raw host functions.
  - Its address is derived (NEP-616) from its code, used as a global contract by hash, and three initial entries: the recipient's ed25519 public key, a withdrawal number and a storage fund.
  - `deposit` keeps one durable record per issuer and slot (attempt and exact amount). `seal` answers with that record; if there is none, it first seals the attempt so a later deposit for it fails.
  - Every write pays its own storage: the vault keeps exactly the shortfall of its fund and returns the rest of the attached fee to the receipt's refund account. The fund always equals the vault's bytes x 10^19 yoctoNEAR, and nothing else is taken from a reward or refund.
  - `withdraw(to, amount, seq, signature)` pays out only on a NEP-413 signature by the key over the chain, vault, destination, amount and withdrawal number. Anyone may submit it, so a relayer can pay the gas.
  - The vault has no access keys and never deploys code, adds keys or deletes itself.
- `escrow/`: a minimal escrow.
  - `reserve` locks an amount for a key, proven by that key's NEP-413 signature over the settlement.
  - `settle` sends `StateInit` plus `deposit`, followed by two callbacks. `reconcile` sends `StateInit` plus `seal` and applies the answer.
  - A resend waits until everything due is back in the escrow's balance.
  - Fault switches break both callbacks, the funding receipt or the reconcile callback, or hold the funding receipt back.
- `actor/`: test helper for actions near-workspaces 0.24 cannot send.
- `harness/`: near-workspaces tests (`lifecycle`, `identity`, `accounting`, `faults`).

## Run

```bash
cd prototypes/nep616-vault
./build.sh                    # all three contracts; prints size and SHA-256
./build.sh vault              # the vault only (reproducible: same hash from a copy elsewhere)
cargo test -p proven-proto-harness -- --nocapture --test-threads 1
```

The sandbox is neard 2.14.0 (commit bc4e9e8c), protocol 88.
