/**
 * Who may see and change whose attendance and leave, as pure functions.
 *
 * Capability — may this person reach the module at all — is decided by
 * `requirePermission` in the route table. What is left is *scope*: which
 * employees' records a permitted person may touch. This extends the Phase 1 HR
 * scope model rather than replacing it, and reuses its `HrActor`.
 *
 * ### The four populations
 *
 *   HR administrators   hold HR_ATTENDANCE:VIEW / HR_LEAVE:VIEW. All employees.
 *   Managers            no HR permission, but appear as somebody's manager.
 *                       Their own records and their direct reports'.
 *   Employees           their own records only. **This is the population Phase 1
 *                       did not have to serve**: an ordinary employee must be
 *                       able to clock in and apply for leave without being
 *                       granted any HR module, because otherwise every employee
 *                       in the company needs an HR grant and the grant stops
 *                       meaning anything.
 *   Everybody else      nothing.
 *
 * ### Why self-service needs no permission
 *
 * The brief's own example has USER A holding only `HR_ATTENDANCE:VIEW`, and USER
 * B also CREATE — which is about seeing and managing *other people's* records.
 * Clocking yourself in is not that. An employee with an Employee record is
 * entitled to their own attendance by virtue of it being theirs, so `selfOnly`
 * below is reachable without any module grant. SELF remains a scope restriction
 * rather than a grant, exactly as the brief requires.
 */

import type { HrActor } from './hr-access.js';

/**
 * Which employees' records are in reach.
 *
 *   all        every employee
 *   reports    themselves plus their direct reports
 *   selfOnly   themselves
 *   none       nothing
 *
 * A union rather than a set of booleans, so a caller cannot forget a case: every
 * exhaustive switch over this breaks at compile time when a variant is added.
 */
export type HrRecordScope =
  | { kind: 'all' }
  | { kind: 'reports'; employeeId: string }
  | { kind: 'selfOnly'; employeeId: string }
  | { kind: 'none' };

/**
 * The scope for attendance.
 *
 * `hasReports` is passed in rather than derived here, because answering "is this
 * person a manager" is a database question and this file is pure. The service
 * resolves it once per request.
 */
export function attendanceScope(
  actor: HrActor,
  context: { hasReports: boolean },
): HrRecordScope {
  // The module permission, never the role: an administrator holds HR_ATTENDANCE
  // by role default, and a per-user override that revokes it must actually
  // revoke it.
  if (actor.can('HR_ATTENDANCE', 'VIEW')) return { kind: 'all' };

  if (actor.employeeId) {
    return context.hasReports
      ? { kind: 'reports', employeeId: actor.employeeId }
      : { kind: 'selfOnly', employeeId: actor.employeeId };
  }

  return { kind: 'none' };
}

/** The same for leave, on its own namespace. */
export function leaveScope(actor: HrActor, context: { hasReports: boolean }): HrRecordScope {
  if (actor.can('HR_LEAVE', 'VIEW')) return { kind: 'all' };

  if (actor.employeeId) {
    return context.hasReports
      ? { kind: 'reports', employeeId: actor.employeeId }
      : { kind: 'selfOnly', employeeId: actor.employeeId };
  }

  return { kind: 'none' };
}

/**
 * The scope as a Prisma filter on `employeeId`, to be ANDed with the query.
 *
 * Returning a filter rather than post-filtering a page is the difference between
 * correct and nearly-correct: filtering after the query would make a page of 25
 * arrive with 3 rows while the cursor advanced past the other 22, so a manager's
 * team would silently appear to end early.
 *
 * `none` returns an impossible id rather than `{}`. An empty Prisma filter
 * matches *every* row, so returning it for "no access" would expose the whole
 * company — the exact mistake this guards.
 */
export function scopedEmployeeFilter(scope: HrRecordScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'reports':
      return {
        OR: [{ id: scope.employeeId }, { managerId: scope.employeeId }],
      };
    case 'selfOnly':
      return { id: scope.employeeId };
    case 'none':
      return { id: '__no_employee_matches_this__' };
  }
}

/** Whether one employee's records are readable under a scope. */
export function mayReadEmployeeRecords(
  scope: HrRecordScope,
  employee: { id: string; managerId: string | null },
): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'reports':
      return employee.id === scope.employeeId || employee.managerId === scope.employeeId;
    case 'selfOnly':
      return employee.id === scope.employeeId;
    case 'none':
      return false;
  }
}

/**
 * Whether this person may clock themselves in, break, or clock out.
 *
 * Their own record only, and only if they have one. Deliberately **not** gated on
 * any HR permission — see the note at the top of this file.
 *
 * Clocking somebody *else* in is not available at all in Phase 2, by any
 * permission: it is attendance fraud with extra steps. HR corrects a day through
 * the correction workflow, which records who decided and why.
 */
export function mayRecordOwnAttendance(
  actor: HrActor,
  targetEmployeeId: string,
): boolean {
  return actor.employeeId !== null && actor.employeeId === targetEmployeeId;
}

/** Whether this person may apply for leave for the named employee. */
export function mayApplyForLeave(actor: HrActor, targetEmployeeId: string): boolean {
  // Same reasoning: applying on somebody else's behalf would need its own audited
  // endpoint, and Phase 2 does not ship one.
  return actor.employeeId !== null && actor.employeeId === targetEmployeeId;
}

/**
 * Whether this person may decide a request — leave or correction.
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. They hold APPROVE on the module, or they are the requester's manager.
 *   2. They are not the requester.
 *
 * Self-approval is refused for everybody, administrators included. An HR
 * administrator who is also somebody's manager still cannot approve their own
 * leave: the request exists precisely because somebody asked for a decision, and
 * letting the asker supply it would put one name on both lines of the trail.
 *
 * The manager route is what makes the brief's hierarchy work without granting
 * every reporting manager an HR module — a manager approves their own team by
 * virtue of being their manager.
 */
export function mayDecideRequest(
  actor: HrActor,
  request: {
    /** The employee the request is about. */
    employeeId: string;
    /** That employee's manager. */
    managerId: string | null;
    status: string;
  },
  options: { module: 'HR_ATTENDANCE' | 'HR_LEAVE' },
): boolean {
  if (request.status !== 'PENDING') return false;

  // Nobody decides their own, whatever else they hold.
  if (actor.employeeId !== null && actor.employeeId === request.employeeId) return false;

  if (actor.can(options.module, 'APPROVE')) return true;

  // The requester's own manager, identified by the reporting line rather than a
  // permission.
  return actor.employeeId !== null && request.managerId === actor.employeeId;
}

/** Whether this person may withdraw a request. The requester alone. */
export function mayCancelOwnRequest(
  actor: HrActor,
  request: { employeeId: string; status: string },
): boolean {
  if (actor.employeeId === null || actor.employeeId !== request.employeeId) return false;
  // A decided request is cancelled through the approved-leave path, which has its
  // own rules about dates; this covers withdrawing before a decision.
  return request.status === 'PENDING';
}

/**
 * Whether an approved leave may still be cancelled.
 *
 * Future-dated only, by policy: a leave that has already started or finished is
 * attendance history, and silently reversing it would restate days somebody was
 * genuinely absent for. HR can still correct the past through the attendance
 * correction workflow, which records who decided and why — a controlled path
 * rather than a silent one, which is what the brief asks for.
 *
 * `today` is passed in, taken from Postgres by the caller, so this stays pure and
 * cannot be fooled by a client clock.
 */
export function mayCancelApprovedLeave(
  actor: HrActor,
  request: { employeeId: string; status: string; startDate: Date },
  today: Date,
): { allowed: boolean; reason?: string } {
  if (request.status !== 'APPROVED') {
    return { allowed: false, reason: 'Only an approved leave can be cancelled this way.' };
  }

  const isOwner = actor.employeeId !== null && actor.employeeId === request.employeeId;
  const isHr = actor.can('HR_LEAVE', 'EDIT');
  if (!isOwner && !isHr) {
    return { allowed: false, reason: 'You cannot cancel this leave.' };
  }

  if (request.startDate.getTime() <= today.getTime()) {
    return {
      allowed: false,
      reason:
        'This leave has already started. Ask HR to raise an attendance correction instead.',
    };
  }

  return { allowed: true };
}

/** Whether this person may configure holidays, policies and leave types. */
export function mayConfigureHr(actor: HrActor): boolean {
  // HR_ADMIN, the structural namespace — the same grant that governs departments
  // and designations. Configuring the working week is structural, not clerical.
  return actor.can('HR_ADMIN', 'EDIT');
}

/** Whether this person may adjust a balance by hand. */
export function mayAdjustBalance(actor: HrActor): boolean {
  /*
    EDIT on HR_LEAVE, deliberately not APPROVE. Approving is deciding somebody
    else's request within the rules; adjusting a balance is overriding the rules,
    and it is the one leave operation with no request behind it. Keeping it on
    EDIT means the person who maintains leave records can correct them, while an
    approver who only decides requests cannot quietly grant days.
  */
  return actor.can('HR_LEAVE', 'EDIT');
}
