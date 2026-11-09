interface ReviewSummary {
  decision: "Allowed" | "Blocked" | "Not recorded";
  fingerprint: string | null;
  model: string | null;
}

/** Only fields the board actually records are evidence. Extra model prose is not a chain reason. */
export function reviewSummary(value: unknown): ReviewSummary {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("allow" in value) ||
    typeof value.allow !== "boolean"
  )
    return { decision: "Not recorded", fingerprint: null, model: null };
  return {
    decision: value.allow ? "Allowed" : "Blocked",
    fingerprint:
      "review_hash" in value &&
      typeof value.review_hash === "string" &&
      /^[a-f0-9]{64}$/.test(value.review_hash)
        ? value.review_hash
        : null,
    model:
      "model" in value && typeof value.model === "string" ? value.model : null,
  };
}

export function BidReview({
  review,
  reason,
}: {
  review: unknown;
  reason?: string | null;
}) {
  const recorded = reviewSummary(review);
  return (
    <details className="job-review">
      <summary>AI bid review: {recorded.decision}</summary>
      <p>
        This review controls admission only. A model never decides payment; the
        executable check determines the verification result.
      </p>
      {recorded.decision === "Not recorded" ? (
        <p>No AI bid review decision is recorded on the chain yet.</p>
      ) : (
        <>
          <p>
            {reason
              ? `Reason (response fingerprint checked against the chain): ${reason}`
              : "The chain records the decision and fingerprint; the review reason is not available for this recorded response."}
          </p>
          <p>Model: {recorded.model ?? "Not recorded"}.</p>
          <p>
            Review fingerprint:{" "}
            <code>{recorded.fingerprint ?? "Not recorded"}</code>
          </p>
        </>
      )}
    </details>
  );
}
