// Fixed phase names and failure categories only: never record requests, responses or raw errors.
export type Phase =
  | "job_read"
  | "keystore_key"
  | "secret_broadcast"
  | "secret_store"
  | "secret_delete"
  | "compute_sign"
  | "compute_admit"
  | "compute_broadcast";
export interface TimingEvent {
  phase: Phase;
  started_at: string;
  elapsed_ms: number;
  failure?: string;
}
export type TimingSink = (event: TimingEvent) => Promise<void>;
function category(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return (
    message.match(
      /InvalidNonce|NotEnoughBalance|NotEnoughAllowance|Expired|TIMEOUT_ERROR|Timeout|429|500|502|503|fetch failed|Failed to fetch/,
    )?.[0] ?? "unclassified"
  );
}
export async function timed<T>(
  phase: Phase,
  call: () => Promise<T>,
  sink?: TimingSink,
): Promise<T> {
  if (!sink) return call();
  const started_at = new Date().toISOString(),
    start = performance.now();
  let failure: string | undefined;
  try {
    return await call();
  } catch (error) {
    failure = category(error);
    throw error;
  } finally {
    await sink({
      phase,
      started_at,
      elapsed_ms: Math.round(performance.now() - start),
      ...(failure ? { failure } : {}),
    });
  }
}
