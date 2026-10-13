/**
 * HR Phase 2 — Attendance business rules.
 *
 * The rules that shape everything here, stated once:
 *
 *   - **Server time is the only time.** Every instant comes from Postgres via
 *     `databaseNow()`. No endpoint accepts a clock-in or clock-out moment, so a
 *     wrong or deliberately-set browser clock cannot move attendance.
 *   - **The calendar day is an IST day.** `companyDateOf` turns an instant into
 *     the day the business would file it under. 00:30 IST is today, not
 *     yesterday — see `utils/hr-time.ts`.
 *   - **Concurrency is the database's job.** A unique index on
 *     (employeeId, attendanceDate) makes a double clock-in impossible; a partial
 *     unique index makes a double break-start impossible; `SELECT … FOR UPDATE`
 *     serialises mutation of an existing row; conditional updates make a double
 *     decision impossible. Application checks give good messages — they are not
 *     the protection.
 *   - **Derived minutes are frozen at clock-out.** Their inputs are policy, and
 *     policy changes; recomputing a 2024 day against 2026's hours would rewrite
 *     history.
 *   - **Notifications go out after commit**, and audit writes never fail a
 *     request.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  companyDateOf,
  isHoliday as isHolidayOn,
  isWeekOff as isWeekOffOn,
  minutesBetween,
  type AttendanceCorrectionListQuery,
  type AttendanceCorrectionPage,
  type AttendanceCorrectionView,
  type AttendanceDetail,
  type AttendanceListQuery,
  type AttendancePage,
  type AttendancePolicyView,
  type AttendanceRow,
  type AttendanceSummary,
  type AttendanceSummaryQuery,
  type AttendanceToday,
  type CreateAttendanceCorrectionInput,
  type CreateAttendancePolicyInput,
  type CreateHolidayInput,
  type DecideAttendanceCorrectionInput,
  type DecideOvertimeInput,
  type HolidayListQuery,
  type HolidayView,
  type OvertimeListQuery,
  type OvertimePage,
  type OvertimeView,
  type UpdateAttendancePolicyInput,
  type UpdateHolidayInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import * as repo from './attendance.repository.js';
import * as leaveRepo from './leave.repository.js';
import * as notify from './attendance.notify.js';
import {
  attendanceScope,
  mayConfigureHr,
  mayDecideRequest,
  mayReadEmployeeRecords,
  mayRecordOwnAttendance,
  scopedEmployeeFilter,
  type HrRecordScope,
} from './attendance-access.js';
import type { HrActor } from './hr-access.js';
import {
  resolveDay,
  sessionActions,
  sessionTotals,
  type AttendanceRules,
} from './attendance.calc.js';

export const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/**
 * The policy used when none is configured.
 *
 * Deliberately present rather than failing: an employee must be able to clock in
 * on day one, before HR has configured anything. The values match the schema
 * defaults, and the UI shows which policy is in force so "the default" is never
 * silently mistaken for a decision somebody made.
 */
const FALLBACK_RULES: AttendanceRules = {
  expectedStartMinute: 570,
  expectedEndMinute: 1110,
  graceMinutes: 15,
  fullDayMinutes: 480,
  halfDayMinutes: 240,
  overtimeThresholdMinutes: 540,
  weekOffDays: [6, 7],
};

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

const displayName = (p: { firstName: string; lastName: string }): string =>
  `${p.firstName} ${p.lastName}`.trim();

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

function toAttendanceRow(row: repo.AttendanceRowRecord): AttendanceRow {
  return {
    id: row.id,
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: displayName(row.employee),
    },
    department: row.employee.department,
    attendanceDate: dayKey(row.attendanceDate),
    status: row.status,
    workMode: row.workMode,
    sessionState: row.sessionState,
    source: row.source,
    clockInAt: iso(row.clockInAt),
    clockOutAt: iso(row.clockOutAt),
    workedMinutes: row.workedMinutes,
    breakMinutes: row.breakMinutes,
    lateMinutes: row.lateMinutes,
    earlyExitMinutes: row.earlyExitMinutes,
    overtimeMinutes: row.overtimeMinutes,
    remarks: row.remarks,
  };
}

function toAttendanceDetail(row: repo.AttendanceDetailRecord): AttendanceDetail {
  return {
    ...toAttendanceRow(row),
    leaveRequestId: row.leaveRequestId,
    breaks: row.breaks.map((b) => ({
      id: b.id,
      startedAt: b.startedAt.toISOString(),
      endedAt: iso(b.endedAt),
      minutes: b.minutes,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPolicyView(row: repo.PolicyRecord): AttendancePolicyView {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    expectedStartMinute: row.expectedStartMinute,
    expectedEndMinute: row.expectedEndMinute,
    graceMinutes: row.graceMinutes,
    fullDayMinutes: row.fullDayMinutes,
    halfDayMinutes: row.halfDayMinutes,
    overtimeThresholdMinutes: row.overtimeThresholdMinutes,
    weekOffDays: row.weekOffDays,
    isActive: row.isActive,
    isDefault: row.isDefault,
    department: row.department,
  };
}

const toRules = (row: repo.PolicyRecord | null): AttendanceRules =>
  row === null
    ? FALLBACK_RULES
    : {
        expectedStartMinute: row.expectedStartMinute,
        expectedEndMinute: row.expectedEndMinute,
        graceMinutes: row.graceMinutes,
        fullDayMinutes: row.fullDayMinutes,
        halfDayMinutes: row.halfDayMinutes,
        overtimeThresholdMinutes: row.overtimeThresholdMinutes,
        weekOffDays: row.weekOffDays,
      };

function toCorrectionView(row: repo.CorrectionRecord): AttendanceCorrectionView {
  return {
    id: row.id,
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: displayName(row.employee),
    },
    attendanceDate: dayKey(row.attendanceDate),
    currentClockInAt: iso(row.currentClockInAt),
    currentClockOutAt: iso(row.currentClockOutAt),
    requestedClockInAt: iso(row.requestedClockInAt),
    requestedClockOutAt: iso(row.requestedClockOutAt),
    requestedWorkMode: row.requestedWorkMode,
    reason: row.reason,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
  };
}

function toOvertimeView(row: repo.OvertimeRecordRow): OvertimeView {
  return {
    id: row.id,
    employee: {
      id: row.employee.id,
      employeeId: row.employee.employeeId,
      displayName: displayName(row.employee),
    },
    overtimeDate: dayKey(row.overtimeDate),
    minutes: row.minutes,
    status: row.status,
    source: row.source,
    remarks: row.remarks,
    decidedAt: iso(row.decidedAt),
  };
}

const toHolidayView = (row: repo.HolidayRecord): HolidayView => ({
  id: row.id,
  name: row.name,
  holidayDate: dayKey(row.holidayDate),
  description: row.description,
  isActive: row.isActive,
  department: row.department,
});

// ---------------------------------------------------------------------------
//  Scope helpers
// ---------------------------------------------------------------------------

/**
 * The acting person's scope, resolved once.
 *
 * "Is this person a manager" is a database question, so it is answered here and
 * handed to the pure policy. One count rather than fetching reports: the policy
 * needs only whether any exist.
 */
async function scopeFor(actor: HrActor): Promise<HrRecordScope> {
  if (actor.can('HR_ATTENDANCE', 'VIEW')) return { kind: 'all' };
  if (!actor.employeeId) return { kind: 'none' };

  const reports = await prisma.employee.count({ where: { managerId: actor.employeeId } });
  return attendanceScope(actor, { hasReports: reports > 0 });
}

const notFound = (): AppError =>
  AppError.notFound('ATTENDANCE_NOT_FOUND', 'That attendance record could not be found.');

/** The employee a self-service action applies to, or a refusal. */
function ownEmployeeOrFail(actor: HrActor): string {
  if (!actor.employeeId) {
    throw new AppError(
      'NO_EMPLOYEE_RECORD',
      403,
      'Your account is not linked to an employee record, so attendance cannot be recorded.',
    );
  }
  return actor.employeeId;
}

/** Context plus the policy and holidays that govern one employee's day. */
async function dayContext(
  client: Prisma.TransactionClient | typeof prisma,
  employeeId: string,
  day: Date,
): Promise<{
  employee: NonNullable<Awaited<ReturnType<typeof leaveRepo.findEmployeeContext>>>;
  rules: AttendanceRules;
  policy: repo.PolicyRecord | null;
  isHoliday: boolean;
  isWeekOff: boolean;
}> {
  const employee = await leaveRepo.findEmployeeContext(client, employeeId);
  if (!employee) throw AppError.notFound('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');

  const policy = await repo.policyForEmployee(client, employee.departmentId);
  const rules = toRules(policy);
  const holidays = await repo.holidaysInRange(client, day, day, employee.departmentId);

  return {
    employee,
    rules,
    policy,
    isHoliday: isHolidayOn(day, holidays, employee.departmentId),
    isWeekOff: isWeekOffOn(day, { weekOffDays: rules.weekOffDays }),
  };
}

/** The approved leave covering a day, if any. */
async function approvedLeaveOn(
  client: Prisma.TransactionClient | typeof prisma,
  employeeId: string,
  day: Date,
): Promise<{ id: string; isHalfDay: boolean } | null> {
  const leave = await client.leaveRequest.findFirst({
    where: {
      employeeId,
      status: 'APPROVED',
      startDate: { lte: day },
      endDate: { gte: day },
    },
    select: { id: true, isHalfDay: true },
  });
  return leave;
}

// ---------------------------------------------------------------------------
//  Clocking
// ---------------------------------------------------------------------------

/**
 * Clocks somebody in.
 *
 * Concurrency: the record is created inside a transaction and the unique index on
 * (employeeId, attendanceDate) is what makes a double clock-in impossible. Two
 * simultaneous requests both see "no record"; one insert wins and the other gets
 * a P2002 that becomes a clear "already clocked in" rather than a 500.
 *
 * A holiday or week-off does **not** block clocking in — people do work Sundays,
 * and refusing would make that unrecordable. The day keeps its HOLIDAY or
 * WEEK_OFF status (see `resolveDay`) with the hours attached, which is what
 * preserves the overtime claim.
 *
 * An approved full-day leave *does* block it: somebody on approved leave who
 * clocks in has either come in unexpectedly — in which case the leave should be
 * cancelled — or made a mistake, and silently overwriting an approved absence is
 * the one outcome nobody wants.
 */
export async function clockIn(
  req: Request,
  actor: HrActor,
  input: { workMode?: AttendanceRow['workMode']; remarks?: string },
): Promise<AttendanceDetail> {
  const employeeId = ownEmployeeOrFail(actor);
  if (!mayRecordOwnAttendance(actor, employeeId)) {
    throw new AppError('ATTENDANCE_NOT_PERMITTED', 403, 'You cannot record this attendance.');
  }

  const now = await databaseNow();
  const day = companyDateOf(now);

  const id = await prisma.$transaction(async (tx) => {
    const context = await dayContext(tx, employeeId, day);

    if (context.employee.status === 'EXITED') {
      throw AppError.badRequest(
        'EMPLOYEE_NOT_EMPLOYED',
        'That employee has left, so attendance cannot be recorded.',
      );
    }
    if (context.employee.status === 'INACTIVE') {
      throw AppError.badRequest(
        'EMPLOYEE_INACTIVE',
        'That employee is inactive, so attendance cannot be recorded.',
      );
    }

    const leave = await approvedLeaveOn(tx, employeeId, day);
    if (leave && !leave.isHalfDay) {
      throw AppError.badRequest(
        'ON_APPROVED_LEAVE',
        'You are on approved leave today. Cancel the leave first if you are working.',
      );
    }

    const existing = await repo.findAttendanceForDate(tx, employeeId, day);
    if (existing) {
      // A clear message for the common case. The unique index below is what
      // actually prevents the duplicate under concurrency.
      if (existing.sessionState === 'CLOSED') {
        throw AppError.badRequest(
          'ALREADY_CLOCKED_OUT',
          'You have already clocked out for today. Raise a correction if that is wrong.',
        );
      }
      throw AppError.badRequest('ALREADY_CLOCKED_IN', 'You are already clocked in.');
    }

    try {
      const created = await repo.createAttendance(tx, {
        employeeId,
        attendanceDate: day,
        // The day's status is the resolution's answer, not "PRESENT" — a Sunday
        // stays WEEK_OFF, and the hours are recorded against it.
        status: resolveDay(
          {
            approvedLeave: leave ? { isHalfDay: leave.isHalfDay } : null,
            isHoliday: context.isHoliday,
            isWeekOff: context.isWeekOff,
            // No completed session yet: the status is provisional and is
            // recomputed at clock-out from the worked minutes.
            workedMinutes: null,
          },
          context.rules,
        ).status,
        sessionState: 'OPEN',
        source: 'SELF',
        clockInAt: now,
        workMode: input.workMode ?? 'OFFICE',
        remarks: input.remarks ?? null,
        leaveRequestId: leave?.id ?? null,
      });
      return created.id;
    } catch (error) {
      // The index did its job: another request created the row first.
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'P2002'
      ) {
        throw AppError.badRequest('ALREADY_CLOCKED_IN', 'You are already clocked in.');
      }
      throw error;
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_CLOCK_IN',
    entityType: 'AttendanceRecord',
    entityId: id,
    actorId: actor.id,
    newValue: { attendanceDate: dayKey(day), workMode: input.workMode ?? 'OFFICE' },
  });

  const record = await repo.findAttendance(id);
  if (!record) throw notFound();
  return toAttendanceDetail(record);
}

/**
 * Clocks somebody out, and computes the day.
 *
 * The row is locked for update first, so two concurrent clock-outs serialise:
 * the unique index protects creation but cannot protect mutation, and without the
 * lock both would read OPEN and both write a clock-out time.
 *
 * Clocking out while ON_BREAK is refused rather than silently closing the break —
 * the state machine says so, and the honest fix is to end the break. Somebody who
 * forgot is better served by the correction workflow than by the system guessing
 * when they stopped.
 */
export async function clockOut(
  req: Request,
  actor: HrActor,
  input: { remarks?: string },
): Promise<AttendanceDetail> {
  const employeeId = ownEmployeeOrFail(actor);
  const now = await databaseNow();
  const day = companyDateOf(now);

  const result = await prisma.$transaction(async (tx) => {
    const locked = await repo.lockAttendanceForDate(tx, employeeId, day);
    if (!locked) {
      throw AppError.badRequest('NOT_CLOCKED_IN', 'You have not clocked in today.');
    }
    if (locked.sessionState === 'CLOSED') {
      throw AppError.badRequest('ALREADY_CLOCKED_OUT', 'You have already clocked out today.');
    }
    if (locked.sessionState === 'ON_BREAK') {
      throw AppError.badRequest(
        'ON_BREAK',
        'End your break before clocking out.',
      );
    }
    if (!locked.clockInAt) {
      // Unreachable while the session CHECK holds; a clear error beats a crash.
      throw AppError.badRequest('NOT_CLOCKED_IN', 'You have not clocked in today.');
    }

    const context = await dayContext(tx, employeeId, day);
    const breakMinutes = await repo.closedBreakMinutes(tx, locked.id);

    const totals = sessionTotals({
      clockInAt: locked.clockInAt,
      clockOutAt: now,
      breakMinutes,
      rules: context.rules,
    });

    const leave = await approvedLeaveOn(tx, employeeId, day);
    const resolved = resolveDay(
      {
        approvedLeave: leave ? { isHalfDay: leave.isHalfDay } : null,
        isHoliday: context.isHoliday,
        isWeekOff: context.isWeekOff,
        workedMinutes: totals.workedMinutes,
      },
      context.rules,
    );

    await repo.updateAttendance(tx, locked.id, {
      clockOutAt: now,
      sessionState: 'CLOSED',
      status: resolved.status,
      workedMinutes: totals.workedMinutes,
      breakMinutes: totals.breakMinutes,
      lateMinutes: totals.lateMinutes,
      earlyExitMinutes: totals.earlyExitMinutes,
      overtimeMinutes: totals.overtimeMinutes,
      ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
    });

    /*
      Overtime becomes a claim somebody decides, rather than a number on the
      attendance row nobody sees. Only raised when there is any, and only while
      still PENDING — an approved claim is never silently restated underneath the
      person who approved it.
    */
    if (totals.overtimeMinutes > 0) {
      const existing = await tx.overtimeRecord.findUnique({
        where: { employeeId_overtimeDate: { employeeId, overtimeDate: day } },
        select: { status: true },
      });
      if (!existing || existing.status === 'PENDING') {
        await repo.upsertOvertime(tx, employeeId, day, totals.overtimeMinutes);
      }
    }

    return { id: locked.id, totals, status: resolved.status };
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_CLOCK_OUT',
    entityType: 'AttendanceRecord',
    entityId: result.id,
    actorId: actor.id,
    newValue: {
      attendanceDate: dayKey(day),
      status: result.status,
      workedMinutes: result.totals.workedMinutes,
      overtimeMinutes: result.totals.overtimeMinutes,
    },
  });

  const record = await repo.findAttendance(result.id);
  if (!record) throw notFound();
  return toAttendanceDetail(record);
}

/**
 * Starts a break.
 *
 * The partial unique index on (attendanceRecordId) WHERE endedAt IS NULL is what
 * makes a second open break impossible; the lock serialises the state change on
 * the record itself.
 */
export async function startBreak(
  req: Request,
  actor: HrActor,
): Promise<AttendanceDetail> {
  const employeeId = ownEmployeeOrFail(actor);
  const now = await databaseNow();
  const day = companyDateOf(now);

  const id = await prisma.$transaction(async (tx) => {
    const locked = await repo.lockAttendanceForDate(tx, employeeId, day);
    if (!locked) throw AppError.badRequest('NOT_CLOCKED_IN', 'You have not clocked in today.');
    if (locked.sessionState === 'CLOSED') {
      throw AppError.badRequest('ALREADY_CLOCKED_OUT', 'You have already clocked out today.');
    }
    if (locked.sessionState === 'ON_BREAK') {
      throw AppError.badRequest('ALREADY_ON_BREAK', 'You are already on a break.');
    }

    try {
      await repo.createBreak(tx, locked.id, now);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'P2002'
      ) {
        throw AppError.badRequest('ALREADY_ON_BREAK', 'You are already on a break.');
      }
      throw error;
    }

    await repo.updateAttendance(tx, locked.id, { sessionState: 'ON_BREAK' });
    return locked.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_BREAK_START',
    entityType: 'AttendanceRecord',
    entityId: id,
    actorId: actor.id,
    newValue: { attendanceDate: dayKey(day) },
  });

  const record = await repo.findAttendance(id);
  if (!record) throw notFound();
  return toAttendanceDetail(record);
}

/** Ends the open break. The conditional close is what stops a double end. */
export async function endBreak(req: Request, actor: HrActor): Promise<AttendanceDetail> {
  const employeeId = ownEmployeeOrFail(actor);
  const now = await databaseNow();
  const day = companyDateOf(now);

  const id = await prisma.$transaction(async (tx) => {
    const locked = await repo.lockAttendanceForDate(tx, employeeId, day);
    if (!locked) throw AppError.badRequest('NOT_CLOCKED_IN', 'You have not clocked in today.');
    if (locked.sessionState !== 'ON_BREAK') {
      throw AppError.badRequest('NOT_ON_BREAK', 'You are not on a break.');
    }

    const open = await repo.findOpenBreak(tx, locked.id);
    if (!open) {
      // State says ON_BREAK but no open break exists — refuse rather than invent
      // one. The CHECK pairing makes this unreachable in practice.
      throw AppError.badRequest('NOT_ON_BREAK', 'You are not on a break.');
    }

    const minutes = minutesBetween(open.startedAt, now);
    const closed = await repo.closeBreak(tx, open.id, now, minutes);
    if (closed.count === 0) {
      throw AppError.badRequest('NOT_ON_BREAK', 'That break has already ended.');
    }

    const breakMinutes = await repo.closedBreakMinutes(tx, locked.id);
    await repo.updateAttendance(tx, locked.id, { sessionState: 'OPEN', breakMinutes });
    return locked.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_BREAK_END',
    entityType: 'AttendanceRecord',
    entityId: id,
    actorId: actor.id,
    newValue: { attendanceDate: dayKey(day) },
  });

  const record = await repo.findAttendance(id);
  if (!record) throw notFound();
  return toAttendanceDetail(record);
}

// ---------------------------------------------------------------------------
//  Reads
// ---------------------------------------------------------------------------

/**
 * The employee's own widget state.
 *
 * `canClockIn` and the rest are derived here from the session state, so the
 * buttons and the API agree. A button left enabled by a stale page is still
 * refused by the service — this is a courtesy, not the enforcement.
 */
export async function today(actor: HrActor): Promise<AttendanceToday> {
  const employeeId = ownEmployeeOrFail(actor);
  const now = await databaseNow();
  const day = companyDateOf(now);

  const context = await dayContext(prisma, employeeId, day);
  const record = await repo.findAttendanceForDate(prisma, employeeId, day);
  const leave = await approvedLeaveOn(prisma, employeeId, day);

  const state = record?.sessionState ?? 'NONE';
  const actions = sessionActions(state);
  const openBreak = record?.breaks.find((b) => b.endedAt === null) ?? null;

  return {
    attendanceDate: dayKey(day),
    record: record ? toAttendanceDetail(record) : null,
    policy: context.policy ? toPolicyView(context.policy) : null,
    isHoliday: context.isHoliday,
    isWeekOff: context.isWeekOff,
    onLeave: leave !== null,
    // A full-day approved leave removes the clock-in action, matching the service.
    canClockIn: actions.canClockIn && !(leave !== null && !leave.isHalfDay),
    canClockOut: actions.canClockOut,
    canStartBreak: actions.canStartBreak,
    canEndBreak: actions.canEndBreak,
    openBreak: openBreak
      ? {
          id: openBreak.id,
          startedAt: openBreak.startedAt.toISOString(),
          endedAt: null,
          minutes: null,
        }
      : null,
  };
}

export async function listAttendance(
  actor: HrActor,
  query: AttendanceListQuery,
): Promise<AttendancePage> {
  const scope = await scopeFor(actor);

  const where: Prisma.AttendanceRecordWhereInput = {
    // ANDed into the query, never applied after: post-filtering a page would make
    // the cursor skip rows and a team would appear to end early.
    employee: scopedEmployeeFilter(scope) as Prisma.EmployeeWhereInput,
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.workMode ? { workMode: query.workMode } : {}),
    ...(query.from || query.to
      ? {
          attendanceDate: {
            ...(query.from ? { gte: companyDateOf(query.from) } : {}),
            ...(query.to ? { lte: companyDateOf(query.to) } : {}),
          },
        }
      : {}),
  };

  /*
    A department filter would otherwise replace the scope's `employee` clause,
    silently widening a manager's view to the whole department. Merged explicitly.
  */
  if (query.departmentId) {
    where.employee = {
      ...(scopedEmployeeFilter(scope) as Prisma.EmployeeWhereInput),
      departmentId: query.departmentId,
    };
  }

  const rows = await repo.listAttendance({
    where,
    take: query.limit,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);

  return {
    attendance: page.map(toAttendanceRow),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getAttendance(actor: HrActor, id: string): Promise<AttendanceDetail> {
  const record = await repo.findAttendance(id);
  if (!record) throw notFound();

  const scope = await scopeFor(actor);
  const employee = await leaveRepo.findEmployeeContext(prisma, record.employee.id);
  // 404 rather than 403 for a record outside scope: saying "it exists but is not
  // yours" would let somebody enumerate colleagues by probing ids.
  if (!employee || !mayReadEmployeeRecords(scope, { id: employee.id, managerId: employee.managerId })) {
    throw notFound();
  }

  return toAttendanceDetail(record);
}

export async function summary(
  actor: HrActor,
  query: AttendanceSummaryQuery,
): Promise<AttendanceSummary> {
  const scope = await scopeFor(actor);
  const from = companyDateOf(query.from);
  const to = companyDateOf(query.to);

  const where: Prisma.AttendanceRecordWhereInput = {
    employee: scopedEmployeeFilter(scope) as Prisma.EmployeeWhereInput,
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    attendanceDate: { gte: from, lte: to },
  };

  const totals = await repo.attendanceSummaryFor(where);
  const count = (status: string): number =>
    totals.byStatus.find((row) => row.status === status)?.count ?? 0;

  return {
    from: dayKey(from),
    to: dayKey(to),
    presentDays: count('PRESENT'),
    absentDays: count('ABSENT'),
    halfDays: count('HALF_DAY'),
    leaveDays: count('LEAVE'),
    holidayDays: count('HOLIDAY'),
    weekOffDays: count('WEEK_OFF'),
    workedMinutes: totals.workedMinutes,
    overtimeMinutes: totals.overtimeMinutes,
    lateCount: totals.lateCount,
    earlyExitCount: totals.earlyExitCount,
  };
}

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

/**
 * Raises a correction request.
 *
 * The current values are snapshotted onto the request so a reviewer sees both
 * sides without the record being mutated first — and so the evidence survives
 * even if the record changes afterwards.
 *
 * Only one PENDING request per employee per date, enforced by a partial unique
 * index: without it somebody could raise five for the same day and five reviewers
 * could decide them independently, each overwriting the last.
 */
export async function createCorrection(
  req: Request,
  actor: HrActor,
  input: CreateAttendanceCorrectionInput,
): Promise<AttendanceCorrectionView> {
  const employeeId = ownEmployeeOrFail(actor);
  const now = await databaseNow();
  const day = companyDateOf(input.attendanceDate);

  if (day.getTime() > companyDateOf(now).getTime()) {
    throw AppError.badRequest(
      'FUTURE_CORRECTION',
      'A correction cannot be raised for a future date.',
    );
  }

  const pending = await repo.findPendingCorrection(employeeId, day);
  if (pending) {
    throw AppError.conflict(
      'CORRECTION_ALREADY_PENDING',
      'You already have a correction waiting for a decision on that date.',
    );
  }

  const existing = await repo.findAttendanceForDate(prisma, employeeId, day);

  let created: { id: string };
  try {
    created = await repo.createCorrection({
      employeeId,
      attendanceRecordId: existing?.id ?? null,
      attendanceDate: day,
      currentClockInAt: existing?.clockInAt ?? null,
      currentClockOutAt: existing?.clockOutAt ?? null,
      requestedClockInAt: input.requestedClockInAt ?? null,
      requestedClockOutAt: input.requestedClockOutAt ?? null,
      requestedWorkMode: input.requestedWorkMode ?? null,
      reason: input.reason,
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    ) {
      throw AppError.conflict(
        'CORRECTION_ALREADY_PENDING',
        'You already have a correction waiting for a decision on that date.',
      );
    }
    throw error;
  }

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_CORRECTION_REQUESTED',
    entityType: 'AttendanceCorrectionRequest',
    entityId: created.id,
    actorId: actor.id,
    newValue: { attendanceDate: dayKey(day) },
  });

  // The manager is told, because nothing else would prompt them to look.
  const employee = await leaveRepo.findEmployeeContext(prisma, employeeId);
  if (employee?.managerId) {
    const manager = await leaveRepo.findManagerAccount(employee.managerId);
    if (manager?.userId && manager.isActive) {
      await notify.notifyCorrectionRequested(manager.userId, created.id);
    }
  }

  const record = await repo.findCorrection(created.id);
  if (!record) {
    throw AppError.notFound('CORRECTION_NOT_FOUND', 'That correction could not be found.');
  }
  return toCorrectionView(record);
}

/**
 * Decides a correction, and applies it atomically when approved.
 *
 * The attendance write and the decision happen in one transaction: a request that
 * said APPROVED while the record was unchanged would be worse than no workflow at
 * all. The conditional update on `status = PENDING` is what makes a double
 * decision impossible.
 *
 * An approved correction stamps the record `source: CORRECTION`, so a future
 * Payroll phase can tell an amended day from a self-recorded one.
 */
export async function decideCorrection(
  req: Request,
  actor: HrActor,
  id: string,
  input: DecideAttendanceCorrectionInput,
): Promise<AttendanceCorrectionView> {
  const request = await repo.findCorrection(id);
  if (!request) {
    throw AppError.notFound('CORRECTION_NOT_FOUND', 'That correction could not be found.');
  }

  const employee = await leaveRepo.findEmployeeContext(prisma, request.employee.id);
  if (!employee) throw AppError.notFound('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');

  if (
    !mayDecideRequest(
      actor,
      { employeeId: employee.id, managerId: employee.managerId, status: request.status },
      { module: 'HR_ATTENDANCE' },
    )
  ) {
    // One message for several causes — no permission, own request, already
    // decided. Distinguishing them would reveal which requests exist.
    throw new AppError(
      'CORRECTION_NOT_PERMITTED',
      403,
      'You cannot decide this correction.',
    );
  }

  const now = await databaseNow();

  await prisma.$transaction(async (tx) => {
    const decided = await repo.decideCorrection(tx, id, {
      status: input.decision,
      decidedById: actor.id,
      decidedAt: now,
      decisionNote: input.note ?? null,
    });
    if (decided.count === 0) {
      throw AppError.badRequest(
        'CORRECTION_ALREADY_DECIDED',
        'Somebody has already decided this correction.',
      );
    }

    if (input.decision !== 'APPROVED') return;

    const day = companyDateOf(request.attendanceDate);
    const context = await dayContext(tx, employee.id, day);

    const clockInAt = request.requestedClockInAt ?? request.currentClockInAt;
    const clockOutAt = request.requestedClockOutAt ?? request.currentClockOutAt;

    /*
      A correction that leaves no clock-in cannot produce a session. Rather than
      writing a half-state, the day is recorded as resolved with no session — the
      CHECK requires NONE to carry neither timestamp.
    */
    if (!clockInAt) {
      const leave = await approvedLeaveOn(tx, employee.id, day);
      const resolved = resolveDay(
        {
          approvedLeave: leave ? { isHalfDay: leave.isHalfDay } : null,
          isHoliday: context.isHoliday,
          isWeekOff: context.isWeekOff,
          workedMinutes: null,
        },
        context.rules,
      );
      await repo.upsertResolvedAttendance(
        tx,
        employee.id,
        day,
        { status: resolved.status, sessionState: 'NONE', source: 'CORRECTION' },
        { status: resolved.status, sessionState: 'NONE', source: 'CORRECTION',
          clockInAt: null, clockOutAt: null, workedMinutes: 0, breakMinutes: 0,
          lateMinutes: 0, earlyExitMinutes: 0, overtimeMinutes: 0 },
      );
      return;
    }

    const breakMinutes = request.attendanceRecordId
      ? await repo.closedBreakMinutes(tx, request.attendanceRecordId)
      : 0;

    const totals = clockOutAt
      ? sessionTotals({ clockInAt, clockOutAt, breakMinutes, rules: context.rules })
      : null;

    const leave = await approvedLeaveOn(tx, employee.id, day);
    const resolved = resolveDay(
      {
        approvedLeave: leave ? { isHalfDay: leave.isHalfDay } : null,
        isHoliday: context.isHoliday,
        isWeekOff: context.isWeekOff,
        workedMinutes: totals?.workedMinutes ?? null,
      },
      context.rules,
    );

    const payload = {
      status: resolved.status,
      source: 'CORRECTION' as const,
      clockInAt,
      clockOutAt: clockOutAt ?? null,
      sessionState: clockOutAt ? ('CLOSED' as const) : ('OPEN' as const),
      workMode: request.requestedWorkMode ?? undefined,
      workedMinutes: totals?.workedMinutes ?? 0,
      breakMinutes: totals?.breakMinutes ?? 0,
      lateMinutes: totals?.lateMinutes ?? 0,
      earlyExitMinutes: totals?.earlyExitMinutes ?? 0,
      overtimeMinutes: totals?.overtimeMinutes ?? 0,
    };

    await repo.upsertResolvedAttendance(tx, employee.id, day, payload, payload);

    // Restate the overtime claim only while it is still undecided.
    if (totals && totals.overtimeMinutes > 0) {
      const current = await tx.overtimeRecord.findUnique({
        where: { employeeId_overtimeDate: { employeeId: employee.id, overtimeDate: day } },
        select: { status: true },
      });
      if (!current || current.status === 'PENDING') {
        await repo.upsertOvertime(tx, employee.id, day, totals.overtimeMinutes);
      }
    }
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_CORRECTION_DECIDED',
    entityType: 'AttendanceCorrectionRequest',
    entityId: id,
    actorId: actor.id,
    oldValue: { status: request.status },
    newValue: { status: input.decision, attendanceDate: dayKey(request.attendanceDate) },
  });

  if (employee.userId) {
    await notify.notifyCorrectionDecided(employee.userId, id, input.decision);
  }

  const updated = await repo.findCorrection(id);
  if (!updated) {
    throw AppError.notFound('CORRECTION_NOT_FOUND', 'That correction could not be found.');
  }
  return toCorrectionView(updated);
}

export async function listCorrections(
  actor: HrActor,
  query: AttendanceCorrectionListQuery,
): Promise<AttendanceCorrectionPage> {
  const scope = await scopeFor(actor);

  const where: Prisma.AttendanceCorrectionRequestWhereInput = {
    employee: scopedEmployeeFilter(scope) as Prisma.EmployeeWhereInput,
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.status ? { status: query.status } : {}),
    // The approver's queue: never their own, because nobody decides their own.
    ...(query.mine && actor.employeeId ? { employeeId: { not: actor.employeeId } } : {}),
    ...(query.mine ? { status: 'PENDING' as const } : {}),
  };

  const rows = await repo.listCorrections({ where, take: query.limit, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    corrections: page.map(toCorrectionView),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

export async function listOvertime(
  actor: HrActor,
  query: OvertimeListQuery,
): Promise<OvertimePage> {
  const scope = await scopeFor(actor);

  const where: Prisma.OvertimeRecordWhereInput = {
    employee: scopedEmployeeFilter(scope) as Prisma.EmployeeWhereInput,
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to
      ? {
          overtimeDate: {
            ...(query.from ? { gte: companyDateOf(query.from) } : {}),
            ...(query.to ? { lte: companyDateOf(query.to) } : {}),
          },
        }
      : {}),
  };

  const rows = await repo.listOvertime({ where, take: query.limit, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    overtime: page.map(toOvertimeView),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function decideOvertime(
  req: Request,
  actor: HrActor,
  id: string,
  input: DecideOvertimeInput,
): Promise<OvertimeView> {
  const record = await repo.findOvertime(id);
  if (!record) throw AppError.notFound('OVERTIME_NOT_FOUND', 'That overtime could not be found.');

  const employee = await leaveRepo.findEmployeeContext(prisma, record.employee.id);
  if (!employee) throw AppError.notFound('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');

  if (
    !mayDecideRequest(
      actor,
      { employeeId: employee.id, managerId: employee.managerId, status: record.status },
      { module: 'HR_ATTENDANCE' },
    )
  ) {
    throw new AppError('OVERTIME_NOT_PERMITTED', 403, 'You cannot decide this overtime.');
  }

  const now = await databaseNow();
  const decided = await repo.decideOvertime(id, {
    status: input.decision,
    decidedById: actor.id,
    decidedAt: now,
    ...(input.note === undefined ? {} : { remarks: input.note }),
  });
  if (decided.count === 0) {
    throw AppError.badRequest(
      'OVERTIME_ALREADY_DECIDED',
      'Somebody has already decided this overtime.',
    );
  }

  await recordAudit(req, {
    action: 'HR_OVERTIME_DECIDED',
    entityType: 'OvertimeRecord',
    entityId: id,
    actorId: actor.id,
    oldValue: { status: record.status },
    newValue: { status: input.decision, minutes: record.minutes },
  });

  const updated = await repo.findOvertime(id);
  if (!updated) throw AppError.notFound('OVERTIME_NOT_FOUND', 'That overtime could not be found.');
  return toOvertimeView(updated);
}

// ---------------------------------------------------------------------------
//  Holidays and policies
// ---------------------------------------------------------------------------

export async function listHolidays(query: HolidayListQuery): Promise<HolidayView[]> {
  const rows = await repo.listHolidays({
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    ...(query.departmentId
      ? { OR: [{ departmentId: null }, { departmentId: query.departmentId }] }
      : {}),
    ...(query.from || query.to
      ? {
          holidayDate: {
            ...(query.from ? { gte: companyDateOf(query.from) } : {}),
            ...(query.to ? { lte: companyDateOf(query.to) } : {}),
          },
        }
      : {}),
  });
  return rows.map(toHolidayView);
}

export async function createHoliday(
  req: Request,
  actor: HrActor,
  input: CreateHolidayInput,
): Promise<HolidayView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure holidays.');
  }

  const day = companyDateOf(input.holidayDate);
  const clash = await repo.findHolidayOnDate(day, input.departmentId ?? null);
  if (clash) {
    throw AppError.conflict('HOLIDAY_EXISTS', 'A holiday already exists on that date.');
  }

  let created: { id: string };
  try {
    created = await repo.createHoliday({
      name: input.name,
      holidayDate: day,
      description: input.description ?? null,
      departmentId: input.departmentId ?? null,
    });
  } catch (error) {
    // The partial unique indexes catch the race the check above cannot.
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    ) {
      throw AppError.conflict('HOLIDAY_EXISTS', 'A holiday already exists on that date.');
    }
    throw error;
  }

  await recordAudit(req, {
    action: 'HR_HOLIDAY_CREATED',
    entityType: 'Holiday',
    entityId: created.id,
    actorId: actor.id,
    newValue: { name: input.name, holidayDate: dayKey(day) },
  });

  const record = await repo.findHoliday(created.id);
  if (!record) throw AppError.notFound('HOLIDAY_NOT_FOUND', 'That holiday could not be found.');
  return toHolidayView(record);
}

export async function updateHoliday(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateHolidayInput,
): Promise<HolidayView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure holidays.');
  }

  const before = await repo.findHoliday(id);
  if (!before) throw AppError.notFound('HOLIDAY_NOT_FOUND', 'That holiday could not be found.');

  await repo.updateHoliday(id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  });

  await recordAudit(req, {
    action: 'HR_HOLIDAY_UPDATED',
    entityType: 'Holiday',
    entityId: id,
    actorId: actor.id,
    oldValue: { name: before.name, isActive: before.isActive },
    newValue: { name: input.name ?? before.name, isActive: input.isActive ?? before.isActive },
  });

  const record = await repo.findHoliday(id);
  if (!record) throw AppError.notFound('HOLIDAY_NOT_FOUND', 'That holiday could not be found.');
  return toHolidayView(record);
}

export async function listPolicies(): Promise<AttendancePolicyView[]> {
  const rows = await repo.listPolicies();
  return rows.map(toPolicyView);
}

export async function createPolicy(
  req: Request,
  actor: HrActor,
  input: CreateAttendancePolicyInput,
): Promise<AttendancePolicyView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure attendance policies.');
  }

  const clash = await repo.findPolicyByCode(input.code);
  if (clash) {
    throw AppError.conflict('POLICY_CODE_TAKEN', 'A policy with that code already exists.');
  }

  const id = await prisma.$transaction(async (tx) => {
    // Exactly one default, which the partial unique index enforces — clearing the
    // old one first is what stops the insert failing on it.
    if (input.isDefault) await repo.clearDefaultPolicy(tx);

    const created = await tx.attendancePolicy.create({
      data: {
        name: input.name,
        code: input.code,
        ...(input.expectedStartMinute === undefined
          ? {}
          : { expectedStartMinute: input.expectedStartMinute }),
        ...(input.expectedEndMinute === undefined
          ? {}
          : { expectedEndMinute: input.expectedEndMinute }),
        ...(input.graceMinutes === undefined ? {} : { graceMinutes: input.graceMinutes }),
        ...(input.fullDayMinutes === undefined ? {} : { fullDayMinutes: input.fullDayMinutes }),
        ...(input.halfDayMinutes === undefined ? {} : { halfDayMinutes: input.halfDayMinutes }),
        ...(input.overtimeThresholdMinutes === undefined
          ? {}
          : { overtimeThresholdMinutes: input.overtimeThresholdMinutes }),
        ...(input.weekOffDays === undefined ? {} : { weekOffDays: input.weekOffDays }),
        departmentId: input.departmentId ?? null,
        isDefault: input.isDefault ?? false,
      },
      select: { id: true },
    });
    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_POLICY_CREATED',
    entityType: 'AttendancePolicy',
    entityId: id,
    actorId: actor.id,
    newValue: { name: input.name, code: input.code, isDefault: input.isDefault ?? false },
  });

  const record = await repo.findPolicy(id);
  if (!record) throw AppError.notFound('POLICY_NOT_FOUND', 'That policy could not be found.');
  return toPolicyView(record);
}

export async function updatePolicy(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateAttendancePolicyInput,
): Promise<AttendancePolicyView> {
  if (!mayConfigureHr(actor)) {
    throw new AppError('HR_CONFIG_NOT_PERMITTED', 403, 'You cannot configure attendance policies.');
  }

  const before = await repo.findPolicy(id);
  if (!before) throw AppError.notFound('POLICY_NOT_FOUND', 'That policy could not be found.');

  /*
    Validated against the merged result, not the input alone: changing only the
    start minute must still leave a day that ends after it starts, and the CHECK
    would otherwise reject it with a database error rather than a useful message.
  */
  const merged = {
    expectedStartMinute: input.expectedStartMinute ?? before.expectedStartMinute,
    expectedEndMinute: input.expectedEndMinute ?? before.expectedEndMinute,
    fullDayMinutes: input.fullDayMinutes ?? before.fullDayMinutes,
    halfDayMinutes: input.halfDayMinutes ?? before.halfDayMinutes,
  };
  if (merged.expectedEndMinute <= merged.expectedStartMinute) {
    throw AppError.badRequest(
      'INVALID_POLICY_HOURS',
      'The working day must end after it starts.',
    );
  }
  if (merged.fullDayMinutes <= merged.halfDayMinutes) {
    throw AppError.badRequest(
      'INVALID_POLICY_THRESHOLDS',
      'A full day must be longer than a half day.',
    );
  }

  await repo.updatePolicy(id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.expectedStartMinute === undefined
      ? {}
      : { expectedStartMinute: input.expectedStartMinute }),
    ...(input.expectedEndMinute === undefined ? {} : { expectedEndMinute: input.expectedEndMinute }),
    ...(input.graceMinutes === undefined ? {} : { graceMinutes: input.graceMinutes }),
    ...(input.fullDayMinutes === undefined ? {} : { fullDayMinutes: input.fullDayMinutes }),
    ...(input.halfDayMinutes === undefined ? {} : { halfDayMinutes: input.halfDayMinutes }),
    ...(input.overtimeThresholdMinutes === undefined
      ? {}
      : { overtimeThresholdMinutes: input.overtimeThresholdMinutes }),
    ...(input.weekOffDays === undefined ? {} : { weekOffDays: input.weekOffDays }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  });

  await recordAudit(req, {
    action: 'HR_ATTENDANCE_POLICY_UPDATED',
    entityType: 'AttendancePolicy',
    entityId: id,
    actorId: actor.id,
    oldValue: {
      expectedStartMinute: before.expectedStartMinute,
      expectedEndMinute: before.expectedEndMinute,
      weekOffDays: before.weekOffDays,
    },
    newValue: { ...merged, weekOffDays: input.weekOffDays ?? before.weekOffDays },
  });

  const record = await repo.findPolicy(id);
  if (!record) throw AppError.notFound('POLICY_NOT_FOUND', 'That policy could not be found.');
  return toPolicyView(record);
}
