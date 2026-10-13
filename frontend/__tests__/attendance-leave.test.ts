/**
 * The HR Phase 2 frontend, asserted without a DOM.
 *
 * Two kinds of test, matching the convention in this directory:
 *
 *   1. **Pure logic**, called directly — label maps, date and duration
 *      formatting, the week-off sentence, the "what is today" description. All
 *      exported from `attendance-labels.ts` precisely so they can be tested as
 *      functions rather than through a render.
 *   2. **Structural assertions** over the source, for properties about *what the
 *      components do not do*: not computing a business figure, not sending a
 *      timestamp, not counting leave days, not offering an action the API would
 *      refuse. None of those is observable from rendered output — a page that
 *      computes the wrong number renders perfectly well.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_SESSION_STATES,
  ATTENDANCE_SOURCES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_WORK_MODES,
  ATTENDANCE_CORRECTION_STATUSES,
  HALF_DAY_PERIODS,
  LEAVE_LEDGER_REASONS,
  LEAVE_REQUEST_STATUSES,
  OVERTIME_STATUSES,
} from '@rs/shared';
import {
  ATTENDANCE_SOURCE_LABELS,
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUS_TONES,
  ATTENDANCE_WORK_MODE_LABELS,
  CORRECTION_STATUS_LABELS,
  DECISION_STATUS_TONES,
  HALF_DAY_PERIOD_LABELS,
  ISO_WEEKDAY_LABELS,
  LEAVE_LEDGER_REASON_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_STATUS_TONES,
  OVERTIME_STATUS_LABELS,
  SESSION_STATE_LABELS,
  describeToday,
  describeWeekOff,
  formatClockTime,
  formatDayRange,
  formatHrDay,
  formatLeaveDays,
  isZeroDays,
} from '@/components/hr/attendance-labels';

const root = join(import.meta.dirname, '..');
const codeOf = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/**
 * The file with its comments removed.
 *
 * Needed by the "this does not do X" assertions: these files *document* what they
 * deliberately omit, so a naive substring search matches the comment explaining
 * the absence and fails a correct file. Learned the hard way in the Phase 1 suite.
 */
function executableCodeOf(relative: string): string {
  return codeOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
//  Labels
// ---------------------------------------------------------------------------

describe('every Phase 2 enum value has a label', () => {
  /*
    The failure this prevents: `LABELS[value]` returns undefined for a value nobody
    added, and React renders nothing — so a status silently disappears from the
    board rather than erroring anywhere.
  */
  it('covers attendance statuses, with a tone each', () => {
    for (const status of ATTENDANCE_STATUSES) {
      expect(ATTENDANCE_STATUS_LABELS[status], status).toBeTruthy();
      expect(ATTENDANCE_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('covers work modes, session states and sources', () => {
    for (const mode of ATTENDANCE_WORK_MODES) {
      expect(ATTENDANCE_WORK_MODE_LABELS[mode], mode).toBeTruthy();
    }
    for (const state of ATTENDANCE_SESSION_STATES) {
      expect(SESSION_STATE_LABELS[state], state).toBeTruthy();
    }
    for (const source of ATTENDANCE_SOURCES) {
      expect(ATTENDANCE_SOURCE_LABELS[source], source).toBeTruthy();
    }
  });

  it('covers correction, overtime and leave statuses', () => {
    for (const status of ATTENDANCE_CORRECTION_STATUSES) {
      expect(CORRECTION_STATUS_LABELS[status], status).toBeTruthy();
      expect(DECISION_STATUS_TONES[status], status).toBeTruthy();
    }
    for (const status of OVERTIME_STATUSES) {
      expect(OVERTIME_STATUS_LABELS[status], status).toBeTruthy();
    }
    for (const status of LEAVE_REQUEST_STATUSES) {
      expect(LEAVE_STATUS_LABELS[status], status).toBeTruthy();
      expect(LEAVE_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('covers half-day periods and every ledger reason', () => {
    for (const period of HALF_DAY_PERIODS) {
      expect(HALF_DAY_PERIOD_LABELS[period], period).toBeTruthy();
    }
    for (const reason of LEAVE_LEDGER_REASONS) {
      expect(LEAVE_LEDGER_REASON_LABELS[reason], reason).toBeTruthy();
    }
  });

  it('shows no enum name to a person', () => {
    const all = [
      ...Object.values(ATTENDANCE_STATUS_LABELS),
      ...Object.values(LEAVE_STATUS_LABELS),
      ...Object.values(LEAVE_LEDGER_REASON_LABELS),
    ];
    // An enum member on screen is a leaked implementation detail. "RESERVATION_
    // RELEASE" explains nothing to an employee disputing a balance.
    for (const label of all) {
      expect(label).not.toMatch(/^[A-Z][A-Z_]+$/);
    }
  });

  it('marks ABSENT as the one critical status', () => {
    /*
      Deliberate: ABSENT is the status that costs somebody something. HOLIDAY and
      WEEK_OFF are outline rather than neutral so a glance down a month
      distinguishes "the office was shut" from "nothing recorded" — those read very
      differently on a timesheet.
    */
    expect(ATTENDANCE_STATUS_TONES.ABSENT).toBe('critical');
    expect(ATTENDANCE_STATUS_TONES.PRESENT).toBe('positive');
    expect(ATTENDANCE_STATUS_TONES.HOLIDAY).toBe('outline');
    expect(ATTENDANCE_STATUS_TONES.WEEK_OFF).toBe('outline');
  });
});

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

describe('clock times render in company time', () => {
  it('renders an instant as the IST wall clock', () => {
    /*
      04:15 UTC is 09:45 IST. Rendering in the browser's zone would make the same
      record read differently to two colleagues, so the zone is fixed.
    */
    expect(formatClockTime('2026-03-12T04:15:00.000Z')).toBe('09:45');
  });

  it('renders a late-evening instant against the right clock', () => {
    // 19:00 UTC is 00:30 IST the next day — the boundary case.
    expect(formatClockTime('2026-03-11T19:00:00.000Z')).toBe('00:30');
  });

  it('shows a dash for an absent or unparseable time', () => {
    expect(formatClockTime(null)).toBe('—');
    expect(formatClockTime('not-a-time')).toBe('—');
  });
});

describe('calendar days render as stored', () => {
  it('renders a date-only value without shifting it', () => {
    /*
      These are `@db.Date` values at midnight UTC. Rendering in a negative offset
      would show the previous day, so somebody's leave would appear to start a day
      early for half the world.
    */
    expect(formatHrDay('2026-03-12')).toBe('12 Mar 2026');
    expect(formatHrDay('2026-03-12T00:00:00.000Z')).toBe('12 Mar 2026');
  });

  it('collapses a single-day range rather than repeating it', () => {
    expect(formatDayRange('2026-03-12', '2026-03-12')).toBe('12 Mar 2026');
    expect(formatDayRange('2026-03-12', '2026-03-14')).toContain('—');
  });

  it('shows a dash for an absent day', () => {
    expect(formatHrDay(null)).toBe('—');
  });
});

describe('leave day counts', () => {
  it('trims a whole number and keeps a half', () => {
    expect(formatLeaveDays('1.00')).toBe('1 day');
    expect(formatLeaveDays('3.00')).toBe('3 days');
    expect(formatLeaveDays('0.50')).toBe('0.5 days');
    expect(formatLeaveDays('2.50')).toBe('2.5 days');
  });

  it('recognises zero in every canonical form', () => {
    // Compared as strings rather than with Number(): a balance is the one figure
    // where "nearly zero" must not read as zero.
    expect(isZeroDays('0.00')).toBe(true);
    expect(isZeroDays('0')).toBe(true);
    expect(isZeroDays('0.50')).toBe(false);
    expect(isZeroDays('1.00')).toBe(false);
  });
});

describe('the week-off sentence', () => {
  it('names the days, ISO-numbered with Monday first', () => {
    expect(ISO_WEEKDAY_LABELS[1]).toBe('Monday');
    expect(ISO_WEEKDAY_LABELS[7]).toBe('Sunday');
    expect(describeWeekOff([6, 7])).toBe('Saturday and Sunday off');
    expect(describeWeekOff([7])).toBe('Sunday off');
  });

  it('says so when there is no weekly off', () => {
    // Not an error: plenty of businesses work seven days, and the policy stores an
    // empty array for exactly that.
    expect(describeWeekOff([])).toContain('No weekly off');
  });

  it('sorts the days rather than echoing the stored order', () => {
    expect(describeWeekOff([7, 6])).toBe('Saturday and Sunday off');
  });
});

describe('the day description', () => {
  const base = { isHoliday: false, isWeekOff: false, onLeave: false, record: null };

  it('puts leave above holiday and week-off, matching the resolution precedence', () => {
    expect(describeToday({ ...base, onLeave: true, isHoliday: true })).toContain('leave');
    expect(describeToday({ ...base, isHoliday: true, isWeekOff: true })).toContain('holiday');
    expect(describeToday({ ...base, isWeekOff: true })).toContain('weekly off');
  });

  it('describes each session state', () => {
    expect(describeToday({ ...base, record: { sessionState: 'OPEN' } })).toContain('clocked in');
    expect(describeToday({ ...base, record: { sessionState: 'ON_BREAK' } })).toContain('break');
    expect(describeToday({ ...base, record: { sessionState: 'CLOSED' } })).toContain('finished');
    expect(describeToday(base)).toContain('not clocked in');
  });
});

// ---------------------------------------------------------------------------
//  The clock widget
// ---------------------------------------------------------------------------

describe('the attendance clock', () => {
  const source = codeOf('components/hr/attendance-clock.tsx');
  const code = executableCodeOf('components/hr/attendance-clock.tsx');

  it('drives every button from the server’s flags', () => {
    /*
      The central property. The service decides what is possible from the session
      state machine; re-deriving it here would mean two implementations drifting,
      and a stale page would offer actions the API refuses.
    */
    for (const flag of ['canClockIn', 'canClockOut', 'canStartBreak', 'canEndBreak']) {
      expect(code, flag).toContain(`today.${flag}`);
    }
  });

  it('never computes a session state of its own', () => {
    // No local state machine: no comparing clockInAt against clockOutAt to decide
    // what to show.
    expect(code).not.toMatch(/sessionState\s*===\s*'OPEN'\s*\?/);
    expect(code).not.toContain('canTransitionSession');
  });

  it('sends no timestamp with any action', () => {
    /*
      A browser clock can be wrong by hours or set deliberately, and attendance is
      exactly the feature somebody would try that on — so there is no field to try
      it with. The moment comes from Postgres.
    */
    expect(code).not.toContain('clockInAt:');
    expect(code).not.toContain('clockOutAt:');
    expect(code).not.toContain('new Date()');
    expect(code).not.toContain('Date.now()');
  });

  it('computes no duration, using the shared formatter instead', () => {
    expect(code).toContain('formatMinutes');
    // No arithmetic on minutes: they were frozen at clock-out against the policy in
    // force then, and recomputing would restate history.
    expect(code).not.toMatch(/workedMinutes\s*[-+*/]/);
    expect(code).not.toMatch(/\/\s*60\b/);
  });

  it('relays the API message rather than paraphrasing it', () => {
    expect(code).toContain('result.message');
  });

  it('shows a completed state rather than disabled buttons', () => {
    // A greyed-out "Clock in" invites clicking; saying the day is recorded explains
    // why there is nothing to press.
    expect(source).toContain('Your day is recorded');
  });

  it('offers work mode only at clock-in', () => {
    // Changing it mid-session would make the record ambiguous about where the day
    // was worked; HR amends it through a correction.
    expect(source).toContain('today.canClockIn && (');
  });
});

// ---------------------------------------------------------------------------
//  The attendance board
// ---------------------------------------------------------------------------

describe('the attendance table', () => {
  const source = codeOf('components/hr/attendance-table.tsx');
  const code = executableCodeOf('components/hr/attendance-table.tsx');

  it('renders loading, empty and error states through the page', () => {
    // The table owns the empty state; the page owns error and loading, which is
    // where the fetch result lives.
    expect(source).toContain('EmptyState');
    expect(source).toContain('rows.length === 0');
  });

  it('distinguishes a filtered empty result from an empty one', () => {
    expect(source).toContain('filtered');
    expect(source).toContain('Try widening');
  });

  it('computes no figure of its own', () => {
    expect(code).toContain('formatMinutes');
    expect(code).not.toMatch(/\.reduce\(/);
    expect(code).not.toMatch(/workedMinutes\s*\+/);
  });

  it('makes no access decision', () => {
    // The rows a viewer sees are decided server-side by the scope rules. A filter
    // here would be a permission decision in the browser.
    expect(code).not.toContain('can(');
    expect(code).not.toContain('requireModule');
  });

  it('shows the record source, so a corrected day is visible as one', () => {
    expect(source).toContain('ATTENDANCE_SOURCE_LABELS');
  });

  it('scrolls sideways rather than overflowing', () => {
    expect(source).toContain('overflow-x-auto');
  });
});

describe('the attendance page', () => {
  const source = codeOf('app/(app)/hr/attendance/page.tsx');

  it('does not block an employee with no HR permission', () => {
    /*
      Deliberate, and the thing most likely to be "fixed" into a bug: an ordinary
      employee must be able to clock in without an HR grant, or every employee
      needs one and the grant stops meaning anything.
    */
    expect(source).toContain('requireModule');
    expect(source).not.toMatch(/if\s*\(!access\.allowed\)\s*return\s*<NoModuleAccess/);
  });

  it('gates the board and the queue on HR_ATTENDANCE:VIEW', () => {
    expect(source).toContain("can(access.user, 'HR_ATTENDANCE', 'VIEW')");
  });

  it('renders error states for every fetch', () => {
    expect(source).toContain('ErrorMessage');
    expect(source).toContain('!todayResult.success');
    expect(source).toContain('!boardResult.success');
  });

  it('links the settings page only for HR_ADMIN', () => {
    expect(source).toContain("can(access.user, 'HR_ADMIN', 'VIEW')");
  });
});

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

describe('the correction panel', () => {
  const source = codeOf('components/hr/correction-panel.tsx');
  const code = executableCodeOf('components/hr/correction-panel.tsx');

  it('requires a reason to raise one', () => {
    expect(code).toContain('Say what needs correcting');
  });

  it('requires at least one requested change', () => {
    // The same rule the API and a CHECK both enforce: a correction that asks for
    // nothing is not a correction.
    expect(code).toContain('Ask for at least one change');
  });

  it('requires a reason to reject', () => {
    expect(code).toContain('Say why this is being rejected');
  });

  it('shows both the current and the requested values', () => {
    // The request snapshots what the record held, so a reviewer sees the change
    // without the record having been mutated first.
    expect(source).toContain('currentClockInAt');
    expect(source).toContain('requestedClockInAt');
  });

  it('offers a decision only on a pending request', () => {
    // The UI half of the double-decision guard; the conditional update in the
    // repository is the half that holds under concurrency.
    expect(code).toContain("correction.status === 'PENDING'");
  });

  it('sends requested times with an explicit company offset', () => {
    /*
      A bare local time would be read in the browser's zone, so a colleague abroad
      would correct the wrong hour. This is the one place a client timestamp is
      legitimate — it is a request somebody reviews.
    */
    expect(code).toContain('+05:30');
  });
});

// ---------------------------------------------------------------------------
//  Leave
// ---------------------------------------------------------------------------

describe('the leave apply form', () => {
  const source = codeOf('components/hr/leave-apply-form.tsx');
  const code = executableCodeOf('components/hr/leave-apply-form.tsx');

  it('reads the day count from the server', () => {
    /*
      THE property. A browser that excluded weekends but not holidays would promise
      two days and the balance would take three — which is exactly why the
      calculator is shared and why this form must not have one.
    */
    expect(code).toContain('/api/hr/leave/preview');
    expect(code).toContain('setPreview');
  });

  it('counts no days itself', () => {
    /*
      It reads `preview.weekOffDays` to *display* the breakdown, which is the point
      — so the assertion is about owning the calculation, not mentioning its
      output. What must be absent: the calculator, a week-off pattern of its own,
      day arithmetic, and any weekday derivation.
    */
    expect(code).not.toContain('calculateLeaveDays');
    expect(code).not.toContain('isWorkingDay');
    // No week-off pattern of its own — only the server's figure, read off preview.
    expect(code).not.toMatch(/weekOffDays\s*[:=]\s*\[/);
    expect(code).not.toMatch(/weekOffDays\.includes/);
    // No day arithmetic.
    expect(code).not.toMatch(/86[_,]?400[_,]?000/);
    expect(code).not.toMatch(/getUTCDay\(/);
    expect(code).not.toMatch(/getDay\(/);
  });

  it('shows the breakdown, so the figure is explainable', () => {
    expect(source).toContain('holidayDays');
    expect(source).toContain('weekOffDays');
    expect(source).toContain('calendar');
  });

  it('shows the available balance beside the choice', () => {
    expect(source).toContain('balance.available');
  });

  it('validates the obvious cases before submitting', () => {
    expect(code).toContain('The end date cannot be before the start date');
    expect(code).toContain('A half day covers a single date');
    expect(code).toContain('Say which half of the day');
  });

  it('keeps the end date in step for a half day', () => {
    // Rather than letting somebody build a state the API will refuse.
    expect(code).toContain('setEndDate(startDate)');
  });

  it('offers half day only when the type allows it', () => {
    expect(source).toContain('selectedType?.halfDayAllowed');
  });

  it('disables submission while in flight', () => {
    expect(source).toContain('disabled={pending}');
  });
});

describe('the leave request list', () => {
  const source = codeOf('components/hr/leave-requests.tsx');
  const code = executableCodeOf('components/hr/leave-requests.tsx');

  it('never offers a decision on one’s own request', () => {
    // Nobody decides their own; the service refuses it, so the button would be a
    // guaranteed failure.
    expect(code).toContain('!isOwn');
  });

  it('offers a decision only while pending', () => {
    expect(code).toContain("request.status === 'PENDING'");
  });

  it('requires a reason to reject', () => {
    expect(code).toContain('Say why this is being rejected');
  });

  it('offers cancellation only where the API would allow it', () => {
    /*
      Pending, or approved and still in the future — mirroring the service, which
      refuses to reverse leave that has already started because that is attendance
      history. A button the API would reject is worse than no button.
    */
    expect(code).toContain('startsInFuture');
    expect(code).toContain("request.status === 'APPROVED' && startsInFuture");
  });

  it('shows the balance components beside available, so a figure is defensible', () => {
    expect(source).toContain('allocated');
    expect(source).toContain('used');
    expect(source).toContain('held');
  });

  it('computes no balance of its own', () => {
    expect(code).not.toMatch(/available\s*[-+]/);
    expect(code).not.toContain('availableDays');
  });

  it('renders loading, empty and error states', () => {
    expect(source).toContain('EmptyState');
    expect(source).toContain('requests.length === 0');
    expect(source).toContain('disabled={pending}');
  });
});

describe('the leave page', () => {
  const source = codeOf('app/(app)/hr/leave/page.tsx');

  it('does not block an employee with no HR permission', () => {
    expect(source).toContain('requireModule');
    expect(source).not.toMatch(/if\s*\(!access\.allowed\)\s*return\s*<NoModuleAccess/);
  });

  it('separates one’s own requests from the approval queue', () => {
    // Which is what stops the queue showing work nobody can do.
    expect(source).toContain("mine: 'true'");
    expect(source).toContain('canDecide={false}');
  });

  it('renders an error state for every fetch', () => {
    expect(source).toContain('ErrorMessage');
    expect(source).toContain('!balances.success');
    expect(source).toContain('!own.success');
  });
});

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------

describe('the settings pages', () => {
  it('gate on HR_ADMIN and block direct access', () => {
    for (const page of [
      'app/(app)/hr/attendance/settings/page.tsx',
      'app/(app)/hr/leave/settings/page.tsx',
    ]) {
      const source = codeOf(page);
      expect(source, page).toContain("requireModule('HR_ADMIN')");
      // Unlike the employee-facing pages, these DO block: configuration is not
      // something an ordinary employee has a scoped view of.
      expect(source, page).toMatch(/if\s*\(!access\.allowed\)\s*return\s*<NoModuleAccess/);
    }
  });

  it('render empty states that explain the fallback', () => {
    const source = codeOf('app/(app)/hr/attendance/settings/page.tsx');
    // An honest statement of what happens with no policy, rather than implying
    // attendance is broken until somebody configures one.
    expect(source).toContain('falls back to');
  });

  it('assume no national holiday calendar', () => {
    const source = codeOf('app/(app)/hr/attendance/settings/page.tsx');
    expect(source).toContain('no national calendar is assumed');
  });
});

// ---------------------------------------------------------------------------
//  Server actions
// ---------------------------------------------------------------------------

describe('the Phase 2 server actions', () => {
  const code = executableCodeOf('app/(app)/hr/attendance-actions.ts');

  it('send no timestamp for clocking', () => {
    expect(code).not.toContain('clockInAt');
    expect(code).not.toContain('clockOutAt');
    expect(code).not.toContain('Date.now()');
  });

  it('compute no leave days', () => {
    expect(code).not.toContain('requestedDays');
    expect(code).not.toContain('calculateLeaveDays');
  });

  it('revalidate the HR landing as well as the page edited', () => {
    // Today's state, the board and the overview counts all derive from the rows
    // these writes touch.
    expect(code).toContain("'/hr/attendance'");
    expect(code).toContain("'/hr/leave'");
    expect(code).toContain("'/hr'");
  });

  it('relay the backend answer rather than deciding anything', () => {
    expect(code).toContain('result.message');
    expect(code).toContain('result.code');
    expect(code).toContain('result.details');
  });
});

// ---------------------------------------------------------------------------
//  The API client
// ---------------------------------------------------------------------------

describe('the Phase 2 API client', () => {
  const code = executableCodeOf('lib/attendance-api.ts');

  it('contains no writer, so mutations go through server actions', () => {
    // The session token never reaches the browser.
    expect(code).not.toContain("method: 'POST'");
    expect(code).not.toContain("method: 'PATCH'");
  });

  it('reads the day preview rather than computing it', () => {
    expect(code).toContain('/api/hr/leave/preview');
  });
});
