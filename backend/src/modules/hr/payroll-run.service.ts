/**
 * Payroll processing: periods, calculation, approval, finalisation, payslips.
 *
 * Compensation *configuration* lives in `payroll.service.ts`. The split follows
 * Phase 5's two-file shape: one file for what exists before any run, one for the
 * run itself.
 *
 * ### The four guarantees this file is responsible for
 *
 * **1. A duplicate payroll run is impossible.** Three independent mechanisms,
 * because each covers a case the others do not:
 *
 *   - `@@unique([year, month])` on PayrollPeriod. Two concurrent creates for
 *     March both pass a service-level check; the database refuses the second.
 *   - `@@unique([periodId, employeeId])` on PayrollItem, reached through
 *     `upsertItem`. A calculation that ran twice updates rows rather than adding
 *     them, which is what makes recalculation idempotent.
 *   - `transitionPeriod`, a conditional `updateMany` with a status predicate.
 *     Two concurrent finalisations both pass the status check in this file and
 *     both proceed; only one matches `status IN ('APPROVED')` at the moment of
 *     the write, and the second sees `count === 0` and is refused.
 *
 * **2. A failed run cannot leave partially finalised payroll.** Finalisation is
 * one transaction containing the period transition, every item's status change
 * (one `updateMany`, not a loop) and every snapshot write. A failure anywhere
 * rolls all of it back. There is no code path that finalises some items and not
 * others.
 *
 * **3. A finalised figure is immutable.** `isPeriodSettled` is consulted before
 * the question of who is asking, in every write check. The state machine offers
 * no transition out of FINALIZED. `payroll_item_finalized_has_snapshot` makes a
 * finalised item without its computation impossible at the database level. And
 * snapshots are written once, inside the finalisation transaction, and never
 * updated afterwards.
 *
 * **4. Nobody approves or finalises a run that pays them.** `paysActor` is
 * resolved before the access functions are called, and both `mayDecidePeriod`
 * and `mayFinalizePeriod` refuse the subject **first**, before any permission is
 * consulted. An HR colleague on the payroll holds APPROVE, and checking the
 * grant first would let them clear their own pay.
 *
 * ### Nothing is guessed
 *
 * Where a policy input is missing — no overtime multiplier, no working-day
 * count, no configured deductions — the calculation reports it in `notApplied`
 * and the figure is left out rather than estimated. The snapshot carries that
 * list, so a payslip states what it does not include instead of implying
 * completeness.
 */

import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_PAYROLL_CURRENCY,
  normaliseAmount,
  type CalculatePayrollInput,
  type CancelPayrollInput,
  type CreatePayrollAdjustmentInput,
  type CreatePayrollPeriodInput,
  type DecidePayrollInput,
  type ExcludePayrollItemInput,
  type FinalizePayrollInput,
  type MyPayrollView,
  type PayrollAdjustmentView,
  type PayrollCalculationResultView,
  type PayrollItemSnapshot,
  type PayrollItemView,
  type PayrollOverviewView,
  type PayrollPeriodListQuery,
  type PayrollPeriodStatus,
  type PayrollPeriodSummaryView,
  type PayrollPeriodView,
  type PayslipView,
  type SubmitPayrollInput,
  type UpdatePayrollPeriodInput,
} from '@rs/shared';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import { readSetting } from '../../services/hr-setting.service.js';
import {
  cancelApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} from '../../services/approval.service.js';
import { usersWithPermission } from '../../services/permission.service.js';
import * as repo from './payroll.repository.js';
import { TX_OPTIONS, TX_OPTIONS_CRITICAL } from './payroll.repository.js';
import * as notify from './payroll.notify.js';
import * as calc from './payroll.calc.js';
import type { HrActor } from './hr-access.js';
import {
  isPeriodSettled,
  mayCalculatePeriod,
  mayCancelPeriod,
  mayCreatePeriod,
  mayDecidePeriod,
  mayEditPeriod,
  mayExcludeItem,
  mayExportPayroll,
  mayFinalizePeriod,
  mayReadPayslip,
  mayRecordAdjustment,
  maySubmitPeriod,
  mayViewPeriods,
  mayViewSummary,
  payrollScope,
  visiblePayrollItemFilter,
} from './payroll-access.js';

const notFound = (): AppError =>
  new AppError('NOT_FOUND', 404, 'That record could not be found.');

/** The snapshot shape's version, so a later change can be read safely. */
const SNAPSHOT_SCHEMA_VERSION = 1;

const dec = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toFixed(2);

const monthName = (year: number, month: number): string =>
  `${new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${year}`;

// ---------------------------------------------------------------------------
//  Policy resolution — every figure configured, none assumed
// ---------------------------------------------------------------------------

/**
 * The payroll policy, read from HRSetting with no statutory defaults.
 *
 * `overtimeMultiplier` and `standardDayMinutes` default to **null**, which means
 * "overtime is not valued and the payslip says so". They do not default to 1.0
 * and 480: there is no standard overtime policy in this codebase, and a guessed
 * multiplier would put a figure on a payslip that nobody configured.
 *
 * The divisor basis and rounding mode DO have defaults, because every period
 * needs one to compute at all and both are recorded on the period so a
 * historical payslip keeps its own arithmetic. Those defaults are declared in
 * `shared/src/enums.ts` as column defaults, not as statutory claims.
 */
async function resolvePolicy(period: {
  dailyRateBasis: string;
  roundingMode: string;
  calendarDays: number;
  workingDays: number;
}): Promise<calc.CalcPolicy> {
  const multiplier = await readSetting<string | null>(
    'HR_PAYROLL',
    'overtime.multiplier',
    (raw) => (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null),
    null,
  );
  const dayMinutes = await readSetting<number | null>(
    'HR_PAYROLL',
    'overtime.standard_day_minutes',
    (raw) => {
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    },
    null,
  );

  return {
    basis: period.dailyRateBasis as calc.CalcPolicy['basis'],
    rounding: period.roundingMode as calc.CalcPolicy['rounding'],
    calendarDays: period.calendarDays,
    workingDays: period.workingDays,
    overtimeMultiplier: multiplier,
    standardDayMinutes: dayMinutes,
  };
}

// ---------------------------------------------------------------------------
//  Presenters
// ---------------------------------------------------------------------------

type PeriodRow = Prisma.PayrollPeriodGetPayload<{ select: typeof repo.periodSelect }>;

/**
 * Presents a period, with `viewerCan` decided here rather than in the browser.
 *
 * `paysActor` is passed in because answering it requires a query the presenter
 * must not make. `finalize` is false for a reader whose own salary is in the run,
 * whatever grants they hold — which is the separation-of-duties rule made visible
 * in the UI, and enforced again on every write.
 */
function presentPeriod(
  row: PeriodRow,
  actor: HrActor,
  paysActor: boolean,
): PayrollPeriodView {
  const status = row.status as PayrollPeriodStatus;
  const hasTotals = row.grossEarnings !== null;

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    year: row.year,
    month: row.month,
    status,
    currency: row.currency,
    dailyRateBasis: row.dailyRateBasis,
    roundingMode: row.roundingMode,
    calendarDays: row.calendarDays,
    workingDays: row.workingDays,
    payableDaysDivisor: row.payableDaysDivisor,
    totals: hasTotals
      ? {
          grossEarnings: dec(row.grossEarnings) ?? '0.00',
          totalDeductions: dec(row.totalDeductions) ?? '0.00',
          employerContributions: dec(row.employerContributions) ?? '0.00',
          netPay: dec(row.netPay) ?? '0.00',
          excludedCount: 0,
          negativeNetCount: 0,
        }
      : null,
    employeeCount: row.employeeCount,
    calculatedAt: row.calculatedAt?.toISOString() ?? null,
    calculatedBy: row.calculatedBy ? { id: row.calculatedBy.id, name: row.calculatedBy.name } : null,
    approvalRequestId: row.approvalRequestId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy ? { id: row.approvedBy.id, name: row.approvedBy.name } : null,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    finalizedBy: row.finalizedBy ? { id: row.finalizedBy.id, name: row.finalizedBy.name } : null,
    notes: row.notes,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    viewerCan: {
      edit: mayEditPeriod(actor, status),
      calculate: mayCalculatePeriod(actor, status),
      submitForApproval: maySubmitPeriod(actor, status),
      approve: mayDecidePeriod(actor, status, paysActor),
      finalize: mayFinalizePeriod(actor, status, paysActor),
      cancel: mayCancelPeriod(actor, status),
      export: mayExportPayroll(actor),
    },
    viewerIsPaidByThisRun: paysActor,
  };
}

type ItemRow = Prisma.PayrollItemGetPayload<{ select: typeof repo.itemSelect }>;

function presentItem(row: ItemRow): PayrollItemView {
  return {
    id: row.id,
    periodId: row.periodId,
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: `${row.employee.firstName} ${row.employee.lastName}`.trim(),
      departmentName: row.employee.department?.name ?? null,
      designationName: row.employee.designation?.name ?? null,
    },
    status: row.status,
    exclusionReason: row.exclusionReason,
    exclusionNote: row.exclusionNote,
    currency: row.currency,
    salaryAssignmentId: row.salaryAssignmentId,
    monthlyGross: dec(row.monthlyGross),
    payableDays: dec(row.payableDays),
    unpaidLeaveDays: dec(row.unpaidLeaveDays),
    presentDays: dec(row.presentDays),
    paidLeaveDays: dec(row.paidLeaveDays),
    overtimeMinutes: row.overtimeMinutes,
    grossEarnings: dec(row.grossEarnings),
    totalDeductions: dec(row.totalDeductions),
    employerContributions: dec(row.employerContributions),
    netPay: dec(row.netPay),
    lines: row.lines.map((l) => ({
      id: l.id,
      componentCode: l.componentCode,
      componentName: l.componentName,
      kind: l.kind,
      calculation: l.calculation,
      rate: dec(l.rate),
      fullAmount: l.fullAmount.toFixed(2),
      amount: l.amount.toFixed(2),
      prorationNote: l.prorationNote,
      displayOrder: l.displayOrder,
    })),
    adjustments: [],
    snapshot: (row.snapshot as PayrollItemSnapshot | null) ?? null,
    payslipDocumentId: row.payslipDocumentId,
    calculatedAt: row.calculatedAt?.toISOString() ?? null,
  };
}

/**
 * Whether this reader's own salary is inside a period.
 *
 * Answered from `Employee.userId` via the actor's resolved `employeeId`, which
 * `hrActor` reads from the relation — **not** by comparing employee codes.
 * `User.employeeId` and `Employee.employeeId` are different columns that usually
 * agree and are not guaranteed to; a Phase 5 defect came from exactly that
 * comparison.
 *
 * An actor with no employee record is never paid by any run, so `false` is
 * correct rather than merely safe.
 */
async function periodPaysActor(actor: HrActor, periodId: string): Promise<boolean> {
  if (!actor.employeeId) return false;
  const existing = await repo.itemExistsFor(periodId, actor.employeeId);
  return existing !== null && existing.status !== 'EXCLUDED';
}

// ---------------------------------------------------------------------------
//  Periods
// ---------------------------------------------------------------------------

export async function listPeriods(
  actor: HrActor,
  query: PayrollPeriodListQuery,
): Promise<{ periods: PayrollPeriodView[]; nextCursor: string | null }> {
  if (!mayViewPeriods(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Reading payroll runs needs payroll access.');
  }
  const rows = await repo.listPeriods({
    where: {
      ...(query.status ? { status: query.status } : {}),
      ...(query.year ? { year: query.year } : {}),
    },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const page = rows.slice(0, query.limit);
  const paysFlags = await Promise.all(page.map((p) => periodPaysActor(actor, p.id)));
  return {
    periods: page.map((row, i) => presentPeriod(row, actor, paysFlags[i] ?? false)),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getPeriod(actor: HrActor, id: string): Promise<PayrollPeriodView> {
  if (!mayViewPeriods(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Reading a payroll run needs payroll access.');
  }
  const row = await repo.findPeriod(id);
  if (!row) throw notFound();
  const paysActor = await periodPaysActor(actor, id);
  const view = presentPeriod(row, actor, paysActor);

  // Excluded and negative-net counts come from the items, not the period row:
  // a total that hid either would be a total somebody acts on without knowing
  // whom it leaves out.
  if (view.totals) {
    const items = await repo.itemsForPeriod(id);
    view.totals.excludedCount = items.filter((i) => i.status === 'EXCLUDED').length;
    view.totals.negativeNetCount = items.filter(
      (i) => i.netPay !== null && i.netPay.lessThan(0),
    ).length;
  }
  return view;
}

/**
 * Opens a run for one month.
 *
 * The `@@unique([year, month])` constraint is what makes a duplicate impossible:
 * the pre-check below is a courtesy that produces a readable message, and the
 * P2002 handler is the actual guarantee. Two concurrent requests for March both
 * pass the pre-check.
 */
export async function createPeriod(
  req: Request,
  actor: HrActor,
  input: CreatePayrollPeriodInput,
): Promise<PayrollPeriodView> {
  if (!mayCreatePeriod(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Opening a payroll run needs payroll create rights.');
  }

  const existing = await repo.findPeriodByMonth(input.year, input.month);
  if (existing) {
    throw new AppError(
      'CONFLICT',
      409,
      `A payroll run for ${monthName(input.year, input.month)} already exists (${existing.code}, ${existing.status}).`,
    );
  }

  const { periodStart, periodEnd, calendarDays } = calc.periodBounds(input.year, input.month);
  const workingDays = await repo.workingDaysIn(periodStart, periodEnd);

  const defaultBasis = await readSetting<'CALENDAR_DAYS' | 'WORKING_DAYS' | 'FIXED_THIRTY'>(
    'HR_PAYROLL',
    'daily_rate.basis',
    (raw) =>
      raw === 'WORKING_DAYS' || raw === 'FIXED_THIRTY' || raw === 'CALENDAR_DAYS'
        ? raw
        : 'CALENDAR_DAYS',
    'CALENDAR_DAYS',
  );
  const defaultRounding = await readSetting<'HALF_UP' | 'HALF_EVEN' | 'DOWN'>(
    'HR_PAYROLL',
    'rounding.mode',
    (raw) => (raw === 'HALF_EVEN' || raw === 'DOWN' || raw === 'HALF_UP' ? raw : 'HALF_UP'),
    'HALF_UP',
  );

  let id: string;
  try {
    id = await repo.prisma.$transaction(async (tx) => {
      const seq = await repo.allocatePayrollCode(tx, `PAY-${input.year}`);
      const created = await repo.createPeriod(tx, {
        code: `PAY-${input.year}-${String(input.month).padStart(2, '0')}-${String(seq).padStart(2, '0')}`,
        name: input.name ?? `Payroll — ${monthName(input.year, input.month)}`,
        periodStart,
        periodEnd,
        year: input.year,
        month: input.month,
        currency: input.currency ?? DEFAULT_PAYROLL_CURRENCY,
        dailyRateBasis: input.dailyRateBasis ?? defaultBasis,
        roundingMode: input.roundingMode ?? defaultRounding,
        calendarDays,
        workingDays,
        notes: input.notes ?? null,
        createdById: actor.id,
      });
      return created.id;
      // The wider budget: two statements, but a 500 here leaves an HR user
      // unsure whether the run exists. See TX_OPTIONS_CRITICAL.
    }, TX_OPTIONS_CRITICAL);
  } catch (error) {
    // The real guarantee. Two concurrent creates both pass the pre-check above;
    // this is what refuses the second.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(
        'CONFLICT',
        409,
        `A payroll run for ${monthName(input.year, input.month)} already exists.`,
      );
    }
    throw error;
  }

  await recordAudit(req, {
    action: 'PAYROLL_PERIOD_CREATED',
    entityType: 'PayrollPeriod',
    entityId: id,
    actorId: actor.id,
    newValue: { year: input.year, month: input.month, basis: input.dailyRateBasis ?? defaultBasis },
  });

  return getPeriod(actor, id);
}

export async function updatePeriod(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdatePayrollPeriodInput,
): Promise<PayrollPeriodView> {
  const state = await repo.findPeriodState(id);
  if (!state) throw notFound();

  if (!mayEditPeriod(actor, state.status as PayrollPeriodStatus)) {
    if (isPeriodSettled(state.status as PayrollPeriodStatus)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `${state.code} is ${state.status.toLowerCase()} and can no longer be changed. Corrections are recorded as an adjustment in a later period.`,
      );
    }
    throw new AppError('FORBIDDEN', 403, 'Changing a payroll run needs payroll edit rights.');
  }

  await repo.prisma.$transaction(
    (tx) =>
      repo.updatePeriod(tx, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.dailyRateBasis !== undefined ? { dailyRateBasis: input.dailyRateBasis } : {}),
        ...(input.roundingMode !== undefined ? { roundingMode: input.roundingMode } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'PAYROLL_PERIOD_UPDATED',
    entityType: 'PayrollPeriod',
    entityId: id,
    actorId: actor.id,
    oldValue: { basis: state.dailyRateBasis, rounding: state.roundingMode },
    newValue: {
      basis: input.dailyRateBasis ?? state.dailyRateBasis,
      rounding: input.roundingMode ?? state.roundingMode,
    },
  });

  return getPeriod(actor, id);
}

// ---------------------------------------------------------------------------
//  Calculation — idempotent by construction
// ---------------------------------------------------------------------------

/**
 * Costs a run, or re-costs it.
 *
 * **Idempotent.** Every write goes through `upsertItem` keyed on
 * `(periodId, employeeId)`, so running this twice replaces figures rather than
 * adding rows. That is what makes "fix the attendance and recalculate" a safe
 * operation rather than one that doubles everybody's pay.
 *
 * **One transaction per employee**, not one for the whole run. A run of four
 * hundred employees inside a single 15-second transaction would exceed the
 * budget, and an employee whose calculation fails should not prevent the other
 * 399 from being costed — their line stays PENDING and the failure is reported
 * as a blocker. The period's own status and totals are written in a final
 * transaction once every line has settled, so a period is never CALCULATED with
 * half its lines missing.
 */
export async function calculatePeriod(
  req: Request,
  actor: HrActor,
  id: string,
  input: CalculatePayrollInput,
): Promise<PayrollCalculationResultView> {
  const state = await repo.findPeriodState(id);
  if (!state) throw notFound();

  if (!mayCalculatePeriod(actor, state.status as PayrollPeriodStatus)) {
    if (isPeriodSettled(state.status as PayrollPeriodStatus)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `${state.code} is ${state.status.toLowerCase()} and cannot be recalculated.`,
      );
    }
    if (state.status === 'PENDING_APPROVAL' || state.status === 'APPROVED') {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `${state.code} is awaiting or has received approval. Recalculating it would change figures somebody has already decided on — send it back first.`,
      );
    }
    throw new AppError('FORBIDDEN', 403, 'Costing a payroll run needs payroll edit rights.');
  }

  const policy = await resolvePolicy(state);
  const { divisor, fellBack } = calc.resolveDivisor(policy);

  const warnings: PayrollCalculationResultView['warnings'] = [];
  const blockers: PayrollCalculationResultView['blockers'] = [];

  if (fellBack) {
    blockers.push({
      employeeId: null,
      message:
        'The working-day divisor is configured but no attendance exists for this period, so calendar days were used. Configure holidays and week-offs, or change the basis.',
    });
  }

  const everybody = await repo.employeesForPeriod();
  const targeted = input.employeeIds?.length
    ? everybody.filter((e) => input.employeeIds?.includes(e.id))
    : everybody;

  let calculated = 0;
  let excluded = 0;

  for (const employee of targeted) {
    const salary = await repo.findSalaryOn(employee.id, state.periodEnd);
    const reason = calc.eligibilityFor({
      status: employee.status,
      joiningDate: employee.joiningDate,
      exitDate: employee.exitDate,
      periodStart: state.periodStart,
      periodEnd: state.periodEnd,
      hasSalaryAssignment: salary !== null,
    });

    if (reason !== null) {
      await repo.prisma.$transaction(
        (tx) =>
          repo.upsertItem(tx, id, employee.id, {
            status: 'EXCLUDED',
            exclusionReason: reason,
            exclusionNote: null,
            currency: state.currency,
            // Figures cleared: the payroll_item_totals_when_calculated CHECK
            // requires an excluded line to carry none, so a total can never
            // silently include somebody who was left out.
            monthlyGross: null,
            grossEarnings: null,
            totalDeductions: null,
            employerContributions: null,
            netPay: null,
            payableDays: null,
            calculatedAt: null,
          }),
        TX_OPTIONS,
      );
      excluded += 1;
      if (reason === 'NO_SALARY_ASSIGNMENT') {
        warnings.push({
          employeeId: employee.id,
          employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
          message: 'No salary assignment is in force for this period, so they were not costed.',
        });
      }
      continue;
    }

    if (!salary) continue; // Unreachable: eligibilityFor returns NO_SALARY_ASSIGNMENT.

    // --- Attendance inputs, read rather than assumed --------------------
    const [totals, unpaidDays, overtime] = await Promise.all([
      repo.attendanceTotals(employee.id, state.periodStart, state.periodEnd),
      repo.unpaidLeaveDays(employee.id, state.periodStart, state.periodEnd),
      repo.approvedOvertimeMinutes(employee.id, state.periodStart, state.periodEnd),
    ]);

    const countOf = (status: string): number =>
      totals.find((t) => t.status === status)?._count._all ?? 0;

    const presentDays = countOf('PRESENT') + countOf('HALF_DAY') * 0.5;
    const leaveDays = countOf('LEAVE');
    const paidLeaveDays = Math.max(leaveDays - unpaidDays, 0);
    const holidayDays = countOf('HOLIDAY');
    const weekOffDays = countOf('WEEK_OFF');
    const hasAttendance = totals.length > 0;

    /*
      No attendance at all for the period is NOT silently treated as a full
      month. It is reported, and the employee is costed as present for the whole
      divisor — which is the only defensible reading of "a salaried employee with
      no attendance records" — but the warning says so plainly so an HR user can
      decide whether the attendance is simply missing.
    */
    const attendance: calc.CalcAttendance = hasAttendance
      ? {
          presentDays: presentDays.toFixed(2),
          paidLeaveDays: paidLeaveDays.toFixed(2),
          unpaidLeaveDays: unpaidDays.toFixed(2),
          holidayDays: holidayDays.toFixed(2),
          weekOffDays: weekOffDays.toFixed(2),
          overtimeMinutes: overtime._sum.minutes ?? 0,
        }
      : {
          presentDays: divisor.toFixed(2),
          paidLeaveDays: '0.00',
          unpaidLeaveDays: '0.00',
          holidayDays: '0.00',
          weekOffDays: '0.00',
          overtimeMinutes: overtime._sum.minutes ?? 0,
        };

    if (!hasAttendance) {
      warnings.push({
        employeeId: employee.id,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        message:
          'No attendance records exist for this period, so they were costed as present for the full month. Check that attendance has been captured.',
      });
    }

    // --- Component set, resolved through structure then employee override ---
    const components = resolveComponents(salary);
    const problems = calc.validateComponentSet(components);
    if (problems.length > 0) {
      blockers.push({
        employeeId: employee.id,
        message: `${employee.firstName} ${employee.lastName}: ${problems.join(' ')}`,
      });
      continue;
    }

    const pending = await repo.pendingAdjustmentsFor(employee.id, id);
    const result = calc.calculateEmployeePay({
      monthlyGross: salary.monthlyGross.toFixed(2),
      components,
      attendance,
      policy,
      adjustments: pending.map((a) => ({
        kind: a.kind,
        amount: a.amount.toFixed(2),
        reference: a.reference,
      })),
    });

    if (result.isNegativeNet) {
      blockers.push({
        employeeId: employee.id,
        message: `${employee.firstName} ${employee.lastName}: deductions exceed earnings, so net pay is negative. This must be resolved before the run can be finalised.`,
      });
    }
    for (const note of result.notApplied) {
      warnings.push({
        employeeId: employee.id,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        message: note,
      });
    }

    await repo.prisma.$transaction(async (tx) => {
      const item = await repo.upsertItem(tx, id, employee.id, {
        status: 'CALCULATED',
        exclusionReason: null,
        exclusionNote: null,
        currency: salary.currency,
        salaryAssignmentId: salary.id,
        monthlyGross: salary.monthlyGross,
        presentDays: attendance.presentDays,
        paidLeaveDays: attendance.paidLeaveDays,
        unpaidLeaveDays: attendance.unpaidLeaveDays,
        holidayDays: attendance.holidayDays,
        weekOffDays: attendance.weekOffDays,
        payableDays: result.payableDays,
        overtimeMinutes: attendance.overtimeMinutes,
        grossEarnings: result.grossEarnings,
        totalDeductions: result.totalDeductions,
        employerContributions: result.employerContributions,
        netPay: result.netPay,
        // Snapshot stays null until finalisation: before then the figures can
        // still legitimately change, and a snapshot that moved would not be one.
        snapshot: Prisma.DbNull,
        calculatedAt: new Date(),
      });

      // Replaced wholesale rather than merged, which is what makes a
      // recalculation idempotent: a component removed from the structure
      // disappears from the line instead of lingering.
      await repo.clearItemLines(tx, item.id);
      await repo.addItemLines(
        tx,
        result.lines.map((l) => ({
          itemId: item.id,
          componentCode: l.componentCode,
          componentName: l.componentName,
          kind: l.kind,
          calculation: l.calculation,
          rate: l.rate,
          fullAmount: l.fullAmount,
          amount: l.amount,
          prorationNote: l.prorationNote,
          displayOrder: l.displayOrder,
        })),
      );

      if (pending.length > 0) {
        await repo.claimAdjustments(
          tx,
          pending.filter((a) => a.periodId === null).map((a) => a.id),
          id,
        );
      }
    }, TX_OPTIONS);

    calculated += 1;
  }

  // --- Period totals, written once every line has settled ---------------
  const items = await repo.itemsForPeriod(id);
  const costed = items.filter((i) => i.status === 'CALCULATED' || i.status === 'FINALIZED');
  const totals = calc.periodTotals(
    costed.map((i) => ({
      grossEarnings: dec(i.grossEarnings) ?? '0.00',
      totalDeductions: dec(i.totalDeductions) ?? '0.00',
      employerContributions: dec(i.employerContributions) ?? '0.00',
      netPay: dec(i.netPay) ?? '0.00',
    })),
  );

  await repo.prisma.$transaction(async (tx) => {
    const moved = await repo.transitionPeriod(tx, {
      id,
      fromStatuses: ['DRAFT', 'CALCULATED'],
      data: {
        status: 'CALCULATED',
        payableDaysDivisor: divisor,
        grossEarnings: totals.grossEarnings,
        totalDeductions: totals.totalDeductions,
        employerContributions: totals.employerContributions,
        netPay: totals.netPay,
        employeeCount: costed.length,
        calculatedAt: new Date(),
        calculatedById: actor.id,
      },
    });
    if (moved === 0) {
      // Somebody submitted or cancelled the run while this calculation was
      // mid-flight. The item rows are idempotent so nothing is corrupted, but the
      // period must not be dragged back to CALCULATED.
      throw new AppError(
        'CONFLICT',
        409,
        'Somebody else changed this payroll run while it was being costed. Reload and try again.',
      );
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'PAYROLL_CALCULATED',
    entityType: 'PayrollPeriod',
    entityId: id,
    actorId: actor.id,
    newValue: {
      calculated,
      excluded,
      divisor,
      blockers: blockers.length,
      netPay: totals.netPay,
    },
  });

  return {
    period: await getPeriod(actor, id),
    calculated,
    excluded,
    warnings,
    blockers,
  };
}

/**
 * The effective component set for one assignment.
 *
 * Resolution order: the component's own configuration, then the structure's
 * override, then the employee's. Later wins, which is what makes a per-employee
 * exception possible without duplicating a structure.
 *
 * **Each component appears exactly once.** The map is keyed by component id, so a
 * component carrying both a structure amount and an employee override is counted
 * once with the override applied — never twice. Acceptance check 7.
 */
function resolveComponents(
  salary: Prisma.EmployeeSalaryGetPayload<{ select: typeof repo.salarySelect }>,
): calc.CalcComponent[] {
  const byId = new Map<string, calc.CalcComponent>();

  for (const sc of salary.structure?.components ?? []) {
    byId.set(sc.component.id, {
      code: sc.component.code,
      name: sc.component.name,
      kind: sc.component.kind,
      calculation: sc.component.calculation,
      rate: dec(sc.rateOverride ?? sc.component.rate),
      amount: dec(sc.amount),
      capAmount: dec(sc.component.capAmount),
      floorAmount: dec(sc.component.floorAmount),
      isBase: sc.component.isBase,
      prorates: sc.component.prorates,
      displayOrder: sc.displayOrder,
    });
  }

  for (const ov of salary.overrides) {
    const existing = byId.get(ov.component.id);
    byId.set(ov.component.id, {
      code: ov.component.code,
      name: ov.component.name,
      kind: ov.component.kind,
      calculation: ov.component.calculation,
      rate: dec(ov.rateOverride) ?? existing?.rate ?? dec(ov.component.rate),
      amount: dec(ov.amount) ?? existing?.amount ?? null,
      capAmount: dec(ov.component.capAmount),
      floorAmount: dec(ov.component.floorAmount),
      isBase: ov.component.isBase,
      prorates: ov.component.prorates,
      displayOrder: existing?.displayOrder ?? ov.component.displayOrder,
    });
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
//  Exclusion
// ---------------------------------------------------------------------------

export async function excludeItem(
  req: Request,
  actor: HrActor,
  periodId: string,
  itemId: string,
  input: ExcludePayrollItemInput,
): Promise<PayrollItemView> {
  const state = await repo.findPeriodState(periodId);
  if (!state) throw notFound();
  if (!mayExcludeItem(actor, state.status as PayrollPeriodStatus)) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `${state.code} is ${state.status.toLowerCase()} and its lines can no longer be changed.`,
    );
  }

  const item = await repo.findItem(itemId);
  if (!item || item.periodId !== periodId) throw notFound();

  await repo.prisma.$transaction(
    (tx) =>
      repo.updateItem(tx, itemId, {
        status: 'EXCLUDED',
        exclusionReason: 'MANUALLY_EXCLUDED',
        exclusionNote: input.note,
        grossEarnings: null,
        totalDeductions: null,
        employerContributions: null,
        netPay: null,
        payableDays: null,
        monthlyGross: null,
        calculatedAt: null,
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'PAYROLL_ITEM_EXCLUDED',
    entityType: 'PayrollItem',
    entityId: itemId,
    actorId: actor.id,
    newValue: { employeeId: item.employee.id, note: input.note },
  });

  const refreshed = await repo.findItem(itemId);
  if (!refreshed) throw notFound();
  return presentItem(refreshed);
}

// ---------------------------------------------------------------------------
//  Approval
// ---------------------------------------------------------------------------

export async function submitPeriod(
  req: Request,
  actor: HrActor,
  id: string,
  input: SubmitPayrollInput,
): Promise<PayrollPeriodView> {
  const state = await repo.findPeriodState(id);
  if (!state) throw notFound();

  if (!maySubmitPeriod(actor, state.status as PayrollPeriodStatus)) {
    if (state.status !== 'CALCULATED') {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `Only a costed run can be submitted. ${state.code} is ${state.status.toLowerCase()}.`,
      );
    }
    throw new AppError('FORBIDDEN', 403, 'Submitting a payroll run needs payroll edit rights.');
  }

  const items = await repo.itemsForPeriod(id);
  const costed = items.filter((i) => i.status === 'CALCULATED');
  if (costed.length === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'This run has no costed employees. Calculate it before submitting.',
    );
  }
  const negative = items.filter((i) => i.netPay !== null && i.netPay.lessThan(0));
  if (negative.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `${negative.length} employee${negative.length === 1 ? ' has' : 's have'} a negative net pay. Resolve that before submitting, or exclude them.`,
    );
  }

  const approval = await createApprovalRequest(
    { id: actor.id, role: actor.role },
    {
      entityType: 'PayrollPeriod',
      entityId: id,
      module: 'HR_PAYROLL',
      action: 'APPROVE',
      ...(input.reason ? { reason: input.reason } : {}),
      // Deliberately no totals in the payload: an ApprovalRequest is readable to
      // anybody who can read approvals, which is a wider set than payroll.
      payload: { periodCode: state.code, employeeCount: costed.length },
    },
  );

  await repo.prisma.$transaction(async (tx) => {
    const moved = await repo.transitionPeriod(tx, {
      id,
      fromStatuses: ['CALCULATED'],
      data: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id },
    });
    if (moved === 0) {
      throw new AppError(
        'CONFLICT',
        409,
        'Somebody else changed this payroll run. Reload and try again.',
      );
    }
  }, TX_OPTIONS);

  const approvers = await usersWithPermission('HR_PAYROLL', 'APPROVE');
  await notify.notifyPayrollApprovalRequired(
    approvers.map((u) => u.id),
    id,
    state.name,
    costed.length,
  );

  await recordAudit(req, {
    action: 'PAYROLL_SUBMITTED_FOR_APPROVAL',
    entityType: 'PayrollPeriod',
    entityId: id,
    actorId: actor.id,
    newValue: { approvalRequestId: approval.id, employeeCount: costed.length },
  });

  return getPeriod(actor, id);
}

/**
 * Approves or rejects a submitted run.
 *
 * `paysActor` is resolved **before** the access check, and `mayDecidePeriod`
 * refuses the subject first. An approver who is paid by this run is approving
 * their own pay.
 */
export async function decidePeriod(
  req: Request,
  actor: HrActor,
  id: string,
  input: DecidePayrollInput,
): Promise<PayrollPeriodView> {
  const state = await repo.findPeriodState(id);
  if (!state) throw notFound();

  const paysActor = await periodPaysActor(actor, id);
  if (!mayDecidePeriod(actor, state.status as PayrollPeriodStatus, paysActor)) {
    if (paysActor) {
      throw new AppError(
        'FORBIDDEN',
        403,
        'You are paid by this payroll run, so you cannot approve it. Somebody else with payroll approval rights has to decide it.',
      );
    }
    if (state.status !== 'PENDING_APPROVAL') {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `${state.code} is ${state.status.toLowerCase()} and is not waiting for a decision.`,
      );
    }
    throw new AppError('FORBIDDEN', 403, 'Deciding a payroll run needs payroll approval rights.');
  }

  if (state.approvalRequestId) {
    await decideApprovalRequest({ id: actor.id, role: actor.role }, state.approvalRequestId, {
      decision: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      ...(input.note ? { note: input.note } : {}),
    });
  }

  const approved = input.decision === 'APPROVE';
  await repo.prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);
    const moved = await repo.transitionPeriod(tx, {
      id,
      fromStatuses: ['PENDING_APPROVAL'],
      data: approved
        ? { status: 'APPROVED', approvedAt: now, approvedById: actor.id, approvalRequestId: null }
        : // Rejected goes back to CALCULATED so the HR team can fix and resubmit.
          // The approval stamps stay null, because nothing was approved.
          { status: 'CALCULATED', approvalRequestId: null },
    });
    if (moved === 0) {
      throw new AppError(
        'CONFLICT',
        409,
        'Somebody else decided this payroll run first. Reload to see the outcome.',
      );
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: approved ? 'PAYROLL_APPROVED' : 'PAYROLL_REJECTED',
    entityType: 'PayrollPeriod',
    entityId: id,
    actorId: actor.id,
    newValue: { decision: input.decision, note: input.note ?? null },
  });

  return getPeriod(actor, id);
}

/**
 * Finalises an approved run — the action that locks the figures.
 *
 * **One transaction.** The period transition, every item's status change and
 * every snapshot write happen together. A failure anywhere rolls all of it back,
 * which is what makes a partially finalised run impossible.
 *
 * **The subject is refused first**, before any permission is consulted.
 *
 * The snapshots are the immutability guarantee: written once, inside this
 * transaction, and never updated by any code path afterwards. The
 * `payroll_item_finalized_has_snapshot` CHECK makes a finalised item without one
 * impossible even if this code were wrong.
 */
export async function finalizePeriod(
  req: Request,
  actor: HrActor,
  id: string,
  input: FinalizePayrollInput,
): Promise<PayrollPeriodView> {
  const state = await repo.findPeriodState(id);
  if (!state) throw notFound();

  const paysActor = await periodPaysActor(actor, id);
  if (!mayFinalizePeriod(actor, state.status as PayrollPeriodStatus, paysActor)) {
    if (paysActor) {
      throw new AppError(
        'FORBIDDEN',
        403,
        'You are paid by this payroll run, so you cannot finalise it. Somebody else with payroll approval rights has to.',
      );
    }
    if (isPeriodSettled(state.status as PayrollPeriodStatus)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `${state.code} is already ${state.status.toLowerCase()}.`,
      );
    }
    if (state.status !== 'APPROVED') {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `Only an approved run can be finalised. ${state.code} is ${state.status.toLowerCase()}.`,
      );
    }
    throw new AppError('FORBIDDEN', 403, 'Finalising a payroll run needs payroll approval rights.');
  }

  // `acknowledgeNotStatutory` is enforced by the Zod literal, but re-checked
  // here so a direct service call cannot bypass it.
  if (input.acknowledgeNotStatutory !== true) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'Finalising requires acknowledging that statutory calculations are configured, not certified.',
    );
  }

  const items = await repo.itemsForPeriod(id);
  const costed = items.filter((i) => i.status === 'CALCULATED');
  if (costed.length === 0) {
    throw new AppError('VALIDATION_ERROR', 400, 'There is nothing costed to finalise.');
  }
  const negative = items.filter((i) => i.netPay !== null && i.netPay.lessThan(0));
  if (negative.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      `${negative.length} employee${negative.length === 1 ? ' has' : 's have'} a negative net pay. A run cannot be finalised in that state.`,
    );
  }

  const policy = await resolvePolicy(state);
  const fullItems = await Promise.all(costed.map((i) => repo.findItem(i.id)));

  await repo.prisma.$transaction(async (tx) => {
    const now = await repo.databaseNow(tx);

    // The period transition first: if somebody else finalised it a moment ago,
    // this fails before any snapshot is written.
    const moved = await repo.transitionPeriod(tx, {
      id,
      fromStatuses: ['APPROVED'],
      data: { status: 'FINALIZED', finalizedAt: now, finalizedById: actor.id },
    });
    if (moved === 0) {
      throw new AppError(
        'CONFLICT',
        409,
        'This payroll run was already finalised by somebody else. Reload to see it.',
      );
    }

    // Every snapshot, inside the same transaction.
    for (const item of fullItems) {
      if (!item) continue;
      const snapshot: PayrollItemSnapshot = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        computedAt: now.toISOString(),
        dailyRateBasis: state.dailyRateBasis,
        roundingMode: state.roundingMode,
        payableDaysDivisor: state.payableDaysDivisor,
        calendarDays: state.calendarDays,
        workingDays: state.workingDays,
        monthlyGross: dec(item.monthlyGross) ?? '0.00',
        currency: item.currency,
        attendance: {
          presentDays: dec(item.presentDays) ?? '0.00',
          paidLeaveDays: dec(item.paidLeaveDays) ?? '0.00',
          unpaidLeaveDays: dec(item.unpaidLeaveDays) ?? '0.00',
          holidayDays: dec(item.holidayDays) ?? '0.00',
          weekOffDays: dec(item.weekOffDays) ?? '0.00',
          payableDays: dec(item.payableDays) ?? '0.00',
          overtimeMinutes: item.overtimeMinutes ?? 0,
          overtimeMultiplier: policy.overtimeMultiplier,
        },
        lines: item.lines.map((l) => ({
          componentCode: l.componentCode,
          componentName: l.componentName,
          kind: l.kind,
          calculation: l.calculation,
          rate: dec(l.rate),
          fullAmount: l.fullAmount.toFixed(2),
          amount: l.amount.toFixed(2),
        })),
        adjustments: [],
        totals: {
          grossEarnings: dec(item.grossEarnings) ?? '0.00',
          totalDeductions: dec(item.totalDeductions) ?? '0.00',
          employerContributions: dec(item.employerContributions) ?? '0.00',
          netPay: dec(item.netPay) ?? '0.00',
        },
        notApplied: notAppliedFor(item, policy),
      };
      await repo.setItemSnapshot(tx, item.id, snapshot as unknown as Prisma.InputJsonValue);
    }

    // One statement, not a loop: a partial failure part-way through a loop would
    // leave some lines FINALIZED and some CALCULATED, which is exactly the
    // partially finalised state that must be impossible.
    await repo.finalizeItems(tx, id);
    // The wider budget: a failed finalisation after approval is the most
    // alarming error this module can produce. See TX_OPTIONS_CRITICAL.
  }, TX_OPTIONS_CRITICAL);

  // Notifications after the transaction commits, so a transport failure cannot
  // roll back a finalisation that has already happened.
  const employeeUserIds = await Promise.all(
    costed.map(async (i) => {
      const ref = await repo.findEmployeeRef(i.employeeId);
      return ref?.userId ?? null;
    }),
  );
  for (const [index, userId] of employeeUserIds.entries()) {
    if (!userId) continue;
    const item = costed[index];
    if (!item) continue;
    await notify.notifyPayslipAvailable([userId], item.id, state.name);
  }

  const payrollTeam = await usersWithPermission('HR_PAYROLL', 'VIEW');
  await notify.notifyPayrollFinalized(
    payrollTeam.map((u) => u.id),
    id,
    state.name,
  );

  await recordAudit(req, {
    action: 'PAYROLL_FINALIZED',
    entityType: 'PayrollPeriod',
    entityId: id,
    actorId: actor.id,
    newValue: {
      employeeCount: costed.length,
      note: input.note ?? null,
      acknowledgedNotStatutory: true,
    },
  });

  return getPeriod(actor, id);
}

/**
 * What a payslip does not include.
 *
 * Reconstructed at finalisation from the item and the policy rather than carried
 * through from the calculation, so the statement is true of the figures actually
 * being locked. An empty list is a meaningful claim; a missing one is not.
 */
function notAppliedFor(
  item: Prisma.PayrollItemGetPayload<{ select: typeof repo.itemSelect }>,
  policy: calc.CalcPolicy,
): string[] {
  const notes: string[] = [];
  if ((item.overtimeMinutes ?? 0) > 0 && policy.overtimeMultiplier === null) {
    notes.push(
      `${item.overtimeMinutes} approved overtime minutes were not valued: no overtime multiplier is configured.`,
    );
  }
  if (!item.lines.some((l) => l.kind === 'DEDUCTION')) {
    notes.push(
      'No deductions were applied: none are configured. This payslip includes no statutory contribution or tax.',
    );
  }
  notes.push(
    'Statutory calculations in this system are configured, not certified. This payslip is not a compliance document.',
  );
  return notes;
}

export async function cancelPeriod(
  req: Request,
  actor: HrActor,
  id: string,
  input: CancelPayrollInput,
): Promise<PayrollPeriodView> {
  const state = await repo.findPeriodState(id);
  if (!state) throw notFound();

  if (!mayCancelPeriod(actor, state.status as PayrollPeriodStatus)) {
    if (isPeriodSettled(state.status as PayrollPeriodStatus)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `${state.code} is ${state.status.toLowerCase()} and cannot be cancelled. A finalised run is corrected by an adjustment in a later period.`,
      );
    }
    throw new AppError('FORBIDDEN', 403, 'Cancelling a payroll run needs payroll approval rights.');
  }

  await repo.prisma.$transaction(async (tx) => {
    const moved = await repo.transitionPeriod(tx, {
      id,
      fromStatuses: ['DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED'],
      data: { status: 'CANCELLED', cancellationReason: input.reason },
    });
    if (moved === 0) {
      throw new AppError(
        'CONFLICT',
        409,
        'Somebody else changed this payroll run. Reload and try again.',
      );
    }
    // Adjustments return to the queue rather than being destroyed with the run.
    await repo.releaseAdjustments(tx, id);
  }, TX_OPTIONS);

  if (state.approvalRequestId) {
    await cancelApprovalRequest({ id: actor.id, role: actor.role }, state.approvalRequestId).catch(
      () => undefined,
    );
  }

  await recordAudit(req, {
    action: 'PAYROLL_CANCELLED',
    entityType: 'PayrollPeriod',
    entityId: id,
    actorId: actor.id,
    newValue: { reason: input.reason },
  });

  return getPeriod(actor, id);
}

// ---------------------------------------------------------------------------
//  Items, payslips and self-service
// ---------------------------------------------------------------------------

export async function listItems(
  actor: HrActor,
  periodId: string,
  query: { cursor?: string; limit: number; departmentId?: string; status?: string; search?: string },
): Promise<{ items: PayrollItemView[]; nextCursor: string | null }> {
  const filter = visiblePayrollItemFilter(actor);
  // `null` means "entitled to nothing" and must return nothing. Treating it as
  // "no filter" would hand back the entire company's salaries.
  if (filter === null) throw notFound();

  const rows = await repo.listItems({
    where: {
      periodId,
      ...filter,
      ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
      ...(query.status ? { status: query.status as 'PENDING' } : {}),
      ...(query.search
        ? {
            employee: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
                { employeeId: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(presentItem),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/**
 * One payslip, from the finalised snapshot.
 *
 * **Never recomputed.** Every input can legitimately change after finalisation —
 * the component rate, the structure, the assignment, the attendance policy — so
 * a payslip that recomputed itself would silently restate what somebody was
 * paid. The snapshot is the document.
 *
 * Scope is resolved from `Employee.userId` against the actor's resolved
 * `employeeId`, and a payslip outside scope returns **404 rather than 403**:
 * "you may not read employee X's payslip" confirms X is paid and roughly when.
 */
export async function getPayslip(actor: HrActor, itemId: string): Promise<PayslipView> {
  const row = await repo.findItemWithPeriod(itemId);
  if (!row) throw notFound();

  const isOwn = actor.employeeId !== null && actor.employeeId === row.employee.id;
  if (!mayReadPayslip(actor, isOwn, row.period.status as PayrollPeriodStatus)) {
    // 404 for a reader out of scope; a specific message only when the period
    // itself is not finalised, which is not a confidentiality matter.
    if (row.period.status !== 'FINALIZED') {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'A payslip is issued only once the payroll run is finalised.',
      );
    }
    throw notFound();
  }

  const snapshot = row.snapshot as PayrollItemSnapshot | null;
  if (!snapshot) {
    throw new AppError(
      'VALIDATION_ERROR',
      400,
      'This payslip has no stored computation and cannot be displayed.',
    );
  }

  const linesOf = (kind: string) =>
    snapshot.lines
      .filter((l) => l.kind === kind)
      .map((l) => ({ label: l.componentName, amount: l.amount }));

  return {
    itemId: row.id,
    period: {
      id: row.period.id,
      code: row.period.code,
      name: row.period.name,
      year: row.period.year,
      month: row.period.month,
      periodStart: row.period.periodStart.toISOString(),
      periodEnd: row.period.periodEnd.toISOString(),
    },
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: `${row.employee.firstName} ${row.employee.lastName}`.trim(),
      departmentName: row.employee.department?.name ?? null,
      designationName: row.employee.designation?.name ?? null,
    },
    currency: snapshot.currency,
    earnings: linesOf('EARNING'),
    deductions: linesOf('DEDUCTION'),
    employerContributions: linesOf('EMPLOYER_CONTRIBUTION'),
    grossEarnings: snapshot.totals.grossEarnings,
    totalDeductions: snapshot.totals.totalDeductions,
    netPay: snapshot.totals.netPay,
    attendance: {
      payableDays: snapshot.attendance.payableDays,
      unpaidLeaveDays: snapshot.attendance.unpaidLeaveDays,
      overtimeMinutes: snapshot.attendance.overtimeMinutes,
    },
    notApplied: snapshot.notApplied,
    documentUrl: null,
    finalizedAt: row.period.finalizedAt?.toISOString() ?? null,
  };
}

/**
 * An employee's own pay, for self-service.
 *
 * Scoped to the actor's own employee record with no payroll grant required, and
 * **never** parameterised by an employee id — there is no way to ask this
 * endpoint about somebody else, which is a stronger guarantee than checking an
 * id against a scope.
 */
export async function getMyPayroll(actor: HrActor): Promise<MyPayrollView> {
  if (!actor.employeeId) {
    return { employee: null, currentSalary: null, payslips: [] };
  }

  const [employee, salary, items] = await Promise.all([
    repo.findEmployeeRef(actor.employeeId),
    repo.findSalaryOn(actor.employeeId, new Date()),
    repo.finalizedItemsForEmployee(actor.employeeId, 24),
  ]);

  return {
    employee: employee
      ? {
          id: employee.id,
          employeeId: employee.employeeId,
          displayName: `${employee.firstName} ${employee.lastName}`.trim(),
          departmentName: employee.department?.name ?? null,
          designationName: employee.designation?.name ?? null,
        }
      : null,
    currentSalary: salary
      ? {
          monthlyGross: salary.monthlyGross.toFixed(2),
          currency: salary.currency,
          effectiveFrom: salary.effectiveFrom.toISOString(),
          structureName: salary.structure?.name ?? null,
        }
      : null,
    payslips: items.map((i) => ({
      itemId: i.id,
      periodId: i.period.id,
      periodCode: i.period.code,
      periodName: i.period.name,
      year: i.period.year,
      month: i.period.month,
      netPay: dec(i.netPay) ?? '0.00',
      currency: i.currency,
      finalizedAt: i.period.finalizedAt?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
//  Summary, export and adjustments
// ---------------------------------------------------------------------------

export async function getSummary(
  actor: HrActor,
  periodId: string,
): Promise<PayrollPeriodSummaryView> {
  if (!mayViewSummary(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Reading the payroll summary needs payroll access.');
  }
  const period = await repo.findPeriod(periodId);
  if (!period) throw notFound();

  const items = await repo.itemsForPeriod(periodId);
  const costed = items.filter((i) => i.status === 'CALCULATED' || i.status === 'FINALIZED');

  const byDeptMap = new Map<
    string,
    { departmentId: string | null; departmentName: string; employeeCount: number; gross: Prisma.Decimal; ded: Prisma.Decimal; net: Prisma.Decimal }
  >();
  for (const item of costed) {
    const key = item.employee.department?.id ?? 'none';
    const entry = byDeptMap.get(key) ?? {
      departmentId: item.employee.department?.id ?? null,
      departmentName: item.employee.department?.name ?? 'Unassigned',
      employeeCount: 0,
      gross: new Prisma.Decimal(0),
      ded: new Prisma.Decimal(0),
      net: new Prisma.Decimal(0),
    };
    entry.employeeCount += 1;
    entry.gross = entry.gross.add(item.grossEarnings ?? 0);
    entry.ded = entry.ded.add(item.totalDeductions ?? 0);
    entry.net = entry.net.add(item.netPay ?? 0);
    byDeptMap.set(key, entry);
  }

  const byComponentMap = new Map<
    string,
    { componentCode: string; componentName: string; kind: string; total: Prisma.Decimal }
  >();
  for (const item of costed) {
    for (const line of item.lines) {
      const entry = byComponentMap.get(line.componentCode) ?? {
        componentCode: line.componentCode,
        componentName: line.componentName,
        kind: line.kind,
        total: new Prisma.Decimal(0),
      };
      entry.total = entry.total.add(line.amount);
      byComponentMap.set(line.componentCode, entry);
    }
  }

  const totals = calc.periodTotals(
    costed.map((i) => ({
      grossEarnings: dec(i.grossEarnings) ?? '0.00',
      totalDeductions: dec(i.totalDeductions) ?? '0.00',
      employerContributions: dec(i.employerContributions) ?? '0.00',
      netPay: dec(i.netPay) ?? '0.00',
    })),
  );

  return {
    period: {
      id: period.id,
      code: period.code,
      name: period.name,
      year: period.year,
      month: period.month,
      status: period.status as PayrollPeriodStatus,
      currency: period.currency,
    },
    totals: {
      ...totals,
      excludedCount: items.filter((i) => i.status === 'EXCLUDED').length,
      negativeNetCount: items.filter((i) => i.netPay !== null && i.netPay.lessThan(0)).length,
    },
    byDepartment: [...byDeptMap.values()].map((d) => ({
      departmentId: d.departmentId,
      departmentName: d.departmentName,
      employeeCount: d.employeeCount,
      grossEarnings: d.gross.toFixed(2),
      totalDeductions: d.ded.toFixed(2),
      netPay: d.net.toFixed(2),
    })),
    byComponent: [...byComponentMap.values()].map((c) => ({
      componentCode: c.componentCode,
      componentName: c.componentName,
      kind: c.kind as 'EARNING',
      total: c.total.toFixed(2),
    })),
  };
}

/**
 * The payroll register as CSV.
 *
 * Requires **EXPORT**, not VIEW. Reading one payslip on screen and taking every
 * salary in the company out of the building are different risks, and only the
 * second leaves — which is the reason the EXPORT action exists. Audited
 * separately from reading, with the row count recorded.
 */
export async function exportRegister(
  req: Request,
  actor: HrActor,
  periodId: string,
): Promise<{ filename: string; csv: string }> {
  if (!mayExportPayroll(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Exporting payroll needs the payroll export permission, which is separate from being able to read it.',
    );
  }
  const period = await repo.findPeriod(periodId);
  if (!period) throw notFound();

  const items = await repo.itemsForPeriod(periodId);
  const costed = items.filter((i) => i.status === 'CALCULATED' || i.status === 'FINALIZED');

  const escape = (cell: string): string =>
    /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;

  const header = [
    'Employee Id',
    'Name',
    'Department',
    'Currency',
    'Gross Earnings',
    'Total Deductions',
    'Employer Contributions',
    'Net Pay',
  ];
  const rows = await Promise.all(
    costed.map(async (i) => {
      const ref = await repo.findEmployeeRef(i.employeeId);
      return [
        ref?.employeeId ?? '',
        `${i.employee.firstName} ${i.employee.lastName}`.trim(),
        i.employee.department?.name ?? '',
        period.currency,
        dec(i.grossEarnings) ?? '0.00',
        dec(i.totalDeductions) ?? '0.00',
        dec(i.employerContributions) ?? '0.00',
        dec(i.netPay) ?? '0.00',
      ].map(escape);
    }),
  );

  await recordAudit(req, {
    action: 'PAYROLL_EXPORTED',
    entityType: 'PayrollPeriod',
    entityId: periodId,
    actorId: actor.id,
    newValue: { rowCount: rows.length, periodCode: period.code },
  });

  return {
    filename: `payroll-register-${period.code}.csv`,
    csv: [header.join(','), ...rows.map((r) => r.join(','))].join('\r\n'),
  };
}

export async function createAdjustment(
  req: Request,
  actor: HrActor,
  input: CreatePayrollAdjustmentInput,
): Promise<PayrollAdjustmentView> {
  if (!mayRecordAdjustment(actor, input.employeeId)) {
    if (actor.employeeId !== null && actor.employeeId === input.employeeId) {
      throw new AppError(
        'FORBIDDEN',
        403,
        'You cannot record a payroll adjustment against yourself. Somebody else with payroll approval rights has to.',
      );
    }
    throw new AppError(
      'FORBIDDEN',
      403,
      'Recording a payroll adjustment needs payroll approval rights.',
    );
  }

  const employee = await repo.findEmployeeRef(input.employeeId);
  if (!employee) throw notFound();

  if (input.correctsPeriodId) {
    const corrected = await repo.findPeriodState(input.correctsPeriodId);
    if (!corrected) {
      throw new AppError('VALIDATION_ERROR', 400, 'The period being corrected does not exist.');
    }
    if (corrected.status !== 'FINALIZED') {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        `${corrected.code} is not finalised, so it can be recalculated directly rather than adjusted.`,
      );
    }
  }

  const id = await repo.prisma.$transaction(async (tx) => {
    const created = await repo.createAdjustment(tx, {
      employeeId: input.employeeId,
      kind: input.kind,
      amount: input.amount,
      reason: input.reason,
      correctsPeriodId: input.correctsPeriodId ?? null,
      reference: input.reference ?? null,
      createdById: actor.id,
    });
    return created.id;
  }, TX_OPTIONS);

  if (employee.userId) {
    await notify.notifyAdjustmentRecorded([employee.userId], id, input.kind);
  }

  await recordAudit(req, {
    action: 'PAYROLL_ADJUSTMENT_RECORDED',
    entityType: 'PayrollAdjustment',
    entityId: id,
    actorId: actor.id,
    newValue: {
      employeeId: input.employeeId,
      kind: input.kind,
      amount: normaliseAmount(input.amount),
      correctsPeriodId: input.correctsPeriodId ?? null,
    },
  });

  const rows = await repo.listAdjustments({ id });
  const row = rows[0];
  if (!row) throw notFound();
  return {
    id: row.id,
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: `${row.employee.firstName} ${row.employee.lastName}`.trim(),
      departmentName: row.employee.department?.name ?? null,
      designationName: row.employee.designation?.name ?? null,
    },
    periodId: row.periodId,
    kind: row.kind,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    reason: row.reason,
    correctsPeriodId: row.correctsPeriodId,
    reference: row.reference,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAdjustments(
  actor: HrActor,
  employeeId?: string,
): Promise<{ adjustments: PayrollAdjustmentView[] }> {
  const scope = payrollScope(actor);
  if (scope.kind === 'none') throw notFound();

  const target = employeeId ?? (scope.kind === 'self' ? scope.employeeId : undefined);
  if (scope.kind === 'self' && target !== scope.employeeId) throw notFound();

  const rows = await repo.listAdjustments(target ? { employeeId: target } : {});
  return {
    adjustments: rows.map((row) => ({
      id: row.id,
      employee: {
        id: row.employee.id,
        employeeId: row.employee.employeeId,
        displayName: `${row.employee.firstName} ${row.employee.lastName}`.trim(),
        departmentName: row.employee.department?.name ?? null,
        designationName: row.employee.designation?.name ?? null,
      },
      periodId: row.periodId,
      kind: row.kind,
      amount: row.amount.toFixed(2),
      currency: row.currency,
      reason: row.reason,
      correctsPeriodId: row.correctsPeriodId,
      reference: row.reference,
      createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** The payroll dashboard, scoped to what the reader may see. */
export async function getOverview(actor: HrActor): Promise<PayrollOverviewView> {
  const scope = payrollScope(actor);
  const canReadAll = scope.kind === 'all';

  const myLatest = actor.employeeId
    ? await repo.finalizedItemsForEmployee(actor.employeeId, 1)
    : [];
  const latest = myLatest[0];

  if (!canReadAll) {
    return {
      canReadAll: false,
      openPeriods: [],
      awaitingApprovalCount: 0,
      activeComponentCount: 0,
      activeStructureCount: 0,
      employeesWithoutSalaryCount: null,
      lastFinalizedPeriod: null,
      myLatestPayslip: latest
        ? {
            itemId: latest.id,
            periodCode: latest.period.code,
            periodName: latest.period.name,
            netPay: dec(latest.netPay) ?? '0.00',
            currency: latest.currency,
          }
        : null,
    };
  }

  const [open, awaiting, components, structures, gaps, lastFinal] = await Promise.all([
    repo.openPeriods(),
    repo.countPeriodsAwaitingApproval(),
    repo.activeComponentCount(),
    repo.activeStructureCount(),
    repo.employeesWithoutSalary(),
    repo.lastFinalizedPeriod(),
  ]);

  return {
    canReadAll: true,
    openPeriods: open.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status as PayrollPeriodStatus,
      year: p.year,
      month: p.month,
      employeeCount: p.employeeCount,
    })),
    awaitingApprovalCount: awaiting,
    activeComponentCount: components,
    activeStructureCount: structures,
    employeesWithoutSalaryCount: gaps,
    lastFinalizedPeriod: lastFinal
      ? {
          id: lastFinal.id,
          code: lastFinal.code,
          name: lastFinal.name,
          netPay: dec(lastFinal.netPay) ?? '0.00',
          currency: lastFinal.currency,
          finalizedAt: lastFinal.finalizedAt?.toISOString() ?? null,
        }
      : null,
    myLatestPayslip: latest
      ? {
          itemId: latest.id,
          periodCode: latest.period.code,
          periodName: latest.period.name,
          netPay: dec(latest.netPay) ?? '0.00',
          currency: latest.currency,
        }
      : null,
  };
}
