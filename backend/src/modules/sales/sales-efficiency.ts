/**
 * The dispatch verdict — pure functions, no Prisma and no Express.
 *
 * `toBeDispatchedBy` is a *date*, not an instant. Comparing a dispatch against
 * its midnight would mark an order sent at 2pm on its own deadline day as
 * DELAYED, which is not what anyone means by "dispatch by the 10th". The
 * deadline is therefore the last millisecond of that day, read in the timezone
 * the business actually works in.
 */

import type { SalesEfficiency } from '@rs/shared';

/**
 * Asia/Kolkata, fixed at UTC+5:30.
 *
 * India observes no daylight saving, so a constant offset is exact rather than
 * an approximation — the same assumption `frontend/lib/format.ts` already makes
 * when it renders every timestamp in IST.
 */
const IST_OFFSET_MINUTES = 330;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * MS_PER_MINUTE;

/**
 * The last instant of the IST day that `toBeDispatchedBy` falls on.
 *
 * Shifts into IST wall-clock time, truncates to the day, takes its final
 * millisecond, then shifts back to a real instant. A deadline stored as
 * 2026-08-10T00:00:00Z yields 2026-08-10T18:29:59.999Z — 23:59:59.999 IST.
 */
export function dispatchDeadline(toBeDispatchedBy: Date): Date {
  const istWallClock = toBeDispatchedBy.getTime() + IST_OFFSET_MS;
  const istDayStart = Math.floor(istWallClock / MS_PER_DAY) * MS_PER_DAY;
  return new Date(istDayStart + MS_PER_DAY - 1 - IST_OFFSET_MS);
}

/**
 * The verdict, decided once at dispatch and then frozen.
 *
 * Called with the dispatch instant taken from Postgres inside the transaction,
 * never from Node's clock.
 */
export function dispatchVerdict(dispatchedAt: Date, toBeDispatchedBy: Date): SalesEfficiency {
  return dispatchedAt <= dispatchDeadline(toBeDispatchedBy) ? 'ON_TIME' : 'DELAYED';
}

/**
 * Derived for display, never stored: still awaiting dispatch and already past
 * the deadline. Distinct from DELAYED, which is a recorded verdict on an order
 * that has actually gone out.
 */
export function isOverdue(
  now: Date,
  toBeDispatchedBy: Date,
  dispatchedAt: Date | null,
): boolean {
  if (dispatchedAt !== null) return false;
  return now > dispatchDeadline(toBeDispatchedBy);
}
