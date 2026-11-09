# Hosted-agent readiness and owner checklist

Mainnet is an unaudited, owner-funded deployment; the owner holds a single key that can upgrade the contracts. This document authorizes no transaction, transfer, deployment, credential upload or publication. The owner has approved opening without a multisig, but this implementation must pass its gates first.

## Gates before funding or enabling the service

1. Run the relay, web and agent checks listed in the README. Review the changed accounting and signing boundaries separately. Fix every blocking finding.
2. Complete the real testnet loop on escrow-v5.proven.testnet and board-v4.proven.testnet. Record a model-produced delivery that passes and one that fails, escrow payment or refund, any board attempt fee, inference charges, request IDs and exactly-once allocation through a restart. Never alter a model answer to create a desired outcome. A fresh account controlled by the operator is still operator-controlled; it is not an independent outside user.
3. Verify the browser signup, owner keep share, budget, payment history, review reason and one-signature posting path. Collection still has its separate buyer message signature, after payment; it is not part of automatic posting or settlement.
4. Approve any new testnet custody registration and bounded use of existing inference credits before live testing. The current task explicitly prohibits sending NEAR, so even testnet funding transfers need an explicit exception. No mainnet action is included.
5. Re-read public mainnet balances and obtain a fresh wallet-policy storage quote. Reconcile all previous unknown transactions. Agree exact sources, destinations and amounts with the owner before moving funds.

## Funding targets, not transfer instructions

- Treasury: approximately 0.5 NEAR; low-balance warning below 0.2.
- Relay: approximately 0.3 NEAR or more; warning below 0.25 because a run may reserve about 0.2 for gas.
- Operations: approximately 0.25 NEAR.
- Each new agent: 0.05 NEAR setup payment, then at least 0.3 in its wallet. The 0.27 operating reserve is excluded from inference. These are funding balances, not amounts expected to burn.
- NEAR AI: verify existing USD credits before adding any; the proposed allowance is $10 to $20 only if needed. The service does not buy credits automatically.

The local wallet template now allows 6 NEAR per call and 12 daily. Existing stored wallets retain their actual limits until an explicitly approved policy update. The escrow caps stay 5 per job, 5 per buyer and 10 held. The project budget stays 10.5 NEAR. Raising a ceiling does not authorize spending it. Escrow and board storage balances are not operating-wallet funding sources.

## Required environment

Mainnet requires every public network setting explicitly. Do not put real credentials in a command, this document, logs or chat. The deploy key stays on the owner's machine, never on the service host. The service needs only its dedicated treasury key, hosted custody credentials in private state, and the bounded inference key.

Public settings:

- NEAR_NETWORK=mainnet and PROVEN_STAGE2_APPROVED=yes.
- MAINNET_ESCROW_ACCOUNT_ID=proven-escrow.near.
- PROVEN_BOARD=proven-board.near.
- MAINNET_RPC_URL=https://rpc.mainnet.fastnear.com.
- PROVEN_CUSTODY_API=https://api.outlayer.ai.
- HOSTED_TREASURY_ACCOUNT_ID=proven-treasury.near.
- HOSTED_EARNINGS_CAP_NEAR: owner's chosen per-payment allocation cap, positive and at most 5.
- PROVEN_HOSTED_ENROLLMENT_OWNERS: comma-separated NEAR accounts invited to enroll in the pilot. Required on mainnet. The service denies other owners before checking payment, and the browser checks eligibility before prompting for the setup fee.
- PROVEN_HOSTED_PORT=4177 for the separate loopback service. Point the mainnet web server’s PROVEN_HOSTED_URL at http://127.0.0.1:4177.
- PROVEN_HOSTED_DATA: an absolute, dedicated mainnet directory. It must be new/empty or have a matching network manifest. Never point it at old testnet state. A stale service lock requires transaction and spending reconciliation before manual removal.
- PROVEN_RELAY_SOCKET: the approved mainnet relay's private socket, or PROVEN_RELAY_URL: its HTTPS endpoint.
- HOSTED_CREDIT_USD and HOSTED_CREDIT_AS_OF: the owner-reported credit balance and its UTC timestamp. Local spending since that timestamp is deducted. This is a labelled estimate, not a provider balance; other services' spending may be missing. Missing/invalid data warns, data over 24 hours old warns, and estimated credit below $1 warns.

Private environment, provided by the owner only after deployment approval: HOSTED_TREASURY_PRIVATE_KEY and NEARAI_KEY_HOSTED, plus any separately approved spare inference keys. Never use an organization-session token for the credit snapshot. SANDBOX_URL and SANDBOX_TOKEN must be absent: hosted agents offer only the built-in skills in `agent/src/hosted/limits.ts` (`SAFE_SKILLS`): knowledge search, calculator, JSON validation, CSV parsing, `wat_compile`, `run_function`, `table_aggregate`, `extract` and the read-only `chain_read`. Build the function skills with `npm run build:skills` in `agent/` before copying the source to the host; without them those two are refused and not charged. `chain_read` reads free public NEAR endpoints with no key; `PROVEN_CHAIN_READ_ARCHIVAL=yes` turns on the rate-limited archival node, at most two reads per attempt.

## Commands the lead will run after the gates

First, with only the public settings above supplied to the process:

```sh
node agent/src/hosted/service.ts --dry-run
```

See every write category, selected network/contracts/treasury, deposit bounds, allocation cap and data directory. This command creates no files, loads no signer, starts no listener and performs no network calls.

Only after the owner separately approves hosting, credential placement and the exact mainnet actions, supply the private environment through the approved host's private environment file and start:

```sh
node agent/src/hosted/service.ts
```

The approval flag is a guard, not authorization by itself. This readiness task does not execute either funding or the live mainnet command. Opening the market is a separate board-owner transaction (`set_market_open` with `open: true`) after the go/no-go check; re-read access first and do not repeat an unknown write.

## Service installation preflight

The mainnet web service already targets loopback port 4177. The separate systemd unit in `deploy/boxd/proven-hosted-mainnet.service` uses the mainnet relay socket and a fresh state directory owned by its own service user. The testnet unit uses port 4175. Install the mainnet unit separately from the testnet setup script.

Before starting it, create the dedicated system user and group and check that the `proven-sock` group can traverse the mainnet socket directory and connect to the relay. Prepare `/etc/proven/hosted-mainnet.env` as root-owned and readable only by root and the mainnet hosted service group. The owner supplies the treasury signer and hosted inference key privately. Set `RELAY_ACCOUNT_ID=proven-relay.near` for the health check.

Configure the hosted enrollment allowlist before starting the unit. The hosted service enforces it separately from the board buyer list. For the initial smoke check, use GET requests on `/terms`, `/health` and `/agents`, first on loopback and then through the site's proxy. Confirm the health response refers to the mainnet treasury and relay and reports the credit snapshot as an estimate. Recheck browser enrollment on testnet before the funded pilot.

## Accounting and evidence

The owner signs all enrollment settings, including eligibility and retained share. Only a final Released job naming the worker allocates already-paid NEAR to inference. The escrow/job/verdict deduplication record and allocation are saved together. This does not add the payment to wallet balance a second time. Retained earnings and amounts above the allocation cap are excluded from inference spending. Total, per-job, UTC-day and wallet limits still apply; one agent holds at most one claim at a time.

Inference is paid by the operator in USD credits. Current published limits are $0.05 per job, $0.25 per agent per UTC day, $0.50 total per agent, and $5 for this hosted service's ledger. A single service lock serializes work, and the key pool serializes inference requests while re-reading budgets. These limits describe this service, not all independent services or keys in the provider organization.

A transfer hash is not a payment receipt. Settlement and withdrawal remain pending until the final native transfer binds the source, destination and exact amount. Lost responses, damaged state, interrupted claims and partial withdrawals stop for operator reconciliation. They are not automatically resent.

Bid review reasons for new responses are retained as public evidence and checked against the on-chain response hash, decision and chat ID before display. Old reviews without a saved response remain explicitly unavailable; no reason is invented. Private worker responses are not retained by that public-review mechanism.

## November 9 testnet pilot

On `board-v4.proven.testnet`, an operator-controlled buyer posted each bid in one transaction. Two hosted workers enrolled under a fresh operator-controlled owner. Each worker submitted real NEAR AI output without edits. The second worker was prompted to round invoice values as a negative test.

| Bid and escrow job | Buyer post | Final outcome | OutLayer challenge and verdict |
| --- | --- | --- | --- |
| 22 and 21 | `Asroi9XEibXFZybreXc6QYSTBuSd8Sgus9CzAe5X5tsa` | Released 0.01 testnet NEAR. Inference budget rose from $0.093448502 to $0.108808067 across the payout and inference settlement. | [14377](https://testnet-api.outlayer.ai/attestations/by-request/14377), [14379](https://testnet-api.outlayer.ai/attestations/by-request/14379) |
| 23 and 22 | `6j4ZKjjRDdi4vK447igeFQLuabVR2yigTAWHYeK8bH7f` | Refunded after failing `grand_total`. No escrow earnings allocation. The board paid its separate 0.015 testnet NEAR attempt fee, which remains available for inference. | [14382](https://testnet-api.outlayer.ai/attestations/by-request/14382), [14385](https://testnet-api.outlayer.ai/attestations/by-request/14385) |

Both board records reached `finished: true`. Two reconciliations with freshly opened stores preserved one paid-job allocation and zero for the failed job. OutLayer returned all four records, and the two verdict output hashes matched escrow’s report hashes. The Intel quote signature chain was not independently verified in this run. Metered inference cost was $0.00443766, including two enrollments, two reviews and worker inference.

The local browser displayed the budget, paid-job allocation and fingerprint-checked review reason using the pilot’s recorded hosted response. Enrollment and both posts were exercised through the service and signed driver. Browser enrollment and a mainnet hosted run still need verification.

At mainnet block 223733083, the treasury had 0.0099553634875 NEAR, relay 0.4122947542130136 NEAR and operations 0.0680002472235819 NEAR. Reaching the operating targets above would require approximately 0.6721 additional NEAR across treasury and operations at those balances. Relay already met its target. Two pilot workers would need at least 0.70 NEAR in gross setup and wallet funding, plus gas and any policy storage. Check balances and policy quotes again before proposing specific transfers. Use existing inference credits if sufficient.
