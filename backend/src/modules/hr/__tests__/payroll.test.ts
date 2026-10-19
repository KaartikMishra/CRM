/**
 * Payroll over real HTTP, against the real database.
 *
 * These are the tests the acceptance checks are written against, and they run
 * against the live Express app and a remote Neon database rather than mocks —
 * because the properties being tested are database properties. A mocked
 * `updateMany` cannot demonstrate that two concurrent finalisations produce one
 * winner, and a mocked unique constraint cannot demonstrate that a duplicate
 * period is impossible.
 *
 * What each describe block maps to:
 *
 *   1. transactional + idempotent calculation and finalisation
 *   2. concurrency: no duplicate runs, no inconsistent double-finalisation
 *   3. finalised snapshots and payslips immutable
 *   4. an approver who is paid by the run is refused BEFORE permission checks
 *   5. self-service never exposes another employee's salary or payslip
 *   6. missing policy inputs produce explicit warnings, never guessed figures
 *   7. deductions counted once; employer contributions do not reduce net pay
 *   9. every route gated on HR_PAYROLL with the right action, EXPORT separate
 *
 * Fixtures are run-owned (`RUN_PREFIX`) and cleaned by the scoped sweep, never
 * by broad deletion.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@rs/database';
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
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

/** Payroll administrator: every payroll grant including EXPORT. */
let payrollAdmin: TestUser;
let payrollAdminToken: string;

/** A second approver who is NOT on the payroll — the one who can finalise. */
let approver: TestUser;
let approverToken: string;

/** An ordinary employee with no payroll grant at all. */
let staff: TestUser;
let staffToken: string;

/** A second employee, used to prove cross-employee denial. */
let other: TestUser;
let otherToken: string;

/**
 * An ADMIN who is themselves on the payroll.
 *
 * The separation-of-duties case: they hold APPROVE by explicit grant and the
 * ADMIN role, and must still be refused approval and finalisation of a run that
 * pays them.
 */
let paidAdmin: TestUser;
let paidAdminToken: string;

let departmentId: string;
let designationId: string;
let staffEmployeeId: string;
let otherEmployeeId: string;
let paidAdminEmployeeId: string;

/**
 * A far-future base year, unique to this run.
 *
 * ### Why it has to be per-run
 *
 * `PayrollPeriod` is uniquely keyed on `(year, month)` — which is the very
 * guarantee this suite tests. That makes a fixed base year self-defeating: the
 * second execution finds last execution's periods still there and every
 * `openPeriod` returns 409. Periods are also outside the fixture sweep's reach,
 * because unlike every other HR row they carry no name to match `RUN_PREFIX`
 * against.
 *
 * So the year itself is the run marker. Derived from the process id, bounded
 * into 2100-2199 — far enough forward that no real payroll will ever occupy it,
 * and wide enough that two concurrent runs on different pids do not collide.
 *
 * Periods are addressed by a **slot number** rather than a raw month, because a
 * month must be 1-12 and this suite needs more than twelve distinct runs.
 * `slot(n)` walks forward from the base year, so slot 13 is January of the next
 * year rather than an invalid month 13.
 */
const BASE_YEAR = 2100 + (process.pid % 90);

/** Maps a slot number onto a valid (year, month) pair. */
function slot(n: number): { year: number; month: number } {
  const zero = n - 1;
  return { year: BASE_YEAR + Math.floor(zero / 12), month: (zero % 12) + 1 };
}

async function grant(userId: string, module: string, actions: string[]): Promise<void> {
  for (const action of actions) {
    await prisma.userModulePermission.upsert({
      where: {
        userId_module_action: { userId, module: module as never, action: action as never },
      },
      create: { userId, module: module as never, action: action as never, allowed: true },
      update: { allowed: true },
    });
  }
}

async function revoke(userId: string, module: string, action: string): Promise<void> {
  await prisma.userModulePermission.upsert({
    where: {
      userId_module_action: { userId, module: module as never, action: action as never },
    },
    create: { userId, module: module as never, action: action as never, allowed: false },
    update: { allowed: false },
  });
}

const data = <T>(res: { body: { data?: unknown } }): T => res.body.data as T;

async function makeEmployee(
  firstName: string,
  linkUserId?: string,
): Promise<{ id: string; employeeId: string }> {
  const res = await api('POST', '/api/hr/employees', {
    token: payrollAdminToken,
    body: {
      firstName: `${RUN_PREFIX}-${firstName}`,
      lastName: 'Payroll',
      // Required by createEmployeeSchema. Unique per employee and per run, so two
      // fixtures in the same suite cannot collide on the unique index.
      workEmail: `${RUN_PREFIX}-${firstName}-${Date.now() % 1_000_000}@test.invalid`,
      departmentId,
      designationId,
      joiningDate: `${BASE_YEAR - 4}-01-15`,
      employmentType: 'FULL_TIME',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const employee = data<{ employee: { id: string; employeeId: string } }>(res).employee;

  if (linkUserId) {
    // Links the CRM account to the HR record. `Employee.userId` is what resolves
    // "is this reader the subject" — never the employee code, which is a
    // different column (the Phase 5 defect).
    await prisma.employee.update({ where: { id: employee.id }, data: { userId: linkUserId } });
  }
  return employee;
}

/** A coherent component set: basic + HRA + balance + PF + employer PF. */
async function seedComponents(): Promise<{
  basicId: string;
  hraId: string;
  specialId: string;
  pfId: string;
  pfErId: string;
}> {
  const mk = async (body: Record<string, unknown>): Promise<string> => {
    const res = await api('POST', '/api/hr/payroll/components', {
      token: payrollAdminToken,
      body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return data<{ component: { id: string } }>(res).component.id;
  };

  const suffix = RUN_PREFIX.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(-8);
  return {
    basicId: await mk({
      code: `BASIC_${suffix}`,
      name: 'Basic',
      kind: 'EARNING',
      calculation: 'FIXED',
      isBase: true,
      prorates: true,
      displayOrder: 10,
    }),
    hraId: await mk({
      code: `HRA_${suffix}`,
      name: 'House Rent Allowance',
      kind: 'EARNING',
      calculation: 'PERCENT_OF_BASE',
      rate: '40',
      displayOrder: 20,
    }),
    specialId: await mk({
      code: `SPECIAL_${suffix}`,
      name: 'Special Allowance',
      kind: 'EARNING',
      calculation: 'FORMULA_BALANCE',
      displayOrder: 30,
    }),
    pfId: await mk({
      code: `PF_EMP_${suffix}`,
      name: 'Provident Fund',
      kind: 'DEDUCTION',
      calculation: 'PERCENT_OF_BASE',
      rate: '12',
      capAmount: '1800.00',
      prorates: false,
      displayOrder: 40,
    }),
    pfErId: await mk({
      code: `PF_ER_${suffix}`,
      name: 'Provident Fund (employer)',
      kind: 'EMPLOYER_CONTRIBUTION',
      calculation: 'PERCENT_OF_BASE',
      rate: '12',
      capAmount: '1800.00',
      prorates: false,
      displayOrder: 50,
    }),
  };
}

let structureId: string;

async function seedStructure(): Promise<string> {
  const c = await seedComponents();
  const suffix = RUN_PREFIX.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(-8);
  const res = await api('POST', '/api/hr/payroll/structures', {
    token: payrollAdminToken,
    body: {
      code: `STD_${suffix}`,
      name: 'Standard',
      components: [
        { componentId: c.basicId, amount: '30000.00', displayOrder: 10 },
        { componentId: c.hraId, displayOrder: 20 },
        { componentId: c.specialId, displayOrder: 30 },
        { componentId: c.pfId, displayOrder: 40 },
        { componentId: c.pfErId, displayOrder: 50 },
      ],
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return data<{ structure: { id: string } }>(res).structure.id;
}

async function assignSalary(employeeId: string, gross: string): Promise<void> {
  const res = await api('POST', '/api/hr/payroll/salaries', {
    token: payrollAdminToken,
    body: {
      employeeId,
      structureId,
      monthlyGross: gross,
      /*
        Deliberately in the real past, not `BASE_YEAR - 1`.

        Periods live in a far-future year so they cannot collide, but a salary
        assignment has to be in force *today* for `/payroll/mine` to report a
        current salary — `findSalaryOn(new Date())` is what that endpoint asks,
        and an assignment starting in 2171 is not in force in 2026. The two dates
        answer different questions and only one of them is about the period.
      */
      effectiveFrom: '2020-01-01',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** Opens a period for a month, returning its id. */
async function openPeriod(slotNumber: number): Promise<string> {
  const res = await api('POST', '/api/hr/payroll/periods', {
    token: payrollAdminToken,
    body: slot(slotNumber),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return data<{ period: { id: string } }>(res).period.id;
}

/** Drives a period all the way to FINALIZED using the non-paid approver. */
async function finalizeRun(slotNumber: number): Promise<{ periodId: string }> {
  const periodId = await openPeriod(slotNumber);

  const calc = await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
    token: payrollAdminToken,
    body: {},
  });
  expect(calc.status, JSON.stringify(calc.body)).toBe(200);

  const submitted = await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
    token: payrollAdminToken,
    body: {},
  });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

  const decided = await api('POST', `/api/hr/payroll/periods/${periodId}/decide`, {
    token: approverToken,
    body: { decision: 'APPROVE' },
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);

  const finalized = await api('POST', `/api/hr/payroll/periods/${periodId}/finalize`, {
    token: approverToken,
    body: { acknowledgeNotStatutory: true },
  });
  expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);

  return { periodId };
}

// ---------------------------------------------------------------------------
//  Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await startTestServer();

  payrollAdmin = await makeUser('ADMIN');
  approver = await makeUser('ADMIN');
  staff = await makeUser('USER');
  other = await makeUser('USER');
  paidAdmin = await makeUser('ADMIN');

  payrollAdminToken = await mintToken(payrollAdmin.id, { role: 'ADMIN' });
  approverToken = await mintToken(approver.id, { role: 'ADMIN' });
  staffToken = await mintToken(staff.id, { role: 'USER' });
  otherToken = await mintToken(other.id, { role: 'USER' });
  paidAdminToken = await mintToken(paidAdmin.id, { role: 'ADMIN' });

  /*
    Grants written explicitly rather than relying on ROLE_DEFAULTS. Phase 4
    shipped with a capability missing from `hrActor`, invisible to typechecks and
    unit tests; writing the override makes this suite fail on its own merits if
    that recurs rather than silently losing its coverage.
  */
  await grant(payrollAdmin.id, 'HR_PAYROLL', [
    'VIEW',
    'CREATE',
    'EDIT',
    'ASSIGN',
    'APPROVE',
    'EXPORT',
  ]);
  await grant(payrollAdmin.id, 'HR_EMPLOYEE', ['VIEW', 'CREATE', 'EDIT']);
  await grant(payrollAdmin.id, 'HR_ADMIN', ['VIEW', 'CREATE', 'EDIT']);

  // The approver can decide and finalise, and is deliberately NOT given an
  // employee record, so they are never paid by a run.
  await grant(approver.id, 'HR_PAYROLL', ['VIEW', 'APPROVE']);
  await grant(approver.id, 'HR_EMPLOYEE', ['VIEW']);

  // Staff reach the self-service floor via HR_EMPLOYEE:VIEW and hold no payroll
  // grant whatsoever. Their access to their own payslip comes from rows.
  await grant(staff.id, 'HR_EMPLOYEE', ['VIEW']);
  await grant(other.id, 'HR_EMPLOYEE', ['VIEW']);

  // The separation-of-duties subject: holds APPROVE and is on the payroll.
  await grant(paidAdmin.id, 'HR_PAYROLL', ['VIEW', 'EDIT', 'APPROVE']);
  await grant(paidAdmin.id, 'HR_EMPLOYEE', ['VIEW']);

  const dept = await api('POST', '/api/hr/departments', {
    token: payrollAdminToken,
    body: { name: `${RUN_PREFIX}-payroll-dept`, code: `PD${Date.now() % 100000}` },
  });
  expect(dept.status, JSON.stringify(dept.body)).toBe(201);
  departmentId = data<{ department: { id: string } }>(dept).department.id;

  const desig = await api('POST', '/api/hr/designations', {
    token: payrollAdminToken,
    body: { name: `${RUN_PREFIX}-payroll-desig`, code: `PG${Date.now() % 100000}` },
  });
  expect(desig.status, JSON.stringify(desig.body)).toBe(201);
  designationId = data<{ designation: { id: string } }>(desig).designation.id;

  structureId = await seedStructure();

  const staffEmp = await makeEmployee('staff', staff.id);
  staffEmployeeId = staffEmp.id;
  const otherEmp = await makeEmployee('other', other.id);
  otherEmployeeId = otherEmp.id;
  const paidAdminEmp = await makeEmployee('paidadmin', paidAdmin.id);
  paidAdminEmployeeId = paidAdminEmp.id;

  await assignSalary(staffEmployeeId, '50000.00');
  await assignSalary(otherEmployeeId, '60000.00');
  await assignSalary(paidAdminEmployeeId, '80000.00');
}, 180_000);

afterAll(async () => {
  await cleanup();
  await stopTestServer();
}, 120_000);

// ---------------------------------------------------------------------------
//  1 + 7. Calculation: transactional, idempotent, correct
// ---------------------------------------------------------------------------

describe('calculation', () => {
  it('costs every eligible employee and totals the run', async () => {
    const periodId = await openPeriod(1);
    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = data<{
      result: { calculated: number; period: { status: string; totals: { netPay: string } | null } };
    }>(res).result;

    expect(result.calculated).toBeGreaterThanOrEqual(3);
    expect(result.period.status).toBe('CALCULATED');
    expect(result.period.totals).not.toBeNull();
  });

  it('is idempotent: recalculating replaces figures rather than doubling them', async () => {
    const periodId = await openPeriod(2);

    const first = await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(first.status).toBe(200);
    const firstNet = data<{ result: { period: { totals: { netPay: string } } } }>(first).result
      .period.totals.netPay;

    const second = await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(second.status).toBe(200);
    const secondNet = data<{ result: { period: { totals: { netPay: string } } } }>(second).result
      .period.totals.netPay;

    // Exactly equal, not merely close: the upsert keyed on (periodId, employeeId)
    // is what makes this true, and a doubled total is the failure it prevents.
    expect(secondNet).toBe(firstNet);

    // And no duplicate rows were created.
    const itemCount = await prisma.payrollItem.count({ where: { periodId } });
    const employeeCount = await prisma.payrollItem.groupBy({
      by: ['employeeId'],
      where: { periodId },
    });
    expect(itemCount).toBe(employeeCount.length);
  });

  it('counts a configured deduction exactly once and excludes the employer share from net', async () => {
    const periodId = await openPeriod(3);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });

    const items = await api(
      'GET',
      `/api/hr/payroll/periods/${periodId}/items?limit=50`,
      { token: payrollAdminToken },
    );
    expect(items.status, JSON.stringify(items.body)).toBe(200);
    const list = data<{
      items: Array<{
        employee: { id: string };
        grossEarnings: string | null;
        totalDeductions: string | null;
        employerContributions: string | null;
        netPay: string | null;
        lines: Array<{ componentCode: string; kind: string; amount: string }>;
      }>;
    }>(items).items;

    const line = list.find((i) => i.employee.id === staffEmployeeId);
    expect(line).toBeDefined();
    if (!line) return;

    const deductions = line.lines.filter((l) => l.kind === 'DEDUCTION');
    expect(deductions).toHaveLength(1);

    // Net = gross - deductions. The employer contribution is reported and does
    // NOT reduce it.
    expect(line.employerContributions).toBe('1800.00');
    expect(Number(line.netPay)).toBeCloseTo(
      Number(line.grossEarnings) - Number(line.totalDeductions),
      2,
    );
    expect(Number(line.netPay)).toBeGreaterThan(0);
  });

  it('excludes an employee with no salary assignment and says why', async () => {
    const unpaidEmp = await makeEmployee('nosalary');
    const periodId = await openPeriod(4);
    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(res.status).toBe(200);

    const item = await prisma.payrollItem.findUnique({
      where: { periodId_employeeId: { periodId, employeeId: unpaidEmp.id } },
      select: { status: true, exclusionReason: true, netPay: true },
    });
    expect(item?.status).toBe('EXCLUDED');
    expect(item?.exclusionReason).toBe('NO_SALARY_ASSIGNMENT');
    // An excluded line carries no figures, so no total can silently include it.
    expect(item?.netPay).toBeNull();
  });

  it('refuses to recalculate a run that is awaiting approval', async () => {
    const periodId = await openPeriod(5);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });

    const again = await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/awaiting or has received approval/i);
  });
});

// ---------------------------------------------------------------------------
//  2. Concurrency
// ---------------------------------------------------------------------------

describe('concurrency', () => {
  it('creates only one period for a month when two requests race', async () => {
    const target = slot(6);
    const [a, b] = await Promise.all([
      api('POST', '/api/hr/payroll/periods', { token: payrollAdminToken, body: target }),
      api('POST', '/api/hr/payroll/periods', { token: payrollAdminToken, body: target }),
    ]);

    const statuses = [a.status, b.status].sort();
    // One wins with 201, the other is refused with 409. Never two 201s.
    expect(statuses).toEqual([201, 409]);

    const rows = await prisma.payrollPeriod.count({ where: target });
    expect(rows).toBe(1);
  });

  it('finalises a period exactly once when two requests race', async () => {
    const periodId = await openPeriod(7);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/decide`, {
      token: approverToken,
      body: { decision: 'APPROVE' },
    });

    const [a, b] = await Promise.all([
      api('POST', `/api/hr/payroll/periods/${periodId}/finalize`, {
        token: approverToken,
        body: { acknowledgeNotStatutory: true },
      }),
      api('POST', `/api/hr/payroll/periods/${periodId}/finalize`, {
        token: approverToken,
        body: { acknowledgeNotStatutory: true },
      }),
    ]);

    const ok = [a, b].filter((r) => r.status === 200);
    const refused = [a, b].filter((r) => r.status !== 200);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);

    // One finaliser stamped, one set of snapshots, every item FINALIZED or
    // EXCLUDED — never a mix of FINALIZED and CALCULATED.
    const period = await prisma.payrollPeriod.findUnique({
      where: { id: periodId },
      select: { status: true, finalizedById: true, finalizedAt: true },
    });
    expect(period?.status).toBe('FINALIZED');
    expect(period?.finalizedById).toBe(approver.id);

    const statuses = await prisma.payrollItem.groupBy({
      by: ['status'],
      where: { periodId },
    });
    const kinds = statuses.map((s) => s.status).sort();
    expect(kinds).not.toContain('CALCULATED');
  });

  it('leaves no partially finalised run: every costed item has a snapshot', async () => {
    const { periodId } = await finalizeRun(8);
    const items = await prisma.payrollItem.findMany({
      where: { periodId, status: 'FINALIZED' },
      select: { id: true, snapshot: true },
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.snapshot, `item ${item.id} has no snapshot`).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
//  3. Immutability
// ---------------------------------------------------------------------------

describe('a finalised run is immutable', () => {
  let finalizedPeriodId: string;

  beforeAll(async () => {
    const run = await finalizeRun(9);
    finalizedPeriodId = run.periodId;
  }, 120_000);

  it('refuses a recalculation', async () => {
    const res = await api('POST', `/api/hr/payroll/periods/${finalizedPeriodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be recalculated/i);
  });

  it('refuses an edit', async () => {
    const res = await api('PATCH', `/api/hr/payroll/periods/${finalizedPeriodId}`, {
      token: payrollAdminToken,
      body: { notes: 'trying to change a paid run' },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/can no longer be changed/i);
  });

  it('refuses a cancellation', async () => {
    const res = await api('POST', `/api/hr/payroll/periods/${finalizedPeriodId}/cancel`, {
      token: approverToken,
      body: { reason: 'trying to undo a paid run' },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be cancelled/i);
  });

  it('refuses a second finalisation', async () => {
    const res = await api('POST', `/api/hr/payroll/periods/${finalizedPeriodId}/finalize`, {
      token: approverToken,
      body: { acknowledgeNotStatutory: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already finalized/i);
  });

  it('refuses excluding an employee after finalisation', async () => {
    const item = await prisma.payrollItem.findFirst({
      where: { periodId: finalizedPeriodId, status: 'FINALIZED' },
      select: { id: true },
    });
    expect(item).not.toBeNull();
    const res = await api(
      'POST',
      `/api/hr/payroll/periods/${finalizedPeriodId}/items/${item?.id}/exclude`,
      { token: payrollAdminToken, body: { note: 'too late' } },
    );
    expect(res.status).toBe(400);
  });

  it('keeps the snapshot byte-identical across reads', async () => {
    const item = await prisma.payrollItem.findFirst({
      where: { periodId: finalizedPeriodId, status: 'FINALIZED' },
      select: { id: true, snapshot: true },
    });
    const first = JSON.stringify(item?.snapshot);

    // A read of the payslip must not recompute or rewrite anything.
    await api('GET', `/api/hr/payroll/payslips/${item?.id}`, { token: payrollAdminToken });

    const after = await prisma.payrollItem.findUnique({
      where: { id: item?.id ?? '' },
      select: { snapshot: true },
    });
    expect(JSON.stringify(after?.snapshot)).toBe(first);
  });

  it('serves the payslip from the snapshot, with the not-applied statement', async () => {
    const item = await prisma.payrollItem.findFirst({
      where: { periodId: finalizedPeriodId, employeeId: staffEmployeeId },
      select: { id: true },
    });
    const res = await api('GET', `/api/hr/payroll/payslips/${item?.id}`, {
      token: staffToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const payslip = data<{
      payslip: { netPay: string; notApplied: string[]; earnings: Array<{ amount: string }> };
    }>(res).payslip;

    expect(payslip.earnings.length).toBeGreaterThan(0);
    expect(Number(payslip.netPay)).toBeGreaterThan(0);
    // The payslip states what it does not include rather than implying
    // completeness.
    expect(payslip.notApplied.join(' ')).toMatch(/configured, not certified/i);
  });

  it('refuses to issue a payslip for a period that is not finalised', async () => {
    const draftPeriod = await openPeriod(10);
    await api('POST', `/api/hr/payroll/periods/${draftPeriod}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    const item = await prisma.payrollItem.findFirst({
      where: { periodId: draftPeriod, employeeId: staffEmployeeId },
      select: { id: true },
    });
    const res = await api('GET', `/api/hr/payroll/payslips/${item?.id}`, {
      token: staffToken,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only once the payroll run is finalised/i);
  });
});

// ---------------------------------------------------------------------------
//  4. Separation of duties — refused BEFORE permission checks
// ---------------------------------------------------------------------------

describe('separation of duties', () => {
  it('refuses an approver who is paid by the run, despite holding APPROVE and ADMIN', async () => {
    const periodId = await openPeriod(11);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });

    // paidAdmin holds HR_PAYROLL:APPROVE by explicit grant AND the ADMIN role,
    // and has an employee record inside this run.
    const decided = await api('POST', `/api/hr/payroll/periods/${periodId}/decide`, {
      token: paidAdminToken,
      body: { decision: 'APPROVE' },
    });
    expect(decided.status).toBe(403);
    expect(decided.body.message).toMatch(/you are paid by this payroll run/i);

    // And the run is still waiting, not quietly approved.
    const period = await prisma.payrollPeriod.findUnique({
      where: { id: periodId },
      select: { status: true },
    });
    expect(period?.status).toBe('PENDING_APPROVAL');
  });

  it('refuses a finaliser who is paid by the run', async () => {
    const periodId = await openPeriod(12);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/decide`, {
      token: approverToken,
      body: { decision: 'APPROVE' },
    });

    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/finalize`, {
      token: paidAdminToken,
      body: { acknowledgeNotStatutory: true },
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/you are paid by this payroll run/i);

    const period = await prisma.payrollPeriod.findUnique({
      where: { id: periodId },
      select: { status: true, finalizedById: true },
    });
    expect(period?.status).toBe('APPROVED');
    expect(period?.finalizedById).toBeNull();
  });

  it('reports viewerCan.finalize as false for a reader inside the run', async () => {
    const periodId = await openPeriod(13);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });

    const res = await api('GET', `/api/hr/payroll/periods/${periodId}`, {
      token: paidAdminToken,
    });
    expect(res.status).toBe(200);
    const period = data<{
      period: { viewerIsPaidByThisRun: boolean; viewerCan: { finalize: boolean; approve: boolean } };
    }>(res).period;
    expect(period.viewerIsPaidByThisRun).toBe(true);
    expect(period.viewerCan.finalize).toBe(false);
    expect(period.viewerCan.approve).toBe(false);
  });

  it('refuses somebody setting their own salary, whatever grants they hold', async () => {
    const res = await api('POST', '/api/hr/payroll/salaries', {
      token: paidAdminToken,
      body: {
        employeeId: paidAdminEmployeeId,
        structureId,
        monthlyGross: '999999.00',
        effectiveFrom: `${BASE_YEAR}-06-01`,
      },
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/cannot set your own salary/i);
  });

  it('refuses somebody recording an adjustment against themselves', async () => {
    const res = await api('POST', '/api/hr/payroll/adjustments', {
      token: paidAdminToken,
      body: {
        employeeId: paidAdminEmployeeId,
        kind: 'BONUS',
        amount: '5000.00',
        reason: 'self-awarded bonus',
      },
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/against yourself/i);
  });

  it('requires the not-statutory acknowledgement to finalise', async () => {
    const periodId = await openPeriod(14);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/decide`, {
      token: approverToken,
      body: { decision: 'APPROVE' },
    });

    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/finalize`, {
      token: approverToken,
      body: {},
    });
    expect(res.status).toBe(422);
    /*
      Two minutes rather than the 60 s default, for this test only.

      It makes five sequential HTTP calls — openPeriod, calculate, submit, decide,
      finalize — and `calculate` alone has been observed between 22 s and 41 s
      against the remote Neon database, because it issues roughly thirty round
      trips (one per employee for the salary lookup, the attendance reads and the
      per-employee write transaction). A run where those four calls totalled 48.5 s
      left under 12 s for `finalize`, which is itself the slowest endpoint here,
      and the test timed out at 60,022 ms with its assertion never evaluated.

      Nothing is being weakened: the assertion, the request sequence and the
      business rule are unchanged, and the rule itself is enforced twice over
      (`z.literal(true)` in finalizePayrollSchema and a re-check in
      payroll-run.service.ts). The 60 s default was simply shorter than the work
      this test legitimately does at current database latency.
    */
  }, 120_000);
});

// ---------------------------------------------------------------------------
//  5. Self-service confidentiality
// ---------------------------------------------------------------------------

describe('self-service never leaks another employee', () => {
  let finalizedPeriodId: string;
  let staffItemId: string;
  let otherItemId: string;

  beforeAll(async () => {
    const run = await finalizeRun(15);
    finalizedPeriodId = run.periodId;
    const staffItem = await prisma.payrollItem.findUnique({
      where: { periodId_employeeId: { periodId: finalizedPeriodId, employeeId: staffEmployeeId } },
      select: { id: true },
    });
    const otherItem = await prisma.payrollItem.findUnique({
      where: { periodId_employeeId: { periodId: finalizedPeriodId, employeeId: otherEmployeeId } },
      select: { id: true },
    });
    staffItemId = staffItem?.id ?? '';
    otherItemId = otherItem?.id ?? '';
  }, 120_000);

  it('lets an employee read their own payslip with no payroll grant', async () => {
    const res = await api('GET', `/api/hr/payroll/payslips/${staffItemId}`, {
      token: staffToken,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const payslip = data<{ payslip: { employee: { id: string } } }>(res).payslip;
    expect(payslip.employee.id).toBe(staffEmployeeId);
  });

  it("returns 404 — not 403 — for another employee's payslip", async () => {
    // 404 rather than 403 on purpose: "you may not read employee X's payslip"
    // confirms X is paid and roughly when.
    const res = await api('GET', `/api/hr/payroll/payslips/${otherItemId}`, {
      token: staffToken,
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('60000');
  });

  it('scopes the items list to the reader own line only', async () => {
    const res = await api(
      'GET',
      `/api/hr/payroll/periods/${finalizedPeriodId}/items?limit=50`,
      { token: staffToken },
    );
    expect(res.status).toBe(200);
    const items = data<{ items: Array<{ employee: { id: string } }> }>(res).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.employee.id).toBe(staffEmployeeId);
  });

  it('gives an authorised payroll reader every line', async () => {
    const res = await api(
      'GET',
      `/api/hr/payroll/periods/${finalizedPeriodId}/items?limit=50`,
      { token: payrollAdminToken },
    );
    expect(res.status).toBe(200);
    const items = data<{ items: unknown[] }>(res).items;
    expect(items.length).toBeGreaterThan(1);
  });

  it('returns only the reader own salary history', async () => {
    const res = await api('GET', '/api/hr/payroll/salaries?includeHistory=true', {
      token: staffToken,
    });
    expect(res.status).toBe(200);
    const assignments = data<{ assignments: Array<{ employee: { id: string } }> }>(res)
      .assignments;
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      expect(a.employee.id).toBe(staffEmployeeId);
    }
  });

  it("refuses a request for another employee's salary history", async () => {
    const res = await api(`GET`, `/api/hr/payroll/salaries?employeeId=${otherEmployeeId}`, {
      token: staffToken,
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('60000');
  });

  it('serves /payroll/mine without any employee parameter', async () => {
    const res = await api('GET', '/api/hr/payroll/mine', { token: staffToken });
    expect(res.status).toBe(200);
    const mine = data<{
      mine: { employee: { id: string } | null; payslips: unknown[]; currentSalary: unknown };
    }>(res).mine;
    expect(mine.employee?.id).toBe(staffEmployeeId);
    expect(mine.currentSalary).not.toBeNull();
    expect(mine.payslips.length).toBeGreaterThan(0);
  });

  it('gives an employee no company figures on the overview', async () => {
    const res = await api('GET', '/api/hr/payroll/overview', { token: staffToken });
    expect(res.status).toBe(200);
    const overview = data<{
      overview: {
        canReadAll: boolean;
        openPeriods: unknown[];
        employeesWithoutSalaryCount: number | null;
        lastFinalizedPeriod: unknown;
      };
    }>(res).overview;
    expect(overview.canReadAll).toBe(false);
    expect(overview.openPeriods).toEqual([]);
    expect(overview.employeesWithoutSalaryCount).toBeNull();
    expect(overview.lastFinalizedPeriod).toBeNull();
  });

  it('refuses an employee the period list entirely', async () => {
    const res = await api('GET', '/api/hr/payroll/periods', { token: staffToken });
    expect(res.status).toBe(403);
  });

  it('refuses an employee the component catalogue', async () => {
    const res = await api('GET', '/api/hr/payroll/components', { token: staffToken });
    expect(res.status).toBe(403);
  });

  it('refuses an employee the summary', async () => {
    const res = await api('GET', `/api/hr/payroll/periods/${finalizedPeriodId}/summary`, {
      token: staffToken,
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
//  9. EXPORT is a separate privilege from VIEW
// ---------------------------------------------------------------------------

describe('export authorization', () => {
  let periodId: string;

  beforeAll(async () => {
    const run = await finalizeRun(16);
    periodId = run.periodId;
  }, 120_000);

  it('lets a holder of EXPORT download the register', async () => {
    const res = await fetch(
      `http://127.0.0.1:${new URL(await startTestServer()).port}/api/hr/payroll/periods/${periodId}/export`,
      { headers: { Authorization: `Bearer ${payrollAdminToken}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    const csv = await res.text();
    expect(csv.split('\r\n')[0]).toMatch(/Employee Id,Name/);
  });

  it('refuses an employee with no payroll grant', async () => {
    const res = await api('GET', `/api/hr/payroll/periods/${periodId}/export`, {
      token: staffToken,
    });
    expect(res.status).toBe(403);
  });

  it('refuses a reader who holds VIEW but whose EXPORT is revoked', async () => {
    // The whole reason EXPORT exists: reading one payslip on screen and taking
    // every salary out of the building are different risks.
    await revoke(payrollAdmin.id, 'HR_PAYROLL', 'EXPORT');
    const res = await api('GET', `/api/hr/payroll/periods/${periodId}/export`, {
      token: payrollAdminToken,
    });
    expect(res.status).toBe(403);

    // Restored, so later tests keep their grant.
    await grant(payrollAdmin.id, 'HR_PAYROLL', ['EXPORT']);
    const after = await api('GET', `/api/hr/payroll/periods/${periodId}/summary`, {
      token: payrollAdminToken,
    });
    expect(after.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  6. Missing policy inputs are reported, never guessed
// ---------------------------------------------------------------------------

describe('missing policy inputs', () => {
  it('reports unvalued overtime rather than assuming a multiplier', async () => {
    // No HRSetting for overtime.multiplier exists in this database.
    await prisma.overtimeRecord.create({
      data: {
        employeeId: staffEmployeeId,
        overtimeDate: new Date(Date.UTC(BASE_YEAR + 1, 4, 10)),
        minutes: 120,
        status: 'APPROVED',
        // `overtime_decision_consistency` requires a decider and a timestamp on
        // anything that is not PENDING — an approved record that cannot say who
        // approved it is exactly what that CHECK exists to prevent.
        decidedById: payrollAdmin.id,
        decidedAt: new Date(),
      },
    });

    const periodId = await openPeriod(17);
    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(res.status).toBe(200);
    const result = data<{
      result: { warnings: Array<{ message: string }> };
    }>(res).result;

    const overtimeWarning = result.warnings.find((w) => /overtime/i.test(w.message));
    expect(overtimeWarning, JSON.stringify(result.warnings)).toBeDefined();
    expect(overtimeWarning?.message).toMatch(/not valued/i);

    // And no OVERTIME line was invented.
    const lines = await prisma.payrollItemLine.findMany({
      where: { item: { periodId, employeeId: staffEmployeeId }, componentCode: 'OVERTIME' },
    });
    expect(lines).toHaveLength(0);
  });

  it('reports a missing deduction configuration on the payslip itself', async () => {
    const { periodId } = await finalizeRun(18);
    const item = await prisma.payrollItem.findUnique({
      where: { periodId_employeeId: { periodId, employeeId: staffEmployeeId } },
      select: { id: true },
    });
    const res = await api('GET', `/api/hr/payroll/payslips/${item?.id}`, {
      token: staffToken,
    });
    expect(res.status).toBe(200);
    const payslip = data<{ payslip: { notApplied: string[] } }>(res).payslip;
    expect(payslip.notApplied.join(' ')).toMatch(/configured, not certified/i);
  });
});

// ---------------------------------------------------------------------------
//  Validation and rollback
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('refuses a negative salary at the boundary', async () => {
    const res = await api('POST', '/api/hr/payroll/salaries', {
      token: payrollAdminToken,
      body: {
        employeeId: staffEmployeeId,
        monthlyGross: '-5000.00',
        effectiveFrom: `${BASE_YEAR}-07-01`,
      },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a percentage component with no rate', async () => {
    const res = await api('POST', '/api/hr/payroll/components', {
      token: payrollAdminToken,
      body: {
        code: `BADPCT${Date.now() % 100000}`,
        name: 'Bad percentage',
        kind: 'DEDUCTION',
        calculation: 'PERCENT_OF_BASE',
      },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a deduction marked as the base', async () => {
    const res = await api('POST', '/api/hr/payroll/components', {
      token: payrollAdminToken,
      body: {
        code: `BADBASE${Date.now() % 100000}`,
        name: 'Bad base',
        kind: 'DEDUCTION',
        calculation: 'FIXED',
        isBase: true,
      },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a rate above 100 percent', async () => {
    const res = await api('POST', '/api/hr/payroll/components', {
      token: payrollAdminToken,
      body: {
        code: `BADRATE${Date.now() % 100000}`,
        name: 'Impossible rate',
        kind: 'DEDUCTION',
        calculation: 'PERCENT_OF_BASE',
        rate: '150',
      },
    });
    expect(res.status).toBe(422);
  });

  it('rolls back a structure whose component does not exist', async () => {
    const before = await prisma.salaryStructure.count();
    const res = await api('POST', '/api/hr/payroll/structures', {
      token: payrollAdminToken,
      body: {
        code: `ROLLBACK${Date.now() % 100000}`,
        name: 'Should not persist',
        components: [{ componentId: 'cjld2cjxh0000qzrmn831i7rn', displayOrder: 10 }],
      },
    });
    expect(res.status).toBe(400);
    // Nothing persisted: the structure and its rows are one transaction.
    const after = await prisma.salaryStructure.count();
    expect(after).toBe(before);
  });

  it('refuses a second salary assignment effective the same day', async () => {
    const day = `${BASE_YEAR}-08-01`;
    const first = await api('POST', '/api/hr/payroll/salaries', {
      token: payrollAdminToken,
      body: { employeeId: otherEmployeeId, structureId, monthlyGross: '61000.00', effectiveFrom: day },
    });
    expect(first.status).toBe(201);

    const second = await api('POST', '/api/hr/payroll/salaries', {
      token: payrollAdminToken,
      body: { employeeId: otherEmployeeId, structureId, monthlyGross: '62000.00', effectiveFrom: day },
    });
    expect(second.status).toBe(409);
  });

  it('keeps salary history append-only: the earlier row survives unchanged', async () => {
    const rows = await prisma.employeeSalary.findMany({
      where: { employeeId: otherEmployeeId },
      select: { monthlyGross: true, effectiveFrom: true, effectiveTo: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The original assignment is still there with its original figure, and now
    // carries an end date rather than having been overwritten.
    const original = rows[0];
    expect(original?.monthlyGross.toFixed(2)).toBe('60000.00');
    expect(original?.effectiveTo).not.toBeNull();
  });

  it('refuses submitting a run with nothing costed', async () => {
    const periodId = await openPeriod(19);
    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('refuses an adjustment against a period that is not finalised', async () => {
    const periodId = await openPeriod(20);
    const res = await api('POST', '/api/hr/payroll/adjustments', {
      token: payrollAdminToken,
      body: {
        employeeId: staffEmployeeId,
        kind: 'ARREAR',
        amount: '1000.00',
        reason: 'test',
        correctsPeriodId: periodId,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not finalised/i);
  });
});

// ---------------------------------------------------------------------------
//  Rejection path and cancellation
// ---------------------------------------------------------------------------

describe('rejection and cancellation', () => {
  it('sends a rejected run back to CALCULATED with no approval stamp', async () => {
    const periodId = await openPeriod(21);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });

    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/decide`, {
      token: approverToken,
      body: { decision: 'REJECT', note: 'attendance looks wrong for two people' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const period = await prisma.payrollPeriod.findUnique({
      where: { id: periodId },
      select: { status: true, approvedAt: true, approvedById: true },
    });
    expect(period?.status).toBe('CALCULATED');
    expect(period?.approvedAt).toBeNull();
    expect(period?.approvedById).toBeNull();
  });

  it('requires a note when rejecting', async () => {
    const periodId = await openPeriod(22);
    await api('POST', `/api/hr/payroll/periods/${periodId}/calculate`, {
      token: payrollAdminToken,
      body: {},
    });
    await api('POST', `/api/hr/payroll/periods/${periodId}/submit`, {
      token: payrollAdminToken,
      body: {},
    });
    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/decide`, {
      token: approverToken,
      body: { decision: 'REJECT' },
    });
    expect(res.status).toBe(422);
  });

  it('cancels an open run and records the reason', async () => {
    const periodId = await openPeriod(23);
    const res = await api('POST', `/api/hr/payroll/periods/${periodId}/cancel`, {
      token: approverToken,
      body: { reason: 'opened for the wrong month' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const period = await prisma.payrollPeriod.findUnique({
      where: { id: periodId },
      select: { status: true, cancellationReason: true },
    });
    expect(period?.status).toBe('CANCELLED');
    expect(period?.cancellationReason).toMatch(/wrong month/);
  });
});
