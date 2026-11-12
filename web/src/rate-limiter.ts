/** A fixed number of writes per client per minute. Reads are shared through the cache above. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(client: string, now = Date.now()): boolean {
    const recent = (this.hits.get(client) ?? []).filter(
      (at) => now - at < this.windowMs,
    );
    if (recent.length >= this.limit) {
      this.hits.set(client, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(client);
    this.hits.set(client, recent);
    // Full: forget the longest-quiet client, never everyone's counts at once.
    if (this.hits.size > 10_000)
      this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}
