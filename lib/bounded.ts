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
 * Seconds the relayer asked us to wait. The header is `retryAfterSeconds`
 * on the SDK error; the body field `retry_after_seconds` survives when a
 * proxy strips the header. The raw body is `error.cause`.
 */
export function retryAfterSeconds(err: unknown): number | undefined {
  for (const item of walkErrors(err)) {
    if (item && typeof item === "object" && "retryAfterSeconds" in item) {
      const seconds = (item as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return seconds;
    }
    const text = errorText(item);
    if (!text) continue;
    const match = text.match(/"retry_after_seconds"\s*:\s*(\d+(?:\.\d+)?)/);
    if (match) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  }
  return undefined;
}

/** 429 from the delegate limiter. Status polls count, so a short retry re-trips it. */
export function isRateLimited(err: unknown): boolean {
  for (const item of walkErrors(err)) {
    if (httpStatus(item) === 429) return true;
    const text = errorText(item);
    if (text && /\(429\)|\bstatus(?:\s+code)?\s*[:=]?\s*429\b/.test(text)) return true;
  }
  return false;
}

/**
 * The relayer already accepted this idempotency key with different bytes.
 * Retrying the same body is not what this error means, and a new key would
 * append a second memory.
 */
export function isIdempotencyConflict(err: unknown): boolean {
  let conflict = false;
  let status409 = false;
  for (const item of walkErrors(err)) {
    if (httpStatus(item) === 409) status409 = true;
    const text = errorText(item);
    if (!text) continue;
    if (/\(409\)/.test(text)) status409 = true;
    if (/idempotency_key was already used/i.test(text) || /different content/i.test(text)) conflict = true;
  }
  return status409 && conflict;
}

/**
 * Call `work` up to `attempts` times. The delay after attempt 1 is
 * `backoffMs`, then doubles, capped by `maxBackoffMs`. `delayFor` replaces
 * that curve for one error — a 429 uses the relayer's retry-after instead
 * of the 2s/4s curve.
 */
export async function withRetry<T>(
  work: () => Promise<T>,
  opts: {
    attempts: number;
    backoffMs: number;
    maxBackoffMs?: number;
    isRetryable?: (err: unknown) => boolean;
    delayFor?: (err: unknown, attempt: number) => number;
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
      const delayMs = opts.delayFor
        ? opts.delayFor(err, attempt)
        : Math.min(maxBackoffMs, opts.backoffMs * 2 ** (attempt - 1));
      opts.onRetry?.({ attempt, attempts, delayMs, error: err });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw last;
}

function walkErrors(err: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (typeof current === "object") seen.add(current);
    out.push(current);
    if (typeof current !== "object") break;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return out;
}

function errorText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item instanceof Error) return item.message;
  if (item && typeof item === "object" && "message" in item && typeof (item as { message?: unknown }).message === "string") {
    return (item as { message: string }).message;
  }
  return "";
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
