# Hosting the market on boxd (testnet)

The market and relay run on one boxd machine, `proven`, with 1 vCPU and 4 GB. The files are in `deploy/boxd/`. Opening the site to the public needs the owner's yes.

**What the server holds.** `node deploy/boxd/make-env.mjs` writes two short env files. `.relay.env`, for the relay only, holds the key of `relay.proven.testnet`, a small account of its own that pins private inputs. `.env`, for the web server and its review step, holds a reviewer key that can only call `record_review` on the board and a NEAR AI review key. There is no buyer, worker, custody, mainnet or escrow owner key. The server can read private checks, references and deliveries, as any relay operator can, but it has no way to post a verdict.

**Known limits of this setup.** Both services run as one user, so a compromise of the web process could read the relay key and the private texts. That is acceptable for testnet and must change before real users. Anyone can use up the review credit: the spend is capped, and once the cap is reached reviews stop for everyone and new bids stay closed, with no money at risk. Each pin locks about 0.07 NEAR of the relay's own until its run ends or an hour passes, so many accounts pinning at once can stop new pins for a while. The deposits come back.

**Install.** Unpack a `git archive` of the commit into `~/proven`, copy `runs/private/boxd.env` there as `.env` and `runs/private/boxd-relay.env` as `.relay.env`, and run `bash deploy/boxd/setup.sh`. The two systemd services then answer on `127.0.0.1:4173` only, and the public address stays closed.

**Standby.** The machine sleeps after 10 minutes without an incoming connection (`--auto-suspend-timeout=600 --idle-ignore-outbound`), and hibernation is off. Outgoing traffic must not count as activity, or the relay's five-minute sweep would keep it awake forever. While it sleeps nothing runs, so finished private inputs are cleaned up only when it next wakes, and a sweep runs within five minutes of waking.

**Before opening, and again after.** Check that port 4173 cannot be reached directly on the machine's public address, and what the boxd proxy sends in `X-Forwarded-For`, because the per-client write limit depends on it. A global write limit holds either way.

**Open.** These steps need the owner's yes each time:

```bash
boxd machine exec proven -- sh -c 'echo PROVEN_WEB_FLAGS=--public > ~/proven/.web-flags && sudo systemctl restart proven-web'
boxd machine proxy set-port --vm proven --port 4173
boxd machine config set proven bot-protection off
```

Bot protection must be off on the default address because its browser check would stop agents and command-line callers. A custom domain is never checked, so with one, bot protection can stay on for the default address. For a custom domain, also set `PROVEN_ORIGIN` in `~/proven/.web-flags`. The server accepts one exact origin.

**Close.** Remove `.web-flags`, restart `proven-web`, and the server answers on localhost only again.

# Older demo hosting notes

This is a preparation checklist, not a deployed service. Publication, service registration, spend and transferring credentials to a host require the owner's approval. The local browser trigger passed a fresh live testnet check on November 6 (jobs 35/36); the hosted environment remains untested.

The current implementation needs one Node host that can run long-lived processes, spawn the existing fixed agent CLI and maintain an owner-only Unix socket. A static-only host cannot run this demo. The host must retain private state and the operator's reconciliation records across restarts. No startup script should create or reset a demo allowance.

Run the web process as an unprivileged dedicated user, from a private checkout with Node 22.18 or later and the locked `web`, `agent` and `relay` dependencies installed. Keep the project `.env` owner-readable only, separate from the public web directory and deployment archive. The browser receives no keys. The agent buyer uses the existing restricted custody credential, the workers use their existing scoped keys, and the separate broker uses its operator signer. A host receiving those credentials becomes part of the trusted backend for availability, privacy and sponsored transactions; it does not gain an escrow verdict method.

The web process always listens on `127.0.0.1:4173`. An approved HTTPS reverse proxy must preserve the original Host and Origin headers. Configure one exact public origin with `npm start -- --demo --origin=https://APPROVED_HOST`. Replace the placeholder only after choosing and approving the host. The app rejects other hosts and origins and does not trust forwarded headers as an access bypass. Do not rewrite every incoming Origin to the approved origin. Restrict the Node port and private broker socket from public ingress. Use request/body limits and rate limits at the proxy; POST accepts only the fixed empty JSON object and no query parameters.

Start the reviewed private operator broker separately, with Fastnear reads and Intear broadcasts, using the README's split RPC command. It permits four fixed compute attempts for exactly two jobs. Confirm the existing reserves before enabling a run: operator at least 0.5 testnet NEAR and custody at least 0.15. Funding above the owner's current cap needs a separate explicit approval.

The owner prepares a single allowance with `cd web && npm run demo:arm`. This creates an owner-only local grant; it does not send a transaction. `npm start -- --demo` reads that grant. The first accepted Start consumes a separate exclusive marker and syncs the file and directory before launching the fixed CLI. No public reset exists. A second click, another server process or a restart cannot use that allowance again. Missing grant storage disables Start. Keep grants and consumed markers out of deployment bundles and images. If a host loses private state, it must stay disabled until the operator reconciles all prior evidence and explicitly approves a new allowance.

After an uncertain run, stop admitting further runs and inspect `runs/p6-demo-*.json`, `runs/private/demo-sponsor-*.json`, signed hashes and custody history. Never remove locks, reset markers, rearm the broker or replay a creation just to get a clean page. Terminal jobs and successful secret deletions must be checked before an operator-approved new session. The existing CLI resume is an operator action and is not exposed to the browser.

Before publication, verify the fresh browser run, exact payouts, four secret deletions, cross-origin refusal, concurrent-click refusal, restart refusal, HTTPS proxy configuration and a separate reviewer pass. Record the approved hostname, provider/account, price cap, credential destination and keep-alive plan through November 18 in the private task log. No public hosting, signup, credential upload, mainnet action or push is authorized by this document.
