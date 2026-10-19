/**
 * Every payroll query and write, in one place.
 *
 * No business rules and no authorization: this file knows how to read and write
 * rows, and `payroll.service.ts` decides whether it should. Following
 * `hr.repository.ts`, `attendance.repository.ts`, `recruitment.repository.ts`,
 * `training.repository.ts` and `performance.repository.ts`.
 *
 * ### The two mechanisms that make duplicate payroll impossible
 *
 * **`allocatePayrollCode`** uses `INSERT … ON CONFLICT DO UPDATE … RETURNING`,
 * because `SELECT max(…) + 1` read by two concurrent creates hands both the same
 * number. The same mechanism as every other code counter in this codebase.
 *
 * **`transitionPeriod`** is a conditional `updateMany` with a status predicate.
 * Two concurrent finalisation requests both pass a service-level status check and
 * both proceed; only one matches `status IN ('APPROVED')` at the moment of the
 * write, and the second sees `count === 0` and is refused. That is what stops a
 * period being finalised twice, stamping two finalisers and sending the employee
 * two notifications.
 *
 * Neither is a substitute for the other, and neither is a substitute for the
 * `@@unique([year, month])` and `@@unique([periodId, employeeId])` constraints —
 * those are what make a duplicate row impossible even if every service check
 * were removed.
 *
 * ### What this module never writes
 *
 * `User`, `UserModulePermission`, `Employee`, `Department`, `Designation`,
 * `AttendanceRecord`, `LeaveRequest`, `OvertimeRecord` and every Sales,
 * Procurement and Dispatch table. Payroll reads attendance and leave; it does not
 * correct them. An attendance figure that is wrong is fixed in the attendance
 * module, and the payroll is then recalculated.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

/**
 * The transaction budget for ordinary payroll writes.
 *
 * Fifteen seconds, matching the other HR modules.
 */
export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/**
 * A wider budget for the two transactions that must not fail on latency alone.
 *
 * ### Why this exists
 *
 * Period creation is two statements — allocate a code, insert a row — and a
 * payroll run's finalisation is a handful more. Neither does meaningful work.
 * But both are on the critical path of something a person is waiting for, and
 * **both failing is worse than both being slow**: a 500 from period creation
 * leaves an HR user unsure whether the run exists, and a failed finalisation
 * after approval is the most alarming error this module can produce.
 *
 * This was not a theoretical concern. An integration run against a cold remote
 * Neon instance produced:
 *
 *   P2028 — "The timeout for this transaction was 15000 ms, however 15127 ms
 *   passed since the start of the transaction"
 *
 * on `POST /payroll/periods`, from two statements. Each round trip had taken
 * seconds; nothing was doing too much work. Raising the ceiling for these two
 * costs nothing when the database is healthy — a transaction that commits in
 * 200 ms is unaffected by its timeout being 45 s rather than 15 s — and removes
 * a failure mode that has nothing to do with the code being correct.
 *
 * It is deliberately **not** applied to the per-employee calculation
 * transactions. Those are in a loop over possibly hundreds of employees, where a
 * tight budget is the thing that stops one pathological row stalling the whole
 * run. Keeping them at 15 s is the point.
 */
export const TX_OPTIONS_CRITICAL = { timeout: 45_000, maxWait: 20_000 } as const;

// ---------------------------------------------------------------------------
//  Selects
// ---------------------------------------------------------------------------

const userRefSelect = { id: true, name: true } satisfies Prisma.UserSelect;

const employeeRefSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  lastName: true,
  userId: true,
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

export const componentSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  kind: true,
  calculation: true,
  rate: true,
  capAmount: true,
  floorAmount: true,
  isBase: true,
  prorates: true,
  isTaxable: true,
  isActive: true,
  displayOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SalaryComponentSelect;

export const structureSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  currency: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  components: {
    select: {
      id: true,
      amount: true,
      rateOverride: true,
      displayOrder: true,
      component: { select: componentSelect },
    },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.SalaryStructureSelect;

export const salarySelect = {
  id: true,
  monthlyGross: true,
  currency: true,
  effectiveFrom: true,
  effectiveTo: true,
  notes: true,
  createdAt: true,
  employee: { select: employeeRefSelect },
  structure: { select: structureSelect },
  createdBy: { select: userRefSelect },
  overrides: {
    select: {
      id: true,
      amount: true,
      rateOverride: true,
      component: { select: componentSelect },
    },
  },
} satisfies Prisma.EmployeeSalarySelect;

export const periodSelect = {
  id: true,
  code: true,
  name: true,
  periodStart: true,
  periodEnd: true,
  year: true,
  month: true,
  status: true,
  currency: true,
  dailyRateBasis: true,
  roundingMode: true,
  calendarDays: true,
  workingDays: true,
  payableDaysDivisor: true,
  grossEarnings: true,
  totalDeductions: true,
  employerContributions: true,
  netPay: true,
  employeeCount: true,
  calculatedAt: true,
  approvalRequestId: true,
  approvedAt: true,
  finalizedAt: true,
  notes: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  calculatedBy: { select: userRefSelect },
  approvedBy: { select: userRefSelect },
  finalizedBy: { select: userRefSelect },
  createdBy: { select: userRefSelect },
} satisfies Prisma.PayrollPeriodSelect;

export const itemSelect = {
  id: true,
  periodId: true,
  status: true,
  exclusionReason: true,
  exclusionNote: true,
  currency: true,
  salaryAssignmentId: true,
  monthlyGross: true,
  presentDays: true,
  paidLeaveDays: true,
  unpaidLeaveDays: true,
  holidayDays: true,
  weekOffDays: true,
  payableDays: true,
  overtimeMinutes: true,
  grossEarnings: true,
  totalDeductions: true,
  employerContributions: true,
  netPay: true,
  snapshot: true,
  payslipDocumentId: true,
  calculatedAt: true,
  employee: { select: employeeRefSelect },
  lines: {
    select: {
      id: true,
      componentCode: true,
      componentName: true,
      kind: true,
      calculation: true,
      rate: true,
      fullAmount: true,
      amount: true,
      prorationNote: true,
      displayOrder: true,
    },
    orderBy: [{ displayOrder: 'asc' }, { componentCode: 'asc' }],
  },
} satisfies Prisma.PayrollItemSelect;

export const adjustmentSelect = {
  id: true,
  periodId: true,
  kind: true,
  amount: true,
  currency: true,
  reason: true,
  correctsPeriodId: true,
  reference: true,
  createdAt: true,
  employee: { select: employeeRefSelect },
  createdBy: { select: userRefSelect },
} satisfies Prisma.PayrollAdjustmentSelect;

// ---------------------------------------------------------------------------
//  Code allocation
// ---------------------------------------------------------------------------

/**
 * The next payroll reference in a scope, allocated atomically.
 *
 * `SELECT max(…) + 1` read by two concurrent creates hands both the same number,
 * and a payroll code appears on documents people keep.
 */
export async function allocatePayrollCode(
  tx: Prisma.TransactionClient,
  scope: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "PayrollCodeCounter" ("scope", "lastValue", "updatedAt")
    VALUES (${scope}, 1, now())
    ON CONFLICT ("scope")
    DO UPDATE SET
      "lastValue" = "PayrollCodeCounter"."lastValue" + 1,
      "updatedAt" = now()
    RETURNING "lastValue"
  `;
  const next = rows[0]?.lastValue;
  if (next === undefined) throw new Error('Payroll code counter returned no value');
  return next;
}

/** The database's own clock, so a stamp never depends on the app server's. */
export async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  const now = rows[0]?.now;
  if (!now) throw new Error('Could not read the database clock');
  return now;
}

// ---------------------------------------------------------------------------
//  Salary components
// ---------------------------------------------------------------------------

export function listComponents(where: Prisma.SalaryComponentWhereInput) {
  return prisma.salaryComponent.findMany({
    where,
    select: componentSelect,
    orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
  });
}

export function findComponent(id: string) {
  return prisma.salaryComponent.findUnique({ where: { id }, select: componentSelect });
}

export function findComponentByCode(code: string) {
  return prisma.salaryComponent.findUnique({ where: { code }, select: componentSelect });
}

export function createComponent(data: Prisma.SalaryComponentUncheckedCreateInput) {
  return prisma.salaryComponent.create({ data, select: componentSelect });
}

export function updateComponent(
  id: string,
  data: Prisma.SalaryComponentUncheckedUpdateInput,
) {
  return prisma.salaryComponent.update({ where: { id }, data, select: componentSelect });
}

/**
 * Whether a component is referenced by any structure or assignment.
 *
 * Read before a delete is allowed. A component in use is deactivated rather than
 * removed, because a historical payslip line names it and the snapshot that
 * explains that line is keyed on its code.
 */
export async function componentUsage(id: string): Promise<number> {
  const [structures, overrides] = await Promise.all([
    prisma.salaryStructureComponent.count({ where: { componentId: id } }),
    prisma.employeeSalaryComponent.count({ where: { componentId: id } }),
  ]);
  return structures + overrides;
}

export function deleteComponent(id: string) {
  return prisma.salaryComponent.delete({ where: { id } });
}

// ---------------------------------------------------------------------------
//  Salary structures
// ---------------------------------------------------------------------------

export function listStructures(args: {
  where: Prisma.SalaryStructureWhereInput;
  take: number;
  cursor?: string;
}) {
  return prisma.salaryStructure.findMany({
    where: args.where,
    select: structureSelect,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function findStructure(id: string) {
  return prisma.salaryStructure.findUnique({ where: { id }, select: structureSelect });
}

export function findStructureByCode(code: string) {
  return prisma.salaryStructure.findUnique({ where: { code }, select: { id: true } });
}

export function createStructure(
  tx: Prisma.TransactionClient,
  data: Prisma.SalaryStructureUncheckedCreateInput,
) {
  return tx.salaryStructure.create({ data, select: { id: true } });
}

export function addStructureComponents(
  tx: Prisma.TransactionClient,
  rows: Prisma.SalaryStructureComponentUncheckedCreateInput[],
) {
  return tx.salaryStructureComponent.createMany({ data: rows });
}

export function clearStructureComponents(tx: Prisma.TransactionClient, structureId: string) {
  return tx.salaryStructureComponent.deleteMany({ where: { structureId } });
}

export function updateStructure(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.SalaryStructureUncheckedUpdateInput,
) {
  return tx.salaryStructure.update({ where: { id }, data, select: { id: true } });
}

export function structureAssignmentCount(structureId: string): Promise<number> {
  return prisma.employeeSalary.count({ where: { structureId } });
}

// ---------------------------------------------------------------------------
//  Employee salary assignments
// ---------------------------------------------------------------------------

export function listSalaries(where: Prisma.EmployeeSalaryWhereInput) {
  return prisma.employeeSalary.findMany({
    where,
    select: salarySelect,
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  });
}

export function findSalary(id: string) {
  return prisma.employeeSalary.findUnique({ where: { id }, select: salarySelect });
}

/**
 * The assignment in force for an employee on a date.
 *
 * `effectiveFrom <= on` and either no end or an end at or after the date. Ordered
 * descending so the most recent qualifying assignment wins, which is what makes
 * two overlapping rows resolve deterministically rather than arbitrarily.
 */
export function findSalaryOn(employeeId: string, on: Date) {
  return prisma.employeeSalary.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
    },
    select: salarySelect,
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
  });
}

export function createSalary(
  tx: Prisma.TransactionClient,
  data: Prisma.EmployeeSalaryUncheckedCreateInput,
) {
  return tx.employeeSalary.create({ data, select: { id: true } });
}

export function addSalaryOverrides(
  tx: Prisma.TransactionClient,
  rows: Prisma.EmployeeSalaryComponentUncheckedCreateInput[],
) {
  return tx.employeeSalaryComponent.createMany({ data: rows });
}

/**
 * Closes the previous open assignment for an employee.
 *
 * Sets `effectiveTo` to the day before the new one begins. An append-only history
 * still needs each row to say when it stopped applying, or "what was in force in
 * March" becomes a window function over every row the employee ever had.
 */
export function closeOpenSalaries(
  tx: Prisma.TransactionClient,
  employeeId: string,
  closeAt: Date,
  exceptId: string,
) {
  return tx.employeeSalary.updateMany({
    where: {
      employeeId,
      id: { not: exceptId },
      effectiveTo: null,
      effectiveFrom: { lte: closeAt },
    },
    data: { effectiveTo: closeAt },
  });
}

export function findSalaryAt(employeeId: string, effectiveFrom: Date) {
  return prisma.employeeSalary.findUnique({
    where: { employeeId_effectiveFrom: { employeeId, effectiveFrom } },
    select: { id: true },
  });
}

/** Employees with no salary assignment at all, for the dashboard gap count. */
export function employeesWithoutSalary(): Promise<number> {
  return prisma.employee.count({
    where: {
      status: { in: ['PROBATION', 'ACTIVE', 'ON_NOTICE'] },
      salaryAssignments: { none: {} },
    },
  });
}

// ---------------------------------------------------------------------------
//  Periods
// ---------------------------------------------------------------------------

export function listPeriods(args: {
  where: Prisma.PayrollPeriodWhereInput;
  take: number;
  cursor?: string;
}) {
  return prisma.payrollPeriod.findMany({
    where: args.where,
    select: periodSelect,
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { id: 'desc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function findPeriod(id: string) {
  return prisma.payrollPeriod.findUnique({ where: { id }, select: periodSelect });
}

export function findPeriodByMonth(year: number, month: number) {
  return prisma.payrollPeriod.findUnique({
    where: { year_month: { year, month } },
    select: { id: true, code: true, status: true },
  });
}

/** Minimal state for a transition decision, read before the write. */
export function findPeriodState(id: string) {
  return prisma.payrollPeriod.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      year: true,
      month: true,
      periodStart: true,
      periodEnd: true,
      currency: true,
      dailyRateBasis: true,
      roundingMode: true,
      calendarDays: true,
      workingDays: true,
      payableDaysDivisor: true,
      approvalRequestId: true,
      calculatedById: true,
    },
  });
}

export function createPeriod(
  tx: Prisma.TransactionClient,
  data: Prisma.PayrollPeriodUncheckedCreateInput,
) {
  return tx.payrollPeriod.create({ data, select: { id: true } });
}

export function updatePeriod(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.PayrollPeriodUncheckedUpdateInput,
) {
  return tx.payrollPeriod.update({ where: { id }, data, select: { id: true } });
}

/**
 * Moves a period, but only from one of the statuses given.
 *
 * Returns the number of rows changed: **zero means somebody else moved it
 * first**, and every caller must treat that as a conflict rather than success.
 * Two concurrent finalisations both pass a service-level status check; only one
 * matches the predicate here.
 */
export async function transitionPeriod(
  tx: Prisma.TransactionClient,
  args: {
    id: string;
    fromStatuses: readonly string[];
    data: Prisma.PayrollPeriodUncheckedUpdateInput;
  },
): Promise<number> {
  const result = await tx.payrollPeriod.updateMany({
    where: { id: args.id, status: { in: args.fromStatuses as Prisma.Enumerable<never> } },
    data: args.data,
  });
  return result.count;
}

export function openPeriods() {
  return prisma.payrollPeriod.findMany({
    where: { status: { in: ['DRAFT', 'CALCULATED', 'PENDING_APPROVAL', 'APPROVED'] } },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      year: true,
      month: true,
      employeeCount: true,
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take: 12,
  });
}

export function countPeriodsAwaitingApproval(): Promise<number> {
  return prisma.payrollPeriod.count({ where: { status: 'PENDING_APPROVAL' } });
}

export function lastFinalizedPeriod() {
  return prisma.payrollPeriod.findFirst({
    where: { status: 'FINALIZED' },
    select: { id: true, code: true, name: true, netPay: true, currency: true, finalizedAt: true },
    orderBy: [{ finalizedAt: 'desc' }],
  });
}

/** The next open period an adjustment can attach to. */
export function nextOpenPeriod() {
  return prisma.payrollPeriod.findFirst({
    where: { status: { in: ['DRAFT', 'CALCULATED'] } },
    select: { id: true, year: true, month: true },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });
}

// ---------------------------------------------------------------------------
//  Items and lines
// ---------------------------------------------------------------------------

export function listItems(args: {
  where: Prisma.PayrollItemWhereInput;
  take: number;
  cursor?: string;
}) {
  return prisma.payrollItem.findMany({
    where: args.where,
    select: itemSelect,
    orderBy: [{ employee: { lastName: 'asc' } }, { id: 'asc' }],
    take: args.take,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
}

export function findItem(id: string) {
  return prisma.payrollItem.findUnique({ where: { id }, select: itemSelect });
}

/**
 * One item with its period's status and the subject's user id.
 *
 * `employee.userId` rather than `employee.employeeId` is what answers "is this
 * reader the subject", because `User.employeeId` and `Employee.employeeId` are
 * different columns that usually agree and are not guaranteed to — a Phase 5
 * defect came from exactly that comparison.
 */
export function findItemWithPeriod(id: string) {
  return prisma.payrollItem.findUnique({
    where: { id },
    select: {
      ...itemSelect,
      period: {
        select: {
          id: true,
          code: true,
          name: true,
          year: true,
          month: true,
          periodStart: true,
          periodEnd: true,
          status: true,
          finalizedAt: true,
          currency: true,
        },
      },
    },
  });
}

export function itemsForPeriod(periodId: string) {
  return prisma.payrollItem.findMany({
    where: { periodId },
    select: {
      id: true,
      status: true,
      grossEarnings: true,
      totalDeductions: true,
      employerContributions: true,
      netPay: true,
      snapshot: true,
      employeeId: true,
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          department: { select: { id: true, name: true } },
        },
      },
      lines: {
        select: { componentCode: true, componentName: true, kind: true, amount: true },
      },
    },
  });
}

export function upsertItem(
  tx: Prisma.TransactionClient,
  periodId: string,
  employeeId: string,
  data: Omit<Prisma.PayrollItemUncheckedUpdateInput, 'periodId' | 'employeeId'>,
) {
  return tx.payrollItem.upsert({
    where: { periodId_employeeId: { periodId, employeeId } },
    // `periodId` and `employeeId` last: they are the row's identity and must not
    // be overridable by a caller's payload, which spreading them first allows.
    create: {
      ...(data as Prisma.PayrollItemUncheckedCreateInput),
      periodId,
      employeeId,
    },
    update: data,
    select: { id: true },
  });
}

export function clearItemLines(tx: Prisma.TransactionClient, itemId: string) {
  return tx.payrollItemLine.deleteMany({ where: { itemId } });
}

export function addItemLines(
  tx: Prisma.TransactionClient,
  rows: Prisma.PayrollItemLineUncheckedCreateInput[],
) {
  return tx.payrollItemLine.createMany({ data: rows });
}

export function updateItem(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.PayrollItemUncheckedUpdateInput,
) {
  return tx.payrollItem.update({ where: { id }, data, select: { id: true } });
}

/**
 * Finalises every calculated line in a period, in one statement.
 *
 * `updateMany` with a status predicate rather than a loop: a partial failure
 * part-way through a loop would leave some lines FINALIZED and some CALCULATED,
 * which is exactly the "partially finalized payroll" state that must be
 * impossible. One statement inside the finalisation transaction either applies
 * to all of them or to none.
 */
export async function finalizeItems(
  tx: Prisma.TransactionClient,
  periodId: string,
): Promise<number> {
  const result = await tx.payrollItem.updateMany({
    where: { periodId, status: 'CALCULATED' },
    data: { status: 'FINALIZED' },
  });
  return result.count;
}

export function setItemSnapshot(
  tx: Prisma.TransactionClient,
  id: string,
  snapshot: Prisma.InputJsonValue,
) {
  return tx.payrollItem.update({ where: { id }, data: { snapshot }, select: { id: true } });
}

/** An employee's finalised payslips, newest first. */
export function finalizedItemsForEmployee(employeeId: string, take: number) {
  return prisma.payrollItem.findMany({
    where: { employeeId, status: 'FINALIZED', period: { status: 'FINALIZED' } },
    select: {
      id: true,
      netPay: true,
      currency: true,
      period: {
        select: {
          id: true,
          code: true,
          name: true,
          year: true,
          month: true,
          finalizedAt: true,
        },
      },
    },
    orderBy: [{ period: { year: 'desc' } }, { period: { month: 'desc' } }],
    take,
  });
}

export function setPayslipDocument(
  tx: Prisma.TransactionClient,
  itemId: string,
  documentId: string,
) {
  return tx.payrollItem.update({
    where: { id: itemId },
    data: { payslipDocumentId: documentId },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
//  Adjustments
// ---------------------------------------------------------------------------

export function listAdjustments(where: Prisma.PayrollAdjustmentWhereInput) {
  return prisma.payrollAdjustment.findMany({
    where,
    select: adjustmentSelect,
    orderBy: [{ createdAt: 'desc' }],
  });
}

export function createAdjustment(
  tx: Prisma.TransactionClient,
  data: Prisma.PayrollAdjustmentUncheckedCreateInput,
) {
  return tx.payrollAdjustment.create({ data, select: { id: true } });
}

/** Unclaimed adjustments for an employee, which a calculation picks up. */
export function pendingAdjustmentsFor(employeeId: string, periodId: string) {
  return prisma.payrollAdjustment.findMany({
    where: { employeeId, OR: [{ periodId: null }, { periodId }] },
    select: { id: true, kind: true, amount: true, reference: true, periodId: true },
  });
}

export function claimAdjustments(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
  periodId: string,
) {
  return tx.payrollAdjustment.updateMany({
    where: { id: { in: ids as string[] }, periodId: null },
    data: { periodId },
  });
}

/** Releases a cancelled period's adjustments back to the queue. */
export function releaseAdjustments(tx: Prisma.TransactionClient, periodId: string) {
  return tx.payrollAdjustment.updateMany({
    where: { periodId },
    data: { periodId: null },
  });
}

// ---------------------------------------------------------------------------
//  Eligibility and attendance inputs
// ---------------------------------------------------------------------------

/**
 * Everybody who could be in a run, with the facts eligibility needs.
 *
 * Deliberately returns EXITED and INACTIVE employees too: whether somebody who
 * left mid-month is paid is an eligibility decision made in
 * `payroll.calc.ts#eligibilityFor`, not a filter here. A repository that
 * pre-filtered them would make the exclusion invisible, and "why was I not paid"
 * must always be answerable.
 */
export function employeesForPeriod() {
  return prisma.employee.findMany({
    where: { status: { in: ['PROBATION', 'ACTIVE', 'ON_NOTICE', 'EXITED', 'INACTIVE'] } },
    select: {
      id: true,
      employeeId: true,
      firstName: true,
      lastName: true,
      status: true,
      joiningDate: true,
      exitDate: true,
      userId: true,
      department: { select: { id: true, name: true } },
      designation: { select: { id: true, name: true } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
}

/**
 * Attendance for one employee over a date span, grouped by status.
 *
 * Read rather than computed: the attendance module owns these rows and payroll
 * reports what they say. A half day counts as 0.5 of a present day, which is why
 * HALF_DAY is counted separately rather than folded into PRESENT.
 */
export function attendanceTotals(employeeId: string, from: Date, to: Date) {
  return prisma.attendanceRecord.groupBy({
    by: ['status'],
    where: { employeeId, attendanceDate: { gte: from, lte: to } },
    _count: { _all: true },
    _sum: { overtimeMinutes: true },
  });
}

/**
 * Unpaid-leave days in a span, from `LeaveType.isPaid`.
 *
 * **The paid/unpaid distinction is data, not a payroll assumption.** The leave
 * module records it on the type; this query reads it. Only APPROVED requests
 * count — a pending request is not yet a fact about somebody's pay.
 */
export function unpaidLeaveDays(employeeId: string, from: Date, to: Date) {
  return prisma.attendanceRecord.count({
    where: {
      employeeId,
      attendanceDate: { gte: from, lte: to },
      status: 'LEAVE',
      leaveRequest: { status: 'APPROVED', leaveType: { isPaid: false } },
    },
  });
}

/** Approved overtime minutes in a span. PENDING overtime is not paid. */
export function approvedOvertimeMinutes(employeeId: string, from: Date, to: Date) {
  return prisma.overtimeRecord.aggregate({
    where: {
      employeeId,
      overtimeDate: { gte: from, lte: to },
      status: 'APPROVED',
    },
    _sum: { minutes: true },
  });
}

/**
 * Working days in a span, from holidays and the attendance records themselves.
 *
 * Counts days that are neither a holiday nor a week-off. Returns zero when no
 * attendance exists for the span, which `resolveDivisor` treats as "no
 * working-day figure available" and falls back from — with the fallback reported
 * rather than silent.
 */
export async function workingDaysIn(from: Date, to: Date): Promise<number> {
  const rows = await prisma.attendanceRecord.groupBy({
    by: ['attendanceDate'],
    where: { attendanceDate: { gte: from, lte: to }, status: { notIn: ['HOLIDAY', 'WEEK_OFF'] } },
  });
  return rows.length;
}

export function findEmployeeRef(employeeId: string) {
  return prisma.employee.findUnique({
    where: { id: employeeId },
    select: employeeRefSelect,
  });
}

export function findEmployeeByUserId(userId: string) {
  return prisma.employee.findUnique({
    where: { userId },
    select: employeeRefSelect,
  });
}

/** Whether a named employee has a calculated line in a period. */
export function itemExistsFor(periodId: string, employeeId: string) {
  return prisma.payrollItem.findUnique({
    where: { periodId_employeeId: { periodId, employeeId } },
    select: { id: true, status: true },
  });
}

export function activeComponentCount(): Promise<number> {
  return prisma.salaryComponent.count({ where: { isActive: true } });
}

export function activeStructureCount(): Promise<number> {
  return prisma.salaryStructure.count({ where: { isActive: true } });
}

export { prisma };
