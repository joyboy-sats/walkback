/**
 * Token-bucket rate limiter.
 *
 * The live delegate limit is 60 weighted requests per minute. A status poll
 * counts. `rememberAndWait` at a 1s poll is ~25 weighted calls for one ~24s
 * write, and the seed process does not share this bucket with the worker, so
 * the two of them trip 429 together. Each process therefore spends at most
 * half of that budget, and one write is charged for the accept plus the
 * polls a 5s interval makes over ~24s.
 */

/** Relayer budget observed in production: `delegate_key limit 60 weighted-requests/min`. */
export const MEMWAL_WEIGHTED_LIMIT_PER_MIN = 60;

/**
 * One accept plus about five status reads. Polling faster than this re-trips
 * the minute window; the SDK's own comment says a short retry after
 * `retry_after_seconds: 60` does the same, because those reads count.
 */
export const REMEMBER_WRITE_WEIGHT = 6;

/** Half the server budget, so a seed and a worker can write at the same time. */
export const MEMWAL_WRITE_PROCESS_BUDGET = MEMWAL_WEIGHTED_LIMIT_PER_MIN / 2;

/** Status interval passed to `rememberAndWait`. Five seconds, not one. */
export const REMEMBER_POLL_INTERVAL_MS = 5_000;

/**
 * Floor for a 429. The relayer's `retry_after_seconds` is honored when it is
 * longer. A shorter wait starts another poll storm inside the same minute.
 */
export const RATE_LIMIT_FLOOR_MS = 60_000;

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

  /** Refill to full. Tests call this so a weight charge does not stall the next case. */
  fill(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
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
 * walk uses `memwalReadLimiter`. Reads are a separate published budget.
 * Writes, including status polls, share the 60 weighted-request minute.
 */
export const memwalWriteLimiter = new RateLimiter({
  capacity: MEMWAL_WRITE_PROCESS_BUDGET,
  windowMs: 60_000,
});

export const memwalReadLimiter = new RateLimiter({
  capacity: 30,
  windowMs: 60_000,
});
