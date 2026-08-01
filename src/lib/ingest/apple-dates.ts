/**
 * @file Parsing Apple's date format, which is **not** ISO-8601.
 *
 * ```
 * 2024-03-01 07:14:22 -0800
 * ```
 *
 * The offset is `±HHMM` with **no colon**, so `new Date(str)` is unreliable —
 * Safari and V8 disagree about it, and V8's tolerance is undocumented
 * behaviour rather than a guarantee. `integration-apple-health.md` §3.5 says
 * parse it with a regex and construct explicitly, so that is what this does.
 *
 * Three real-world variants have to be tolerated as well
 * (`integration-apple-health.md` §4.5):
 *
 * - `2006-01-02 3:04:05 PM -0700` — iOS "24-Hour Time" switched off
 * - `2006-01-02 3:04:05 pm -0700` — lower case
 * - a **U+202F NARROW NO-BREAK SPACE** before `PM` on newer iOS, which is not
 *   matched by `\s` in older JS engines and silently breaks a naive split
 *
 * ## Why the local day is taken from the string, not computed
 *
 * `AppleDate.dateKey` is the first ten characters of the source string. The
 * export already carries wall-clock local time at the moment of capture, so a
 * 06:00 workout in Los Angeles reads `2024-03-01` whatever time zone the phone
 * is in when the import runs. Recomputing the day from the UTC instant would
 * re-derive it against the *device's current* zone and quietly move a year of
 * data across midnight for anyone who has travelled.
 */

/** A parsed Apple timestamp. */
export interface AppleDate {
  /** Epoch milliseconds — the true instant. */
  ms: number;
  /** Local wall-clock calendar day at capture, `YYYY-MM-DD`. */
  dateKey: string;
  /** Offset from UTC in minutes at capture, e.g. `-480`. */
  offsetMin: number;
}

/**
 * `yyyy-MM-dd HH:mm:ss ±HHMM`, with optional AM/PM and optional seconds.
 *
 * Written as one regex rather than a split-and-parse chain because the
 * separator is exactly what varies (space, narrow no-break space, `T`).
 */
const APPLE_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AaPp][Mm])?\s*([+-])(\d{2}):?(\d{2})$/;

/** Same, but with no trailing offset — treated as UTC and flagged by callers. */
const NO_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AaPp][Mm])?Z?$/;

/**
 * Replace the space variants iOS emits with a plain ASCII space.
 *
 * U+202F (narrow no-break space) and U+00A0 (no-break space) both appear in
 * real exports in front of `AM`/`PM`. Normalising first means the regex above
 * only has to know about one separator.
 *
 * @param input the raw attribute value
 * @returns the string with exotic spaces flattened and ends trimmed
 */
export function normalizeSpaces(input: string): string {
  // U+00A0 no-break, U+2007 figure, U+2009 thin, U+202F narrow no-break.
  // Written as escapes because these are invisible in a source file and a
  // stray literal is undiagnosable.
  return input.replace(/[\u00A0\u2007\u2009\u202F]/g, ' ').trim();
}

/** Apply an AM/PM marker to a 12-hour clock reading. */
function to24Hour(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const pm = meridiem.toLowerCase() === 'pm';
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

/**
 * Parse an Apple Health timestamp.
 *
 * Never throws. Returns `null` for anything it cannot read, so the caller
 * counts a failure rather than storing an `Invalid Date` that renders as `NaN`
 * three screens away.
 *
 * @param raw the attribute value, e.g. `2024-03-01 07:14:22 -0800`
 * @returns the instant, the local day and the offset, or `null`
 */
export function parseAppleDate(raw: string | null | undefined): AppleDate | null {
  if (!raw) return null;
  const s = normalizeSpaces(raw);

  const m = APPLE_DATE_RE.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, sec, meridiem, sign, offH, offM] = m;
    const hour = to24Hour(Number(h), meridiem);
    const offsetMin =
      (sign === '-' ? -1 : 1) * (Number(offH) * 60 + Number(offM));
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi), Number(sec ?? 0));
    if (!Number.isFinite(utc)) return null;
    return { ms: utc - offsetMin * 60_000, dateKey: `${y}-${mo}-${d}`, offsetMin };
  }

  const n = NO_OFFSET_RE.exec(s);
  if (n) {
    const [, y, mo, d, h, mi, sec, meridiem] = n;
    const hour = to24Hour(Number(h), meridiem);
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi), Number(sec ?? 0));
    if (!Number.isFinite(utc)) return null;
    return { ms: utc, dateKey: `${y}-${mo}-${d}`, offsetMin: 0 };
  }

  // Last resort: a genuine ISO-8601 string, which is what FHIR resources carry.
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const dt = new Date(t);
  const dateKey = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate(),
  ).padStart(2, '0')}`;
  return { ms: t, dateKey, offsetMin: 0 };
}

/**
 * The local calendar day an instant belongs to, in the device's own zone.
 *
 * Used only where no source offset exists — a clipboard payload built by
 * Shortcuts on this very phone, for instance. Prefer {@link parseAppleDate}'s
 * `dateKey` whenever the string carries an offset.
 *
 * @param ms epoch milliseconds
 * @returns `YYYY-MM-DD`
 */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * The earlier of two `YYYY-MM-DD` keys, tolerating `null`.
 *
 * @param a a date key or `null`
 * @param b a date key or `null`
 * @returns the earlier key, or whichever is non-null
 */
export function minDateKey(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * The later of two `YYYY-MM-DD` keys, tolerating `null`.
 *
 * @param a a date key or `null`
 * @param b a date key or `null`
 * @returns the later key, or whichever is non-null
 */
export function maxDateKey(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}
