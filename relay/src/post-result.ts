/** Normalize an ID from a confirmed posting event. Content hashes do not identify a transaction. */
export function postedBidId(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9]\d{0,15})$/.test(value))
    value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function matchesPostedBid(
  value: unknown,
  expected: {
    buyer: string;
    check_hash: string;
    reference_hash: string;
    verifier_hash: string;
  },
): boolean {
  if (!value || typeof value !== "object") return false;
  const bid = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, entry]) => bid[key] === entry);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** post_bid resolves to its callback's bool. Its board-authored event carries the created ID. */
export function postedBidFromOutcome(
  value: unknown,
  board: string,
  buyer: string,
): number | null {
  if (!record(value) || !record(value.transaction) || !record(value.status))
    return null;
  const tx = value.transaction;
  if (
    tx.receiver_id !== board ||
    tx.signer_id !== buyer ||
    !Array.isArray(tx.actions) ||
    tx.actions.length !== 1 ||
    !record(tx.actions[0]) ||
    !record(tx.actions[0].FunctionCall) ||
    tx.actions[0].FunctionCall.method_name !== "post_bid" ||
    value.status.SuccessValue !== "dHJ1ZQ==" ||
    !Array.isArray(value.receipts_outcome)
  )
    return null;
  const ids: number[] = [];
  for (const receipt of value.receipts_outcome) {
    if (!record(receipt) || !record(receipt.outcome)) continue;
    const outcome = receipt.outcome;
    if (
      outcome.executor_id !== board ||
      !record(outcome.status) ||
      !(
        "SuccessValue" in outcome.status || "SuccessReceiptId" in outcome.status
      ) ||
      !Array.isArray(outcome.logs)
    )
      continue;
    for (const log of outcome.logs) {
      if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
      let event: unknown;
      try {
        event = JSON.parse(log.slice("EVENT_JSON:".length));
      } catch {
        continue;
      }
      if (
        !record(event) ||
        event.standard !== "proven-board" ||
        event.version !== "1.0.0" ||
        event.event !== "bid_posted" ||
        !Array.isArray(event.data) ||
        event.data.length !== 1
      )
        continue;
      const data: unknown = event.data[0];
      if (!record(data) || data.buyer !== buyer) continue;
      const id = postedBidId(data.bid_id);
      if (id !== null) ids.push(id);
    }
  }
  return ids.length === 1 ? ids[0]! : null;
}
