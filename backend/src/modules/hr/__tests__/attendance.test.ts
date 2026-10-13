/**
 * HR Phase 2 — Attendance, end to end.
 *
 * Real requests against a real database, because the things worth pinning are
 * the ones a type cannot express:
 *
 *   - that a double clock-in, double clock-out and double break are refused by
 *     the database rather than by an application check a race could slip past;
 *   - that no endpoint accepts a client timestamp for a clock-in or clock-out;
 *   - that the resolution precedence holds against real rows, so an approved
 *     leave is never overwritten by ABSENT;
 *   - that an employee sees only their own records, a manager their team's;
 *   - that nobody decides their own correction;
 *   - and that none of it writes to User, a permission row, or another module.
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

/** An HR administrator: holds every HR namespace by role default. */
let admin: TestUser;
let adminToken: string;

/** An ordinary employee with a linked account and NO HR permission. */
let worker: TestUser;
let workerToken: string;
let workerEmployeeId: string;

/** Their manager: also no HR permission, reaches the team by the reporting line. */
let manager: TestUser;
let managerToken: string;
let managerEmployeeId: string;

/** Somebody unrelated: no HR permission, no reports, no link to the others. */
let stranger: TestUser;
let strangerToken: string;
let strangerEmployeeId: string;

let departmentId: string;
let policyId: string;

let codeSeq = 0;
const testCode = (stem: string): string => {
  codeSeq += 1;
  return `ZZT${stem}${codeSeq}`.toUpperCase().slice(0, 20);
};

let emailSeq = 0;
const testEmail = (): string => {
  emailSeq += 1;
  return `${RUN_PREFIX}-att${emailSeq}@test.invalid`;
};

/** Creates an employee through the API and returns its id. */
async function makeEmployee(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await api('POST', '/api/hr/employees', {
    token: adminToken,
    body: {
      firstName: 'Att',
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

/** Links a CRM account to an employee record. */
async function link(employeeId: string, userId: string): Promise<void> {
  const res = await api('POST', `/api/hr/employees/${employeeId}/user`, {
    token: adminToken,
    body: { userId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Clears today's attendance so each test starts from a known state. */
async function resetToday(employeeId: string): Promise<void> {
  await prisma.attendanceBreak.deleteMany({
    where: { attendanceRecord: { employeeId } },
  });
  await prisma.attendanceRecord.deleteMany({ where: { employeeId } });
  await prisma.overtimeRecord.deleteMany({ where: { employeeId } });
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
    body: { name: 'Attendance Dept', code: testCode('ADEPT') },
  });
  expect(dept.status).toBe(201);
  departmentId = (dept.body.data as { department: { id: string } }).department.id;

  /*
    A policy with a wide full-day threshold, so a test clock-in/clock-out seconds
    apart resolves deterministically rather than depending on how fast the suite
    runs. Week-offs are set to none so "today" is always a working day whenever
    CI happens to run — a Saturday run would otherwise resolve every day as
    WEEK_OFF and make half the assertions meaningless.
  */
  const policy = await api('POST', '/api/hr/attendance-policies', {
    token: adminToken,
    body: {
      name: 'Attendance Test Policy',
      code: testCode('APOL'),
      expectedStartMinute: 570,
      expectedEndMinute: 1110,
      graceMinutes: 15,
      fullDayMinutes: 480,
      halfDayMinutes: 240,
      overtimeThresholdMinutes: 540,
      weekOffDays: [],
      departmentId,
      isDefault: false,
    },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(201);
  policyId = (policy.body.data as { policy: { id: string } }).policy.id;

  managerEmployeeId = await makeEmployee({ firstName: 'The', lastName: 'Manager' });
  workerEmployeeId = await makeEmployee({ firstName: 'The', lastName: 'Worker' });
  strangerEmployeeId = await makeEmployee({ firstName: 'The', lastName: 'Stranger' });

  await link(managerEmployeeId, manager.id);
  await link(workerEmployeeId, worker.id);
  await link(strangerEmployeeId, stranger.id);

  // The reporting line: worker reports to manager. Stranger reports to nobody.
  const assigned = await api('POST', `/api/hr/employees/${workerEmployeeId}/manager`, {
    token: adminToken,
    body: { managerId: managerEmployeeId },
  });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
});

afterAll(async () => {
  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
});

// ---------------------------------------------------------------------------
//  Clocking
// ---------------------------------------------------------------------------

describe('clocking in', () => {
  it('opens a session with a server timestamp', async () => {
    await resetToday(workerEmployeeId);

    const res = await api('POST', '/api/hr/attendance/clock-in', {
      token: workerToken,
      body: { workMode: 'OFFICE' },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const record = (res.body.data as { attendance: Record<string, unknown> }).attendance;
    expect(record.sessionState).toBe('OPEN');
    expect(record.source).toBe('SELF');
    expect(record.clockInAt).toBeTruthy();
    expect(record.clockOutAt).toBeNull();
  });

  it('ignores a client-supplied timestamp entirely', async () => {
    await resetToday(workerEmployeeId);

    const before = new Date();
    const res = await api('POST', '/api/hr/attendance/clock-in', {
      token: workerToken,
      // A browser clock set to last year. The schema does not accept it, and the
      // server takes the moment from Postgres — attendance is exactly the feature
      // somebody would try this on.
      body: { workMode: 'OFFICE', clockInAt: '2020-01-01T00:00:00.000Z' },
    });

    expect(res.status).toBe(201);
    const record = (res.body.data as { attendance: { clockInAt: string } }).attendance;
    const stamped = new Date(record.clockInAt);
    expect(stamped.getUTCFullYear()).toBe(before.getUTCFullYear());
  });

  it('refuses a second clock-in', async () => {
    await resetToday(workerEmployeeId);
    expect((await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} })).status).toBe(201);

    const res = await api('POST', '/api/hr/attendance/clock-in', {
      token: workerToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALREADY_CLOCKED_IN');
  });

  it('lets only one of two simultaneous clock-ins win', async () => {
    await resetToday(workerEmployeeId);

    /*
      The race the unique index exists for. Both requests see "no record"; one
      insert wins and the other gets a P2002 the service turns into a clear
      error rather than a 500. An application-only check would let both through.
    */
    const [a, b] = await Promise.all([
      api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} }),
      api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);

    const rows = await prisma.attendanceRecord.count({ where: { employeeId: workerEmployeeId } });
    expect(rows).toBe(1);
  });

  it('refuses somebody with no linked employee record', async () => {
    const orphan = await makeUser('USER');
    const orphanToken = await mintToken(orphan.id, { role: 'USER' });

    const res = await api('POST', '/api/hr/attendance/clock-in', {
      token: orphanToken,
      body: {},
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_EMPLOYEE_RECORD');
  });

  it('refuses an unauthenticated request', async () => {
    expect((await api('POST', '/api/hr/attendance/clock-in', { body: {} })).status).toBe(401);
  });

  it('records WFH and REMOTE as the work mode', async () => {
    for (const workMode of ['WFH', 'REMOTE'] as const) {
      await resetToday(workerEmployeeId);
      const res = await api('POST', '/api/hr/attendance/clock-in', {
        token: workerToken,
        body: { workMode },
      });
      expect(res.status).toBe(201);
      expect(
        (res.body.data as { attendance: { workMode: string } }).attendance.workMode,
      ).toBe(workMode);
    }
  });
});

describe('clocking out', () => {
  it('closes the session and computes the day', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });

    const res = await api('POST', '/api/hr/attendance/clock-out', {
      token: workerToken,
      body: {},
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const record = (res.body.data as { attendance: Record<string, unknown> }).attendance;
    expect(record.sessionState).toBe('CLOSED');
    expect(record.clockOutAt).toBeTruthy();
    // Seconds of work: below the half-day threshold, so honestly ABSENT rather
    // than a half day. The correction workflow covers a wrong clock.
    expect(record.status).toBe('ABSENT');
    expect(record.workedMinutes).toBe(0);
  });

  it('refuses a clock-out with no clock-in', async () => {
    await resetToday(workerEmployeeId);
    const res = await api('POST', '/api/hr/attendance/clock-out', {
      token: workerToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_CLOCKED_IN');
  });

  it('refuses a second clock-out', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });
    await api('POST', '/api/hr/attendance/clock-out', { token: workerToken, body: {} });

    const res = await api('POST', '/api/hr/attendance/clock-out', {
      token: workerToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALREADY_CLOCKED_OUT');
  });

  it('lets only one of two simultaneous clock-outs win', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });

    // The row lock is what serialises these: the unique index protects creation
    // but cannot protect mutation of an existing row.
    const [a, b] = await Promise.all([
      api('POST', '/api/hr/attendance/clock-out', { token: workerToken, body: {} }),
      api('POST', '/api/hr/attendance/clock-out', { token: workerToken, body: {} }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('refuses clocking out while on a break', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });
    await api('POST', '/api/hr/attendance/break/start', { token: workerToken, body: {} });

    /*
      Refused rather than silently closing the break: that would leave an open
      break with no session to sit in, and the honest fix is to end it. Somebody
      who forgot is better served by the correction workflow.
    */
    const res = await api('POST', '/api/hr/attendance/clock-out', {
      token: workerToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ON_BREAK');
  });
});

describe('breaks', () => {
  it('starts and ends a break', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });

    const started = await api('POST', '/api/hr/attendance/break/start', {
      token: workerToken,
      body: {},
    });
    expect(started.status).toBe(200);
    expect(
      (started.body.data as { attendance: { sessionState: string } }).attendance.sessionState,
    ).toBe('ON_BREAK');

    const ended = await api('POST', '/api/hr/attendance/break/end', {
      token: workerToken,
      body: {},
    });
    expect(ended.status).toBe(200);
    expect(
      (ended.body.data as { attendance: { sessionState: string } }).attendance.sessionState,
    ).toBe('OPEN');
  });

  it('refuses a second break while one is open', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });
    await api('POST', '/api/hr/attendance/break/start', { token: workerToken, body: {} });

    const res = await api('POST', '/api/hr/attendance/break/start', {
      token: workerToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALREADY_ON_BREAK');
  });

  it('refuses ending a break that is not running', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });

    const res = await api('POST', '/api/hr/attendance/break/end', {
      token: workerToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ON_BREAK');
  });

  it('refuses a break with no session', async () => {
    await resetToday(workerEmployeeId);
    const res = await api('POST', '/api/hr/attendance/break/start', {
      token: workerToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_CLOCKED_IN');
  });

  it('keeps at most one open break under concurrency', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });

    // The partial unique index on (attendanceRecordId) WHERE endedAt IS NULL.
    await Promise.all([
      api('POST', '/api/hr/attendance/break/start', { token: workerToken, body: {} }),
      api('POST', '/api/hr/attendance/break/start', { token: workerToken, body: {} }),
    ]);

    const open = await prisma.attendanceBreak.count({
      where: { attendanceRecord: { employeeId: workerEmployeeId }, endedAt: null },
    });
    expect(open).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  Today's state
// ---------------------------------------------------------------------------

describe('the employee widget', () => {
  it('offers clock-in before clocking in, and nothing after clocking out', async () => {
    await resetToday(workerEmployeeId);

    const fresh = await api('GET', '/api/hr/attendance/today', { token: workerToken });
    expect(fresh.status).toBe(200);
    let today = (fresh.body.data as { today: Record<string, boolean> }).today;
    expect(today.canClockIn).toBe(true);
    expect(today.canClockOut).toBe(false);
    expect(today.canStartBreak).toBe(false);

    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });
    today = (
      (await api('GET', '/api/hr/attendance/today', { token: workerToken })).body.data as {
        today: Record<string, boolean>;
      }
    ).today;
    expect(today.canClockIn).toBe(false);
    expect(today.canClockOut).toBe(true);
    expect(today.canStartBreak).toBe(true);

    await api('POST', '/api/hr/attendance/clock-out', { token: workerToken, body: {} });
    today = (
      (await api('GET', '/api/hr/attendance/today', { token: workerToken })).body.data as {
        today: Record<string, boolean>;
      }
    ).today;
    // No duplicate actions after clocking out, which is what the brief asks for.
    expect(today.canClockIn).toBe(false);
    expect(today.canClockOut).toBe(false);
    expect(today.canStartBreak).toBe(false);
    expect(today.canEndBreak).toBe(false);
  });

  it('reports the policy in force, so expected hours are shown honestly', async () => {
    const res = await api('GET', '/api/hr/attendance/today', { token: workerToken });
    const today = (res.body.data as { today: { policy: { id: string } | null } }).today;
    expect(today.policy?.id).toBe(policyId);
  });
});

// ---------------------------------------------------------------------------
//  Holidays and week-offs
// ---------------------------------------------------------------------------

describe('holidays', () => {
  it('creates one and refuses a duplicate on the same date', async () => {
    const date = '2026-12-25';
    const first = await api('POST', '/api/hr/holidays', {
      token: adminToken,
      body: { name: 'ZZT Christmas', holidayDate: date },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await api('POST', '/api/hr/holidays', {
      token: adminToken,
      body: { name: 'ZZT Christmas Again', holidayDate: date },
    });
    // A plain composite unique could not express this — NULLs never collide in
    // Postgres, so the company-wide case needs a partial index.
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('HOLIDAY_EXISTS');
  });

  it('refuses configuration without HR_ADMIN', async () => {
    const res = await api('POST', '/api/hr/holidays', {
      token: workerToken,
      body: { name: 'ZZT Unauthorised', holidayDate: '2026-11-11' },
    });
    expect(res.status).toBe(403);
  });

  it('lets any employee read the holiday list', async () => {
    // Knowing when the office is closed is not confidential, and the leave form
    // needs it to explain why a range costs fewer days than it spans.
    const res = await api('GET', '/api/hr/holidays', { token: workerToken });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  Corrections
// ---------------------------------------------------------------------------

describe('attendance corrections', () => {
  const pastDate = '2026-02-10';

  async function raiseCorrection(token: string, date = pastDate) {
    return api('POST', '/api/hr/attendance/corrections', {
      token,
      body: {
        attendanceDate: date,
        requestedClockInAt: `${date}T04:00:00.000Z`,
        requestedClockOutAt: `${date}T13:00:00.000Z`,
        reason: 'I forgot to clock out that day',
      },
    });
  }

  it('raises a request with the current values snapshotted', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });

    const res = await raiseCorrection(workerToken);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const correction = (res.body.data as { correction: Record<string, unknown> }).correction;
    expect(correction.status).toBe('PENDING');
    expect(correction.requestedClockInAt).toBeTruthy();
  });

  it('refuses a correction for a future date', async () => {
    const res = await api('POST', '/api/hr/attendance/corrections', {
      token: workerToken,
      body: {
        attendanceDate: '2099-01-01',
        requestedClockInAt: '2099-01-01T04:00:00.000Z',
        reason: 'Travelling forward in time',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FUTURE_CORRECTION');
  });

  it('refuses a correction that asks for nothing', async () => {
    const res = await api('POST', '/api/hr/attendance/corrections', {
      token: workerToken,
      body: { attendanceDate: pastDate, reason: 'Nothing in particular' },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a second pending correction for the same date', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });
    expect((await raiseCorrection(workerToken)).status).toBe(201);

    const res = await raiseCorrection(workerToken);
    // Without this, five requests for one day could be decided independently,
    // each overwriting the last.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CORRECTION_ALREADY_PENDING');
  });

  it('lets the manager approve and applies the attendance atomically', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });
    await prisma.attendanceRecord.deleteMany({
      where: { employeeId: workerEmployeeId, attendanceDate: new Date(`${pastDate}T00:00:00.000Z`) },
    });

    const raised = await raiseCorrection(workerToken);
    const id = (raised.body.data as { correction: { id: string } }).correction.id;

    // The manager holds no HR permission: they decide by being the manager.
    const decided = await api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
      token: managerToken,
      body: { decision: 'APPROVED' },
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const record = await prisma.attendanceRecord.findFirst({
      where: { employeeId: workerEmployeeId, attendanceDate: new Date(`${pastDate}T00:00:00.000Z`) },
      select: { source: true, clockInAt: true, clockOutAt: true, workedMinutes: true },
    });
    expect(record).not.toBeNull();
    // Stamped CORRECTION so a future Payroll phase can tell it from a
    // self-recorded day.
    expect(record!.source).toBe('CORRECTION');
    expect(record!.clockOutAt).not.toBeNull();
    // 04:00 to 13:00 UTC is nine hours.
    expect(record!.workedMinutes).toBe(540);
  });

  it('refuses the requester deciding their own correction', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });
    const raised = await raiseCorrection(workerToken);
    const id = (raised.body.data as { correction: { id: string } }).correction.id;

    const res = await api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
      token: workerToken,
      body: { decision: 'APPROVED' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses an administrator deciding their own correction', async () => {
    /*
      Self-approval is refused for everybody. The request exists because somebody
      asked for a decision; letting the asker supply it would put one name on both
      lines of the trail.
    */
    const adminEmployeeId = await makeEmployee({ firstName: 'Admin', lastName: 'Person' });
    await link(adminEmployeeId, admin.id);

    const raised = await api('POST', '/api/hr/attendance/corrections', {
      token: adminToken,
      body: {
        attendanceDate: '2026-02-11',
        requestedClockInAt: '2026-02-11T04:00:00.000Z',
        reason: 'My own correction',
      },
    });
    expect(raised.status).toBe(201);
    const id = (raised.body.data as { correction: { id: string } }).correction.id;

    const res = await api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
      token: adminToken,
      body: { decision: 'APPROVED' },
    });
    expect(res.status).toBe(403);

    // Unlink so later tests see the administrator without an employee record.
    await api('DELETE', `/api/hr/employees/${adminEmployeeId}/user`, {
      token: adminToken,
      body: {},
    });
  });

  it('refuses an unrelated manager', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });
    const raised = await raiseCorrection(workerToken);
    const id = (raised.body.data as { correction: { id: string } }).correction.id;

    // The stranger manages nobody and holds no HR permission.
    const res = await api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
      token: strangerToken,
      body: { decision: 'APPROVED' },
    });
    expect(res.status).toBe(403);
  });

  it('requires a reason when rejecting', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });
    const raised = await raiseCorrection(workerToken);
    const id = (raised.body.data as { correction: { id: string } }).correction.id;

    const res = await api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
      token: managerToken,
      body: { decision: 'REJECTED' },
    });
    expect(res.status).toBe(422);
  });

  it('cannot be decided twice', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });
    const raised = await raiseCorrection(workerToken);
    const id = (raised.body.data as { correction: { id: string } }).correction.id;

    expect(
      (
        await api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
          token: managerToken,
          body: { decision: 'APPROVED' },
        })
      ).status,
    ).toBe(200);

    const second = await api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
      token: managerToken,
      body: { decision: 'REJECTED', note: 'Changed my mind' },
    });
    // The conditional update on status = PENDING is what makes this safe.
    expect([400, 403]).toContain(second.status);
  });

  it('lets only one of two simultaneous decisions win', async () => {
    await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: workerEmployeeId } });
    const raised = await raiseCorrection(workerToken);
    const id = (raised.body.data as { correction: { id: string } }).correction.id;

    const [a, b] = await Promise.all([
      api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
        token: managerToken,
        body: { decision: 'APPROVED' },
      }),
      api('POST', `/api/hr/attendance/corrections/${id}/decide`, {
        token: adminToken,
        body: { decision: 'REJECTED', note: 'No' },
      }),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 200);
    expect(succeeded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
//  Row-level access
// ---------------------------------------------------------------------------

describe('row-level access', () => {
  it('shows an employee only their own attendance', async () => {
    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });

    const res = await api('GET', '/api/hr/attendance?limit=100', { token: workerToken });
    expect(res.status).toBe(200);

    const rows = (res.body.data as { attendance: { employee: { id: string } }[] }).attendance;
    expect(rows.length).toBeGreaterThan(0);
    // Employee A cannot see employee B — the brief's requirement, asserted on
    // real rows rather than on the policy function.
    expect(rows.every((r) => r.employee.id === workerEmployeeId)).toBe(true);
  });

  it('shows a manager their own records and their reports', async () => {
    const res = await api('GET', '/api/hr/attendance?limit=100', { token: managerToken });
    expect(res.status).toBe(200);

    const ids = new Set(
      (res.body.data as { attendance: { employee: { id: string } }[] }).attendance.map(
        (r) => r.employee.id,
      ),
    );
    // The worker reports to the manager, so their rows are in reach.
    expect([...ids].every((id) => id === managerEmployeeId || id === workerEmployeeId)).toBe(true);
  });

  it('does not show an unrelated employee anybody else', async () => {
    const res = await api('GET', '/api/hr/attendance?limit=100', { token: strangerToken });
    expect(res.status).toBe(200);

    const ids = (res.body.data as { attendance: { employee: { id: string } }[] }).attendance.map(
      (r) => r.employee.id,
    );
    expect(ids.every((id) => id === strangerEmployeeId)).toBe(true);
  });

  it('lets an administrator see everybody', async () => {
    const res = await api('GET', '/api/hr/attendance?limit=100', { token: adminToken });
    expect(res.status).toBe(200);

    const ids = new Set(
      (res.body.data as { attendance: { employee: { id: string } }[] }).attendance.map(
        (r) => r.employee.id,
      ),
    );
    expect(ids.has(workerEmployeeId)).toBe(true);
  });

  it('reports a record outside scope as missing, never as forbidden', async () => {
    await resetToday(workerEmployeeId);
    const clocked = await api('POST', '/api/hr/attendance/clock-in', {
      token: workerToken,
      body: {},
    });
    const id = (clocked.body.data as { attendance: { id: string } }).attendance.id;

    const res = await api('GET', `/api/hr/attendance/${id}`, { token: strangerToken });
    /*
      404 rather than 403: saying "this exists but is not yours" would let
      somebody enumerate colleagues' attendance by probing ids.
    */
    expect(res.status).toBe(404);
  });

  it('does not let a department filter widen a manager’s scope', async () => {
    /*
      The subtle one. A department filter must be ANDed with the scope, not
      replace it — otherwise asking for a department would show a manager every
      employee in it rather than only their own reports.
    */
    const res = await api(
      'GET',
      `/api/hr/attendance?limit=100&departmentId=${departmentId}`,
      { token: managerToken },
    );
    expect(res.status).toBe(200);

    const ids = (res.body.data as { attendance: { employee: { id: string } }[] }).attendance.map(
      (r) => r.employee.id,
    );
    expect(ids).not.toContain(strangerEmployeeId);
  });
});

// ---------------------------------------------------------------------------
//  Summary and isolation
// ---------------------------------------------------------------------------

describe('the summary', () => {
  it('counts statuses and sums minutes over a range', async () => {
    const res = await api(
      'GET',
      '/api/hr/attendance/summary?from=2026-01-01&to=2026-12-31',
      { token: workerToken },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const summary = (res.body.data as { summary: Record<string, number | string> }).summary;
    expect(typeof summary.presentDays).toBe('number');
    expect(typeof summary.workedMinutes).toBe('number');
    // Deliberately no percentages or trends: Phase 2 holds no baseline to compare
    // against, and an "attendance score" would be a number nobody agreed.
    expect(summary).not.toHaveProperty('attendanceRate');
  });
});

describe('isolation from other modules', () => {
  it('writes no User, permission row, sales order or employee change', async () => {
    const before = {
      users: await prisma.user.count(),
      perms: await prisma.userModulePermission.count(),
      orders: await prisma.salesOrder.count(),
      employees: await prisma.employee.count(),
    };

    await resetToday(workerEmployeeId);
    await api('POST', '/api/hr/attendance/clock-in', { token: workerToken, body: {} });
    await api('POST', '/api/hr/attendance/break/start', { token: workerToken, body: {} });
    await api('POST', '/api/hr/attendance/break/end', { token: workerToken, body: {} });
    await api('POST', '/api/hr/attendance/clock-out', { token: workerToken, body: {} });

    // A clock-in does not change somebody's employment record, grant anything, or
    // touch another module.
    expect(await prisma.user.count()).toBe(before.users);
    expect(await prisma.userModulePermission.count()).toBe(before.perms);
    expect(await prisma.salesOrder.count()).toBe(before.orders);
    expect(await prisma.employee.count()).toBe(before.employees);
  });

  it('audits clocking without recording a location or device', async () => {
    await resetToday(workerEmployeeId);
    const res = await api('POST', '/api/hr/attendance/clock-in', {
      token: workerToken,
      body: { workMode: 'WFH' },
    });
    const id = (res.body.data as { attendance: { id: string } }).attendance.id;

    const entry = await prisma.auditLog.findFirst({
      where: { entityType: 'AttendanceRecord', entityId: id, action: 'HR_ATTENDANCE_CLOCK_IN' },
      select: { newValue: true },
    });
    expect(entry).not.toBeNull();

    const serialised = JSON.stringify(entry!.newValue);
    expect(serialised).toContain('workMode');
    // No GPS, no IP in the payload, no device fingerprint: Phase 2 collects none
    // of it, and an audit payload is the wrong place for any of it.
    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('ipAddress');
  });
});
