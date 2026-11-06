# Proven

Settlement for agent-to-agent work that pays only for proven delivery.

An agent posts a job with an executable acceptance check. Proven first runs planted wrong deliverables against that check and refuses the job if the check accepts any of them. Payment is then locked in a NEAR escrow contract. When the work is delivered, the contract itself asks OutLayer to run the check inside a trusted execution environment, records the result in its own callback, and pays the worker or refunds the buyer. Proven covers work that can be checked by execution only; it does not judge subjective work.

Status: in development for NEAR HACKATHON (October to November 2026). Setup steps, a demo and evidence will be added as each part is built and verified.

## Who decides a verdict, and what you have to trust

The buyer, worker, escrow owner and relay have no method for posting a pass or fail. A result is recorded only by a private callback of the escrow's own call to the OutLayer contract, and only if the output names this escrow, this job, this check and this deliverable. Anyone can trigger a run. If OutLayer fails, times out or returns anything else, there is no verdict: the run can be tried again, and if no verdict arrives in the job's window, the buyer is refunded.

This does not remove trust. You are trusting:

- **OutLayer's operator account.** The OutLayer contract accepts a run's result from one account (`worker.outlayer.testnet` on testnet) and checks only that the caller is that account. It does not check the output or which WASM ran. So any key on that account could report any output for a pending run, and the OutLayer contract's owner can change the account. The escrow asks for the verifier by URL and SHA-256, and an honest worker refuses other bytes, but the escrow cannot see which code actually ran.
- **OutLayer's registered worker keys and approved measurements.** A worker's key is added to that account only after its Intel TDX quote and measurements are checked when it registers. **The quote of an individual run is not verified on chain**, so the escrow's verdict rests on this registration, not on a proof for that run. Whoever controls OutLayer's list of approved builds is part of what you trust. The stored request id is reported by the run and is not checked on chain; it is how you find the attestation, which you then check yourself.
- **OutLayer's keystore**, which holds the key that decrypts private checks, and OutLayer's API, which supplies that key's public half without an attestation.
- **The relay, for availability and privacy, not for verdicts.** It holds a job's private check, reference and deliverable, and pins them as an OutLayer secret. It can read them. If it withholds them, no verdict can be reached and the job refunds the buyer, so an honest worker would go unpaid. If it changes them, the verifier refuses them, because they no longer match the hashes fixed on chain.
- **The host of the verifier file.** It cannot swap the file, because the hash is checked, but if it is unreachable when a worker has no cached copy there is no verdict, and the buyer is refunded if that lasts past the window.
- **The escrow's account key.** The contract is not locked: the holder of its full-access key could redeploy it.

A worker or buyer can also lose money in one case with no verdict involved: if the receiving account of a payout was deleted, or a token account can never accept the transfer, the payout can only be retried. Nobody can redirect it, by design.

Each recorded verdict stores its OutLayer request id and the hash of its output, so anyone can fetch the attestation and compare it. Public execution input contains hashes and the job binding. Outputs also expose counts, failed-rule ids and missed-fake names; stored secrets expose ciphertext lengths. Low-entropy private text may be guessed from its public hash.

Independent command-line verification of **request 8700 (task 19117, job 6)** passed on November 4 with source-built `outlayer-verify` v0.1.0, revision `90c27d9d`, exit code 0. On November 5 the same tool independently verified **requests 9345 (job 13) and 9430 (job 14)**, online and from saved offline bundles. Authenticity (Intel signature chain, TCB UpToDate), measurement approval, execution binding, and input/output bytes recovered from chain all passed. Intel collateral read from the register contract matched the API copy byte for byte. Requests 9452 (job 18) and 9455 (job 17) also passed independent command-line verification on November 5. Requests 9557 (job 27) and 9556 (job 28) also passed online and offline verification on November 5. Requests 9632 (job 31) and 9631 (job 32) also passed online and offline verification. Requests 9699 (job 33) and 9701 (job 34) also passed online and offline verification. Requests 10067 (job 35) and 10068 (job 36) also passed online and offline verification. These results cover those thirteen attestations; the other listed runs have hash-binding checks only. The relay itself does not verify Intel signatures, and the escrow still does not verify a per-call quote on chain.

The tool's default testnet API address was retired in that revision. Use an explicit API address:

```sh
outlayer-verify tx AfaFhms3qDvef2HXttdvwkc328oAuyBu8XEsxETJ2zij --network testnet --api https://testnet-api.outlayer.ai --rpc https://test.rpc.fastnear.com --archival-rpc https://archival-rpc.testnet.near.org
```

## Calls, refunds and limits

Both `request_challenge(job_id)` and `request_verification(job_id)` are permissionless. The triggerer attaches 0.1 to 1 NEAR and at least 150 Tgas. OutLayer's `payer_account_id` returns unused compute deposits to that triggerer. NEAR's protocol-level `refund_to` sends an admission-rejection refund to the same account, even if the refund arrives after the callback. Escrow never reimburses a failed compute request from job payment.

If OutLayer's settlement callback itself fails, anyone can call `cancel_stale_outlayer_execution(request_id)` with at least 70 Tgas after OutLayer's ten-minute timeout. OutLayer enforces request ownership and single settlement, and refunds its stored payer. The request id for an unsuccessful run is in OutLayer's `execution_requested` event; only successful recorded results have an id stored on the job. OutLayer cancellation cannot create a verdict or redirect its refund.

The public input contains only the escrow account, job id, mode and committed hashes. Private check, reference and deliverable text is encrypted locally into WASM-bound OutLayer secrets, restricted by a `Predecessor` whitelist to this escrow. This supports anyone triggering a call without publishing the private text. Both the data and function examples use this path. Larger private payloads have not been tested; the function interpreter separately caps submitted modules at 64 KB. Runs request 50 billion instructions, 128 MB and 60 seconds. Verifier output is limited to 900 bytes and the callback rejects larger output before parsing it.

One run may be in flight per job. A result arriving more than fifteen minutes after its trigger is no verdict, even if no one retried the job yet. A missing or exhausted callback can be retried after that timeout. After the verdict window closes, anyone can expire the job and return the payment to the buyer. A timely trigger has bounded callback grace within those fifteen minutes; a completed expiry always prevents a late verdict.

## Local checks

Use Rust with `wasm32-unknown-unknown` and `wasm32-wasip1`, `cargo-near`, and Node 22.18 or later. From the repository root:

```sh
(cd contracts/test-token && cargo near build non-reproducible-wasm)
(cd contracts/mock-outlayer && cargo near build non-reproducible-wasm)
(cd contracts/escrow && cargo near build non-reproducible-wasm && cargo test --lib && cargo test --test sandbox)
(cd verifier && cargo test --release --features cli)
(cd relay && npm ci && npm test && npm run typecheck)
```

Sandbox tests use a local test double for failure injection, including admission rejection, delayed settlement failure, malformed and oversized output, yield timeout and an actual exhausted callback. They are separate from the real OutLayer testnet evidence. Deposits use NEAR's custom refund receiver support (protocol 82 or newer; checked on testnet protocol 88).

## Testnet evidence (November 4, 2026)

Contract: `escrow-v2.proven.testnet`, [deployment](https://testnet.nearblocks.io/txns/6y7RWZSp5hDH2W3w11RgFfvYBQ7p284Y93nbikZwMZqh). The verifier build is `c3f3b90a9b6c0e4bca023465c69c8dbab476d0fa96fcdc50d808877b4010dafe`.

| Job | Delivery | Recorded verdict attestation | Settlement |
|---|---|---|---|
| 6 | data, honest | [request 8700](https://testnet-api.outlayer.ai/attestations/by-request/8700) | [released 25 pUSD](https://testnet.nearblocks.io/txns/HWkZ6btQZMT2UKEbJiJVAji7Vvf6XDjxCdFa1jcgmVkS) |
| 7 | data, fake | [request 8702](https://testnet-api.outlayer.ai/attestations/by-request/8702) | [refunded 25 pUSD](https://testnet.nearblocks.io/txns/5LMvQjvuV1qpPY67sdLtqaRbrdE7JWyLx1AZMWCgTTYd) |
| 8 | function, honest | [request 8704](https://testnet-api.outlayer.ai/attestations/by-request/8704) | [released 25 pUSD](https://testnet.nearblocks.io/txns/5S8JoucdPk4z4vz9sofF4p2eYNG5dRdqxt8UZZuaW1qC) |
| 9 | function, fake | [request 8706](https://testnet-api.outlayer.ai/attestations/by-request/8706) | [refunded 25 pUSD](https://testnet.nearblocks.io/txns/9m7ppv8ux87nRVzqonVY8Ds9qomejG2A9Mdo9iWMTGv7) |

Each challenge was triggered by the fake-worker account, and each delivery verification by the named worker. Both data challenges caught 13 of 13 generated fakes; both function challenges caught 11 of 11, with one additional mutant unconfirmed. These counts describe mutations of the supplied reference; they do not establish check completeness. The strong checks were written with knowledge of the generator. Final token balances: honest worker 275 pUSD, fake worker 0, escrow 0. pUSD is a test token with no value.

To audit a recorded result after configuring `.env`, run `cd relay` and `npm run relay -- audit 6 verify`. That audits hash bindings and quote fields only. The independent Intel signature check for request 8700 is described above.

## P5 quote preview (no funds)

From `agent/`, after `npm ci`, run this public quote preview. It needs no `.env`, account, API key or balance. The addresses below are placeholders for this preview only.

```sh
npm run --silent settlement -- quote '{"origin_asset":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","destination_asset":"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near","amount":"1000000","refund_to":"0000000000000000000000000000000000000000000000000000000000000000","recipient":"0x1111111111111111111111111111111111111111"}'
```

Expect JSON with `mode: "dry_quote"`, `execution_enabled: false`, token decimals, and integer input/output amounts. This always sends `dry: true`, including when `--dry-run` is omitted. It requests no deposit address and cannot sign or send a transaction. Choose assets by exact ID from the [public token catalog](https://1click.chaindefuser.com/v0/tokens); `amount` uses the origin token's smallest units. Slippage defaults to 100 basis points (1%); `slippage_bps` accepts 0 to 100. Unknown arguments, mismatched responses and funding fields are rejected. A November 4 preview of 1 NEAR USDC returned 997398 base units of Base USDC (minimum 987424), with a 2400-unit withdrawal fee already included. Quotes change; this is not an execution price or a verified service signature.

For an existing real 1Click deposit, `npm run --silent settlement -- status '{"deposit_address":"<actual deposit address>"}'` reads the API's status. Add `deposit_memo` when the original quote requires it. It preserves all seven documented states, returns transaction hashes, and never retries a payment. `REFUNDED` is an API report requiring independent refund confirmation; fees can reduce the returned amount. `FAILED` does not prove a refund. Unknown states and request failures remain unresolved. These statuses cannot set a Proven verdict or change escrow state.

P5 is incomplete: there is no cross-chain payout integration or mainnet settlement evidence. [1Click has no testnet deployment](https://docs.near-intents.org/resources/faqs), so these estimates concern mainnet assets and cannot spend the testnet escrow's funds. The existing worker receives NEAR or the job's token through the escrow. Mainnet funding, destination/refund addresses and the connection to an escrow payout still need an approved design. The preview trusts the 1Click HTTPS API for estimates; it does not verify settlement on either chain.

## Local job evidence page

Run `cd web && npm ci && npm start`, then open `http://127.0.0.1:4173`. Node 22.18 or newer is required. No `.env`, wallet or API key is needed. Click **Job 33** to read the existing honest payout, or **Job 34** for the fake delivery's refund. These are existing jobs read live, not newly triggered demos. Refresh is manual; old results are cleared on a new lookup or error.

The page shows the amount, confirmed or pending payout state, current attempt, retry/expiry eligibility, check-challenge counts, hashes and evidence links. It reads the job at a fixed final testnet block and compares each stored request's attestation with that job's input, verifier and output hashes, secret profile and quote commitments. **Bindings matched** means those field comparisons passed. The page does not verify Intel signatures, worker-measurement approval or NEAR light-client proofs; it relies on the public RPC and OutLayer API. Job lookups cannot start runs, set verdicts, release funds or read private input files. A separate opt-in browser control can launch the fixed scripted demo through the existing CLI; only the escrow callback can record a verdict. The read-only API uses Node built-ins and the repository's existing pure attestation/hash helpers. The opt-in demo child uses the existing agent and relay dependencies.

For checks, run `cd web && npm test && npm run typecheck && npm run format:check`. P6 remains incomplete: the guarded browser trigger passed a fresh local testnet loop, but public hosting is not yet deployed or verified. P5's real cross-chain payout remains pending. Stop the local server with Ctrl-C when finished.

## Local browser demo

The default `cd web && npm start` keeps live demos disabled. The page reads completed jobs 33/34 as existing records; those buttons do not create a new demo. The guarded Start control passed local unit, HTTP and browser-control tests and a fresh user-started testnet loop on November 6. It does not make the earlier 117.87-second command result a browser benchmark.

For an owner-approved fresh test, first start the private operator broker using the split RPC command below and confirm the unchanged reserves and funding cap. Then run `cd web && npm run demo:arm`, followed by `npm start -- --demo`. Open `http://127.0.0.1:4173` and press Start live demo. Arming alone sends no transaction. Start launches only the two fixed scripted cases, with 0.01 testnet NEAR per job and four sponsored compute attempts; the browser cannot choose amounts, recipients, inputs or commands.

One durable allowance permits at most one CLI invocation. Consumption is exclusive and synced before launch. Repeated clicks, separate server processes and restarts cannot spend it again. Missing allowance storage disables the control. There is no browser reset, resume or automatic POST retry. If a response or process outcome is uncertain, use Check demo status and have the operator reconcile private evidence before any new session. The wrapper's elapsed timer is progress only. Completion requires the CLI's two exact payout proofs and four secret cleanup results; those proofs are produced by the existing runner, not independently revalidated by the web wrapper. Open each job for a public chain snapshot.

The November 6 local browser run created jobs 35/36, paid the honest worker and refunded the fake, exactly 0.01 testnet NEAR each, and deleted all four secret profiles. The server reported 114.383 seconds from consuming the allowance through child completion; the runner measured 114.068 seconds internally. These are progress measurements, not an independent external browser or full-command timing benchmark. Opening a live job snapshot did not enable Start again. After completion Start remained disabled, and a server restart still reported the allowance consumed. Both verdict attestations passed independent online and offline signature/binding verification. A separate reviewer independently checked both transfer receipts and all four final cleanup transactions.

| Fresh browser case | Verdict attestation | Native settlement |
|---|---|---|
| 35 · honest | [request 10067](https://testnet-api.outlayer.ai/attestations/by-request/10067) | [0.01 testnet NEAR released](https://testnet.nearblocks.io/txns/uqZECbkFgNCTGchXMVbwHEZG7wsSqezYu3dscmSccbX) |
| 36 · fake | [request 10068](https://testnet-api.outlayer.ai/attestations/by-request/10068) | [0.01 testnet NEAR refunded](https://testnet.nearblocks.io/txns/2SupqXas9p4BPW2JcEaN1RU2XpgamuJMaTh3DvfFVogb) |

Recheck the new honest verdict independently, without keys or funds:

```sh
outlayer-verify tx GmizzZPytSs3RDGJmYkTigGcViJjfjjCxJyXRbhmjtU2 --network testnet --api https://testnet-api.outlayer.ai --rpc https://test.rpc.fastnear.com --archival-rpc https://archival-rpc.testnet.near.org --bundle runs/10067.bundle.json --no-color
outlayer-verify bundle runs/10067.bundle.json --offline --short --no-color
```

No public deployment is configured. [Hosting preparation](web/HOSTING.md) describes the required private state, exact HTTPS origin and separate publication checkpoint. No keys, private run journals or allowance files belong in a deployment bundle.

## Layout

The P4 interface lives in `agent/`; see [agent instructions](agent/skill.md) for tool arguments, signer limits and the local private handoff. From `agent/`, `npm ci`, `npm run proven -- --help` and `npm run mcp` start the CLI and MCP interface. The owner-only custody setup requires explicit approval before registration or funding. Agent tools accept custody credentials or scoped worker keys, never a full-access buyer key. The current custody policy supports native-NEAR jobs only; token funding would call a contract outside its escrow-only allowlist.

After owner setup, start `cd relay && npm run handoff`, then run `cd agent && npm run demo` in another terminal. This is a scripted demo, not a model-driven agent. Use `npm run demo -- --dry-run` to construct creation plans without chain or service writes; local evidence files are still saved. Private data travels over an owner-only local Unix socket and stays available to the relay operator; no public relay API is deployed. If a live run stops, inspect the recorded job and wallet history before using `npm run demo -- --resume <absolute-evidence-file>`; a confirmed job id is reused rather than posted again.

The P6 command follows an asynchronous custody request using its fixed request ID, then reads the known transaction until settled. Transient status-read failures cause bounded GET retries; a custody POST is never automatically repeated. An uncertain submission stops the run for reconciliation; resuming cannot repeat that uncertain operation. The command checks the restricted policy and private relay socket, requires at least 0.3 testnet NEAR in the custody account for a fresh run's transient reserves, and never adds funds or changes permissions. It attaches 0.02 NEAR per job for storage (the observed fixed example needed 0.00837), with excess returned by escrow. Evidence files use `runs/p6-demo-<uuid>.json`. The internal timer includes preflight but starts after module loading. The strict full-command check uses the external `real` value from `/usr/bin/time -p npm run demo -- --operator-compute`; it must be below 120 seconds. `internal_timer_under_two_minutes` describes only a fresh, non-dry run’s internal measurement. Dry and resumed runs cannot satisfy the target. Job lookups remain read-only; the separately armed demo control is described below.

An opt-in operator mode starts with `cd relay && npm run handoff -- --demo-compute`, then `cd agent && npm run demo -- --operator-compute`. The existing local relay operator sponsors the four permissionless compute calls; the buyer still posts and funds through its restricted custody wallet, and workers still use scoped keys. The private broker binds one random session to exactly two fixed example jobs and permits at most four compute attempts, each attaching 0.1 testnet NEAR and 150 Tgas. Unused compute deposits return to that operator. This mode requires existing balances of at least 0.5 NEAR in the operator and 0.15 NEAR in custody; it never tops them up. Sponsorship is disabled by default and grants no verdict authority.

The broker journals each signed compute and secret-store/delete hash, public nonce and reference block before broadcast. Each journaled call signs once and reads only its known hash. If unobserved, the broker may transmit the same immutable signed bytes through `broadcast_tx_async` at most three times; it never signs a replacement or changes the nonce. Retransmission stops permanently once matching inclusion is seen. These are copies of one transaction, not additional logical compute attempts. Acknowledgement is not admission: the compute signer queue remains held until matching final inclusion, and secret pinning requires confirmed execution. If inclusion remains unproved, further operator signing suspends; inspect the known transaction before restarting. A consumed attempt is never automatically retried. Operator HTTP transport uses one attempt per request; fixed phase timings and redacted failure categories are saved in owner-only `runs/private/demo-timing-*.json`. The official testnet endpoints `https://near-testnet.drpc.org` and `https://testnet-rpc.intea.rs` can be selected explicitly with `NEAR_RPC_URL`. The broker can separately send broadcasts through `PROVEN_BROADCAST_RPC_URL`; all state reads still use `NEAR_RPC_URL`. Both routes must be allowlisted testnet URLs, and neither has automatic endpoint failover. The measured 117.87-second fresh run used Fastnear reads and Intear broadcasts. The client waits for the escrow's recorded callback result before deleting inputs. Payment evidence checks the exact successful native transfer receipt, its escrow source, job, receiver and amount. Receipt mode skips redundant before/after balance requests; legacy balance snapshots remain in older run evidence and may lag or include unrelated activity. These reads trust the configured RPC, rather than a light-client proof.

Earlier operator benchmarks missed the target. Jobs 15 and 16 settled correctly, but the command took 263.57 seconds and its old balance-based check stopped on stale readings; exact receipts subsequently confirmed both payments. The next run created jobs 17 and 18, stopped during pinning, and resumed in 162.38 seconds. Job 18 was refunded; job 17 was released after one separately journaled recovery verification (request 9455). Interrupted and resumed runs never count as a two-minute pass. The first unattended complete loop, jobs 27/28, took **216.84 seconds** wall time (216.541 seconds recorded inside the command), including preflight, four compute runs, payout receipt checks and four secret deletions. It used Intear for reads and broadcasts, paid the honest worker and refunded the fake delivery without resume or manual repair. All four hash-binding audits passed; both delivery attestations passed independent verification online and offline. A later complete fresh run, jobs 31/32, took **120.20 seconds** wall time while its internal timer reported 119.917 seconds. This also misses the strict target. Its canonical assessment records the external result, and the runner now labels internal timing separately. The next fresh run, jobs 33/34, completed in **117.87 seconds** externally (117.531 seconds internally), passing the strict timing check for this recorded run. It included preflight, four compute runs, exact payout receipt checks and four secret deletions, without resume or manual intervention. Future duration depends on network and service latency; this is one measured pass, not a time guarantee. A separate earlier instrumented attempt also failed to complete: job 19 stayed unfunded and was canceled; job 20 had no delivery verdict and was refunded through Expired after its verdict window. The broker retained the uncertain signed hash and stopped further signing. These are recovery outcomes, not a successful live-demo result.

For the measured split route, the operator command is `cd relay && NEAR_RPC_URL=https://test.rpc.fastnear.com PROVEN_BROADCAST_RPC_URL=https://testnet-rpc.intea.rs npm run handoff -- --demo-compute`; the timed client command is `cd agent && NEAR_RPC_URL=https://test.rpc.fastnear.com /usr/bin/time -p npm run demo -- --operator-compute`. Preserve the existing reserve checks and funding approvals. The local command timing task and fresh local browser loop passed; approved public hosting remains pending.

| Completed unattended run (117.87-second fresh pair) | Verdict attestation | Native settlement |
|---|---|---|
| 33 · honest | [request 9699](https://testnet-api.outlayer.ai/attestations/by-request/9699) | [0.01 testnet NEAR released](https://testnet.nearblocks.io/txns/ZH9GuHppqh46wGMWdegkD42DSpMDFsb5T3d81CKXuo7) |
| 34 · fake | [request 9701](https://testnet-api.outlayer.ai/attestations/by-request/9701) | [0.01 testnet NEAR refunded](https://testnet.nearblocks.io/txns/83q49439pgMNYa5e4XxicWXSXbn357cLZcrfC3kgHyKR) |

To independently check these completed verdicts from the repository root:

```sh
outlayer-verify tx EJsfAgS2Jfk88H7PFFQXFf6LxEYugPnYBmd6Yo9mq3Pj --network testnet --api https://testnet-api.outlayer.ai --rpc https://test.rpc.fastnear.com --archival-rpc https://archival-rpc.testnet.near.org --bundle runs/9699.bundle.json --no-color
outlayer-verify tx EXRCPbapaCyeQTcCuvxNAMbzggNDayhgS7kF9Yj93jqJ --network testnet --api https://testnet-api.outlayer.ai --rpc https://test.rpc.fastnear.com --archival-rpc https://archival-rpc.testnet.near.org --bundle runs/9701.bundle.json --no-color
outlayer-verify bundle runs/9699.bundle.json --offline --short --no-color
outlayer-verify bundle runs/9701.bundle.json --offline --short --no-color
```

The November 4–5 P6 run settled job 13 to the honest worker and refunded job 14, each for exactly 0.01 testnet NEAR. The first command stopped at an uncertain client response after verification had succeeded on chain; its known transaction was reconciled without repeating verification. The resumed command completed in 145.74 seconds. **This earlier resumed run does not satisfy the two-minute check; the later fresh jobs 33/34 passed it.**

| Job | Verdict attestation | Payout |
|---|---|---|
| 13 · honest | [request 9345](https://testnet-api.outlayer.ai/attestations/by-request/9345) | [0.01 testnet NEAR released](https://testnet.nearblocks.io/txns/C7HHm4kxAHhyJz2Bq4FdBAFWJk1KK4H9313ge7RLKvbe) |
| 14 · fake | [request 9430](https://testnet-api.outlayer.ai/attestations/by-request/9430) | [0.01 testnet NEAR refunded](https://testnet.nearblocks.io/txns/BKnYwooxqpi8NNSpkwr6t7aJqZANbLBzK26GN7DYEqzk) |

Independently verify these verdicts without keys or funds:

```sh
outlayer-verify tx Hfgtr6Y9j3mkeRnrwJUAT11tMwKXx2taTTsaAeuW3TEm --network testnet --api https://testnet-api.outlayer.ai --rpc https://test.rpc.fastnear.com --archival-rpc https://archival-rpc.testnet.near.org
outlayer-verify tx 6vCuRofcNfgXvCX1kF9PMTaCwpfVrgJ3v27T9ejX9ygb --network testnet --api https://testnet-api.outlayer.ai --rpc https://test.rpc.fastnear.com --archival-rpc https://archival-rpc.testnet.near.org
```

The native-call custody policy limits direct targets and attached deposits. It has no method-name allowlist and does not understand a job's intended worker. Escrow authorization and state checks still apply. Custody depends on OutLayer's keystore and policy enforcement; its cumulative daily counter is best effort under concurrency. None of this changes the escrow's verdict trust described above.

The P4 terminal check passed on November 4: job 11 paid the honest worker exactly [0.01 testnet NEAR](https://testnet.nearblocks.io/txns/LkRgmoW5yt5uFtiR2Zofuf9n1nLLYVs3rmfsbTaNjne), and job 12 refunded the buyer exactly [0.01 testnet NEAR](https://testnet.nearblocks.io/txns/FSWa78WDpFJY9wuY9Ky3P4xaQQLHhbsqMG1WpUPVXepU). Verdict attestations are [request 8815](https://testnet-api.outlayer.ai/attestations/by-request/8815) and [request 8817](https://testnet-api.outlayer.ai/attestations/by-request/8817). Their hash bindings were audited; these new quotes were not independently signature-checked. The run required explicit resume after asynchronous custody responses and gas-reserve checks; it is not a two-minute unattended demo. The custody policy rejected a call outside escrow with HTTP 403 before a transaction was created.

| Path | What |
|---|---|
| `contracts/escrow/` | NEAR escrow contract (Rust, `near-sdk`) |
| `contracts/test-token/` | Test NEP-141 token with no value, for tests and the testnet demo |
| `contracts/mock-outlayer/` | Test double of the OutLayer contract, used only by sandbox tests |
| `verifier/` | Acceptance-check runner (Rust to WebAssembly) and the check challenge |
| `relay/` | Convenience tool: pins private texts, triggers runs and audits attestations. It cannot set a result |
| `agent/` | MCP server, CLI and `skill.md` for agents |
| `web/` | Local job evidence page and guarded browser demo trigger; fresh local browser loop verified; public hosting remains pending |
| `examples/` | Sample jobs and fictional data |

## License

MIT. See `LICENSE`.
