/**
 * HR Phase 1 — Employee & Organization, end to end.
 *
 * Real requests against a real database, because the things worth pinning here
 * are the ones a type cannot express —
 *
 *   - that employee ids are unique and allocated atomically, so two simultaneous
 *     creates cannot receive the same one;
 *   - that a User maps to at most one Employee and an Employee to at most one
 *     User, in both directions;
 *   - that nobody can be their own manager and no reporting cycle can be created;
 *   - that status changes and transfers write history, in the same transaction;
 *   - that HR_EMPLOYEE and HR_ADMIN are genuinely separate capabilities;
 *   - that a manager sees their own reports and nobody else's;
 *   - and that none of it writes to User, a permission row, or any other module.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../config/database.js';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import {
  RUN_PREFIX,
  cleanup,
  makeUser,
  residualTestRows,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

let admin: TestUser;
/** HR_EMPLOYEE VIEW only — reads the directory, writes nothing. */
let viewer: TestUser;
/** HR_EMPLOYEE VIEW+CREATE+EDIT, deliberately NOT ASSIGN. */
let coordinator: TestUser;
/** No HR permission at all, and no reports — sees nothing. */
let outsider: TestUser;

let adminToken: string;
let viewerToken: string;
let coordinatorToken: string;
let outsiderToken: string;

let departmentId: string;
let designationId: string;

/** Codes carry a ZZT prefix so fixture teardown can find them. */
let codeSeq = 0;
const testCode = (stem: string): string => {
  codeSeq += 1;
  return `ZZT${stem}${codeSeq}`.toUpperCase().slice(0, 20);
};

/** Work emails carry the run marker, which is how teardown finds employees. */
let emailSeq = 0;
const testEmail = (): string => {
  emailSeq += 1;
  return `${RUN_PREFIX}-emp${emailSeq}@test.invalid`;
};

async function grant(
  userId: string,
  module: string,
  actions: string[],
): Promise<void> {
  await prisma.userModulePermission.createMany({
    data: actions.map((action) => ({
      userId,
      module: module as never,
      action: action as never,
      allowed: true,
    })),
    skipDuplicates: true,
  });
}

/** Creates an employee through the API as the administrator. */
async function makeEmployee(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; employeeId: string }> {
  const res = await api('POST', '/api/hr/employees', {
    token: adminToken,
    body: {
      firstName: 'Test',
      lastName: 'Person',
      workEmail: testEmail(),
      joiningDate: '2026-01-15',
      ...overrides,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const employee = (res.body.data as { employee: { id: string; employeeId: string } }).employee;
  return employee;
}

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  viewer = await makeUser('USER');
  coordinator = await makeUser('USER');
  outsider = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  viewerToken = await mintToken(viewer.id, { role: 'USER' });
  coordinatorToken = await mintToken(coordinator.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });

  await grant(viewer.id, 'HR_EMPLOYEE', ['VIEW']);
  await grant(coordinator.id, 'HR_EMPLOYEE', ['VIEW', 'CREATE', 'EDIT']);

  const dept = await api('POST', '/api/hr/departments', {
    token: adminToken,
    body: { name: 'Test Operations', code: testCode('DEPT') },
  });
  expect(dept.status, JSON.stringify(dept.body)).toBe(201);
  departmentId = (dept.body.data as { department: { id: string } }).department.id;

  const desig = await api('POST', '/api/hr/designations', {
    token: adminToken,
    body: { name: 'Test Executive', code: testCode('DESIG'), level: 3 },
  });
  expect(desig.status).toBe(201);
  designationId = (desig.body.data as { designation: { id: string } }).designation.id;
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Organization
// ---------------------------------------------------------------------------

describe('departments', () => {
  it('creates one and counts its employees as zero', async () => {
    const code = testCode('NEWD');
    const res = await api('POST', '/api/hr/departments', {
      token: adminToken,
      body: { name: 'Fresh Department', code, description: 'For the test' },
    });

    expect(res.status).toBe(201);
    const department = (res.body.data as { department: Record<string, unknown> }).department;
    expect(department.code).toBe(code);
    // Derived by the database, never stored.
    expect(department.employeeCount).toBe(0);
    expect(department.status).toBe('ACTIVE');
  });

  it('uppercases the code, so "eng" and "ENG" cannot both exist', async () => {
    const stem = testCode('CASE');
    const first = await api('POST', '/api/hr/departments', {
      token: adminToken,
      body: { name: 'Lower', code: stem.toLowerCase() },
    });
    expect(first.status).toBe(201);
    expect((first.body.data as { department: { code: string } }).department.code).toBe(stem);

    /*
      The failure this prevents: two departments whose codes differ only in case
      read as the same code to a human, and the unique index cannot help because it
      sees two different strings.
    */
    const second = await api('POST', '/api/hr/departments', {
      token: adminToken,
      body: { name: 'Upper', code: stem },
    });
    expect(second.status).toBe(409);
  });

  it('refuses a duplicate code', async () => {
    const code = testCode('DUPD');
    expect((await api('POST', '/api/hr/departments', {
      token: adminToken, body: { name: 'One', code },
    })).status).toBe(201);

    const res = await api('POST', '/api/hr/departments', {
      token: adminToken,
      body: { name: 'Two', code },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEPARTMENT_CODE_TAKEN');
  });

  it('updates the name but does not accept a new code', async () => {
    const created = await api('POST', '/api/hr/departments', {
      token: adminToken,
      body: { name: 'Before', code: testCode('UPDD') },
    });
    const id = (created.body.data as { department: { id: string } }).department.id;

    const res = await api('PATCH', `/api/hr/departments/${id}`, {
      token: adminToken,
      body: { name: 'After', code: 'SOMETHINGELSE' },
    });

    expect(res.status).toBe(200);
    const department = (res.body.data as { department: { name: string; code: string } }).department;
    expect(department.name).toBe('After');
    // The code is the stable identifier people quote; renaming is `name`.
    expect(department.code).not.toBe('SOMETHINGELSE');
  });

  it('archives rather than deleting', async () => {
    const created = await api('POST', '/api/hr/departments', {
      token: adminToken,
      body: { name: 'To Archive', code: testCode('ARCH') },
    });
    const id = (created.body.data as { department: { id: string } }).department.id;

    const res = await api('PATCH', `/api/hr/departments/${id}`, {
      token: adminToken,
      body: { status: 'ARCHIVED' },
    });
    expect(res.status).toBe(200);

    // Still readable — archiving keeps history, which is the whole point.
    const read = await api('GET', `/api/hr/departments/${id}`, { token: adminToken });
    expect(read.status).toBe(200);
  });

  it('refuses a parent that would create a loop', async () => {
    const a = await api('POST', '/api/hr/departments', {
      token: adminToken, body: { name: 'Parent A', code: testCode('LOOPA') },
    });
    const aId = (a.body.data as { department: { id: string } }).department.id;
    const b = await api('POST', '/api/hr/departments', {
      token: adminToken, body: { name: 'Child B', code: testCode('LOOPB'), parentId: aId },
    });
    const bId = (b.body.data as { department: { id: string } }).department.id;

    // A under B, when B is already under A, would make the tree unwalkable.
    const res = await api('PATCH', `/api/hr/departments/${aId}`, {
      token: adminToken,
      body: { parentId: bId },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PARENT');
  });

  it('refuses a department as its own parent', async () => {
    const created = await api('POST', '/api/hr/departments', {
      token: adminToken, body: { name: 'Selfish', code: testCode('SELFD') },
    });
    const id = (created.body.data as { department: { id: string } }).department.id;

    const res = await api('PATCH', `/api/hr/departments/${id}`, {
      token: adminToken,
      body: { parentId: id },
    });
    expect(res.status).toBe(400);
  });
});

describe('designations', () => {
  it('creates one with a level', async () => {
    const res = await api('POST', '/api/hr/designations', {
      token: adminToken,
      body: { name: 'Senior Thing', code: testCode('SEN'), level: 5 },
    });
    expect(res.status).toBe(201);
    expect((res.body.data as { designation: { level: number } }).designation.level).toBe(5);
  });

  it('refuses a duplicate code', async () => {
    const code = testCode('DUPG');
    expect((await api('POST', '/api/hr/designations', {
      token: adminToken, body: { name: 'One', code },
    })).status).toBe(201);

    const res = await api('POST', '/api/hr/designations', {
      token: adminToken,
      body: { name: 'Two', code },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DESIGNATION_CODE_TAKEN');
  });

  it('refuses a negative level', async () => {
    const res = await api('POST', '/api/hr/designations', {
      token: adminToken,
      body: { name: 'Negative', code: testCode('NEG'), level: -1 },
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Employees
// ---------------------------------------------------------------------------

describe('creating an employee', () => {
  it('allocates an RS-series employee id the caller cannot choose', async () => {
    const res = await api('POST', '/api/hr/employees', {
      token: adminToken,
      body: {
        firstName: 'Allocated',
        lastName: 'Identifier',
        workEmail: testEmail(),
        joiningDate: '2026-02-01',
        // Ignored: the id comes from the counter, and a client-supplied one would
        // collide under concurrent creates.
        employeeId: 'RS999999',
      },
    });

    expect(res.status).toBe(201);
    const employee = (res.body.data as { employee: { employeeId: string } }).employee;
    expect(employee.employeeId).toMatch(/^RS\d{3,}$/);
    expect(employee.employeeId).not.toBe('RS999999');
  });

  it('gives two simultaneous creates two different ids', async () => {
    /*
      The race the counter exists for. `findMany → max + 1` in application code —
      which is what the existing user-management helper does — returns the same
      maximum to both callers, so both build the same id and the unique index fails
      one at random. An atomic INSERT … ON CONFLICT … RETURNING cannot.
    */
    const [a, b] = await Promise.all([
      api('POST', '/api/hr/employees', {
        token: adminToken,
        body: { firstName: 'Race', lastName: 'One', workEmail: testEmail(), joiningDate: '2026-02-01' },
      }),
      api('POST', '/api/hr/employees', {
        token: adminToken,
        body: { firstName: 'Race', lastName: 'Two', workEmail: testEmail(), joiningDate: '2026-02-01' },
      }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = (a.body.data as { employee: { employeeId: string } }).employee.employeeId;
    const idB = (b.body.data as { employee: { employeeId: string } }).employee.employeeId;
    expect(idA).not.toBe(idB);
  });

  it('never reuses an id already held by a User account', async () => {
    // User.employeeId predates this module and holds real ids; an HR record must
    // not be allocated one somebody's login already has.
    const employee = await makeEmployee();
    const clash = await prisma.user.findFirst({
      where: { employeeId: employee.employeeId },
      select: { id: true },
    });
    expect(clash).toBeNull();
  });

  it('refuses a duplicate work email', async () => {
    const workEmail = testEmail();
    await makeEmployee({ workEmail });

    const res = await api('POST', '/api/hr/employees', {
      token: adminToken,
      body: { firstName: 'Second', lastName: 'Person', workEmail, joiningDate: '2026-02-01' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WORK_EMAIL_TAKEN');
  });

  it('starts ACTIVE with no exit date, whatever the caller asks for', async () => {
    const res = await api('POST', '/api/hr/employees', {
      token: adminToken,
      body: {
        firstName: 'Born',
        lastName: 'Active',
        workEmail: testEmail(),
        joiningDate: '2026-02-01',
        status: 'EXITED',
        exitDate: '2026-03-01',
      },
    });

    expect(res.status).toBe(201);
    const employee = (res.body.data as { employee: { status: string; exitDate: string | null } })
      .employee;
    // Status moves only through its own endpoint, so it writes history.
    expect(employee.status).toBe('ACTIVE');
    expect(employee.exitDate).toBeNull();
  });

  it('writes a JOINED history entry', async () => {
    const employee = await makeEmployee({ departmentId, designationId });

    const res = await api('GET', `/api/hr/employees/${employee.id}/history`, {
      token: adminToken,
    });
    expect(res.status).toBe(200);

    const history = (res.body.data as { history: { eventType: string }[] }).history;
    expect(history.map((h) => h.eventType)).toContain('JOINED');
    // Department and designation set at creation are events too.
    expect(history.map((h) => h.eventType)).toContain('DEPARTMENT_CHANGED');
    expect(history.map((h) => h.eventType)).toContain('DESIGNATION_CHANGED');
  });

  it('refuses an archived department', async () => {
    const created = await api('POST', '/api/hr/departments', {
      token: adminToken, body: { name: 'Closed', code: testCode('CLOSED') },
    });
    const id = (created.body.data as { department: { id: string } }).department.id;
    await api('PATCH', `/api/hr/departments/${id}`, {
      token: adminToken, body: { status: 'ARCHIVED' },
    });

    const res = await api('POST', '/api/hr/employees', {
      token: adminToken,
      body: {
        firstName: 'No', lastName: 'Home', workEmail: testEmail(),
        joiningDate: '2026-02-01', departmentId: id,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DEPARTMENT_ARCHIVED');
  });

  it('does not create a User, a permission row, or touch any other module', async () => {
    const usersBefore = await prisma.user.count();
    const permsBefore = await prisma.userModulePermission.count();
    const ordersBefore = await prisma.salesOrder.count();

    await makeEmployee();

    // Employee is the HR record; User is the authentication account. Creating one
    // must never create the other, and must never grant anybody anything.
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.userModulePermission.count()).toBe(permsBefore);
    expect(await prisma.salesOrder.count()).toBe(ordersBefore);
  });
});

describe('updating an employee', () => {
  it('records a transfer in history but not a phone correction', async () => {
    const employee = await makeEmployee();

    const res = await api('PATCH', `/api/hr/employees/${employee.id}`, {
      token: adminToken,
      body: { departmentId, phone: '+919800000001' },
    });
    expect(res.status).toBe(200);

    const history = (
      (await api('GET', `/api/hr/employees/${employee.id}/history`, { token: adminToken }))
        .body.data as { history: { eventType: string }[] }
    ).history;

    /*
      A transfer is an event in somebody's employment; a corrected phone number is
      not. Recording the second would bury the first, which is what a timeline is
      read for.
    */
    expect(history.filter((h) => h.eventType === 'DEPARTMENT_CHANGED')).toHaveLength(1);
    expect(history.map((h) => h.eventType)).not.toContain('PROFILE_UPDATED');
  });

  it('refuses an empty update', async () => {
    const employee = await makeEmployee();
    const res = await api('PATCH', `/api/hr/employees/${employee.id}`, {
      token: adminToken,
      body: {},
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
//  Manager hierarchy
// ---------------------------------------------------------------------------

describe('the manager hierarchy', () => {
  it('assigns a manager and records it', async () => {
    const manager = await makeEmployee({ firstName: 'The', lastName: 'Manager' });
    const report = await makeEmployee({ firstName: 'The', lastName: 'Report' });

    const res = await api('POST', `/api/hr/employees/${report.id}/manager`, {
      token: adminToken,
      body: { managerId: manager.id },
    });
    expect(res.status).toBe(200);

    const employee = (res.body.data as { employee: { manager: { id: string } | null } }).employee;
    expect(employee.manager?.id).toBe(manager.id);
  });

  it('refuses an employee as their own manager', async () => {
    const employee = await makeEmployee();

    const res = await api('POST', `/api/hr/employees/${employee.id}/manager`, {
      token: adminToken,
      body: { managerId: employee.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MANAGER');
  });

  it('refuses a two-step reporting cycle', async () => {
    const top = await makeEmployee({ firstName: 'Cycle', lastName: 'Top' });
    const middle = await makeEmployee({ firstName: 'Cycle', lastName: 'Middle' });

    await api('POST', `/api/hr/employees/${middle.id}/manager`, {
      token: adminToken, body: { managerId: top.id },
    });

    /*
      Top reporting to Middle, when Middle already reports to Top, would make the
      chain unwalkable. A row-local CHECK cannot see this — it needs the whole
      ancestor chain, which is why the service walks it.
    */
    const res = await api('POST', `/api/hr/employees/${top.id}/manager`, {
      token: adminToken,
      body: { managerId: middle.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MANAGER');
  });

  it('refuses a three-step reporting cycle', async () => {
    const a = await makeEmployee({ firstName: 'Deep', lastName: 'A' });
    const b = await makeEmployee({ firstName: 'Deep', lastName: 'B' });
    const c = await makeEmployee({ firstName: 'Deep', lastName: 'C' });

    await api('POST', `/api/hr/employees/${b.id}/manager`, {
      token: adminToken, body: { managerId: a.id },
    });
    await api('POST', `/api/hr/employees/${c.id}/manager`, {
      token: adminToken, body: { managerId: b.id },
    });

    // A → B → C → A. The recursive walk is what catches a cycle at any depth.
    const res = await api('POST', `/api/hr/employees/${a.id}/manager`, {
      token: adminToken,
      body: { managerId: c.id },
    });
    expect(res.status).toBe(400);
  });

  it('clears a reporting line with null', async () => {
    const manager = await makeEmployee();
    const report = await makeEmployee();
    await api('POST', `/api/hr/employees/${report.id}/manager`, {
      token: adminToken, body: { managerId: manager.id },
    });

    const res = await api('POST', `/api/hr/employees/${report.id}/manager`, {
      token: adminToken,
      body: { managerId: null },
    });
    expect(res.status).toBe(200);
    expect(
      (res.body.data as { employee: { manager: unknown } }).employee.manager,
    ).toBeNull();
  });

  it('refuses a departed employee as a manager', async () => {
    const leaver = await makeEmployee();
    await api('POST', `/api/hr/employees/${leaver.id}/status`, {
      token: adminToken,
      body: { status: 'EXITED', exitDate: '2026-06-30' },
    });

    const report = await makeEmployee();
    const res = await api('POST', `/api/hr/employees/${report.id}/manager`, {
      token: adminToken,
      body: { managerId: leaver.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MANAGER_NOT_EMPLOYED');
  });

  it('requires ASSIGN, not merely EDIT', async () => {
    const manager = await makeEmployee();
    const report = await makeEmployee();

    // The coordinator holds VIEW, CREATE and EDIT — a reporting line is not
    // authority over somebody's employment terms, so it needs ASSIGN.
    const res = await api('POST', `/api/hr/employees/${report.id}/manager`, {
      token: coordinatorToken,
      body: { managerId: manager.id },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  Status
// ---------------------------------------------------------------------------

describe('employment status', () => {
  it('moves to ON_NOTICE and records it', async () => {
    const employee = await makeEmployee();

    const res = await api('POST', `/api/hr/employees/${employee.id}/status`, {
      token: adminToken,
      body: { status: 'ON_NOTICE', note: 'Resigned' },
    });
    expect(res.status).toBe(200);
    expect((res.body.data as { employee: { status: string } }).employee.status).toBe('ON_NOTICE');

    const history = (
      (await api('GET', `/api/hr/employees/${employee.id}/history`, { token: adminToken }))
        .body.data as { history: { eventType: string; note: string | null }[] }
    ).history;
    const entry = history.find((h) => h.eventType === 'STATUS_CHANGED');
    expect(entry?.note).toBe('Resigned');
  });

  it('requires an exit date for EXITED', async () => {
    const employee = await makeEmployee();
    const res = await api('POST', `/api/hr/employees/${employee.id}/status`, {
      token: adminToken,
      body: { status: 'EXITED' },
    });
    // The schema refuses it, and the CHECK would refuse it again.
    expect(res.status).toBe(422);
  });

  it('stores the exit date with EXITED and clears it on return', async () => {
    const employee = await makeEmployee();

    const exited = await api('POST', `/api/hr/employees/${employee.id}/status`, {
      token: adminToken,
      body: { status: 'EXITED', exitDate: '2026-08-31' },
    });
    expect(exited.status).toBe(200);
    expect(
      (exited.body.data as { employee: { exitDate: string | null } }).employee.exitDate,
    ).not.toBeNull();

    // Reinstated: the date must go, or the record says both employed and departed.
    const back = await api('POST', `/api/hr/employees/${employee.id}/status`, {
      token: adminToken,
      body: { status: 'ACTIVE' },
    });
    expect(back.status).toBe(200);
    expect(
      (back.body.data as { employee: { exitDate: string | null } }).employee.exitDate,
    ).toBeNull();
  });

  it('refuses an exit date before the joining date', async () => {
    const employee = await makeEmployee({ joiningDate: '2026-05-01' });
    const res = await api('POST', `/api/hr/employees/${employee.id}/status`, {
      token: adminToken,
      body: { status: 'EXITED', exitDate: '2026-01-01' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXIT_BEFORE_JOINING');
  });

  it('refuses a no-op status change', async () => {
    const employee = await makeEmployee();
    const res = await api('POST', `/api/hr/employees/${employee.id}/status`, {
      token: adminToken,
      body: { status: 'ACTIVE' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STATUS_UNCHANGED');
  });

  it('has no DELETE route — status is the lifecycle', async () => {
    const employee = await makeEmployee();
    const res = await api('DELETE', `/api/hr/employees/${employee.id}`, { token: adminToken });
    // HR records are the business's history of its people; erasing them would make
    // that history optional.
    expect([404, 405]).toContain(res.status);
    expect(await prisma.employee.count({ where: { id: employee.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  User linking
// ---------------------------------------------------------------------------

describe('linking a CRM account', () => {
  it('links an existing account and records it', async () => {
    const employee = await makeEmployee();
    const account = await makeUser('USER');

    const res = await api('POST', `/api/hr/employees/${employee.id}/user`, {
      token: adminToken,
      body: { userId: account.id },
    });
    expect(res.status).toBe(200);

    const linked = (res.body.data as { employee: { account: { id: string } | null } }).employee;
    expect(linked.account?.id).toBe(account.id);

    const history = (
      (await api('GET', `/api/hr/employees/${employee.id}/history`, { token: adminToken }))
        .body.data as { history: { eventType: string }[] }
    ).history;
    expect(history.map((h) => h.eventType)).toContain('USER_LINKED');
  });

  it('refuses an account already linked to another employee', async () => {
    const account = await makeUser('USER');
    const first = await makeEmployee();
    await api('POST', `/api/hr/employees/${first.id}/user`, {
      token: adminToken, body: { userId: account.id },
    });

    const second = await makeEmployee();
    const res = await api('POST', `/api/hr/employees/${second.id}/user`, {
      token: adminToken,
      body: { userId: account.id },
    });
    // One User maps to at most one Employee — enforced by a unique index as well.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USER_ALREADY_LINKED');
  });

  it('refuses a second account for one employee', async () => {
    const employee = await makeEmployee();
    const first = await makeUser('USER');
    const second = await makeUser('USER');

    await api('POST', `/api/hr/employees/${employee.id}/user`, {
      token: adminToken, body: { userId: first.id },
    });

    const res = await api('POST', `/api/hr/employees/${employee.id}/user`, {
      token: adminToken,
      body: { userId: second.id },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMPLOYEE_ALREADY_LINKED');
  });

  it('refuses an account that does not exist', async () => {
    const employee = await makeEmployee();
    const res = await api('POST', `/api/hr/employees/${employee.id}/user`, {
      token: adminToken,
      body: { userId: 'clzz0000000000000000000z' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('unlinks without deleting either record or changing permissions', async () => {
    const employee = await makeEmployee();
    const account = await makeUser('USER');
    await grant(account.id, 'HR_EMPLOYEE', ['VIEW']);

    await api('POST', `/api/hr/employees/${employee.id}/user`, {
      token: adminToken, body: { userId: account.id },
    });

    const permsBefore = await prisma.userModulePermission.count({
      where: { userId: account.id },
    });

    const res = await api('DELETE', `/api/hr/employees/${employee.id}/user`, {
      token: adminToken,
      body: { note: 'Wrong person' },
    });
    expect(res.status).toBe(200);
    expect((res.body.data as { employee: { account: unknown } }).employee.account).toBeNull();

    /*
      Both rows survive and the account keeps every permission. Unlinking corrects a
      data-entry error; revoking access is user management's job, and conflating the
      two would make a correction silently remove somebody's CRM access.
    */
    expect(await prisma.user.count({ where: { id: account.id } })).toBe(1);
    expect(await prisma.employee.count({ where: { id: employee.id } })).toBe(1);
    expect(
      await prisma.userModulePermission.count({ where: { userId: account.id } }),
    ).toBe(permsBefore);
  });

  it('requires ASSIGN', async () => {
    const employee = await makeEmployee();
    const account = await makeUser('USER');

    const res = await api('POST', `/api/hr/employees/${employee.id}/user`, {
      token: coordinatorToken,
      body: { userId: account.id },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  Authorization and scope
// ---------------------------------------------------------------------------

describe('authorization', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await api('GET', '/api/hr/employees')).status).toBe(401);
    expect((await api('GET', '/api/hr/departments')).status).toBe(401);
  });

  it('lets a VIEW-only user read but not write', async () => {
    expect((await api('GET', '/api/hr/employees', { token: viewerToken })).status).toBe(200);

    const res = await api('POST', '/api/hr/employees', {
      token: viewerToken,
      body: { firstName: 'No', lastName: 'Rights', workEmail: testEmail(), joiningDate: '2026-02-01' },
    });
    expect(res.status).toBe(403);
  });

  it('lets a coordinator create and edit', async () => {
    const res = await api('POST', '/api/hr/employees', {
      token: coordinatorToken,
      body: {
        firstName: 'Coordinator', lastName: 'Made', workEmail: testEmail(),
        joiningDate: '2026-02-01',
      },
    });
    expect(res.status).toBe(201);
  });

  it('separates HR_EMPLOYEE from HR_ADMIN', async () => {
    /*
      The coordinator maintains employee records and has no HR_ADMIN, so they
      cannot restructure the company. One namespace would have made these the same
      grant.
    */
    const res = await api('POST', '/api/hr/departments', {
      token: coordinatorToken,
      body: { name: 'Not Allowed', code: testCode('NOPE') },
    });
    expect(res.status).toBe(403);
  });

  it('shows an outsider with no reports an empty directory, not an error', async () => {
    const res = await api('GET', '/api/hr/employees', { token: outsiderToken });

    // A permitted-but-unscoped reader gets nothing rather than a 403: they are
    // signed in and the endpoint exists, there is simply nothing in their scope.
    expect(res.status).toBe(200);
    expect((res.body.data as { employees: unknown[] }).employees).toEqual([]);
  });

  it('reports a record outside scope as missing, never as forbidden', async () => {
    const employee = await makeEmployee();

    const res = await api('GET', `/api/hr/employees/${employee.id}`, { token: outsiderToken });
    /*
      404 rather than 403, deliberately. Saying "this exists but is not yours"
      would let somebody enumerate the directory by probing ids and learn who works
      here without being entitled to.
    */
    expect(res.status).toBe(404);
  });

  it('lets a manager see their own reports without any HR permission', async () => {
    // The outsider holds no HR grant. Linking them to an employee who manages
    // somebody is what brings their team into scope.
    const managerEmployee = await makeEmployee({ firstName: 'Scoped', lastName: 'Manager' });
    await api('POST', `/api/hr/employees/${managerEmployee.id}/user`, {
      token: adminToken,
      body: { userId: outsider.id },
    });

    const report = await makeEmployee({ firstName: 'Scoped', lastName: 'Report' });
    await api('POST', `/api/hr/employees/${report.id}/manager`, {
      token: adminToken,
      body: { managerId: managerEmployee.id },
    });

    const res = await api('GET', '/api/hr/employees', { token: outsiderToken });
    expect(res.status).toBe(200);

    const ids = (res.body.data as { employees: { id: string }[] }).employees.map((e) => e.id);
    expect(ids).toContain(report.id);
    expect(ids).toContain(managerEmployee.id);
  });

  it('does not let that manager see somebody else’s team', async () => {
    const stranger = await makeEmployee({ firstName: 'Not', lastName: 'Mine' });

    const res = await api('GET', '/api/hr/employees', { token: outsiderToken });
    const ids = (res.body.data as { employees: { id: string }[] }).employees.map((e) => e.id);
    expect(ids).not.toContain(stranger.id);
  });

  it('does not let that manager edit their own report', async () => {
    const report = await prisma.employee.findFirst({
      where: { workEmail: { startsWith: RUN_PREFIX }, manager: { user: { id: outsider.id } } },
      select: { id: true },
    });
    expect(report).not.toBeNull();

    /*
      Seeing a team and changing its members' employment terms are different
      privileges. A reporting line is not authority over somebody's grade,
      department or status, so writing needs the module permission regardless of
      scope.
    */
    const res = await api('PATCH', `/api/hr/employees/${report!.id}`, {
      token: outsiderToken,
      body: { location: 'Somewhere else' },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  Overview and audit
// ---------------------------------------------------------------------------

describe('the overview and the audit trail', () => {
  it('counts employees, departments and designations', async () => {
    const res = await api('GET', '/api/hr/overview', { token: adminToken });
    expect(res.status).toBe(200);

    const overview = res.body.data as {
      overview: {
        totalEmployees: number;
        employedCount: number;
        activeDepartments: number;
        activeDesignations: number;
      };
    };
    expect(overview.overview.totalEmployees).toBeGreaterThan(0);
    expect(overview.overview.employedCount).toBeLessThanOrEqual(
      overview.overview.totalEmployees,
    );
    expect(overview.overview.activeDepartments).toBeGreaterThan(0);
  });

  it('audits a creation without recording personal contact detail', async () => {
    const employee = await makeEmployee({ phone: '+919812345678' });

    const entry = await prisma.auditLog.findFirst({
      where: { entityType: 'Employee', entityId: employee.id, action: 'HR_EMPLOYEE_CREATED' },
      select: { newValue: true },
    });
    expect(entry).not.toBeNull();

    /*
      Structural facts only. An audit table that accumulates personal data becomes
      its own disclosure risk, and Phase 1 holds no salary, bank or tax field to
      leak even by accident.
    */
    const serialised = JSON.stringify(entry!.newValue);
    expect(serialised).not.toContain('919812345678');
    expect(serialised).toContain('employeeId');
  });

  it('audits a status change with both ends', async () => {
    const employee = await makeEmployee();
    await api('POST', `/api/hr/employees/${employee.id}/status`, {
      token: adminToken,
      body: { status: 'INACTIVE' },
    });

    const entry = await prisma.auditLog.findFirst({
      where: {
        entityType: 'Employee',
        entityId: employee.id,
        action: 'HR_EMPLOYEE_STATUS_CHANGED',
      },
      select: { oldValue: true, newValue: true },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.oldValue)).toContain('ACTIVE');
    expect(JSON.stringify(entry!.newValue)).toContain('INACTIVE');
  });
});
