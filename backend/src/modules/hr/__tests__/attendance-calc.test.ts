/**
 * Attendance arithmetic and the day's verdict, as pure logic.
 *
 * No database and no HTTP. These are the rules most worth being certain about —
 * a wrong `lateMinutes` is somebody's pay docked, and a resolution precedence
 * that puts ABSENT above approved leave makes an approval meaningless — so they
 * are tested exhaustively here rather than through the handful of paths an
 * integration suite happens to take.
 *
 * Every date in this file is built from an explicit UTC instant and asserted
 * against company time (IST, +5:30), because the single most likely attendance
 * bug is a day-boundary error that only shows up for evening shifts.
 */

import { describe, expect, it } from 'vitest';
import {
  companyDateKey,
  companyDateOf,
  companyDateRange,
  companyWeekday,
  formatMinutes,
  formatMinuteOfDay,
  minutesBetween,
  minutesIntoCompanyDay,
  parseMinuteOfDay,
} from '@rs/shared';
import {
  canTransitionSession,
  earlyExitMinutesFor,
  lateMinutesFor,
  resolveDay,
  sessionActions,
  sessionTotals,
  workedDayStatus,
  type AttendanceRules,
} from '../attendance.calc.js';

/** The default policy: 09:30–18:30, 15 minutes' grace, 8h full / 4h half. */
const rules: AttendanceRules = {
  expectedStartMinute: 570,
  expectedEndMinute: 1110,
  graceMinutes: 15,
  fullDayMinutes: 480,
  halfDayMinutes: 240,
  overtimeThresholdMinutes: 540,
  weekOffDays: [6, 7],
};

// ---------------------------------------------------------------------------
//  Company time
// ---------------------------------------------------------------------------

describe('company time puts an instant on the right calendar day', () => {
  it('files 00:30 IST against today, not yesterday', () => {
    /*
      THE attendance day-boundary bug, asserted directly. 00:30 IST on the 12th is
      19:00 UTC on the 11th; truncating the instant to a UTC day would file every
      late-evening and early-morning shift against the wrong date.
    */
    const lateNight = new Date('2026-03-11T19:00:00.000Z');
    expect(companyDateKey(lateNight)).toBe('2026-03-12');
  });

  it('files 23:30 IST against the same day', () => {
    // 23:30 IST on the 12th is 18:00 UTC on the 12th — same day either way, which
    // is exactly why the previous case is the one that catches the bug.
    expect(companyDateKey(new Date('2026-03-12T18:00:00.000Z'))).toBe('2026-03-12');
  });

  it('files 05:00 IST against the same day', () => {
    // 05:00 IST is 23:30 UTC the previous day.
    expect(companyDateKey(new Date('2026-03-11T23:30:00.000Z'))).toBe('2026-03-12');
  });

  it('returns a midnight-UTC date, so Postgres DATE round-trips unchanged', () => {
    const day = companyDateOf(new Date('2026-03-11T19:00:00.000Z'));
    expect(day.toISOString()).toBe('2026-03-12T00:00:00.000Z');
  });

  it('measures minutes into the day in company time', () => {
    // 09:45 IST = 04:15 UTC. 9*60+45 = 585.
    expect(minutesIntoCompanyDay(new Date('2026-03-12T04:15:00.000Z'))).toBe(585);
    // Midnight IST is minute zero, not 330.
    expect(minutesIntoCompanyDay(new Date('2026-03-11T18:30:00.000Z'))).toBe(0);
  });

  it('uses ISO weekdays, so Sunday is 7 rather than 0', () => {
    // 2026-03-15 is a Sunday.
    expect(companyWeekday(new Date('2026-03-15T00:00:00.000Z'))).toBe(7);
    // 2026-03-16 is a Monday.
    expect(companyWeekday(new Date('2026-03-16T00:00:00.000Z'))).toBe(1);
  });

  it('decides the weekday in company time, not UTC', () => {
    /*
      22:00 UTC Saturday is 03:30 IST Sunday. A UTC-based weekday would call this
      Saturday and a Sunday-only week-off would miss it.
    */
    expect(companyWeekday(new Date('2026-03-14T22:00:00.000Z'))).toBe(7);
  });

  it('builds an inclusive date range', () => {
    const days = companyDateRange(
      new Date('2026-03-12T00:00:00.000Z'),
      new Date('2026-03-14T00:00:00.000Z'),
    );
    // The 12th to the 14th is three days, not two.
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
    ]);
  });

  it('returns an empty range when the end precedes the start', () => {
    expect(
      companyDateRange(new Date('2026-03-14T00:00:00.000Z'), new Date('2026-03-12T00:00:00.000Z')),
    ).toEqual([]);
  });

  it('spans a month boundary without drifting', () => {
    const days = companyDateRange(
      new Date('2026-03-30T00:00:00.000Z'),
      new Date('2026-04-02T00:00:00.000Z'),
    );
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
    ]);
  });
});

describe('durations', () => {
  it('floors to whole minutes and never goes negative', () => {
    const a = new Date('2026-03-12T04:00:00.000Z');
    const b = new Date('2026-03-12T04:30:59.000Z');
    // Floored, so a worked duration is never overstated.
    expect(minutesBetween(a, b)).toBe(30);
    // Clamped: a negative duration is a bug upstream, and the database refuses it.
    expect(minutesBetween(b, a)).toBe(0);
  });

  it('formats for people, and says 0m rather than nothing', () => {
    expect(formatMinutes(450)).toBe('7h 30m');
    expect(formatMinutes(480)).toBe('8h');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(-5)).toBe('0m');
  });

  it('round-trips a minute-of-day', () => {
    expect(formatMinuteOfDay(570)).toBe('09:30');
    expect(formatMinuteOfDay(1110)).toBe('18:30');
    expect(parseMinuteOfDay('09:30')).toBe(570);
    expect(parseMinuteOfDay('18:30')).toBe(1110);
    expect(parseMinuteOfDay('25:00')).toBeNull();
    expect(parseMinuteOfDay('nonsense')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Late and early
// ---------------------------------------------------------------------------

describe('late arrival counts from the end of the grace period', () => {
  const on = (h: number, m: number) =>
    new Date(Date.UTC(2026, 2, 12, h, m) - 330 * 60_000);

  it('is zero when inside the grace period', () => {
    // 09:30 exactly, and 09:44 — one minute inside fifteen minutes' grace.
    expect(lateMinutesFor(on(9, 30), rules)).toBe(0);
    expect(lateMinutesFor(on(9, 44), rules)).toBe(0);
    expect(lateMinutesFor(on(9, 45), rules)).toBe(0);
  });

  it('counts from the grace boundary, not the expected start', () => {
    /*
      The subtlety worth a test: 09:46 is one minute late, not sixteen. Counting
      from 09:30 while also granting grace would make the grace invisible in the
      number, and somebody would "fix" it by removing the grace.
    */
    expect(lateMinutesFor(on(9, 46), rules)).toBe(1);
    expect(lateMinutesFor(on(10, 15), rules)).toBe(30);
  });

  it('is zero for an early arrival, never negative', () => {
    expect(lateMinutesFor(on(8, 0), rules)).toBe(0);
  });
});

describe('early exit has no grace, deliberately', () => {
  const on = (h: number, m: number) =>
    new Date(Date.UTC(2026, 2, 12, h, m) - 330 * 60_000);

  it('counts every minute before the expected end', () => {
    /*
      No symmetric allowance: grace forgives traffic on the way in, and granting
      it at both ends would quietly shorten the working day by twice the grace.
      If the business wants it, it belongs in the policy as its own field.
    */
    expect(earlyExitMinutesFor(on(18, 30), rules)).toBe(0);
    expect(earlyExitMinutesFor(on(18, 29), rules)).toBe(1);
    expect(earlyExitMinutesFor(on(17, 30), rules)).toBe(60);
  });

  it('is zero for a late departure', () => {
    expect(earlyExitMinutesFor(on(19, 30), rules)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  Session totals
// ---------------------------------------------------------------------------

describe('session totals', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 2, 12, h, m) - 330 * 60_000);

  it('subtracts breaks from elapsed time', () => {
    const totals = sessionTotals({
      clockInAt: at(9, 30),
      clockOutAt: at(18, 30),
      breakMinutes: 60,
      rules,
    });
    // Nine hours elapsed, one hour of break, eight hours worked.
    expect(totals.workedMinutes).toBe(480);
    expect(totals.breakMinutes).toBe(60);
  });

  it('measures overtime on worked minutes, not elapsed time', () => {
    /*
      Sitting at a desk for twelve hours with four hours of breaks is not four
      hours of overtime. Measuring elapsed time would pay for the breaks.
    */
    const totals = sessionTotals({
      clockInAt: at(9, 30),
      clockOutAt: at(21, 30),
      breakMinutes: 240,
      rules,
    });
    expect(totals.workedMinutes).toBe(480);
    // 480 worked against a 540 threshold: no overtime despite a twelve-hour day.
    expect(totals.overtimeMinutes).toBe(0);
  });

  it('counts overtime past the threshold', () => {
    const totals = sessionTotals({
      clockInAt: at(9, 30),
      clockOutAt: at(20, 30),
      breakMinutes: 0,
      rules,
    });
    // 11h worked, threshold 9h, so 2h overtime.
    expect(totals.workedMinutes).toBe(660);
    expect(totals.overtimeMinutes).toBe(120);
  });

  it('clamps a break longer than the session rather than going negative', () => {
    const totals = sessionTotals({
      clockInAt: at(9, 30),
      clockOutAt: at(10, 30),
      breakMinutes: 600,
      rules,
    });
    // Nonsense input, non-negative output: the database refuses a negative
    // duration, so the arithmetic must not produce one.
    expect(totals.workedMinutes).toBe(0);
    expect(totals.breakMinutes).toBe(60);
  });

  it('carries the late and early figures through', () => {
    const totals = sessionTotals({
      clockInAt: at(10, 0),
      clockOutAt: at(17, 0),
      breakMinutes: 0,
      rules,
    });
    expect(totals.lateMinutes).toBe(15);
    expect(totals.earlyExitMinutes).toBe(90);
  });
});

describe('half day is deterministic', () => {
  it('uses two thresholds and three outcomes', () => {
    expect(workedDayStatus(480, rules)).toBe('PRESENT');
    expect(workedDayStatus(479, rules)).toBe('HALF_DAY');
    expect(workedDayStatus(240, rules)).toBe('HALF_DAY');
    expect(workedDayStatus(239, rules)).toBe('ABSENT');
    expect(workedDayStatus(0, rules)).toBe('ABSENT');
  });

  it('calls twenty minutes ABSENT rather than half a day', () => {
    /*
      Deliberate and honest: it is not half a day, and recording it as one would
      make the half-day threshold meaningless. The correction workflow covers the
      case where the clock is wrong rather than the attendance.
    */
    expect(workedDayStatus(20, rules)).toBe('ABSENT');
  });
});

// ---------------------------------------------------------------------------
//  Resolution precedence — the rule the brief singles out
// ---------------------------------------------------------------------------

describe('resolution precedence: LEAVE > HOLIDAY > WEEK_OFF > ATTENDANCE > ABSENT', () => {
  const facts = (over: Partial<Parameters<typeof resolveDay>[0]> = {}) => ({
    approvedLeave: null,
    isHoliday: false,
    isWeekOff: false,
    workedMinutes: null,
    ...over,
  });

  it('marks a day with nothing on it ABSENT', () => {
    expect(resolveDay(facts(), rules).status).toBe('ABSENT');
  });

  it('never lets ABSENT override an approved leave', () => {
    /*
      THE rule. If ABSENT could win, an employee whose leave was approved would
      still be marked absent and the approval would have achieved nothing.
    */
    expect(resolveDay(facts({ approvedLeave: { isHalfDay: false } }), rules).status).toBe('LEAVE');
  });

  it('puts approved leave above a holiday', () => {
    // So cancelling the leave cannot silently turn the day into a working one.
    const resolved = resolveDay(
      facts({ approvedLeave: { isHalfDay: false }, isHoliday: true }),
      rules,
    );
    expect(resolved.status).toBe('LEAVE');
  });

  it('puts approved leave above a week-off', () => {
    const resolved = resolveDay(
      facts({ approvedLeave: { isHalfDay: false }, isWeekOff: true }),
      rules,
    );
    expect(resolved.status).toBe('LEAVE');
  });

  it('puts approved leave above worked hours', () => {
    const resolved = resolveDay(
      facts({ approvedLeave: { isHalfDay: false }, workedMinutes: 480 }),
      rules,
    );
    expect(resolved.status).toBe('LEAVE');
  });

  it('never lets ABSENT override a holiday', () => {
    expect(resolveDay(facts({ isHoliday: true }), rules).status).toBe('HOLIDAY');
  });

  it('puts a holiday above a week-off', () => {
    // A holiday falling on a Sunday reports as the holiday, which is what a
    // payroll register needs to show.
    expect(resolveDay(facts({ isHoliday: true, isWeekOff: true }), rules).status).toBe('HOLIDAY');
  });

  it('never lets ABSENT override a week-off', () => {
    expect(resolveDay(facts({ isWeekOff: true }), rules).status).toBe('WEEK_OFF');
  });

  it('keeps a worked Sunday as WEEK_OFF', () => {
    /*
      Somebody who works a Sunday has a WEEK_OFF day with hours on it. Calling it
      PRESENT would make the week look like six working days and lose the
      overtime claim.
    */
    const resolved = resolveDay(facts({ isWeekOff: true, workedMinutes: 480 }), rules);
    expect(resolved.status).toBe('WEEK_OFF');
  });

  it('reads a full day of work as PRESENT', () => {
    expect(resolveDay(facts({ workedMinutes: 480 }), rules).status).toBe('PRESENT');
  });

  it('reads a short day as HALF_DAY or ABSENT by the thresholds', () => {
    expect(resolveDay(facts({ workedMinutes: 300 }), rules).status).toBe('HALF_DAY');
    expect(resolveDay(facts({ workedMinutes: 60 }), rules).status).toBe('ABSENT');
  });

  it('reads a half-day leave as HALF_DAY, worked or not', () => {
    expect(resolveDay(facts({ approvedLeave: { isHalfDay: true } }), rules).status).toBe('HALF_DAY');
    const withWork = resolveDay(
      facts({ approvedLeave: { isHalfDay: true }, workedMinutes: 240 }),
      rules,
    );
    // Took half, worked half — which is exactly what the status says.
    expect(withWork.status).toBe('HALF_DAY');
  });

  it('explains itself in words for the trail', () => {
    expect(resolveDay(facts({ isHoliday: true }), rules).reason).toContain('holiday');
    expect(resolveDay(facts(), rules).reason).toContain('No attendance');
  });
});

// ---------------------------------------------------------------------------
//  Session state machine
// ---------------------------------------------------------------------------

describe('the session state machine', () => {
  it('allows only clock-in from NONE', () => {
    expect(canTransitionSession('NONE', 'OPEN')).toBe(true);
    expect(canTransitionSession('NONE', 'CLOSED')).toBe(false);
    expect(canTransitionSession('NONE', 'ON_BREAK')).toBe(false);
  });

  it('allows break or clock-out from OPEN', () => {
    expect(canTransitionSession('OPEN', 'ON_BREAK')).toBe(true);
    expect(canTransitionSession('OPEN', 'CLOSED')).toBe(true);
    // No second clock-in.
    expect(canTransitionSession('OPEN', 'OPEN')).toBe(false);
  });

  it('allows only resuming from ON_BREAK', () => {
    expect(canTransitionSession('ON_BREAK', 'OPEN')).toBe(true);
    /*
      Clocking out mid-break would leave an open break with no session to sit in.
      The honest fix is to end the break first; somebody who forgot is better
      served by the correction workflow than by the system silently guessing.
    */
    expect(canTransitionSession('ON_BREAK', 'CLOSED')).toBe(false);
    expect(canTransitionSession('ON_BREAK', 'ON_BREAK')).toBe(false);
  });

  it('makes CLOSED terminal', () => {
    for (const to of ['OPEN', 'ON_BREAK', 'CLOSED', 'NONE'] as const) {
      expect(canTransitionSession('CLOSED', to), to).toBe(false);
    }
  });

  it('offers the right actions for each state', () => {
    expect(sessionActions('NONE')).toEqual({
      canClockIn: true, canClockOut: false, canStartBreak: false, canEndBreak: false,
    });
    expect(sessionActions('OPEN')).toEqual({
      canClockIn: false, canClockOut: true, canStartBreak: true, canEndBreak: false,
    });
    expect(sessionActions('ON_BREAK')).toEqual({
      canClockIn: false, canClockOut: false, canStartBreak: false, canEndBreak: true,
    });
    // After clocking out, no duplicate actions — what the brief asks for.
    expect(sessionActions('CLOSED')).toEqual({
      canClockIn: false, canClockOut: false, canStartBreak: false, canEndBreak: false,
    });
  });
});
