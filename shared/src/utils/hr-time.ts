/**
 * Calendar days and wall-clock rules in the timezone the business works in.
 *
 * ### The two kinds of value, and why they must not be confused
 *
 * Attendance deals with *instants* (when somebody clocked in — a real moment)
 * and *calendar days* (which day that was — a label). They are different types
 * of thing, and the classic attendance bug is treating one as the other:
 * somebody clocking in at 00:30 IST belongs to today's attendance date, but that
 * instant is 19:00 UTC **yesterday**. Truncating the instant to a UTC day files
 * every late-evening shift against the wrong date.
 *
 * So:
 *
 *   - Instants always come from Postgres `now()` via `databaseNow()`. Never from
 *     Node's clock and **never from the client** — a browser clock can be wrong
 *     by hours or set deliberately, and attendance is precisely the feature
 *     somebody would try that on.
 *   - Calendar days are derived from an instant by these functions, in IST.
 *
 * ### Why IST, fixed
 *
 * Asia/Kolkata at UTC+5:30. India observes no daylight saving, so a constant
 * offset is exact rather than an approximation — the same assumption
 * `backend/src/modules/sales/sales-efficiency.ts` already makes for dispatch
 * deadlines and `frontend/lib/format.ts` already makes when rendering every
 * timestamp in the product. Reusing it keeps one company timezone rather than
 * introducing a second notion of "today".
 *
 * **Employee-level timezones are deliberately not implemented.** Nothing in the
 * repository models one, the business operates from India, and inventing a
 * per-employee timezone would mean guessing at a policy nobody has stated — and
 * every attendance comparison would then need to know whose timezone it is in.
 * The documented fallback is: one company timezone, IST, for every employee.
 * When a genuine second location appears, the extension point is a timezone on
 * the employee's location with these functions taking it as an argument.
 */

/** Asia/Kolkata, fixed. No daylight saving, so this is exact. */
export const COMPANY_UTC_OFFSET_MINUTES = 330;
export const COMPANY_TIMEZONE = 'Asia/Kolkata';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const OFFSET_MS = COMPANY_UTC_OFFSET_MINUTES * MS_PER_MINUTE;

/**
 * The calendar day an instant falls on, in company time.
 *
 * Returned as a Date at midnight UTC, which is how Postgres `DATE` columns
 * round-trip through Prisma — so the value that goes into `attendanceDate` is
 * exactly the value that comes back out.
 */
export function companyDateOf(instant: Date): Date {
  const wallClock = instant.getTime() + OFFSET_MS;
  return new Date(Math.floor(wallClock / MS_PER_DAY) * MS_PER_DAY);
}

/** The same day as an ISO `YYYY-MM-DD` string, for keys and display. */
export function companyDateKey(instant: Date): string {
  return companyDateOf(instant).toISOString().slice(0, 10);
}

/**
 * Minutes from midnight company-time for an instant.
 *
 * What late-arrival and early-exit compare against: a policy says "09:30", which
 * is 570 minutes, and that rule applies every day rather than to one moment.
 */
export function minutesIntoCompanyDay(instant: Date): number {
  const wallClock = instant.getTime() + OFFSET_MS;
  return Math.floor((wallClock % MS_PER_DAY) / MS_PER_MINUTE);
}

/**
 * The instant at which a given minute-of-day occurs on a given calendar day.
 *
 * The inverse of `minutesIntoCompanyDay`, used to turn a policy's "expected end
 * 18:30" into a real moment on the day being judged.
 */
export function companyDayInstantAt(day: Date, minuteOfDay: number): Date {
  const dayStartUtc = companyDateOf(day).getTime();
  return new Date(dayStartUtc + minuteOfDay * MS_PER_MINUTE - OFFSET_MS);
}

/**
 * ISO weekday for a calendar day: 1 = Monday … 7 = Sunday.
 *
 * ISO rather than JavaScript's 0 = Sunday, because a week-off policy stores ISO
 * numbers and a reader should not have to remember which convention a given
 * number is in. Computed from the company-time day so a Sunday in IST is Sunday
 * here even when the underlying instant is Saturday in UTC.
 */
export function companyWeekday(day: Date): number {
  const jsDay = companyDateOf(day).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** Whether two instants fall on the same company calendar day. */
export function isSameCompanyDate(a: Date, b: Date): boolean {
  return companyDateOf(a).getTime() === companyDateOf(b).getTime();
}

/**
 * Every calendar day from `start` to `end` inclusive.
 *
 * Inclusive because leave from the 3rd to the 5th is three days, not two. Built
 * by adding whole days to a midnight-UTC value, which cannot drift: there is no
 * daylight saving to step over and no local-time arithmetic involved.
 */
export function companyDateRange(start: Date, end: Date): Date[] {
  const first = companyDateOf(start).getTime();
  const last = companyDateOf(end).getTime();
  if (last < first) return [];

  const days: Date[] = [];
  for (let t = first; t <= last; t += MS_PER_DAY) days.push(new Date(t));
  return days;
}

/** Whole days between two calendar days. Negative if `to` precedes `from`. */
export function companyDaysBetween(from: Date, to: Date): number {
  return Math.round((companyDateOf(to).getTime() - companyDateOf(from).getTime()) / MS_PER_DAY);
}

/**
 * A duration in whole minutes, floored and never negative.
 *
 * Floored rather than rounded so a worked duration is never overstated, and
 * clamped at zero because a negative duration is a bug upstream — the database
 * refuses the row that would store one, and this stops the service computing it
 * in the first place.
 */
export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_MINUTE));
}

/** "7h 30m" — a duration as people read it. Zero is "0m", never blank. */
export function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0m';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** A minute-of-day as "09:30", for rendering a policy. */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const safe = ((minuteOfDay % 1440) + 1440) % 1440;
  const hours = String(Math.floor(safe / 60)).padStart(2, '0');
  const minutes = String(safe % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** "09:30" to 570. Returns null for anything that is not a time of day. */
export function parseMinuteOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
