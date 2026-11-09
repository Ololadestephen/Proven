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

## The parties

| Party | NEAR account | GitHub account |
|---|---|---|
| Maintainer (buyer) | Posts and funds the bounty, nominates the pull request, receives refunds and unused compute. Must be on the owner's allowlist | Merges, or does not merge, the pull request |
| Contributor | The payout wallet, fixed when the claim is proved | Owns the claim gist and authors the pull request |
| Contract owner | Manages the allowlist, the caps and the pause on new bounties. Cannot move funds, change a bounty or record a result | None |
| Anyone | May start a self-funded merge check, settle an expired bounty, record a transfer's result and resend a failed transfer. Money only ever goes to the recorded beneficiary | None |

## Who can do what, and what it costs

All amounts are testnet values for the pilot.

| Action | Who | Attaches | Unused compute goes to |
|---|---|---|---|
| Post a bounty | An allowlisted maintainer, while posting is not paused | reward + 0.03 NEAR merge-check budget + 0.02 NEAR storage, exactly | n/a |
| Cancel before anyone has claimed | The maintainer | nothing | n/a |
| Prove a claim | Any wallet, but only the contributor's GitHub account can make it succeed | 0.01 NEAR compute | the wallet that proved |
| Nominate the pull request | The maintainer | 0.01 NEAR compute | the maintainer |
| Check the merge from the bounty's budget | The contributor's recorded wallet, up to 3 times | nothing | the maintainer, who funded the budget |
| Check the merge, self-funded | Anyone | 0.01 NEAR compute | the caller |
| Settle after expiry, or after an ineligible merge | Anyone | nothing | n/a |
| Record a transfer's result from its recorded outcome (`recover_transfer`) | Anyone | nothing | n/a |
| Resend a failed transfer | Anyone | nothing | n/a |
| Forward OutLayer's stale cancellation | Anyone | nothing | OutLayer refunds the run's own payer |

Every OutLayer run attaches exactly 0.01 NEAR, above OutLayer's 0.0040005 NEAR admission estimate for these limits. OutLayer keeps its charge, about 0.0011 NEAR, and returns the rest to the run's payer. Each call also needs at least 250 Tgas attached. On testnet, gas is bought upfront at ten times its burn price and the difference comes back.

## Money is kept apart

- **The reward** is locked from posting until it is paid to the contributor or refunded to the maintainer.
- **The merge-check budget** (3 × 0.01 NEAR) is reserved so the contributor can verify even if the maintainer stops cooperating. Only the contributor's wallet can spend it, so nobody can drain it with their own checks. Anyone else, including the maintainer, pays for their own checks. Whatever is left goes back to the maintainer at the end.
- **The storage deposit** (0.02 NEAR) pays for the bounty record and the used-pull-request entry. Both are kept permanently as evidence, so this deposit is not returned.
- **Claim and nomination checks** are paid by whoever starts them.

## Steps and deadlines

The maintainer sets three times when posting, in Unix seconds:

- `claim_by`: the last moment a claim proof may be started;
- `bind_by`: the last moment a nomination check may be started;
- `merge_deadline`: the merge must happen strictly before this second.

There is also a grace period of 10 minutes to 1 day after `merge_deadline`, for starting checks of a merge that happened in time. The contract requires `now < claim_by ≤ bind_by ≤ merge_deadline`, with at most 30 days from posting to `merge_deadline`.

NEAR block times are in nanoseconds. A rule that says "before T" for a deadline T in seconds means the block timestamp is less than T × 10⁹.

1. **Claim.**
   - The contributor's wallet reads its challenge from the contract. The challenge is `proven-claim:` followed by the hex SHA-256 of `proven-pr-bounty-claim:v2|<network>|<contract>|<bounty>|<repo owner/name>|<repo id>|<issue>|<wallet>|<GitHub user id>|<expires_at>`. `expires_at` is in Unix seconds, in the future and at most one hour ahead when the proof starts.
   - Signed in to GitHub as the contributor, the contributor creates a gist, secret or public, with exactly one file whose whole text is that challenge.
   - The wallet then calls `prove_claim` with the gist's id and `expires_at`, before both `claim_by` and `expires_at`.
   - The verifier reads `GET /gists/<id>` without a credential and sends back three facts: the gist owner's numeric id, the number of files, and whether its one file's whole text, trimmed of surrounding whitespace, equals the challenge the contract sent. It gives no result if GitHub's answer is about another gist, has no owner, lists a truncated file set, or has any truncated file (GitHub truncates file text above 1 MB and file lists above 300 files).
   - The contract accepts the claim only if all of these hold:
     - the gist's owner id is the bounty's contributor id;
     - the gist has exactly one file;
     - that file's text is this wallet's challenge for this bounty and expiry.
   - The first accepted proof fixes the payout wallet, the GitHub id and the gist id. They never change. Removing the gist later changes nothing.
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
   - An eligible check pays the reward to the recorded wallet in the same callback, and returns the unused budget to the maintainer.
   - An open, or closed and unmerged, pull request is **pending**, and the bounty stays checkable.
   - A merge at or after the deadline, or into another branch, is **ineligible**, which is final: the maintainer may then be refunded at once.
   - The grace period only gives time to start a check. It never makes a late merge eligible.
4. **Refund.** Anyone may settle a bounty to the maintainer when one of these holds:
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

## Transfers

- **No payout and refund on the same bounty.** A bounty reaches `Paid` or `Refunded` once, from a state that allows only one of them.
- **Each transfer has a fixed recipient and amount**, recorded when the bounty is paid or refunded. Nothing can change them.
- **Each send is a numbered attempt.** The contract marks the transfer `Sending`, raises its attempt number, and sends it with two callbacks on the same transfer receipt:
  - `on_transfer` (10 Tgas) does the bookkeeping: a success marks the transfer `Done`; a failure makes it `Due` again;
  - `on_transfer_outcome` (5 Tgas) only writes the runtime's result for that attempt (`Succeeded` or `Failed`) into a fixed-size field.
  - A result for any attempt other than the current one changes nothing.
- **Reserved until confirmed.** A payout or refund stays counted in the contract's total `held` until the runtime confirms that its transfer succeeded. A failed attempt stays reserved for its resend and is never counted twice. So the total cap holds while transfers are in flight, and nobody can post into headroom that only seems free.
- **Recovery uses only the runtime's result for that exact attempt.** If the bookkeeping callback did not run, anyone may call `recover_transfer`. It acts only on a transfer still `Sending` whose result for the current attempt was recorded: a success releases the reservation once; a failure makes the transfer `Due`. It never sends anything, and a second call finds nothing to do. Elapsed time, the contract's balance and the owner play no part.
- **A failed transfer can be resent by anyone, to the same beneficiary, for the same amount** (`send_due`), for example to a wallet that was deleted and is created again. The resend is a new attempt.
- **Remaining risk:** if both callbacks of one attempt fail, its result is never recorded. The transfer stays `Sending` and is never sent again, so nothing is paid twice. But its amount stays reserved in `held`, and if that transfer had also failed, the money stays in the contract with no way to pay it out without a contract upgrade. Both callbacks have fixed gas reserved when they are created, burn under 1.8 Tgas each in the sandbox, and do no arithmetic that can fail; the sandbox tests run builds where the first, and then both, are forced to fail.
- `get_free_balance` reports the contract's balance beyond its storage and everything still reserved. While a transfer is in flight its amount has left the balance but is still reserved, so the figure reads low until the result is recorded.

## Pilot limits

The owner sets these at deployment and may lower or raise them within the contract's hard maximums:

- the maximum reward per bounty, at most 5 NEAR;
- the maximum total held, at most 10 NEAR, counting every payout and refund until its transfer is confirmed;
- the maximum open bounties per maintainer;
- the posting allowlist.

The owner's pause stops new bounties only. Claiming, nominating, checking, settling, recording transfer results and resending always work. The pilot repository cannot be changed; another repository needs another deployment.

## Evidence

- Every run's OutLayer request id is copied from the worker into the verifier's answer, and recorded with the claim, the binding and the merge.
- It can be matched against OutLayer's `execution_requested` event in the same transaction.
- `GET https://testnet-api.outlayer.ai/attestations/by-request/<id>` and `outlayer-verify tx <hash> --network testnet` check the run's code hash, input hash and output hash, and its Intel TDX quote.
