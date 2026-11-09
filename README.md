# Proven

Proven records payment for checkable work on NEAR. A buyer posts a bid with a payment, a public output format, and hashes of its private acceptance check and reference. A worker claims the checked bid and delivers exact bytes. The escrow requests OutLayer execution and records a verdict only in its own private callback. A model response cannot decide payment.

## Deployment and access

[useproven.xyz](https://useproven.xyz) is the **unaudited, owner-funded mainnet deployment**. The owner holds a single key that can upgrade the contracts. It is closed to listed buyers. The November 7 readback showed two listed buyers, a 5 NEAR per-job cap, 10 NEAR held in total, and 5 NEAR held per buyer. These are observed settings, not constants in the clients: read the board’s `get_access` and the escrow’s `get_config` for current values. Only the owner can change access or caps. Opening the market to outside users needs the owner’s approval.

The board is `proven-board.near`; the escrow is `proven-escrow.near`. The relay uses `proven-relay.near`, separate from the contract owner. The testnet copy is preparation only and is not linked from the app. A historical testnet example does not establish that the current mainnet flow has run.

The web server and relay use the board’s `get_access` as the access source. Only an older board without that view uses `PROVEN_MARKET_ACCESS`. A transport error or malformed current-board response must not open the market or silently select the environment list. The board also enforces access in `post_bid`; a page check is not the authority to accept a deposit.

## Read the current state without keys or transactions

Use Node 22.18 or newer. From the repository root, run the following public RPC queries. They load no configuration or keys from this checkout and make only `call_function` views at finality `final`.

```sh
node --input-type=module <<'NODE'
const rpc = 'https://rpc.mainnet.fastnear.com';
async function view(account, method, args = {}) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: method, method: 'query',
      params: {
        request_type: 'call_function', finality: 'final',
        account_id: account, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const reply = await response.json();
  if (reply.error) throw new Error(`RPC view ${method} refused`);
  const value = JSON.parse(Buffer.from(reply.result.result).toString('utf8'));
  console.log(JSON.stringify({ account, method, block: reply.result.block_height, value }, null, 2));
  return value;
}
await view('proven-board.near', 'get_access');
const config = await view('proven-escrow.near', 'get_config');
console.log('Native NEAR caps:', config.caps.find(cap => cap.token === null));
await view('proven-board.near', 'get_bid', { bid_id: 0 });
await view('proven-escrow.near', 'get_job', { job_id: 3 });
await view('proven-board.near', 'get_agent_record', { wallet: 'proven-ops.near' });
NODE
```

See the access flag and buyer accounts in the first response, native-token limits in `config.caps`, the bid’s escrow job ID, and the job’s state, history and request IDs. The November 7 snapshot had bid 0 `Done`, job 3 `Released`, and the market closed. Agent records for bids posted before the storage upgrade can remain uncounted until their attempt fees are synced; a zero record is not proof that an account has never worked.

Open `/api/market/config` on the site to see the settings served to the app. The static pages and app labels read these settings instead of stating fixed limits. If the settings cannot be read, the page shows that access or limits are unavailable rather than inventing them.

## Current one-signature workflow

The buyer signs one posting transaction, plus a message signature when collecting paid work. Registration, a worker’s claim, delivery and private handoff are separate worker actions; “one signature” does not mean no worker signatures or no gas.

1. **Post.** In `/app/post`, enter a public brief, output format, private check and reference, amount, deadline, attempt limit and optional allowed workers. Review the full attached amount: payment, checking budget, prepaid attempt fees and storage. Confirm the board call once. See the bid’s job ID when the board’s callback confirms escrow creation. Posting first uses the wallet’s board-authored `bid_posted` event. If that is unavailable and a transaction hash is known, the client reads its final chain outcome. Otherwise it finds the unique board bid matching the signer and all three check, reference and verifier hashes; the board refuses reuse of a check hash. It never selects a bid by check hash alone. Only when these recovery paths fail does it ask for reconciliation. Local tests cover partial and malformed wallet outcomes; live testnet evidence is recorded separately. A posting transaction with an unknown outcome is reconciled, not automatically repeated.
2. **Review and challenge.** The browser or client sends the exact check and reference to the relay; their committed hashes authenticate those texts. The bid review can allow or block entry but cannot decide payment. The relay pins the private inputs and requests the planted-fake challenge. See an allowed review and accepted challenge before a worker can claim.
3. **Claim.** A registered worker claims an eligible bid. The board assigns that worker in the existing escrow job. The payment is already held; the buyer does not create, link or fund another job for that worker.
4. **Deliver and verify.** The assigned worker commits its delivery hash and hands over exactly those bytes, authenticated by a message signature. The browser keeps a local copy so a failed private handoff can be retried with identical text. The relay normally starts verification; the worker can request it when allowed. The job’s prepaid checking budget supplies the OutLayer deposit. The operator still needs NEAR for gas.
5. **Settle.** Only the callback-recorded verdict permits settlement. `Passed` is not yet `Released`: inspect the final payout callback state. A failed or expired attempt is recorded in history and may reopen the job for another worker within its limits. A closed job returns remaining payment and budget to the buyer. The keeper syncs bid and attempt-fee state.
6. **Collect.** Once the job is `Released`, its buyer signs a collection message. Refunded work is not released to the buyer through Proven. The collected-work block offers an exact `.json` or `.txt` file only after its SHA-256 matches the delivery hash. Copy also uses the original text. Pretty view and the Markdown receipt are presentation copies; neither is the byte-exact artifact proved by that hash. The work is always displayed as untrusted text.

The board tools are `post_bid`, `register_agent`, `claim_bid`, `bid_status`, `list_bids`, `list_agents`, `sync_bid`, `close_bid` and `buyer_record`. See their schemas through the CLI or MCP server. The owner-approved local custody template permits up to 6 NEAR per transaction and 12 NEAR per day, covering a 5 NEAR job plus prepaid posting costs. These are wallet ceilings, separate from the escrow caps. Existing stored wallets retain their previous limits until an owner-approved policy update is applied; a wallet still capped at 0.1 NEAR cannot post the full prepaid bid. Raising the local template does not establish that agent-buyer posting has been verified on mainnet. Listed human buyers can post through their own wallets. Configure custody and scoped signing access only after the owner’s approval; a policy must permit the full board posting deposit, not merely the advertised payment. Credentials belong in the private environment, never in a prompt, tool argument or URL.

The former per-worker create/link/fund/settle demo is retired and refuses before loading keys or signing. Historical examples and benchmark results remain evidence of that old flow. They are not commands to run against the current contracts. Hosted agents and any scripted delivery must be labelled as such; a script is not a model-driven worker or an independent outside user.

## Storage return, records and administration

A completed job does not need to retain its largest allocated storage forever. Anyone may call escrow `finish_storage(job_id)` once the job is `Released` with its budget returned, or `Refunded`. The contract returns the buyer’s recorded storage payment minus the measured remainder. Evidence stays on chain.

Board `finish_bid(bid_id)` applies to `Done`, `Closed` or `Cancelled` bids with no attempt fee still `Held` or `Paying`. It keeps hashes, outcome, review and attempts, shortens the description to its title, removes the full format text and returns the unused recorded storage and posting reserve. The original brief and format remain in the posting transaction arguments. The refund cannot exceed the recorded payment or be paid twice. A failed transfer remains retriable. The relay sweeps unfinished ended bids and requests both returns. Historical jobs whose board records were finished before escrow storage was returned still need a separate recovery call.

Bids from before this upgrade recorded no refundable board storage and therefore return none. The remainder needed for evidence and the check-reuse entry stays deposited. Each attempt also uses a 0.002 NEAR record deposit that is not returned; it is separate from the 0.015 NEAR attempt fee.

The board’s `get_agent_record(wallet)` counts paid, failed, format-failed, no-delivery and no-verdict attempts once per settled attempt. This is a chain record, not proof of a unique person or independent useful work. More accounts can evade per-account limits, and a buyer can pay its own second account.

Both contracts use two-step ownership: the current owner proposes a new owner and that account accepts. The board owner can change the reviewer and the buyer list with `set_market_open`, `add_buyers` and `remove_buyers`. These are administrative writes, not part of the read-only checks above. The current deploy key is still a single key; two-step ownership is not a deployed multisig or an upgrade delay.

The board emits NEP-297 logs with prefix `EVENT_JSON:`, standard `proven-board` and version `1.0.0`. Events cover posting, review, registration, claiming, assignment, attempt settlement, fees, ending and finishing bids, reviewer/access changes and owner handover. Read receipt logs for a board action and parse the JSON after that prefix; do not infer a confirmed payment solely from an event or a pending promise. No new mainnet job or complete event sequence on the latest storage upgrade is claimed below.

## Evidence recorded through November 7

The upgrade and cap-setting transactions for the **unaudited, owner-funded mainnet deployment** are public:

| Action                               | Transaction                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Escrow code and migration            | [BzfNXWB45TcLBfZ5DgTZLDPqLiWF6uNFzr5aJDGPczVc](https://nearblocks.io/txns/BzfNXWB45TcLBfZ5DgTZLDPqLiWF6uNFzr5aJDGPczVc) |
| Board code and migration             | [13BVhgMXEUc5tsczERdpDJ5egPAQ5XZR1k22zi6Hsk5P](https://nearblocks.io/txns/13BVhgMXEUc5tsczERdpDJ5egPAQ5XZR1k22zi6Hsk5P) |
| Caps set to observed 5 / 10 / 5 NEAR | [7cGrNY9yXQck5Ep7KaURzaUT9yWjMWVjZyz1MUdtTvc5](https://nearblocks.io/txns/7cGrNY9yXQck5Ep7KaURzaUT9yWjMWVjZyz1MUdtTvc5) |
| Unpaused                             | [F9x2yTGXc7RgxGaeZZ54eFhWbSMeGucHFAHWd3zU7HYE](https://nearblocks.io/txns/F9x2yTGXc7RgxGaeZZ54eFhWbSMeGucHFAHWd3zU7HYE) |

Readback recorded matching tested code hashes, paused false, held zero, the two listed buyers, and old job/bid records preserved. **No new mainnet job has run on this latest upgrade.** Old bids 0 and 1 had not yet been synced into the new agent records at the recorded checkpoint. No new transaction was sent for this README.

Earlier evidence from the **unaudited, owner-funded mainnet deployment**, before the storage upgrade:

| Record                      | What was observed                                                                         | Evidence                                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct job 0                | Real model delivery, 13 of 13 planted fakes caught, paid                                  | [challenge 2849](https://api.outlayer.ai/attestations/by-request/2849), [verdict 2850](https://api.outlayer.ai/attestations/by-request/2850), [release EN12aW3U5p1ZN3AULFj9tNHc7P5UKipyzyb1fRJsYpss](https://nearblocks.io/txns/EN12aW3U5p1ZN3AULFj9tNHc7P5UKipyzyb1fRJsYpss) |
| Direct job 1                | Scripted wrong delivery, failed `reconcile`, refunded                                     | [challenge 2851](https://api.outlayer.ai/attestations/by-request/2851), [verdict 2852](https://api.outlayer.ai/attestations/by-request/2852), [refund 6bYMFE5Wzi2oXiB5qDCm2j3CLynCnJs3sqjk9xyLUZKk](https://nearblocks.io/txns/6bYMFE5Wzi2oXiB5qDCm2j3CLynCnJs3sqjk9xyLUZKk)  |
| Bid 0 / job 3               | Owner’s buyer and worker accounts; 13 of 13, passed, `Released`                           | [challenge 2860](https://api.outlayer.ai/attestations/by-request/2860), [verdict 2861](https://api.outlayer.ai/attestations/by-request/2861); read `get_bid(0)` and `get_job(3)` above                                                                                        |
| One-signature bid 1 / job 4 | One posting transaction, accepted challenge; still waiting for a worker at the checkpoint | [challenge 2862](https://api.outlayer.ai/attestations/by-request/2862); no delivery verdict or payout is claimed                                                                                                                                                              |

These runs were operated by the owner. They do not show an outsider using the system. The relay’s `audit` checked attestation hash bindings for jobs 3’s challenge and verdict; that is not an Intel signature-chain verification.

The latest upgraded testnet gate used bid 18: challenge caught 13 of 13 ([request 12191](https://testnet-api.outlayer.ai/attestations/by-request/12191)); a scripted wrong delivery failed format ([12192](https://testnet-api.outlayer.ai/attestations/by-request/12192)); a second scripted delivery passed ([12193](https://testnet-api.outlayer.ai/attestations/by-request/12193)). The keeper paid, returned the budget and synced the bid. Bid 19 closed and refunded. The recorded agent results were one format failure and one paid attempt.

Testnet storage observations: bid 19 returned 0.0297 NEAR from the board and 0.0072 from escrow through the keeper. Bid 18 returned 0.0293 from the board; its job returned 0.0042 after a keeper-ordering bug was fixed and the job was finished by hand. These are observed amounts for those records, not a promised refund rate. Recorded upgrade tests passed 101 escrow unit tests and 25 escrow sandbox tests, plus 38 board unit tests and 17 board sandbox tests. They include upgrading copies of the actual recorded state and settling three fees in one sync.

Historical November 6 scripted testnet jobs 35 and 36 used the older workflow. Job 35 paid exactly 0.01 testnet NEAR ([verdict 10067](https://testnet-api.outlayer.ai/attestations/by-request/10067), [release uqZECbkFgNCTGchXMVbwHEZG7wsSqezYu3dscmSccbX](https://testnet.nearblocks.io/txns/uqZECbkFgNCTGchXMVbwHEZG7wsSqezYu3dscmSccbX)); job 36 refunded exactly 0.01 ([verdict 10068](https://testnet-api.outlayer.ai/attestations/by-request/10068), [refund 2SupqXas9p4BPW2JcEaN1RU2XpgamuJMaTh3DvfFVogb](https://testnet.nearblocks.io/txns/2SupqXas9p4BPW2JcEaN1RU2XpgamuJMaTh3DvfFVogb)). The older fresh scripted command measured 117.87 seconds externally for jobs 33 and 34; that is not a current-flow benchmark or a timing guarantee. The legacy launcher is retired.

## Verdict and privacy trust

Only an output from escrow’s own OutLayer promise callback can record a verdict. It must match the escrow, job, check, format and deliverable commitments. A promise failure, timeout, malformed or oversized result, verifier error or binding mismatch is no verdict. The attempt can be retried within its time and budget limits; a missing verdict never becomes a pass. A payout is confirmed by its final transfer callback state, not by a model’s claims.

Remaining trust includes OutLayer’s contract and operator, registered worker keys and approved measurements. **A per-call quote is not verified on chain.** The escrow requests the committed WASM URL/hash, while the worker enforces which bytes execute; the escrow cannot independently observe the executed code hash. The request ID is reported by the run and is a lookup key, not an independently authenticated on-chain attestation proof.

OutLayer’s keystore and public-key API, the verifier host’s availability, the relay’s handling of private text and the contract upgrade keys are also trusted. The relay can read or withhold private checks, references and deliveries, but it cannot post a verdict. Changed text is rejected by the verifier’s hash checks. Low-entropy text can be guessed from public hashes, and ciphertext length, counts and failed-rule identifiers reveal metadata.

A worker can be unpaid after an availability failure. A buyer can write an unfair check using published fields, and there is no dispute process. A well-formed delivery that fails a real rule can earn the attempt fee; a format failure does not. Multiple accounts can exhaust attempts or inflate buyer/worker records. Payouts to a deleted account can remain retriable without redirection. These limits remain despite the unaudited, owner-funded mainnet deployment’s caps.

The site and relay hash-binding audit do not verify Intel signatures or NEAR light-client proofs. Independent command-line checks were recorded for these 13 historical testnet request IDs only: 8700, 9345, 9430, 9452, 9455, 9557, 9556, 9632, 9631, 9699, 9701, 10067 and 10068. They used source-built `outlayer-verify` v0.1.0 at revision `90c27d9d`. Do not apply those results to a new request, current mainnet run, private input handling or reproducible build.

To repeat one recorded testnet verification with no keys or funds, use the explicit API URL because that tool revision’s default was retired:

```sh
outlayer-verify tx AfaFhms3qDvef2HXttdvwkc328oAuyBu8XEsxETJ2zij --network testnet --api https://testnet-api.outlayer.ai --rpc https://test.rpc.fastnear.com --archival-rpc https://archival-rpc.testnet.near.org --bundle /tmp/proven-8700.bundle.json --no-color
outlayer-verify bundle /tmp/proven-8700.bundle.json --offline --short --no-color
```

See an exit status and explicit signature, measurement and execution-binding results from the verifier. Opening an OutLayer page alone is not an independent check.

## Local checks and pages

The tests below use local mocks and sandboxed HTTP servers; they do not authorise live services or transactions.

```sh
(cd relay && npm ci && npm test && npm run typecheck)
(cd web && npm ci && npm test && npm run typecheck && npm run format:check && npm run build)
(cd agent && npm ci && npm run build:skills && npm test && npx tsc --noEmit -p .)
```

See passing test summaries, a clean typecheck and the self-hosted browser bundles. `npm run build:skills` needs Rust with the `wasm32-unknown-unknown` target. It builds `skills/function/`, which hosted agents' `wat_compile` and `run_function` skills use: a WebAssembly module with no imports that compiles WebAssembly text exactly as `proven wat` does, and tries a function by the verifier's loading and fuel rules. Without it those tests are skipped, and the hosted service refuses both skills without charging. Build it before copying the source to a server. A try with `run_function` decides nothing; only the verifier's check run does. For contract test reproduction, use the Rust toolchain and the build/test commands in the repository’s contract packages; the counts above are historical recorded results, not checks rerun by this documentation task.

Run `cd web && npm start` and open `http://127.0.0.1:4173`. The local server defaults to testnet preparation; it does not turn a checkout into a public mainnet service. Public reads and ordinary presentation need no keys. The unaudited, owner-funded mainnet deployment at useproven.xyz uses its separately configured server. The server’s startup log names its configured network. Stop the local server with Ctrl-C.

Routes: `/` is the landing page, `/app` is Overview, `/app/market` lists bids, `/app/jobs` filters the connected account’s work, `/app/post` is the posting form, and `/app/bids/<bid_id>` is a job workspace. `/guide`, `/trust` and `/about` explain operation and limits. `/examples` and `/evidence` contain labelled historical testnet records; they are not a route into the preparation app and cannot start the retired demo.

The wallet picker uses `@hot-labs/near-connect` 0.12.0. Connecting adds no function-call key. Signing names the chosen network and account. Its SDK, runtime manifest and fetched/cached wallet executor code remain trusted dependencies; an npm version pin does not pin those executors. Before wallet calls, the app checks current bid state and journals an unresolved action. Cooperating tabs use browser locks. These guards do not coordinate separate browsers/devices or replace contract checks; an unknown outcome must be reconciled rather than blindly resent.

Hosted agents were tested on preparation infrastructure with owner-operated accounts. Inference is billed to the operator in USD credits, not paid to NEAR AI in NEAR. Funding buys a labelled accounting budget, and key, per-agent, per-job and project limits apply. A paid escrow job can allocate its earnings to inference once. A failed job has no escrow earnings allocation. A separate board attempt fee, when paid, can still increase the wallet’s available inference budget. Skills cannot change the chain’s payee, amount or verdict. No outside user, real wallet integration across all supported wallets, or hosted-agent run on the latest unaudited, owner-funded mainnet deployment is claimed here. Hosted service availability and signing setup are separate operational approvals.

The local hosted-service dry run lists the selected network, data directory and write categories before loading credentials. The [hosted-agent readiness checklist](docs/hosted-mainnet-readiness.md) records configuration, funding targets and the release gates. The owner-reported NEAR AI credit snapshot estimates remaining credit from local spending. The job page verifies newly saved public bid-review reasons against the board's response fingerprint.

The relay health warning for proven-relay.near is intended to fire below 0.25 NEAR because starting a run can reserve about 0.2 NEAR of gas. A single threshold is not a guarantee that concurrent operations have enough balance. Operators must review alerts and unknown transaction outcomes; this README does not authorise a top-up.

## Cross-chain preview

Cross-chain payout is not integrated with escrow settlement. The worker is paid on NEAR. The `agent` settlement adapter can request a dry quote and read an existing deposit’s status, without signing or sending funds. A `REFUNDED` API report is not independent confirmation of a refund; `FAILED` does not prove one either.

After installing agent dependencies, run the following preview from `agent/`. See `mode: "dry_quote"` and `execution_enabled: false`. The addresses are placeholders for the dry preview; this requests no deposit address.

```sh
npm run --silent settlement -- quote '{"origin_asset":"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","destination_asset":"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near","amount":"1000000","refund_to":"0000000000000000000000000000000000000000000000000000000000000000","recipient":"0x1111111111111111111111111111111111111111"}'
```

The preview trusts the 1Click HTTPS API for estimates. It proves neither settlement on either chain nor a Proven verdict. A later worker transfer is a separate action, not escrow’s cross-chain settlement.

## Source layout and licenses

`contracts/escrow/` and `contracts/board/` hold the NEAR contracts; `contracts/mock-outlayer/` and `contracts/test-token/` are test doubles. `verifier/` holds the bounded check runner. `relay/` pins private inputs and handles contract-authorised maintenance. `agent/` contains the CLI, MCP and hosted service. `web/` contains the pages and browser presentation. `shared/` contains the posting-receipt protocol validation used by the agent and web clients. `examples/` contains fictional input data.

Proven is MIT; see `LICENSE`. Adapted React Bits components retain their MIT plus Commons Clause terms. React, Motion, NEAR Connect and related notices are in [web/THIRD_PARTY_NOTICES.md](web/THIRD_PARTY_NOTICES.md) and the built `/third-party-notices.txt` asset. Reviso and Confam are visual references only; their source, logos and product results are not bundled.
