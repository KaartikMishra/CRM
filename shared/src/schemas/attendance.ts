import { z } from 'zod';
import {
  ATTENDANCE_CORRECTION_STATUSES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_WORK_MODES,
  OVERTIME_STATUSES,
} from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for HR Phase 2 — Attendance.
 *
 * ### The rule that shapes every schema here
 *
 * **No timestamp is ever accepted for a clock-in or clock-out.** The server takes
 * the moment from Postgres `now()`. A browser clock can be wrong by hours or set
 * deliberately, and attendance is precisely the feature somebody would try that
 * on — accepting `clockInAt` from a body would make the whole module
 * unauditable. `clockIn` and `clockOut` below therefore take no time at all.
 *
 * The one exception is a **correction request**, which must name the times being
 * asked for. That is safe because it is a *request*: somebody else reviews it,
 * the decision is recorded, and the attendance row is stamped CORRECTION so a
 * future Payroll phase can tell it from a self-recorded day.
 *
 * Also never accepted: `status`, `workedMinutes`, `lateMinutes` and the rest.
 * Status is decided by the resolution service; the minutes are computed at
 * clock-out against the policy in force then.
 */

/** A calendar day, `YYYY-MM-DD`. Coerced so a form string and a Date both work. */
const dateSchema = z.coerce.date();

/** Minutes from midnight, 0–1439. How a policy states a wall-clock time. */
const minuteOfDaySchema = z.coerce
  .number()
  .int()
  .min(0, 'A time of day cannot be negative')
  .max(1439, 'A time of day must be within the day');

// ---------------------------------------------------------------------------
//  Clocking
// ---------------------------------------------------------------------------

/**
 * Clocking in.
 *
 * Takes only where the person is working. Everything else — the moment, the
 * date, the status — is the server's to decide.
 */
export const clockInSchema = z.object({
  workMode: z.enum(ATTENDANCE_WORK_MODES).optional(),
  remarks: z.string().trim().max(500, 'Keep remarks under 500 characters').optional(),
});

/** Clocking out. Takes nothing but an optional note. */
export const clockOutSchema = z.object({
  remarks: z.string().trim().max(500, 'Keep remarks under 500 characters').optional(),
});

/** Starting and ending a break. Neither takes a time. */
export const breakActionSchema = z.object({});

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

/**
 * Asking for a day to be corrected.
 *
 * At least one of the three requested values must be present — a correction that
 * asks for nothing is not a correction, which a CHECK enforces as well. The
 * reason is required: a request nobody explained is one nobody can review.
 */
export const createAttendanceCorrectionSchema = z
  .object({
    attendanceDate: dateSchema,
    requestedClockInAt: z.coerce.date().optional(),
    requestedClockOutAt: z.coerce.date().optional(),
    requestedWorkMode: z.enum(ATTENDANCE_WORK_MODES).optional(),
    reason: z
      .string()
      .trim()
      .min(5, 'Say what needs correcting and why')
      .max(1000, 'Keep the reason under 1000 characters'),
  })
  .refine(
    (v) =>
      v.requestedClockInAt !== undefined ||
      v.requestedClockOutAt !== undefined ||
      v.requestedWorkMode !== undefined,
    { message: 'Ask for at least one change', path: ['requestedClockInAt'] },
  )
  .refine(
    (v) =>
      v.requestedClockInAt === undefined ||
      v.requestedClockOutAt === undefined ||
      v.requestedClockOutAt >= v.requestedClockInAt,
    { message: 'Clock-out cannot be before clock-in', path: ['requestedClockOutAt'] },
  );

/**
 * Deciding one.
 *
 * APPROVED or REJECTED only — cancelling is the requester's act and has its own
 * endpoint, so an approver cannot cancel somebody's request and have the trail
 * read as though they withdrew it themselves. A rejection must say why.
 */
export const decideAttendanceCorrectionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED'], {
      errorMap: () => ({ message: 'Choose whether to approve or reject' }),
    }),
    note: z.string().trim().max(1000, 'Keep the note under 1000 characters').optional(),
  })
  .refine((v) => v.decision !== 'REJECTED' || (v.note?.length ?? 0) > 0, {
    message: 'Say why this correction is being rejected',
    path: ['note'],
  });

export const cancelAttendanceCorrectionSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
//  Reads
// ---------------------------------------------------------------------------

/**
 * The attendance board.
 *
 * `employeeId` doubles as the "one person's month" view, which is why there is no
 * separate scope parameter: an employee asking for their own attendance makes the
 * same query an HR administrator makes about somebody else's, and the row-level
 * scope decides what comes back.
 */
export const attendanceListQuerySchema = paginationSchema.extend({
  employeeId: cuidSchema.optional(),
  departmentId: cuidSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  workMode: z.enum(ATTENDANCE_WORK_MODES).optional(),
});

export const attendanceSummaryQuerySchema = z.object({
  employeeId: cuidSchema.optional(),
  from: dateSchema,
  to: dateSchema,
});

export const attendanceCorrectionListQuerySchema = paginationSchema.extend({
  employeeId: cuidSchema.optional(),
  status: z.enum(ATTENDANCE_CORRECTION_STATUSES).optional(),
  /** The approver's queue: requests this person may actually decide. */
  mine: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Admin configuration
// ---------------------------------------------------------------------------

export const createHolidaySchema = z.object({
  name: z.string().trim().min(2, 'Name the holiday').max(120),
  holidayDate: dateSchema,
  description: z.string().trim().max(500).optional(),
  /** Null or absent means company-wide. */
  departmentId: cuidSchema.optional(),
});

export const updateHolidaySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const holidayListQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  departmentId: cuidSchema.optional(),
  isActive: z.coerce.boolean().optional(),
});

/**
 * The attendance policy.
 *
 * Expected hours are minutes-from-midnight rather than timestamps, because
 * "09:30" is a wall-clock rule that applies every day — storing it as a Date
 * would attach it to one particular day.
 */
export const createAttendancePolicySchema = z
  .object({
    name: z.string().trim().min(2, 'Name the policy').max(120),
    code: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, hyphens and underscores')
      .transform((v) => v.toUpperCase()),
    expectedStartMinute: minuteOfDaySchema.optional(),
    expectedEndMinute: z.coerce.number().int().min(1).max(1440).optional(),
    graceMinutes: z.coerce.number().int().min(0).max(240).optional(),
    fullDayMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    halfDayMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    overtimeThresholdMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    /** ISO weekdays: 1 = Monday … 7 = Sunday. Deliberately not assumed. */
    weekOffDays: z.array(z.coerce.number().int().min(1).max(7)).max(7).optional(),
    departmentId: cuidSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.expectedStartMinute === undefined ||
      v.expectedEndMinute === undefined ||
      v.expectedEndMinute > v.expectedStartMinute,
    { message: 'The working day must end after it starts', path: ['expectedEndMinute'] },
  )
  .refine(
    (v) =>
      v.fullDayMinutes === undefined ||
      v.halfDayMinutes === undefined ||
      v.fullDayMinutes > v.halfDayMinutes,
    { message: 'A full day must be longer than a half day', path: ['fullDayMinutes'] },
  );

export const updateAttendancePolicySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    expectedStartMinute: minuteOfDaySchema.optional(),
    expectedEndMinute: z.coerce.number().int().min(1).max(1440).optional(),
    graceMinutes: z.coerce.number().int().min(0).max(240).optional(),
    fullDayMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    halfDayMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    overtimeThresholdMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    weekOffDays: z.array(z.coerce.number().int().min(1).max(7)).max(7).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const decideOvertimeSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.decision !== 'REJECTED' || (v.note?.length ?? 0) > 0, {
    message: 'Say why this overtime is being rejected',
    path: ['note'],
  });

export const overtimeListQuerySchema = paginationSchema.extend({
  employeeId: cuidSchema.optional(),
  status: z.enum(OVERTIME_STATUSES).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
});

export const attendanceParamSchema = z.object({ id: cuidSchema });
export const holidayParamSchema = z.object({ id: cuidSchema });
export const attendancePolicyParamSchema = z.object({ id: cuidSchema });

export type ClockInInput = z.infer<typeof clockInSchema>;
export type ClockOutInput = z.infer<typeof clockOutSchema>;
export type CreateAttendanceCorrectionInput = z.infer<typeof createAttendanceCorrectionSchema>;
export type DecideAttendanceCorrectionInput = z.infer<typeof decideAttendanceCorrectionSchema>;
export type AttendanceListQuery = z.infer<typeof attendanceListQuerySchema>;
export type AttendanceSummaryQuery = z.infer<typeof attendanceSummaryQuerySchema>;
export type AttendanceCorrectionListQuery = z.infer<typeof attendanceCorrectionListQuerySchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;
export type HolidayListQuery = z.infer<typeof holidayListQuerySchema>;
export type CreateAttendancePolicyInput = z.infer<typeof createAttendancePolicySchema>;
export type UpdateAttendancePolicyInput = z.infer<typeof updateAttendancePolicySchema>;
export type DecideOvertimeInput = z.infer<typeof decideOvertimeSchema>;
export type OvertimeListQuery = z.infer<typeof overtimeListQuerySchema>;
