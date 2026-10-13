import type {
  AttendanceCorrectionPage,
  AttendanceDetail,
  AttendancePage,
  AttendancePolicyView,
  AttendanceSummary,
  AttendanceToday,
  HolidayView,
  LeaveBalanceView,
  LeaveDayPreview,
  LeavePolicyView,
  LeaveRequestDetail,
  LeaveRequestPage,
  LeaveTypeView,
  OvertimePage,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the HR Phase 2 API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the
 * backend changes a contract this file stops compiling. Mirrors lib/hr-api.ts.
 *
 * Nothing here computes a business figure. Worked minutes, late minutes, leave
 * day counts, available balance and the permitted next actions are all derived
 * server-side from rows the same request already read — a second calculation in
 * the browser would be a second answer, and for attendance it would be a second
 * answer about somebody's pay.
 *
 * Note what is absent: any writer. Mutations go through server actions in
 * `app/(app)/hr/attendance-actions.ts`, so the session token never reaches the
 * browser.
 */

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  return search.toString();
};

// ---------------------------------------------------------------------------
//  Attendance
// ---------------------------------------------------------------------------

/** The employee's own day: state, policy and what they may do next. */
export async function fetchAttendanceToday(): Promise<ApiResult<{ today: AttendanceToday }>> {
  return apiFetch<{ today: AttendanceToday }>('/api/hr/attendance/today');
}

export async function fetchAttendance(
  params: Record<string, string | undefined>,
): Promise<ApiResult<AttendancePage>> {
  return apiFetch<AttendancePage>(`/api/hr/attendance?${query(params)}`);
}

export async function fetchAttendanceRecord(
  id: string,
): Promise<ApiResult<{ attendance: AttendanceDetail }>> {
  return apiFetch<{ attendance: AttendanceDetail }>(`/api/hr/attendance/${id}`);
}

export async function fetchAttendanceSummary(
  params: { from: string; to: string; employeeId?: string },
): Promise<ApiResult<{ summary: AttendanceSummary }>> {
  return apiFetch<{ summary: AttendanceSummary }>(`/api/hr/attendance/summary?${query(params)}`);
}

export async function fetchCorrections(
  params: Record<string, string | undefined>,
): Promise<ApiResult<AttendanceCorrectionPage>> {
  return apiFetch<AttendanceCorrectionPage>(`/api/hr/attendance/corrections?${query(params)}`);
}

export async function fetchOvertime(
  params: Record<string, string | undefined>,
): Promise<ApiResult<OvertimePage>> {
  return apiFetch<OvertimePage>(`/api/hr/attendance/overtime?${query(params)}`);
}

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------

export async function fetchHolidays(
  params: Record<string, string | undefined> = {},
): Promise<ApiResult<{ holidays: HolidayView[] }>> {
  return apiFetch<{ holidays: HolidayView[] }>(`/api/hr/holidays?${query(params)}`);
}

export async function fetchAttendancePolicies(): Promise<
  ApiResult<{ policies: AttendancePolicyView[] }>
> {
  return apiFetch<{ policies: AttendancePolicyView[] }>('/api/hr/attendance-policies');
}

// ---------------------------------------------------------------------------
//  Leave
// ---------------------------------------------------------------------------

export async function fetchLeaveTypes(
  params: Record<string, string | undefined> = {},
): Promise<ApiResult<{ leaveTypes: LeaveTypeView[] }>> {
  return apiFetch<{ leaveTypes: LeaveTypeView[] }>(`/api/hr/leave-types?${query(params)}`);
}

export async function fetchLeavePolicies(): Promise<ApiResult<{ policies: LeavePolicyView[] }>> {
  return apiFetch<{ policies: LeavePolicyView[] }>('/api/hr/leave-policies');
}

/** The acting person's balances, or somebody else's where they are in scope. */
export async function fetchLeaveBalances(
  params: Record<string, string | undefined> = {},
): Promise<ApiResult<{ balances: LeaveBalanceView[] }>> {
  return apiFetch<{ balances: LeaveBalanceView[] }>(`/api/hr/leave/balances?${query(params)}`);
}

export async function fetchLeaveRequests(
  params: Record<string, string | undefined>,
): Promise<ApiResult<LeaveRequestPage>> {
  return apiFetch<LeaveRequestPage>(`/api/hr/leave/requests?${query(params)}`);
}

export async function fetchLeaveRequest(
  id: string,
): Promise<ApiResult<{ request: LeaveRequestDetail }>> {
  return apiFetch<{ request: LeaveRequestDetail }>(`/api/hr/leave/requests/${id}`);
}

/**
 * What a date range would cost, before applying.
 *
 * Read from the server rather than computed here, which is the whole point of the
 * shared calculator: the preview and the eventual charge come from one place, so
 * the form cannot promise two days and the balance take three.
 */
export async function fetchLeaveDayPreview(
  params: { startDate: string; endDate: string; isHalfDay?: string },
): Promise<ApiResult<{ preview: LeaveDayPreview }>> {
  return apiFetch<{ preview: LeaveDayPreview }>(`/api/hr/leave/preview?${query(params)}`);
}
