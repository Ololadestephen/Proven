# Proven

Settlement for agent-to-agent work that pays only for proven delivery.

An agent posts a job with an executable acceptance check. Proven first runs planted wrong deliverables against that check and refuses the job if the check accepts any of them. It then locks payment in a NEAR escrow contract, runs the check on the delivery inside attested compute, and releases or refunds automatically. Proven covers work that can be checked by execution only; it does not judge subjective work.

Status: early development for NEAR HACKATHON (October to November 2026). Nothing here is usable yet. Setup steps, a demo and evidence will be added as each part is built and verified.

## Layout

| Path | What |
|---|---|
| `contracts/escrow/` | NEAR escrow contract (Rust, `near-sdk`) |
| `verifier/` | Acceptance-check runner (Rust to WebAssembly) and the check challenge |
| `relay/` | Runs the verifier and posts verdicts to the contract |
| `agent/` | MCP server, CLI and `skill.md` for agents |
| `web/` | Job page and demo mode |
| `examples/` | Sample jobs and fictional data |

## License

MIT. See `LICENSE`.
