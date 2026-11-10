# PR merge bounties: rules (pilot)

Claim: **automatic payout after an attested GitHub merge check.** GitHub supplies the facts. The maintainer decides whether to merge. The contract relies on OutLayer's authenticated result and its approved workers. Checking each run's Intel TDX quote independently, for example with `outlayer-verify`, is a separate evidence check that anyone can repeat. This job type does not use the buyer-written check challenge that Proven's data and function jobs use.

This is a pilot on one public repository approved by the contract owner. The contract is deployed with that repository's `owner/name` and its stable numeric GitHub id, which never change, and refuses a bounty for any other repository, or for the approved id paired with another name. It is not open to arbitrary repositories, private repositories or automated GitHub writes. There is no hosted agent, no signup fee and no model in the loop.

## What one bounty is

- One public repository: the pilot repository, by its `owner/name` and its numeric GitHub id, exactly as fixed at deployment. Every GitHub answer about a pull request must carry the same repository id.
- One issue of that repository.
- One target branch, the branch the pull request must merge into.
- One contributor, fixed at posting by their numeric GitHub user id. The maintainer chooses who works on the issue, as when assigning it.
- One pull request, nominated by the maintainer and bound by its numeric id.
- One reward in native NEAR.
- Two recipient vaults: the contributor's payout goes to a vault controlled by the contributor's two keys, and the maintainer's refund and budget return go to a vault controlled by the maintainer's two keys. Money never goes to an account name.

## The parties

| Party | NEAR account | GitHub account |
|---|---|---|
| Maintainer (buyer) | Posts and funds the bounty with a primary and a backup key, nominates the pull request. Refunds and the budget return go to the vault of those two keys. Must be on the owner's allowlist | Merges, or does not merge, the pull request |
| Contributor | The wallet that proves the claim, with a primary and a backup key; the payout goes to the vault of those two keys | Owns the claim gist and authors the pull request |
| Contract owner | Manages the allowlist, the caps, the sponsor limits and the pause on new bounties. Cannot move funds, change a bounty or record a result | None |
| Sponsor account | Fixed at deployment. Funds the sponsor float and receives the unused compute of sponsored checks | None |
| Anyone | May start a self-funded merge check, settle an expired bounty, send a due settlement, record a settlement's result, and reconcile after 24 hours. Money only ever goes to the recorded vault | None |

## Who can do what, and what it costs

All amounts are testnet values for the pilot.

| Action | Who | Attaches | Unused compute goes to |
|---|---|---|---|
| Post a bounty | An allowlisted maintainer, while posting is not paused, with both key proofs | reward + 0.03 NEAR merge-check budget + 0.029 NEAR storage, exactly | n/a |
| Cancel before anyone has claimed | The maintainer | nothing | n/a |
| Prove a claim | Any wallet with both key proofs, but only the contributor's GitHub account can make it succeed | 0.01 NEAR compute | the wallet that proved |
| Nominate the pull request | The maintainer | 0.01 NEAR compute | the maintainer |
| Sponsored merge check | The contributor's recorded wallet, up to 3 times, while the sponsor float and the sponsor caps allow it | nothing | the sponsor account |
| Check the merge, self-funded | Anyone | 0.01 NEAR compute | the caller |
| Settle after expiry, or after an ineligible merge | Anyone | nothing | n/a |
| Send a due settlement (`send_due`) | Anyone | nothing | n/a |
| Record a settlement's result from its recorded outcome (`recover_settlement`) | Anyone | nothing | n/a |
| Reconcile an in-flight settlement with its vault | A bounty party after 15 minutes, anyone after 24 hours | exactly 0.01 NEAR, at least 40 Tgas | what the vault does not keep returns to the caller |
| Withdraw from a vault | Anyone who submits an authorization signed by one of the vault's two keys | nothing; the submitter pays the gas | n/a |
| Fund the sponsor float (`fund_sponsor`) | The owner or the sponsor account | the exact amount, up to the float cap | n/a |
| Forward OutLayer's stale cancellation | Anyone | nothing | OutLayer refunds the run's own payer |

Every OutLayer run attaches exactly 0.01 NEAR, above OutLayer's 0.0040005 NEAR admission estimate for these limits. OutLayer keeps its charge, about 0.0011 NEAR, and returns the rest to the run's payer. Each call also needs at least 260 Tgas attached. On testnet, gas is bought upfront at ten times its burn price and the difference comes back.

## Money is kept apart

- **The reward** is locked from posting until it is paid to the contributor or refunded to the maintainer.
- **The merge-check budget** (0.03 NEAR) stays fully reserved and returns in full to the maintainer's vault: with a payout as a separate budget return, with a refund inside the refund (reward + 0.03 NEAR). Sponsored checks never spend it.
- **Sponsored checks** let the contributor verify even if the maintainer stops cooperating. They are paid from the **sponsor float**, a ledger the owner or the sponsor account funds with `fund_sponsor`. Each sponsored run debits exactly 0.01 NEAR from the float. OutLayer records the sponsor account as the run's payer and refund receiver, so its unused compute, and the whole 0.01 NEAR if OutLayer refuses the run, go to the sponsor account, whenever they arrive. Limits: 3 sponsored runs per bounty, a cap on the float (`max_sponsor_float`, at most 1 NEAR) and a cap on the total spent (`max_sponsor_spent`, at most 2 NEAR). The float has no withdrawal method; it returns to the owner only if the contract account is deleted. An empty float stops only sponsored checks: self-funded checks, expiry refunds, settlements, recovery and withdrawals keep working. Anyone, including the maintainer, can always pay for their own checks.
- **The storage deposit** (0.029 NEAR) pays for the bounty record, the posting nonce, the used-pull-request entry, the settlement records, the storage the vaults keep, and the settlement fees while they are in flight. For the largest bounty the contract accepts (64-character accounts, a 255-byte branch, two new vaults) the sandbox measured 0.02816 NEAR at the peak, with both fees in flight, and 0.0257 NEAR kept. It settled that payout, a refund, and a retry of each after failed sends, on a contract with no other spare balance and without touching the sponsor float. What the deposit does not use stays in the contract's free balance.
- **Settlement fees**: each deposit into a vault attaches 0.006 NEAR on top of the principal from the contract's free balance. The vault keeps exactly its storage shortfall (0.00477 NEAR for a new vault and its first record, 0.00091 NEAR for another record) and returns the rest to the contract.
- **Claim and nomination checks** are paid by whoever starts them.

## Steps and deadlines

The maintainer sets three times when posting, in Unix seconds:

- `claim_by`: the last moment a claim proof may be started;
- `bind_by`: the last moment a nomination check may be started;
- `merge_deadline`: the merge must happen strictly before this second.

There is also a grace period of 10 minutes to 1 day after `merge_deadline`, for starting checks of a merge that happened in time. The contract requires `now < claim_by ≤ bind_by ≤ merge_deadline`, with at most 30 days from posting to `merge_deadline`.

NEAR block times are in nanoseconds. A rule that says "before T" for a deadline T in seconds means the block timestamp is less than T × 10⁹.

1. **Claim.**
   - The contributor chooses a primary and a backup ed25519 key and signs a key proof with each (see "Vaults and keys"). The wallet reads its challenge from the contract. The challenge is `proven-claim:` followed by the hex SHA-256 of `proven-pr-bounty-claim:v3|<network>|<contract>|<bounty>|<repo owner/name>|<repo id>|<issue>|<wallet>|<GitHub user id>|<expires_at>|<key pair digest>`, where the key pair digest is the hex SHA-256 of the borsh string `proven-key-pair:v1` followed by the 32 bytes of the primary key and then of the backup key. `expires_at` is in Unix seconds, in the future and at most one hour ahead when the proof starts, and the same value the key proofs name.
   - Signed in to GitHub as the contributor, the contributor creates a gist, secret or public, with exactly one file whose whole text is that challenge.
   - The wallet then calls `prove_claim` with the gist's id, `expires_at`, the key pair and both key-proof signatures, before both `claim_by` and `expires_at`. The contract checks both key proofs before it starts the run.
   - The verifier reads `GET /gists/<id>` without a credential and sends back three facts: the gist owner's numeric id, the number of files, and whether its one file's whole text, trimmed of surrounding whitespace, equals the challenge the contract sent. It gives no result if GitHub's answer is about another gist, has no owner, lists a truncated file set, or has any truncated file (GitHub truncates file text above 1 MB and file lists above 300 files).
   - The contract accepts the claim only if all of these hold:
     - the gist's owner id is the bounty's contributor id;
     - the gist has exactly one file;
     - that file's text is this wallet's challenge for this bounty and expiry.
   - The first accepted proof fixes the claiming wallet, the GitHub id, the gist id, the key pair and its vault. They never change. Removing the gist later changes nothing.
2. **Nominate.**
   - The maintainer names the pull request number, before `bind_by`. Nominating is the maintainer's decision that this pull request is the work for this issue.
   - The verifier reads the pull request. The contract binds it only if all of these hold:
     - it is open and not merged;
     - its base repository id matches;
     - it targets the agreed branch;
     - its author id is the claimed GitHub id;
     - its id has never been bound to any bounty of this contract.
   - The pull request's id is then recorded as used, and the run's request time is recorded as the binding time.
   - If a nomination fails its checks, the maintainer may nominate again before `bind_by`.
3. **Check the merge**, before `merge_deadline` plus grace. Eligible means all of these hold:
   - the bound pull request id, repository id, number, author id and base branch all match;
   - the pull request is merged;
   - `merged_at < merge_deadline`;
   - `merged_at` is no more than 60 seconds before the binding time.

   GitHub reports `merged_at` truncated to whole seconds, so `merged_at < D` holds exactly when the true merge instant is before D. The binding run saw the pull request open and unmerged after the binding time, which shows the merge came later. The 60-second rule only rejects answers that contradict that order, allowing for the difference between GitHub's clock and block time. Such an answer gives no verdict.

   What happens next:
   - An eligible check records the payout to the contributor's vault and the budget return to the maintainer's vault, and then sends both in a separate call, so the verdict never depends on the sends.
   - An open, or closed and unmerged, pull request is **pending**, and the bounty stays checkable.
   - A merge at or after the deadline, or into another branch, is **ineligible**, which is final: the maintainer may then be refunded at once.
   - The grace period only gives time to start a check. It never makes a late merge eligible.
4. **Refund.** Anyone may settle a bounty to the maintainer's vault, for the reward plus the full 0.03 NEAR budget, when one of these holds:
   - it was never claimed, and `claim_by` plus 15 minutes has passed, so any proof started before `claim_by` has had time to finish;
   - it was claimed but nothing was bound, `bind_by` has passed, and no nomination check is still live;
   - it is bound, `merge_deadline` plus grace has passed, and no merge check is still live;
   - its merge was ineligible.

   The maintainer may also cancel at any time before a claim is accepted.

## Races at the boundaries

- **A run started before its deadline counts if its result arrives within 15 minutes.** A nomination check or merge check started before its deadline settles even if its result lands after it. A refund waits while that check is live.
- **After 15 minutes a run is stale.** Its late result is recorded as stale and changes nothing. The next check, or the refund, may proceed.
- **Cancellation against a claim in flight.** Claim proofs keep no state while in flight, so a maintainer's cancellation can win against a proof whose result has not landed. That proof's wallet loses only its compute charge.
- **One run at a time.** Only one nomination or merge check runs per bounty at a time, and each carries a sequence number. A result that does not match the live run's sequence number, bounty, contract, network, operation and target is ignored.

## Identity: what is and is not proved

- **The wallet:** a signed NEAR transaction shows the wallet's holder started the proof.
- **The keys:** both key proofs show the holders of the primary and the backup key agreed to receive this bounty's money. The contract checks that the keys differ; it cannot check that they are held separately.
- **The GitHub account:** a gist owned by the contributor's numeric GitHub id, carrying a challenge that names this network, contract, bounty, repository, issue, wallet, GitHub id and expiry, shows that account's holder chose this wallet.
- **Why a gist and not an issue comment:** repository writers can edit anyone's comments on their issues, and GitHub's timestamps cannot rule such an edit out. Only a gist's owner can create or edit it, so a maintainer or another writer cannot put a challenge in the contributor's name.
- **What fails:**
  - a copied challenge, in a gist owned by another account, has the wrong owner id;
  - a challenge for another wallet, bounty, repository, issue or expiry does not match the caller's;
  - a gist with more than one file is refused as ambiguous;
  - an answer about another gist, or for another bounty or run, is refused as wrongly bound;
  - an expired challenge, or one more than an hour ahead, is refused before any run starts;
  - a matching login proves nothing, because logins are never compared.
- **No credential:** the verifier uses no GitHub credential, so nothing can leak.
- **Why nobody else can grab the claim:** the maintainer fixes the contributor's GitHub id at posting. Only that account can own a qualifying gist. Any wallet may try, at its own cost, and fail.
- **Not proved:** that the contributor did the work, that the pull request solves the issue, or that it is any good. The maintainer decides that by nominating and merging. Proven verifies the merge, and nothing about the work.

## Vaults and keys

- **A vault per key pair.** Each recipient is an ordered pair of distinct ed25519 public keys, a primary key and a backup key. Its vault is a NEP-616 deterministic account: the address is derived from the vault code's hash, pinned at deployment, and the two keys, so it can receive a deposit before it exists. A reused key pair shares one vault, and its withdrawals are shown for the vault as a whole.
- **Not an account name.** A deleted or re-registered NEAR account name receives nothing and cannot withdraw. Deleting or rotating the account access key that is a vault key removes the ability to sign with it through that account; it does not change the vault's keys.
- **Either key alone can withdraw everything.** Losing both keys leaves the vault inaccessible, and no operator can recover the funds.
- **Key proofs.** Each key signs, as a NEP-413 message to the contract, a text naming the role, network, contract, actor, the posting's nonce and terms digest (maintainer) or the bounty and GitHub id (contributor), which key is signing, both keys and an expiry at most one hour ahead. Its NEP-413 nonce is the SHA-256 of the text. A maintainer's posting nonce is fresh, 32 bytes, and consumed when the bounty is posted.
- **Withdrawals.** One of the two keys signs, as a NEP-413 message to the vault, `proven-vault-withdraw:v2|chain=<chain id>|vault=<vault>|to=<destination>|amount=<yoctoNEAR>|n=<withdrawal number>|deadline=<Unix seconds>`, with the withdrawal number as its nonce. Anyone may submit it as the vault's `withdraw` JSON call; the vault checks the signature, that the number is its current one, and that the deadline is in the future and at most 15 minutes ahead, then uses the number and sends the amount. If the transfer fails, the amount returns to the vault and a new authorization uses the next number.
- **The browser and the command line.** The web page signs and submits withdrawals through the connected wallet as an ordinary JSON function call, and also shows the equivalent NEAR CLI `call-function ... json-args` command. Browser wallet withdrawal is pending until a real testnet wallet has completed one through the page.
- **What the page says about a withdrawal.** It keeps the transaction hash the wallet returns, also when the wallet reports a failure or an incomplete outcome, and reads the finalized transaction. It shows **delivered** only when the transaction is exactly one `withdraw` call to the vault with the signed destination, amount and number, and the transfer that call created, from the vault to that destination for exactly that amount, succeeded. It shows **returned** only when that transfer failed and the refund it created, back to the vault for the same amount, succeeded. It shows **refused** when the call itself failed. Anything else, including an answer that is not final, partial, mismatched or malformed, stays **pending**, and no new withdrawal is offered while a pending one still holds the vault's current number before its deadline.

## Settlements

- **No payout and refund on the same bounty.** A bounty reaches `Paid` or `Refunded` once, from a state that allows only one of them.
- **Each settlement has a fixed vault, key pair and principal**, recorded when the bounty is paid or refunded: the payout (the reward) to the contributor's vault, the budget return (0.03 NEAR) to the maintainer's vault, or the refund (reward + 0.03 NEAR) to the maintainer's vault. Nothing can change them.
- **Each send is a numbered attempt.** The contract marks the settlement in flight, raises its attempt number, and sends the vault's state with a `deposit` of exactly the principal plus the fee, tagged with the bounty, the kind and the attempt. Two callbacks follow on the same receipt:
  - `on_settle` does the bookkeeping: a success marks the settlement done; a failure makes it due again;
  - `on_settle_outcome` only records the runtime's result for that attempt.
  - A result for any attempt other than the current one changes nothing.
- **The vault keeps a record per contract, bounty and kind**: the attempt deposited, the exact amount, and the highest attempt sealed. It refuses a second deposit and a deposit for a sealed attempt; that NEAR returns to the contract.
- **Reserved until confirmed.** A principal stays in the contract's `held` until its deposit is confirmed, so the total cap holds while settlements are in flight or due.
- **Recovery.** If the bookkeeping callback did not run, anyone may call `recover_settlement`, which finishes the attempt from its recorded result and sends nothing. If neither callback ran, a bounty party may `reconcile` 15 minutes after the attempt was sent, and anyone after 24 hours. The contract asks the vault to seal that attempt: a deposit of exactly the principal for that attempt marks the settlement done; a seal with no deposit makes it due. One reconcile runs at a time; its marker expires after 10 minutes, so a reconcile whose callback failed can be retried. Each resend restarts both delays, so nobody can keep interrupting fresh sends. The contract's balance never decides an outcome.
- **A due settlement can be sent by anyone, to the same vault, for the same principal** (`send_due`). A send waits while the contract's free balance (balance minus storage, minus the principals still in the contract, minus the sponsor float) cannot cover its fee; for example, a resend waits until a sealed late deposit's NEAR has come back.
- `get_free_balance` reports that free balance.

## Pilot limits

The owner sets these at deployment and may lower or raise them within the contract's hard maximums:

- the maximum reward per bounty, at most 5 NEAR;
- the maximum total held, at most 10 NEAR, counting every settlement until its deposit is confirmed;
- the maximum open bounties per maintainer;
- the posting allowlist;
- the sponsor float cap (at most 1 NEAR) and the cap on total sponsored spending (at most 2 NEAR).

The owner's pause stops new bounties only. Claiming, nominating, checking, settling, sending, recording results, reconciling and withdrawing always work. The pilot repository cannot be changed; another repository needs another deployment.

## Evidence

- Every run's OutLayer request id is copied from the worker into the verifier's answer, and recorded with the claim, the binding and the merge.
- It can be matched against OutLayer's `execution_requested` event in the same transaction.
- `GET https://testnet-api.outlayer.ai/attestations/by-request/<id>` and `outlayer-verify tx <hash> --network testnet` check the run's code hash, input hash and output hash, and its Intel TDX quote.
