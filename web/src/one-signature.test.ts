import assert from "node:assert/strict";
import test from "node:test";
import { startPostingFollowup } from "../ui/posting.ts";
import { sendCheck, requestReview } from "../ui/job-actions.ts";
import type { MarketBid } from "../ui/market-steps.ts";

test("automatic check handoff and review require no buyer transaction or message after posting", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path: String(path), body: JSON.parse(String(options?.body)) });
    return Response.json({ ok: true });
  };
  let signatures = 0;
  const buyer = {
    call: async () => {
      signatures++;
      return { transaction_hash: "posted" };
    },
    signForRelay: async () => {
      assert.fail(
        "automatic post flow must not ask for a buyer message signature",
      );
    },
  };
  await buyer.call();
  const gate = { current: false },
    bid = { id: 0, job_id: 0 } as MarketBid;
  const next = startPostingFollowup(
    gate,
    bid,
    (id) => sendCheck(id, "check", "reference"),
    requestReview,
  )!;
  await Promise.all([next.check, next.review]);
  assert.equal(
    startPostingFollowup(
      gate,
      bid,
      (id) => sendCheck(id, "check", "reference"),
      requestReview,
    ),
    null,
  );
  assert.equal(signatures, 1);
  assert.deepEqual(calls.map((c) => c.path).sort(), [
    "/api/market/relay",
    "/api/market/review/0",
  ]);
  assert.ok(
    calls.every((c) => !("auth" in c.body) && !("signature" in c.body)),
  );
});
