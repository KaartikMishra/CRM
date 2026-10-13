/**
 * The route table for HR Phase 2 — Attendance and Leave.
 *
 * Mounted under the existing `/api/hr` router, so Phase 1's paths are untouched
 * and the module stays one namespace.
 *
 * ### No new permission vocabulary
 *
 * Every namespace and action below already exists: HR_ATTENDANCE, HR_LEAVE and
 * HR_ADMIN from Phase 0.5, and the actions from the original five plus APPROVE.
 * USER holds nothing on any of them by default, so a plain employee reaches the
 * *management* routes only once an administrator grants it.
 *
 * ### The one thing worth reading closely: self-service has no permission
 *
 * Clock-in, clock-out, breaks, applying for leave, raising a correction and
 * reading one's own balance carry **`requireAuth` only**. That is deliberate and
 * is the difference between a workable module and an unusable one: if clocking in
 * needed `HR_ATTENDANCE:CREATE`, every employee in the company would need an HR
 * grant, and the grant would stop meaning anything.
 *
 * What protects these routes instead is *scope*, in the service: each one acts on
 * the acting person's own Employee record and nothing else. There is no endpoint
 * anywhere that clocks somebody else in — by any permission — because that is
 * attendance fraud with extra steps. HR amends a day through the correction
 * workflow, which records who decided and why.
 *
 * The brief's examples (USER A with `HR_ATTENDANCE:VIEW`, USER B also CREATE) are
 * about *other people's* records, and those routes are gated accordingly.
 *
 * ### How the actions divide
 *
 *   VIEW      other people's attendance, leave, balances, corrections, overtime
 *   CREATE    recording attendance for the team — reserved, unused in Phase 2
 *   EDIT      amending records; adjusting balances; configuring (HR_ADMIN)
 *   APPROVE   deciding somebody else's correction, leave or overtime
 *
 * Deciding is also reachable by being the requester's **manager**, which the
 * service checks — a reporting manager approves their own team without holding
 * any HR module. That is what makes the brief's hierarchy work.
 *
 * Literal paths are declared before any parameterised one, so `/today`,
 * `/corrections` and `/balances` are never read as record ids.
 */

import { Router } from 'express';
import {
  adjustLeaveBalanceSchema,
  allocateLeaveSchema,
  attendanceCorrectionListQuerySchema,
  attendanceListQuerySchema,
  attendanceParamSchema,
  attendancePolicyParamSchema,
  attendanceSummaryQuerySchema,
  breakActionSchema,
  cancelLeaveRequestSchema,
  clockInSchema,
  clockOutSchema,
  createAttendanceCorrectionSchema,
  createAttendancePolicySchema,
  createHolidaySchema,
  createLeavePolicySchema,
  createLeaveRequestSchema,
  createLeaveTypeSchema,
  decideAttendanceCorrectionSchema,
  decideLeaveRequestSchema,
  decideOvertimeSchema,
  holidayListQuerySchema,
  holidayParamSchema,
  leaveBalanceQuerySchema,
  leaveDayPreviewSchema,
  leavePolicyParamSchema,
  leaveRequestListQuerySchema,
  leaveRequestParamSchema,
  leaveTypeListQuerySchema,
  leaveTypeParamSchema,
  overtimeListQuerySchema,
  updateAttendancePolicySchema,
  updateHolidaySchema,
  updateLeavePolicySchema,
  updateLeaveTypeSchema,
} from '@rs/shared';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './attendance.controller.js';

/**
 * Phase 2's routes, mounted onto the Phase 1 HR router by `hr.routes.ts`.
 *
 * A separate Router rather than more lines in Phase 1's table: the two phases
 * have different permission namespaces and different reasoning, and one 500-line
 * route file would make neither readable.
 */
export const attendanceRoutes = Router();

// `requireAuth` is applied by the parent HR router, so every route here is
// already authenticated. Self-service routes add nothing further.

// ---------------------------------------------------------------------------
//  Attendance — self service (requireAuth only; see the note at the top)
// ---------------------------------------------------------------------------

/** The employee's own widget: today's state and what they may do next. */
attendanceRoutes.get('/attendance/today', controller.today);

attendanceRoutes.post(
  '/attendance/clock-in',
  validate({ body: clockInSchema }),
  controller.clockIn,
);

attendanceRoutes.post(
  '/attendance/clock-out',
  validate({ body: clockOutSchema }),
  controller.clockOut,
);

attendanceRoutes.post(
  '/attendance/break/start',
  validate({ body: breakActionSchema }),
  controller.startBreak,
);

attendanceRoutes.post(
  '/attendance/break/end',
  validate({ body: breakActionSchema }),
  controller.endBreak,
);

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

/** Raising one is self-service: it is a request about one's own day. */
attendanceRoutes.post(
  '/attendance/corrections',
  validate({ body: createAttendanceCorrectionSchema }),
  controller.createCorrection,
);

/**
 * Reading them.
 *
 * Scoped rather than permission-gated, like the attendance list: an employee sees
 * their own, a manager sees their team's, HR sees everybody's.
 */
attendanceRoutes.get(
  '/attendance/corrections',
  validate({ query: attendanceCorrectionListQuerySchema }),
  controller.listCorrections,
);

/**
 * Deciding one. APPROVE, or the requester's manager — checked in the service,
 * because being somebody's manager is a fact about employee rows rather than a
 * permission the route table can express.
 */
attendanceRoutes.post(
  '/attendance/corrections/:id/decide',
  validate({ params: attendanceParamSchema, body: decideAttendanceCorrectionSchema }),
  controller.decideCorrection,
);

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

attendanceRoutes.get(
  '/attendance/overtime',
  validate({ query: overtimeListQuerySchema }),
  controller.listOvertime,
);

attendanceRoutes.post(
  '/attendance/overtime/:id/decide',
  validate({ params: attendanceParamSchema, body: decideOvertimeSchema }),
  controller.decideOvertime,
);

// ---------------------------------------------------------------------------
//  Attendance — summary and board
// ---------------------------------------------------------------------------

attendanceRoutes.get(
  '/attendance/summary',
  validate({ query: attendanceSummaryQuerySchema }),
  controller.summary,
);

/**
 * The board.
 *
 * Scoped, not gated: a manager with no HR permission still needs their team's
 * attendance, and somebody with neither permission nor reports gets their own
 * rows. The service's filter is what narrows it.
 */
attendanceRoutes.get(
  '/attendance',
  validate({ query: attendanceListQuerySchema }),
  controller.listAttendance,
);

attendanceRoutes.get(
  '/attendance/:id',
  validate({ params: attendanceParamSchema }),
  controller.getAttendance,
);

// ---------------------------------------------------------------------------
//  Holidays — readable by everyone, configurable by HR_ADMIN
// ---------------------------------------------------------------------------

/**
 * Reading holidays is open to any authenticated employee, deliberately: knowing
 * when the office is closed is not confidential, and the leave form needs it to
 * explain why a range costs fewer days than it spans.
 */
attendanceRoutes.get(
  '/holidays',
  validate({ query: holidayListQuerySchema }),
  controller.listHolidays,
);

attendanceRoutes.post(
  '/holidays',
  requirePermission('HR_ADMIN', 'CREATE'),
  validate({ body: createHolidaySchema }),
  controller.createHoliday,
);

attendanceRoutes.patch(
  '/holidays/:id',
  requirePermission('HR_ADMIN', 'EDIT'),
  validate({ params: holidayParamSchema, body: updateHolidaySchema }),
  controller.updateHoliday,
);

// ---------------------------------------------------------------------------
//  Attendance policies — HR_ADMIN, because the working week is structural
// ---------------------------------------------------------------------------

attendanceRoutes.get(
  '/attendance-policies',
  requireAnyPermission(['HR_ADMIN', 'VIEW'], ['HR_ATTENDANCE', 'VIEW']),
  controller.listPolicies,
);

attendanceRoutes.post(
  '/attendance-policies',
  requirePermission('HR_ADMIN', 'CREATE'),
  validate({ body: createAttendancePolicySchema }),
  controller.createPolicy,
);

attendanceRoutes.patch(
  '/attendance-policies/:id',
  requirePermission('HR_ADMIN', 'EDIT'),
  validate({ params: attendancePolicyParamSchema, body: updateAttendancePolicySchema }),
  controller.updatePolicy,
);

// ---------------------------------------------------------------------------
//  Leave types and policies
// ---------------------------------------------------------------------------

/**
 * Leave types are readable by any authenticated employee: the apply form has to
 * offer them, and a list of leave types is not confidential. Their *policies* —
 * entitlements by department — are not, and are gated in the service.
 */
attendanceRoutes.get(
  '/leave-types',
  validate({ query: leaveTypeListQuerySchema }),
  controller.listLeaveTypes,
);

attendanceRoutes.post(
  '/leave-types',
  requirePermission('HR_ADMIN', 'CREATE'),
  validate({ body: createLeaveTypeSchema }),
  controller.createLeaveType,
);

attendanceRoutes.patch(
  '/leave-types/:id',
  requirePermission('HR_ADMIN', 'EDIT'),
  validate({ params: leaveTypeParamSchema, body: updateLeaveTypeSchema }),
  controller.updateLeaveType,
);

attendanceRoutes.get('/leave-policies', controller.listLeavePolicies);

attendanceRoutes.post(
  '/leave-policies',
  requirePermission('HR_ADMIN', 'CREATE'),
  validate({ body: createLeavePolicySchema }),
  controller.createLeavePolicy,
);

attendanceRoutes.patch(
  '/leave-policies/:id',
  requirePermission('HR_ADMIN', 'EDIT'),
  validate({ params: leavePolicyParamSchema, body: updateLeavePolicySchema }),
  controller.updateLeavePolicy,
);

// ---------------------------------------------------------------------------
//  Balances
// ---------------------------------------------------------------------------

/**
 * Reading balances.
 *
 * Self-service by default — an employee reads their own without any grant — and
 * scoped when asking about somebody else.
 */
attendanceRoutes.get(
  '/leave/balances',
  validate({ query: leaveBalanceQuerySchema }),
  controller.listBalances,
);

/**
 * Moving a balance by hand. HR_LEAVE:EDIT, deliberately not APPROVE.
 *
 * Approving is deciding a request within the rules; allocating, carrying forward
 * and adjusting are overriding them, and they are the only leave operations with
 * no request behind them. Keeping them on EDIT means an approver who only decides
 * requests cannot quietly grant themselves days.
 */
attendanceRoutes.post(
  '/leave/balances/allocate',
  requirePermission('HR_LEAVE', 'EDIT'),
  validate({ body: allocateLeaveSchema }),
  controller.allocateEntitlement,
);

attendanceRoutes.post(
  '/leave/balances/carry-forward',
  requirePermission('HR_LEAVE', 'EDIT'),
  validate({ body: allocateLeaveSchema }),
  controller.carryForward,
);

attendanceRoutes.post(
  '/leave/balances/adjust',
  requirePermission('HR_LEAVE', 'EDIT'),
  validate({ body: adjustLeaveBalanceSchema }),
  controller.adjustBalance,
);

// ---------------------------------------------------------------------------
//  Leave requests
// ---------------------------------------------------------------------------

/** What a range would cost, before applying. Self-service. */
attendanceRoutes.get(
  '/leave/preview',
  validate({ query: leaveDayPreviewSchema }),
  controller.previewLeaveDays,
);

/** Applying is self-service: it is one's own leave. */
attendanceRoutes.post(
  '/leave/requests',
  validate({ body: createLeaveRequestSchema }),
  controller.applyForLeave,
);

attendanceRoutes.get(
  '/leave/requests',
  validate({ query: leaveRequestListQuerySchema }),
  controller.listLeaveRequests,
);

attendanceRoutes.get(
  '/leave/requests/:id',
  validate({ params: leaveRequestParamSchema }),
  controller.getLeaveRequest,
);

/** Deciding. APPROVE or the requester's manager — checked in the service. */
attendanceRoutes.post(
  '/leave/requests/:id/decide',
  validate({ params: leaveRequestParamSchema, body: decideLeaveRequestSchema }),
  controller.decideLeave,
);

/**
 * Cancelling.
 *
 * Self-service for one's own request, and the service decides which path applies:
 * a PENDING request is withdrawn by its author, an APPROVED future-dated one is
 * cancelled by its author or by HR_LEAVE:EDIT, and a leave that has already
 * started is refused with a pointer to the correction workflow.
 */
attendanceRoutes.post(
  '/leave/requests/:id/cancel',
  validate({ params: leaveRequestParamSchema, body: cancelLeaveRequestSchema }),
  controller.cancelLeave,
);
