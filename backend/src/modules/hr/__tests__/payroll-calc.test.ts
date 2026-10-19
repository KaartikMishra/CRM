/**
 * Payroll arithmetic, as pure unit tests.
 *
 * No database and no HTTP: every function under test is a pure function of its
 * arguments, which is the whole reason the calculation lives in
 * `payroll.calc.ts` and `payroll-money.ts` rather than inside a service.
 *
 * What these cover, against the acceptance checks:
 *
 *   - proration under **both** supported divisor settings, and the third
 *   - unpaid leave reducing pay, and only the components configured to prorate
 *   - rounding boundaries under all three modes
 *   - zero-value and empty cases
 *   - deductions counted **exactly once**
 *   - employer contributions **not** reducing net pay
 *   - a missing overtime multiplier producing an explicit warning, never a guess
 *   - FINALIZED being terminal in the state machine
 */

import { describe, expect, it } from 'vitest';
import {
  calendarDaysInMonth,
  dailyRate,
  isNegativeAmount,
  overtimeValue,
  percentOfAmount,
  prorateAmount,
  roundAmount,
} from '@rs/shared';
import {
  calculateEmployeePay,
  canMovePeriod,
  eligibilityFor,
  payableDaysFor,
  periodBounds,
  periodTotals,
  resolveDivisor,
  validateComponentSet,
  type CalcAttendance,
  type CalcComponent,
  type CalcPolicy,
} from '../payroll.calc.js';

// ---------------------------------------------------------------------------
//  Fixtures
// ---------------------------------------------------------------------------

const basic = (over: Partial<CalcComponent> = {}): CalcComponent => ({
  code: 'BASIC',
  name: 'Basic',
  kind: 'EARNING',
  calculation: 'FIXED',
  rate: null,
  amount: '30000.00',
  capAmount: null,
  floorAmount: null,
  isBase: true,
  prorates: true,
  displayOrder: 10,
  ...over,
});

const hra = (over: Partial<CalcComponent> = {}): CalcComponent => ({
  code: 'HRA',
  name: 'House Rent Allowance',
  kind: 'EARNING',
  calculation: 'PERCENT_OF_BASE',
  rate: '40.00',
  amount: null,
  capAmount: null,
  floorAmount: null,
  isBase: false,
  prorates: true,
  displayOrder: 20,
  ...over,
});

const special = (over: Partial<CalcComponent> = {}): CalcComponent => ({
  code: 'SPECIAL',
  name: 'Special Allowance',
  kind: 'EARNING',
  calculation: 'FORMULA_BALANCE',
  rate: null,
  amount: null,
  capAmount: null,
  floorAmount: null,
  isBase: false,
  prorates: true,
  displayOrder: 30,
  ...over,
});

const pfEmployee = (over: Partial<CalcComponent> = {}): CalcComponent => ({
  code: 'PF_EMPLOYEE',
  name: 'Provident Fund',
  kind: 'DEDUCTION',
  calculation: 'PERCENT_OF_BASE',
  rate: '12.00',
  amount: null,
  capAmount: null,
  floorAmount: null,
  isBase: false,
  prorates: false,
  displayOrder: 40,
  ...over,
});

const pfEmployer = (over: Partial<CalcComponent> = {}): CalcComponent => ({
  code: 'PF_EMPLOYER',
  name: 'Provident Fund (employer)',
  kind: 'EMPLOYER_CONTRIBUTION',
  calculation: 'PERCENT_OF_BASE',
  rate: '12.00',
  amount: null,
  capAmount: null,
  floorAmount: null,
  isBase: false,
  prorates: false,
  displayOrder: 50,
  ...over,
});

const fullMonth = (days: number): CalcAttendance => ({
  presentDays: String(days - 6) + '.00',
  paidLeaveDays: '0.00',
  unpaidLeaveDays: '0.00',
  holidayDays: '1.00',
  weekOffDays: '5.00',
  overtimeMinutes: 0,
});

const policy = (over: Partial<CalcPolicy> = {}): CalcPolicy => ({
  basis: 'CALENDAR_DAYS',
  rounding: 'HALF_UP',
  calendarDays: 31,
  workingDays: 26,
  overtimeMultiplier: null,
  standardDayMinutes: null,
  ...over,
});

const lineFor = (
  result: ReturnType<typeof calculateEmployeePay>,
  code: string,
): { amount: string; fullAmount: string } | undefined => {
  const line = result.lines.find((l) => l.componentCode === code);
  return line ? { amount: line.amount, fullAmount: line.fullAmount } : undefined;
};

// ---------------------------------------------------------------------------
//  Money primitives
// ---------------------------------------------------------------------------

describe('monetary precision', () => {
  it('computes a whole percentage exactly', () => {
    expect(percentOfAmount('50000.00', '12')).toBe('6000.00');
  });

  it('computes a fractional percentage exactly', () => {
    // 0.75% of 21000 is 157.50 — the case a whole-number-percent helper cannot do.
    expect(percentOfAmount('21000.00', '0.75')).toBe('157.50');
    expect(percentOfAmount('18000.00', '4.81')).toBe('865.80');
  });

  it('returns zero for a zero rate rather than throwing', () => {
    expect(percentOfAmount('50000.00', '0')).toBe('0.00');
  });

  it('never produces a float artefact', () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    expect(percentOfAmount('0.30', '100')).toBe('0.30');
    expect(roundAmount('0.1', 'HALF_UP')).toBe('0.10');
  });
});

describe('rounding boundaries', () => {
  it('rounds a half paisa up under HALF_UP', () => {
    expect(roundAmount('2.005', 'HALF_UP')).toBe('2.01');
    expect(dailyRate('0.05', 2, 'HALF_UP')).toBe('0.03');
  });

  it('rounds a half paisa to the even neighbour under HALF_EVEN', () => {
    // 0.025 -> 0.02 because 2 is even; this is the whole difference from HALF_UP.
    expect(dailyRate('0.05', 2, 'HALF_EVEN')).toBe('0.02');
    expect(roundAmount('2.005', 'HALF_EVEN')).toBe('2.00');
    expect(roundAmount('2.015', 'HALF_EVEN')).toBe('2.02');
  });

  it('truncates toward zero under DOWN', () => {
    expect(dailyRate('0.05', 2, 'DOWN')).toBe('0.02');
    expect(roundAmount('2.009', 'DOWN')).toBe('2.00');
  });

  it('leaves a figure already at two decimals untouched under every mode', () => {
    for (const mode of ['HALF_UP', 'HALF_EVEN', 'DOWN'] as const) {
      expect(roundAmount('1234.56', mode)).toBe('1234.56');
    }
  });

  it('refuses a zero divisor rather than returning Infinity', () => {
    expect(() => dailyRate('100.00', 0)).toThrow(/positive whole day count/);
    expect(() => prorateAmount('100.00', 1, 0)).toThrow(/positive whole divisor/);
  });
});

describe('proration', () => {
  it('pays a full month exactly, with no rounding applied', () => {
    // The short-circuit matters: 50000/31*31 through integer division would not
    // necessarily return 50000.00, and an employee present all month must be paid
    // precisely their stated salary.
    expect(prorateAmount('50000.00', 31, 31)).toBe('50000.00');
    expect(prorateAmount('50000.00', 40, 31)).toBe('50000.00');
  });

  it('rounds once rather than multiplying a rounded daily rate', () => {
    // 10000/31*15: one division gives 4838.71. dailyRate(10000,31) is 322.58,
    // and 322.58*15 is 4838.70 — a paisa adrift, which compounds per employee.
    expect(prorateAmount('10000.00', 15, 31)).toBe('4838.71');
  });

  it('returns zero for zero payable days', () => {
    expect(prorateAmount('50000.00', 0, 31)).toBe('0.00');
  });
});

describe('overtime', () => {
  it('values minutes at a configured multiplier', () => {
    // 1000/day over a 480-minute day is 2.0833/min; 60 min at 1.5x is 187.50.
    expect(overtimeValue('1000.00', 480, 60, '1.00')).toBe('125.00');
    expect(overtimeValue('1000.00', 480, 60, '1.50')).toBe('187.50');
    expect(overtimeValue('1000.00', 480, 60, '2.00')).toBe('250.00');
  });

  it('values a full extra day as exactly one day at 1x', () => {
    expect(overtimeValue('1000.00', 480, 480, '1.00')).toBe('1000.00');
  });

  it('rounds once over the whole span rather than per minute', () => {
    // 100 separate one-minute roundings would give 100 x 2.08 = 208.00.
    expect(overtimeValue('1000.00', 480, 1, '1.00')).toBe('2.08');
    expect(overtimeValue('1000.00', 480, 100, '1.00')).toBe('208.33');
  });

  it('returns zero for zero minutes', () => {
    expect(overtimeValue('1000.00', 480, 0, '1.50')).toBe('0.00');
  });

  it('refuses a zero-length working day', () => {
    expect(() => overtimeValue('1000.00', 0, 60, '1.50')).toThrow(/positive working day/);
  });
});

describe('calendar arithmetic', () => {
  it('knows the length of every month, leap years included', () => {
    expect(calendarDaysInMonth(2026, 1)).toBe(31);
    expect(calendarDaysInMonth(2026, 2)).toBe(28);
    expect(calendarDaysInMonth(2024, 2)).toBe(29);
    expect(calendarDaysInMonth(2026, 4)).toBe(30);
    expect(calendarDaysInMonth(2000, 2)).toBe(29);
    expect(calendarDaysInMonth(1900, 2)).toBe(28);
  });

  it('refuses a month outside 1-12', () => {
    expect(() => calendarDaysInMonth(2026, 0)).toThrow(/Not a month/);
    expect(() => calendarDaysInMonth(2026, 13)).toThrow(/Not a month/);
  });

  it('derives period bounds from year and month', () => {
    const feb = periodBounds(2026, 2);
    expect(feb.calendarDays).toBe(28);
    expect(feb.periodStart.toISOString().slice(0, 10)).toBe('2026-02-01');
    expect(feb.periodEnd.toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

// ---------------------------------------------------------------------------
//  Divisor basis — acceptance check 8
// ---------------------------------------------------------------------------

describe('the divisor basis', () => {
  it('uses the calendar length under CALENDAR_DAYS', () => {
    expect(resolveDivisor(policy({ basis: 'CALENDAR_DAYS', calendarDays: 28 }))).toEqual({
      divisor: 28,
      fellBack: false,
    });
  });

  it('uses the working-day count under WORKING_DAYS', () => {
    expect(resolveDivisor(policy({ basis: 'WORKING_DAYS', workingDays: 26 }))).toEqual({
      divisor: 26,
      fellBack: false,
    });
  });

  it('always uses 30 under FIXED_THIRTY, whatever the month', () => {
    expect(resolveDivisor(policy({ basis: 'FIXED_THIRTY', calendarDays: 28 })).divisor).toBe(30);
    expect(resolveDivisor(policy({ basis: 'FIXED_THIRTY', calendarDays: 31 })).divisor).toBe(30);
  });

  it('falls back from WORKING_DAYS to calendar days and SAYS SO', () => {
    // The flag is the point: a silent fallback would change everybody's pay with
    // nothing recording that it happened.
    const resolved = resolveDivisor(policy({ basis: 'WORKING_DAYS', workingDays: 0 }));
    expect(resolved).toEqual({ divisor: 31, fellBack: true });
  });

  it('prorates the same salary differently under each basis, as configured', () => {
    // The three bases genuinely disagree, which is why the choice is stored per
    // period rather than derived at read time.
    const under = (p: CalcPolicy): string => {
      const { divisor } = resolveDivisor(p);
      return prorateAmount('31000.00', 15, divisor, 'HALF_UP');
    };
    expect(under(policy({ basis: 'CALENDAR_DAYS', calendarDays: 31 }))).toBe('15000.00');
    expect(under(policy({ basis: 'FIXED_THIRTY' }))).toBe('15500.00');
    expect(under(policy({ basis: 'WORKING_DAYS', workingDays: 26 }))).toBe('17884.62');
  });
});

describe('payable days', () => {
  it('counts present, paid leave, holidays and week-offs', () => {
    expect(
      payableDaysFor({
        presentDays: '20.00',
        paidLeaveDays: '2.00',
        unpaidLeaveDays: '3.00',
        holidayDays: '1.00',
        weekOffDays: '5.00',
        overtimeMinutes: 0,
      }),
    ).toBe('28.00');
  });

  it('excludes unpaid leave, which is the only thing that reduces pay', () => {
    const withUnpaid = payableDaysFor({
      presentDays: '20.00',
      paidLeaveDays: '0.00',
      unpaidLeaveDays: '5.00',
      holidayDays: '1.00',
      weekOffDays: '5.00',
      overtimeMinutes: 0,
    });
    expect(withUnpaid).toBe('26.00');
  });

  it('handles an all-zero month without producing NaN', () => {
    expect(
      payableDaysFor({
        presentDays: '0.00',
        paidLeaveDays: '0.00',
        unpaidLeaveDays: '0.00',
        holidayDays: '0.00',
        weekOffDays: '0.00',
        overtimeMinutes: 0,
      }),
    ).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
//  Component set validation
// ---------------------------------------------------------------------------

describe('component set validation', () => {
  it('accepts a coherent set', () => {
    expect(validateComponentSet([basic(), hra(), special(), pfEmployee()])).toEqual([]);
  });

  it('refuses two base components', () => {
    const problems = validateComponentSet([basic(), basic({ code: 'BASIC2', name: 'Other' })]);
    expect(problems.join(' ')).toMatch(/More than one base component/);
  });

  it('refuses a percentage with no base to take a percentage of', () => {
    const problems = validateComponentSet([basic({ isBase: false }), hra()]);
    expect(problems.join(' ')).toMatch(/no component is marked as the base/);
  });

  it('refuses a percentage component with no rate', () => {
    const problems = validateComponentSet([basic(), hra({ rate: null })]);
    expect(problems.join(' ')).toMatch(/percentage component with no rate/);
  });

  it('refuses a fixed component with no amount', () => {
    const problems = validateComponentSet([basic({ amount: null })]);
    expect(problems.join(' ')).toMatch(/fixed component with no amount/);
  });

  it('refuses two balancing components', () => {
    const problems = validateComponentSet([
      basic(),
      special(),
      special({ code: 'SPECIAL2', name: 'Another' }),
    ]);
    expect(problems.join(' ')).toMatch(/More than one balancing component/);
  });

  it('refuses a duplicated code', () => {
    const problems = validateComponentSet([basic(), basic()]);
    expect(problems.join(' ')).toMatch(/appears twice/);
  });
});

// ---------------------------------------------------------------------------
//  The calculation itself
// ---------------------------------------------------------------------------

describe('a full month', () => {
  const result = calculateEmployeePay({
    monthlyGross: '50000.00',
    components: [basic(), hra(), special(), pfEmployee(), pfEmployer()],
    attendance: fullMonth(31),
    policy: policy(),
    adjustments: [],
  });

  it('resolves the balancing component so gross equals the agreed figure', () => {
    // 30000 basic + 12000 HRA leaves 8000 for the special allowance.
    expect(lineFor(result, 'SPECIAL')?.amount).toBe('8000.00');
    expect(result.grossEarnings).toBe('50000.00');
  });

  it('computes a percentage of the base, not of the gross', () => {
    expect(lineFor(result, 'HRA')?.amount).toBe('12000.00');
  });

  it('counts each configured deduction exactly once', () => {
    const deductionLines = result.lines.filter((l) => l.kind === 'DEDUCTION');
    expect(deductionLines).toHaveLength(1);
    expect(deductionLines[0]?.componentCode).toBe('PF_EMPLOYEE');
    expect(result.totalDeductions).toBe('3600.00');
  });

  it('does NOT reduce net pay by the employer contribution', () => {
    // The rule: an employer's share never passes through the employee's hands, so
    // netting it off would understate what they were paid.
    expect(result.employerContributions).toBe('3600.00');
    expect(result.netPay).toBe('46400.00'); // 50000 - 3600, employer share excluded
  });

  it('reports a negative net as false for a healthy payslip', () => {
    expect(result.isNegativeNet).toBe(false);
  });
});

describe('caps and floors are configuration, not statute', () => {
  it('applies a configured cap to a percentage deduction', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special(), pfEmployee({ capAmount: '1800.00' })],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [],
    });
    // 12% of 30000 is 3600; the configured cap takes it to 1800.
    expect(lineFor(result, 'PF_EMPLOYEE')?.fullAmount).toBe('3600.00');
    expect(lineFor(result, 'PF_EMPLOYEE')?.amount).toBe('1800.00');
    expect(result.totalDeductions).toBe('1800.00');
  });

  it('withholds a component entirely below its configured gross floor', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special(), pfEmployee({ floorAmount: '90000.00' })],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [],
    });
    expect(lineFor(result, 'PF_EMPLOYEE')?.amount).toBe('0.00');
    expect(result.totalDeductions).toBe('0.00');
  });
});

describe('unpaid leave', () => {
  const withUnpaid = calculateEmployeePay({
    monthlyGross: '50000.00',
    components: [basic(), hra(), special(), pfEmployee({ prorates: false })],
    attendance: {
      presentDays: '20.00',
      paidLeaveDays: '0.00',
      unpaidLeaveDays: '5.00',
      holidayDays: '1.00',
      weekOffDays: '5.00',
      overtimeMinutes: 0,
    },
    policy: policy({ calendarDays: 31 }),
    adjustments: [],
  });

  it('reduces earnings in proportion to payable days', () => {
    expect(withUnpaid.payableDays).toBe('26.00');
    // 30000 x 26/31 = 25161.29
    expect(lineFor(withUnpaid, 'BASIC')?.amount).toBe('25161.29');
    expect(lineFor(withUnpaid, 'BASIC')?.fullAmount).toBe('30000.00');
  });

  it('leaves a component configured not to prorate at its full figure', () => {
    expect(lineFor(withUnpaid, 'PF_EMPLOYEE')?.amount).toBe('3600.00');
  });

  it('records why the figure was reduced', () => {
    const line = withUnpaid.lines.find((l) => l.componentCode === 'BASIC');
    expect(line?.prorationNote).toMatch(/Prorated for 26.00 payable days of 31/);
  });

  it('pays nothing for a month entirely of unpaid leave', () => {
    const none = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: {
        presentDays: '0.00',
        paidLeaveDays: '0.00',
        unpaidLeaveDays: '31.00',
        holidayDays: '0.00',
        weekOffDays: '0.00',
        overtimeMinutes: 0,
      },
      policy: policy(),
      adjustments: [],
    });
    expect(none.grossEarnings).toBe('0.00');
    expect(none.netPay).toBe('0.00');
    expect(none.isNegativeNet).toBe(false);
  });
});

describe('a missing policy input is reported, never guessed', () => {
  it('does not value overtime when no multiplier is configured', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: { ...fullMonth(31), overtimeMinutes: 120 },
      policy: policy({ overtimeMultiplier: null, standardDayMinutes: null }),
      adjustments: [],
    });
    expect(lineFor(result, 'OVERTIME')).toBeUndefined();
    expect(result.grossEarnings).toBe('50000.00');
    expect(result.notApplied.join(' ')).toMatch(
      /120 approved overtime minutes were not valued/,
    );
  });

  it('does not value overtime when the multiplier is set but the working day is not', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: { ...fullMonth(31), overtimeMinutes: 120 },
      policy: policy({ overtimeMultiplier: '1.50', standardDayMinutes: null }),
      adjustments: [],
    });
    expect(lineFor(result, 'OVERTIME')).toBeUndefined();
    expect(result.notApplied.join(' ')).toMatch(/not valued/);
  });

  it('values overtime once both inputs are configured', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: { ...fullMonth(31), overtimeMinutes: 120 },
      policy: policy({ overtimeMultiplier: '1.50', standardDayMinutes: 480 }),
      adjustments: [],
    });
    expect(lineFor(result, 'OVERTIME')).toBeDefined();
    expect(result.notApplied.join(' ')).not.toMatch(/overtime minutes were not valued/);
  });

  it('says plainly that no deduction was applied when none is configured', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [],
    });
    expect(result.totalDeductions).toBe('0.00');
    expect(result.notApplied.join(' ')).toMatch(
      /includes no statutory contribution or tax/,
    );
  });

  it('reports the working-day fallback through the result', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: fullMonth(31),
      policy: policy({ basis: 'WORKING_DAYS', workingDays: 0 }),
      adjustments: [],
    });
    expect(result.notApplied.join(' ')).toMatch(/no working-day count was available/);
  });

  it('reports configured earnings that exceed the agreed gross', () => {
    const result = calculateEmployeePay({
      monthlyGross: '20000.00',
      components: [basic(), hra(), special()],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [],
    });
    // 30000 + 12000 already exceeds a 20000 target, so the balance is zero and
    // the overage is stated rather than silently producing a negative allowance.
    expect(lineFor(result, 'SPECIAL')?.amount).toBe('0.00');
    expect(result.notApplied.join(' ')).toMatch(/exceed the agreed monthly gross/);
  });
});

describe('adjustments', () => {
  it('adds an arrear as an earning', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [{ kind: 'ARREAR', amount: '2500.00', reference: 'MAR-FIX' }],
    });
    expect(result.grossEarnings).toBe('52500.00');
    expect(result.netPay).toBe('52500.00');
  });

  it('subtracts a recovery as a deduction', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [{ kind: 'RECOVERY', amount: '2500.00', reference: null }],
    });
    expect(result.grossEarnings).toBe('50000.00');
    expect(result.totalDeductions).toBe('2500.00');
    expect(result.netPay).toBe('47500.00');
  });

  it('detects a negative net rather than clamping it', () => {
    // Deductions exceeding earnings is a real condition that must be reported and
    // block finalisation, not hidden behind a zero.
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra(), special()],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [{ kind: 'RECOVERY', amount: '60000.00', reference: 'OVERPAY' }],
    });
    expect(result.netPay).toBe('-10000.00');
    expect(result.isNegativeNet).toBe(true);
    expect(isNegativeAmount(result.netPay)).toBe(true);
  });
});

describe('zero-value and empty cases', () => {
  it('produces zero totals for an empty component set', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [],
    });
    expect(result.grossEarnings).toBe('0.00');
    expect(result.totalDeductions).toBe('0.00');
    expect(result.netPay).toBe('0.00');
    expect(result.lines).toEqual([]);
  });

  it('handles a zero-rate component without dropping the line', () => {
    const result = calculateEmployeePay({
      monthlyGross: '50000.00',
      components: [basic(), hra({ rate: '0.00' }), special()],
      attendance: fullMonth(31),
      policy: policy(),
      adjustments: [],
    });
    expect(lineFor(result, 'HRA')?.amount).toBe('0.00');
    expect(result.grossEarnings).toBe('50000.00');
  });

  it('sums an empty period to zero rather than NaN', () => {
    expect(periodTotals([])).toEqual({
      grossEarnings: '0.00',
      totalDeductions: '0.00',
      employerContributions: '0.00',
      netPay: '0.00',
    });
  });
});

// ---------------------------------------------------------------------------
//  Eligibility and the state machine
// ---------------------------------------------------------------------------

describe('eligibility', () => {
  const periodStart = new Date(Date.UTC(2026, 2, 1));
  const periodEnd = new Date(Date.UTC(2026, 2, 31));
  const base = { periodStart, periodEnd, hasSalaryAssignment: true };

  it('pays an active employee', () => {
    expect(
      eligibilityFor({
        ...base,
        status: 'ACTIVE',
        joiningDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: null,
      }),
    ).toBeNull();
  });

  it('pays somebody on probation — a review status, not an unpaid one', () => {
    expect(
      eligibilityFor({
        ...base,
        status: 'PROBATION',
        joiningDate: new Date(Date.UTC(2026, 0, 1)),
        exitDate: null,
      }),
    ).toBeNull();
  });

  it('pays somebody on notice', () => {
    expect(
      eligibilityFor({
        ...base,
        status: 'ON_NOTICE',
        joiningDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: null,
      }),
    ).toBeNull();
  });

  it('excludes somebody who joined after the period ended', () => {
    expect(
      eligibilityFor({
        ...base,
        status: 'ACTIVE',
        joiningDate: new Date(Date.UTC(2026, 3, 5)),
        exitDate: null,
      }),
    ).toBe('JOINED_AFTER_PERIOD');
  });

  it('excludes somebody who left before the period started', () => {
    expect(
      eligibilityFor({
        ...base,
        status: 'EXITED',
        joiningDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: new Date(Date.UTC(2026, 1, 10)),
      }),
    ).toBe('EXITED_BEFORE_PERIOD');
  });

  it('pays somebody who left mid-period', () => {
    // They were employed for part of it, so they are costed; proration handles
    // the rest.
    expect(
      eligibilityFor({
        ...base,
        status: 'EXITED',
        joiningDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: new Date(Date.UTC(2026, 2, 15)),
      }),
    ).toBeNull();
  });

  it('excludes somebody with no salary assignment, and says which', () => {
    expect(
      eligibilityFor({
        ...base,
        hasSalaryAssignment: false,
        status: 'ACTIVE',
        joiningDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: null,
      }),
    ).toBe('NO_SALARY_ASSIGNMENT');
  });

  it('excludes an inactive employee who never formally exited', () => {
    expect(
      eligibilityFor({
        ...base,
        status: 'INACTIVE',
        joiningDate: new Date(Date.UTC(2020, 0, 1)),
        exitDate: null,
      }),
    ).toBe('NOT_ELIGIBLE');
  });
});

describe('the period state machine', () => {
  it('allows the forward path', () => {
    expect(canMovePeriod('DRAFT', 'CALCULATED')).toBe(true);
    expect(canMovePeriod('CALCULATED', 'PENDING_APPROVAL')).toBe(true);
    expect(canMovePeriod('PENDING_APPROVAL', 'APPROVED')).toBe(true);
    expect(canMovePeriod('APPROVED', 'FINALIZED')).toBe(true);
  });

  it('allows a recalculation and a send-back', () => {
    expect(canMovePeriod('CALCULATED', 'CALCULATED')).toBe(true);
    expect(canMovePeriod('PENDING_APPROVAL', 'CALCULATED')).toBe(true);
    expect(canMovePeriod('APPROVED', 'CALCULATED')).toBe(true);
  });

  it('offers NO path out of FINALIZED, to anywhere', () => {
    // The immutability guarantee at the state-machine level. Corrections are
    // adjustments in a later period, never an edit to a paid figure.
    for (const to of ['DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED']) {
      expect(canMovePeriod('FINALIZED', to), `FINALIZED -> ${to}`).toBe(false);
    }
  });

  it('offers no path out of CANCELLED either', () => {
    for (const to of ['DRAFT', 'CALCULATED', 'FINALIZED']) {
      expect(canMovePeriod('CANCELLED', to), `CANCELLED -> ${to}`).toBe(false);
    }
  });
});
