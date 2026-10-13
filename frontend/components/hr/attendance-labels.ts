import type {
  AttendanceCorrectionStatus,
  AttendanceSessionState,
  AttendanceSource,
  AttendanceStatus,
  AttendanceWorkMode,
  HalfDayPeriod,
  LeaveLedgerReason,
  LeaveRequestStatus,
  OvertimeStatus,
} from '@rs/shared';

/**
 * How HR Phase 2 values are written in the interface.
 *
 * Pure data and pure functions, exported so the DOM-less frontend suite can
 * assert them directly — the project's convention for presentation logic, and the
 * reason none of this is inlined into the components.
 *
 * **Nothing here computes a business figure.** Worked minutes, late minutes, leave
 * day counts and available balances all arrive derived from the service. These
 * functions only decide how an already-computed value is written down, which is
 * the one thing the browser is entitled to decide.
 */

export const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  HALF_DAY: 'Half day',
  LEAVE: 'On leave',
  HOLIDAY: 'Holiday',
  WEEK_OFF: 'Week off',
};

/**
 * The visual weight each status carries.
 *
 * `ABSENT` is the only critical one: it is the status that costs somebody
 * something. `HOLIDAY` and `WEEK_OFF` are outline rather than neutral so a glance
 * down a month distinguishes "the office was shut" from "nothing recorded" —
 * those read very differently to anybody checking a timesheet.
 */
export const ATTENDANCE_STATUS_TONES: Record<
  AttendanceStatus,
  'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline'
> = {
  PRESENT: 'positive',
  ABSENT: 'critical',
  HALF_DAY: 'warning',
  LEAVE: 'accent',
  HOLIDAY: 'outline',
  WEEK_OFF: 'outline',
};

export const ATTENDANCE_WORK_MODE_LABELS: Record<AttendanceWorkMode, string> = {
  OFFICE: 'Office',
  WFH: 'Work from home',
  REMOTE: 'Remote',
};

export const SESSION_STATE_LABELS: Record<AttendanceSessionState, string> = {
  NONE: 'Not started',
  OPEN: 'Working',
  ON_BREAK: 'On break',
  CLOSED: 'Finished',
};

/**
 * Where a record came from.
 *
 * Shown on the board because an auto-resolved day and a corrected one are
 * different claims, and somebody auditing a timesheet needs to tell them apart.
 */
export const ATTENDANCE_SOURCE_LABELS: Record<AttendanceSource, string> = {
  SELF: 'Self recorded',
  SYSTEM: 'System',
  MANUAL: 'HR entered',
  CORRECTION: 'Corrected',
};

export const CORRECTION_STATUS_LABELS: Record<AttendanceCorrectionStatus, string> = {
  PENDING: 'Awaiting decision',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Withdrawn',
};

export const OVERTIME_STATUS_LABELS: Record<OvertimeStatus, string> = {
  PENDING: 'Awaiting decision',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const LEAVE_STATUS_LABELS: Record<LeaveRequestStatus, string> = {
  PENDING: 'Awaiting decision',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

export const LEAVE_STATUS_TONES: Record<
  LeaveRequestStatus,
  'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline'
> = {
  PENDING: 'warning',
  APPROVED: 'positive',
  REJECTED: 'critical',
  CANCELLED: 'outline',
};

export const DECISION_STATUS_TONES: Record<
  AttendanceCorrectionStatus | OvertimeStatus,
  'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline'
> = {
  PENDING: 'warning',
  APPROVED: 'positive',
  REJECTED: 'critical',
  CANCELLED: 'outline',
};

export const HALF_DAY_PERIOD_LABELS: Record<HalfDayPeriod, string> = {
  FIRST_HALF: 'First half',
  SECOND_HALF: 'Second half',
};

/**
 * What one ledger entry says, in words.
 *
 * Written as prose rather than the enum name because this is what an employee
 * reads when they dispute a balance, and `RESERVATION_RELEASE` explains nothing
 * to anybody. The ledger exists precisely so the number can be defended; the
 * wording is half of that.
 */
export const LEAVE_LEDGER_REASON_LABELS: Record<LeaveLedgerReason, string> = {
  ALLOCATION: 'Annual entitlement',
  ACCRUAL: 'Accrued',
  CARRY_FORWARD: 'Carried forward',
  RESERVATION: 'Held for a pending request',
  RESERVATION_RELEASE: 'Hold released',
  CONSUMPTION: 'Leave taken',
  CONSUMPTION_REVERSAL: 'Returned after cancellation',
  ADJUSTMENT: 'HR adjustment',
  LAPSE: 'Lapsed',
};

/**
 * ISO weekdays as names, for rendering a week-off pattern.
 *
 * Indexed 1–7 with Monday first, matching the ISO numbering the policy stores —
 * so a reader never has to work out whether `0` means Sunday.
 */
export const ISO_WEEKDAY_LABELS: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

/** A week-off pattern as a sentence. Empty means a seven-day week. */
export function describeWeekOff(days: readonly number[]): string {
  if (days.length === 0) return 'No weekly off configured';
  const names = [...days].sort((a, b) => a - b).map((d) => ISO_WEEKDAY_LABELS[d] ?? `Day ${d}`);
  if (names.length === 1) return `${names[0]} off`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} off`;
}

/**
 * A clock time from an ISO instant, in company time.
 *
 * `Asia/Kolkata` explicitly rather than the browser's zone: attendance is
 * recorded against company days, and a colleague in another timezone opening the
 * board must see the same clock-in time the person who recorded it saw. Letting
 * the browser decide would make the same record read differently to two people.
 */
export function formatClockTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * A calendar day for display.
 *
 * UTC, because these are `@db.Date` values stored at midnight — rendering them in
 * a negative offset would show the previous day, so somebody's leave would appear
 * to start a day early for half the world.
 */
export function formatHrDay(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A date range, collapsing a single day rather than repeating it. */
export function formatDayRange(start: string, end: string): string {
  return start === end ? formatHrDay(start) : `${formatHrDay(start)} — ${formatHrDay(end)}`;
}

/**
 * A day count for display: "1 day", "2.5 days".
 *
 * Trims a trailing `.00` so a whole number reads as one, while a half day keeps
 * its fraction. Takes the canonical string the API sends rather than a number, so
 * nothing is re-parsed into a float on the way to the screen.
 */
export function formatLeaveDays(days: string): string {
  const trimmed = days.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `${trimmed} ${trimmed === '1' ? 'day' : 'days'}`;
}

/**
 * Whether a day figure is effectively zero.
 *
 * Compared as a string against the canonical forms rather than with `Number()`,
 * for the same reason the backend uses exact arithmetic: a balance is the one
 * figure where "nearly zero" must not read as zero.
 */
export function isZeroDays(days: string): boolean {
  return days === '0.00' || days === '0' || days === '-0.00';
}

/**
 * What the employee's widget should say about the day as a whole.
 *
 * Derived from flags the server already decided — it does not re-decide whether
 * somebody may clock in, which is the service's answer and arrives on the payload.
 */
export function describeToday(today: {
  isHoliday: boolean;
  isWeekOff: boolean;
  onLeave: boolean;
  record: { sessionState: AttendanceSessionState } | null;
}): string {
  if (today.onLeave) return 'You are on approved leave today';
  if (today.isHoliday) return 'Today is a company holiday';
  if (today.isWeekOff) return 'Today is a weekly off';

  switch (today.record?.sessionState) {
    case 'OPEN':
      return 'You are clocked in';
    case 'ON_BREAK':
      return 'You are on a break';
    case 'CLOSED':
      return 'You have finished for today';
    default:
      return 'You have not clocked in yet';
  }
}
