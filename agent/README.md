# Proven agent interface

Run `npm run proven -- list_bids '{}'` to read the configured board. The result is public board data; it does not create a job or move funds.

Current board jobs use the one-signature flow. The buyer posts a bid once with `post_bid`, which fixes the check, reference and public format and prepays the job payment, compute budget, attempt fees and storage. After review and the check challenge allow the bid, a registered worker claims it and delivers. The relay requests verification and advances settlement only as the recorded chain state permits. The executable tool schemas describe the current arguments.

## Historical scripted demos

The earlier `npm run demo` flow was scripted, not a model-driven agent. It created and funded separate per-worker jobs and is retired. Running it with no flags, `--dry-run`, `--resume` or `--operator-compute` exits with an explanatory error before configuration, keys, private evidence or service clients are loaded. It sends no transaction.

The obsolete hosted end-to-end, outside-agent, per-worker agent-job, MCP agent-test and Stage 2 job scripts have been removed because they depended on the old claim/link/fund sequence. Their old recorded results remain historical evidence and are not evidence that those commands work with the current contracts.

The one-signature gate script is a separately controlled testnet test, not a replacement public demo and not an outsider run. Running a funded gate or a mainnet operation still needs the owner's applicable approval. Do not use an old demo resume file to start a new job.
