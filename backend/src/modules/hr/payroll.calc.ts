/**
 * Payroll arithmetic — pure, deterministic, and free of statutory opinion.
 *
 * ### Deterministic means reproducible by hand
 *
 * Every function here is a pure function of its arguments. Given the same
 * salary, the same component configuration and the same attendance, it returns
 * the same figures forever — which is what lets a payslip from eight months ago
 * be re-explained to the person who received it.
 *
 * Nothing reads the clock, the database or a setting. Policy arrives as an
 * argument, because a calculation that fetched its own configuration could not
 * be unit-tested and could not be replayed against the configuration that was
 * in force when it ran.
 *
 * ### The evaluation order, and why it is fixed
 *
 * Components are evaluated in four passes, and the order is the whole reason
 * this file can guarantee termination:
 *
 *   1. **FIXED earnings.** Stated amounts. No dependency on anything.
 *   2. **PERCENT_OF_BASE.** A percentage of the single `isBase` earning, which
 *      pass 1 has already settled.
 *   3. **FORMULA_BALANCE.** Whatever is left of the target gross after passes 1
 *      and 2 — the "special allowance" shape, a figure that exists to make a
 *      total come out right.
 *   4. **PERCENT_OF_GROSS.** A percentage of the gross that passes 1-3 produced.
 *
 * A PERCENT_OF_GROSS component is therefore never an input to another one. That
 * restriction is not a simplification: a percentage of a total that includes
 * itself is a fixed-point problem, not a payroll line, and iterating to a
 * figure nobody can reproduce by hand is worse than refusing the configuration.
 * `validateComponentSet` refuses it up front.
 *
 * ### What this file does not know
 *
 * No provident-fund rate. No insurance threshold. No tax slab. No overtime
 * multiplier. No rounding default beyond what the caller passes. Every one of
 * those is a configured `SalaryComponent` row or an `HRSetting`, and this file
 * multiplies and rounds what it is given. See `PAYROLL-SCOPE.md`.
 *
 * The one thing it does assert is **internal coherence**: that the parts add up
 * to the total, that proration never increases a figure, and that a negative net
 * is reported rather than hidden.
 */

import {
  addAmount,
  compareAmount,
  isNegativeAmount,
  normaliseAmount,
  percentOfAmount,
  prorateAmount,
  roundAmount,
  subtractAmount,
  sumAmounts,
  overtimeValue,
  calendarDaysInMonth,
  type DailyRateBasis,
  type MonetaryRoundingMode,
  type PayrollAdjustmentKind,
  type SalaryCalculationKind,
  type SalaryComponentKind,
} from '@rs/shared';

/** A component as the calculator needs it: configuration, already resolved. */
export type CalcComponent = {
  code: string;
  name: string;
  kind: SalaryComponentKind;
  calculation: SalaryCalculationKind;
  /** The effective rate after structure and employee overrides. */
  rate: string | null;
  /** The effective amount after structure and employee overrides. */
  amount: string | null;
  capAmount: string | null;
  floorAmount: string | null;
  isBase: boolean;
  prorates: boolean;
  displayOrder: number;
};

/** Attendance for one employee over one period, already aggregated. */
export type CalcAttendance = {
  presentDays: string;
  paidLeaveDays: string;
  unpaidLeaveDays: string;
  holidayDays: string;
  weekOffDays: string;
  overtimeMinutes: number;
};

/** The period's frozen arithmetic policy. */
export type CalcPolicy = {
  basis: DailyRateBasis;
  rounding: MonetaryRoundingMode;
  calendarDays: number;
  workingDays: number;
  /**
   * The overtime multiplier, or null when none is configured.
   *
   * Null means **overtime is not valued**, and the result says so in
   * `notApplied` rather than silently paying zero or silently assuming 1.0.
   */
  overtimeMultiplier: string | null;
  /** Minutes in a standard working day, for valuing overtime. Null disables it. */
  standardDayMinutes: number | null;
};

export type CalcAdjustment = {
  kind: PayrollAdjustmentKind;
  amount: string;
  reference: string | null;
};

export type CalcLine = {
  componentCode: string;
  componentName: string;
  kind: SalaryComponentKind;
  calculation: SalaryCalculationKind;
  rate: string | null;
  fullAmount: string;
  amount: string;
  prorationNote: string | null;
  displayOrder: number;
};

export type CalcResult = {
  lines: CalcLine[];
  payableDays: string;
  grossEarnings: string;
  totalDeductions: string;
  employerContributions: string;
  netPay: string;
  /** True when deductions exceeded earnings. Blocks finalisation. */
  isNegativeNet: boolean;
  /** Policies that were NOT applied because nothing was configured. */
  notApplied: string[];
};

/**
 * The divisor this policy implies.
 *
 * WORKING_DAYS falls back to calendar days when no working-day figure has been
 * computed, and says so through `notApplied` at the call site rather than
 * dividing by zero. A business that configures the working-day basis without
 * holiday data has a configuration gap, not a payroll that should crash.
 */
export function resolveDivisor(policy: CalcPolicy): { divisor: number; fellBack: boolean } {
  switch (policy.basis) {
    case 'FIXED_THIRTY':
      return { divisor: 30, fellBack: false };
    case 'WORKING_DAYS':
      if (policy.workingDays > 0) return { divisor: policy.workingDays, fellBack: false };
      return { divisor: policy.calendarDays, fellBack: true };
    case 'CALENDAR_DAYS':
    default:
      return { divisor: policy.calendarDays, fellBack: false };
  }
}

/**
 * The days an employee is paid for.
 *
 * Present + paid leave + holidays + week-offs. Unpaid leave is the only thing
 * that reduces it, and that is read from `LeaveType.isPaid` upstream rather than
 * inferred — the module does not decide which leave is paid.
 *
 * Holidays and week-offs count as payable because a monthly salary is a monthly
 * salary: an employee is not docked for Sunday. A business paying only for days
 * worked would configure a different basis, which is why the divisor is
 * configurable.
 */
export function payableDaysFor(attendance: CalcAttendance): string {
  return sumAmounts([
    attendance.presentDays,
    attendance.paidLeaveDays,
    attendance.holidayDays,
    attendance.weekOffDays,
  ]);
}

/**
 * Whether a component set can be evaluated at all.
 *
 * Returns the problems rather than throwing, so the API can report every
 * configuration fault at once instead of the first one.
 */
export function validateComponentSet(components: readonly CalcComponent[]): string[] {
  const problems: string[] = [];

  const bases = components.filter((c) => c.isBase);
  if (bases.length > 1) {
    problems.push(
      `More than one base component: ${bases.map((b) => b.code).join(', ')}. Percentages of the base would be ambiguous.`,
    );
  }

  const needsBase = components.filter((c) => c.calculation === 'PERCENT_OF_BASE');
  if (needsBase.length > 0 && bases.length === 0) {
    problems.push(
      `${needsBase.map((c) => c.code).join(', ')} are percentages of the base, but no component is marked as the base.`,
    );
  }

  for (const c of components) {
    if (
      (c.calculation === 'PERCENT_OF_BASE' || c.calculation === 'PERCENT_OF_GROSS') &&
      c.rate === null
    ) {
      problems.push(`${c.code} is a percentage component with no rate configured.`);
    }
    if (c.calculation === 'FIXED' && c.amount === null) {
      problems.push(`${c.code} is a fixed component with no amount configured.`);
    }
  }

  const balances = components.filter((c) => c.calculation === 'FORMULA_BALANCE');
  if (balances.length > 1) {
    problems.push(
      `More than one balancing component: ${balances.map((b) => b.code).join(', ')}. Only one figure can absorb the remainder.`,
    );
  }

  const codes = new Set<string>();
  for (const c of components) {
    if (codes.has(c.code)) problems.push(`${c.code} appears twice in the same structure.`);
    codes.add(c.code);
  }

  return problems;
}

/** Applies a cap and a floor to a computed figure, in that order. */
function applyBounds(amount: string, component: CalcComponent, gross: string): string {
  // A floor is a *gross* eligibility threshold: below it, the component does not
  // apply at all. That is how a capped statutory contribution is configured
  // without the threshold being code.
  if (component.floorAmount !== null && compareAmount(gross, component.floorAmount) < 0) {
    return '0.00';
  }
  if (component.capAmount !== null && compareAmount(amount, component.capAmount) > 0) {
    return normaliseAmount(component.capAmount);
  }
  return amount;
}

/**
 * The whole calculation for one employee.
 *
 * Returns figures and a list of what it did not do. The second half matters as
 * much as the first: a payslip that silently omits overtime because no
 * multiplier is configured is a payslip the employee will dispute, and
 * `notApplied` is what lets the UI and the snapshot say so plainly.
 */
export function calculateEmployeePay(input: {
  monthlyGross: string;
  components: readonly CalcComponent[];
  attendance: CalcAttendance;
  policy: CalcPolicy;
  adjustments: readonly CalcAdjustment[];
}): CalcResult {
  const { monthlyGross, components, attendance, policy, adjustments } = input;
  const notApplied: string[] = [];
  const mode = policy.rounding;

  const { divisor, fellBack } = resolveDivisor(policy);
  if (fellBack) {
    notApplied.push(
      'The working-day divisor was configured but no working-day count was available, so calendar days were used.',
    );
  }

  const payableDays = payableDaysFor(attendance);
  // Day counts are Decimal(5,2) to allow half days, so the divisor comparison
  // works on exact strings rather than floats.
  const payableWholeDays = Math.min(Math.round(Number(payableDays) * 100) / 100, divisor);
  const isFullMonth = compareAmount(payableDays, String(divisor)) >= 0;

  /**
   * Prorates one component, where it prorates at all.
   *
   * A full month short-circuits to the stated figure so a present-all-month
   * employee is paid exactly their salary with no rounding applied.
   */
  const prorate = (full: string, component: CalcComponent): { amount: string; note: string | null } => {
    if (!component.prorates) return { amount: full, note: null };
    if (isFullMonth) return { amount: full, note: null };
    const prorated = prorateAmount(full, Math.floor(payableWholeDays), divisor, mode);
    return {
      amount: prorated,
      note: `Prorated for ${payableDays} payable days of ${divisor}.`,
    };
  };

  const lines: CalcLine[] = [];

  // --- Pass 1: FIXED earnings -------------------------------------------
  const base = components.find((c) => c.isBase);
  const fixedEarnings = components.filter(
    (c) => c.kind === 'EARNING' && c.calculation === 'FIXED',
  );
  for (const c of fixedEarnings) {
    const full = normaliseAmount(c.amount ?? '0.00');
    const { amount, note } = prorate(full, c);
    lines.push({
      componentCode: c.code,
      componentName: c.name,
      kind: c.kind,
      calculation: c.calculation,
      rate: null,
      fullAmount: full,
      amount,
      prorationNote: note,
      displayOrder: c.displayOrder,
    });
  }

  // The base figure percentages are taken of: the *full* base, before proration,
  // so a mid-month joiner's percentage components scale with the same proration
  // as the base rather than being prorated twice.
  const baseFull = base ? normaliseAmount(base.amount ?? '0.00') : '0.00';

  // --- Pass 2: PERCENT_OF_BASE ------------------------------------------
  const percentOfBase = components.filter((c) => c.calculation === 'PERCENT_OF_BASE');
  for (const c of percentOfBase) {
    const full = percentOfAmount(baseFull, c.rate ?? '0.00', mode);
    const { amount, note } = prorate(full, c);
    lines.push({
      componentCode: c.code,
      componentName: c.name,
      kind: c.kind,
      calculation: c.calculation,
      rate: c.rate,
      fullAmount: full,
      amount,
      prorationNote: note,
      displayOrder: c.displayOrder,
    });
  }

  // --- Pass 3: FORMULA_BALANCE ------------------------------------------
  //
  // Whatever is left of the target gross once every other earning is assigned.
  // Clamped at zero: if the configured earnings already exceed the target, the
  // balance is nothing rather than a negative allowance, and the overage is
  // reported.
  const balance = components.find((c) => c.calculation === 'FORMULA_BALANCE');
  if (balance) {
    const assignedFull = sumAmounts(
      lines.filter((l) => l.kind === 'EARNING').map((l) => l.fullAmount),
    );
    let full = subtractAmount(normaliseAmount(monthlyGross), assignedFull);
    if (isNegativeAmount(full)) {
      notApplied.push(
        `Configured earnings exceed the agreed monthly gross by ${full.replace('-', '')}, so ${balance.code} was set to zero.`,
      );
      full = '0.00';
    }
    const { amount, note } = prorate(full, balance);
    lines.push({
      componentCode: balance.code,
      componentName: balance.name,
      kind: balance.kind,
      calculation: balance.calculation,
      rate: null,
      fullAmount: full,
      amount,
      prorationNote: note,
      displayOrder: balance.displayOrder,
    });
  }

  // --- Overtime ----------------------------------------------------------
  //
  // Valued only when BOTH a multiplier and a standard day are configured. With
  // neither, the minutes are reported as unvalued rather than paid at a guessed
  // rate — there is no default overtime policy in this codebase.
  if (attendance.overtimeMinutes > 0) {
    if (policy.overtimeMultiplier === null || policy.standardDayMinutes === null) {
      notApplied.push(
        `${attendance.overtimeMinutes} approved overtime minutes were not valued: no overtime multiplier and standard working day are configured.`,
      );
    } else {
      const dailyFromGross = prorateAmount(monthlyGross, 1, divisor, mode);
      const otAmount = overtimeValue(
        dailyFromGross,
        policy.standardDayMinutes,
        attendance.overtimeMinutes,
        policy.overtimeMultiplier,
        mode,
      );
      lines.push({
        componentCode: 'OVERTIME',
        componentName: 'Overtime',
        kind: 'EARNING',
        calculation: 'FIXED',
        rate: null,
        fullAmount: otAmount,
        amount: otAmount,
        prorationNote: `${attendance.overtimeMinutes} minutes at ${policy.overtimeMultiplier}x.`,
        displayOrder: 900,
      });
    }
  }

  // --- Adjustments -------------------------------------------------------
  //
  // Arrears, bonuses and reimbursements add; recoveries deduct. The amount is
  // always positive and the kind decides the direction, which is why neither is
  // a signed figure.
  for (const [index, adj] of adjustments.entries()) {
    const isDeduction = adj.kind === 'RECOVERY';
    lines.push({
      componentCode: `ADJ_${adj.kind}_${index + 1}`,
      componentName:
        adj.kind === 'ARREAR'
          ? 'Arrear'
          : adj.kind === 'RECOVERY'
            ? 'Recovery'
            : adj.kind === 'BONUS'
              ? 'Bonus'
              : 'Reimbursement',
      kind: isDeduction ? 'DEDUCTION' : 'EARNING',
      calculation: 'FIXED',
      rate: null,
      fullAmount: normaliseAmount(adj.amount),
      amount: normaliseAmount(adj.amount),
      prorationNote: adj.reference ? `Reference ${adj.reference}.` : null,
      displayOrder: 950,
    });
  }

  // Gross after passes 1-3, overtime and additive adjustments. This is the
  // figure PERCENT_OF_GROSS components are taken of.
  const grossSoFar = sumAmounts(lines.filter((l) => l.kind === 'EARNING').map((l) => l.amount));

  // --- Pass 4: PERCENT_OF_GROSS ----------------------------------------
  const percentOfGross = components.filter((c) => c.calculation === 'PERCENT_OF_GROSS');
  for (const c of percentOfGross) {
    const raw = percentOfAmount(grossSoFar, c.rate ?? '0.00', mode);
    const bounded = applyBounds(raw, c, grossSoFar);
    lines.push({
      componentCode: c.code,
      componentName: c.name,
      kind: c.kind,
      calculation: c.calculation,
      rate: c.rate,
      fullAmount: raw,
      amount: bounded,
      prorationNote:
        bounded !== raw
          ? c.floorAmount !== null && compareAmount(grossSoFar, c.floorAmount) < 0
            ? `Not applied: gross is below the ${c.floorAmount} threshold.`
            : `Capped at ${c.capAmount}.`
          : null,
      displayOrder: c.displayOrder,
    });
  }

  // Apply bounds to the base-percentage deductions too, now that gross is known.
  for (const line of lines) {
    if (line.calculation !== 'PERCENT_OF_BASE') continue;
    const component = components.find((c) => c.code === line.componentCode);
    if (!component) continue;
    const bounded = applyBounds(line.amount, component, grossSoFar);
    if (bounded !== line.amount) {
      line.prorationNote =
        component.floorAmount !== null && compareAmount(grossSoFar, component.floorAmount) < 0
          ? `Not applied: gross is below the ${component.floorAmount} threshold.`
          : `Capped at ${component.capAmount}.`;
      line.amount = bounded;
    }
  }

  const grossEarnings = roundAmount(
    sumAmounts(lines.filter((l) => l.kind === 'EARNING').map((l) => l.amount)),
    mode,
  );
  const totalDeductions = roundAmount(
    sumAmounts(lines.filter((l) => l.kind === 'DEDUCTION').map((l) => l.amount)),
    mode,
  );
  const employerContributions = roundAmount(
    sumAmounts(lines.filter((l) => l.kind === 'EMPLOYER_CONTRIBUTION').map((l) => l.amount)),
    mode,
  );

  // Net is gross minus deductions. Employer contributions are deliberately NOT
  // subtracted: they never pass through the employee's hands, and netting them
  // off would understate what the employee was paid.
  const netPay = subtractAmount(grossEarnings, totalDeductions);

  // No statutory deduction was computed unless one was configured. Said plainly,
  // because a payslip that omits tax without saying so implies there is none.
  const hasDeductions = lines.some((l) => l.kind === 'DEDUCTION');
  if (!hasDeductions) {
    notApplied.push(
      'No deductions were applied: none are configured. This payslip includes no statutory contribution or tax.',
    );
  }

  lines.sort((a, b) => a.displayOrder - b.displayOrder || a.componentCode.localeCompare(b.componentCode));

  return {
    lines,
    payableDays,
    grossEarnings,
    totalDeductions,
    employerContributions,
    netPay,
    isNegativeNet: isNegativeAmount(netPay),
    notApplied,
  };
}

/**
 * Whether an employee is eligible for a run, under the documented rules.
 *
 * The rules, stated rather than implied:
 *
 *   - An employee whose `joiningDate` is after the period ends was not employed
 *     during it.
 *   - An employee whose `exitDate` is before the period starts had left.
 *   - EXITED and INACTIVE employees are excluded unless they were employed for
 *     part of the period, which the two date rules already decide.
 *   - PROBATION, ACTIVE and ON_NOTICE employees are all paid. Probation is a
 *     review status, not an unpaid state.
 *
 * Returns the exclusion reason, or null when eligible, so the caller records
 * *why* rather than inferring it. "Why was I not paid" is the one question this
 * module must always be able to answer.
 */
export function eligibilityFor(input: {
  status: 'PROBATION' | 'ACTIVE' | 'ON_NOTICE' | 'EXITED' | 'INACTIVE';
  joiningDate: Date;
  exitDate: Date | null;
  periodStart: Date;
  periodEnd: Date;
  hasSalaryAssignment: boolean;
}): 'NOT_ELIGIBLE' | 'NO_SALARY_ASSIGNMENT' | 'JOINED_AFTER_PERIOD' | 'EXITED_BEFORE_PERIOD' | null {
  if (input.joiningDate > input.periodEnd) return 'JOINED_AFTER_PERIOD';
  if (input.exitDate !== null && input.exitDate < input.periodStart) return 'EXITED_BEFORE_PERIOD';
  if (input.status === 'INACTIVE' && input.exitDate === null) return 'NOT_ELIGIBLE';
  if (!input.hasSalaryAssignment) return 'NO_SALARY_ASSIGNMENT';
  return null;
}

/** The period's date span, derived from year and month. */
export function periodBounds(year: number, month: number): {
  periodStart: Date;
  periodEnd: Date;
  calendarDays: number;
} {
  const calendarDays = calendarDaysInMonth(year, month);
  return {
    periodStart: new Date(Date.UTC(year, month - 1, 1)),
    periodEnd: new Date(Date.UTC(year, month - 1, calendarDays)),
    calendarDays,
  };
}

/**
 * The valid moves for a payroll period.
 *
 * **There is no transition out of FINALIZED.** Not to APPROVED, not anywhere.
 * The figures are what people were paid against; reopening one would restate
 * history. Corrections are adjustments in a later period.
 */
export const PAYROLL_TRANSITIONS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  DRAFT: ['CALCULATED', 'CANCELLED'],
  CALCULATED: ['DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'CALCULATED', 'CANCELLED'],
  APPROVED: ['FINALIZED', 'CALCULATED', 'CANCELLED'],
  FINALIZED: [],
  CANCELLED: [],
});

export function canMovePeriod(from: string, to: string): boolean {
  return (PAYROLL_TRANSITIONS[from] ?? []).includes(to);
}

/** Totals across a set of already-computed lines, for the period row. */
export function periodTotals(
  items: readonly {
    grossEarnings: string;
    totalDeductions: string;
    employerContributions: string;
    netPay: string;
  }[],
): {
  grossEarnings: string;
  totalDeductions: string;
  employerContributions: string;
  netPay: string;
} {
  return {
    grossEarnings: sumAmounts(items.map((i) => i.grossEarnings)),
    totalDeductions: sumAmounts(items.map((i) => i.totalDeductions)),
    employerContributions: sumAmounts(items.map((i) => i.employerContributions)),
    netPay: items.reduce((acc, i) => addAmount(acc, i.netPay), '0.00'),
  };
}
