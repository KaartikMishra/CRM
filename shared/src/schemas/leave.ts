import { z } from 'zod';
import { HALF_DAY_PERIODS, LEAVE_REQUEST_STATUSES } from '../enums.js';
import { cuidSchema, paginationSchema } from './common.js';

/**
 * Contracts for HR Phase 2 — Leave.
 *
 * What these deliberately do NOT accept:
 *
 *   - **`requestedDays`.** Computed by the one shared calculator in
 *     `utils/leave-days.ts`, which knows the holidays and the week-off pattern.
 *     A client-supplied figure would let somebody book five days and be charged
 *     one, and the whole point of a single calculator is that the request, the
 *     reservation, the approval and the attendance resolution agree.
 *   - **`status`.** A new request is PENDING; it moves only through the decide
 *     and cancel endpoints, which write the balance and the ledger in the same
 *     transaction. Accepting it here would let a request be born APPROVED.
 *   - **`employeeId` on apply.** Taken from the authenticated session's employee
 *     record. Applying on somebody else's behalf is an HR action, and would need
 *     its own audited endpoint rather than a field.
 *   - **Any balance field.** Balances move only by ledger entry.
 */

const dateSchema = z.coerce.date();

/** Days, to one decimal place in practice — half days are the only fraction. */
const daysSchema = z.coerce
  .number()
  .min(0, 'Days cannot be negative')
  .max(999, 'That is more days than any policy allows');

const leaveCodeSchema = z
  .string()
  .trim()
  .min(2, 'A code needs at least two characters')
  .max(20, 'Keep the code under 20 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, hyphens and underscores only')
  // Uppercased on the way in, so "sick" and "SICK" cannot become two leave types
  // that read as one. The unique index sees two strings; a human sees one code.
  .transform((v) => v.toUpperCase());

// ---------------------------------------------------------------------------
//  Leave types
// ---------------------------------------------------------------------------

export const createLeaveTypeSchema = z.object({
  name: z.string().trim().min(2, 'Name the leave type').max(120),
  code: leaveCodeSchema,
  description: z.string().trim().max(500).optional(),
  /** Recorded for a future Payroll phase; Phase 2 computes no money from it. */
  isPaid: z.boolean().optional(),
  halfDayAllowed: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  accrualEnabled: z.boolean().optional(),
  carryForwardEnabled: z.boolean().optional(),
  /** Absent means unlimited, which is different from zero. */
  carryForwardLimit: daysSchema.optional(),
  /** Foundation only — the flag is stored and no payout is implemented. */
  encashmentAllowed: z.boolean().optional(),
});

/**
 * Amending one.
 *
 * `code` is absent on purpose: it is the stable identifier policies and balances
 * are reconciled against. Renaming is `name`; re-coding is a new type and
 * deactivating the old one, which keeps history honest.
 */
export const updateLeaveTypeSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isPaid: z.boolean().optional(),
    isActive: z.boolean().optional(),
    halfDayAllowed: z.boolean().optional(),
    approvalRequired: z.boolean().optional(),
    accrualEnabled: z.boolean().optional(),
    carryForwardEnabled: z.boolean().optional(),
    carryForwardLimit: daysSchema.nullable().optional(),
    encashmentAllowed: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

export const leaveTypeListQuerySchema = z.object({
  isActive: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
//  Leave policies
// ---------------------------------------------------------------------------

export const createLeavePolicySchema = z.object({
  leaveTypeId: cuidSchema,
  /** Absent means company-wide. */
  departmentId: cuidSchema.optional(),
  annualEntitlement: daysSchema,
  accrualPerPeriod: daysSchema.optional(),
  minNoticeDays: z.coerce.number().int().min(0).max(365).optional(),
  /** Absent means no limit. */
  maxConsecutiveDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const updateLeavePolicySchema = z
  .object({
    annualEntitlement: daysSchema.optional(),
    accrualPerPeriod: daysSchema.nullable().optional(),
    minNoticeDays: z.coerce.number().int().min(0).max(365).optional(),
    maxConsecutiveDays: z.coerce.number().int().min(1).max(365).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Change at least one field');

// ---------------------------------------------------------------------------
//  Leave requests
// ---------------------------------------------------------------------------

/**
 * Applying for leave.
 *
 * A half day is a single date and names which half — the database enforces the
 * same pairing. "Half a day off" spanning a week, or without saying which half,
 * cannot be rostered against.
 */
export const createLeaveRequestSchema = z
  .object({
    leaveTypeId: cuidSchema,
    startDate: dateSchema,
    endDate: dateSchema,
    isHalfDay: z.boolean().optional(),
    halfDayPeriod: z.enum(HALF_DAY_PERIODS).optional(),
    reason: z
      .string()
      .trim()
      .min(5, 'Say why you need the leave')
      .max(1000, 'Keep the reason under 1000 characters'),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  })
  .refine((v) => !v.isHalfDay || v.startDate.getTime() === v.endDate.getTime(), {
    message: 'A half day covers a single date',
    path: ['endDate'],
  })
  .refine((v) => !v.isHalfDay || v.halfDayPeriod !== undefined, {
    message: 'Say which half of the day',
    path: ['halfDayPeriod'],
  })
  .refine((v) => v.isHalfDay || v.halfDayPeriod === undefined, {
    message: 'A full-day request cannot name a half',
    path: ['halfDayPeriod'],
  });

/**
 * Deciding a request.
 *
 * APPROVED or REJECTED only. Cancelling is the requester's act with its own
 * endpoint, so an approver cannot cancel somebody's leave and have it read as a
 * withdrawal. A rejection must say why — "no" with no reason is the commonest
 * complaint about every approval system.
 */
export const decideLeaveRequestSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED'], {
      errorMap: () => ({ message: 'Choose whether to approve or reject' }),
    }),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.decision !== 'REJECTED' || (v.note?.length ?? 0) > 0, {
    message: 'Say why this leave is being rejected',
    path: ['note'],
  });

export const cancelLeaveRequestSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const leaveRequestListQuerySchema = paginationSchema.extend({
  employeeId: cuidSchema.optional(),
  leaveTypeId: cuidSchema.optional(),
  status: z.enum(LEAVE_REQUEST_STATUSES).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  /** The approver's queue: requests this person may actually decide. */
  mine: z.coerce.boolean().optional(),
});

/** Asking what a range would cost, before applying. */
export const leaveDayPreviewSchema = z
  .object({
    startDate: dateSchema,
    endDate: dateSchema,
    isHalfDay: z.coerce.boolean().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  });

// ---------------------------------------------------------------------------
//  Balances
// ---------------------------------------------------------------------------

export const leaveBalanceQuerySchema = z.object({
  employeeId: cuidSchema.optional(),
  periodYear: z.coerce.number().int().min(2000).max(2200).optional(),
});

/**
 * An HR correction to a balance.
 *
 * `days` is signed — a correction may remove as well as add — and a reason is
 * required because an unexplained adjustment is indistinguishable from a mistake.
 * Writes a ledger entry like every other movement, so the balance stays the sum
 * of its history rather than a number somebody edited.
 */
export const adjustLeaveBalanceSchema = z.object({
  employeeId: cuidSchema,
  leaveTypeId: cuidSchema,
  periodYear: z.coerce.number().int().min(2000).max(2200),
  days: z.coerce
    .number()
    .refine((v) => v !== 0, 'An adjustment of zero days changes nothing')
    .refine((v) => Math.abs(v) <= 999, 'That adjustment is implausibly large'),
  note: z
    .string()
    .trim()
    .min(5, 'Say why the balance is being adjusted')
    .max(500),
});

/** Allocating a period's entitlement, or running accrual for one employee. */
export const allocateLeaveSchema = z.object({
  employeeId: cuidSchema,
  leaveTypeId: cuidSchema,
  periodYear: z.coerce.number().int().min(2000).max(2200),
});

export const leaveRequestParamSchema = z.object({ id: cuidSchema });
export const leaveTypeParamSchema = z.object({ id: cuidSchema });
export const leavePolicyParamSchema = z.object({ id: cuidSchema });

export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;
export type LeaveTypeListQuery = z.infer<typeof leaveTypeListQuerySchema>;
export type CreateLeavePolicyInput = z.infer<typeof createLeavePolicySchema>;
export type UpdateLeavePolicyInput = z.infer<typeof updateLeavePolicySchema>;
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type DecideLeaveRequestInput = z.infer<typeof decideLeaveRequestSchema>;
export type CancelLeaveRequestInput = z.infer<typeof cancelLeaveRequestSchema>;
export type LeaveRequestListQuery = z.infer<typeof leaveRequestListQuerySchema>;
export type LeaveDayPreviewInput = z.infer<typeof leaveDayPreviewSchema>;
export type LeaveBalanceQuery = z.infer<typeof leaveBalanceQuerySchema>;
export type AdjustLeaveBalanceInput = z.infer<typeof adjustLeaveBalanceSchema>;
export type AllocateLeaveInput = z.infer<typeof allocateLeaveSchema>;
