import { parseJob } from "../src/model.ts";

export function fixture(state = "Delivered") {
  return parseJob({
    buyer: "buyer.testnet",
    worker: "worker.testnet",
    token: null,
    amount: "10000000000000000000000",
    state,
    deadline: "1000000000000",
    verdict_window_secs: 1800,
    attempt: 1,
    run_started_at: null,
    delivered_at: "1000000000000",
    spec_hash: "a".repeat(64),
    fakes_hash: "b".repeat(64),
    verifier_hash: "c".repeat(64),
    secrets_owner: "relay.testnet",
    deliverable_hash: "d".repeat(64),
    fakes_total: 13,
    fakes_caught: 13,
    challenge_request_id: "8814",
    challenge_report_hash: "e".repeat(64),
    verdict_request_id: null,
    report_hash: null,
    failed_rule: null,
  });
}
