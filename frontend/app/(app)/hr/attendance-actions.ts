'use server';

import { revalidatePath } from 'next/cache';
import type {
  AdjustLeaveBalanceInput,
  AllocateLeaveInput,
  AttendanceCorrectionView,
  AttendanceDetail,
  AttendancePolicyView,
  CreateAttendanceCorrectionInput,
  CreateAttendancePolicyInput,
  CreateHolidayInput,
  CreateLeavePolicyInput,
  CreateLeaveRequestInput,
  CreateLeaveTypeInput,
  HolidayView,
  LeaveBalanceView,
  LeavePolicyView,
  LeaveRequestDetail,
  LeaveTypeView,
  OvertimeView,
  UpdateAttendancePolicyInput,
  UpdateHolidayInput,
  UpdateLeavePolicyInput,
  UpdateLeaveTypeInput,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * HR Phase 2 mutations, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches
 * the bearer and calls Express. Nothing decides a business outcome — each action
 * forwards the request and relays the backend's answer verbatim, so the API
 * remains the only authority on the session state machine, the leave-day
 * calculation, the balance arithmetic and the permission behind every write.
 *
 * In particular:
 *
 *   - **No action sends a timestamp.** Clock-in and clock-out take the moment from
 *     Postgres. A browser clock can be wrong by hours or set deliberately, and
 *     attendance is exactly the feature somebody would try that on — so there is
 *     no field here to try it with.
 *   - **No action computes days.** The leave form reads its figure from the
 *     server's preview endpoint, which uses the same calculator the eventual
 *     charge does.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

async function call<T>(
  path: string,
  init: RequestInit,
  revalidate?: string[],
): Promise<ActionResult<T>> {
  const result = await apiFetch<T>(path, init);

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  for (const path of revalidate ?? []) revalidatePath(path);
  return { ok: true, data: result.data };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * The attendance page and the HR landing, always.
 *
 * Today's state, the board and the overview counts all derive from the rows these
 * writes touch, so a clock-in has to change every screen that shows it — not only
 * the one the person is looking at.
 */
const ATTENDANCE_PATHS = ['/hr/attendance', '/hr'];
const LEAVE_PATHS = ['/hr/leave', '/hr'];

// ---------------------------------------------------------------------------
//  Attendance self service
// ---------------------------------------------------------------------------

export async function clockInAction(
  workMode?: string,
): Promise<ActionResult<{ attendance: AttendanceDetail }>> {
  // No timestamp: the server takes the moment from Postgres.
  return call<{ attendance: AttendanceDetail }>(
    '/api/hr/attendance/clock-in',
    json('POST', workMode ? { workMode } : {}),
    ATTENDANCE_PATHS,
  );
}

export async function clockOutAction(
  remarks?: string,
): Promise<ActionResult<{ attendance: AttendanceDetail }>> {
  return call<{ attendance: AttendanceDetail }>(
    '/api/hr/attendance/clock-out',
    json('POST', remarks ? { remarks } : {}),
    ATTENDANCE_PATHS,
  );
}

export async function startBreakAction(): Promise<ActionResult<{ attendance: AttendanceDetail }>> {
  return call<{ attendance: AttendanceDetail }>(
    '/api/hr/attendance/break/start',
    json('POST', {}),
    ATTENDANCE_PATHS,
  );
}

export async function endBreakAction(): Promise<ActionResult<{ attendance: AttendanceDetail }>> {
  return call<{ attendance: AttendanceDetail }>(
    '/api/hr/attendance/break/end',
    json('POST', {}),
    ATTENDANCE_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

export async function requestCorrectionAction(
  input: CreateAttendanceCorrectionInput,
): Promise<ActionResult<{ correction: AttendanceCorrectionView }>> {
  return call<{ correction: AttendanceCorrectionView }>(
    '/api/hr/attendance/corrections',
    json('POST', input),
    ATTENDANCE_PATHS,
  );
}

/**
 * Deciding a correction.
 *
 * `note` is required by the API when rejecting, and the form enforces it too —
 * two checks for one rule, because being told "say why" before submitting is
 * kinder than being told afterwards. The API's is the one that decides.
 */
export async function decideCorrectionAction(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  note?: string,
): Promise<ActionResult<{ correction: AttendanceCorrectionView }>> {
  return call<{ correction: AttendanceCorrectionView }>(
    `/api/hr/attendance/corrections/${id}/decide`,
    json('POST', { decision, ...(note ? { note } : {}) }),
    ATTENDANCE_PATHS,
  );
}

export async function decideOvertimeAction(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  note?: string,
): Promise<ActionResult<{ overtime: OvertimeView }>> {
  return call<{ overtime: OvertimeView }>(
    `/api/hr/attendance/overtime/${id}/decide`,
    json('POST', { decision, ...(note ? { note } : {}) }),
    ATTENDANCE_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Leave
// ---------------------------------------------------------------------------

export async function applyForLeaveAction(
  input: CreateLeaveRequestInput,
): Promise<ActionResult<{ request: LeaveRequestDetail }>> {
  return call<{ request: LeaveRequestDetail }>(
    '/api/hr/leave/requests',
    json('POST', input),
    LEAVE_PATHS,
  );
}

export async function decideLeaveAction(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  note?: string,
): Promise<ActionResult<{ request: LeaveRequestDetail }>> {
  return call<{ request: LeaveRequestDetail }>(
    `/api/hr/leave/requests/${id}/decide`,
    json('POST', { decision, ...(note ? { note } : {}) }),
    LEAVE_PATHS,
  );
}

export async function cancelLeaveAction(
  id: string,
  note?: string,
): Promise<ActionResult<{ request: LeaveRequestDetail }>> {
  return call<{ request: LeaveRequestDetail }>(
    `/api/hr/leave/requests/${id}/cancel`,
    json('POST', note ? { note } : {}),
    LEAVE_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Configuration — HR_ADMIN / HR_LEAVE:EDIT, enforced by the API
// ---------------------------------------------------------------------------

export async function createHolidayAction(
  input: CreateHolidayInput,
): Promise<ActionResult<{ holiday: HolidayView }>> {
  return call<{ holiday: HolidayView }>('/api/hr/holidays', json('POST', input), [
    '/hr/attendance/settings',
    ...ATTENDANCE_PATHS,
  ]);
}

export async function updateHolidayAction(
  id: string,
  input: UpdateHolidayInput,
): Promise<ActionResult<{ holiday: HolidayView }>> {
  return call<{ holiday: HolidayView }>(`/api/hr/holidays/${id}`, json('PATCH', input), [
    '/hr/attendance/settings',
    ...ATTENDANCE_PATHS,
  ]);
}

export async function createAttendancePolicyAction(
  input: CreateAttendancePolicyInput,
): Promise<ActionResult<{ policy: AttendancePolicyView }>> {
  return call<{ policy: AttendancePolicyView }>(
    '/api/hr/attendance-policies',
    json('POST', input),
    ['/hr/attendance/settings', ...ATTENDANCE_PATHS],
  );
}

export async function updateAttendancePolicyAction(
  id: string,
  input: UpdateAttendancePolicyInput,
): Promise<ActionResult<{ policy: AttendancePolicyView }>> {
  return call<{ policy: AttendancePolicyView }>(
    `/api/hr/attendance-policies/${id}`,
    json('PATCH', input),
    ['/hr/attendance/settings', ...ATTENDANCE_PATHS],
  );
}

export async function createLeaveTypeAction(
  input: CreateLeaveTypeInput,
): Promise<ActionResult<{ leaveType: LeaveTypeView }>> {
  return call<{ leaveType: LeaveTypeView }>('/api/hr/leave-types', json('POST', input), [
    '/hr/leave/settings',
    ...LEAVE_PATHS,
  ]);
}

export async function updateLeaveTypeAction(
  id: string,
  input: UpdateLeaveTypeInput,
): Promise<ActionResult<{ leaveType: LeaveTypeView }>> {
  return call<{ leaveType: LeaveTypeView }>(`/api/hr/leave-types/${id}`, json('PATCH', input), [
    '/hr/leave/settings',
    ...LEAVE_PATHS,
  ]);
}

export async function createLeavePolicyAction(
  input: CreateLeavePolicyInput,
): Promise<ActionResult<{ policy: LeavePolicyView }>> {
  return call<{ policy: LeavePolicyView }>('/api/hr/leave-policies', json('POST', input), [
    '/hr/leave/settings',
    ...LEAVE_PATHS,
  ]);
}

export async function updateLeavePolicyAction(
  id: string,
  input: UpdateLeavePolicyInput,
): Promise<ActionResult<{ policy: LeavePolicyView }>> {
  return call<{ policy: LeavePolicyView }>(`/api/hr/leave-policies/${id}`, json('PATCH', input), [
    '/hr/leave/settings',
    ...LEAVE_PATHS,
  ]);
}

export async function allocateLeaveAction(
  input: AllocateLeaveInput,
): Promise<ActionResult<{ balances: LeaveBalanceView[] }>> {
  return call<{ balances: LeaveBalanceView[] }>(
    '/api/hr/leave/balances/allocate',
    json('POST', input),
    LEAVE_PATHS,
  );
}

export async function adjustLeaveBalanceAction(
  input: AdjustLeaveBalanceInput,
): Promise<ActionResult<{ balances: LeaveBalanceView[] }>> {
  return call<{ balances: LeaveBalanceView[] }>(
    '/api/hr/leave/balances/adjust',
    json('POST', input),
    LEAVE_PATHS,
  );
}
