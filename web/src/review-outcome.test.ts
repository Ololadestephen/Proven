import assert from "node:assert/strict";
import test from "node:test";
import { reviewOutcome } from "./market.ts";
import { ReadError } from "./model.ts";

const failed = () =>
  Promise.reject(
    new ReadError(
      "We couldn’t finish the bid review. Check the bid status before trying again.",
      502,
    ),
  );

test("a review that landed on chain is reported as recorded, even if its command failed", async () => {
  const reply = await reviewOutcome(3, failed(), async () => ({
    state: "Open",
  }));
  assert.deepEqual(reply, {
    bid_id: 3,
    recorded: true,
    state: "Open",
    confirmed_from_chain: true,
  });
  const blocked = await reviewOutcome(4, failed(), async () => ({
    state: "Blocked",
  }));
  assert.equal((blocked as { state: string }).state, "Blocked");
});

test("a bid still waiting for review, a missing bid or an unreadable board keeps the error", async () => {
  for (const readBid of [
    async () => ({ state: "Unreviewed" }),
    async () => null,
    async () => {
      throw new Error("rate limited");
    },
  ])
    await assert.rejects(
      reviewOutcome(3, failed(), readBid),
      /couldn’t finish/,
    );
});

test("a successful command is passed through without reading the chain", async () => {
  let reads = 0;
  const reply = await reviewOutcome(
    3,
    Promise.resolve({ recorded: true, state: "Open" }),
    async () => {
      reads++;
      return null;
    },
  );
  assert.deepEqual(reply, { recorded: true, state: "Open" });
  assert.equal(reads, 0);
});
