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

Independent command-line verification of **request 8700 (task 19117, job 6)** passed on November 4 with source-built `outlayer-verify` v0.1.0, revision `90c27d9d`, exit code 0. Authenticity (Intel signature chain, TCB UpToDate), measurement approval, execution binding, and input/output bytes recovered from chain all passed. Intel collateral read from the register contract matched the API copy byte for byte. This result covers this attestation; the other listed runs have hash-binding checks only. The relay itself does not verify Intel signatures, and the escrow still does not verify a per-call quote on chain.

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

## Layout

The P4 interface lives in `agent/`; see [agent instructions](agent/skill.md) for tool arguments, signer limits and the local private handoff. From `agent/`, `npm ci`, `npm run proven -- --help` and `npm run mcp` start the CLI and MCP interface. The owner-only custody setup requires explicit approval before registration or funding. Agent tools accept custody credentials or scoped worker keys, never a full-access buyer key. The current custody policy supports native-NEAR jobs only; token funding would call a contract outside its escrow-only allowlist.

After owner setup, start `cd relay && npm run handoff`, then run `cd agent && npm run demo` in another terminal. This is a scripted demo, not a model-driven agent. Use `npm run demo -- --dry-run` to construct creation plans without chain or service writes; local evidence files are still saved. Private data travels over an owner-only local Unix socket and stays available to the relay operator; no public relay API is deployed. If a live run stops, inspect the recorded job and wallet history before using `npm run demo -- --resume <absolute-evidence-file>`; a confirmed job id is reused rather than posted again.

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
| `web/` | Job page and demo mode |
| `examples/` | Sample jobs and fictional data |

## License

MIT. See `LICENSE`.
