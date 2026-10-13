import type {
  AttendanceCorrectionStatus,
  AttendanceSessionState,
  AttendanceSource,
  AttendanceStatus,
  AttendanceWorkMode,
  HalfDayPeriod,
  LeaveLedgerReason,
  LeaveRequestStatus,
  OvertimeStatus,
} from '../enums.js';
import type { EmployeeRef, OrgUnitRef } from './hr.js';

/**
 * The HR Phase 2 view contracts — what the API returns, shared by both tiers.
 *
 * Dates and instants both cross the wire as ISO strings. Typing them as `string`
 * is what stops a component calling `.getTime()` on something that is no longer a
 * Date, and the field names say which kind each is: `attendanceDate` is a
 * calendar day, `clockInAt` is a moment.
 *
 * Durations are whole minutes, named `*Minutes`, and formatted for display by
 * `formatMinutes` in @rs/shared — never by a component doing its own arithmetic,
 * which is how two screens come to disagree about the same number.
 */

export type AttendanceBreakView = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  minutes: number | null;
};

/** One row of the attendance board. */
export type AttendanceRow = {
  id: string;
  employee: EmployeeRef;
  department: OrgUnitRef | null;
  attendanceDate: string;
  status: AttendanceStatus;
  workMode: AttendanceWorkMode | null;
  sessionState: AttendanceSessionState;
  source: AttendanceSource;
  clockInAt: string | null;
  clockOutAt: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyExitMinutes: number;
  overtimeMinutes: number;
  remarks: string | null;
};

export type AttendancePage = {
  attendance: AttendanceRow[];
  nextCursor: string | null;
};

/** One day in full, including its breaks. */
export type AttendanceDetail = AttendanceRow & {
  breaks: AttendanceBreakView[];
  /** The leave covering this day, where one does. */
  leaveRequestId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * What the employee's own attendance widget needs.
 *
 * `canClockIn` and the rest are derived server-side from the session state and
 * the day's resolution. The browser does not decide them: a button enabled by a
 * stale page must still be refused by the API, and having the server state what
 * is possible keeps the two from disagreeing.
 */
export type AttendanceToday = {
  attendanceDate: string;
  record: AttendanceDetail | null;
  /** The policy in force, so the UI can show expected hours honestly. */
  policy: AttendancePolicyView | null;
  isHoliday: boolean;
  isWeekOff: boolean;
  /** The approved leave covering today, if any. */
  onLeave: boolean;
  canClockIn: boolean;
  canClockOut: boolean;
  canStartBreak: boolean;
  canEndBreak: boolean;
  /** The open break, when one is running. */
  openBreak: AttendanceBreakView | null;
};

/**
 * Totals over a range.
 *
 * Counts of days and sums of minutes, computed from the rows the same request
 * read. Deliberately no percentages, averages or trends: Phase 2 holds no
 * baseline to compare against, and an "attendance score" would be a number
 * nobody agreed the meaning of. HR analytics is a later phase.
 */
export type AttendanceSummary = {
  from: string;
  to: string;
  presentDays: number;
  absentDays: number;
  halfDays: number;
  leaveDays: number;
  holidayDays: number;
  weekOffDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
  lateCount: number;
  earlyExitCount: number;
};

export type AttendanceCorrectionView = {
  id: string;
  employee: EmployeeRef;
  attendanceDate: string;
  currentClockInAt: string | null;
  currentClockOutAt: string | null;
  requestedClockInAt: string | null;
  requestedClockOutAt: string | null;
  requestedWorkMode: AttendanceWorkMode | null;
  reason: string;
  status: AttendanceCorrectionStatus;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
};

export type AttendanceCorrectionPage = {
  corrections: AttendanceCorrectionView[];
  nextCursor: string | null;
};

export type OvertimeView = {
  id: string;
  employee: EmployeeRef;
  overtimeDate: string;
  minutes: number;
  status: OvertimeStatus;
  source: AttendanceSource;
  remarks: string | null;
  decidedAt: string | null;
};

export type OvertimePage = {
  overtime: OvertimeView[];
  nextCursor: string | null;
};

export type HolidayView = {
  id: string;
  name: string;
  holidayDate: string;
  description: string | null;
  isActive: boolean;
  department: OrgUnitRef | null;
};

export type AttendancePolicyView = {
  id: string;
  name: string;
  code: string;
  /** Minutes from midnight company-time. Rendered by `formatMinuteOfDay`. */
  expectedStartMinute: number;
  expectedEndMinute: number;
  graceMinutes: number;
  fullDayMinutes: number;
  halfDayMinutes: number;
  overtimeThresholdMinutes: number;
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  weekOffDays: number[];
  isActive: boolean;
  isDefault: boolean;
  department: OrgUnitRef | null;
};

// ---------------------------------------------------------------------------
//  Leave
// ---------------------------------------------------------------------------

export type LeaveTypeView = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isPaid: boolean;
  isActive: boolean;
  halfDayAllowed: boolean;
  approvalRequired: boolean;
  accrualEnabled: boolean;
  carryForwardEnabled: boolean;
  /** Null means unlimited, not zero. */
  carryForwardLimit: string | null;
  encashmentAllowed: boolean;
};

export type LeavePolicyView = {
  id: string;
  leaveType: { id: string; name: string; code: string };
  department: OrgUnitRef | null;
  /** Decimal as a string, so no precision is lost crossing the wire. */
  annualEntitlement: string;
  accrualPerPeriod: string | null;
  minNoticeDays: number;
  maxConsecutiveDays: number | null;
  isActive: boolean;
};

/**
 * One balance.
 *
 * `available` is **derived** — allocated + accrued + carriedForward + adjusted
 * − used − reserved — and computed by the service from the five stored
 * components. It is deliberately not a database column: a stored copy would be a
 * sixth number free to disagree with the five it comes from.
 */
export type LeaveBalanceView = {
  leaveType: { id: string; name: string; code: string };
  periodYear: number;
  allocated: string;
  accrued: string;
  carriedForward: string;
  used: string;
  reserved: string;
  adjusted: string;
  available: string;
};

export type LeaveLedgerEntryView = {
  id: string;
  reason: LeaveLedgerReason;
  days: string;
  note: string | null;
  performedBy: { id: string; name: string } | null;
  createdAt: string;
};

export type LeaveRequestRow = {
  id: string;
  employee: EmployeeRef;
  leaveType: { id: string; name: string; code: string };
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  halfDayPeriod: HalfDayPeriod | null;
  requestedDays: string;
  reason: string;
  status: LeaveRequestStatus;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelledAt: string | null;
  createdAt: string;
};

export type LeaveRequestPage = {
  requests: LeaveRequestRow[];
  nextCursor: string | null;
};

export type LeaveRequestDetail = LeaveRequestRow & {
  cancellationNote: string | null;
  /** Every balance movement this request caused, so the cost is explainable. */
  ledger: LeaveLedgerEntryView[];
  updatedAt: string;
};

/**
 * What a date range would cost, before applying.
 *
 * Returned as a breakdown rather than a bare number so the form can explain it:
 * "5 calendar days, 1 holiday, 2 week-offs, 2 days of leave" is what stops
 * somebody disputing their balance afterwards. Computed by the one shared
 * calculator, so the preview and the eventual charge cannot differ.
 */
export type LeaveDayPreview = {
  leaveDays: string;
  totalDays: number;
  holidayDays: number;
  weekOffDays: number;
  workingDates: string[];
};
