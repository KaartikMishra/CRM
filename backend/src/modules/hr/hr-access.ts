/**
 * Who may see and change what in HR, as pure functions.
 *
 * Capability — whether somebody may reach the module at all — is decided before
 * this file runs, by `requirePermission` in the route table using the existing
 * two-layer resolver. What is left is *scope*: which employees a person who may
 * read the module is allowed to read.
 *
 * ### The three populations
 *
 *   HR administrators   hold HR_EMPLOYEE:VIEW. They see everybody. Running an HR
 *                       function means knowing who works here.
 *   Managers            hold no HR permission but appear as somebody's manager.
 *                       They see their own reports and nothing else.
 *   Everybody else      sees nothing, and gets the module's 403 from the route
 *                       table before reaching any of this.
 *
 * ### Why this is deliberately not a policy engine
 *
 * The brief allows for "the minimal safe rule, with the future extension
 * documented", and that is what this is. A general row-level framework — rules
 * stored as data, composed at request time — is the right answer when there are
 * many resources with many overlapping scopes. HR Phase 1 has one resource and
 * three populations, so a framework would be more code to audit than the rule it
 * encodes, and every bug in it would be a confidentiality bug.
 *
 * **Future extension.** Phase 2 brings employee self-service, which adds a fourth
 * population: a person reading their *own* record. The hook for it already exists —
 * `SELF` is in PermissionAction and `scopeFor` below returns a discriminated union
 * — so the change is a new variant here plus the route table asking for it, not a
 * rewrite. Phases 5–6 bring payroll and documents with genuinely narrower scopes
 * (a manager must not read a report's payslip); at that point the per-field
 * question arrives and a real framework may be justified. It is not yet.
 *
 * Pure functions with no database access, following the precedent of
 * enquiry-access.ts and procurement-access.ts: a policy that queries cannot be
 * unit-tested without one, and these are the rules most worth testing.
 */

import type { AppModule, PermissionAction } from '@rs/shared';

/** The acting person, as the services need to see them. */
export type HrActor = {
  id: string;
  role: 'ADMIN' | 'USER';
  /** Resolved capabilities, passed in because the resolver is async. */
  can: (module: AppModule, action: PermissionAction) => boolean;
  /**
   * This person's own Employee id, where they have one.
   *
   * Null for an account with no HR record — a shared operations login, or an
   * administrator who is not themselves on the payroll. Null must therefore never
   * mean "matches everybody": see `visibleEmployeeFilter`.
   */
  employeeId: string | null;
};

/**
 * What a person is allowed to see.
 *
 *   all          every employee
 *   reports      only the people reporting to them, plus themselves
 *   none         nothing
 *
 * A union rather than a boolean pair, so a caller cannot forget one case — adding
 * `self` in Phase 2 will make every exhaustive switch a compile error until it is
 * handled.
 */
export type HrScope =
  | { kind: 'all' }
  | { kind: 'reports'; managerEmployeeId: string }
  | { kind: 'none' };

export function scopeFor(actor: HrActor): HrScope {
  // The module permission is the grant; the role is not consulted. An
  // administrator holds HR_EMPLOYEE by role default, and a per-user override that
  // revokes it must actually revoke it — which only works if role is not a back
  // door. This is the same reasoning procurement-access.ts applies.
  if (actor.can('HR_EMPLOYEE', 'VIEW')) return { kind: 'all' };

  /*
    A manager with no HR permission still needs their own team. They are
    identified by being somebody's manager, which is a fact about the employee
    rows rather than a permission — so it cannot be expressed in the route table
    and has to be a scope.
  */
  if (actor.employeeId) return { kind: 'reports', managerEmployeeId: actor.employeeId };

  return { kind: 'none' };
}

/**
 * The scope as a Prisma filter, to be ANDed with whatever the caller asked for.
 *
 * Returning a filter rather than post-filtering a page is the difference between
 * correct and nearly-correct: filtering after the query would make a page of 25
 * arrive with 3 rows and the cursor skip the rest, so somebody's team would
 * silently appear to end early.
 *
 * `none` returns a filter that matches nothing rather than throwing, so a
 * permitted-but-unscoped reader sees an empty directory instead of an error. The
 * impossible-id form is deliberate: a `false`-like filter has no Prisma
 * equivalent, and `{}` would match everything — the exact mistake this guards.
 */
export function visibleEmployeeFilter(scope: HrScope): Record<string, unknown> {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'reports':
      // Themselves, plus their direct reports. Not the whole subtree: a skip-level
      // view is a Phase 2 decision, and a recursive walk per list request would be
      // a cost nobody has asked for.
      return {
        OR: [{ id: scope.managerEmployeeId }, { managerId: scope.managerEmployeeId }],
      };
    case 'none':
      return { id: '__no_employee_matches_this__' };
  }
}

/** Whether this person may read one particular employee. */
export function mayViewEmployee(
  scope: HrScope,
  employee: { id: string; managerId: string | null },
): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'reports':
      return (
        employee.id === scope.managerEmployeeId || employee.managerId === scope.managerEmployeeId
      );
    case 'none':
      return false;
  }
}

/**
 * Whether this person may change employee records.
 *
 * Deliberately not scoped the way reading is. A manager who may see their team
 * may not re-grade them, move them between departments or end their employment —
 * those are HR actions with process behind them, and a reporting line is not
 * authority over somebody's employment terms. So writing needs the module
 * permission, full stop, and the route table enforces it before this is reached.
 * This function exists for services that must re-check after loading a row.
 */
export function mayEditEmployees(actor: HrActor): boolean {
  return actor.can('HR_EMPLOYEE', 'EDIT');
}

export function mayManageOrganization(actor: HrActor): boolean {
  return actor.can('HR_ADMIN', 'EDIT');
}

/**
 * Whether this person may read an employee's documents.
 *
 * Stricter than reading the employee. An identity proof or a contract is
 * confidential in a way a department name is not, so a manager's `reports` scope
 * is not enough — this needs the HR module itself. The practical effect is that a
 * manager sees who is on their team and not their team's passports.
 */
export function mayViewEmployeeDocuments(actor: HrActor): boolean {
  return actor.can('HR_EMPLOYEE', 'VIEW');
}

/** Verifying a document against its original is an HR approval, hence APPROVE. */
export function mayVerifyDocuments(actor: HrActor): boolean {
  return actor.can('HR_EMPLOYEE', 'APPROVE');
}

/**
 * Whether a manager assignment is structurally legal.
 *
 * Self-reference is refused by a database CHECK as well, because it is expressible
 * row-locally. A longer cycle is not: deciding whether B is already beneath A
 * needs the ancestor chain, so the caller walks it and passes the result here.
 * Keeping the decision in a pure function is what makes it testable without a
 * database.
 */
export function managerAssignmentError(
  employeeId: string,
  managerId: string | null,
  ancestorIds: readonly string[],
): string | null {
  if (managerId === null) return null;
  if (managerId === employeeId) return 'An employee cannot be their own manager.';
  if (ancestorIds.includes(employeeId)) {
    return 'That would create a reporting loop: the chosen manager already reports to this employee.';
  }
  return null;
}
