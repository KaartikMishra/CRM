/**
 * The HR permission vocabulary, and the guarantee that adding it changed nothing.
 *
 * This file exists because of one specific hazard. `ActionSet` is
 * `Partial<Record<PermissionAction, boolean>>`, so adding APPROVE, EXPORT and
 * SELF to the enum compiled without touching a single existing entry in
 * ROLE_DEFAULTS — no error anywhere, and the constant that grants the nine
 * shipped modules their actions was called `ALL`. A name like that goes on
 * reading as "everything" indefinitely while quietly meaning "everything except
 * whatever was added last", and nothing in the type system says otherwise.
 *
 * The rename to `CRUD_ASSIGN` makes the code honest. These tests make it
 * enforced: the central assertion below is that no pre-existing module grants any
 * of the three new actions to anybody, by role default or otherwise. If somebody
 * later "tidies up" by spreading the new actions into the shared constant, this
 * fails and says which module gained what.
 *
 * Runs against the real resolver and the real database, because the two-layer
 * rule — role default, overridden per user — is the thing being tested, and a
 * mocked resolver would test the mock.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_MODULES,
  CRUD_ASSIGN_ACTIONS,
  HR_MODULES,
  MODULES_WITHOUT_NAVIGATION,
  PERMISSION_ACTIONS,
  type AppModule,
  type PermissionAction,
} from '@rs/shared';
import { prisma } from '../../config/database.js';
import {
  effectivePermissions,
  resolvePermission,
  roleDefault,
  usersWithPermission,
} from '../permission.service.js';
import { cleanup, makeUser, type TestUser } from '../../__tests__/helpers/fixtures.js';

/** The three actions introduced for HR. */
const NEW_ACTIONS: PermissionAction[] = ['APPROVE', 'EXPORT', 'SELF'];

/** Every module that is not an HR namespace. */
const PRE_EXISTING_MODULES: AppModule[] = APP_MODULES.filter(
  (module) => !(HR_MODULES as readonly AppModule[]).includes(module),
);

let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  admin = await makeUser('ADMIN');
  user = await makeUser('USER');
});

afterAll(async () => {
  await cleanup();
});

describe('the vocabulary itself', () => {
  it('partitions the module vocabulary into HR and non-HR namespaces', () => {
    /*
      This test asserted three literal counts (9 / 7 / 16) until Phase 5. Both
      halves had drifted, for unrelated reasons, and the literals hid which:

      - RS_PRODUCTS shipped as a tenth non-HR module (commit e375902), so the
        "nine pre-existing" figure was stale before HR Phase 4 began. Nothing to
        do with HR.
      - HR_TRAINING was added as an eighth HR namespace in Phase 4.

      Counting is the wrong assertion here: the number changes every time a
      module legitimately ships, so a literal fails on correct work and teaches
      people to bump it without reading. What must hold is that the two sets
      *partition* APP_MODULES — every module is classified, nothing is in both,
      and nothing is in neither. A module that slips out of both sets would be
      invisible to every HR-vs-shipped assertion in this file, and that is the
      failure worth catching.

      The HR list itself is pinned by name below, because which namespaces exist
      is a deliberate separation-of-duties decision rather than a count.
    */
    expect(PRE_EXISTING_MODULES.length + HR_MODULES.length).toBe(APP_MODULES.length);

    // No module claims to be both, and every module is one or the other.
    for (const module of APP_MODULES) {
      const isHr = (HR_MODULES as readonly AppModule[]).includes(module);
      expect(PRE_EXISTING_MODULES.includes(module), module).toBe(!isHr);
    }

    // The HR namespaces, by name: eight, each a distinct grant on purpose.
    expect([...HR_MODULES].sort()).toEqual([
      'HR_ADMIN',
      'HR_ATTENDANCE',
      'HR_EMPLOYEE',
      'HR_LEAVE',
      'HR_PAYROLL',
      'HR_PERFORMANCE',
      'HR_RECRUITMENT',
      'HR_TRAINING',
    ]);
  });

  it('keeps the original five actions and adds three', () => {
    expect(CRUD_ASSIGN_ACTIONS).toEqual(['VIEW', 'CREATE', 'EDIT', 'DELETE', 'ASSIGN']);
    expect(PERMISSION_ACTIONS).toHaveLength(8);
    for (const action of NEW_ACTIONS) {
      expect(PERMISSION_ACTIONS).toContain(action);
    }
  });

  it('names the HR modules that still have no navigation', () => {
    /*
      "No navigation" means **no top-level sidebar row of its own**, not "no pages".
      Most entries here have working screens; they are reached as children of the HR
      & Workforce row, because the navigation table's invariant requires every child
      to share its parent's module.

      Updated in Phase 1: HR_EMPLOYEE gained the employee directory and profile and
      a row of its own, so it left this list — which is exactly what the list is for.

      HR_ADMIN stays deliberately: it governs the department and designation
      masters, which have pages but no sidebar row, because HR_ADMIN is a different
      grant from HR_EMPLOYEE and a top-level row would imply one grant covers both.

      HR_TRAINING joined in Phase 4 and HR_PERFORMANCE now has pages too (Phase 5).
      Both stay here for the child-row reason above, not because they are unbuilt —
      the earlier note calling HR_PERFORMANCE "genuinely unbuilt" is no longer true.
    */
    expect([...MODULES_WITHOUT_NAVIGATION].sort()).toEqual([
      'HR_ADMIN',
      'HR_ATTENDANCE',
      'HR_LEAVE',
      'HR_PAYROLL',
      'HR_PERFORMANCE',
      'HR_RECRUITMENT',
      'HR_TRAINING',
    ]);

    // Every entry is still an HR namespace: nothing non-HR has drifted in.
    for (const module of MODULES_WITHOUT_NAVIGATION) {
      expect(HR_MODULES as readonly string[], module).toContain(module);
    }
  });
});

describe('the nine pre-existing modules are unchanged — the central guarantee', () => {
  it('grants no new action to anybody, on any module, by role default', () => {
    /*
      The assertion this whole file is for. Asserted as a collected list rather
      than a bare boolean so a failure names exactly which module and action
      leaked, which is the difference between a two-minute fix and an afternoon.
    */
    const leaked: string[] = [];

    for (const module of PRE_EXISTING_MODULES) {
      for (const action of NEW_ACTIONS) {
        for (const role of ['ADMIN', 'USER'] as const) {
          if (roleDefault(role, module, action)) leaked.push(`${role} ${module}:${action}`);
        }
      }
    }

    expect(leaked).toEqual([]);
  });

  it('keeps ADMIN’s five original actions on all nine', () => {
    for (const module of PRE_EXISTING_MODULES) {
      for (const action of CRUD_ASSIGN_ACTIONS) {
        expect(roleDefault('ADMIN', module, action), `ADMIN ${module}:${action}`).toBe(true);
      }
    }
  });

  it('keeps USER’s defaults exactly as they were', () => {
    // Product Enquiry and Sales: view, create, edit. Nothing else, nowhere else.
    for (const module of ['PRODUCT_ENQUIRY', 'SALES'] as const) {
      expect(roleDefault('USER', module, 'VIEW')).toBe(true);
      expect(roleDefault('USER', module, 'CREATE')).toBe(true);
      expect(roleDefault('USER', module, 'EDIT')).toBe(true);
      expect(roleDefault('USER', module, 'DELETE')).toBe(false);
      expect(roleDefault('USER', module, 'ASSIGN')).toBe(false);
    }

    const otherSeven = PRE_EXISTING_MODULES.filter(
      (m) => m !== 'PRODUCT_ENQUIRY' && m !== 'SALES',
    );
    for (const module of otherSeven) {
      for (const action of PERMISSION_ACTIONS) {
        expect(roleDefault('USER', module, action), `USER ${module}:${action}`).toBe(false);
      }
    }
  });
});

describe('HR defaults', () => {
  it('gives ADMIN full authority over every HR namespace, including APPROVE and EXPORT', () => {
    for (const module of HR_MODULES) {
      for (const action of [...CRUD_ASSIGN_ACTIONS, 'APPROVE', 'EXPORT'] as PermissionAction[]) {
        expect(roleDefault('ADMIN', module, action), `ADMIN ${module}:${action}`).toBe(true);
      }
    }
  });

  it('grants SELF to nobody by default, not even ADMIN', () => {
    /*
      SELF narrows rather than widens: it means "your own record only". An
      administrator who already reads everybody's records gains nothing from it,
      and granting it would make can(…, 'SELF') true for somebody whose access is
      not self-scoped at all — the opposite of what any caller asking that
      question wants to know.
    */
    for (const module of APP_MODULES) {
      expect(roleDefault('ADMIN', module, 'SELF'), `ADMIN ${module}`).toBe(false);
      expect(roleDefault('USER', module, 'SELF'), `USER ${module}`).toBe(false);
    }
  });

  it('gives a plain USER no HR access at all', () => {
    for (const module of HR_MODULES) {
      for (const action of PERMISSION_ACTIONS) {
        expect(roleDefault('USER', module, action), `USER ${module}:${action}`).toBe(false);
      }
    }
  });
});

describe('the resolver reports the new actions, which a hardcoded list would not', () => {
  it('includes every module × action pair in the effective matrix', async () => {
    const matrix = await effectivePermissions(admin.id, 'ADMIN');

    /*
      The regression guard for a real bug that was in this file: the action list
      in effectivePermissions was five literals typed out by hand, so APPROVE,
      EXPORT and SELF would have been absent from /api/auth/me — and therefore
      false everywhere can() is asked — while ROLE_DEFAULTS said otherwise. It
      reads PERMISSION_ACTIONS now.
    */
    expect(matrix).toHaveLength(APP_MODULES.length * PERMISSION_ACTIONS.length);

    const approve = matrix.filter((row) => row.action === 'APPROVE');
    expect(approve).toHaveLength(APP_MODULES.length);
    expect(approve.filter((row) => row.allowed).map((row) => row.module).sort()).toEqual(
      [...HR_MODULES].sort(),
    );
  });

  it('reports SELF present but denied everywhere', async () => {
    const matrix = await effectivePermissions(admin.id, 'ADMIN');
    const self = matrix.filter((row) => row.action === 'SELF');

    expect(self).toHaveLength(APP_MODULES.length);
    expect(self.every((row) => row.allowed === false)).toBe(true);
  });
});

describe('an override still beats the default, for the new actions too', () => {
  it('grants a USER APPROVE on one HR module without touching the others', async () => {
    await prisma.userModulePermission.create({
      data: { userId: user.id, module: 'HR_LEAVE', action: 'APPROVE', allowed: true },
    });

    // The reporting-manager case the whole design is for: approves leave, and is
    // not an administrator.
    expect(await resolvePermission(user.id, 'USER', 'HR_LEAVE', 'APPROVE')).toBe(true);
    expect(await resolvePermission(user.id, 'USER', 'HR_PAYROLL', 'APPROVE')).toBe(false);
    expect(await resolvePermission(user.id, 'USER', 'HR_LEAVE', 'EXPORT')).toBe(false);
    // And it grants nothing on a pre-existing module.
    expect(await resolvePermission(user.id, 'USER', 'SALES', 'APPROVE')).toBe(false);
  });

  it('revokes EXPORT from an administrator when a row says so', async () => {
    await prisma.userModulePermission.create({
      data: { userId: admin.id, module: 'HR_PAYROLL', action: 'EXPORT', allowed: false },
    });

    // The property that makes this a real permission rather than a role check:
    // an administrator can be denied the payroll register specifically.
    expect(await resolvePermission(admin.id, 'ADMIN', 'HR_PAYROLL', 'EXPORT')).toBe(false);
    expect(await resolvePermission(admin.id, 'ADMIN', 'HR_PAYROLL', 'VIEW')).toBe(true);
    expect(await resolvePermission(admin.id, 'ADMIN', 'HR_EMPLOYEE', 'EXPORT')).toBe(true);
  });

  it('finds the people who may approve one HR module', async () => {
    const approvers = await usersWithPermission('HR_LEAVE', 'APPROVE');
    const ids = approvers.map((a) => a.id);

    // The administrator by role default, the USER by the override above. The
    // second is the point: querying the override table alone would have missed
    // the administrator entirely, and querying roles alone would have missed the
    // manager.
    expect(ids).toContain(admin.id);
    expect(ids).toContain(user.id);
  });
});
