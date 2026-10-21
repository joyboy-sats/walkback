/**
 * Deadlines and retries for calls that would otherwise sit forever.
 *
 * `Promise.race` against a timer is not enough on its own: the loser keeps
 * running, and a late rejection becomes an unhandled rejection. These helpers
 * attach both handlers, ignore the result after the winner, and (for fetch)
 * abort the in-flight request so the socket does not hold the process open.
 */

export class DeadlineError extends Error {
  readonly timeoutMs: number;
  readonly label: string;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "DeadlineError";
    this.timeoutMs = timeoutMs;
    this.label = label;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `err` or a `cause` along the chain is a deadline. */
export function isDeadlineError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof DeadlineError) return true;
    if ("name" in current && (current as { name?: unknown }).name === "DeadlineError") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  if ("status" in err && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  if ("code" in err && typeof (err as { code?: unknown }).code === "number") {
    const code = (err as { code: number }).code;
    if (code >= 400 && code < 600) return code;
  }
  return undefined;
}

/**
 * Transient transport and server failures. A 4xx other than 408/429 is the
 * caller's input and will not succeed on a retry.
 */
export function isRetryableError(err: unknown): boolean {
  if (isDeadlineError(err)) return true;
  const status = httpStatus(err);
  if (status === 0 || status === 408 || status === 429 || status === 504) return true;
  if (status !== undefined && status >= 500) return true;
  if (status !== undefined && status >= 400 && status < 500) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (/timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(err.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Bound `work`. The underlying promise is not cancelled; use
 * `withFetchDeadline` when the work is a fetch that must release its socket.
 */
export function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  assertTimeout(timeoutMs);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DeadlineError(label, timeoutMs));
    }, timeoutMs);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run `work` with a deadline, and abort any `fetch` it starts when the
 * deadline fires.
 *
 * The installed MemWal client builds a SEAL session (`SessionKey.create` →
 * `suiClient.core.getObject`) before it arms the remember-poll deadline, and
 * that read uses global `fetch` with no timeout of its own. Patching `fetch`
 * for the duration of `work` is what makes the deadline actually cancel the
 * socket. The previous `fetch` is restored before this function settles.
 */
export async function withFetchDeadline<T>(work: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  assertTimeout(timeoutMs);
  const controller = new AbortController();
  const previous = globalThis.fetch;
  const patched: typeof fetch = (input, init) => {
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return previous(input, { ...init, signal });
  };
  globalThis.fetch = patched;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new DeadlineError(label, timeoutMs));
      }, timeoutMs);
      work().then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          controller.abort();
          reject(err);
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (globalThis.fetch === patched) globalThis.fetch = previous;
  }
}

export interface RetryInfo {
  /** The attempt that just failed. 1-based. */
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
}

/**
 * Call `work` up to `attempts` times. The delay after attempt 1 is
 * `backoffMs`, then doubles, capped by `maxBackoffMs`.
 */
export async function withRetry<T>(
  work: () => Promise<T>,
  opts: {
    attempts: number;
    backoffMs: number;
    maxBackoffMs?: number;
    isRetryable?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: RetryInfo) => void;
  },
): Promise<T> {
  const attempts = opts.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts must be a positive integer, got ${attempts}`);
  }
  const isRetryable = opts.isRetryable ?? isRetryableError;
  const sleep = opts.sleep ?? delay;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (err) {
      last = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      const delayMs = Math.min(maxBackoffMs, opts.backoffMs * 2 ** (attempt - 1));
      opts.onRetry?.({ attempt, attempts, delayMs, error: err });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw last;
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeout must be a positive finite number, got ${timeoutMs}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
