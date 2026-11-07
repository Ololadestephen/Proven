# One-signature jobs: design

Status: agreed with the owner on November 7, 2026. Built on testnet first, reviewed, then the mainnet escrow and board are upgraded while the escrow holds no money.

## Goal

A buyer signs once, when posting. Everything after that happens without the buyer: the bid review, the fake challenge, funding when a worker applies, verification and the payout. A worker signs to apply and to deliver. Payment still moves only on a verdict recorded in the escrow's own callback of its own OutLayer run. No model, relay, owner or buyer can release money any other way.

## What stays the same

- The check, reference, format and verifier are fixed by hash before any money is locked.
- A check must reject every planted fake before anyone can be paid by it.
- A verdict is recorded once, only in `on_run_result`, only if it names this escrow, job, check, format and delivery.
- Caps: per job, per buyer and in total, enforced by the escrow. The pause stops new jobs only.
- The attempt fee rule: the worker keeps the fee only if well-formed work failed a real rule.

## What changes

### Posting: one transaction

The buyer calls `post_bid` on the board with one deposit:

| Part | Amount | Comes back |
|---|---|---|
| Payment | the job amount, at most the per-job cap | to the worker on a pass, otherwise to the buyer |
| Attempt fees | 0.017 NEAR per attempt (0.015 fee and 0.002 record), up to 3 | unused ones when the bid ends |
| Compute budget | runs × the escrow's run deposit (about 0.01 NEAR now) | each run's unused part straight away; the rest when the bid ends |
| Storage | bid, job and record storage | when records are removed |

The board keeps the attempt fees and forwards the payment, compute budget and job storage to the escrow in one call, `create_open_job`, naming the buyer. The escrow accepts that call only from its configured board. If the escrow refuses, the board's callback returns everything to the buyer.

The payment counts against the caps from the moment of posting, because it is held from then on.

### The check: no signature to hand it over

The relay accepts the check and reference for a job if their SHA-256 hashes equal the job's hashes on chain. The hashes already authenticate the texts, so no wallet signature is needed. The buyer's browser sends them straight after posting. The relay then pins them and triggers the challenge.

### Escrow job lifecycle

A job now has no worker until one is assigned, and can serve up to `max_attempts` workers in turn.

- `Draft` -> run challenge -> `Challenging` -> `Open` (check accepted, waiting for a worker) or `CheckRejected`
- `Open` -> `assign(worker)` from the board -> `Funded`, with `deadline = now + deliver_secs`
- `Funded` -> `deliver` -> `Delivered` -> run verification -> `Verifying` -> `Passed` or `Failed`
- `Passed` -> `release` -> `Released` (final)
- `Failed`, or `Funded` past its deadline, or `Delivered` past its verdict window: the attempt is recorded in the job's history. If attempts are left and the bid has not ended, the job goes back to `Open` with the worker and delivery cleared. Otherwise it is refunded: `Refunding` -> `Refunded` (final).
- `Open` or `CheckRejected` -> `close` by the buyer at any time, or by anyone after the bid's end time -> refunded.

Every attempt keeps a record (worker, outcome, failed rule, verdict request id). The board reads it to settle that attempt's fee.

### Who pays for runs

The escrow attaches the run deposit from the job's compute budget and names the buyer as OutLayer's payer, so OutLayer returns the unused part straight to the buyer. Anyone can trigger a run in the states that allow one, at no cost beyond gas: the relay triggers them automatically, and a worker can trigger verification itself. A run in flight blocks another until it finishes or goes stale, so a caller cannot drain the budget. If the budget runs out, the job can still be closed and refunded, and the buyer can top it up.

### Claiming: no buyer step

`claim` on the board checks the bid and the worker as today, then calls `assign` on the escrow. The worker can start as soon as the claim confirms: the money is already held. Link, create and fund steps for the buyer are gone.

### Release condition

Each job carries `release: Verdict`. It is the only value now. A separately labelled buyer-approval job type may be added later, with preview-only work before payment and automatic release if the buyer stays silent; it would need the owner's explicit decision and its own review. No model ever decides payment.

### Signatures after this

- Buyer: one transaction to post, plus one message signature to collect the work after it is paid.
- Worker: register once, apply, deliver (a transaction and a message).
- Everything else is triggered by the relay or by anyone.

## Costs and limits to disclose

- The buyer's payment is held from posting until the bid ends or a worker is paid. It counts against the per-buyer cap.
- Each run uses a little of the compute budget even when it fails.
- The operator pays gas for the runs it triggers automatically.
- The relay can still read the check, reference and delivery, and could withhold them. Then no verdict is reached and the job eventually refunds the buyer.

## Migration

Both mainnet contracts keep their accounts. The escrow's `migrate` refuses if any money is held. Old jobs keep their records and states. New jobs use the new layout. The board's existing bid stays readable.

## Not in this change

- Milestones as one bid. A large job is posted as several bids for now.
- Job types that need a heavier runner (code repositories, websites).
- Buyer approval.
