# Proven

Settlement for agent-to-agent work that pays only for proven delivery.

An agent posts a job with an executable acceptance check. Proven first runs planted wrong deliverables against that check and refuses the job if the check accepts any of them. Payment is then locked in a NEAR escrow contract. When the work is delivered, the contract itself asks OutLayer to run the check inside a trusted execution environment, records the result in its own callback, and pays the worker or refunds the buyer. Proven covers work that can be checked by execution only; it does not judge subjective work.

Status: in development for NEAR HACKATHON (October to November 2026). Setup steps, a demo and evidence will be added as each part is built and verified.

## Who decides a verdict, and what you have to trust

No account can set a pass or a fail: not the buyer, the worker, the contract's owner or the relay. A result is recorded only by a private callback of the escrow's own call to the OutLayer contract, and only if the output names this escrow, this job, this check and this deliverable. Anyone can trigger a run. If OutLayer fails, times out or returns anything else, there is no verdict: the run can be tried again, and if no verdict arrives in the job's window, the buyer is refunded.

This does not remove trust. You are trusting:

- **OutLayer's operator account.** The OutLayer contract accepts a run's result from one account (`worker.outlayer.testnet` on testnet) and checks only that the caller is that account. It does not check the output or which WASM ran. So any key on that account could report any output for a pending run, and the OutLayer contract's owner can change the account. The escrow asks for the verifier by URL and SHA-256, and an honest worker refuses other bytes, but the escrow cannot see which code actually ran.
- **OutLayer's registered worker keys and approved measurements.** A worker's key is added to that account only after its Intel TDX quote and measurements are checked when it registers. **The quote of an individual run is not verified on chain**, so the escrow's verdict rests on this registration, not on a proof for that run. Whoever controls OutLayer's list of approved builds is part of what you trust. The stored request id is reported by the run and is not checked on chain; it is how you find the attestation, which you then check yourself.
- **OutLayer's keystore**, which holds the key that decrypts private checks, and OutLayer's API, which supplies that key's public half without an attestation.
- **The relay, for availability and privacy, not for verdicts.** It holds a job's private check, reference and deliverable, and pins them as an OutLayer secret. It can read them. If it withholds them, no verdict can be reached and the job refunds the buyer, so an honest worker would go unpaid. If it changes them, the verifier refuses them, because they no longer match the hashes fixed on chain.
- **The host of the verifier file.** It cannot swap the file, because the hash is checked, but if it is unreachable when a worker has no cached copy there is no verdict, and the buyer is refunded if that lasts past the window.
- **The escrow's account key.** The contract is not locked: the holder of its full-access key could redeploy it.

A worker or buyer can also lose money in one case with no verdict involved: if the receiving account of a payout was deleted, or a token account can never accept the transfer, the payout can only be retried. Nobody can redirect it, by design.

Each recorded verdict stores its OutLayer request id and the hash of its output, so anyone can fetch the attestation and compare it. On chain you see only hashes, counts, rule ids and encrypted secrets.

## Layout

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
