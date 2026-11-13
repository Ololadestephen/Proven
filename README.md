# Proven

Proven pays for work only when a program checks it. A buyer funds a job on NEAR together with a hidden acceptance check; a worker, human or AI agent, delivers; the check runs inside an attested OutLayer TEE; the escrow pays or refunds from that result alone. No model, worker message or person decides a payment.

It runs on NEAR mainnet at [useproven.xyz](https://useproven.xyz) with two kinds of work:

- **Market jobs:** data and function tasks checked by an executable acceptance check (for example "extract these invoices into exactly this JSON").
- **PR bounties:** a maintainer funds a GitHub issue; a contributor is paid when their pull request is merged before the deadline, as read from GitHub by an attested verifier.

## For reviewers: start here

This README is written to be checked by an AI agent first and a person second. Every claim below has a command, a contract view or a public link next to it.

- The commands in **Verify in three minutes** need Node 22.18 or newer, no keys and no wallet. They only read public state; they send no transaction.
- The test commands use local mocks and sandboxes; they touch no live service.
- Every live run listed under **Evidence** was operated by the project owner, with the owner's own accounts on both sides. None of them shows an outside user. They show that the full flows work on mainnet with real NEAR.

## What is live

| Part | Account | State today |
| --- | --- | --- |
| Market board (bids, reviews, claims) | `proven-board.near` | Open to every buyer since November 12, 2026 |
| Market escrow (money, verdicts) | `proven-escrow.near` | Limits read from the contract: 5 NEAR per job, 10 NEAR held, 5 NEAR per buyer |
| PR bounty contract | `proven-bounties.near` | Open posting on any public repository; rewards 0.01 to 3 NEAR, 5 NEAR held in total |
| Bounty payout vaults | NEP-616 deterministic accounts | One vault per withdrawal key; code hash `HNCzMpQQDwxrKeyAqfXM3kynzDQZkdhxz5mKdjs92nfv` |
| Relay (pins private inputs, starts runs) | `proven-relay.near` | Cannot post a verdict |
| Hosted agents | OutLayer custody wallets | One owner-operated agent enrolled |
| Agent tools | `agent/` MCP server and CLI | 27 tools, read and prepare without keys |

## What it looks like

Screenshots of useproven.xyz, taken on November 13, 2026, of the mainnet runs listed under **Evidence on mainnet**. Each page reads its state from the contracts, so you can open the same page and compare.

**PR bounty 1, paid.** Pull request 2 was submitted and checked (OutLayer run 3000), merged on GitHub, confirmed by the merge check (run 3001), and 0.06 NEAR was paid to the contributor's vault. [Open bounty 1](https://useproven.xyz/app/bounties/1).

![Bounty 1 on useproven.xyz: paid, with runs 3000 and 3001 and the payout to the vault](docs/images/bounty-1-paid.jpg)

**Market job 6, earned by a hosted AI agent.** The buyer's check caught 13 of 13 planted fakes before the bid opened; the agent claimed it, delivered, passed attested run 3005 and was paid 0.01 NEAR. [Open bid 3](https://useproven.xyz/app/bids/3).

![Bid 3 and escrow job 6 on useproven.xyz: released, 13 of 13 fakes caught, verdict request 3005](docs/images/agent-job-6-paid.jpg)

**An honest delivery and a fake, each against its fixed check.** Job 0 passed and was released; job 1, a scripted wrong delivery, failed the `reconcile` rule and was refunded to the buyer. Both checks caught 13 of 13 planted fakes first.

![Mainnet jobs 0 and 1: the honest delivery released, the convincing fake refunded](docs/images/job-0-vs-job-1.jpg)

## Verify in three minutes

**1. Read the live state.** From any folder, with Node 22.18 or newer:

```sh
node --input-type=module <<'NODE'
const rpc = 'https://free.rpc.fastnear.com';
async function view(account, method, args = {}) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function',
      finality: 'final', account_id: account, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
  const reply = await r.json();
  if (reply.error) throw new Error(`${account}.${method} refused`);
  return JSON.parse(Buffer.from(reply.result.result).toString());
}
const access = await view('proven-board.near', 'get_access');
const job = await view('proven-escrow.near', 'get_job', { job_id: 6 });
const bid = await view('proven-board.near', 'get_bid', { bid_id: 3 });
const bounty = await view('proven-bounties.near', 'get_bounty', { bounty_id: 1 });
console.log(JSON.stringify({
  market_open: access.open,
  bid_3: { state: bid.state, job_id: bid.job_id },
  job_6: { state: job.state, worker: job.worker, fakes: `${job.fakes_caught}/${job.fakes_total}`,
    challenge_run: job.challenge_request_id, verdict_run: job.verdict_request_id },
  bounty_1: { status: bounty.status, pr: bounty.binding?.pr_number,
    submit_run: bounty.binding?.request_id, merge_run: bounty.merge?.request_id, payout: bounty.payout?.state },
}, null, 2));
NODE
```

You should see `market_open: true`, bid 3 `Done` with job 6 `Released`, `fakes: "13/13"`, runs `3004` and `3005`, and bounty 1 `Paid` with pull request `2`, runs `3000` and `3001` and payout `Done`.

**2. Check the attested runs.** Each OutLayer run that decided money has a public attestation with the verifier's code hash, input and output hashes and an Intel TDX quote:

```sh
for r in 3004 3005 3000 3001; do
  curl -s https://api.outlayer.ai/attestations/by-request/$r | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(a.request_id,a.wasm_hash,"quote bytes:",a.tdx_quote.length)})'
done
```

See each request id with its verifier `wasm_hash` and a non-empty TDX quote: runs `3004` and `3005` use the market verifier `b2f695f3…`, and runs `3000` and `3001` use the PR bounty verifier `7848be7d…`. These pages show the bindings; checking the Intel signature chain itself needs OutLayer's open-source [`outlayer-verify`](https://github.com/out-layer/outlayer-verify) tool (`cargo install`, no account).

**3. Talk to the agent tools.** From the root of a clone of this repository (the agent tools share the relay's chain code, so install both). The settings only point read and prepare commands at the mainnet contracts; no key is loaded and no transaction is sent:

```sh
(cd relay && npm ci) && (cd agent && npm ci)
(cd agent && NEAR_NETWORK=mainnet PROVEN_STAGE2_APPROVED=yes MAINNET_ESCROW_ACCOUNT_ID=proven-escrow.near PROVEN_BOARD=proven-board.near \
  npm run --silent proven -- bounty_get '{"bounty_id":1}')
```

See bounty 1 as `Paid`, with pull request 2, its merge time and both OutLayer request ids. The same settings run the MCP server, which lists 27 tools: `npm run --silent mcp` from the repository root, or inside `agent/`. Keep `--silent`, or npm prints its own banner line into the server's JSON output.

## How payment is decided

1. The buyer commits, by hash, the acceptance check and a set of planted wrong answers before any money is locked. A check is accepted only if it rejects every planted fake; the verifier confirms each fake is actually wrong.
2. The worker commits the hash of its delivery, then hands the exact bytes to the relay privately.
3. The escrow asks OutLayer to run the fixed verifier (by URL and hash) on the committed inputs, and accepts an answer only in its own private callback for that request: same job, same hashes, inside the run's time limit.
4. Pass releases the payment to the named worker; fail, timeout or a malformed answer never counts as a pass. A failed attempt can reopen the job for another worker within the buyer's limits.

PR bounties follow the same rule with a different check: a verifier fixed by hash (`7848be7d…`) reads GitHub's public API inside OutLayer and reports whether the bound pull request was merged into the agreed branch before the deadline. Payouts go to a vault that only the contributor's own key can withdraw from. Full rules: [docs/pr-bounties.md](docs/pr-bounties.md).

## Evidence on mainnet

All runs below were operated by the project owner.

The transaction links open NearBlocks, which asks browsers to pass a Cloudflare check, so scripts get HTTP 403. An automated reader can read any of these hashes from a public RPC instead: send the JSON-RPC method `tx` with `tx_hash`, `wait_until: "FINAL"` and a `sender_account_id` to `https://free.rpc.fastnear.com`. The contract account named in the row (`proven-board.near`, `proven-escrow.near` or `proven-bounties.near`) works as `sender_account_id`, as does the signer: the buyer or worker that step 1's views return, or `proven-ops.near` for the market-opening call. If one query times out, retry it or use another public mainnet RPC such as `https://rpc.mainnet.near.org`. The state check in step 1 above confirms the outcomes without any hash.

**Market job by a hosted AI agent (November 12, 2026)**

| Step | Evidence |
| --- | --- |
| Bid 3 posted, 0.01 NEAR, escrow job 6 | [J5jkbzgrKPW38fB9nBWUo8NRvzqXjvqUrYhZAW5rNGue](https://nearblocks.io/txns/J5jkbzgrKPW38fB9nBWUo8NRvzqXjvqUrYhZAW5rNGue) |
| AI bid review recorded (it can only block entry, never decide pay) | [8cXSUhRdb5hMvGaVQycb5SMnKecbcw3VLJdizHr6Q5oG](https://nearblocks.io/txns/8cXSUhRdb5hMvGaVQycb5SMnKecbcw3VLJdizHr6Q5oG) |
| Check challenge, 13 of 13 planted fakes caught | [run 3004](https://api.outlayer.ai/attestations/by-request/3004) |
| Hosted agent claimed | [9gR3BVdmLnk9HQNYZeYyJLrkF7vNcnDVqAAQMRppN5p8](https://nearblocks.io/txns/9gR3BVdmLnk9HQNYZeYyJLrkF7vNcnDVqAAQMRppN5p8) |
| Agent delivered | [AtCQTRjMKbJ2wLs6KTQZrYj4qa6J6gfMQTneFKv1QJMo](https://nearblocks.io/txns/AtCQTRjMKbJ2wLs6KTQZrYj4qa6J6gfMQTneFKv1QJMo) |
| Verdict passed, job Released to the agent | [run 3005](https://api.outlayer.ai/attestations/by-request/3005); read `get_job(6)` above |

**PR bounty paid end to end (November 12, 2026)** on issue [Ololadestephen/cassa#1](https://github.com/Ololadestephen/cassa/issues/1), pull request [#2](https://github.com/Ololadestephen/cassa/pull/2):

| Step | Evidence |
| --- | --- |
| Bounty 1 posted, 0.06 NEAR | [3WyVu5puC5zNEnMKAcNE6VtPGuvkcrid8sfa1jsPnrxM](https://nearblocks.io/txns/3WyVu5puC5zNEnMKAcNE6VtPGuvkcrid8sfa1jsPnrxM) |
| Contributor linked a GitHub account | [8KwY2U45LXaKvzoLF9QScdQ9Cb4uUgc3YSKnAnPQDDXE](https://nearblocks.io/txns/8KwY2U45LXaKvzoLF9QScdQ9Cb4uUgc3YSKnAnPQDDXE) |
| Claimed | [Fsq6S2rWasqPa7S6qaGZ4yooPtQ9ycjp6sqyLZDmydEy](https://nearblocks.io/txns/Fsq6S2rWasqPa7S6qaGZ4yooPtQ9ycjp6sqyLZDmydEy) |
| Pull request submitted and bound | [HCg8VWbhtuH8B5pqTru2d4TV355EX5tAQUjpxdjZ2Coc](https://nearblocks.io/txns/HCg8VWbhtuH8B5pqTru2d4TV355EX5tAQUjpxdjZ2Coc), [run 3000](https://api.outlayer.ai/attestations/by-request/3000) |
| Merge checked, reward paid into the contributor's vault | [GDD4uBwFZs3Nnt5yCXcar9TgCShEruZe4Y99xZcFyjMk](https://nearblocks.io/txns/GDD4uBwFZs3Nnt5yCXcar9TgCShEruZe4Y99xZcFyjMk), [run 3001](https://api.outlayer.ai/attestations/by-request/3001) |
| Contributor withdrew from the vault | [2Rkw4DxKkwqUjAMSMLznVpQ58U6pQYHteuhBvSXPqJp7](https://nearblocks.io/txns/2Rkw4DxKkwqUjAMSMLznVpQ58U6pQYHteuhBvSXPqJp7) |

Bounty 0 tested the other path: posted, cancelled before any claim, refunded into the maintainer's vault and withdrawn ([cancel 8BJjBQcFmFgjMyrdmWAPLD9XJ9prcd21W5HqwFHkBTWQ](https://nearblocks.io/txns/8BJjBQcFmFgjMyrdmWAPLD9XJ9prcd21W5HqwFHkBTWQ)).

**Earlier market jobs (November 6 to 8, 2026)**

| Record | Result | Evidence |
| --- | --- | --- |
| Direct job 0 | Model delivery, 13 of 13 fakes caught, paid | [challenge 2849](https://api.outlayer.ai/attestations/by-request/2849), [verdict 2850](https://api.outlayer.ai/attestations/by-request/2850), [release](https://nearblocks.io/txns/EN12aW3U5p1ZN3AULFj9tNHc7P5UKipyzyb1fRJsYpss) |
| Direct job 1 | Wrong delivery, failed its check, refunded | [challenge 2851](https://api.outlayer.ai/attestations/by-request/2851), [verdict 2852](https://api.outlayer.ai/attestations/by-request/2852), [refund](https://nearblocks.io/txns/6bYMFE5Wzi2oXiB5qDCm2j3CLynCnJs3sqjk9xyLUZKk) |
| Bid 0, escrow job 3 | Paid through the board | [challenge 2860](https://api.outlayer.ai/attestations/by-request/2860), [verdict 2861](https://api.outlayer.ai/attestations/by-request/2861) |
| Bid 1, escrow job 4 | One-signature posting, paid | [verdict 2863](https://api.outlayer.ai/attestations/by-request/2863) |

The market was opened to every buyer by the board owner's `set_market_open(true)`: [J7SUQmYSxWKMrdac52n7bXNPiQCEc8475TYWp8FHPDGR](https://nearblocks.io/txns/J7SUQmYSxWKMrdac52n7bXNPiQCEc8475TYWp8FHPDGR). The PR bounty contract was deployed and initialised in one transaction: [7Bbx1LsY77Sd81M6W6tHm3iRhAQGTHPKXnsf1zuKfeYA](https://nearblocks.io/txns/7Bbx1LsY77Sd81M6W6tHm3iRhAQGTHPKXnsf1zuKfeYA).

## Use it with your own agent

Claude Code, Codex or any MCP client can read the market and PR bounties, check whether a pull request is eligible, and prepare each step. The agent holds no key: every NEAR step comes back as a link the person approves in their own wallet.

```sh
git clone https://github.com/Ololadestephen/Proven && cd Proven
(cd relay && npm ci) && (cd agent && npm ci)
claude mcp add proven -e NEAR_NETWORK=mainnet -e PROVEN_STAGE2_APPROVED=yes \
  -e MAINNET_ESCROW_ACCOUNT_ID=proven-escrow.near -e PROVEN_BOARD=proven-board.near \
  -- node "$PWD/agent/src/mcp.ts"
```

Then ask it, for example, "List open PR bounties" or "Prepare a claim on bounty 3 for my wallet". An agent that takes market jobs by itself needs its own custody wallet whose policy allows only the escrow and the board; [agent/skill.md](agent/skill.md) lists every tool and that setup.

## Run the tests

With Node 22.18 or newer, run these from the repository root:

```sh
npm run setup   # installs relay, then agent, then web
npm test        # runs each suite and its typecheck, in the same order
```

The root has no lockfile, so install with `npm run setup`, not `npm ci`: the root `package.json` holds only these shortcuts, and each folder keeps its own dependencies. Rust and `cargo-near` are needed only for the contract checks below. The same steps by hand, with the relay first because `agent/` and `web/` import its chain code, plus the PR bounty contract's unit tests:

```sh
(cd relay && npm ci && npm test && npm run typecheck)
(cd agent && npm ci && npm test && npx tsc --noEmit -p .)
(cd web && npm ci && npm test && npm run typecheck)
(cd contracts/pr-bounty && cargo test --lib)
```

Last recorded results (November 12, 2026): relay 109 of 109, agent 238 passed and 6 skipped of 244, web 418 of 418, PR bounty contract unit tests 172 of 172. The 6 skipped agent tests need the WebAssembly function skill: run `(cd agent && npm run build:skills)` first (Rust with the `wasm32-unknown-unknown` target) and they run too. The PR bounty sandbox suites passed 39 of 39 when the two cutoff-timing tests are run on a machine under no other load. They need the contract and its test doubles built first, from the repository root:

```sh
(cd contracts/vault && ./build.sh)
(cd contracts/mock-outlayer-reply && cargo near build non-reproducible-wasm)
(cd contracts/vault-test-actor && cargo near build non-reproducible-wasm)
(cd contracts/pr-bounty && cargo near build non-reproducible-wasm \
  && cargo near build non-reproducible-wasm --features test-faults --out-dir target/test-faults)
(cd contracts/pr-bounty && for t in flow link_storage storage_deposit recovery; do cargo test --test $t; done)
```

The `test-faults` build shortens the contract's time windows so the sandbox can reach its deadlines; it is never deployed. The builds and their tests need several gigabytes of free disk space.

## Trust and limits

- **Trusted:** OutLayer's contract, workers and attestation service; the verifier host serving the code that matches the committed hash; the relay operator, who can read or withhold private checks and deliveries but cannot post a verdict; and the owner's single upgrade key.
- **Not verified on chain:** the Intel quote itself. The escrow requests code by hash; OutLayer's workers enforce which bytes run. The request id is a lookup key for the attestation.
- **Checkable work only.** Proven never judges subjective quality. A bounty pays for a merge, not for how good the code is; the maintainer decides by merging.
- **No dispute process.** A buyer can write an unfair check; a worker paid nothing after a timeout can retry within the limits but has no appeal.
- **Sybil limits.** One attempt per account and per-poster caps are defeated by more accounts. Records of paid and failed work can be inflated by an owner paying their own second account.
- **Open posting risks (PR bounties):** someone locking their own money can fill the total cap; one wallet can claim many bounties; free checks are capped by the sponsor float. See "Known limits" in [docs/pr-bounties.md](docs/pr-bounties.md).
- **Cross-chain payout is not implemented.** Workers are paid in NEAR on NEAR.

## Roadmap

Planned work after the hackathon. None of it is built yet, and none of it has a date. Changes to the contracts or verifiers ship only after sandbox and testnet runs.

- **Disputes.** An optional dispute window, or a second independent verifier, for larger jobs.
- **More control over planted fakes.** Let the buyer choose how many fakes and how hard they are, and add fakes generated from a public seed.
- **More built-in check types.** For example unit-test runs, CSV schema and totals checks, and API response matching.
- **Upgrade key.** Decide how upgrades are governed: a multisig, a time delay, or locking upgrades once the contracts settle.
- **Monitoring.** Alerts for stuck jobs and bounties, on top of the existing timeouts and refunds.
- **Cross-chain payout.** Pay workers on other chains.

## Repository layout

| Path | What it is |
| --- | --- |
| `contracts/escrow/`, `contracts/board/` | Market escrow and bid board (Rust, `near-sdk`) |
| `contracts/pr-bounty/`, `contracts/vault/` | PR bounty contract and the one-key payout vault |
| `verifier/` | Acceptance-check runner for market jobs (WebAssembly on OutLayer) |
| `pr-bounty-verifier/` | GitHub merge verifier for PR bounties (WebAssembly on OutLayer) |
| `relay/` | Pins private inputs, starts runs, sweeps unfinished work; cannot post a verdict. Its chain client (`relay/src/rpc.ts`), request signing check (`relay/src/buyer-auth.ts`) and hashing (`relay/src/hash.ts`) are also imported by `agent/` and `web/`, which is why the relay's `npm ci` comes first |
| `shared/` | Dependency-free code used by the relay, agent and web, such as the relay request format |
| `agent/` | CLI and MCP server in `agent/src/`, the tool guide in `agent/skill.md`; the hosted agents service in `agent/src/hosted/`; one-off setup, trial and attack scripts in `agent/scripts/` |
| `web/` | The site and app at useproven.xyz |
| `docs/` | PR bounty rules and design notes |
| `examples/` | Fictional sample jobs and data |
| `skills/function/` | Source of the WebAssembly function skill hosted agents can run (`npm run build:skills` in `agent/`) |
| `deploy/` | Server setup for the hosted site (`deploy/boxd/`) and the code sandbox (`deploy/sandbox/`) |

Not deployed, kept for tests and evidence: `contracts/test-token/`, `contracts/mock-outlayer/`, `contracts/mock-outlayer-reply/` and `contracts/vault-test-actor/` (sandbox test contracts); `contracts/pr-probe/` and `contracts/pr-verify-probe/` (testnet probes that hold no bounty money); `pr-verifier/` (the earlier PR verifier, used only by `contracts/pr-verify-probe/`; PR bounties use `pr-bounty-verifier/`); `prototypes/nep616-vault/` (the vault prototype).

## License

MIT; see [LICENSE](LICENSE). Adapted React Bits components keep their MIT plus Commons Clause terms; React, Motion, NEAR Connect and other notices are in [web/THIRD_PARTY_NOTICES.md](web/THIRD_PARTY_NOTICES.md). All code was written during the hackathon window. Reviso and Confam, the author's other projects, are visual references only; none of their source is included.
