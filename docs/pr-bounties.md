# PR merge bounties: rules

A maintainer funds a bounty on a GitHub issue. A contributor claims it with one NEAR wallet, opens a pull request and submits it. When the pull request is merged into the agreed branch before the deadline, the bounty pays the contributor's vault. If it is not merged in time, the maintainer is refunded.

**What decides payment:** Proven's verifier, fixed by hash, runs inside an OutLayer TEE and reads GitHub's public API. The contract accepts only the answer of its own OutLayer request, bound to that bounty, run and pull request. The maintainer decides by merging. Proven checks the merge, not the quality of the work or whether the pull request solves the issue. No model and no person decides a payment.

**Status:** on testnet, November 11, 2026, both paths ran end to end with the pilot build, which took posts only from allowlisted maintainers for one repository: a paid merge, and a refund after a check found the pull request not merged (see "Evidence"). The current build opens posting to anyone, on any public repository, and adds a claim fee and a minimum reward (see "Limits"). It passes the unit and sandbox tests and has not been run on a live network.

## The parties

| Party | What they do |
|---|---|
| Maintainer | Posts and funds the bounty; merges, or does not merge, on GitHub. Refunds go to the maintainer's vault |
| Contributor | Links GitHub once, claims, opens and submits the pull request. The payout goes to the contributor's vault |
| Anyone | May start a self-paid merge check, refund a bounty that can no longer pay, and run the recovery calls. Money only ever goes to the recorded vault |
| Contract owner | Can close posting to an allowlist, and manages the caps, the minimum reward, the sponsor limits and the pause on new bounties. Cannot move funds, change a bounty or record a result |
| Sponsor account | Funds the float that pays for free merge checks, and receives their unused compute |

Each person uses **one wallet** and signs **one transaction per step**. A step that binds money to a key also asks the wallet to sign a message (see "Vaults and keys").

## Steps

1. **Link GitHub (once per wallet).** The page runs GitHub's device flow with a gists-only app, creates one secret gist holding a challenge that names the network, contract, wallet, link number and expiry, and sends `link` with **0.017 NEAR**: 0.01 for the check run (unused part returned) and 0.007 for storing the link (returned if nothing is stored). The verifier reads the gist; the contract records the GitHub user id. The page builds the challenge itself and refuses to create a gist unless the contract's `link_challenge` returns exactly the same text. The GitHub permission is never stored. Keep the gist: the submission check reads it again.
2. **Post.** The maintainer pastes an issue link, sets a reward and the deadlines, signs the key message and sends `post_bounty` with exactly **reward + 0.03 NEAR** (the record deposit).
3. **Claim.** A linked contributor signs the key message and sends `claim` with exactly **0.0001 NEAR**, the claim fee, which the contract keeps. A claim lasts the posted time (at least 1 hour), capped by the merge deadline. One claim per wallet per bounty: a released, revoked or expired claim cannot be made again by that wallet.
4. **Submit.** The contributor opens a pull request into the agreed branch, then sends `submit_pr` with **0.01 NEAR**. One run reads the pull request and the link gist. The contract binds the pull request only if it is open and unmerged, targets the agreed branch of the bounty's repository, was authored by the GitHub id pinned at claim, and has never been bound before. It records the pull request id and number, the author id, the wallet and the payout key.
5. **Merge.** The maintainer merges on GitHub, or does not.
6. **Check the merge.** Anyone may send `check_merge` with **0.01 NEAR**. The bound contributor may instead use up to **3 free checks** paid by the sponsor float. Checks run only when someone asks.
7. **Settle.** A check that finds the pull request merged before the deadline pays the reward into the contributor's vault. Otherwise anyone sends `settle` once a refund is due, and the reward goes to the maintainer's vault.
8. **Withdraw.** Each person withdraws from their own vault with their wallet (see "Vaults and keys").

## Deadlines and outcomes

The maintainer sets, at posting: claims until, how long a claim lasts, the merge deadline, and a checking grace of 10 minutes to 24 hours.

- **Paid:** GitHub's `merged_at` is strictly before the merge deadline, the merge is into the agreed branch, and it is not more than 60 seconds before binding. A merge before the deadline is paid by the first check that reads it, even after the grace, until the hard cutoff (merge deadline + grace + 14 days).
- **Ineligible:** a merge at or after the deadline, or into another branch. Final; the maintainer can be refunded at once.
- **Refund of a submitted bounty** opens either:
  - after the grace, if a check requested **at least 60 seconds after the merge deadline** found the pull request not merged. An answer from the first minute does not count, because GitHub's clock and NEAR's may differ and GitHub may report a merge late; or
  - at the hard cutoff, if no check has read GitHub by then.
- **The risk this leaves:** if nobody checks before the hard cutoff, a pull request merged on time is refunded to the maintainer, not paid, and the refund is final. Both parties see this before they post or claim.
- **What never counts against the contributor:** a timeout, a run with no result, an inconsistent or oversized answer. A failed check changes nothing and can be repeated.
- **Other refunds:** an unclaimed bounty after its claim window, and a bounty whose claim ended without a submission.
- **Cancel:** the maintainer may cancel only while nobody holds a claim.

## Races at the boundaries

- **One check at a time per bounty.** A check is live for 15 minutes. While it is live, no refund is accepted and no second check starts.
- **A check requested before the hard cutoff counts if its answer lands within its 15 minutes**, even after the cutoff. An answer that arrives after a refund is ignored.
- **Every answer must match its run:** the contract, network, bounty, operation, pull request and run number. Anything else is ignored.
- **A changed GitHub link** (another GitHub id for a wallet, or a second wallet for a GitHub id) waits 72 hours and only affects later claims and submissions. It never changes a claim or a submitted pull request. The current holder of the GitHub id can confirm or cancel the change earlier.

## What it costs

| Action | Who | Attaches |
|---|---|---|
| Link GitHub | Contributor, once | 0.017 NEAR (0.01 run, unused part returned; 0.007 storage) |
| Post | Maintainer | reward + 0.03 NEAR record deposit |
| Claim | Contributor | 0.0001 NEAR claim fee, kept by the contract |
| Submit | Contributor | 0.01 NEAR run, unused part returned |
| Check the merge | Anyone; or the contributor, free, up to 3 times | 0.01 NEAR run, unused part returned; nothing when free |
| Settle, cancel, release, revoke, expire | As above | nothing |
| Withdraw from a vault | The vault's key holder | nothing; gas only |
| Reconcile a settlement in flight | A party after 15 minutes, anyone after 24 hours | 0.01 NEAR; what the vault does not keep comes back |

OutLayer keeps its charge for each run, about 0.0011 NEAR on testnet, and returns the rest to whoever paid. A free check's charge comes out of the sponsor float, and its unused part goes to the sponsor account.

**The record deposit (0.03 NEAR)** pays for the bounty record, its settlement, the vault storage and the settlement fee. It is kept. Each claim that ends without a submission leaves a permanent 73-byte record (0.00073 NEAR), paid from the contract's spare balance.

## Vaults and keys

- **Money goes to a vault, never to an account name.** A vault is a NEP-616 deterministic account whose address comes from the vault code's hash and **one public key**: the key the person's wallet signs messages with. It can receive a deposit before it exists. A deleted or re-registered account name receives nothing.
- **Key proofs.** When posting and when claiming, the wallet signs a NEP-413 message naming the network, contract, account and the exact terms (or the bounty and GitHub id). The key that signed becomes the vault's key, and the page shows it. It may differ from the key that signs the wallet's transactions; the page says so when it can tell.
- **Only that key can withdraw. If it is lost, the money is lost.** Nobody, including the owner, can recover it.
- **Withdrawing.** The key signs `proven-vault-withdraw` with the destination, amount, the vault's current withdrawal number and a deadline at most 15 minutes ahead. Anyone may submit it; the vault checks the signature and number, then sends the amount. A failed transfer returns the amount to the vault, and the next withdrawal uses the next number. The page prefills the whole amount and the connected wallet as the destination.
- **Credit and withdrawal are separate.** The page shows the vault credit (the contract's part is finished when the vault's own record shows the deposit) apart from the wallet withdrawal (a finalized `withdraw` whose transfer succeeded). Nothing is forwarded or swept automatically.
- **Storage.** A vault keeps a small storage fund out of the first deposit (0.00421 NEAR measured on testnet). The rest is withdrawable.

## Settlements

- **One outcome per bounty.** A bounty reaches Paid or Refunded once.
- **Fixed recipient.** Each settlement records its kind (payout or refund), vault, key and principal when the outcome is decided. Nothing can change them.
- **Numbered attempts.** The contract sends the principal plus a 0.006 NEAR fee to the vault, tagged with the bounty, kind and attempt, and books the result in its callback. The vault keeps one record per contract, bounty and kind, and refuses a second deposit or a deposit for a sealed attempt.
- **Reserved until confirmed.** A principal stays counted in `held` until the vault confirms it.
- **Recovery, open to anyone:** `send_due` resends a due settlement to the same vault for the same principal; `recover_settlement` finishes an attempt from its recorded result; `reconcile` asks the vault to seal an attempt whose callbacks never ran (a party after 15 minutes, anyone after 24 hours); `cancel_stale_outlayer_execution` forwards OutLayer's cancellation of a stuck run. None of them can send money anywhere but the recorded vault.

## Identity: what is and is not proved

- **The wallet:** a signed NEAR transaction shows its holder acted.
- **The GitHub account:** a secret gist owned by the GitHub user id, holding a challenge for this network, contract, wallet, link number and expiry, shows that account's holder chose this wallet. A copied challenge in someone else's gist has the wrong owner. Logins are never compared, only numeric ids.
- **Why a gist:** only its owner can create or edit it. A repository writer can edit comments on an issue, so comments prove nothing.
- **No credential:** the verifier reads GitHub's public API with no token, so nothing can leak. The page's GitHub permission is used once, to create the gist, and is not stored.
- **Not proved:** that the contributor did the work, that the pull request solves the issue, or that it is good. The maintainer decides by merging.

## Limits

Set by the owner, within the contract's hard maximums:

- the minimum reward per bounty (above zero), the maximum reward per bounty (at most 5 NEAR) and the maximum held in total (at most 10 NEAR);
- the maximum open bounties per poster (at most 5);
- whether posting is open to anyone, or closed to the poster allowlist;
- the sponsor float cap (at most 1 NEAR) and the cap on total sponsored spending (at most 2 NEAR).

Posting is open to anyone at deployment, for any public repository named in each bounty by its `owner/name` and numeric GitHub id. The verifier checks every pull request against the bounty's own repository id, so a bounty that names the wrong repository can never pay; it refunds its poster. A poster need not maintain the repository: the bounty pays only if that repository's maintainers merge. The owner's pause stops new bounties only; claiming, submitting, checking, settling, recovery and withdrawing always work. Ownership moves only when the proposed account accepts it.

## Known limits of open posting

Found in review and not fixed in the contract. The owner can close posting to the allowlist at any time; claims, checks, settlements and withdrawals keep working.

- **The total cap can be filled.** The contract holds at most the set total (5 NEAR at launch). Someone willing to lock their own money can post bounties up to that total and cancel them later, and new posts are refused meanwhile. Each post costs them the 0.03 NEAR record deposit.
- **One wallet can claim many bounties.** Nothing limits how many bounties a wallet claims at once. A maintainer can revoke a claim on their bounty; that wallet can then never claim it again.
- **Free checks can be spent by anyone who posts.** A poster can claim their own bounty with a second linked wallet and use its 3 free checks. The sponsor float cap and the total sponsored spending cap bound this.
- **A poster need not maintain the repository.** The page and the contract say "maintainer" for whoever posts. The bounty still pays only for a pull request merged into the named repository, by its id.
- **The claim fee does not cover a claim's leftover record.** A claim that ends without a submission leaves a 73-byte record (0.00073 NEAR), more than the 0.0001 NEAR fee. The difference comes from the contract's spare balance.

## Evidence

- Every run's OutLayer request id is recorded with the link, the submission and the merge check, and shown on the bounty's page.
- `GET https://testnet-api.outlayer.ai/attestations/by-request/<id>` (on mainnet, `https://api.outlayer.ai/...`) and `outlayer-verify tx <hash>` check the run's code hash, input, output and Intel TDX quote.
- **Testnet run, November 11, 2026** (contract `pr-bounty-2.proven-funding.testnet`, deleted after the run; verifier `7848be7d…`):
  - Bounty 0: pull request #3 submitted (run 21183), merged, then a free check (run 21198) paid 0.05 NEAR into the contributor's vault, withdrawn through the page with a browser wallet.
  - Bounty 1: pull request #4 submitted (run 22381), never merged; a check 80 seconds after the deadline (run 22923) found it not merged; `settle` refunded 0.05 NEAR into the maintainer's vault, withdrawn the same way.
