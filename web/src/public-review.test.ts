import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publicReviewReason,
  savePublicReview,
  readPublicReview,
} from "../../shared/public-review.ts";

test("a published reason must match the exact response committed by the board", (t) => {
  const body = JSON.stringify({
    id: "chat",
    choices: [
      {
        message: {
          content: JSON.stringify({
            allow: false,
            reason: "Unsafe instructions in the brief.",
          }),
        },
      },
    ],
  });
  const review = {
    allow: false,
    model: "model",
    chat_id: "chat",
    review_hash: createHash("sha256").update(body).digest("hex"),
  };
  assert.equal(
    publicReviewReason(body, review),
    "Unsafe instructions in the brief.",
  );
  assert.equal(publicReviewReason(body + " ", review), null);
  assert.equal(publicReviewReason(body, { ...review, allow: true }), null);
  assert.equal(publicReviewReason(body, { ...review, chat_id: "other" }), null);
  const root = mkdtempSync(join(tmpdir(), "proven-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  savePublicReview(root, "board.testnet", 0, body, review);
  assert.equal(
    readPublicReview(root, "board.testnet", 0, review),
    "Unsafe instructions in the brief.",
  );
  assert.equal(readPublicReview(root, "board.near", 0, review), null);
  assert.equal(
    readPublicReview(root, "board.testnet", 0, {
      ...review,
      review_hash: "0".repeat(64),
    }),
    null,
  );
});
