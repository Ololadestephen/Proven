import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the rendered component as well as its pure formatter without adding a JSX test runtime.
const built = await build({
  entryPoints: [new URL("../ui/BidReview.tsx", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
});
const module = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
);
const summary = module.reviewSummary as (value: unknown) => {
  decision: string;
  fingerprint: string | null;
  model: string | null;
};
const rendered = (review: unknown) =>
  renderToStaticMarkup(createElement(module.BidReview, { review }));

test("an absent or malformed review is never displayed as an allowed bid", () => {
  for (const value of [null, undefined, {}, [], { allow: "true" }]) {
    assert.equal(summary(value).decision, "Not recorded");
    assert.match(rendered(value), /No AI bid review decision is recorded/);
    assert.doesNotMatch(rendered(value), /AI bid review: Allowed/);
  }
});

test("allowed and blocked admission decisions do not claim a payment result", () => {
  for (const allow of [true, false]) {
    const review = {
      allow,
      review_hash: "a".repeat(64),
      model: "review-model",
    };
    assert.equal(summary(review).decision, allow ? "Allowed" : "Blocked");
    const text = rendered(review);
    assert.match(text, /This review controls admission only/);
    assert.match(text, /A model never decides payment/);
    assert.ok(text.includes("a".repeat(64)));
    assert.match(text, /review-model/);
    assert.doesNotMatch(text, /Paid|Refunded/);
  }
});

test("unpublished prose is not invented as an on-chain reason and model text is escaped", () => {
  const text = rendered({
    allow: false,
    review_hash: "b".repeat(64),
    model: "<script>fake</script>",
    reason: "A reason supplied outside the recorded contract shape",
  });
  assert.match(text, /the review reason is not available/);
  assert.doesNotMatch(text, /A reason supplied outside/);
  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /&lt;script&gt;/);
  assert.equal(
    summary({ allow: true, review_hash: "invalid" }).fingerprint,
    null,
  );
});

test("a fingerprint-checked public reason is displayed as escaped text", () => {
  const text = renderToStaticMarkup(
    createElement(module.BidReview, {
      review: { allow: false, review_hash: "b".repeat(64) },
      reason: "<script>untrusted reason</script>",
    }),
  );
  assert.match(text, /response fingerprint checked/);
  assert.match(text, /&lt;script&gt;/);
  assert.doesNotMatch(text, /<script>/);
});
