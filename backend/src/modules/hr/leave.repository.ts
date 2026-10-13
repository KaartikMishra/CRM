/**
 * Every Leave database read and write.
 *
 * The balance functions here are the ones worth reading closely: a balance is a
 * cache of the ledger, and the two must move together or not at all. Every
 * mutation therefore takes a transaction client rather than defaulting to the
 * global one — a signature that makes "I forgot the transaction" a compile error
 * instead of a corrupted balance.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

const employeeRefSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.EmployeeSelect;

const orgUnitRefSelect = { id: true, name: true, code: true } satisfies Prisma.DepartmentSelect;

const leaveTypeRefSelect = { id: true, name: true, code: true } satisfies Prisma.LeaveTypeSelect;

export const leaveTypeSelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  isPaid: true,
  isActive: true,
  halfDayAllowed: true,
  approvalRequired: true,
  accrualEnabled: true,
  carryForwardEnabled: true,
  carryForwardLimit: true,
  encashmentAllowed: true,
} satisfies Prisma.LeaveTypeSelect;

export const leavePolicySelect = {
  id: true,
  annualEntitlement: true,
  accrualPerPeriod: true,
  minNoticeDays: true,
  maxConsecutiveDays: true,
  isActive: true,
  leaveType: { select: leaveTypeRefSelect },
  department: { select: orgUnitRefSelect },
} satisfies Prisma.LeavePolicySelect;

export const leaveRequestSelect = {
  id: true,
  startDate: true,
  endDate: true,
  isHalfDay: true,
  halfDayPeriod: true,
  requestedDays: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  cancelledAt: true,
  createdAt: true,
  employee: { select: { ...employeeRefSelect, managerId: true, departmentId: true } },
  leaveType: { select: leaveTypeRefSelect },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.LeaveRequestSelect;

export const leaveRequestDetailSelect = {
  ...leaveRequestSelect,
  cancellationNote: true,
  updatedAt: true,
  ledger: {
    select: {
      id: true,
      reason: true,
      days: true,
      note: true,
      createdAt: true,
      performedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.LeaveRequestSelect;

export const balanceSelect = {
  id: true,
  periodYear: true,
  allocated: true,
  accrued: true,
  carriedForward: true,
  used: true,
  reserved: true,
  adjusted: true,
  leaveType: { select: leaveTypeRefSelect },
} satisfies Prisma.LeaveBalanceSelect;

export type LeaveTypeRecord = Prisma.LeaveTypeGetPayload<{ select: typeof leaveTypeSelect }>;
export type LeavePolicyRecord = Prisma.LeavePolicyGetPayload<{ select: typeof leavePolicySelect }>;
export type LeaveRequestRecord = Prisma.LeaveRequestGetPayload<{
  select: typeof leaveRequestSelect;
}>;
export type LeaveRequestDetailRecord = Prisma.LeaveRequestGetPayload<{
  select: typeof leaveRequestDetailSelect;
}>;
export type LeaveBalanceRecord = Prisma.LeaveBalanceGetPayload<{ select: typeof balanceSelect }>;

// ---------------------------------------------------------------------------
//  Types and policies
// ---------------------------------------------------------------------------

export function listLeaveTypes(where: Prisma.LeaveTypeWhereInput): Promise<LeaveTypeRecord[]> {
  return prisma.leaveType.findMany({ where, orderBy: { name: 'asc' }, select: leaveTypeSelect });
}

export function findLeaveType(
  client: Prisma.TransactionClient | typeof prisma,
  id: string,
): Promise<LeaveTypeRecord | null> {
  return client.leaveType.findUnique({ where: { id }, select: leaveTypeSelect });
}

export function findLeaveTypeByCode(code: string): Promise<{ id: string } | null> {
  return prisma.leaveType.findUnique({ where: { code }, select: { id: true } });
}

export function createLeaveType(
  data: Prisma.LeaveTypeUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.leaveType.create({ data, select: { id: true } });
}

export function updateLeaveType(
  id: string,
  data: Prisma.LeaveTypeUncheckedUpdateInput,
): Promise<{ id: string }> {
  return prisma.leaveType.update({ where: { id }, data, select: { id: true } });
}

/**
 * The policy in force for one employee and leave type.
 *
 * Their department's policy if one exists, otherwise the company-wide one. Same
 * two-step fallback as the attendance policy, for the same reason: the fallback
 * is a different row rather than a nullable column.
 */
export async function policyFor(
  client: Prisma.TransactionClient | typeof prisma,
  leaveTypeId: string,
  departmentId: string | null,
): Promise<LeavePolicyRecord | null> {
  if (departmentId) {
    const departmental = await client.leavePolicy.findFirst({
      where: { leaveTypeId, departmentId, isActive: true },
      select: leavePolicySelect,
    });
    if (departmental) return departmental;
  }

  return client.leavePolicy.findFirst({
    where: { leaveTypeId, departmentId: null, isActive: true },
    select: leavePolicySelect,
  });
}

export function listLeavePolicies(
  where: Prisma.LeavePolicyWhereInput,
): Promise<LeavePolicyRecord[]> {
  return prisma.leavePolicy.findMany({
    where,
    orderBy: [{ leaveType: { name: 'asc' } }],
    select: leavePolicySelect,
  });
}

export function findLeavePolicy(id: string): Promise<LeavePolicyRecord | null> {
  return prisma.leavePolicy.findUnique({ where: { id }, select: leavePolicySelect });
}

export function findPolicyForScope(
  leaveTypeId: string,
  departmentId: string | null,
): Promise<{ id: string } | null> {
  return prisma.leavePolicy.findFirst({
    where: { leaveTypeId, departmentId },
    select: { id: true },
  });
}

export function createLeavePolicy(
  data: Prisma.LeavePolicyUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.leavePolicy.create({ data, select: { id: true } });
}

export function updateLeavePolicy(
  id: string,
  data: Prisma.LeavePolicyUncheckedUpdateInput,
): Promise<{ id: string }> {
  return prisma.leavePolicy.update({ where: { id }, data, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  Balances and the ledger
// ---------------------------------------------------------------------------

export function listBalances(
  employeeId: string,
  periodYear: number,
): Promise<LeaveBalanceRecord[]> {
  return prisma.leaveBalance.findMany({
    where: { employeeId, periodYear },
    orderBy: { leaveType: { name: 'asc' } },
    select: balanceSelect,
  });
}

/**
 * The balance row, locked for update, created at zero if absent.
 *
 * **The single most important function in the leave module.** Two concurrent
 * approvals against the same balance must not both read "2 days available" and
 * both deduct — so the row is locked for the rest of the transaction before any
 * arithmetic happens.
 *
 * The upsert comes first because `FOR UPDATE` cannot lock a row that does not
 * exist: an employee's first ever request would find nothing to lock and the
 * two requests would race to insert. `ON CONFLICT DO UPDATE` with a no-op touch
 * both creates it and locks it in one statement — a bare `DO NOTHING` would not
 * lock the row it declined to insert.
 */
export async function lockBalance(
  tx: Prisma.TransactionClient,
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
): Promise<{
  id: string;
  allocated: string;
  accrued: string;
  carriedForward: string;
  used: string;
  reserved: string;
  adjusted: string;
}> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      allocated: string;
      accrued: string;
      carriedForward: string;
      used: string;
      reserved: string;
      adjusted: string;
    }[]
  >`
    INSERT INTO "LeaveBalance" ("id", "employeeId", "leaveTypeId", "periodYear", "updatedAt")
    VALUES (gen_random_uuid()::text, ${employeeId}, ${leaveTypeId}, ${periodYear}, now())
    ON CONFLICT ("employeeId", "leaveTypeId", "periodYear")
    DO UPDATE SET "updatedAt" = "LeaveBalance"."updatedAt"
    RETURNING
      "id",
      "allocated"::text AS "allocated",
      "accrued"::text AS "accrued",
      "carriedForward"::text AS "carriedForward",
      "used"::text AS "used",
      "reserved"::text AS "reserved",
      "adjusted"::text AS "adjusted"
  `;

  const row = rows[0];
  if (!row) throw new Error('Leave balance lock returned no row');
  return row;
}

/**
 * Writes a ledger entry and the balance it moves, together.
 *
 * One function rather than two calls, because the ledger and the cached balance
 * must never diverge: a caller that could write one without the other would
 * eventually write one without the other.
 */
export async function recordLedgerAndBalance(
  tx: Prisma.TransactionClient,
  input: {
    balanceId: string;
    employeeId: string;
    leaveTypeId: string;
    periodYear: number;
    reason: Prisma.LeaveLedgerEntryUncheckedCreateInput['reason'];
    days: string;
    leaveRequestId?: string | null;
    note?: string | null;
    performedById?: string | null;
    /** The recomputed components, from applyLedgerEntry. */
    balance: {
      allocated: string;
      accrued: string;
      carriedForward: string;
      used: string;
      reserved: string;
      adjusted: string;
    };
  },
): Promise<void> {
  await tx.leaveLedgerEntry.create({
    data: {
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      periodYear: input.periodYear,
      reason: input.reason,
      days: input.days,
      leaveRequestId: input.leaveRequestId ?? null,
      note: input.note ?? null,
      performedById: input.performedById ?? null,
    },
  });

  await tx.leaveBalance.update({
    where: { id: input.balanceId },
    data: {
      allocated: input.balance.allocated,
      accrued: input.balance.accrued,
      carriedForward: input.balance.carriedForward,
      used: input.balance.used,
      reserved: input.balance.reserved,
      adjusted: input.balance.adjusted,
    },
  });
}

export function listLedger(
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
): Promise<
  {
    id: string;
    reason: string;
    days: Prisma.Decimal;
    note: string | null;
    createdAt: Date;
    performedBy: { id: string; name: string } | null;
  }[]
> {
  return prisma.leaveLedgerEntry.findMany({
    where: { employeeId, leaveTypeId, periodYear },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      reason: true,
      days: true,
      note: true,
      createdAt: true,
      performedBy: { select: { id: true, name: true } },
    },
  });
}

// ---------------------------------------------------------------------------
//  Requests
// ---------------------------------------------------------------------------

export function findLeaveRequest(id: string): Promise<LeaveRequestDetailRecord | null> {
  return prisma.leaveRequest.findUnique({ where: { id }, select: leaveRequestDetailSelect });
}

/** The scope check needs only these, so it does not fetch a whole request. */
export function findLeaveRequestScope(id: string): Promise<{
  id: string;
  employeeId: string;
  status: string;
  employee: { managerId: string | null };
} | null> {
  return prisma.leaveRequest.findUnique({
    where: { id },
    select: {
      id: true,
      employeeId: true,
      status: true,
      employee: { select: { managerId: true } },
    },
  });
}

/**
 * Any live request that overlaps a date range.
 *
 * PENDING or APPROVED only: a rejected or cancelled request does not block a new
 * one, which is what makes re-applying after a rejection possible. Overlap is
 * `start <= theirEnd AND end >= theirStart` — the standard interval test, and the
 * one people get wrong by comparing only one end.
 */
export function findOverlappingLeave(
  client: Prisma.TransactionClient | typeof prisma,
  employeeId: string,
  startDate: Date,
  endDate: Date,
  excludeId?: string,
): Promise<{ id: string; startDate: Date; endDate: Date }[]> {
  return client.leaveRequest.findMany({
    where: {
      employeeId,
      status: { in: ['PENDING', 'APPROVED'] },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, startDate: true, endDate: true },
  });
}

export function createLeaveRequest(
  tx: Prisma.TransactionClient,
  data: Prisma.LeaveRequestUncheckedCreateInput,
): Promise<{ id: string }> {
  return tx.leaveRequest.create({ data, select: { id: true } });
}

/**
 * Moves a request, conditionally on its current status.
 *
 * The conditional is the concurrency guard: two managers approving at once, or an
 * approval racing a cancellation, cannot both apply. A zero count means somebody
 * else got there first, and the service reports that rather than overwriting.
 */
export function transitionLeaveRequest(
  tx: Prisma.TransactionClient,
  id: string,
  fromStatus: Prisma.LeaveRequestUncheckedUpdateInput['status'][],
  data: Prisma.LeaveRequestUncheckedUpdateInput,
): Promise<{ count: number }> {
  return tx.leaveRequest.updateMany({
    where: { id, status: { in: fromStatus as never } },
    data,
  });
}

export function listLeaveRequests(args: {
  where: Prisma.LeaveRequestWhereInput;
  take: number;
  cursor?: string;
}): Promise<LeaveRequestRecord[]> {
  return prisma.leaveRequest.findMany({
    where: args.where,
    select: leaveRequestSelect,
    take: args.take + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
  });
}

/** The employee behind a session, for self-service scoping. */
export function findEmployeeForUser(userId: string): Promise<{
  id: string;
  status: string;
  departmentId: string | null;
  managerId: string | null;
} | null> {
  return prisma.employee.findUnique({
    where: { userId },
    select: { id: true, status: true, departmentId: true, managerId: true },
  });
}

/** One employee's details, for validation and scoping. */
export function findEmployeeContext(
  client: Prisma.TransactionClient | typeof prisma,
  employeeId: string,
): Promise<{
  id: string;
  status: string;
  departmentId: string | null;
  managerId: string | null;
  userId: string | null;
  firstName: string;
  lastName: string;
} | null> {
  return client.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      status: true,
      departmentId: true,
      managerId: true,
      userId: true,
      firstName: true,
      lastName: true,
    },
  });
}

/** The manager's account, for notifying them. Never a credential. */
export function findManagerAccount(
  employeeId: string,
): Promise<{ userId: string | null; isActive: boolean } | null> {
  return prisma.employee
    .findUnique({
      where: { id: employeeId },
      select: { user: { select: { id: true, isActive: true } } },
    })
    .then((row) =>
      row?.user ? { userId: row.user.id, isActive: row.user.isActive } : null,
    );
}
