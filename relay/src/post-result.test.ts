import assert from "node:assert/strict";
import test from "node:test";
import { postedBidFromOutcome } from "./post-result.ts";
const board = "proven-board.near",
  buyer = "buyer.near";
function outcome(id: unknown = 150) {
  return {
    transaction: {
      receiver_id: board,
      signer_id: buyer,
      actions: [{ FunctionCall: { method_name: "post_bid" } }],
    },
    status: { SuccessValue: "dHJ1ZQ==" },
    receipts_outcome: [
      {
        outcome: {
          executor_id: board,
          status: { SuccessReceiptId: "receipt" },
          logs: [
            "EVENT_JSON:" +
              JSON.stringify({
                standard: "proven-board",
                version: "1.0.0",
                event: "bid_posted",
                data: [{ bid_id: id, buyer }],
              }),
          ],
        },
      },
    ],
  };
}
test("created ID comes from the successful board-authored posting event, not the callback bool", () => {
  for (const id of [0, 150])
    assert.equal(postedBidFromOutcome(outcome(id), board, buyer), id);
  assert.equal(
    postedBidFromOutcome({ ...outcome(), receipts_outcome: [] }, board, buyer),
    null,
  );
});
test("unrelated, failed, malformed and ambiguous receipts never identify a posted bid", () => {
  const missing = outcome();
  missing.receipts_outcome[0]!.outcome.logs = ["EVENT_JSON:{bad"];
  const foreign = outcome();
  foreign.receipts_outcome[0]!.outcome.executor_id = "stranger.near";
  const wrongMethod = outcome();
  wrongMethod.transaction.actions[0]!.FunctionCall.method_name = "other";
  const double = outcome();
  double.receipts_outcome.push(double.receipts_outcome[0]!);
  for (const value of [
    null,
    {},
    missing,
    foreign,
    wrongMethod,
    double,
    outcome(-1),
    outcome(true),
    { ...outcome(), status: { SuccessValue: "ZmFsc2U=" } },
    { ...outcome(), status: { Failure: {} } },
  ])
    assert.equal(postedBidFromOutcome(value, board, buyer), null);
  assert.equal(postedBidFromOutcome(outcome(), board, "other.near"), null);
  assert.equal(postedBidFromOutcome(outcome(), "other.near", buyer), null);
});
