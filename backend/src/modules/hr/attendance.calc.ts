/**
 * Attendance arithmetic and the day's verdict, as pure functions.
 *
 * No Prisma, no Express, no clock. Every input is passed in — including "now",
 * which the caller takes from Postgres — so every awkward case is testable
 * exhaustively without fixtures or a database. These are the rules most worth
 * being certain about: a wrong `lateMinutes` is somebody's pay docked.
 *
 * ### The resolution precedence, and why it is in this order
 *
 *     APPROVED LEAVE  >  HOLIDAY  >  WEEK OFF  >  VALID ATTENDANCE  >  ABSENT
 *
 * Read upwards, each rule exists to stop the one below it being wrong:
 *
 *   - **ABSENT is last.** It is the default, and the default must never override
 *     a reason the person was legitimately not working.
 *   - **Attendance beats absence** — obviously, but worth stating: a record with
 *     a clock-in is evidence, and evidence outranks an assumption.
 *   - **Week-off beats attendance** for the *status*. Somebody who works a
 *     Sunday has a WEEK_OFF day with hours on it; calling it PRESENT would make
 *     the week look like six working days and quietly lose the overtime claim.
 *   - **Holiday beats week-off** so a holiday falling on a Sunday is reported as
 *     the holiday, which is what a payroll register needs to show.
 *   - **Approved leave beats everything.** This is the rule the brief singles
 *     out, and rightly: if ABSENT could override it, an employee whose leave was
 *     approved would still be marked absent, and the approval would have
 *     achieved nothing. It also beats holiday and week-off so a cancelled leave
 *     cannot silently become a working day.
 */

import type {
  AttendanceSessionState,
  AttendanceStatus,
  AttendanceWorkMode,
} from '@rs/shared';
import {
  companyDayInstantAt,
  minutesBetween,
  minutesIntoCompanyDay,
} from '@rs/shared';

/** The policy values the arithmetic needs. */
export type AttendanceRules = {
  expectedStartMinute: number;
  expectedEndMinute: number;
  graceMinutes: number;
  fullDayMinutes: number;
  halfDayMinutes: number;
  overtimeThresholdMinutes: number;
  weekOffDays: readonly number[];
};

/** What one completed session produced. */
export type SessionTotals = {
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
};

/**
 * How late somebody was.
 *
 * Measured against the expected start plus the grace period, so a policy with
 * fifteen minutes' grace treats 09:44 as on time and 09:46 as one minute late —
 * not sixteen. Counting from the expected start while also granting grace would
 * make the grace period invisible in the number, and somebody would "fix" it.
 *
 * Zero, never negative: arriving early is not negative lateness, and the database
 * refuses a negative duration.
 */
export function lateMinutesFor(clockInAt: Date, rules: AttendanceRules): number {
  const arrived = minutesIntoCompanyDay(clockInAt);
  const allowedUntil = rules.expectedStartMinute + rules.graceMinutes;
  return Math.max(0, arrived - allowedUntil);
}

/**
 * How early somebody left.
 *
 * No grace on this side, deliberately: grace exists to forgive traffic on the way
 * in, and a symmetric allowance at the end would quietly shorten the working day
 * by twice the grace. If the business wants it, it belongs in the policy as its
 * own field rather than being assumed here.
 */
export function earlyExitMinutesFor(clockOutAt: Date, rules: AttendanceRules): number {
  const left = minutesIntoCompanyDay(clockOutAt);
  return Math.max(0, rules.expectedEndMinute - left);
}

/**
 * Totals for a completed session.
 *
 * `workedMinutes` is elapsed time minus breaks, floored at zero. Breaks are
 * summed by the caller from the break rows, because only the caller knows which
 * of them closed — an open break at clock-out is closed first, and that is a
 * service decision rather than arithmetic.
 *
 * Overtime is measured on *worked* minutes against the threshold, not on elapsed
 * time: sitting at a desk for twelve hours with four hours of breaks is not four
 * hours of overtime.
 */
export function sessionTotals(input: {
  clockInAt: Date;
  clockOutAt: Date;
  breakMinutes: number;
  rules: AttendanceRules;
}): SessionTotals {
  const elapsed = minutesBetween(input.clockInAt, input.clockOutAt);
  const breakMinutes = Math.max(0, Math.min(input.breakMinutes, elapsed));
  const workedMinutes = Math.max(0, elapsed - breakMinutes);

  return {
    workedMinutes,
    breakMinutes,
    lateMinutes: lateMinutesFor(input.clockInAt, input.rules),
    earlyExitMinutes: earlyExitMinutesFor(input.clockOutAt, input.rules),
    overtimeMinutes: Math.max(0, workedMinutes - input.rules.overtimeThresholdMinutes),
  };
}

/**
 * Whether a day's worked minutes amount to a full day, a half day, or neither.
 *
 * Deterministic, which is what the brief asks for: two thresholds, three
 * outcomes, no judgement.
 *
 *   worked >= fullDayMinutes   PRESENT
 *   worked >= halfDayMinutes   HALF_DAY
 *   otherwise                  ABSENT
 *
 * ABSENT for a day somebody genuinely worked twenty minutes of is deliberate and
 * is the honest answer: it is not half a day, and recording it as one would make
 * the half-day threshold meaningless. The correction workflow exists for the case
 * where the clock is wrong rather than the attendance.
 */
export function workedDayStatus(
  workedMinutes: number,
  rules: AttendanceRules,
): Extract<AttendanceStatus, 'PRESENT' | 'HALF_DAY' | 'ABSENT'> {
  if (workedMinutes >= rules.fullDayMinutes) return 'PRESENT';
  if (workedMinutes >= rules.halfDayMinutes) return 'HALF_DAY';
  return 'ABSENT';
}

/** What the resolver knows about one day. */
export type DayFacts = {
  /** An approved leave covers this day. Half days carry the period. */
  approvedLeave: { isHalfDay: boolean } | null;
  isHoliday: boolean;
  isWeekOff: boolean;
  /** A completed session's worked minutes, or null if there is no session. */
  workedMinutes: number | null;
};

export type ResolvedDay = {
  status: AttendanceStatus;
  /** Why, in words, for the audit trail and for a reader of the board. */
  reason: string;
};

/**
 * The day's verdict.
 *
 * The single deterministic place attendance status is decided, so the board, the
 * summary, the leave integration and a future Payroll phase all get the same
 * answer. The precedence is documented at the top of this file and asserted
 * exhaustively in the tests.
 */
export function resolveDay(facts: DayFacts, rules: AttendanceRules): ResolvedDay {
  /*
    Approved leave first, and above holiday and week-off. The brief is explicit
    that an approved leave must not become ABSENT; putting it at the top also
    means a leave approved over a holiday still reads as leave, so cancelling it
    cannot silently turn the day into a working one.

    A half-day leave with hours worked is HALF_DAY: the person took half and
    worked half, and that is exactly what the status says.
  */
  if (facts.approvedLeave) {
    if (facts.approvedLeave.isHalfDay) {
      return facts.workedMinutes !== null && facts.workedMinutes > 0
        ? { status: 'HALF_DAY', reason: 'Half-day leave with hours worked' }
        : { status: 'HALF_DAY', reason: 'Half-day leave' };
    }
    return { status: 'LEAVE', reason: 'Approved leave' };
  }

  // Holiday above week-off, so a holiday on a Sunday reports as the holiday —
  // which is what a payroll register needs to show.
  if (facts.isHoliday) return { status: 'HOLIDAY', reason: 'Company holiday' };

  /*
    Week-off above attendance for the *status*: somebody who works a Sunday has a
    WEEK_OFF day with hours on it. Calling it PRESENT would make the week look
    like six working days and lose the overtime claim.
  */
  if (facts.isWeekOff) return { status: 'WEEK_OFF', reason: 'Weekly off' };

  if (facts.workedMinutes !== null) {
    const status = workedDayStatus(facts.workedMinutes, rules);
    return {
      status,
      reason:
        status === 'PRESENT'
          ? 'Worked a full day'
          : status === 'HALF_DAY'
            ? 'Worked at least half a day'
            : 'Worked less than half a day',
    };
  }

  // The default, and deliberately last: it must never override a reason the
  // person was legitimately not working.
  return { status: 'ABSENT', reason: 'No attendance recorded' };
}

/**
 * Which session transitions are legal.
 *
 * The state machine the database's CHECK also enforces. Keeping it here as data
 * means a service can ask "may this happen" without a round trip, and the test
 * can enumerate every pair rather than the handful a service happens to try.
 */
const SESSION_TRANSITIONS: Record<AttendanceSessionState, readonly AttendanceSessionState[]> = {
  /** Nothing yet: clocking in opens the session. */
  NONE: ['OPEN'],
  /** Working: may break, or clock out. */
  OPEN: ['ON_BREAK', 'CLOSED'],
  /** On a break: may resume. Clocking out from a break is refused — see below. */
  ON_BREAK: ['OPEN'],
  /*
    Clocked out. Terminal for the day: a second clock-out is refused, and
    reopening happens only through an approved correction, which rewrites the row
    rather than transitioning it.
  */
  CLOSED: [],
};

export function canTransitionSession(
  from: AttendanceSessionState,
  to: AttendanceSessionState,
): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

/**
 * What the employee's widget may offer.
 *
 * Derived server-side from the state, so the buttons and the API agree. The
 * browser never decides this: a button left enabled by a stale page must still be
 * refused, and having one source for "what is possible" is what stops the two
 * drifting.
 *
 * Note `canClockOut` is false while ON_BREAK. Clocking out mid-break would leave
 * an open break with no session to sit in, and the honest fix is to end the break
 * first rather than silently closing it — somebody who forgot is better served by
 * the correction workflow than by the system guessing.
 */
export function sessionActions(state: AttendanceSessionState): {
  canClockIn: boolean;
  canClockOut: boolean;
  canStartBreak: boolean;
  canEndBreak: boolean;
} {
  return {
    canClockIn: canTransitionSession(state, 'OPEN') && state === 'NONE',
    canClockOut: canTransitionSession(state, 'CLOSED'),
    canStartBreak: canTransitionSession(state, 'ON_BREAK'),
    canEndBreak: state === 'ON_BREAK',
  };
}

/** Whether a work mode is one an employee may record for themselves. */
export function isSelfRecordableWorkMode(mode: AttendanceWorkMode | null): boolean {
  // All three are: where somebody worked is their own statement of fact, and HR
  // can correct it. Kept as a function so a policy restricting WFH later has one
  // place to live.
  return mode === null || mode === 'OFFICE' || mode === 'WFH' || mode === 'REMOTE';
}

/**
 * The expected end of the working day as a real moment, for a given day.
 *
 * Used to decide whether a clock-out is early. Turns the policy's minute-of-day
 * rule into an instant on the day being judged, in company time.
 */
export function expectedEndInstant(day: Date, rules: AttendanceRules): Date {
  return companyDayInstantAt(day, rules.expectedEndMinute);
}
