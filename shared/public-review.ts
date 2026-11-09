// The published reason is accepted only when the exact model response matches the board's fingerprint.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RecordedReview { allow: boolean; review_hash: string; model: string; chat_id: string }
export function publicReviewReason(body: string, review: RecordedReview): string | null {
  if (Buffer.byteLength(body) > 1024 * 1024 || createHash("sha256").update(body).digest("hex") !== review.review_hash) return null;
  try {
    const value = JSON.parse(body);
    if (value.id !== review.chat_id || !Array.isArray(value.choices) || typeof value.choices[0]?.message?.content !== "string") return null;
    const answer = JSON.parse(value.choices[0].message.content);
    if (!answer || typeof answer !== "object" || Array.isArray(answer) || Object.keys(answer).length !== 2 || answer.allow !== review.allow || typeof answer.reason !== "string" || answer.reason.length > 200) return null;
    return answer.reason;
  } catch { return null; }
}
function pathFor(root: string, board: string, bid: number) {
  if (!/^[a-z0-9._-]{2,64}$/.test(board) || !Number.isSafeInteger(bid) || bid < 0) throw new Error("Invalid public review identity.");
  return join(root, board, `${bid}.json`);
}
export function savePublicReview(root: string, board: string, bid: number, body: string, review: RecordedReview) {
  if (publicReviewReason(body, review) === null) throw new Error("The public review does not match its recorded fingerprint.");
  const path = pathFor(root, board, bid);
  mkdirSync(join(root, board), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
}
function isRecordedReview(value: unknown): value is RecordedReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.allow === "boolean" && typeof v.review_hash === "string" && /^[a-f0-9]{64}$/.test(v.review_hash) && typeof v.model === "string" && typeof v.chat_id === "string";
}
export function readPublicReview(root: string, board: string, bid: number, review: unknown): string | null {
  if (!isRecordedReview(review)) return null;
  try {
    const path = pathFor(root, board, bid);
    if (statSync(path).size > 1024 * 1024) return null;
    return publicReviewReason(readFileSync(path, "utf8"), review);
  } catch { return null; }
}
