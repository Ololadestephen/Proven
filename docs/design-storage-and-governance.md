# Storage return, on-chain access, ownership, agent records and events: design

Status: agreed with the owner on November 7, 2026, as one upgrade of both contracts. Built on testnet first, reviewed, then mainnet is upgraded while the escrow holds no money.

## 1. Storage goes back when a job and its bid end

Today a bid and its job lock about 0.05 NEAR of storage for good. After this change, most of it returns to the buyer.

**Escrow.** A job is charged storage at its largest when it is created (three full attempt records). When the job has ended (Released with its budget returned, or Refunded), anyone may call `finish_storage(job_id)`. It measures what the finished record really uses and sends the difference between what the buyer paid and that to the buyer, once. The record itself stays, as evidence.

**Board.** When a bid has ended (Done, Closed or Cancelled) and none of its fees is Held or Paying, anyone may call `finish_bid(bid_id)`. It keeps the bid's hashes, outcome, review, attempts and a short title (the description's first line, at most 120 bytes), and removes the full description and format text. Both stay readable forever in the posting transaction's arguments. It then sends the buyer what the buyer paid for storage and the posting reserve, minus what the shortened record and the check's reuse entry still use, once.

**Never more than paid, never twice.** Each bid records what its buyer paid for storage; each job records its storage deposit. A refund is that amount minus the measured remainder, and the record is marked finished before the transfer. A failed transfer marks it unfinished again so it can be retried.

The relay calls both automatically once a job has ended.

## 2. The market can be closed on the chain

The board gets an access setting kept by its owner: open to everyone, or open only to listed buyers. `post_bid` refuses an unlisted buyer, so nobody can lock money in a bid that cannot run. Methods: `set_market_open(bool)`, `add_buyers`, `remove_buyers`, view `get_access`. The migration starts it closed with the buyers the relay already allows.

## 3. Ownership can be handed over

The board gets an owner (it has none today). The owner can change the reviewer, and the access setting. Both contracts get a two-step handover: `propose_owner(new)`, then `accept_owner()` from the new account. This lets the deploy key move to a multisig or a time-delayed account later without another upgrade. The owner still cannot set a verdict or move job money.

## 4. Each agent has a record on the chain

The board keeps per worker: attempts paid, failed, failed on format, not delivered, no verdict. It is updated once per attempt, when that attempt's fee is settled from the escrow's history, so it cannot be counted twice. View `get_agent_record(wallet)`. Each attempt's 0.002 NEAR record deposit, which is not returned, pays for this record.

## 5. Standard events

The board logs NEP-297 events (`EVENT_JSON`, standard `proven-board`, version 1.0.0): `bid_posted`, `bid_job_created`, `bid_refused`, `bid_reviewed`, `agent_registered`, `bid_claimed`, `bid_assigned`, `assign_refused`, `attempt_settled` (with worker, outcome, failed rule and verdict request id), `fee_paying`, `fee_settled`, `bid_ended`, `bid_closing`, `bid_finished`, and the owner's `reviewer_set`, `market_access`, `owner_proposed` and `owner_accepted`. Agents and indexers can watch the chain instead of polling.

## 6. Gas for settling three fees at once

A sandbox test settles three attempt fees and ends a bid in one sync. The largest board receipt in it burned 4.4 Tgas, against the 80 Tgas the callback reserves, so the reservation stays as it is. Unused gas is refunded to whoever called `sync`.

## 7. Larger jobs: at least 5 NEAR per job

The owner raised the per-job limit from 0.1 NEAR to 5 NEAR on November 7. The escrow already lets its owner change its caps (`set_caps`), so this needs no new contract code: the upgrade step calls `set_caps` after migrating. The other limits rise with it: 10 NEAR held in total and 5 NEAR per buyer, so two full jobs can run at once, one per buyer. The page and the agent tools stop writing the limits by hand and read them from the escrow's `get_config`, so a later change of caps shows everywhere at once.

The contract is still unaudited, so every place that names mainnet keeps saying so, now with the larger limits.

## What stays the same

Only a verdict recorded in the escrow's own callback moves job money. Pause, the attempt fee rule and the check reveal are unchanged. Nothing here lets the owner, relay or board pay anyone except a buyer's own storage refund, computed by the contract.

## Migration

Escrow: the contract state gains the pending owner; jobs keep their layout and are not rewritten, so jobs under way carry on. A job's existing `storage_deposit` records what it paid, so earlier finished jobs can also give back what they no longer use. Board: `migrate(owner, buyers)` rewrites bids to add the storage paid (zero for earlier bids, which then have nothing to return), the count of attempts already recorded (zero, so the next sync of an earlier bid counts its attempts) and the finished flag; the state gains an owner, a pending owner, the access setting (closed, with the listed buyers) and the agent records. Both refuse to migrate twice, and only the contract's own account can run the migration.

## Measured in the sandbox

- A three-attempt bid closed after one failed attempt: the board returned 0.00915 of the 0.01598 NEAR paid for its storage, and the escrow returned 0.01012 NEAR.
- A three-attempt job closed before any worker: the escrow returned 0.00717 of 0.0135 NEAR.
- A copy of the live mainnet escrow and board, with their real state, upgraded with every job and bid reading as before.
