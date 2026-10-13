import {
  companyDateOf,
  companyDateRange,
  companyWeekday,
} from './hr-time.js';
import type { HalfDayPeriod } from '../enums.js';

/**
 * How many days of leave a date range actually costs.
 *
 * **The one place this is calculated.** The brief asks for a single shared
 * service, and the reason is worth stating: a leave request, a balance
 * reservation, an approval and an attendance resolution all need the same
 * answer, and four implementations would drift. Three of them agreeing is not
 * reassuring when the fourth is the one that moved the balance.
 *
 * Pure: no database, no clock, no Prisma. Every input is passed in, so the
 * awkward cases — a holiday in the middle, a week-off at either end, a half day
 * — are testable exhaustively without fixtures. The caller fetches the holidays
 * and the policy; this decides.
 *
 * ### What counts
 *
 * A day costs leave only if it is a working day: not a week-off under the
 * employee's policy, and not an active holiday that applies to them. A half-day
 * request costs 0.5 and is a single date by definition — the database enforces
 * that pairing too.
 *
 * ### Why holidays and week-offs are excluded rather than deducted afterwards
 *
 * Taking a week off that contains a public holiday should not cost the employee
 * that holiday. Counting the whole span and subtracting later gives the same
 * total only when nothing overlaps; walking the days and skipping the non-working
 * ones is right in every case, including a range that is *entirely* holidays —
 * which costs nothing and should be refused as a request rather than silently
 * costing zero.
 */

/** A day the business is closed, as the calculator needs to see it. */
export type HolidayDay = {
  /** Midnight-UTC calendar day, as `companyDateOf` produces. */
  holidayDate: Date;
  /** Null means company-wide; otherwise only that department's employees. */
  departmentId: string | null;
};

/** The week-off rule in force for the employee. */
export type WorkWeek = {
  /** ISO weekday numbers that are off: 1 = Monday … 7 = Sunday. */
  weekOffDays: readonly number[];
};

export type LeaveDayBreakdown = {
  /** Days that cost leave. 0.5 for a half day. */
  leaveDays: number;
  /** Calendar days in the range, working or not. */
  totalDays: number;
  holidayDays: number;
  weekOffDays: number;
  /** The working dates, as ISO day strings — what attendance is written for. */
  workingDates: string[];
};

/**
 * Whether one calendar day is a working day for one employee.
 *
 * Exported because attendance resolution asks the same question about a single
 * date, and it must get the same answer as the leave calculator — a day that is a
 * week-off for leave purposes but a working day for attendance purposes would
 * mark somebody absent on their day off.
 */
export function isWorkingDay(
  day: Date,
  options: {
    workWeek: WorkWeek;
    holidays: readonly HolidayDay[];
    /** The employee's department, for department-scoped holidays. */
    departmentId: string | null;
  },
): boolean {
  if (isWeekOff(day, options.workWeek)) return false;
  return !isHoliday(day, options.holidays, options.departmentId);
}

export function isWeekOff(day: Date, workWeek: WorkWeek): boolean {
  return workWeek.weekOffDays.includes(companyWeekday(day));
}

/**
 * Whether a holiday applies to this employee on this day.
 *
 * A company-wide holiday (null department) applies to everybody; a scoped one
 * only to its own department. Callers are expected to have filtered to active
 * holidays — an inactive one is a cancelled closure and must not stop somebody's
 * leave from counting.
 */
export function isHoliday(
  day: Date,
  holidays: readonly HolidayDay[],
  departmentId: string | null,
): boolean {
  const target = companyDateOf(day).getTime();
  return holidays.some((holiday) => {
    if (companyDateOf(holiday.holidayDate).getTime() !== target) return false;
    return holiday.departmentId === null || holiday.departmentId === departmentId;
  });
}

/**
 * The cost of a leave request.
 *
 * Returns the breakdown rather than a bare number so the UI can explain it —
 * "5 calendar days, 1 holiday, 2 week-offs, 2 days of leave" is what stops
 * somebody querying their balance.
 */
export function calculateLeaveDays(input: {
  startDate: Date;
  endDate: Date;
  isHalfDay: boolean;
  halfDayPeriod?: HalfDayPeriod | null;
  workWeek: WorkWeek;
  holidays: readonly HolidayDay[];
  departmentId: string | null;
}): LeaveDayBreakdown {
  const days = companyDateRange(input.startDate, input.endDate);

  let holidayDays = 0;
  let weekOffDays = 0;
  const workingDates: string[] = [];

  for (const day of days) {
    /*
      Week-off is checked first, so a holiday falling on a Sunday is counted once
      as a week-off rather than twice. The totals are for explanation, and double
      counting would make them not add up.
    */
    if (isWeekOff(day, input.workWeek)) {
      weekOffDays += 1;
      continue;
    }
    if (isHoliday(day, input.holidays, input.departmentId)) {
      holidayDays += 1;
      continue;
    }
    workingDates.push(day.toISOString().slice(0, 10));
  }

  /*
    A half day is a single date, and only costs anything if that date is a working
    day. Asking for a half day on a holiday costs nothing — which the service
    refuses as a request rather than recording a zero-day leave.
  */
  const leaveDays = input.isHalfDay
    ? workingDates.length > 0
      ? 0.5
      : 0
    : workingDates.length;

  return {
    leaveDays,
    totalDays: days.length,
    holidayDays,
    weekOffDays,
    workingDates,
  };
}

/**
 * The longest unbroken run of working days in a range.
 *
 * What a policy's `maxConsecutiveDays` is actually about. Counting every working
 * day in the span would be wrong: leave either side of a public holiday is not
 * one long absence, and a policy capping "consecutive days" means consecutive.
 */
export function longestConsecutiveWorkingRun(input: {
  startDate: Date;
  endDate: Date;
  workWeek: WorkWeek;
  holidays: readonly HolidayDay[];
  departmentId: string | null;
}): number {
  let longest = 0;
  let current = 0;

  for (const day of companyDateRange(input.startDate, input.endDate)) {
    if (
      isWorkingDay(day, {
        workWeek: input.workWeek,
        holidays: input.holidays,
        departmentId: input.departmentId,
      })
    ) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}
