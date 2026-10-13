/**
 * HR Phase 2 — Leave, end to end.
 *
 * The properties worth proving against a real database:
 *
 *   - that a balance never goes negative, and that two concurrent requests
 *     cannot both be approved into the same remaining day;
 *   - that the ledger and the cached balance always agree, because the balance is
 *     only ever a replay of the ledger;
 *   - that approval writes the attendance for every working day, and cancellation
 *     unwinds it — in the same transaction as the balance movement;
 *   - that an approved leave is never overwritten by ABSENT;
 *   - that nobody approves their own leave, and an unrelated manager cannot;
 *   - that holidays and week-offs inside a range cost nothing.
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
let adminToken: string;
let worker: TestUser;
let workerToken: string;
let workerEmployeeId: string;
let manager: TestUser;
let managerToken: string;
let managerEmployeeId: string;
let stranger: TestUser;
let strangerToken: string;
let strangerEmployeeId: string;

let departmentId: string;
let leaveTypeId: string;
/** A type that forbids half days, for the pairing tests. */
let noHalfDayTypeId: string;

/** 2026 — every date in this suite is in it, so one period year throughout. */
const YEAR = 2026;

let codeSeq = 0;
const testCode = (stem: string): string => {
  codeSeq += 1;
  return `ZZT${stem}${codeSeq}`.toUpperCase().slice(0, 20);
};

let emailSeq = 0;
const testEmail = (): string => {
  emailSeq += 1;
  return `${RUN_PREFIX}-lv${emailSeq}@test.invalid`;
};

async function makeEmployee(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await api('POST', '/api/hr/employees', {
    token: adminToken,
    body: {
      firstName: 'Leave',
      lastName: 'Tester',
      workEmail: testEmail(),
      joiningDate: '2026-01-05',
      departmentId,
      ...overrides,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.data as { employee: { id: string } }).employee.id;
}

async function link(employeeId: string, userId: string): Promise<void> {
  const res = await api('POST', `/api/hr/employees/${employeeId}/user`, {
    token: adminToken,
    body: { userId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Resets one employee's leave state so each test starts from a known balance. */
async function resetLeave(employeeId: string): Promise<void> {
  await prisma.attendanceRecord.deleteMany({ where: { employeeId } });
  await prisma.leaveLedgerEntry.deleteMany({ where: { employeeId } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId } });
  await prisma.leaveBalance.deleteMany({ where: { employeeId } });
}

/** Gives an employee a known balance by allocating their entitlement. */
async function allocate(employeeId: string, typeId = leaveTypeId): Promise<void> {
  const res = await api('POST', '/api/hr/leave/balances/allocate', {
    token: adminToken,
    body: { employeeId, leaveTypeId: typeId, periodYear: YEAR },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const balanceOf = async (
  employeeId: string,
  typeId = leaveTypeId,
): Promise<Record<string, string>> => {
  const res = await api(
    'GET',
    `/api/hr/leave/balances?employeeId=${employeeId}&periodYear=${YEAR}`,
    { token: adminToken },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const balances = (res.body.data as { balances: { leaveType: { id: string } }[] }).balances;
  return (balances.find((b) => b.leaveType.id === typeId) ?? {}) as Record<string, string>;
};

async function applyLeave(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return api('POST', '/api/hr/leave/requests', { token, body }) as Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
}

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  worker = await makeUser('USER');
  manager = await makeUser('USER');
  stranger = await makeUser('USER');

  adminToken = await mintToken(admin.id, { role: 'ADMIN' });
  workerToken = await mintToken(worker.id, { role: 'USER' });
  managerToken = await mintToken(manager.id, { role: 'USER' });
  strangerToken = await mintToken(stranger.id, { role: 'USER' });

  const dept = await api('POST', '/api/hr/departments', {
    token: adminToken,
    body: { name: 'Leave Dept', code: testCode('LDEPT') },
  });
  departmentId = (dept.body.data as { department: { id: string } }).department.id;

  /*
    An attendance policy with no week-offs, so a date range's cost depends only on
    the holidays each test configures. With Saturday/Sunday off, every assertion
    about day counts would shift depending on which weekday the fixed dates fall
    on — the tests would still be correct but would read as arbitrary.
  */
  await api('POST', '/api/hr/attendance-policies', {
    token: adminToken,
    body: {
      name: 'Leave Test Policy',
      code: testCode('LPOL'),
      weekOffDays: [],
      departmentId,
    },
  });

  const type = await api('POST', '/api/hr/leave-types', {
    token: adminToken,
    body: { name: 'ZZT Annual', code: testCode('ANN'), halfDayAllowed: true },
  });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  leaveTypeId = (type.body.data as { leaveType: { id: string } }).leaveType.id;

  const strict = await api('POST', '/api/hr/leave-types', {
    token: adminToken,
    body: { name: 'ZZT No Half', code: testCode('NOHALF'), halfDayAllowed: false },
  });
  noHalfDayTypeId = (strict.body.data as { leaveType: { id: string } }).leaveType.id;

  // 20 days a year, no notice period, no consecutive cap — the caps get their own
  // policies inside the tests that need them.
  const policy = await api('POST', '/api/hr/leave-policies', {
    token: adminToken,
    body: { leaveTypeId, departmentId, annualEntitlement: 20 },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(201);

  await api('POST', '/api/hr/leave-policies', {
    token: adminToken,
    body: { leaveTypeId: noHalfDayTypeId, departmentId, annualEntitlement: 5 },
  });

  managerEmployeeId = await makeEmployee({ firstName: 'Leave', lastName: 'Manager' });
  workerEmployeeId = await makeEmployee({ firstName: 'Leave', lastName: 'Worker' });
  strangerEmployeeId = await makeEmployee({ firstName: 'Leave', lastName: 'Stranger' });

  await link(managerEmployeeId, manager.id);
  await link(workerEmployeeId, worker.id);
  await link(strangerEmployeeId, stranger.id);

  await api('POST', `/api/hr/employees/${workerEmployeeId}/manager`, {
    token: adminToken,
    body: { managerId: managerEmployeeId },
  });
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Types and policies
// ---------------------------------------------------------------------------

describe('leave types', () => {
  it('creates one and refuses a duplicate code', async () => {
    const code = testCode('DUPT');
    expect(
      (
        await api('POST', '/api/hr/leave-types', {
          token: adminToken,
          body: { name: 'ZZT First', code },
        })
      ).status,
    ).toBe(201);

    const res = await api('POST', '/api/hr/leave-types', {
      token: adminToken,
      body: { name: 'ZZT Second', code },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAVE_TYPE_CODE_TAKEN');
  });

  it('uppercases the code, so "sick" and "SICK" cannot both exist', async () => {
    const stem = testCode('CASE');
    expect(
      (
        await api('POST', '/api/hr/leave-types', {
          token: adminToken,
          body: { name: 'ZZT Lower', code: stem.toLowerCase() },
        })
      ).status,
    ).toBe(201);

    const res = await api('POST', '/api/hr/leave-types', {
      token: adminToken,
      body: { name: 'ZZT Upper', code: stem },
    });
    expect(res.status).toBe(409);
  });

  it('refuses configuration without HR_ADMIN', async () => {
    const res = await api('POST', '/api/hr/leave-types', {
      token: workerToken,
      body: { name: 'ZZT Sneaky', code: testCode('SNEAK') },
    });
    expect(res.status).toBe(403);
  });

  it('lets any employee read the type list, for the apply form', async () => {
    expect((await api('GET', '/api/hr/leave-types', { token: workerToken })).status).toBe(200);
  });

  it('does not let an ordinary employee read policies', async () => {
    // Entitlements by department are not directory information. The employee's
    // own entitlement reaches them through their balance.
    expect((await api('GET', '/api/hr/leave-policies', { token: workerToken })).status).toBe(403);
  });

  it('refuses a second policy for the same type and scope', async () => {
    const res = await api('POST', '/api/hr/leave-policies', {
      token: adminToken,
      body: { leaveTypeId, departmentId, annualEntitlement: 10 },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAVE_POLICY_EXISTS');
  });
});

// ---------------------------------------------------------------------------
//  Balances
// ---------------------------------------------------------------------------

describe('balances', () => {
  it('allocates the policy entitlement and derives available', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const balance = await balanceOf(workerEmployeeId);
    expect(balance.allocated).toBe('20.00');
    expect(balance.used).toBe('0.00');
    expect(balance.reserved).toBe('0.00');
    // Derived from the five components, never stored as a column.
    expect(balance.available).toBe('20.00');
  });

  it('refuses a second allocation for the same period', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await api('POST', '/api/hr/leave/balances/allocate', {
      token: adminToken,
      body: { employeeId: workerEmployeeId, leaveTypeId, periodYear: YEAR },
    });
    // Idempotent by construction: allocation is the operation most likely to be
    // run by hand twice.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ALLOCATED');
  });

  it('adjusts a balance and records a ledger entry', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await api('POST', '/api/hr/leave/balances/adjust', {
      token: adminToken,
      body: {
        employeeId: workerEmployeeId,
        leaveTypeId,
        periodYear: YEAR,
        days: 2,
        note: 'Goodwill days for the migration weekend',
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const balance = await balanceOf(workerEmployeeId);
    expect(balance.adjusted).toBe('2.00');
    expect(balance.available).toBe('22.00');

    const entries = await prisma.leaveLedgerEntry.count({
      where: { employeeId: workerEmployeeId, reason: 'ADJUSTMENT' },
    });
    // A balance that is the sum of its ledger can be explained; a bare number
    // somebody edited cannot be defended.
    expect(entries).toBe(1);
  });

  it('refuses an adjustment that would go negative', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await api('POST', '/api/hr/leave/balances/adjust', {
      token: adminToken,
      body: {
        employeeId: workerEmployeeId,
        leaveTypeId,
        periodYear: YEAR,
        days: -50,
        note: 'Trying to overdraw the balance',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BALANCE_WOULD_GO_NEGATIVE');
  });

  it('refuses an adjustment of zero days', async () => {
    const res = await api('POST', '/api/hr/leave/balances/adjust', {
      token: adminToken,
      body: {
        employeeId: workerEmployeeId,
        leaveTypeId,
        periodYear: YEAR,
        days: 0,
        note: 'Changes nothing at all',
      },
    });
    expect(res.status).toBe(422);
  });

  it('refuses an adjustment without HR_LEAVE:EDIT', async () => {
    const res = await api('POST', '/api/hr/leave/balances/adjust', {
      token: workerToken,
      body: {
        employeeId: workerEmployeeId,
        leaveTypeId,
        periodYear: YEAR,
        days: 5,
        note: 'Granting myself a week off',
      },
    });
    expect(res.status).toBe(403);
  });

  it('lets an employee read their own balance with no HR grant', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await api('GET', `/api/hr/leave/balances?periodYear=${YEAR}`, {
      token: workerToken,
    });
    expect(res.status).toBe(200);
    expect(
      (res.body.data as { balances: unknown[] }).balances.length,
    ).toBeGreaterThan(0);
  });

  it('returns an empty list for an account with no employee record', async () => {
    /*
      An administrator who is not themselves on the payroll, or a shared operations
      login, has no balances — and that is nothing to show rather than a refusal.
      Returning 403 made the leave page render an error block for an administrator
      who had done nothing wrong, which real browser QA caught.

      Writing still refuses: applying for leave needs a record for it to belong to.
    */
    const orphan = await makeUser('ADMIN');
    const orphanToken = await mintToken(orphan.id, { role: 'ADMIN' });

    const res = await api('GET', '/api/hr/leave/balances', { token: orphanToken });
    expect(res.status).toBe(200);
    expect((res.body.data as { balances: unknown[] }).balances).toEqual([]);

    const applied = await applyLeave(orphanToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      reason: 'No employee record behind this administrator account',
    });
    expect(applied.status).toBe(403);
    expect(applied.body.code).toBe('NO_EMPLOYEE_RECORD');
  });

  it('does not let an employee read somebody else’s balance', async () => {
    const res = await api(
      'GET',
      `/api/hr/leave/balances?employeeId=${strangerEmployeeId}&periodYear=${YEAR}`,
      { token: workerToken },
    );
    expect(res.status).toBe(404);
  });

  it('carries a balance forward, capped by the type limit', async () => {
    const capped = await api('POST', '/api/hr/leave-types', {
      token: adminToken,
      body: {
        name: 'ZZT Carry',
        code: testCode('CARRY'),
        carryForwardEnabled: true,
        carryForwardLimit: 3,
      },
    });
    const typeId = (capped.body.data as { leaveType: { id: string } }).leaveType.id;
    await api('POST', '/api/hr/leave-policies', {
      token: adminToken,
      body: { leaveTypeId: typeId, departmentId, annualEntitlement: 10 },
    });

    await allocate(workerEmployeeId, typeId);

    const res = await api('POST', '/api/hr/leave/balances/carry-forward', {
      token: adminToken,
      body: { employeeId: workerEmployeeId, leaveTypeId: typeId, periodYear: YEAR },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const next = await prisma.leaveBalance.findFirst({
      where: { employeeId: workerEmployeeId, leaveTypeId: typeId, periodYear: YEAR + 1 },
      select: { carriedForward: true },
    });
    /*
      Ten available, limit three: three carried. Compared as a number because this
      reads the column directly — `Prisma.Decimal.toString()` renders 3 as "3",
      while the API canonicalises every day figure to "3.00". The API shape is
      asserted through balanceOf elsewhere.
    */
    expect(Number(next?.carriedForward)).toBe(3);
  });

  it('refuses carry forward when the type disallows it', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await api('POST', '/api/hr/leave/balances/carry-forward', {
      token: adminToken,
      body: { employeeId: workerEmployeeId, leaveTypeId, periodYear: YEAR },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CARRY_FORWARD_DISABLED');
  });
});

// ---------------------------------------------------------------------------
//  Day counting through the API
// ---------------------------------------------------------------------------

describe('day counting', () => {
  it('previews a range before applying', async () => {
    const res = await api(
      'GET',
      '/api/hr/leave/preview?startDate=2026-06-01&endDate=2026-06-03',
      { token: workerToken },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const preview = (res.body.data as { preview: Record<string, unknown> }).preview;
    expect(preview.totalDays).toBe(3);
    expect(preview.leaveDays).toBe('3.00');
  });

  it('excludes a holiday in the middle', async () => {
    await api('POST', '/api/hr/holidays', {
      token: adminToken,
      body: { name: 'ZZT Mid Holiday', holidayDate: '2026-06-10' },
    });

    const res = await api(
      'GET',
      '/api/hr/leave/preview?startDate=2026-06-09&endDate=2026-06-11',
      { token: workerToken },
    );
    const preview = (res.body.data as { preview: Record<string, unknown> }).preview;
    expect(preview.totalDays).toBe(3);
    expect(preview.holidayDays).toBe(1);
    // Taking leave across a public holiday must not cost the holiday.
    expect(preview.leaveDays).toBe('2.00');
  });

  it('charges a half day as 0.5', async () => {
    const res = await api(
      'GET',
      '/api/hr/leave/preview?startDate=2026-06-15&endDate=2026-06-15&isHalfDay=true',
      { token: workerToken },
    );
    expect((res.body.data as { preview: { leaveDays: string } }).preview.leaveDays).toBe('0.50');
  });
});

// ---------------------------------------------------------------------------
//  Applying
// ---------------------------------------------------------------------------

describe('applying for leave', () => {
  it('creates a pending request and reserves the days', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      reason: 'Family visit over three days',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const request = (res.body.data as { request: Record<string, unknown> }).request;
    expect(request.status).toBe('PENDING');
    expect(request.requestedDays).toBe('3.00');

    const balance = await balanceOf(workerEmployeeId);
    /*
      Reserved rather than used: a pending request holds the days so two of them
      cannot both be approved into the same remaining day. `available` subtracts
      it, which is what makes the hold meaningful.
    */
    expect(balance.reserved).toBe('3.00');
    expect(balance.used).toBe('0.00');
    expect(balance.available).toBe('17.00');
  });

  it('refuses an end date before the start', async () => {
    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-10',
      endDate: '2026-07-08',
      reason: 'Travelling backwards in time',
    });
    expect(res.status).toBe(422);
  });

  it('refuses a half day spanning more than one date', async () => {
    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-10',
      endDate: '2026-07-11',
      isHalfDay: true,
      halfDayPeriod: 'FIRST_HALF',
      reason: 'Half a day across two dates',
    });
    expect(res.status).toBe(422);
  });

  it('refuses a half day that does not say which half', async () => {
    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-10',
      endDate: '2026-07-10',
      isHalfDay: true,
      reason: 'Half a day, unspecified',
    });
    expect(res.status).toBe(422);
  });

  it('refuses a half day on a type that forbids it', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId, noHalfDayTypeId);

    const res = await applyLeave(workerToken, {
      leaveTypeId: noHalfDayTypeId,
      startDate: '2026-07-20',
      endDate: '2026-07-20',
      isHalfDay: true,
      halfDayPeriod: 'FIRST_HALF',
      reason: 'Half a day on a strict type',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('HALF_DAY_NOT_ALLOWED');
  });

  it('refuses more days than the balance covers', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-08-01',
      endDate: '2026-09-15',
      reason: 'A month and a half, which the balance cannot cover',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('refuses an overlapping request', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);
    expect(
      (
        await applyLeave(workerToken, {
          leaveTypeId,
          startDate: '2026-07-01',
          endDate: '2026-07-05',
          reason: 'The first request for these dates',
        })
      ).status,
    ).toBe(201);

    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-03',
      endDate: '2026-07-07',
      reason: 'Overlapping the first request',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAVE_OVERLAPS');
  });

  it('refuses a range with no working days', async () => {
    await api('POST', '/api/hr/holidays', {
      token: adminToken,
      body: { name: 'ZZT Solo Holiday', holidayDate: '2026-10-02' },
    });

    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-10-02',
      endDate: '2026-10-02',
      reason: 'Leave on a day the office is already closed',
    });
    // Costs nothing, so it is refused rather than stored as a zero-day leave —
    // a CHECK requires requestedDays > 0.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_WORKING_DAYS');
  });

  it('enforces a notice period', async () => {
    const noticeType = await api('POST', '/api/hr/leave-types', {
      token: adminToken,
      body: { name: 'ZZT Notice', code: testCode('NOTICE') },
    });
    const typeId = (noticeType.body.data as { leaveType: { id: string } }).leaveType.id;
    await api('POST', '/api/hr/leave-policies', {
      token: adminToken,
      body: { leaveTypeId: typeId, departmentId, annualEntitlement: 10, minNoticeDays: 30 },
    });
    await allocate(workerEmployeeId, typeId);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await applyLeave(workerToken, {
      leaveTypeId: typeId,
      startDate: tomorrow,
      endDate: tomorrow,
      reason: 'Tomorrow, against a thirty-day notice policy',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_NOTICE');
  });

  it('enforces a maximum consecutive run', async () => {
    const cappedType = await api('POST', '/api/hr/leave-types', {
      token: adminToken,
      body: { name: 'ZZT Capped', code: testCode('CAP') },
    });
    const typeId = (cappedType.body.data as { leaveType: { id: string } }).leaveType.id;
    await api('POST', '/api/hr/leave-policies', {
      token: adminToken,
      body: {
        leaveTypeId: typeId,
        departmentId,
        annualEntitlement: 20,
        maxConsecutiveDays: 3,
      },
    });
    await allocate(workerEmployeeId, typeId);

    const res = await applyLeave(workerToken, {
      leaveTypeId: typeId,
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      reason: 'Five consecutive days against a three-day cap',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXCEEDS_MAX_CONSECUTIVE');
  });

  it('refuses somebody with no employee record', async () => {
    const orphan = await makeUser('USER');
    const orphanToken = await mintToken(orphan.id, { role: 'USER' });

    const res = await applyLeave(orphanToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      reason: 'No employee record behind this account',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_EMPLOYEE_RECORD');
  });

  it('holds days for only one of two simultaneous requests when the balance is tight', async () => {
    await resetLeave(workerEmployeeId);
    await api('POST', '/api/hr/leave/balances/adjust', {
      token: adminToken,
      body: {
        employeeId: workerEmployeeId,
        leaveTypeId,
        periodYear: YEAR,
        days: 1,
        note: 'Exactly one day available for the race test',
      },
    });

    /*
      The race `lockBalance` exists for. Both requests ask for the single
      remaining day; without the row lock both would read "1 available" and both
      would reserve it, leaving the balance at -1.
    */
    const [a, b] = await Promise.all([
      applyLeave(workerToken, {
        leaveTypeId,
        startDate: '2026-07-20',
        endDate: '2026-07-20',
        reason: 'First of two simultaneous requests',
      }),
      applyLeave(workerToken, {
        leaveTypeId,
        startDate: '2026-07-21',
        endDate: '2026-07-21',
        reason: 'Second of two simultaneous requests',
      }),
    ]);

    const created = [a, b].filter((r) => r.status === 201);
    expect(created).toHaveLength(1);

    const balance = await balanceOf(workerEmployeeId);
    expect(balance.available).toBe('0.00');
    // Never overdrawn: the row lock is what makes this hold under concurrency.
    expect(balance.available?.startsWith('-')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Deciding
// ---------------------------------------------------------------------------

describe('deciding leave', () => {
  async function pending(): Promise<string> {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);
    const res = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      reason: 'Two days for the decision tests',
    });
    expect(res.status).toBe(201);
    return (res.body.data as { request: { id: string } }).request.id;
  }

  it('lets the manager approve, moving reserved to used', async () => {
    const id = await pending();

    const res = await api(`POST`, `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const balance = await balanceOf(workerEmployeeId);
    expect(balance.reserved).toBe('0.00');
    expect(balance.used).toBe('2.00');
    expect(balance.available).toBe('18.00');
  });

  it('writes LEAVE attendance for every working day', async () => {
    const id = await pending();
    await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });

    const records = await prisma.attendanceRecord.findMany({
      where: { employeeId: workerEmployeeId, leaveRequestId: id },
      select: { attendanceDate: true, status: true },
      orderBy: { attendanceDate: 'asc' },
    });

    // Two working days, two rows, both LEAVE — so resolution never calls them
    // ABSENT, which is the rule the brief singles out.
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.status === 'LEAVE')).toBe(true);
  });

  it('releases the hold on rejection and writes no attendance', async () => {
    const id = await pending();

    const res = await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'REJECTED', note: 'Team is short that week' },
    });
    expect(res.status).toBe(200);

    const balance = await balanceOf(workerEmployeeId);
    expect(balance.reserved).toBe('0.00');
    expect(balance.used).toBe('0.00');
    // A rejected request costs nothing.
    expect(balance.available).toBe('20.00');

    const records = await prisma.attendanceRecord.count({ where: { leaveRequestId: id } });
    expect(records).toBe(0);
  });

  it('requires a reason when rejecting', async () => {
    const id = await pending();
    const res = await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'REJECTED' },
    });
    expect(res.status).toBe(422);
  });

  it('refuses the requester approving their own leave', async () => {
    const id = await pending();
    const res = await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: workerToken,
      body: { decision: 'APPROVED' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses an unrelated manager', async () => {
    const id = await pending();
    const res = await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: strangerToken,
      body: { decision: 'APPROVED' },
    });
    expect(res.status).toBe(403);
  });

  it('cannot be decided twice', async () => {
    const id = await pending();
    expect(
      (
        await api('POST', `/api/hr/leave/requests/${id}/decide`, {
          token: managerToken,
          body: { decision: 'APPROVED' },
        })
      ).status,
    ).toBe(200);

    const second = await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'REJECTED', note: 'Changed my mind' },
    });
    expect([400, 403]).toContain(second.status);
  });

  it('lets only one of two simultaneous approvals win, and charges once', async () => {
    const id = await pending();

    const [a, b] = await Promise.all([
      api('POST', `/api/hr/leave/requests/${id}/decide`, {
        token: managerToken,
        body: { decision: 'APPROVED' },
      }),
      api('POST', `/api/hr/leave/requests/${id}/decide`, {
        token: adminToken,
        body: { decision: 'APPROVED' },
      }),
    ]);

    expect([a, b].filter((r) => r.status === 200)).toHaveLength(1);

    const balance = await balanceOf(workerEmployeeId);
    // Charged exactly once: a double approval would have taken four days.
    expect(balance.used).toBe('2.00');
  });

  it('keeps the ledger and the balance in agreement', async () => {
    const id = await pending();
    await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });

    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { employeeId: workerEmployeeId, leaveTypeId },
      select: { reason: true, days: true },
    });

    /*
      The invariant the whole design protects: replaying the ledger must give the
      stored balance. Allocation +20, reservation -2, release +2, consumption -2.
    */
    const net = entries.reduce((total, e) => total + Number(e.days), 0);
    const balance = await balanceOf(workerEmployeeId);
    expect(Number(balance.available)).toBeCloseTo(net, 2);
    expect(entries.map((e) => e.reason).sort()).toEqual([
      'ALLOCATION',
      'CONSUMPTION',
      'RESERVATION',
      'RESERVATION_RELEASE',
    ]);
  });
});

// ---------------------------------------------------------------------------
//  Cancellation
// ---------------------------------------------------------------------------

describe('cancelling leave', () => {
  it('withdraws a pending request and releases the hold', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);
    const created = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      reason: 'To be withdrawn before a decision',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;

    const res = await api('POST', `/api/hr/leave/requests/${id}/cancel`, {
      token: workerToken,
      body: { note: 'Plans changed' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.data as { request: { status: string } }).request.status).toBe('CANCELLED');

    const balance = await balanceOf(workerEmployeeId);
    expect(balance.reserved).toBe('0.00');
    expect(balance.available).toBe('20.00');
  });

  it('refuses somebody else withdrawing a pending request', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);
    const created = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      reason: 'Somebody else will try to cancel this',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;

    const res = await api('POST', `/api/hr/leave/requests/${id}/cancel`, {
      token: strangerToken,
      body: {},
    });
    expect(res.status).toBe(403);
  });

  it('cancels an approved future leave, restoring the balance and unwinding attendance', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    // Far future, so the "already started" rule does not apply.
    const created = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      reason: 'Approved then cancelled, well in advance',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;

    await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });
    expect((await balanceOf(workerEmployeeId)).used).toBe('2.00');

    const res = await api('POST', `/api/hr/leave/requests/${id}/cancel`, {
      token: workerToken,
      body: { note: 'No longer needed' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const balance = await balanceOf(workerEmployeeId);
    expect(balance.used).toBe('0.00');
    expect(balance.available).toBe('20.00');

    /*
      The attendance is unwound rather than deleted: nothing points at a cancelled
      request, and a row that also carried a session would keep it. Here there is
      no session, so the days resolve afresh.
    */
    const stillLinked = await prisma.attendanceRecord.count({ where: { leaveRequestId: id } });
    expect(stillLinked).toBe(0);

    const rows = await prisma.attendanceRecord.findMany({
      where: {
        employeeId: workerEmployeeId,
        attendanceDate: { gte: new Date('2026-12-01T00:00:00.000Z'), lte: new Date('2026-12-02T00:00:00.000Z') },
      },
      select: { status: true },
    });
    expect(rows.every((r) => r.status !== 'LEAVE')).toBe(true);
  });

  it('refuses cancelling a leave that has already started', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const created = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: yesterday,
      endDate: yesterday,
      reason: 'Leave that has already begun',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;
    await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });

    const res = await api('POST', `/api/hr/leave/requests/${id}/cancel`, {
      token: workerToken,
      body: {},
    });
    /*
      Past leave is attendance history, and silently reversing it would restate
      days somebody was genuinely absent for. The error points at the correction
      workflow, which is the controlled path.
    */
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LEAVE_NOT_CANCELLABLE');
  });

  it('cannot be cancelled twice', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);
    const created = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      reason: 'Cancelled once, then again',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;

    expect(
      (await api('POST', `/api/hr/leave/requests/${id}/cancel`, { token: workerToken, body: {} }))
        .status,
    ).toBe(200);

    const second = await api('POST', `/api/hr/leave/requests/${id}/cancel`, {
      token: workerToken,
      body: {},
    });
    expect([400, 403]).toContain(second.status);
  });
});

// ---------------------------------------------------------------------------
//  Attendance integration and scope
// ---------------------------------------------------------------------------

describe('leave and attendance together', () => {
  it('blocks clocking in on an approved full-day leave', async () => {
    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);

    const today = new Date().toISOString().slice(0, 10);
    const created = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: today,
      endDate: today,
      reason: 'On leave today, so clocking in should be refused',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;
    await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });

    const res = await api('POST', '/api/hr/attendance/clock-in', {
      token: workerToken,
      body: {},
    });
    /*
      Refused rather than silently overwriting an approved absence: somebody on
      leave who clocks in has either come in unexpectedly, in which case the leave
      should be cancelled, or made a mistake.
    */
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ON_APPROVED_LEAVE');
  });

  it('reports being on leave in today’s widget', async () => {
    const res = await api('GET', '/api/hr/attendance/today', { token: workerToken });
    const today = (res.body.data as { today: { onLeave: boolean; canClockIn: boolean } }).today;
    expect(today.onLeave).toBe(true);
    expect(today.canClockIn).toBe(false);
  });
});

describe('row-level access for leave', () => {
  it('shows an employee only their own requests', async () => {
    const res = await api('GET', '/api/hr/leave/requests?limit=100', { token: workerToken });
    expect(res.status).toBe(200);

    const ids = (res.body.data as { requests: { employee: { id: string } }[] }).requests.map(
      (r) => r.employee.id,
    );
    expect(ids.every((id) => id === workerEmployeeId)).toBe(true);
  });

  it('shows a manager their team’s requests', async () => {
    const res = await api('GET', '/api/hr/leave/requests?limit=100', { token: managerToken });
    expect(res.status).toBe(200);

    const ids = new Set(
      (res.body.data as { requests: { employee: { id: string } }[] }).requests.map(
        (r) => r.employee.id,
      ),
    );
    expect([...ids].every((id) => id === managerEmployeeId || id === workerEmployeeId)).toBe(true);
  });

  it('excludes the approver’s own requests from their queue', async () => {
    await resetLeave(managerEmployeeId);
    await allocate(managerEmployeeId);
    const own = await applyLeave(managerToken, {
      leaveTypeId,
      startDate: '2026-07-15',
      endDate: '2026-07-15',
      reason: 'The manager’s own leave request',
    });
    const ownId = (own.body.data as { request: { id: string } }).request.id;

    const res = await api('GET', '/api/hr/leave/requests?mine=true&limit=100', {
      token: managerToken,
    });
    const ids = (res.body.data as { requests: { id: string }[] }).requests.map((r) => r.id);
    // Nobody decides their own, so showing it in the queue would be showing work
    // they cannot do.
    expect(ids).not.toContain(ownId);
  });

  it('reports a request outside scope as missing', async () => {
    await resetLeave(strangerEmployeeId);
    await allocate(strangerEmployeeId);
    const created = await applyLeave(strangerToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      reason: 'The stranger’s own request',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;

    const res = await api('GET', `/api/hr/leave/requests/${id}`, { token: workerToken });
    expect(res.status).toBe(404);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await api('GET', '/api/hr/leave/requests')).status).toBe(401);
  });
});

describe('isolation from other modules', () => {
  it('writes no User, permission row or sales data', async () => {
    const before = {
      users: await prisma.user.count(),
      perms: await prisma.userModulePermission.count(),
      orders: await prisma.salesOrder.count(),
    };

    await resetLeave(workerEmployeeId);
    await allocate(workerEmployeeId);
    const created = await applyLeave(workerToken, {
      leaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      reason: 'Checking module isolation',
    });
    const id = (created.body.data as { request: { id: string } }).request.id;
    await api('POST', `/api/hr/leave/requests/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });

    expect(await prisma.user.count()).toBe(before.users);
    expect(await prisma.userModulePermission.count()).toBe(before.perms);
    expect(await prisma.salesOrder.count()).toBe(before.orders);
  });

  it('audits a decision without recording a salary or bank detail', async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { entityType: 'LeaveRequest', action: 'HR_LEAVE_DECIDED' },
      orderBy: { createdAt: 'desc' },
      select: { newValue: true },
    });
    expect(entry).not.toBeNull();

    const serialised = JSON.stringify(entry!.newValue);
    expect(serialised).toContain('status');
    // Phase 2 holds none of these, and an audit payload is the wrong place for
    // any of them.
    for (const forbidden of ['salary', 'bankAccount', 'password', 'token']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
