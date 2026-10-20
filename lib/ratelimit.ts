/**
 * Token-bucket rate limiter.
 *
 * The Walrus Memory delegate key is limited to 30 points/minute per key. The
 * measured cost of one `rememberAndWait` is ~24s of server time, so a naive
 * loop is not what trips this — parallel bursts are. This keeps concurrent
 * writes inside the budget without serialising more than necessary.
 *
 * Deliberately conservative: 25/min rather than 30, because the relayer counts
 * internal work (embed, encrypt, upload, index) against the same budget and we
 * cannot see that accounting.
 */

export interface RateLimiterOptions {
  /** Tokens added per window. */
  capacity: number;
  /** Window length in ms. */
  windowMs: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly waiting: Array<() => void> = [];

  constructor({ capacity, windowMs }: RateLimiterOptions) {
    if (capacity <= 0) throw new Error("capacity must be positive");
    this.capacity = capacity;
    this.windowMs = windowMs;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.windowMs) * this.capacity;
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefill = now;
    }
  }

  /** ms until at least one token is available. 0 if available now. */
  private waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.capacity) * this.windowMs);
  }

  /**
   * Take `cost` tokens, waiting if necessary. FIFO among concurrent callers so
   * a burst does not starve an earlier request.
   */
  async acquire(cost = 1): Promise<void> {
    if (cost > this.capacity) {
      throw new Error(
        `cost ${cost} exceeds bucket capacity ${this.capacity}; the call can never succeed`,
      );
    }

    // Queue behind anything already waiting, so ordering is fair.
    if (this.waiting.length > 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        this.drain();
        return;
      }
      const ms = this.waitMs();
      await new Promise((r) => setTimeout(r, Math.max(ms, 10)));
    }
  }

  private drain(): void {
    const next = this.waiting.shift();
    if (next) next();
  }

  /** Introspection for tests and the /memory diagnostics panel. */
  snapshot(): { tokens: number; capacity: number; waiting: number } {
    this.refill();
    return {
      tokens: Math.floor(this.tokens),
      capacity: this.capacity,
      waiting: this.waiting.length,
    };
  }
}

/**
 * The one limiter every Walrus Memory write must pass through.
 *
 * A single `recall` or `listNamespaces` call is not gated. Paging the owner
 * inventory and then recalling each product namespace is many calls, so that
 * walk uses `memwalReadLimiter`. The read API has its own budget, separate
 * from the 30/min write budget; 30/min stays under the published example of
 * 60 weighted reads per minute.
 */
export const memwalWriteLimiter = new RateLimiter({
  capacity: 25,
  windowMs: 60_000,
});

export const memwalReadLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
});
