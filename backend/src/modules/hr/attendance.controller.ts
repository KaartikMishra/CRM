/**
 * HTTP translation for HR Phase 2 — Attendance and Leave.
 *
 * No business rule, no permission decision, no try/catch: the route table states
 * who may call what, the services decide, and the async error handler reports
 * failures. Matching every other controller in this codebase.
 */

import type { Request, Response } from 'express';
import type {
  AdjustLeaveBalanceInput,
  AllocateLeaveInput,
  AttendanceCorrectionListQuery,
  AttendanceListQuery,
  AttendanceSummaryQuery,
  CancelLeaveRequestInput,
  ClockInInput,
  ClockOutInput,
  CreateAttendanceCorrectionInput,
  CreateAttendancePolicyInput,
  CreateHolidayInput,
  CreateLeavePolicyInput,
  CreateLeaveRequestInput,
  CreateLeaveTypeInput,
  DecideAttendanceCorrectionInput,
  DecideLeaveRequestInput,
  DecideOvertimeInput,
  HolidayListQuery,
  LeaveBalanceQuery,
  LeaveDayPreviewInput,
  LeaveRequestListQuery,
  LeaveTypeListQuery,
  OvertimeListQuery,
  UpdateAttendancePolicyInput,
  UpdateHolidayInput,
  UpdateLeavePolicyInput,
  UpdateLeaveTypeInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { hrActor } from './hr.service.js';
import * as attendance from './attendance.service.js';
import * as leave from './leave.service.js';

type IdParam = { id: string };

/**
 * The acting person's HR capabilities, resolved once per request.
 *
 * Reused from Phase 1 rather than reimplemented, which is what keeps one
 * permission resolution for the whole HR module.
 */
const actor = (req: Request) => hrActor(currentUser(req));

// ---------------------------------------------------------------------------
//  Attendance — self service
// ---------------------------------------------------------------------------

export async function today(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { today: await attendance.today(await actor(req)) });
}

export async function clockIn(req: Request, res: Response): Promise<void> {
  const record = await attendance.clockIn(req, await actor(req), validatedBody<ClockInInput>(req));
  sendCreated(res, { attendance: record });
}

export async function clockOut(req: Request, res: Response): Promise<void> {
  const record = await attendance.clockOut(
    req,
    await actor(req),
    validatedBody<ClockOutInput>(req),
  );
  sendSuccess(res, { attendance: record });
}

export async function startBreak(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { attendance: await attendance.startBreak(req, await actor(req)) });
}

export async function endBreak(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { attendance: await attendance.endBreak(req, await actor(req)) });
}

// ---------------------------------------------------------------------------
//  Attendance — reads
// ---------------------------------------------------------------------------

export async function listAttendance(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await attendance.listAttendance(await actor(req), validatedQuery<AttendanceListQuery>(req)),
  );
}

export async function getAttendance(req: Request, res: Response): Promise<void> {
  const record = await attendance.getAttendance(await actor(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { attendance: record });
}

export async function summary(req: Request, res: Response): Promise<void> {
  sendSuccess(res, {
    summary: await attendance.summary(
      await actor(req),
      validatedQuery<AttendanceSummaryQuery>(req),
    ),
  });
}

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

export async function createCorrection(req: Request, res: Response): Promise<void> {
  const correction = await attendance.createCorrection(
    req,
    await actor(req),
    validatedBody<CreateAttendanceCorrectionInput>(req),
  );
  sendCreated(res, { correction });
}

export async function listCorrections(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await attendance.listCorrections(
      await actor(req),
      validatedQuery<AttendanceCorrectionListQuery>(req),
    ),
  );
}

export async function decideCorrection(req: Request, res: Response): Promise<void> {
  const correction = await attendance.decideCorrection(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<DecideAttendanceCorrectionInput>(req),
  );
  sendSuccess(res, { correction });
}

// ---------------------------------------------------------------------------
//  Overtime
// ---------------------------------------------------------------------------

export async function listOvertime(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await attendance.listOvertime(await actor(req), validatedQuery<OvertimeListQuery>(req)),
  );
}

export async function decideOvertime(req: Request, res: Response): Promise<void> {
  const overtime = await attendance.decideOvertime(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<DecideOvertimeInput>(req),
  );
  sendSuccess(res, { overtime });
}

// ---------------------------------------------------------------------------
//  Holidays and attendance policies
// ---------------------------------------------------------------------------

export async function listHolidays(req: Request, res: Response): Promise<void> {
  sendSuccess(res, {
    holidays: await attendance.listHolidays(validatedQuery<HolidayListQuery>(req)),
  });
}

export async function createHoliday(req: Request, res: Response): Promise<void> {
  const holiday = await attendance.createHoliday(
    req,
    await actor(req),
    validatedBody<CreateHolidayInput>(req),
  );
  sendCreated(res, { holiday });
}

export async function updateHoliday(req: Request, res: Response): Promise<void> {
  const holiday = await attendance.updateHoliday(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateHolidayInput>(req),
  );
  sendSuccess(res, { holiday });
}

export async function listPolicies(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, { policies: await attendance.listPolicies() });
}

export async function createPolicy(req: Request, res: Response): Promise<void> {
  const policy = await attendance.createPolicy(
    req,
    await actor(req),
    validatedBody<CreateAttendancePolicyInput>(req),
  );
  sendCreated(res, { policy });
}

export async function updatePolicy(req: Request, res: Response): Promise<void> {
  const policy = await attendance.updatePolicy(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateAttendancePolicyInput>(req),
  );
  sendSuccess(res, { policy });
}

// ---------------------------------------------------------------------------
//  Leave types and policies
// ---------------------------------------------------------------------------

export async function listLeaveTypes(req: Request, res: Response): Promise<void> {
  sendSuccess(res, {
    leaveTypes: await leave.listLeaveTypes(validatedQuery<LeaveTypeListQuery>(req)),
  });
}

export async function createLeaveType(req: Request, res: Response): Promise<void> {
  const leaveType = await leave.createLeaveType(
    req,
    await actor(req),
    validatedBody<CreateLeaveTypeInput>(req),
  );
  sendCreated(res, { leaveType });
}

export async function updateLeaveType(req: Request, res: Response): Promise<void> {
  const leaveType = await leave.updateLeaveType(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateLeaveTypeInput>(req),
  );
  sendSuccess(res, { leaveType });
}

export async function listLeavePolicies(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { policies: await leave.listLeavePolicies(await actor(req)) });
}

export async function createLeavePolicy(req: Request, res: Response): Promise<void> {
  const policy = await leave.createLeavePolicy(
    req,
    await actor(req),
    validatedBody<CreateLeavePolicyInput>(req),
  );
  sendCreated(res, { policy });
}

export async function updateLeavePolicy(req: Request, res: Response): Promise<void> {
  const policy = await leave.updateLeavePolicy(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateLeavePolicyInput>(req),
  );
  sendSuccess(res, { policy });
}

// ---------------------------------------------------------------------------
//  Balances
// ---------------------------------------------------------------------------

export async function listBalances(req: Request, res: Response): Promise<void> {
  sendSuccess(res, {
    balances: await leave.listBalances(await actor(req), validatedQuery<LeaveBalanceQuery>(req)),
  });
}

export async function allocateEntitlement(req: Request, res: Response): Promise<void> {
  const balances = await leave.allocateEntitlement(
    req,
    await actor(req),
    validatedBody<AllocateLeaveInput>(req),
  );
  sendSuccess(res, { balances });
}

export async function carryForward(req: Request, res: Response): Promise<void> {
  const balances = await leave.carryForward(
    req,
    await actor(req),
    validatedBody<AllocateLeaveInput>(req),
  );
  sendSuccess(res, { balances });
}

export async function adjustBalance(req: Request, res: Response): Promise<void> {
  const balances = await leave.adjustBalance(
    req,
    await actor(req),
    validatedBody<AdjustLeaveBalanceInput>(req),
  );
  sendSuccess(res, { balances });
}

// ---------------------------------------------------------------------------
//  Leave requests
// ---------------------------------------------------------------------------

export async function previewLeaveDays(req: Request, res: Response): Promise<void> {
  sendSuccess(res, {
    preview: await leave.previewDays(await actor(req), validatedQuery<LeaveDayPreviewInput>(req)),
  });
}

export async function applyForLeave(req: Request, res: Response): Promise<void> {
  const request = await leave.applyForLeave(
    req,
    await actor(req),
    validatedBody<CreateLeaveRequestInput>(req),
  );
  sendCreated(res, { request });
}

export async function listLeaveRequests(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await leave.listLeaveRequests(await actor(req), validatedQuery<LeaveRequestListQuery>(req)),
  );
}

export async function getLeaveRequest(req: Request, res: Response): Promise<void> {
  const request = await leave.getLeaveRequest(await actor(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { request });
}

export async function decideLeave(req: Request, res: Response): Promise<void> {
  const request = await leave.decideLeave(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<DecideLeaveRequestInput>(req),
  );
  sendSuccess(res, { request });
}

export async function cancelLeave(req: Request, res: Response): Promise<void> {
  const request = await leave.cancelLeave(
    req,
    await actor(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CancelLeaveRequestInput>(req),
  );
  sendSuccess(res, { request });
}
