/**
 * Every Attendance and Leave database read and write, and nothing else.
 *
 * No business rule lives here: the service decides, this executes. The selects
 * are shared constants rather than inline objects so a field cannot be exposed
 * in one query and withheld in another.
 *
 * ### What this module never writes
 *
 * `User`, `UserModulePermission`, `Employee`, `Department`, `Designation`, and
 * every table belonging to Sales, Purchase, Dispatch, Post Sales, Lead or
 * RsProduct. Attendance and Leave reference the Phase 1 Employee and never
 * modify it — a clock-in does not change somebody's employment record.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';

// ---------------------------------------------------------------------------
//  Selects
// ---------------------------------------------------------------------------

const employeeRefSelect = {
  id: true,
  employeeId: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.EmployeeSelect;

const orgUnitRefSelect = { id: true, name: true, code: true } satisfies Prisma.DepartmentSelect;

export const attendanceRowSelect = {
  id: true,
  attendanceDate: true,
  status: true,
  workMode: true,
  sessionState: true,
  source: true,
  clockInAt: true,
  clockOutAt: true,
  workedMinutes: true,
  breakMinutes: true,
  lateMinutes: true,
  earlyExitMinutes: true,
  overtimeMinutes: true,
  remarks: true,
  leaveRequestId: true,
  employee: {
    select: { ...employeeRefSelect, department: { select: orgUnitRefSelect } },
  },
} satisfies Prisma.AttendanceRecordSelect;

export const attendanceDetailSelect = {
  ...attendanceRowSelect,
  createdAt: true,
  updatedAt: true,
  breaks: {
    select: { id: true, startedAt: true, endedAt: true, minutes: true },
    orderBy: { startedAt: 'asc' },
  },
} satisfies Prisma.AttendanceRecordSelect;

export const correctionSelect = {
  id: true,
  attendanceDate: true,
  currentClockInAt: true,
  currentClockOutAt: true,
  requestedClockInAt: true,
  requestedClockOutAt: true,
  requestedWorkMode: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  attendanceRecordId: true,
  employee: { select: employeeRefSelect },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceCorrectionRequestSelect;

export const overtimeSelect = {
  id: true,
  overtimeDate: true,
  minutes: true,
  status: true,
  source: true,
  remarks: true,
  decidedAt: true,
  employee: { select: employeeRefSelect },
} satisfies Prisma.OvertimeRecordSelect;

export const holidaySelect = {
  id: true,
  name: true,
  holidayDate: true,
  description: true,
  isActive: true,
  department: { select: orgUnitRefSelect },
} satisfies Prisma.HolidaySelect;

export const policySelect = {
  id: true,
  name: true,
  code: true,
  expectedStartMinute: true,
  expectedEndMinute: true,
  graceMinutes: true,
  fullDayMinutes: true,
  halfDayMinutes: true,
  overtimeThresholdMinutes: true,
  weekOffDays: true,
  isActive: true,
  isDefault: true,
  department: { select: orgUnitRefSelect },
} satisfies Prisma.AttendancePolicySelect;

export type AttendanceRowRecord = Prisma.AttendanceRecordGetPayload<{
  select: typeof attendanceRowSelect;
}>;
export type AttendanceDetailRecord = Prisma.AttendanceRecordGetPayload<{
  select: typeof attendanceDetailSelect;
}>;
export type CorrectionRecord = Prisma.AttendanceCorrectionRequestGetPayload<{
  select: typeof correctionSelect;
}>;
export type OvertimeRecordRow = Prisma.OvertimeRecordGetPayload<{ select: typeof overtimeSelect }>;
export type HolidayRecord = Prisma.HolidayGetPayload<{ select: typeof holidaySelect }>;
export type PolicyRecord = Prisma.AttendancePolicyGetPayload<{ select: typeof policySelect }>;

// ---------------------------------------------------------------------------
//  Policy resolution
// ---------------------------------------------------------------------------

/**
 * The attendance policy in force for one employee.
 *
 * Their department's policy if it has one, otherwise the company default. Two
 * queries rather than a join, because the fallback is a different row rather than
 * a nullable column and `OR` with a priority would need sorting logic the
 * database cannot express cleanly.
 */
export async function policyForEmployee(
  client: Prisma.TransactionClient | typeof prisma,
  departmentId: string | null,
): Promise<PolicyRecord | null> {
  if (departmentId) {
    const departmental = await client.attendancePolicy.findFirst({
      where: { departmentId, isActive: true },
      select: policySelect,
    });
    if (departmental) return departmental;
  }

  return client.attendancePolicy.findFirst({
    where: { isDefault: true, isActive: true },
    select: policySelect,
  });
}

export function listPolicies(): Promise<PolicyRecord[]> {
  return prisma.attendancePolicy.findMany({
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: policySelect,
  });
}

export function findPolicy(id: string): Promise<PolicyRecord | null> {
  return prisma.attendancePolicy.findUnique({ where: { id }, select: policySelect });
}

export function findPolicyByCode(code: string): Promise<{ id: string } | null> {
  return prisma.attendancePolicy.findUnique({ where: { code }, select: { id: true } });
}

export function createPolicy(
  data: Prisma.AttendancePolicyUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.attendancePolicy.create({ data, select: { id: true } });
}

export function updatePolicy(
  id: string,
  data: Prisma.AttendancePolicyUncheckedUpdateInput,
): Promise<{ id: string }> {
  return prisma.attendancePolicy.update({ where: { id }, data, select: { id: true } });
}

/** Clears the current default, so the partial unique index cannot be violated. */
export function clearDefaultPolicy(
  tx: Prisma.TransactionClient,
  exceptId?: string,
): Promise<{ count: number }> {
  return tx.attendancePolicy.updateMany({
    where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { isDefault: false },
  });
}

// ---------------------------------------------------------------------------
//  Holidays
// ---------------------------------------------------------------------------

/**
 * Active holidays in a date range that could apply to an employee.
 *
 * Company-wide plus the employee's own department. Inactive ones are excluded
 * here rather than by the caller: an inactive holiday is a cancelled closure, and
 * letting it reach the leave calculator would stop somebody's leave counting.
 */
export function holidaysInRange(
  client: Prisma.TransactionClient | typeof prisma,
  from: Date,
  to: Date,
  departmentId: string | null,
): Promise<{ holidayDate: Date; departmentId: string | null }[]> {
  return client.holiday.findMany({
    where: {
      isActive: true,
      holidayDate: { gte: from, lte: to },
      OR: [{ departmentId: null }, ...(departmentId ? [{ departmentId }] : [])],
    },
    select: { holidayDate: true, departmentId: true },
  });
}

export function listHolidays(where: Prisma.HolidayWhereInput): Promise<HolidayRecord[]> {
  return prisma.holiday.findMany({
    where,
    orderBy: { holidayDate: 'asc' },
    select: holidaySelect,
  });
}

export function findHoliday(id: string): Promise<HolidayRecord | null> {
  return prisma.holiday.findUnique({ where: { id }, select: holidaySelect });
}

/** The duplicate check. The partial unique indexes enforce it again. */
export function findHolidayOnDate(
  holidayDate: Date,
  departmentId: string | null,
): Promise<{ id: string } | null> {
  return prisma.holiday.findFirst({
    where: { holidayDate, departmentId },
    select: { id: true },
  });
}

export function createHoliday(data: Prisma.HolidayUncheckedCreateInput): Promise<{ id: string }> {
  return prisma.holiday.create({ data, select: { id: true } });
}

export function updateHoliday(
  id: string,
  data: Prisma.HolidayUncheckedUpdateInput,
): Promise<{ id: string }> {
  return prisma.holiday.update({ where: { id }, data, select: { id: true } });
}

// ---------------------------------------------------------------------------
//  Attendance records
// ---------------------------------------------------------------------------

export function findAttendance(id: string): Promise<AttendanceDetailRecord | null> {
  return prisma.attendanceRecord.findUnique({ where: { id }, select: attendanceDetailSelect });
}

/** One employee's day. The unique index makes this the canonical lookup. */
export function findAttendanceForDate(
  client: Prisma.TransactionClient | typeof prisma,
  employeeId: string,
  attendanceDate: Date,
): Promise<AttendanceDetailRecord | null> {
  return client.attendanceRecord.findUnique({
    where: { employeeId_attendanceDate: { employeeId, attendanceDate } },
    select: attendanceDetailSelect,
  });
}

/**
 * The same row, locked for update.
 *
 * `SELECT … FOR UPDATE` so two concurrent clock-outs or break actions serialise
 * rather than both reading the same state and both writing. The unique index
 * protects creation; this protects mutation of an existing row, which the index
 * cannot.
 */
export async function lockAttendanceForDate(
  tx: Prisma.TransactionClient,
  employeeId: string,
  attendanceDate: Date,
): Promise<{ id: string; sessionState: string; clockInAt: Date | null } | null> {
  const rows = await tx.$queryRaw<{ id: string; sessionState: string; clockInAt: Date | null }[]>`
    SELECT "id", "sessionState"::text AS "sessionState", "clockInAt"
      FROM "AttendanceRecord"
     WHERE "employeeId" = ${employeeId} AND "attendanceDate" = ${attendanceDate}
     FOR UPDATE
  `;
  return rows[0] ?? null;
}

export function createAttendance(
  client: Prisma.TransactionClient | typeof prisma,
  data: Prisma.AttendanceRecordUncheckedCreateInput,
): Promise<{ id: string }> {
  return client.attendanceRecord.create({ data, select: { id: true } });
}

export function updateAttendance(
  client: Prisma.TransactionClient | typeof prisma,
  id: string,
  data: Prisma.AttendanceRecordUncheckedUpdateInput,
): Promise<{ id: string }> {
  return client.attendanceRecord.update({ where: { id }, data, select: { id: true } });
}

/**
 * Upserts the system-resolved row for a date.
 *
 * Used by leave approval and by resolution: a day that already has a record keeps
 * its session and gains the leave link, and a day with none gets a row. An upsert
 * rather than find-then-write, because two leave approvals covering the same date
 * would otherwise both insert.
 */
export function upsertResolvedAttendance(
  tx: Prisma.TransactionClient,
  employeeId: string,
  attendanceDate: Date,
  create: Omit<Prisma.AttendanceRecordUncheckedCreateInput, 'employeeId' | 'attendanceDate'>,
  update: Prisma.AttendanceRecordUncheckedUpdateInput,
): Promise<{ id: string }> {
  return tx.attendanceRecord.upsert({
    where: { employeeId_attendanceDate: { employeeId, attendanceDate } },
    create: { employeeId, attendanceDate, ...create },
    update,
    select: { id: true },
  });
}

export function listAttendance(args: {
  where: Prisma.AttendanceRecordWhereInput;
  take: number;
  cursor?: string;
}): Promise<AttendanceRowRecord[]> {
  return prisma.attendanceRecord.findMany({
    where: args.where,
    select: attendanceRowSelect,
    take: args.take + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    orderBy: [{ attendanceDate: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Status counts and minute totals over a range, in two queries.
 *
 * `groupBy` for the counts and an aggregate for the sums, rather than reading
 * every row into memory: a year of attendance for a department is thousands of
 * rows and the summary needs none of their detail.
 */
export async function attendanceSummaryFor(
  where: Prisma.AttendanceRecordWhereInput,
): Promise<{
  byStatus: { status: string; count: number }[];
  workedMinutes: number;
  overtimeMinutes: number;
  lateCount: number;
  earlyExitCount: number;
}> {
  const [grouped, totals, lateCount, earlyExitCount] = await Promise.all([
    prisma.attendanceRecord.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    }),
    prisma.attendanceRecord.aggregate({
      where,
      _sum: { workedMinutes: true, overtimeMinutes: true },
    }),
    prisma.attendanceRecord.count({ where: { ...where, lateMinutes: { gt: 0 } } }),
    prisma.attendanceRecord.count({ where: { ...where, earlyExitMinutes: { gt: 0 } } }),
  ]);

  return {
    byStatus: grouped.map((row) => ({ status: row.status, count: row._count._all })),
    workedMinutes: totals._sum.workedMinutes ?? 0,
    overtimeMinutes: totals._sum.overtimeMinutes ?? 0,
    lateCount,
    earlyExitCount,
  };
}

// ---------------------------------------------------------------------------
//  Breaks
// ---------------------------------------------------------------------------

export function findOpenBreak(
  client: Prisma.TransactionClient | typeof prisma,
  attendanceRecordId: string,
): Promise<{ id: string; startedAt: Date } | null> {
  return client.attendanceBreak.findFirst({
    where: { attendanceRecordId, endedAt: null },
    select: { id: true, startedAt: true },
  });
}

export function createBreak(
  tx: Prisma.TransactionClient,
  attendanceRecordId: string,
  startedAt: Date,
): Promise<{ id: string }> {
  return tx.attendanceBreak.create({
    data: { attendanceRecordId, startedAt },
    select: { id: true },
  });
}

/**
 * Closes a break, conditionally on it still being open.
 *
 * `updateMany` with `endedAt: null` rather than `update` by id: two concurrent
 * break-end requests would otherwise both succeed and the second would overwrite
 * the first's duration. A zero count tells the service it lost the race.
 */
export function closeBreak(
  tx: Prisma.TransactionClient,
  id: string,
  endedAt: Date,
  minutes: number,
): Promise<{ count: number }> {
  return tx.attendanceBreak.updateMany({
    where: { id, endedAt: null },
    data: { endedAt, minutes },
  });
}

/** Total closed-break minutes for a record, for the clock-out arithmetic. */
export async function closedBreakMinutes(
  client: Prisma.TransactionClient | typeof prisma,
  attendanceRecordId: string,
): Promise<number> {
  const result = await client.attendanceBreak.aggregate({
    where: { attendanceRecordId, endedAt: { not: null } },
    _sum: { minutes: true },
  });
  return result._sum.minutes ?? 0;
}

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

export function findCorrection(id: string): Promise<CorrectionRecord | null> {
  return prisma.attendanceCorrectionRequest.findUnique({
    where: { id },
    select: correctionSelect,
  });
}

export function findPendingCorrection(
  employeeId: string,
  attendanceDate: Date,
): Promise<{ id: string } | null> {
  return prisma.attendanceCorrectionRequest.findFirst({
    where: { employeeId, attendanceDate, status: 'PENDING' },
    select: { id: true },
  });
}

export function createCorrection(
  data: Prisma.AttendanceCorrectionRequestUncheckedCreateInput,
): Promise<{ id: string }> {
  return prisma.attendanceCorrectionRequest.create({ data, select: { id: true } });
}

/**
 * Decides a correction, conditionally on it still being PENDING.
 *
 * The same conditional-update pattern as everywhere else in this codebase: two
 * reviewers deciding at once cannot both succeed, and the loser is told it was
 * already decided rather than silently overwriting the winner.
 */
export function decideCorrection(
  tx: Prisma.TransactionClient,
  id: string,
  data: Prisma.AttendanceCorrectionRequestUncheckedUpdateInput,
): Promise<{ count: number }> {
  return tx.attendanceCorrectionRequest.updateMany({
    where: { id, status: 'PENDING' },
    data,
  });
}

export function listCorrections(args: {
  where: Prisma.AttendanceCorrectionRequestWhereInput;
  take: number;
  cursor?: string;
}): Promise<CorrectionRecord[]> {
  return prisma.attendanceCorrectionRequest.findMany({
    where: args.where,
    select: correctionSelect,
    take: args.take + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

export function upsertOvertime(
  tx: Prisma.TransactionClient,
  employeeId: string,
  overtimeDate: Date,
  minutes: number,
): Promise<{ id: string }> {
  return tx.overtimeRecord.upsert({
    where: { employeeId_overtimeDate: { employeeId, overtimeDate } },
    create: { employeeId, overtimeDate, minutes, status: 'PENDING', source: 'SYSTEM' },
    // A re-clock-out on a corrected day restates the hours. Only a PENDING row is
    // restated — the service guards that, so an approved claim is never silently
    // changed underneath the person who approved it.
    update: { minutes },
    select: { id: true },
  });
}

export function findOvertime(id: string): Promise<OvertimeRecordRow | null> {
  return prisma.overtimeRecord.findUnique({ where: { id }, select: overtimeSelect });
}

export function decideOvertime(
  id: string,
  data: Prisma.OvertimeRecordUncheckedUpdateInput,
): Promise<{ count: number }> {
  return prisma.overtimeRecord.updateMany({ where: { id, status: 'PENDING' }, data });
}

export function listOvertime(args: {
  where: Prisma.OvertimeRecordWhereInput;
  take: number;
  cursor?: string;
}): Promise<OvertimeRecordRow[]> {
  return prisma.overtimeRecord.findMany({
    where: args.where,
    select: overtimeSelect,
    take: args.take + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    orderBy: [{ overtimeDate: 'desc' }, { id: 'desc' }],
  });
}
