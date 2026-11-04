# Proven agent tools

Use Proven for work checked by executable rules. This interface supports testnet native NEAR jobs, with amounts greater than zero and at most 0.1 NEAR. It does not judge subjective work. Demo agents are scripted, with fictional invoice data; they make no model calls.

From `agent/`, run `npm ci`, then `npm run proven -- <tool_name> '<JSON>'`. Supply private JSON through standard input or `@file` instead of shell arguments. Add `--dry-run` to construct calls without signing or handing off private data. Use `--actor buyer`, `--actor honest` or `--actor fake` for the configured role. For MCP, run `npm run mcp`; its actor is fixed by `PROVEN_ACTOR` in the owner's configuration. Tool arguments cannot select another actor or provide credentials.

The owner must run `node scripts/setup-testnet.ts --approved-testnet-setup` only after approving its external registration and testnet funding. This owner-only script uses existing owner credentials, creates restricted worker keys, and stores credentials in ignored `.env`. Agent tools never accept the owner's full-access buyer key. The buyer uses a custody API credential, and workers use function-call keys checked against chain permissions before signing. Keep the owner's full-access key for recovery; function-call keys cannot add keys, transfer NEAR or attach deposits, and their gas allowance can run out.

Before live operations, the operator starts `cd relay && npm run handoff` in another terminal. It reads the operator's relay credential separately from the agent signer. The channel is a local Unix socket at `runs/private/relay.sock`, with an owner-only directory and socket permissions. It provides no public TCP endpoint. If a crashed process leaves a socket behind, confirm the old server is stopped before removing that socket and restarting. Do not delete a live server's socket.

| Tool | Required arguments | Behavior |
|---|---|---|
| `post_job` | `worker`, `check`, `reference`, `amount_near` | Fixes check/reference hashes and expected verifier build. Optional `deadline_seconds` (600 to 2592000, default 3600) and `verdict_window_secs` (1800 to 604800). Creation attaches 0.05 NEAR for storage; escrow returns excess. |
| `challenge_check` | `job_id`, `check`, `reference` | Hands off private texts, pins the challenge, and triggers escrow. `pin_only:true` stops before triggering. |
| `fund_job` | `job_id` | Buyer custody attaches exactly the recorded native amount. Funding requires ten minutes remaining before delivery deadline. |
| `list_jobs` | none | Public page; optional `from_id` and `limit` (1 to 50). |
| `deliver` | `job_id`, `deliverable` | Named scoped worker fixes the hash and hands the text privately to relay. Repeat identical bytes if handoff failed after delivery. Changed bytes are refused. |
| `request_verification` | `job_id` | Pins saved check/delivery and triggers escrow through buyer custody. `pin_only:true` does no trigger. |
| `release_or_refund` | `job_id` | Follows the stored verdict or expiry; callers cannot choose a payee. |
| `job_status` | `job_id` | State, attempt, hashes and both attestation links. Links are not Intel signature verification. |
| `recover_outlayer_deposit` | `request_id` as a decimal string | Forwards stale cancellation; OutLayer checks ownership and sends change to the original payer. |

Every tool accepts `dry_run:true`. Check, reference and deliverable arguments are exact file contents as strings; whitespace affects their hashes. A function delivery is the verifier's JSON function format, not an arbitrary executable. CLI/MCP input is bounded at 512 KiB, and individual private texts at 256 KiB. Large private payloads have not been validated on OutLayer.

Compute requests attach 0.1 NEAR and 150 Tgas; unused compute deposits return to the triggerer. Payouts and stale recovery reserve 70 Tgas. Workers cannot attach compute deposits with their function-call keys, so the demo buyer triggers verification. The underlying contract remains permissionless. The relay temporarily supplies its own separate secret-storage deposit, deleting the secret after a recorded result. It keeps the private check locally for verification.

The custody policy allows only native calls to escrow, with a 0.1 NEAR per-call deposit cap and a 1 NEAR daily counter. Refunded deposits still count toward that counter. Cumulative counters are best effort under concurrency; the per-call limit and destination restriction are the hard signing boundary. The policy has no method-name allowlist and does not understand job worker selection or business intent. Escrow enforces method authorization and job state. FT funding is unavailable through this policy because it would require calling the token contract outside its allowlist.

The relay can read private texts and can withhold them, leaving an honest worker unpaid until the job expires and refunds its buyer. It cannot set a verdict. Private texts are stored locally with owner-only permissions and encrypted for OutLayer before being pinned. OutLayer's contract/operator, registered keys, approved measurements and keystore remain trusted; the escrow does not verify a per-call quote on chain. The escrow deployment key can still replace contract code.

Saved local check and delivery files remain under the operator's control; removing an OutLayer secret does not guarantee local file removal. Remove local copies only after their job is terminal and the operator no longer needs them. If an asynchronous custody reply stops the script, inspect status and use the existing evidence file with `--resume`; unknown job creation is deliberately refused until its outcome is reconciled.

Read the returned transaction hash and job state. A pending or failed transaction is not proof of success. An unknown custody submission must be checked in wallet history before retrying; tools never automatically repeat a write. For a no-verdict run, retain the pinned texts and retry within the allowed window, or expire the job. Do not pay based on worker claims, logs or model messages.

To run the terminal milestone check after setup and starting the relay, use `cd agent && npm run demo`. It creates two native jobs, pays the honest worker and refunds the fake, and writes public metadata evidence under ignored `runs/`. `npm run demo -- --dry-run` constructs creation plans only and does not start a service or submit transactions.
