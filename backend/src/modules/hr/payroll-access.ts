/**
 * Who may see and change what in payroll, as pure functions.
 *
 * Capability — may this person reach the module at all — is decided by
 * `requirePermission` in the route table using the existing two-layer resolver.
 * What is left is **scope** and **separation of duties**, and payroll has the
 * sharpest version of both in the system, because the data is the most sensitive
 * and the actions move real money.
 *
 * ### The three populations
 *
 *   Payroll administrators  hold HR_PAYROLL:VIEW. Every period, every employee's
 *                           figures, every salary. Running payroll means seeing
 *                           all of it.
 *   Employees               reach **their own** payslips and **their own** salary
 *                           with no payroll grant at all. That is the population
 *                           a grant-based gate cannot serve: everybody is paid,
 *                           so requiring a grant would mean granting the module
 *                           to the whole company and the grant would stop
 *                           meaning anything.
 *   Everybody else          nothing.
 *
 * **Managers are deliberately NOT a population here.** This is the one HR module
 * where the manager scope from `hr-access.ts` does not apply: a reporting line
 * is a reason to read somebody's attendance or write their appraisal, and it is
 * not a reason to read their salary. Pay confidentiality runs across the
 * hierarchy, not down it. A manager who also runs payroll holds HR_PAYROLL and
 * is in the first population; one who does not sees only their own payslip.
 *
 * ### The four rules this file exists to enforce
 *
 * **1. An employee must not read another employee's pay.** Not their team's, not
 * their peers'. `mayReadEmployeePay` answers this and is consulted before any
 * figure is assembled, not after — the service returns 404 rather than 403 for a
 * payslip outside scope, because "you may not read employee X's payslip"
 * confirms that X is paid and roughly when.
 *
 * **2. Nobody finalises a run that pays them.** Not with APPROVE, not as an
 * administrator, not as the person who built the run. `mayFinalizePeriod`
 * refuses the subject **first**, before any permission is consulted, so no grant
 * can reach past it. An HR colleague is on the payroll like everybody else, and
 * checking the grant first would let them lock the figure that pays them.
 *
 * **3. A finalised period is editable by nobody.** Not the HR team, not an
 * administrator. `isPeriodSettled` is consulted before the question of who is
 * asking. The figures are what people were paid against; editing one afterwards
 * restates history. Corrections go through `PayrollAdjustment` in a later
 * period.
 *
 * **4. Exporting is a separate privilege from reading.** `mayExportPayroll`
 * requires EXPORT, not VIEW. Reading one payslip on screen and downloading every
 * salary in the company are different risks, and only the second leaves the
 * building — which is precisely why the EXPORT action exists (see its comment in
 * `shared/src/enums.ts`).
 *
 * Pure functions with no database access, following `hr-access.ts`,
 * `attendance-access.ts`, `recruitment-access.ts`, `training-access.ts` and
 * `performance-access.ts`. The facts these need — is this reader the employee,
 * is this reader inside this run — are resolved once per request by the service
 * and passed in. A policy that queries cannot be unit-tested, and these are the
 * rules most worth testing.
 */

import { SETTLED_PAYROLL_PERIOD_STATUSES, type PayrollPeriodStatus } from '@rs/shared';
import type { HrActor } from './hr-access.js';

/**
 * What a reader may see of payroll.
 *
 *   all   every employee's pay — a payroll administrator
 *   self  only their own — everybody else who has an employee record
 *   none  nothing — an account with no employee record and no grant
 *
 * Deliberately three cases and deliberately no `reports`: see the note above on
 * why a reporting line is not a reason to read somebody's salary.
 */
export type PayrollScope =
  | { kind: 'all' }
  | { kind: 'self'; employeeId: string }
  | { kind: 'none' };

export function payrollScope(actor: HrActor): PayrollScope {
  /*
    The module permission is the grant; the role is not consulted. An
    administrator holds HR_PAYROLL by role default, and a per-user override that
    revokes it must actually revoke it — which only works if role is not a back
    door. The same reasoning every other access policy in this codebase applies.
  */
  if (actor.can('HR_PAYROLL', 'VIEW')) return { kind: 'all' };

  /*
    Null must never mean "matches everybody". An account with no HR record — a
    shared operations login, or an administrator who is not on the payroll — gets
    nothing rather than an unbounded filter.
  */
  if (actor.employeeId) return { kind: 'self', employeeId: actor.employeeId };

  return { kind: 'none' };
}

/**
 * The Prisma filter that scopes a payroll-item query to what this reader may see.
 *
 * Returns `null` for a reader entitled to nothing, which callers must treat as
 * "return nothing" rather than "no filter". Returning `{}` there would be the
 * difference between an empty list and the entire company's salaries.
 */
export function visiblePayrollItemFilter(
  actor: HrActor,
): { employeeId?: string } | null {
  const scope = payrollScope(actor);
  switch (scope.kind) {
    case 'all':
      return {};
    case 'self':
      return { employeeId: scope.employeeId };
    case 'none':
      return null;
  }
}

/** Whether this reader may read a named employee's pay at all. */
export function mayReadEmployeePay(actor: HrActor, employeeId: string): boolean {
  const scope = payrollScope(actor);
  switch (scope.kind) {
    case 'all':
      return true;
    case 'self':
      return scope.employeeId === employeeId;
    case 'none':
      return false;
  }
}

/**
 * Whether a period can still be changed at all.
 *
 * Consulted **before** who is asking, in every write check below. A finalised
 * period is immutable to everybody rather than to everybody without a
 * sufficiently broad grant.
 */
export function isPeriodSettled(status: PayrollPeriodStatus): boolean {
  return (SETTLED_PAYROLL_PERIOD_STATUSES as readonly PayrollPeriodStatus[]).includes(status);
}

// ---------------------------------------------------------------------------
//  Compensation configuration
// ---------------------------------------------------------------------------

/** Reading the component and structure catalogue. */
export function mayViewCompensationConfig(actor: HrActor): boolean {
  return actor.can('HR_PAYROLL', 'VIEW');
}

/** Creating a salary component or structure. */
export function mayManageCompensationConfig(actor: HrActor): boolean {
  return actor.can('HR_PAYROLL', 'CREATE');
}

/** Editing one. Separate from creating, because EDIT is the narrower grant. */
export function mayEditCompensationConfig(actor: HrActor): boolean {
  return actor.can('HR_PAYROLL', 'EDIT');
}

/**
 * Assigning a salary to an employee.
 *
 * ASSIGN rather than EDIT, matching how training assignment and goal assignment
 * are gated: putting a figure against a named person is a different privilege
 * from configuring the catalogue of possible figures.
 *
 * **The subject is refused first.** Somebody cannot set their own salary,
 * whatever grants they hold. An HR administrator who is also an employee holds
 * ASSIGN, and checking the grant first would let them give themselves a raise.
 */
export function mayAssignSalary(actor: HrActor, employeeId: string): boolean {
  if (actor.employeeId !== null && actor.employeeId === employeeId) return false;
  return actor.can('HR_PAYROLL', 'ASSIGN');
}

/** Reading an employee's salary assignment history. */
export function mayReadSalaryHistory(actor: HrActor, employeeId: string): boolean {
  return mayReadEmployeePay(actor, employeeId);
}

// ---------------------------------------------------------------------------
//  Payroll periods
// ---------------------------------------------------------------------------

export function mayViewPeriods(actor: HrActor): boolean {
  return actor.can('HR_PAYROLL', 'VIEW');
}

export function mayCreatePeriod(actor: HrActor): boolean {
  return actor.can('HR_PAYROLL', 'CREATE');
}

/** Editing a period's policy or notes. Refused once settled, for anybody. */
export function mayEditPeriod(actor: HrActor, status: PayrollPeriodStatus): boolean {
  if (isPeriodSettled(status)) return false;
  // A period under approval is not editable either: changing the arithmetic
  // under an approver who is mid-decision would have them approve figures they
  // did not read.
  if (status === 'PENDING_APPROVAL' || status === 'APPROVED') return false;
  return actor.can('HR_PAYROLL', 'EDIT');
}

/**
 * Running or re-running the calculation.
 *
 * Allowed from DRAFT and CALCULATED, which is what makes recalculation after an
 * attendance correction cheap. Refused from PENDING_APPROVAL onwards: recosting
 * a run somebody is deciding on, or has decided on, would change what they
 * approved.
 */
export function mayCalculatePeriod(actor: HrActor, status: PayrollPeriodStatus): boolean {
  if (status !== 'DRAFT' && status !== 'CALCULATED') return false;
  return actor.can('HR_PAYROLL', 'EDIT');
}

/** Submitting a costed run for approval. */
export function maySubmitPeriod(actor: HrActor, status: PayrollPeriodStatus): boolean {
  if (status !== 'CALCULATED') return false;
  return actor.can('HR_PAYROLL', 'EDIT');
}

/**
 * Deciding a submitted run.
 *
 * **The subject is refused first.** `paysActor` is true when this reader's own
 * salary is inside the run, and an approver who is paid by the run they are
 * approving is approving their own pay. Refusing before the permission check is
 * the substance: an HR colleague being paid holds APPROVE, and checking the
 * grant first would let them clear it.
 */
export function mayDecidePeriod(
  actor: HrActor,
  status: PayrollPeriodStatus,
  paysActor: boolean,
): boolean {
  if (paysActor) return false;
  if (status !== 'PENDING_APPROVAL') return false;
  return actor.can('HR_PAYROLL', 'APPROVE');
}

/**
 * Finalising an approved run — the action that locks the figures.
 *
 * The subject is refused **first**, for the same reason and in the same shape as
 * `mayDecidePeriod` and as Phase 5's `mayFinalizeReview`. This is the rule the
 * user approved explicitly: APPROVE is required, and it is never sufficient for
 * a run that pays the person using it.
 *
 * Note what is *not* here: the person who ran the calculation is **not**
 * refused. A single-HR-person business would otherwise be unable to complete any
 * payroll at all. That was a deliberate decision rather than an oversight — see
 * `PAYROLL-SCOPE.md`, which records it as a configurable control that is not
 * currently enforced.
 */
export function mayFinalizePeriod(
  actor: HrActor,
  status: PayrollPeriodStatus,
  paysActor: boolean,
): boolean {
  if (paysActor) return false;
  if (status !== 'APPROVED') return false;
  return actor.can('HR_PAYROLL', 'APPROVE');
}

/** Abandoning a run before finalisation. Never possible once settled. */
export function mayCancelPeriod(actor: HrActor, status: PayrollPeriodStatus): boolean {
  if (isPeriodSettled(status)) return false;
  return actor.can('HR_PAYROLL', 'APPROVE');
}

/** Holding one employee out of a run. */
export function mayExcludeItem(actor: HrActor, status: PayrollPeriodStatus): boolean {
  if (status !== 'DRAFT' && status !== 'CALCULATED') return false;
  return actor.can('HR_PAYROLL', 'EDIT');
}

// ---------------------------------------------------------------------------
//  Payslips, adjustments and exports
// ---------------------------------------------------------------------------

/**
 * Reading one payslip.
 *
 * `isOwn` is resolved by the service from `Employee.userId` against the actor's
 * id — **not** by comparing employee codes. `User.employeeId` and
 * `Employee.employeeId` are different columns that usually agree and are not
 * guaranteed to, and a Phase 5 defect came from exactly that comparison. The
 * service answers this from the relation.
 *
 * A payslip exists only for a finalised period, so there is no "own draft
 * payslip": a document somebody can save and forward must not be issuable from
 * figures that are still moving.
 */
export function mayReadPayslip(
  actor: HrActor,
  isOwn: boolean,
  periodStatus: PayrollPeriodStatus,
): boolean {
  if (periodStatus !== 'FINALIZED') {
    // Before finalisation, only a payroll administrator sees the working figures,
    // and even they see them as a payroll item rather than as a payslip.
    return false;
  }
  if (isOwn) return true;
  return actor.can('HR_PAYROLL', 'VIEW');
}

/**
 * Recording an adjustment against a closed period.
 *
 * APPROVE rather than EDIT, because an adjustment is how a finalised figure gets
 * corrected and therefore carries the weight of the finalisation it amends.
 *
 * The subject is refused first: nobody awards themselves an arrear or a bonus.
 */
export function mayRecordAdjustment(actor: HrActor, employeeId: string): boolean {
  if (actor.employeeId !== null && actor.employeeId === employeeId) return false;
  return actor.can('HR_PAYROLL', 'APPROVE');
}

/**
 * Exporting the payroll register.
 *
 * EXPORT, never VIEW. This is the action the EXPORT permission was added for.
 * An administrator whose EXPORT has been revoked by a per-user override can
 * still read payroll on screen and cannot download it, which is the entire point
 * of the two being separate.
 */
export function mayExportPayroll(actor: HrActor): boolean {
  return actor.can('HR_PAYROLL', 'EXPORT');
}

/**
 * Whether this reader sees the aggregate summary.
 *
 * VIEW, because a summary carries no individual salary — see
 * `PayrollPeriodSummaryView`, which is aggregates only. A reader entitled to a
 * total is deliberately not handed the figures that compose it.
 */
export function mayViewSummary(actor: HrActor): boolean {
  return actor.can('HR_PAYROLL', 'VIEW');
}
