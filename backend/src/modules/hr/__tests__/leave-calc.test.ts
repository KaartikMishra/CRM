/**
 * Leave day counting and balance arithmetic, as pure logic.
 *
 * The working-day calculator is the one the brief insists must exist exactly
 * once, because a leave request, a balance reservation, an approval and an
 * attendance resolution all need the same answer — three of them agreeing is not
 * reassuring when the fourth is the one that moved the balance. It is pure, so
 * every awkward case the brief lists is testable here without fixtures.
 *
 * The balance arithmetic is tested against the drift that motivates it: a
 * balance is a running total, and `0.1 + 0.2 !== 0.3` in binary floating point.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateLeaveDays,
  isHoliday,
  isWeekOff,
  isWorkingDay,
  longestConsecutiveWorkingRun,
  type HolidayDay,
} from '@rs/shared';
import {
  accruedByMonth,
  applyLedgerEntry,
  availableDays,
  carryForwardDays,
  hasSufficientBalance,
  LEDGER_EFFECTS,
  type BalanceComponents,
} from '../leave.calc.js';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** Saturday and Sunday off — the default, not an assumption baked into logic. */
const weekend = { weekOffDays: [6, 7] };
/** A business that works Saturdays and takes Sunday only. */
const sundayOnly = { weekOffDays: [7] };

const noHolidays: HolidayDay[] = [];

// 2026-03-09 is a Monday; 03-14 Saturday; 03-15 Sunday; 03-16 Monday.

describe('week-offs are configurable, never assumed', () => {
  it('reads Saturday and Sunday as off under the default pattern', () => {
    expect(isWeekOff(day('2026-03-14'), weekend)).toBe(true);
    expect(isWeekOff(day('2026-03-15'), weekend)).toBe(true);
    expect(isWeekOff(day('2026-03-16'), weekend)).toBe(false);
  });

  it('reads Saturday as a working day for a business that works it', () => {
    // The reason the pattern is data rather than code: plenty of businesses do.
    expect(isWeekOff(day('2026-03-14'), sundayOnly)).toBe(false);
    expect(isWeekOff(day('2026-03-15'), sundayOnly)).toBe(true);
  });

  it('treats an empty pattern as a seven-day week', () => {
    expect(isWeekOff(day('2026-03-15'), { weekOffDays: [] })).toBe(false);
  });
});

describe('holiday scope', () => {
  const companyWide: HolidayDay = { holidayDate: day('2026-03-11'), departmentId: null };
  const engineeringOnly: HolidayDay = { holidayDate: day('2026-03-12'), departmentId: 'dept-eng' };

  it('applies a company-wide holiday to everybody', () => {
    expect(isHoliday(day('2026-03-11'), [companyWide], 'dept-eng')).toBe(true);
    expect(isHoliday(day('2026-03-11'), [companyWide], null)).toBe(true);
    expect(isHoliday(day('2026-03-11'), [companyWide], 'dept-sales')).toBe(true);
  });

  it('applies a scoped holiday only to its own department', () => {
    expect(isHoliday(day('2026-03-12'), [engineeringOnly], 'dept-eng')).toBe(true);
    expect(isHoliday(day('2026-03-12'), [engineeringOnly], 'dept-sales')).toBe(false);
    expect(isHoliday(day('2026-03-12'), [engineeringOnly], null)).toBe(false);
  });

  it('does not match a different date', () => {
    expect(isHoliday(day('2026-03-13'), [companyWide, engineeringOnly], 'dept-eng')).toBe(false);
  });
});

describe('a working day is neither a week-off nor an applicable holiday', () => {
  it('combines both rules', () => {
    const holidays: HolidayDay[] = [{ holidayDate: day('2026-03-11'), departmentId: null }];
    const opts = { workWeek: weekend, holidays, departmentId: null };

    expect(isWorkingDay(day('2026-03-10'), opts)).toBe(true);
    expect(isWorkingDay(day('2026-03-11'), opts)).toBe(false);
    expect(isWorkingDay(day('2026-03-15'), opts)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Leave day counting — every case the brief lists
// ---------------------------------------------------------------------------

describe('leave day counting', () => {
  const base = { workWeek: weekend, holidays: noHolidays, departmentId: null, isHalfDay: false };

  it('counts a single working day', () => {
    const result = calculateLeaveDays({
      ...base, startDate: day('2026-03-10'), endDate: day('2026-03-10'),
    });
    expect(result.leaveDays).toBe(1);
    expect(result.totalDays).toBe(1);
  });

  it('counts multiple working days inclusively', () => {
    // Monday to Wednesday is three days, not two.
    const result = calculateLeaveDays({
      ...base, startDate: day('2026-03-09'), endDate: day('2026-03-11'),
    });
    expect(result.leaveDays).toBe(3);
  });

  it('excludes a week-off in the middle', () => {
    /*
      Thursday to the following Monday is five calendar days but three working
      ones. Taking a week off that spans a weekend should not cost the weekend.
    */
    const result = calculateLeaveDays({
      ...base, startDate: day('2026-03-12'), endDate: day('2026-03-16'),
    });
    expect(result.totalDays).toBe(5);
    expect(result.weekOffDays).toBe(2);
    expect(result.leaveDays).toBe(3);
  });

  it('excludes a holiday in the middle', () => {
    const holidays: HolidayDay[] = [{ holidayDate: day('2026-03-10'), departmentId: null }];
    const result = calculateLeaveDays({
      ...base, holidays, startDate: day('2026-03-09'), endDate: day('2026-03-11'),
    });
    // Three calendar days, one a holiday: two days of leave.
    expect(result.holidayDays).toBe(1);
    expect(result.leaveDays).toBe(2);
  });

  it('excludes multiple holidays', () => {
    const holidays: HolidayDay[] = [
      { holidayDate: day('2026-03-10'), departmentId: null },
      { holidayDate: day('2026-03-11'), departmentId: null },
    ];
    const result = calculateLeaveDays({
      ...base, holidays, startDate: day('2026-03-09'), endDate: day('2026-03-12'),
    });
    expect(result.holidayDays).toBe(2);
    expect(result.leaveDays).toBe(2);
  });

  it('excludes a holiday at the start and at the end', () => {
    const holidays: HolidayDay[] = [
      { holidayDate: day('2026-03-09'), departmentId: null },
      { holidayDate: day('2026-03-11'), departmentId: null },
    ];
    const result = calculateLeaveDays({
      ...base, holidays, startDate: day('2026-03-09'), endDate: day('2026-03-11'),
    });
    expect(result.leaveDays).toBe(1);
  });

  it('counts a range that starts and ends on a week-off as nothing', () => {
    /*
      Saturday to Sunday costs no leave. The service refuses it as a request
      rather than storing a zero-day leave — a CHECK requires requestedDays > 0.
    */
    const result = calculateLeaveDays({
      ...base, startDate: day('2026-03-14'), endDate: day('2026-03-15'),
    });
    expect(result.leaveDays).toBe(0);
    expect(result.weekOffDays).toBe(2);
  });

  it('counts a half day as 0.5 on a working day', () => {
    const result = calculateLeaveDays({
      ...base, isHalfDay: true, startDate: day('2026-03-10'), endDate: day('2026-03-10'),
    });
    expect(result.leaveDays).toBe(0.5);
  });

  it('counts a half day on a holiday as nothing', () => {
    const holidays: HolidayDay[] = [{ holidayDate: day('2026-03-10'), departmentId: null }];
    const result = calculateLeaveDays({
      ...base, holidays, isHalfDay: true,
      startDate: day('2026-03-10'), endDate: day('2026-03-10'),
    });
    expect(result.leaveDays).toBe(0);
  });

  it('counts a holiday falling on a week-off once', () => {
    /*
      The totals are for explanation — "5 days, 1 holiday, 2 week-offs" — and
      double counting would make them not add up to totalDays.
    */
    const holidays: HolidayDay[] = [{ holidayDate: day('2026-03-15'), departmentId: null }];
    const result = calculateLeaveDays({
      ...base, holidays, startDate: day('2026-03-14'), endDate: day('2026-03-16'),
    });
    expect(result.weekOffDays).toBe(2);
    expect(result.holidayDays).toBe(0);
    expect(result.weekOffDays + result.holidayDays + result.workingDates.length).toBe(
      result.totalDays,
    );
  });

  it('lists the working dates, which attendance is written for', () => {
    const result = calculateLeaveDays({
      ...base, startDate: day('2026-03-12'), endDate: day('2026-03-16'),
    });
    expect(result.workingDates).toEqual(['2026-03-12', '2026-03-13', '2026-03-16']);
  });

  it('excludes a department holiday only for that department', () => {
    const holidays: HolidayDay[] = [{ holidayDate: day('2026-03-10'), departmentId: 'dept-eng' }];
    const forEng = calculateLeaveDays({
      ...base, holidays, departmentId: 'dept-eng',
      startDate: day('2026-03-09'), endDate: day('2026-03-11'),
    });
    const forSales = calculateLeaveDays({
      ...base, holidays, departmentId: 'dept-sales',
      startDate: day('2026-03-09'), endDate: day('2026-03-11'),
    });
    expect(forEng.leaveDays).toBe(2);
    expect(forSales.leaveDays).toBe(3);
  });
});

describe('consecutive working run, for a max-consecutive policy', () => {
  it('counts an unbroken run', () => {
    expect(
      longestConsecutiveWorkingRun({
        startDate: day('2026-03-09'), endDate: day('2026-03-13'),
        workWeek: weekend, holidays: noHolidays, departmentId: null,
      }),
    ).toBe(5);
  });

  it('is broken by a holiday, so leave either side is not one long absence', () => {
    /*
      Why this is a separate function from the day count: a policy capping
      "consecutive days" means consecutive, and counting every working day in the
      span would wrongly refuse leave either side of a public holiday.
    */
    const holidays: HolidayDay[] = [{ holidayDate: day('2026-03-11'), departmentId: null }];
    expect(
      longestConsecutiveWorkingRun({
        startDate: day('2026-03-09'), endDate: day('2026-03-13'),
        workWeek: weekend, holidays, departmentId: null,
      }),
    ).toBe(2);
  });

  it('is broken by a weekend', () => {
    expect(
      longestConsecutiveWorkingRun({
        startDate: day('2026-03-13'), endDate: day('2026-03-17'),
        workWeek: weekend, holidays: noHolidays, departmentId: null,
      }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  Balance arithmetic
// ---------------------------------------------------------------------------

const zero: BalanceComponents = {
  allocated: '0.00', accrued: '0.00', carriedForward: '0.00',
  used: '0.00', reserved: '0.00', adjusted: '0.00',
};

describe('available days is derived from the five components', () => {
  it('adds credits and subtracts debits', () => {
    expect(
      availableDays({
        ...zero, allocated: '18.00', accrued: '2.00', carriedForward: '3.00',
        used: '5.00', reserved: '1.00', adjusted: '0.50',
      }),
    ).toBe('17.50');
  });

  it('subtracts reserved, so two pending requests cannot share one day', () => {
    /*
      The subtle and important part. Without it an employee with one day left
      could apply twice and have both approved by different managers.
    */
    const withHold = { ...zero, allocated: '1.00', reserved: '1.00' };
    expect(availableDays(withHold)).toBe('0.00');
    expect(hasSufficientBalance(withHold, '1.00')).toBe(false);
  });

  it('honours a negative adjustment', () => {
    expect(availableDays({ ...zero, allocated: '10.00', adjusted: '-2.00' })).toBe('8.00');
  });

  it('does not drift over repeated half-day arithmetic', () => {
    /*
      The reason this module uses string decimals rather than JavaScript numbers.
      Twenty half days added as floats drift; added exactly they are ten.
    */
    let balance = zero;
    for (let i = 0; i < 20; i += 1) {
      balance = applyLedgerEntry(balance, { reason: 'ACCRUAL', days: '0.50' });
    }
    expect(balance.accrued).toBe('10.00');
    expect(availableDays(balance)).toBe('10.00');
  });

  it('is exact for the classic floating-point case', () => {
    let balance = applyLedgerEntry(zero, { reason: 'ACCRUAL', days: '0.10' });
    balance = applyLedgerEntry(balance, { reason: 'ACCRUAL', days: '0.20' });
    // 0.1 + 0.2 === 0.30000000000000004 as floats.
    expect(balance.accrued).toBe('0.30');
  });
});

describe('the ledger moves exactly one column, in the right direction', () => {
  it('covers every reason', () => {
    // Exhaustive over the enum, so adding a reason without a rule fails to compile
    // and is caught here if the record is ever loosened.
    expect(Object.keys(LEDGER_EFFECTS).sort()).toEqual([
      'ACCRUAL', 'ADJUSTMENT', 'ALLOCATION', 'CARRY_FORWARD', 'CONSUMPTION',
      'CONSUMPTION_REVERSAL', 'LAPSE', 'RESERVATION', 'RESERVATION_RELEASE',
    ]);
  });

  it('raises reserved when a reservation is taken', () => {
    // A RESERVATION writes negative ledger days but raises the reserved column:
    // getting this backwards is the obvious way to corrupt a balance.
    const held = applyLedgerEntry({ ...zero, allocated: '5.00' }, {
      reason: 'RESERVATION', days: '-2.00',
    });
    expect(held.reserved).toBe('2.00');
    expect(availableDays(held)).toBe('3.00');
  });

  it('lowers reserved when the hold is released', () => {
    const released = applyLedgerEntry(
      { ...zero, allocated: '5.00', reserved: '2.00' },
      { reason: 'RESERVATION_RELEASE', days: '2.00' },
    );
    expect(released.reserved).toBe('0.00');
    expect(availableDays(released)).toBe('5.00');
  });

  it('raises used on consumption and lowers it on reversal', () => {
    const spent = applyLedgerEntry({ ...zero, allocated: '5.00' }, {
      reason: 'CONSUMPTION', days: '-2.00',
    });
    expect(spent.used).toBe('2.00');
    expect(availableDays(spent)).toBe('3.00');

    const returned = applyLedgerEntry(spent, { reason: 'CONSUMPTION_REVERSAL', days: '2.00' });
    expect(returned.used).toBe('0.00');
    expect(availableDays(returned)).toBe('5.00');
  });

  it('returns a new object rather than mutating', () => {
    const before = { ...zero, allocated: '5.00' };
    applyLedgerEntry(before, { reason: 'CONSUMPTION', days: '-1.00' });
    // A caller cannot half-apply an entry and leave the balance inconsistent.
    expect(before.used).toBe('0.00');
  });
});

describe('carry forward', () => {
  it('carries everything when there is no limit', () => {
    expect(carryForwardDays({ ...zero, allocated: '7.00' }, null)).toBe('7.00');
  });

  it('caps at the limit', () => {
    expect(carryForwardDays({ ...zero, allocated: '7.00' }, '5.00')).toBe('5.00');
  });

  it('carries the lesser when under the limit', () => {
    expect(carryForwardDays({ ...zero, allocated: '3.00' }, '5.00')).toBe('3.00');
  });

  it('carries nothing from an overdrawn balance rather than a debt', () => {
    // Nobody expects last year's shortfall to reduce this year's entitlement, and
    // no policy here describes it.
    expect(carryForwardDays({ ...zero, allocated: '1.00', used: '3.00' }, null)).toBe('0.00');
  });

  it('treats a zero limit as carrying nothing, distinct from unlimited', () => {
    expect(carryForwardDays({ ...zero, allocated: '7.00' }, '0.00')).toBe('0.00');
  });
});

describe('accrual', () => {
  it('accrues per completed month', () => {
    expect(accruedByMonth('1.50', 4)).toBe('6.00');
    expect(accruedByMonth('1.50', 0)).toBe('0.00');
  });

  it('caps at twelve months and floors a partial one', () => {
    expect(accruedByMonth('1.00', 20)).toBe('12.00');
    expect(accruedByMonth('1.00', 3.9)).toBe('3.00');
  });

  it('does not drift across a full year of fractional accrual', () => {
    expect(accruedByMonth('1.25', 12)).toBe('15.00');
  });
});
