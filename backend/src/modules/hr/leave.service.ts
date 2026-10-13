/**
 * HR Phase 2 — Leave business rules.
 *
 * ### The balance invariant, which everything here protects
 *
 * A balance is a *cache* of the ledger. Every movement writes both, in one
 * transaction, after locking the balance row. That gives three properties:
 *
 *   1. **No lost update.** `lockBalance` takes a row lock before any arithmetic,
 *      so two concurrent approvals cannot both read "2 days available" and both
 *      deduct. The lock is taken by an upsert-then-lock, because `FOR UPDATE`
 *      cannot lock a row that does not exist yet.
 *   2. **No divergence.** The ledger row and the balance update are written by
 *      one repository function, so a caller cannot write one without the other.
 *   3. **Explainability.** Any balance can be re-derived by replaying its ledger,
 *      which is the question actually asked when somebody disputes a number.
 *
 * ### Reservations
 *
 * A PENDING request *reserves* its days rather than spending them, and
 * `available` subtracts reserved. Without that, an employee with one day left
 * could apply twice and have both approved by different managers. Approval moves
 * the days from reserved to used; rejection and cancellation release them.
 *
 * ### Day counting
 *
 * Always through the one shared calculator in `@rs/shared/leave-days`. The
 * request, the reservation, the approval and the attendance resolution must agree
 * — three of them agreeing is not reassuring when the fourth moved the balance.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  calculateLeaveDays,
  companyDateOf,
  companyDaysBetween,
  isHoliday as isHolidayOn,
  isWeekOff as isWeekOffOn,
  longestConsecutiveWorkingRun,
  type CancelLeaveRequestInput,
  type CreateLeavePolicyInput,
  type CreateLeaveRequestInput,
  type CreateLeaveTypeInput,
  type DecideLeaveRequestInput,
  type LeaveBalanceQuery,
  type LeaveBalanceView,
  type LeaveDayPreview,
  type LeaveDayPreviewInput,
  type LeavePolicyView,
  type LeaveRequestDetail,
  type LeaveRequestListQuery,
  type LeaveRequestPage,
  type LeaveRequestRow,
  type LeaveTypeListQuery,
  type LeaveTypeView,
  type UpdateLeavePolicyInput,
  type UpdateLeaveTypeInput,
  type AdjustLeaveBalanceInput,
  type AllocateLeaveInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import * as repo from './leave.repository.js';
import * as attendanceRepo from './attendance.repository.js';
import * as notify from './attendance.notify.js';
import {
  leaveScope,
  mayAdjustBalance,
  mayApplyForLeave,
  mayCancelApprovedLeave,
  mayCancelOwnRequest,
  mayConfigureHr,
  mayDecideRequest,
  mayReadEmployeeRecords,
  scopedEmployeeFilter,
  type HrRecordScope,
} from './attendance-access.js';
import type { HrActor } from './hr-access.js';
import { resolveDay } from './attendance.calc.js';
import {
  applyLedgerEntry,
  availableDays,
  carryForwardDays,
  hasSufficientBalance,
  normaliseDays,
  type BalanceComponents,
} from './leave.calc.js';

export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/** Week-offs when no attendance policy is configured. Matches the schema default. */
const FALLBACK_WEEK_OFF = [6, 7];

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

const displayName = (p: { firstName: string; lastName: string }): string =>
  `${p.firstName} ${p.lastName}`.trim();

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
/** A nullable day figure, canonicalised — null stays null, not "0.00". */
const dec = (v: Prisma.Decimal | null): string | null =>
  v === null ? null : normaliseDays(v.toString());

const toLeaveTypeView = (row: repo.LeaveTypeRecord): LeaveTypeView => ({
  id: row.id,
  name: row.name,
  code: row.code,
  description: row.description,
  isPaid: row.isPaid,
  isActive: row.isActive,
  halfDayAllowed: row.halfDayAllowed,
  approvalRequired: row.approvalRequired,
  accrualEnabled: row.accrualEnabled,
  carryForwardEnabled: row.carryForwardEnabled,
  carryForwardLimit: dec(row.carryForwardLimit),
  encashmentAllowed: row.encashmentAllowed,
});

const toPolicyView = (row: repo.LeavePolicyRecord): LeavePolicyView => ({
  id: row.id,
  leaveType: row.leaveType,
  department: row.department,
  annualEntitlement: normaliseDays(row.annualEntitlement.toString()),
  accrualPerPeriod: dec(row.accrualPerPeriod),
  minNoticeDays: row.minNoticeDays,
  maxConsecutiveDays: row.maxConsecutiveDays,
  isActive: row.isActive,
});

function toRequestRow(row: repo.LeaveRequestRecord): LeaveRequestRow {
  return {
    id: row.id,
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: displayName(row.employee),
    },
    leaveType: row.leaveType,
    startDate: dayKey(row.startDate),
    endDate: dayKey(row.endDate),
    isHalfDay: row.isHalfDay,
    halfDayPeriod: row.halfDayPeriod,
    requestedDays: normaliseDays(row.requestedDays.toString()),
    reason: row.reason,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote,
    cancelledAt: iso(row.cancelledAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toRequestDetail(row: repo.LeaveRequestDetailRecord): LeaveRequestDetail {
  return {
    ...toRequestRow(row),
    cancellationNote: row.cancellationNote,
    updatedAt: row.updatedAt.toISOString(),
    ledger: row.ledger.map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      days: normaliseDays(entry.days.toString()),
      note: entry.note,
      performedBy: entry.performedBy,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

/**
 * The balance, with `available` derived rather than read from a column.
 *
 * Every component is put through `normaliseDays`, which matters more than it
 * looks: `Prisma.Decimal.toString()` renders 20 as `"20"` while the derived
 * `available` is always `"20.00"`. Returning both shapes in one response would
 * make the API inconsistent about the same kind of value, and any client
 * comparing or formatting them would have to handle two formats. One format, set
 * here, matching the `Decimal(6,2)` column.
 */
function toBalanceView(row: repo.LeaveBalanceRecord): LeaveBalanceView {
  const components: BalanceComponents = {
    allocated: normaliseDays(row.allocated.toString()),
    accrued: normaliseDays(row.accrued.toString()),
    carriedForward: normaliseDays(row.carriedForward.toString()),
    used: normaliseDays(row.used.toString()),
    reserved: normaliseDays(row.reserved.toString()),
    adjusted: normaliseDays(row.adjusted.toString()),
  };

  return {
    leaveType: row.leaveType,
    periodYear: row.periodYear,
    ...components,
    available: availableDays(components),
  };
}

// ---------------------------------------------------------------------------
//  Scope and context
// ---------------------------------------------------------------------------

async function scopeFor(actor: HrActor): Promise<HrRecordScope> {
  if (actor.can('HR_LEAVE', 'VIEW')) return { kind: 'all' };
  if (!actor.employeeId) return { kind: 'none' };

  const reports = await prisma.employee.count({ where: { managerId: actor.employeeId } });
  return leaveScope(actor, { hasReports: reports > 0 });
}

const notFound = (): AppError =>
  AppError.notFound('LEAVE_NOT_FOUND', 'That leave request could not be found.');

function ownEmployeeOrFail(actor: HrActor): string {
  if (!actor.employeeId) {
    throw new AppError(
      'NO_EMPLOYEE_RECORD',
      403,
      'Your account is not linked to an employee record, so leave cannot be applied for.',
    );
  }
  return actor.employeeId;
}

/**
 * The week-off pattern and holidays governing one employee over a range.
 *
 * Fetched once and handed to the pure calculator, so the calculator stays
 * testable and the two cannot disagree about which days are working days.
 */
async function workingDayContext(
  client: Prisma.TransactionClient | typeof prisma,
  employee: { departmentId: string | null },
  from: Date,
  to: Date,
): Promise<{
  workWeek: { weekOffDays: number[] };
  holidays: { holidayDate: Date; departmentId: string | null }[];
}> {
  const policy = await attendanceRepo.policyForEmployee(client, employee.departmentId);
  const holidays = await attendanceRepo.holidaysInRange(
    client,
    from,
    to,
    employee.departmentId,
  );

  return {
    workWeek: { weekOffDays: policy?.weekOffDays ?? FALLBACK_WEEK_OFF },
    holidays,
  };
}

/** The leave year a date falls in. Calendar year — see the schema note. */
const periodYearOf = (day: Date): number => companyDateOf(day).getUTCFullYear();

// ---------------------------------------------------------------------------
//  Types and policies
// ---------------------------------------------------------------------------

export async function listLeaveTypes(query: LeaveTypeListQuery): Promise<LeaveTypeView[]> {
  const rows = await repo.listLeaveTypes(
    query.isActive === undefined ? {} : { isActive: query.isActive },
  );
  return rows.map(toLeaveTypeView);
}

export async function createLeaveType(
  req: Request,
  actor: HrActor,
  input: CreateLeaveTypeInput,
): Promise<LeaveTypeView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure leave types.');
  }

  // The schema uppercases the code, so this catches "sick" against "SICK" rather
  // than letting two types exist that read as one.
  const clash = await repo.findLeaveTypeByCode(input.code);
  if (clash) {
    throw AppError.conflict('LEAVE_TYPE_CODE_TAKEN', 'A leave type with that code already exists.');
  }

  let created: { id: string };
  try {
    created = await repo.createLeaveType({
      name: input.name,
      code: input.code,
      description: input.description ?? null,
      ...(input.isPaid === undefined ? {} : { isPaid: input.isPaid }),
      ...(input.halfDayAllowed === undefined ? {} : { halfDayAllowed: input.halfDayAllowed }),
      ...(input.approvalRequired === undefined ? {} : { approvalRequired: input.approvalRequired }),
      ...(input.accrualEnabled === undefined ? {} : { accrualEnabled: input.accrualEnabled }),
      ...(input.carryForwardEnabled === undefined
        ? {}
        : { carryForwardEnabled: input.carryForwardEnabled }),
      ...(input.carryForwardLimit === undefined
        ? {}
        : { carryForwardLimit: String(input.carryForwardLimit) }),
      ...(input.encashmentAllowed === undefined
        ? {}
        : { encashmentAllowed: input.encashmentAllowed }),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'LEAVE_TYPE_CODE_TAKEN',
        'A leave type with that code already exists.',
      );
    }
    throw error;
  }

  await recordAudit(req, {
    action: 'HR_LEAVE_TYPE_CREATED',
    entityType: 'LeaveType',
    entityId: created.id,
    actorId: actor.id,
    newValue: { name: input.name, code: input.code },
  });

  const record = await repo.findLeaveType(prisma, created.id);
  if (!record) {
    throw AppError.notFound('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
  }
  return toLeaveTypeView(record);
}

export async function updateLeaveType(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateLeaveTypeInput,
): Promise<LeaveTypeView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure leave types.');
  }

  const before = await repo.findLeaveType(prisma, id);
  if (!before) {
    throw AppError.notFound('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
  }

  await repo.updateLeaveType(id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.isPaid === undefined ? {} : { isPaid: input.isPaid }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.halfDayAllowed === undefined ? {} : { halfDayAllowed: input.halfDayAllowed }),
    ...(input.approvalRequired === undefined ? {} : { approvalRequired: input.approvalRequired }),
    ...(input.accrualEnabled === undefined ? {} : { accrualEnabled: input.accrualEnabled }),
    ...(input.carryForwardEnabled === undefined
      ? {}
      : { carryForwardEnabled: input.carryForwardEnabled }),
    ...(input.carryForwardLimit === undefined
      ? {}
      : {
          carryForwardLimit:
            input.carryForwardLimit === null ? null : String(input.carryForwardLimit),
        }),
    ...(input.encashmentAllowed === undefined ? {} : { encashmentAllowed: input.encashmentAllowed }),
  });

  await recordAudit(req, {
    action: 'HR_LEAVE_TYPE_UPDATED',
    entityType: 'LeaveType',
    entityId: id,
    actorId: actor.id,
    oldValue: { name: before.name, isActive: before.isActive },
    newValue: { name: input.name ?? before.name, isActive: input.isActive ?? before.isActive },
  });

  const record = await repo.findLeaveType(prisma, id);
  if (!record) {
    throw AppError.notFound('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
  }
  return toLeaveTypeView(record);
}

export async function listLeavePolicies(actor: HrActor): Promise<LeavePolicyView[]> {
  // Policies are configuration, so reading them needs HR access rather than being
  // open to every employee: entitlements by department are not directory
  // information. The employee's own entitlement reaches them through their balance.
  if (!actor.can('HR_LEAVE', 'VIEW') && !actor.can('HR_ADMIN', 'VIEW')) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot view leave policies.');
  }
  const rows = await repo.listLeavePolicies({});
  return rows.map(toPolicyView);
}

export async function createLeavePolicy(
  req: Request,
  actor: HrActor,
  input: CreateLeavePolicyInput,
): Promise<LeavePolicyView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure leave policies.');
  }

  const leaveType = await repo.findLeaveType(prisma, input.leaveTypeId);
  if (!leaveType) {
    throw AppError.badRequest('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
  }

  const clash = await repo.findPolicyForScope(input.leaveTypeId, input.departmentId ?? null);
  if (clash) {
    throw AppError.conflict(
      'LEAVE_POLICY_EXISTS',
      'A policy already exists for that leave type and scope.',
    );
  }

  let created: { id: string };
  try {
    created = await repo.createLeavePolicy({
      leaveTypeId: input.leaveTypeId,
      departmentId: input.departmentId ?? null,
      annualEntitlement: String(input.annualEntitlement),
      ...(input.accrualPerPeriod === undefined
        ? {}
        : { accrualPerPeriod: String(input.accrualPerPeriod) }),
      ...(input.minNoticeDays === undefined ? {} : { minNoticeDays: input.minNoticeDays }),
      ...(input.maxConsecutiveDays === undefined
        ? {}
        : { maxConsecutiveDays: input.maxConsecutiveDays }),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'LEAVE_POLICY_EXISTS',
        'A policy already exists for that leave type and scope.',
      );
    }
    throw error;
  }

  await recordAudit(req, {
    action: 'HR_LEAVE_POLICY_CREATED',
    entityType: 'LeavePolicy',
    entityId: created.id,
    actorId: actor.id,
    newValue: {
      leaveTypeId: input.leaveTypeId,
      departmentId: input.departmentId ?? null,
      annualEntitlement: String(input.annualEntitlement),
    },
  });

  const record = await repo.findLeavePolicy(created.id);
  if (!record) {
    throw AppError.notFound('LEAVE_POLICY_NOT_FOUND', 'That policy could not be found.');
  }
  return toPolicyView(record);
}

export async function updateLeavePolicy(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateLeavePolicyInput,
): Promise<LeavePolicyView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure leave policies.');
  }

  const before = await repo.findLeavePolicy(id);
  if (!before) {
    throw AppError.notFound('LEAVE_POLICY_NOT_FOUND', 'That policy could not be found.');
  }

  await repo.updateLeavePolicy(id, {
    ...(input.annualEntitlement === undefined
      ? {}
      : { annualEntitlement: String(input.annualEntitlement) }),
    ...(input.accrualPerPeriod === undefined
      ? {}
      : {
          accrualPerPeriod:
            input.accrualPerPeriod === null ? null : String(input.accrualPerPeriod),
        }),
    ...(input.minNoticeDays === undefined ? {} : { minNoticeDays: input.minNoticeDays }),
    ...(input.maxConsecutiveDays === undefined
      ? {}
      : { maxConsecutiveDays: input.maxConsecutiveDays }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  });

  await recordAudit(req, {
    action: 'HR_LEAVE_POLICY_UPDATED',
    entityType: 'LeavePolicy',
    entityId: id,
    actorId: actor.id,
    oldValue: {
      annualEntitlement: before.annualEntitlement.toString(),
      isActive: before.isActive,
    },
    newValue: {
      annualEntitlement:
        input.annualEntitlement === undefined
          ? before.annualEntitlement.toString()
          : String(input.annualEntitlement),
      isActive: input.isActive ?? before.isActive,
    },
  });

  const record = await repo.findLeavePolicy(id);
  if (!record) {
    throw AppError.notFound('LEAVE_POLICY_NOT_FOUND', 'That policy could not be found.');
  }
  return toPolicyView(record);
}

// ---------------------------------------------------------------------------
//  Balances
// ---------------------------------------------------------------------------

export async function listBalances(
  actor: HrActor,
  query: LeaveBalanceQuery,
): Promise<LeaveBalanceView[]> {
  const now = await databaseNow();
  const periodYear = query.periodYear ?? periodYearOf(now);

  /*
    Their own by default. Asking about somebody else needs them to be in scope.

    An account with no HR record — a shared operations login, or an administrator
    who is not themselves on the payroll — has no balances, and that is an EMPTY
    LIST rather than an error. 403 means "you are not allowed"; this is "there is
    nothing of yours to show", and returning the former made the leave page render
    an error block for an administrator who had done nothing wrong.

    Writing is different and still refuses: `applyForLeave` needs an employee
    record because the leave has to belong to somebody.
  */
  if (!query.employeeId && !actor.employeeId) return [];

  const employeeId = query.employeeId ?? actor.employeeId;
  if (!employeeId) return [];

  if (employeeId !== actor.employeeId) {
    const scope = await scopeFor(actor);
    const employee = await repo.findEmployeeContext(prisma, employeeId);
    if (
      !employee ||
      !mayReadEmployeeRecords(scope, { id: employee.id, managerId: employee.managerId })
    ) {
      throw AppError.notFound('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
    }
  }

  const rows = await repo.listBalances(employeeId, periodYear);
  return rows.map(toBalanceView);
}

/**
 * Allocates a period's entitlement.
 *
 * Idempotent by construction: the ledger is checked for an existing ALLOCATION in
 * the same period before writing, so running it twice does not double somebody's
 * entitlement. That matters because allocation is the operation most likely to be
 * run by hand twice.
 */
export async function allocateEntitlement(
  req: Request,
  actor: HrActor,
  input: AllocateLeaveInput,
): Promise<LeaveBalanceView[]> {
  if (!mayAdjustBalance(actor)) {
    throw new AppError('BALANCE_NOT_PERMITTED', 403, 'You cannot allocate leave.');
  }

  const employee = await repo.findEmployeeContext(prisma, input.employeeId);
  if (!employee) {
    throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
  }

  await prisma.$transaction(async (tx) => {
    const leaveType = await repo.findLeaveType(tx, input.leaveTypeId);
    if (!leaveType) {
      throw AppError.badRequest('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
    }

    const policy = await repo.policyFor(tx, input.leaveTypeId, employee.departmentId);
    if (!policy) {
      throw AppError.badRequest(
        'LEAVE_POLICY_NOT_FOUND',
        'No leave policy applies to that employee for that leave type.',
      );
    }

    const existing = await tx.leaveLedgerEntry.findFirst({
      where: {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        periodYear: input.periodYear,
        reason: 'ALLOCATION',
      },
      select: { id: true },
    });
    if (existing) {
      throw AppError.conflict(
        'ALREADY_ALLOCATED',
        'That period has already been allocated for this leave type.',
      );
    }

    const balance = await repo.lockBalance(
      tx,
      input.employeeId,
      input.leaveTypeId,
      input.periodYear,
    );
    const days = normaliseDays(policy.annualEntitlement.toString());
    const next = applyLedgerEntry(balance, { reason: 'ALLOCATION', days });

    await repo.recordLedgerAndBalance(tx, {
      balanceId: balance.id,
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      periodYear: input.periodYear,
      reason: 'ALLOCATION',
      days,
      note: `Annual entitlement for ${input.periodYear}`,
      performedById: actor.id,
      balance: next,
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_LEAVE_ALLOCATED',
    entityType: 'LeaveBalance',
    entityId: input.employeeId,
    actorId: actor.id,
    newValue: { leaveTypeId: input.leaveTypeId, periodYear: input.periodYear },
  });

  const rows = await repo.listBalances(input.employeeId, input.periodYear);
  return rows.map(toBalanceView);
}

/**
 * Carries a balance into the next period.
 *
 * Capped by the leave type's limit, never negative, and idempotent on the target
 * period's CARRY_FORWARD entry — the same reasoning as allocation.
 */
export async function carryForward(
  req: Request,
  actor: HrActor,
  input: AllocateLeaveInput,
): Promise<LeaveBalanceView[]> {
  if (!mayAdjustBalance(actor)) {
    throw new AppError('BALANCE_NOT_PERMITTED', 403, 'You cannot carry leave forward.');
  }

  const targetYear = input.periodYear + 1;

  await prisma.$transaction(async (tx) => {
    const leaveType = await repo.findLeaveType(tx, input.leaveTypeId);
    if (!leaveType) {
      throw AppError.badRequest('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
    }
    if (!leaveType.carryForwardEnabled) {
      throw AppError.badRequest(
        'CARRY_FORWARD_DISABLED',
        'That leave type does not allow carry forward.',
      );
    }

    const already = await tx.leaveLedgerEntry.findFirst({
      where: {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        periodYear: targetYear,
        reason: 'CARRY_FORWARD',
      },
      select: { id: true },
    });
    if (already) {
      throw AppError.conflict(
        'ALREADY_CARRIED_FORWARD',
        'That period has already been carried forward.',
      );
    }

    // Both periods are locked, source first, so a concurrent approval against the
    // outgoing year cannot change what is carried after it is computed.
    const source = await repo.lockBalance(
      tx,
      input.employeeId,
      input.leaveTypeId,
      input.periodYear,
    );
    const target = await repo.lockBalance(tx, input.employeeId, input.leaveTypeId, targetYear);

    const days = carryForwardDays(
      source,
      leaveType.carryForwardLimit === null ? null : leaveType.carryForwardLimit.toString(),
    );

    if (normaliseDays(days) === '0.00') {
      throw AppError.badRequest(
        'NOTHING_TO_CARRY_FORWARD',
        'That balance has nothing left to carry forward.',
      );
    }

    const next = applyLedgerEntry(target, { reason: 'CARRY_FORWARD', days });
    await repo.recordLedgerAndBalance(tx, {
      balanceId: target.id,
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      periodYear: targetYear,
      reason: 'CARRY_FORWARD',
      days,
      note: `Carried forward from ${input.periodYear}`,
      performedById: actor.id,
      balance: next,
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_LEAVE_CARRIED_FORWARD',
    entityType: 'LeaveBalance',
    entityId: input.employeeId,
    actorId: actor.id,
    newValue: { leaveTypeId: input.leaveTypeId, fromYear: input.periodYear, toYear: targetYear },
  });

  const rows = await repo.listBalances(input.employeeId, targetYear);
  return rows.map(toBalanceView);
}

/**
 * An HR correction to a balance.
 *
 * Writes a ledger entry like every other movement, so the balance stays the sum
 * of its history rather than a number somebody edited. Signed: a correction may
 * remove days as well as add them.
 */
export async function adjustBalance(
  req: Request,
  actor: HrActor,
  input: AdjustLeaveBalanceInput,
): Promise<LeaveBalanceView[]> {
  if (!mayAdjustBalance(actor)) {
    throw new AppError('BALANCE_NOT_PERMITTED', 403, 'You cannot adjust leave balances.');
  }

  await prisma.$transaction(async (tx) => {
    const leaveType = await repo.findLeaveType(tx, input.leaveTypeId);
    if (!leaveType) {
      throw AppError.badRequest('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
    }

    const balance = await repo.lockBalance(
      tx,
      input.employeeId,
      input.leaveTypeId,
      input.periodYear,
    );
    const days = normaliseDays(input.days);
    const next = applyLedgerEntry(balance, { reason: 'ADJUSTMENT', days });

    /*
      A negative adjustment may not take the balance below zero: a negative
      available balance is a debt nobody agreed to, and the policy does not
      describe one. The brief allows it only where policy explicitly permits,
      and no policy field here does.
    */
    if (availableDays(next).startsWith('-')) {
      throw AppError.badRequest(
        'BALANCE_WOULD_GO_NEGATIVE',
        'That adjustment would take the balance below zero.',
      );
    }

    await repo.recordLedgerAndBalance(tx, {
      balanceId: balance.id,
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      periodYear: input.periodYear,
      reason: 'ADJUSTMENT',
      days,
      note: input.note,
      performedById: actor.id,
      balance: next,
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_LEAVE_BALANCE_ADJUSTED',
    entityType: 'LeaveBalance',
    entityId: input.employeeId,
    actorId: actor.id,
    // The days and the reason, never a salary or any figure beyond leave.
    newValue: {
      leaveTypeId: input.leaveTypeId,
      periodYear: input.periodYear,
      days: String(input.days),
      note: input.note,
    },
  });

  const rows = await repo.listBalances(input.employeeId, input.periodYear);
  return rows.map(toBalanceView);
}

// ---------------------------------------------------------------------------
//  Day preview
// ---------------------------------------------------------------------------

/**
 * What a range would cost, before applying.
 *
 * Uses the same calculator the request will, so the preview and the eventual
 * charge cannot differ — which is the whole reason the calculator is shared.
 */
export async function previewDays(
  actor: HrActor,
  input: LeaveDayPreviewInput,
): Promise<LeaveDayPreview> {
  const employeeId = ownEmployeeOrFail(actor);
  const employee = await repo.findEmployeeContext(prisma, employeeId);
  if (!employee) throw AppError.notFound('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');

  const start = companyDateOf(input.startDate);
  const end = companyDateOf(input.endDate);
  const context = await workingDayContext(prisma, employee, start, end);

  const breakdown = calculateLeaveDays({
    startDate: start,
    endDate: end,
    isHalfDay: input.isHalfDay ?? false,
    workWeek: context.workWeek,
    holidays: context.holidays,
    departmentId: employee.departmentId,
  });

  return {
    leaveDays: normaliseDays(breakdown.leaveDays),
    totalDays: breakdown.totalDays,
    holidayDays: breakdown.holidayDays,
    weekOffDays: breakdown.weekOffDays,
    workingDates: breakdown.workingDates,
  };
}

// ---------------------------------------------------------------------------
//  Requests
// ---------------------------------------------------------------------------

/**
 * Applies for leave.
 *
 * The whole validation chain, in the order that gives the most useful error
 * first. The reservation is taken in the same transaction as the request, so a
 * request can never exist without its hold on the balance.
 */
export async function applyForLeave(
  req: Request,
  actor: HrActor,
  input: CreateLeaveRequestInput,
): Promise<LeaveRequestDetail> {
  const employeeId = ownEmployeeOrFail(actor);
  if (!mayApplyForLeave(actor, employeeId)) {
    throw new AppError('LEAVE_NOT_PERMITTED', 403, 'You cannot apply for this leave.');
  }

  const now = await databaseNow();
  const start = companyDateOf(input.startDate);
  const end = companyDateOf(input.endDate);
  const periodYear = periodYearOf(start);

  const id = await prisma.$transaction(async (tx) => {
    const employee = await repo.findEmployeeContext(tx, employeeId);
    if (!employee) {
      throw AppError.notFound('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
    }
    if (employee.status === 'EXITED' || employee.status === 'INACTIVE') {
      throw AppError.badRequest(
        'EMPLOYEE_NOT_EMPLOYED',
        'Leave cannot be applied for while the employee is not active.',
      );
    }

    const leaveType = await repo.findLeaveType(tx, input.leaveTypeId);
    if (!leaveType) {
      throw AppError.badRequest('LEAVE_TYPE_NOT_FOUND', 'That leave type could not be found.');
    }
    if (!leaveType.isActive) {
      throw AppError.badRequest('LEAVE_TYPE_INACTIVE', 'That leave type is no longer available.');
    }
    if (input.isHalfDay && !leaveType.halfDayAllowed) {
      throw AppError.badRequest(
        'HALF_DAY_NOT_ALLOWED',
        'That leave type cannot be taken as a half day.',
      );
    }

    // Overlap before cost: being told "you already have leave then" is more
    // useful than being told how many days the clashing request would cost.
    const overlapping = await repo.findOverlappingLeave(tx, employeeId, start, end);
    if (overlapping.length > 0) {
      throw AppError.conflict(
        'LEAVE_OVERLAPS',
        'You already have a leave request covering some of those dates.',
      );
    }

    const context = await workingDayContext(tx, employee, start, end);
    const breakdown = calculateLeaveDays({
      startDate: start,
      endDate: end,
      isHalfDay: input.isHalfDay ?? false,
      halfDayPeriod: input.halfDayPeriod ?? null,
      workWeek: context.workWeek,
      holidays: context.holidays,
      departmentId: employee.departmentId,
    });

    if (breakdown.leaveDays <= 0) {
      throw AppError.badRequest(
        'NO_WORKING_DAYS',
        'Those dates contain no working days, so no leave is needed.',
      );
    }

    const policy = await repo.policyFor(tx, input.leaveTypeId, employee.departmentId);

    if (policy) {
      if (policy.minNoticeDays > 0) {
        const notice = companyDaysBetween(companyDateOf(now), start);
        if (notice < policy.minNoticeDays) {
          throw AppError.badRequest(
            'INSUFFICIENT_NOTICE',
            `That leave type needs ${policy.minNoticeDays} days' notice.`,
          );
        }
      }

      if (policy.maxConsecutiveDays !== null) {
        const run = longestConsecutiveWorkingRun({
          startDate: start,
          endDate: end,
          workWeek: context.workWeek,
          holidays: context.holidays,
          departmentId: employee.departmentId,
        });
        if (run > policy.maxConsecutiveDays) {
          throw AppError.badRequest(
            'EXCEEDS_MAX_CONSECUTIVE',
            `That leave type allows at most ${policy.maxConsecutiveDays} consecutive days.`,
          );
        }
      }
    }

    const days = normaliseDays(breakdown.leaveDays);

    // Locked before the sufficiency check, so a concurrent request cannot slip
    // between the check and the reservation.
    const balance = await repo.lockBalance(tx, employeeId, input.leaveTypeId, periodYear);
    if (!hasSufficientBalance(balance, days)) {
      throw AppError.badRequest(
        'INSUFFICIENT_BALANCE',
        `You have ${availableDays(balance)} days available and asked for ${days}.`,
      );
    }

    const created = await repo.createLeaveRequest(tx, {
      employeeId,
      leaveTypeId: input.leaveTypeId,
      startDate: start,
      endDate: end,
      isHalfDay: input.isHalfDay ?? false,
      halfDayPeriod: input.halfDayPeriod ?? null,
      requestedDays: days,
      reason: input.reason,
      status: 'PENDING',
    });

    // The hold. Negative ledger days, raising `reserved` — see LEDGER_EFFECTS.
    const next = applyLedgerEntry(balance, { reason: 'RESERVATION', days: `-${days}` });
    await repo.recordLedgerAndBalance(tx, {
      balanceId: balance.id,
      employeeId,
      leaveTypeId: input.leaveTypeId,
      periodYear,
      reason: 'RESERVATION',
      days: `-${days}`,
      leaveRequestId: created.id,
      note: 'Held while awaiting a decision',
      performedById: actor.id,
      balance: next,
    });

    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_LEAVE_REQUESTED',
    entityType: 'LeaveRequest',
    entityId: id,
    actorId: actor.id,
    newValue: {
      leaveTypeId: input.leaveTypeId,
      startDate: dayKey(start),
      endDate: dayKey(end),
    },
  });

  // After commit, and only to somebody who can act on it.
  const employee = await repo.findEmployeeContext(prisma, employeeId);
  if (employee?.managerId) {
    const manager = await repo.findManagerAccount(employee.managerId);
    if (manager?.userId && manager.isActive) {
      await notify.notifyLeaveRequested(manager.userId, id);
    }
  }

  const record = await repo.findLeaveRequest(id);
  if (!record) throw notFound();
  return toRequestDetail(record);
}

/**
 * Decides a request.
 *
 * Approval converts the reservation into consumption and writes the attendance
 * for every working day the leave covers — all in one transaction, because a
 * leave that was approved but left the days absent would be worse than no
 * approval. Rejection releases the hold.
 *
 * The conditional transition is what makes a double decision impossible.
 */
export async function decideLeave(
  req: Request,
  actor: HrActor,
  id: string,
  input: DecideLeaveRequestInput,
): Promise<LeaveRequestDetail> {
  const request = await repo.findLeaveRequest(id);
  if (!request) throw notFound();

  if (
    !mayDecideRequest(
      actor,
      {
        employeeId: request.employee.id,
        managerId: request.employee.managerId,
        status: request.status,
      },
      { module: 'HR_LEAVE' },
    )
  ) {
    throw new AppError('LEAVE_NOT_PERMITTED', 403, 'You cannot decide this leave request.');
  }

  const now = await databaseNow();
  const periodYear = periodYearOf(request.startDate);
  const days = normaliseDays(request.requestedDays.toString());

  await prisma.$transaction(async (tx) => {
    const moved = await repo.transitionLeaveRequest(tx, id, ['PENDING'], {
      status: input.decision,
      decidedById: actor.id,
      decidedAt: now,
      decisionNote: input.note ?? null,
    });
    if (moved.count === 0) {
      throw AppError.badRequest(
        'LEAVE_ALREADY_DECIDED',
        'Somebody has already decided this request.',
      );
    }

    const balance = await repo.lockBalance(
      tx,
      request.employee.id,
      request.leaveType.id,
      periodYear,
    );

    if (input.decision === 'REJECTED') {
      // Release the hold: a rejected request costs nothing.
      const released = applyLedgerEntry(balance, { reason: 'RESERVATION_RELEASE', days });
      await repo.recordLedgerAndBalance(tx, {
        balanceId: balance.id,
        employeeId: request.employee.id,
        leaveTypeId: request.leaveType.id,
        periodYear,
        reason: 'RESERVATION_RELEASE',
        days,
        leaveRequestId: id,
        note: 'Request rejected',
        performedById: actor.id,
        balance: released,
      });
      return;
    }

    /*
      Approval is two movements: the hold is released and the days are spent. Two
      ledger rows rather than one net entry, so the trail reads as what happened
      rather than as an unexplained single number.
    */
    const released = applyLedgerEntry(balance, { reason: 'RESERVATION_RELEASE', days });
    await repo.recordLedgerAndBalance(tx, {
      balanceId: balance.id,
      employeeId: request.employee.id,
      leaveTypeId: request.leaveType.id,
      periodYear,
      reason: 'RESERVATION_RELEASE',
      days,
      leaveRequestId: id,
      note: 'Hold released on approval',
      performedById: actor.id,
      balance: released,
    });

    const consumed = applyLedgerEntry(released, { reason: 'CONSUMPTION', days: `-${days}` });
    await repo.recordLedgerAndBalance(tx, {
      balanceId: balance.id,
      employeeId: request.employee.id,
      leaveTypeId: request.leaveType.id,
      periodYear,
      reason: 'CONSUMPTION',
      days: `-${days}`,
      leaveRequestId: id,
      note: 'Leave approved',
      performedById: actor.id,
      balance: consumed,
    });

    await writeLeaveAttendance(tx, {
      employeeId: request.employee.id,
      departmentId: request.employee.departmentId,
      startDate: request.startDate,
      endDate: request.endDate,
      isHalfDay: request.isHalfDay,
      leaveRequestId: id,
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_LEAVE_DECIDED',
    entityType: 'LeaveRequest',
    entityId: id,
    actorId: actor.id,
    oldValue: { status: request.status },
    newValue: { status: input.decision, requestedDays: days },
  });

  if (request.employee.id) {
    const employee = await repo.findEmployeeContext(prisma, request.employee.id);
    if (employee?.userId) {
      await notify.notifyLeaveDecided(employee.userId, id, input.decision);
    }
  }

  const updated = await repo.findLeaveRequest(id);
  if (!updated) throw notFound();
  return toRequestDetail(updated);
}

/**
 * Writes the LEAVE attendance rows an approved leave implies.
 *
 * One row per *working* day — holidays and week-offs inside the range are not
 * leave and keep their own status. Upserted rather than inserted, so a day that
 * already has a record (somebody clocked in before the leave was approved) gains
 * the leave link instead of colliding, and two approvals touching the same date
 * cannot both insert.
 *
 * A half day keeps any session it has: the person worked half and took half, and
 * `resolveDay` reads that as HALF_DAY.
 */
async function writeLeaveAttendance(
  tx: Prisma.TransactionClient,
  input: {
    employeeId: string;
    departmentId: string | null;
    startDate: Date;
    endDate: Date;
    isHalfDay: boolean;
    leaveRequestId: string;
  },
): Promise<void> {
  const context = await workingDayContext(
    tx,
    { departmentId: input.departmentId },
    input.startDate,
    input.endDate,
  );

  const breakdown = calculateLeaveDays({
    startDate: input.startDate,
    endDate: input.endDate,
    isHalfDay: input.isHalfDay,
    workWeek: context.workWeek,
    holidays: context.holidays,
    departmentId: input.departmentId,
  });

  for (const key of breakdown.workingDates) {
    const day = new Date(`${key}T00:00:00.000Z`);
    const status = input.isHalfDay ? ('HALF_DAY' as const) : ('LEAVE' as const);

    await attendanceRepo.upsertResolvedAttendance(
      tx,
      input.employeeId,
      day,
      {
        status,
        sessionState: 'NONE',
        source: 'SYSTEM',
        leaveRequestId: input.leaveRequestId,
      },
      // An existing record keeps its session and its measured minutes; only the
      // status and the leave link change. Overwriting a clock-in would destroy
      // evidence of hours actually worked.
      { status, leaveRequestId: input.leaveRequestId },
    );
  }
}

/**
 * Withdraws or cancels a request.
 *
 * Two paths with different rules, both ending in CANCELLED:
 *
 *   PENDING   the requester withdraws. The hold is released.
 *   APPROVED  future-dated only. The consumption is reversed and the attendance
 *             rows are unwound.
 *
 * A leave that has already started is not cancellable here, by design: it is
 * attendance history, and silently reversing it would restate days somebody was
 * genuinely absent for. HR corrects the past through the attendance correction
 * workflow, which records who decided and why.
 */
export async function cancelLeave(
  req: Request,
  actor: HrActor,
  id: string,
  input: CancelLeaveRequestInput,
): Promise<LeaveRequestDetail> {
  const request = await repo.findLeaveRequest(id);
  if (!request) throw notFound();

  const now = await databaseNow();
  const today = companyDateOf(now);
  const periodYear = periodYearOf(request.startDate);
  const days = normaliseDays(request.requestedDays.toString());

  const wasApproved = request.status === 'APPROVED';

  if (request.status === 'PENDING') {
    if (!mayCancelOwnRequest(actor, { employeeId: request.employee.id, status: request.status })) {
      throw new AppError(
        'LEAVE_NOT_PERMITTED',
        403,
        'You can only withdraw a request you raised yourself.',
      );
    }
  } else {
    const verdict = mayCancelApprovedLeave(
      actor,
      {
        employeeId: request.employee.id,
        status: request.status,
        startDate: companyDateOf(request.startDate),
      },
      today,
    );
    if (!verdict.allowed) {
      throw AppError.badRequest('LEAVE_NOT_CANCELLABLE', verdict.reason ?? 'That leave cannot be cancelled.');
    }
  }

  await prisma.$transaction(async (tx) => {
    const moved = await repo.transitionLeaveRequest(
      tx,
      id,
      wasApproved ? ['APPROVED'] : ['PENDING'],
      {
        status: 'CANCELLED',
        cancelledAt: now,
        cancellationNote: input.note ?? null,
      },
    );
    if (moved.count === 0) {
      throw AppError.badRequest(
        'LEAVE_ALREADY_DECIDED',
        'That request has already been decided or cancelled.',
      );
    }

    const balance = await repo.lockBalance(
      tx,
      request.employee.id,
      request.leaveType.id,
      periodYear,
    );

    if (wasApproved) {
      const reversed = applyLedgerEntry(balance, { reason: 'CONSUMPTION_REVERSAL', days });
      await repo.recordLedgerAndBalance(tx, {
        balanceId: balance.id,
        employeeId: request.employee.id,
        leaveTypeId: request.leaveType.id,
        periodYear,
        reason: 'CONSUMPTION_REVERSAL',
        days,
        leaveRequestId: id,
        note: 'Approved leave cancelled',
        performedById: actor.id,
        balance: reversed,
      });

      /*
        Unwind the attendance. The rows this leave created are cleared back to an
        unresolved state rather than deleted, because a record may also carry a
        session somebody clocked: deleting it would destroy evidence of hours
        worked. `resolveDay` then reads the day afresh.
      */
      await unwindLeaveAttendance(tx, id);
    } else {
      const released = applyLedgerEntry(balance, { reason: 'RESERVATION_RELEASE', days });
      await repo.recordLedgerAndBalance(tx, {
        balanceId: balance.id,
        employeeId: request.employee.id,
        leaveTypeId: request.leaveType.id,
        periodYear,
        reason: 'RESERVATION_RELEASE',
        days,
        leaveRequestId: id,
        note: 'Request withdrawn',
        performedById: actor.id,
        balance: released,
      });
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_LEAVE_CANCELLED',
    entityType: 'LeaveRequest',
    entityId: id,
    actorId: actor.id,
    oldValue: { status: request.status },
    newValue: { status: 'CANCELLED', requestedDays: days },
  });

  // The manager's team plan has changed; the employee already knows, having done
  // it — unless HR cancelled on their behalf, in which case they are told too.
  const employee = await repo.findEmployeeContext(prisma, request.employee.id);
  const recipients: string[] = [];
  if (employee?.managerId) {
    const manager = await repo.findManagerAccount(employee.managerId);
    if (manager?.userId && manager.isActive) recipients.push(manager.userId);
  }
  if (employee?.userId && actor.employeeId !== employee.id) recipients.push(employee.userId);
  if (recipients.length > 0) await notify.notifyLeaveCancelled(recipients, id);

  const updated = await repo.findLeaveRequest(id);
  if (!updated) throw notFound();
  return toRequestDetail(updated);
}

/**
 * Clears the attendance a cancelled leave had written.
 *
 * Rows with no session become HOLIDAY/WEEK_OFF/ABSENT as resolution decides;
 * rows with a session keep it and are re-resolved from their worked minutes. The
 * leave link is cleared either way, so nothing points at a cancelled request.
 */
async function unwindLeaveAttendance(
  tx: Prisma.TransactionClient,
  leaveRequestId: string,
): Promise<void> {
  const rows = await tx.attendanceRecord.findMany({
    where: { leaveRequestId },
    select: {
      id: true,
      employeeId: true,
      attendanceDate: true,
      sessionState: true,
      workedMinutes: true,
      employee: { select: { departmentId: true } },
    },
  });

  for (const row of rows) {
    const policy = await attendanceRepo.policyForEmployee(tx, row.employee.departmentId);
    const holidays = await attendanceRepo.holidaysInRange(
      tx,
      row.attendanceDate,
      row.attendanceDate,
      row.employee.departmentId,
    );

    const rules = {
      expectedStartMinute: policy?.expectedStartMinute ?? 570,
      expectedEndMinute: policy?.expectedEndMinute ?? 1110,
      graceMinutes: policy?.graceMinutes ?? 15,
      fullDayMinutes: policy?.fullDayMinutes ?? 480,
      halfDayMinutes: policy?.halfDayMinutes ?? 240,
      overtimeThresholdMinutes: policy?.overtimeThresholdMinutes ?? 540,
      weekOffDays: policy?.weekOffDays ?? FALLBACK_WEEK_OFF,
    };

    const resolved = resolveDay(
      {
        // The leave is gone, so the day is decided by everything else.
        approvedLeave: null,
        isHoliday: isHolidayOn(row.attendanceDate, holidays, row.employee.departmentId),
        isWeekOff: isWeekOffOn(row.attendanceDate, { weekOffDays: rules.weekOffDays }),
        // A closed session keeps its measured hours; an open or absent day has none.
        workedMinutes: row.sessionState === 'CLOSED' ? row.workedMinutes : null,
      },
      rules,
    );

    await tx.attendanceRecord.update({
      where: { id: row.id },
      data: { status: resolved.status, leaveRequestId: null },
    });
  }
}

export async function listLeaveRequests(
  actor: HrActor,
  query: LeaveRequestListQuery,
): Promise<LeaveRequestPage> {
  const scope = await scopeFor(actor);

  const where: Prisma.LeaveRequestWhereInput = {
    employee: scopedEmployeeFilter(scope) as Prisma.EmployeeWhereInput,
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
    ...(query.status ? { status: query.status } : {}),
    // The approver's queue: pending, and never their own.
    ...(query.mine ? { status: 'PENDING' as const } : {}),
    ...(query.mine && actor.employeeId ? { employeeId: { not: actor.employeeId } } : {}),
    ...(query.from || query.to
      ? {
          startDate: {
            ...(query.from ? { gte: companyDateOf(query.from) } : {}),
            ...(query.to ? { lte: companyDateOf(query.to) } : {}),
          },
        }
      : {}),
  };

  const rows = await repo.listLeaveRequests({ where, take: query.limit, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    requests: page.map(toRequestRow),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getLeaveRequest(actor: HrActor, id: string): Promise<LeaveRequestDetail> {
  const record = await repo.findLeaveRequest(id);
  if (!record) throw notFound();

  const scope = await scopeFor(actor);
  if (
    !mayReadEmployeeRecords(scope, {
      id: record.employee.id,
      managerId: record.employee.managerId,
    })
  ) {
    // 404, not 403: "it exists but is not yours" would leak who has leave booked.
    throw notFound();
  }

  return toRequestDetail(record);
}

/** Prisma's unique-violation code, named so the intent reads at each call site. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}
