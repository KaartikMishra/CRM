/**
 * The HR scope rules, as pure logic.
 *
 * No database and no HTTP: these are functions of their arguments, and the point
 * of testing them separately is that they are the rules most worth being certain
 * about. A mistake here is a confidentiality bug — somebody reading a colleague's
 * record they are not entitled to — and the integration suite exercises them only
 * through the handful of paths it happens to take.
 *
 * Following the precedent of policies/approval.test.ts and enquiry-access: the
 * rule lives in a pure function precisely so it can be tested exhaustively.
 */

import { describe, expect, it } from 'vitest';
import type { AppModule, PermissionAction } from '@rs/shared';
import {
  managerAssignmentError,
  mayEditEmployees,
  mayManageOrganization,
  mayVerifyDocuments,
  mayViewEmployee,
  mayViewEmployeeDocuments,
  scopeFor,
  visibleEmployeeFilter,
  type HrActor,
} from '../hr-access.js';

/** An actor holding exactly the capabilities listed. */
function actor(
  granted: `${AppModule}:${PermissionAction}`[],
  options: { id?: string; role?: 'ADMIN' | 'USER'; employeeId?: string | null } = {},
): HrActor {
  const set = new Set<string>(granted);
  return {
    id: options.id ?? 'u1',
    role: options.role ?? 'USER',
    can: (module, action) => set.has(`${module}:${action}`),
    employeeId: options.employeeId ?? null,
  };
}

describe('scope follows the permission, never the role', () => {
  it('gives somebody with HR_EMPLOYEE:VIEW the whole directory', () => {
    expect(scopeFor(actor(['HR_EMPLOYEE:VIEW']))).toEqual({ kind: 'all' });
  });

  it('gives an administrator nothing extra by virtue of being one', () => {
    /*
      The property that makes HR access a real permission rather than a role check:
      an administrator holds HR_EMPLOYEE by role default, so a per-user override
      that revokes it must actually revoke it. If the role were a back door here,
      revoking somebody's HR access would silently not work.
    */
    const revokedAdmin = actor([], { role: 'ADMIN' });
    expect(scopeFor(revokedAdmin)).toEqual({ kind: 'none' });
  });

  it('gives a manager with no HR permission their own reports', () => {
    const manager = actor([], { employeeId: 'e-manager' });
    expect(scopeFor(manager)).toEqual({ kind: 'reports', managerEmployeeId: 'e-manager' });
  });

  it('gives somebody with neither permission nor an HR record nothing', () => {
    expect(scopeFor(actor([]))).toEqual({ kind: 'none' });
  });

  it('prefers the permission over the manager scope when both apply', () => {
    // An HR administrator who is also somebody's manager should see everybody, not
    // just their team.
    const both = actor(['HR_EMPLOYEE:VIEW'], { employeeId: 'e-manager' });
    expect(scopeFor(both)).toEqual({ kind: 'all' });
  });
});

describe('the scope filter', () => {
  it('is empty for "all", so nothing is excluded', () => {
    expect(visibleEmployeeFilter({ kind: 'all' })).toEqual({});
  });

  it('matches the manager and their direct reports', () => {
    expect(visibleEmployeeFilter({ kind: 'reports', managerEmployeeId: 'm1' })).toEqual({
      OR: [{ id: 'm1' }, { managerId: 'm1' }],
    });
  });

  it('matches nothing for "none" — and is not an empty object', () => {
    /*
      The trap this guards. `{}` is the natural thing to return for "no access" and
      is catastrophically wrong: an empty Prisma filter matches *every* row, so a
      reader with no scope would see the entire directory. There is no `false`
      filter in Prisma, hence the impossible id.
    */
    const filter = visibleEmployeeFilter({ kind: 'none' });
    expect(filter).not.toEqual({});
    expect(Object.keys(filter)).toHaveLength(1);
    expect(filter).toEqual({ id: '__no_employee_matches_this__' });
  });
});

describe('reading one employee', () => {
  const employee = { id: 'e1', managerId: 'm1' };

  it('allows anybody whose scope is "all"', () => {
    expect(mayViewEmployee({ kind: 'all' }, employee)).toBe(true);
  });

  it('allows a manager their own report', () => {
    expect(mayViewEmployee({ kind: 'reports', managerEmployeeId: 'm1' }, employee)).toBe(true);
  });

  it('allows a manager their own record', () => {
    expect(
      mayViewEmployee({ kind: 'reports', managerEmployeeId: 'e1' }, employee),
    ).toBe(true);
  });

  it('refuses a manager somebody else’s report', () => {
    expect(mayViewEmployee({ kind: 'reports', managerEmployeeId: 'other' }, employee)).toBe(false);
  });

  it('refuses a skip-level report', () => {
    /*
      Direct reports only, deliberately. A skip-level view is a Phase 2 decision,
      and a recursive subtree walk on every list request would be a cost nobody
      asked for. An employee whose manager is somebody else is out of scope even if
      that manager reports to the viewer.
    */
    const grandchild = { id: 'e2', managerId: 'e1' };
    expect(mayViewEmployee({ kind: 'reports', managerEmployeeId: 'm1' }, grandchild)).toBe(false);
  });

  it('refuses everything for "none"', () => {
    expect(mayViewEmployee({ kind: 'none' }, employee)).toBe(false);
  });
});

describe('writing is not scoped the way reading is', () => {
  it('needs the module permission, not a reporting line', () => {
    /*
      A manager who may see their team may not re-grade them, move them between
      departments or end their employment. Those are HR actions with process
      behind them, and a reporting line is not authority over somebody's
      employment terms.
    */
    const manager = actor([], { employeeId: 'e-manager' });
    expect(mayEditEmployees(manager)).toBe(false);

    const coordinator = actor(['HR_EMPLOYEE:EDIT']);
    expect(mayEditEmployees(coordinator)).toBe(true);
  });

  it('separates organization administration from employee records', () => {
    const coordinator = actor(['HR_EMPLOYEE:VIEW', 'HR_EMPLOYEE:EDIT']);
    expect(mayManageOrganization(coordinator)).toBe(false);

    const orgAdmin = actor(['HR_ADMIN:EDIT']);
    expect(mayManageOrganization(orgAdmin)).toBe(true);
    // And the reverse: structural rights are not employee rights.
    expect(mayEditEmployees(orgAdmin)).toBe(false);
  });
});

describe('documents are stricter than the directory', () => {
  it('refuses a manager their own report’s documents', () => {
    /*
      The deliberate asymmetry: a manager sees who is on their team and not their
      team's passports. An identity proof or a contract is confidential in a way a
      department name is not, so the manager scope is not enough.
    */
    const manager = actor([], { employeeId: 'e-manager' });
    expect(mayViewEmployeeDocuments(manager)).toBe(false);
  });

  it('allows somebody with the HR module', () => {
    expect(mayViewEmployeeDocuments(actor(['HR_EMPLOYEE:VIEW']))).toBe(true);
  });

  it('needs APPROVE to verify, not merely VIEW or EDIT', () => {
    expect(mayVerifyDocuments(actor(['HR_EMPLOYEE:VIEW', 'HR_EMPLOYEE:EDIT']))).toBe(false);
    expect(mayVerifyDocuments(actor(['HR_EMPLOYEE:APPROVE']))).toBe(true);
  });
});

describe('manager assignment validity', () => {
  it('accepts clearing the reporting line', () => {
    expect(managerAssignmentError('e1', null, [])).toBeNull();
  });

  it('accepts an unrelated manager', () => {
    expect(managerAssignmentError('e1', 'm1', ['m2', 'm3'])).toBeNull();
  });

  it('refuses self-management', () => {
    expect(managerAssignmentError('e1', 'e1', [])).toContain('their own manager');
  });

  it('refuses a cycle at any depth', () => {
    // The proposed manager's chain already contains this employee, so the
    // assignment would close a loop and make the hierarchy unwalkable.
    expect(managerAssignmentError('e1', 'm1', ['x', 'y', 'e1'])).toContain('reporting loop');
    expect(managerAssignmentError('e1', 'm1', ['e1'])).toContain('reporting loop');
  });

  it('is decided by the chain, not by the depth of the chain', () => {
    const deep = Array.from({ length: 40 }, (_, i) => `ancestor-${i}`);
    expect(managerAssignmentError('e1', 'm1', deep)).toBeNull();
    expect(managerAssignmentError('e1', 'm1', [...deep, 'e1'])).toContain('reporting loop');
  });
});
