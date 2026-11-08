import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmedPostedBid,
  decodeCallResult,
  postedBidId,
} from "../ui/posting.ts";
import type { MarketBid } from "../ui/market-steps.ts";
const expected = {
  buyer: "buyer.near",
  check_hash: "a".repeat(64),
  reference_hash: "b".repeat(64),
  verifier_hash: "c".repeat(64),
};
const bid = (id: number, buyer = expected.buyer) =>
  ({ id, ...expected, buyer }) as MarketBid;
test("posting uses the confirmed returned ID, including zero and IDs beyond the first page", () => {
  const bids = [bid(1), bid(0), bid(150)];
  for (const id of [0, 150])
    assert.equal(
      confirmedPostedBid(
        bids,
        { transaction_hash: "tx", posted_bid_id: id },
        expected,
      )?.id,
      id,
    );
  assert.equal(
    confirmedPostedBid(
      bids,
      { transaction_hash: "tx", posted_bid_id: 999 },
      expected,
    ),
    null,
  );
});
test("matching hashes never substitute for absent or mismatched posting identity", () => {
  const bids = [bid(1), bid(2, "stranger.near")];
  for (const result of [
    undefined,
    null,
    {},
    -1,
    1.5,
    "01",
    "1x",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(postedBidId(result), null);
    assert.equal(
      confirmedPostedBid(
        bids,
        { transaction_hash: "tx", posted_bid_id: result as number },
        expected,
      ),
      null,
    );
  }
  assert.equal(
    confirmedPostedBid(
      bids,
      { transaction_hash: "tx", posted_bid_id: 2 },
      expected,
    ),
    null,
  );
  assert.equal(
    confirmedPostedBid(
      [{ ...bid(1), reference_hash: "other" }],
      { transaction_hash: "tx", posted_bid_id: 1 },
      expected,
    ),
    null,
  );
  assert.equal(confirmedPostedBid(bids, undefined, expected), null);
});
test("wallet return bytes are decoded without treating malformed bytes as a created bid", () => {
  assert.equal(decodeCallResult(btoa("150")), 150);
  for (const value of [
    null,
    "!not-base64",
    btoa("{bad"),
    btoa(String.fromCharCode(255)),
  ])
    assert.equal(decodeCallResult(value), null);
});
