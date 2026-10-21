/**
 * Published-at as the ingest form stores it.
 *
 * The value is a `datetime-local` string: `YYYY-MM-DDTHH:mm`, no seconds and
 * no offset. `new Date(value)` reads that as local time, and the page sends
 * `new Date(value).toISOString()` to the API. The picker has to keep emitting
 * this exact shape.
 */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parseLocalDateTime(value: string): Date | null {
  const match = LOCAL_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  if (month < 1 || month > 12 || hours > 23 || minutes > 59) return null;
  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) {
    return null;
  }
  return date;
}

export function formatLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Digits only, clamped. Empty input is 0 so a chosen day still has a time. */
export function clampTimePart(raw: string, max: number): number {
  const digits = raw.replace(/\D/g, "").slice(0, 2);
  if (!digits) return 0;
  const n = Number.parseInt(digits, 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(max, Math.max(0, n));
}

export function padTime(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Next digit in a two-character time field.
 *
 * The field is shown padded ("00"), so a digit replaces that pair instead of
 * being inserted into it. A second digit completes the pair. A value over
 * `max` is refused and the field stays as it was.
 */
export function pushTimeDigit(current: string, digit: string, max: number): string | null {
  if (!/^\d$/.test(digit)) return null;
  const base = current.length >= 2 ? "" : current.replace(/\D/g, "");
  const next = (base + digit).slice(0, 2);
  if (Number(next) > max) return null;
  return next;
}
