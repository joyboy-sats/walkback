import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeadlineError,
  isDeadlineError,
  isIdempotencyConflict,
  isRateLimited,
  isRetryableError,
  retryAfterSeconds,
  withDeadline,
  withFetchDeadline,
  withRetry,
} from "./bounded";

afterEach(() => {
  vi.useRealTimers();
});

describe("withDeadline", () => {
  it("rejects a call that never settles and does not leave a timer", async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise(() => {}), 500, "close database pool");
    const settled = pending.then(
      () => "resolved" as const,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;
    expect(err).toBeInstanceOf(DeadlineError);
    expect((err as DeadlineError).message).toBe("close database pool timed out after 500ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the value and clears the timer", async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(7), 500, "close database pool")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withFetchDeadline", () => {
  it("aborts the in-flight fetch and restores the previous fetch", async () => {
    vi.useFakeTimers();
    const realFetch = globalThis.fetch;
    let signal: AbortSignal | null | undefined;
    const hanging = vi.fn((_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    globalThis.fetch = hanging as typeof fetch;
    try {
      const pending = withFetchDeadline(() => fetch("https://example.test/remember"), 1_000, "remember");
      const settled = pending.then(
        () => "resolved" as const,
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const err = await settled;
      expect(err).toBeInstanceOf(DeadlineError);
      expect(signal?.aborted).toBe(true);
      expect(globalThis.fetch).toBe(hanging);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("withRetry", () => {
  it("retries a deadline with exponential backoff and then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new DeadlineError("MemWal remember claim:1", 10);
        return "blob-1";
      },
      {
        attempts: 3,
        backoffMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(value).toBe("blob-1");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry a 400 and stops after the configured attempts on a 503", async () => {
    let rejected = 0;
    await expect(
      withRetry(
        async () => {
          rejected += 1;
          throw Object.assign(new Error("bad input"), { status: 400 });
        },
        { attempts: 3, backoffMs: 50, sleep: async () => {} },
      ),
    ).rejects.toThrow(/bad input/);
    expect(rejected).toBe(1);

    let server = 0;
    await expect(
      withRetry(
        async () => {
          server += 1;
          throw Object.assign(new Error("unavailable"), { status: 503 });
        },
        { attempts: 3, backoffMs: 10, sleep: async () => {} },
      ),
    ).rejects.toThrow(/unavailable/);
    expect(server).toBe(3);
  });
});

describe("rate limit and idempotency errors", () => {
  const rateLimited = Object.assign(
    new Error('Walrus Memory server error (429): {"error":"delegate_key limit","retry_after_seconds":60}'),
    { status: 429, cause: '{"retry_after_seconds":60}' },
  );

  it("reads retry_after_seconds from the body and treats 409 idempotency conflicts as final", () => {
    expect(isRateLimited(rateLimited)).toBe(true);
    expect(retryAfterSeconds(rateLimited)).toBe(60);
    expect(isRetryableError(rateLimited)).toBe(true);
    const conflict = Object.assign(
      new Error(
        'Walrus Memory server error (409): {"error":"idempotency_key was already used for a request with different content"}',
      ),
      { status: 409 },
    );
    expect(isIdempotencyConflict(conflict)).toBe(true);
    expect(isRetryableError(conflict)).toBe(false);
    expect(isIdempotencyConflict(rateLimited)).toBe(false);
  });

  it("waits out a 429 instead of the short backoff curve", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw rateLimited;
        return "ok";
      },
      {
        attempts: 2,
        backoffMs: 2_000,
        delayFor: () => 60_000,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(calls).toBe(2);
    expect(delays).toEqual([60_000]);
  });
});

describe("isDeadlineError", () => {
  it("walks the cause chain and ignores an ordinary timeout string", () => {
    const wrapped = new Error("memory write stopped", { cause: new DeadlineError("remember", 10) });
    expect(isDeadlineError(wrapped)).toBe(true);
    expect(isDeadlineError(new Error("canceling statement due to statement timeout"))).toBe(false);
    expect(isRetryableError(Object.assign(new Error("rate"), { code: 429 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("rate"), { code: 400 }))).toBe(false);
  });
});
