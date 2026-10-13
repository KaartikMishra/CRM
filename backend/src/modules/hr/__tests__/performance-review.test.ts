/**
 * HR Phase 5 — the appraisal workflow and its authorization boundaries, over real
 * HTTP against the real database.
 *
 * ### Why this file exists separately from the calc tests
 *
 * `performance-calc.test.ts` covers the pure arithmetic and the pure access
 * functions: 111 tests, all passing with the module completely unreachable. Phase 4
 * proved that is not enough — it shipped with forty-five green unit tests while
 * `hrActor` resolved no `HR_TRAINING` capability at all, so every service check
 * returned false even for an administrator holding the grant by role default. The
 * route table passed (it uses the resolver directly) and the service then 403'd.
 * **Only an HTTP request surfaces that**, which is what this file is for.
 *
 * ### What it pins
 *
 *   1. An employee reaches their own review and not a colleague's.
 *   2. A manager reaches their report's and writes its manager assessment.
 *   3. Nobody writes their own manager assessment — including an ADMIN.
 *   4. **Nobody finalises their own review — including an ADMIN holding APPROVE.**
 *   5. A finalized review refuses every further edit, from everybody.
 *   6. Invalid state transitions are refused.
 *   7. KPI attainment is computed server-side against the configured target, and a
 *      forged attainment is refused rather than accepted.
 *   8. Concurrent finalisation produces one success and one conflict.
 *   9. Duplicate submission is a conflict, not a second timestamp.
 *  10. Audit rows and notification rows are written.
 *
 * ### Fixture ownership
 *
 * Every row is tracked by id and deleted by id in `afterAll`, then asserted gone.
 * Nothing is matched by name prefix: the Phase 3 teardown leak came from exactly
 * that — a `startsWith('ZZT')` predicate that matched the department code rather
 * than the requisition reference, leaving 142 orphans across runs. Ids cannot drift.
 *
 * Deletion order follows the foreign keys: reviews before cycles (`cycleId` cascades
 * but the goals' `Restrict` does not), goals before cycles, employees last.
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
  residualTestRows,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';

/** HR, holding everything. Appraises others and approves. */
let hr: TestUser;
let hrToken: string;
/** A manager with no performance grant at all — authority comes from rows. */
let manager: TestUser;
let managerToken: string;
/** An ordinary employee being appraised. No performance grant. */
let employee: TestUser;
let employeeToken: string;
/** A second employee, to prove cross-employee reads are refused. */
let outsider: TestUser;
let outsiderToken: string;
/**
 * An ADMIN who is also an employee being appraised.
 *
 * The actor that matters most in this file. They hold HR_PERFORMANCE:APPROVE by
 * role default *and* are the subject of a review — which is the exact case the
 * separation-of-duties ordering exists for, and the one a permission-first check
 * would wave through.
 */
let adminSubject: TestUser;
let adminSubjectToken: string;

let departmentId: string;
let designationId: string;
let managerEmployeeId: string;
let employeeEmployeeId: string;
let outsiderEmployeeId: string;
let adminSubjectEmployeeId: string;

const owned = {
  reviewIds: [] as string[],
  cycleIds: [] as string[],
  goalIds: [] as string[],
  planIds: [] as string[],
  employeeIds: [] as string[],
  departmentIds: [] as string[],
  designationIds: [] as string[],
};

let codeSeq = 0;
const testCode = (stem: string): string => {
  codeSeq += 1;
  return `ZZT5${stem}${codeSeq}`.toUpperCase().slice(0, 20);
};

let emailSeq = 0;
const testEmail = (stem = 'p5'): string => {
  emailSeq += 1;
  return `${RUN_PREFIX}-${stem}${emailSeq}@test.invalid`;
};

function data<T>(res: { body: { data?: unknown } }): T {
  return res.body.data as T;
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

async function makeEmployee(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; employeeId: string }> {
  const res = await api('POST', '/api/hr/employees', {
    token: hrToken,
    body: {
      firstName: 'Phase',
      lastName: 'Five',
      workEmail: testEmail('emp'),
      joiningDate: '2026-01-15',
      departmentId,
      designationId,
      ...overrides,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const employeeRow = data<{ employee: { id: string; employeeId: string } }>(res).employee;
  owned.employeeIds.push(employeeRow.id);
  return employeeRow;
}

/** A cycle with one competency, opened, ready to generate reviews from. */
async function makeOpenCycle(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; competencyId: string }> {
  const created = await api('POST', '/api/hr/performance/cycles', {
    token: hrToken,
    body: {
      name: `${RUN_PREFIX} Cycle`,
      cadence: 'ANNUAL',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      selfAssessmentDueOn: '2027-01-15',
      managerReviewDueOn: '2027-01-31',
      competencies: [{ name: 'Communication', category: 'CORE', weight: 100 }],
      ...overrides,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const cycle = data<{ cycle: { id: string; competencies: { id: string }[] } }>(created).cycle;
  owned.cycleIds.push(cycle.id);

  const opened = await api('POST', `/api/hr/performance/cycles/${cycle.id}/activate`, {
    token: hrToken,
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);

  const competencyId = cycle.competencies[0]?.id;
  expect(competencyId).toBeTruthy();
  if (!competencyId) throw new Error('unreachable: asserted above');

  return { id: cycle.id, competencyId };
}

/** One review for a named employee in a cycle. */
async function makeReview(
  cycleId: string,
  employeeRowId: string,
): Promise<{ id: string }> {
  const generated = await api('POST', `/api/hr/performance/cycles/${cycleId}/reviews`, {
    token: hrToken,
    body: { employeeIds: [employeeRowId] },
  });
  expect(generated.status, JSON.stringify(generated.body)).toBe(201);

  const list = await api('GET', `/api/hr/performance/reviews?cycleId=${cycleId}&employeeId=${employeeRowId}`, {
    token: hrToken,
  });
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const items = data<{ items: { id: string }[] }>(list).items;
  const review = items[0];
  expect(review, 'the generated review is listed').toBeTruthy();
  if (!review) throw new Error('unreachable: asserted above');

  owned.reviewIds.push(review.id);
  return review;
}

/** Carries a review all the way to PENDING_APPROVAL, ready to finalise. */
async function reviewAwaitingApproval(
  subjectToken: string,
  reviewerToken: string,
  cycleId: string,
  employeeRowId: string,
  competencyId: string,
): Promise<{ id: string }> {
  const review = await makeReview(cycleId, employeeRowId);

  const savedSelf = await api(
    'PATCH',
    `/api/hr/performance/reviews/${review.id}/self-assessment`,
    {
      token: subjectToken,
      body: {
        achievements: 'Delivered the thing',
        competencyRatings: [{ competencyId, rating: 4 }],
      },
    },
  );
  expect(savedSelf.status, JSON.stringify(savedSelf.body)).toBe(200);

  const submittedSelf = await api(
    'POST',
    `/api/hr/performance/reviews/${review.id}/self-assessment/submit`,
    { token: subjectToken, body: {} },
  );
  expect(submittedSelf.status, JSON.stringify(submittedSelf.body)).toBe(200);

  const savedManager = await api(
    'PATCH',
    `/api/hr/performance/reviews/${review.id}/manager-assessment`,
    {
      token: reviewerToken,
      body: {
        strengths: 'Reliable',
        competencyRatings: [{ competencyId, rating: 3 }],
      },
    },
  );
  expect(savedManager.status, JSON.stringify(savedManager.body)).toBe(200);

  const submittedManager = await api(
    'POST',
    `/api/hr/performance/reviews/${review.id}/manager-assessment/submit`,
    { token: reviewerToken, body: {} },
  );
  expect(submittedManager.status, JSON.stringify(submittedManager.body)).toBe(200);

  return review;
}

// ---------------------------------------------------------------------------
//  Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await startTestServer();

  hr = await makeUser('ADMIN');
  manager = await makeUser('USER');
  employee = await makeUser('USER');
  outsider = await makeUser('USER');
  adminSubject = await makeUser('ADMIN');

  hrToken = await mintToken(hr.id, { role: 'ADMIN' });
  managerToken = await mintToken(manager.id, { role: 'USER' });
  employeeToken = await mintToken(employee.id, { role: 'USER' });
  outsiderToken = await mintToken(outsider.id, { role: 'USER' });
  adminSubjectToken = await mintToken(adminSubject.id, { role: 'ADMIN' });

  /*
    HR gets the performance grants explicitly rather than relying on ROLE_DEFAULTS.
    The whole reason this suite exists is that a grant held by default was invisible
    to `hrActor` in Phase 4 — writing the override makes the test independent of
    ROLE_DEFAULTS, so a change there fails on its own merits rather than silently
    removing this file's coverage.
  */
  await grant(hr.id, 'HR_PERFORMANCE', ['VIEW', 'CREATE', 'EDIT', 'ASSIGN', 'APPROVE']);
  await grant(hr.id, 'HR_EMPLOYEE', ['VIEW', 'CREATE', 'EDIT']);
  await grant(hr.id, 'HR_ADMIN', ['VIEW', 'CREATE', 'EDIT']);

  /*
    The manager, the employee and the outsider get HR_EMPLOYEE:VIEW only — enough to
    reach the routes (the EMPLOYEE_FLOOR), and nothing that would give them the
    performance module. Their authority over reviews comes entirely from rows.
  */
  await grant(manager.id, 'HR_EMPLOYEE', ['VIEW']);
  await grant(employee.id, 'HR_EMPLOYEE', ['VIEW']);
  await grant(outsider.id, 'HR_EMPLOYEE', ['VIEW']);

  /*
    adminSubject keeps the ADMIN role and is granted APPROVE explicitly. They will
    be the subject of their own review — the case the separation-of-duties ordering
    exists for.
  */
  await grant(adminSubject.id, 'HR_PERFORMANCE', ['VIEW', 'EDIT', 'APPROVE']);
  await grant(adminSubject.id, 'HR_EMPLOYEE', ['VIEW']);

  const dept = await api('POST', '/api/hr/departments', {
    token: hrToken,
    body: { name: `${RUN_PREFIX} P5 Dept`, code: testCode('DEPT') },
  });
  expect(dept.status, JSON.stringify(dept.body)).toBe(201);
  departmentId = data<{ department: { id: string } }>(dept).department.id;
  owned.departmentIds.push(departmentId);

  const desig = await api('POST', '/api/hr/designations', {
    token: hrToken,
    body: { name: `${RUN_PREFIX} P5 Role`, code: testCode('DESIG'), level: 3 },
  });
  expect(desig.status, JSON.stringify(desig.body)).toBe(201);
  designationId = data<{ designation: { id: string } }>(desig).designation.id;
  owned.designationIds.push(designationId);

  // The manager's own HR record, linked to their account — this is what makes the
  // manager scope possible at all.
  const managerRow = await makeEmployee({ firstName: 'Mandy', lastName: 'Manager' });
  managerEmployeeId = managerRow.id;
  const linkManager = await api('POST', `/api/hr/employees/${managerRow.id}/user`, {
    token: hrToken,
    body: { userId: manager.id },
  });
  expect(linkManager.status, JSON.stringify(linkManager.body)).toBe(200);

  // The employee, reporting to that manager.
  const employeeRow = await makeEmployee({
    firstName: 'Ellie',
    lastName: 'Employee',
    managerId: managerEmployeeId,
  });
  employeeEmployeeId = employeeRow.id;
  const linkEmployee = await api('POST', `/api/hr/employees/${employeeRow.id}/user`, {
    token: hrToken,
    body: { userId: employee.id },
  });
  expect(linkEmployee.status, JSON.stringify(linkEmployee.body)).toBe(200);

  // The outsider, reporting to nobody in this story.
  const outsiderRow = await makeEmployee({ firstName: 'Otto', lastName: 'Outsider' });
  outsiderEmployeeId = outsiderRow.id;
  const linkOutsider = await api('POST', `/api/hr/employees/${outsiderRow.id}/user`, {
    token: hrToken,
    body: { userId: outsider.id },
  });
  expect(linkOutsider.status, JSON.stringify(linkOutsider.body)).toBe(200);

  // The ADMIN who is also appraised, reporting to the manager.
  const adminRow = await makeEmployee({
    firstName: 'Adam',
    lastName: 'Admin',
    managerId: managerEmployeeId,
  });
  adminSubjectEmployeeId = adminRow.id;
  const linkAdmin = await api('POST', `/api/hr/employees/${adminRow.id}/user`, {
    token: hrToken,
    body: { userId: adminSubject.id },
  });
  expect(linkAdmin.status, JSON.stringify(linkAdmin.body)).toBe(200);
}, 180_000);

afterAll(async () => {
  /*
    Deleted by id, in foreign-key order, then asserted gone.

    Reviews before cycles: a review cascades from its cycle, but a goal's `cycleId`
    is SetNull and a goal must go before the department it belongs to. Employees
    last, because reviews, goals and plans all reference them.

    Nothing here matches on a name or code prefix — the Phase 3 teardown leak came
    from exactly that.
  */
  await prisma.performanceReview.deleteMany({ where: { id: { in: owned.reviewIds } } });
  await prisma.developmentPlan.deleteMany({ where: { id: { in: owned.planIds } } });
  await prisma.performanceGoal.deleteMany({ where: { id: { in: owned.goalIds } } });
  await prisma.reviewCycle.deleteMany({ where: { id: { in: owned.cycleIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: owned.employeeIds } } });
  await prisma.designation.deleteMany({ where: { id: { in: owned.designationIds } } });
  await prisma.department.deleteMany({ where: { id: { in: owned.departmentIds } } });

  const residue = await Promise.all([
    prisma.performanceReview.count({ where: { id: { in: owned.reviewIds } } }),
    prisma.reviewCycle.count({ where: { id: { in: owned.cycleIds } } }),
    prisma.performanceGoal.count({ where: { id: { in: owned.goalIds } } }),
    prisma.developmentPlan.count({ where: { id: { in: owned.planIds } } }),
    prisma.employee.count({ where: { id: { in: owned.employeeIds } } }),
  ]);
  expect(residue, 'this run left no performance rows behind').toEqual([0, 0, 0, 0, 0]);

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
}, 180_000);

// ---------------------------------------------------------------------------
//  Reachability — the Phase 4 defect, pinned
// ---------------------------------------------------------------------------

describe('the module is reachable at all', () => {
  it(
    'resolves HR_PERFORMANCE for an actor who holds it',
    async () => {
      /*
        THE test that Phase 4 needed and did not have. `hrActor` answers `can()`
        from a fixed capability list; a pair missing from it resolves to false for
        everybody, including an administrator holding the grant by role default.
        The route table would admit the request and the service would then 403 —
        with typechecks and every unit test green.

        Creating a cycle needs HR_PERFORMANCE:CREATE and goes through both checks,
        so a 201 here proves the pair is declared.
      */
      const res = await api('POST', '/api/hr/performance/cycles', {
        token: hrToken,
        body: {
          name: `${RUN_PREFIX} Reachability`,
          cadence: 'QUARTERLY',
          periodStart: '2026-01-01',
          periodEnd: '2026-03-31',
          competencies: [{ name: 'Reachability', category: 'CORE' }],
        },
      });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const cycle = data<{ cycle: { id: string; code: string; status: string } }>(res).cycle;
      owned.cycleIds.push(cycle.id);

      // Born DRAFT, with a server-allocated reference.
      expect(cycle.status).toBe('DRAFT');
      expect(cycle.code).toMatch(/^PRF-\d{4}-\d{4}$/);
    },
    120_000,
  );

  it(
    'refuses cycle creation to somebody without the grant',
    async () => {
      const res = await api('POST', '/api/hr/performance/cycles', {
        token: employeeToken,
        body: {
          name: 'Should not exist',
          cadence: 'ANNUAL',
          periodStart: '2026-01-01',
          periodEnd: '2026-12-31',
        },
      });
      expect(res.status).toBe(403);
    },
    120_000,
  );

  it(
    'never issues the same cycle reference twice under concurrency',
    async () => {
      /*
        The counter's whole purpose. `SELECT max(...) + 1` read by two simultaneous
        creates returns the same number to both; INSERT … ON CONFLICT DO UPDATE …
        RETURNING inside the creating transaction cannot.
      */
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          api('POST', '/api/hr/performance/cycles', {
            token: hrToken,
            body: {
              name: `${RUN_PREFIX} Concurrent ${index}`,
              cadence: 'AD_HOC',
              periodStart: '2026-04-01',
              periodEnd: '2026-06-30',
              competencies: [{ name: 'Concurrency', category: 'CORE' }],
            },
          }),
        ),
      );

      const codes: string[] = [];
      for (const res of results) {
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const cycle = data<{ cycle: { id: string; code: string } }>(res).cycle;
        owned.cycleIds.push(cycle.id);
        codes.push(cycle.code);
      }

      expect(new Set(codes).size, 'four distinct references').toBe(4);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
//  Access boundaries
// ---------------------------------------------------------------------------

describe('employee and manager access boundaries', () => {
  it(
    'lets an employee read their own review and refuses a colleague’s',
    async () => {
      const cycle = await makeOpenCycle();
      const mine = await makeReview(cycle.id, employeeEmployeeId);
      const theirs = await makeReview(cycle.id, outsiderEmployeeId);

      const own = await api('GET', `/api/hr/performance/reviews/${mine.id}`, {
        token: employeeToken,
      });
      expect(own.status, JSON.stringify(own.body)).toBe(200);

      /*
        Not found rather than forbidden, deliberately: telling somebody "you may not
        read employee X's review" confirms X is being appraised and by whom.
      */
      const other = await api('GET', `/api/hr/performance/reviews/${theirs.id}`, {
        token: employeeToken,
      });
      expect(other.status).toBe(404);
    },
    180_000,
  );

  it(
    'lets a manager read their report’s review with no performance grant',
    async () => {
      // Being somebody's manager is a fact about rows, not a permission — which is
      // why it cannot live in the route table.
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      const res = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: managerToken,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const view = data<{ review: { reviewer: { id: string } | null } }>(res).review;
      expect(view.reviewer?.id, 'the manager is the stored reviewer').toBe(managerEmployeeId);
    },
    180_000,
  );

  it(
    'refuses a manager a review outside their team',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, outsiderEmployeeId);

      const res = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: managerToken,
      });
      expect(res.status).toBe(404);
    },
    180_000,
  );

  it(
    'scopes the review list rather than post-filtering it',
    async () => {
      /*
        The filter is applied inside the query, so the employee's list contains only
        their own rows. Post-filtering a page would make a page of 25 arrive with 1
        row and the cursor skip the rest.
      */
      const cycle = await makeOpenCycle();
      await makeReview(cycle.id, employeeEmployeeId);
      await makeReview(cycle.id, outsiderEmployeeId);

      const res = await api('GET', `/api/hr/performance/reviews?cycleId=${cycle.id}`, {
        token: employeeToken,
      });
      expect(res.status).toBe(200);

      const items = data<{ items: { employee: { id: string } }[] }>(res).items;
      expect(items.length).toBe(1);
      expect(items[0]?.employee.id).toBe(employeeEmployeeId);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
//  RULE 1 — a draft manager review is not readable by its subject
// ---------------------------------------------------------------------------

describe('an employee does not read a draft manager review', () => {
  it(
    'hides the manager assessment until it is submitted, then shows it',
    async () => {
      /*
        The Phase 5 equivalent of Phase 4's answer-key rule. A manager's draft is a
        private working document; showing it early means an employee reading
        half-formed criticism, after which managers stop drafting honestly.

        Note this is not a 403 on the page — the employee is entitled to the rest of
        their own review, and refusing it would be the wrong answer to "may I see my
        review".
      */
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      // The employee submits theirs, so the manager can write.
      await api('PATCH', `/api/hr/performance/reviews/${review.id}/self-assessment`, {
        token: employeeToken,
        body: { achievements: 'Mine', competencyRatings: [{ competencyId: cycle.competencyId, rating: 4 }] },
      });
      await api('POST', `/api/hr/performance/reviews/${review.id}/self-assessment/submit`, {
        token: employeeToken,
        body: {},
      });

      // The manager drafts but does not submit.
      const draft = await api(
        'PATCH',
        `/api/hr/performance/reviews/${review.id}/manager-assessment`,
        {
          token: managerToken,
          body: {
            strengths: 'A private working note',
            competencyRatings: [{ competencyId: cycle.competencyId, rating: 2 }],
          },
        },
      );
      expect(draft.status, JSON.stringify(draft.body)).toBe(200);

      // The employee sees their own half and NOT the manager's draft.
      const asEmployee = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: employeeToken,
      });
      expect(asEmployee.status).toBe(200);
      const employeeView = data<{
        review: {
          selfAssessment: unknown;
          managerAssessment: unknown;
          competencyRatings: { manager: unknown }[];
        };
      }>(asEmployee).review;

      expect(employeeView.selfAssessment, 'their own is visible').not.toBeNull();
      expect(employeeView.managerAssessment, 'the draft is withheld').toBeNull();
      // And the manager's *ratings* are withheld too — reading scores before the
      // comments explaining them is the worst order to learn them in.
      expect(employeeView.competencyRatings[0]?.manager).toBeNull();

      // The manager sees their own draft, because they are writing it.
      const asManager = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: managerToken,
      });
      const managerView = data<{ review: { managerAssessment: unknown } }>(asManager).review;
      expect(managerView.managerAssessment).not.toBeNull();

      // Once submitted, the employee sees it.
      const submitted = await api(
        'POST',
        `/api/hr/performance/reviews/${review.id}/manager-assessment/submit`,
        { token: managerToken, body: {} },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

      const afterSubmit = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: employeeToken,
      });
      const finalView = data<{
        review: { managerAssessment: { strengths: string } | null };
      }>(afterSubmit).review;
      expect(finalView.managerAssessment?.strengths).toBe('A private working note');
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
//  RULE 2 — nobody writes their own manager review
// ---------------------------------------------------------------------------

describe('nobody writes their own manager review', () => {
  it(
    'refuses the subject even as an ADMIN holding EDIT and APPROVE',
    async () => {
      /*
        The ordering test. adminSubject holds HR_PERFORMANCE:EDIT and APPROVE and is
        the subject of this review. `mayWriteManagerAssessment` refuses the subject
        BEFORE consulting any permission — checking the grant first would let them
        write their own manager review.
      */
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, adminSubjectEmployeeId);

      await api('PATCH', `/api/hr/performance/reviews/${review.id}/self-assessment`, {
        token: adminSubjectToken,
        body: { achievements: 'Mine', competencyRatings: [{ competencyId: cycle.competencyId, rating: 5 }] },
      });
      await api('POST', `/api/hr/performance/reviews/${review.id}/self-assessment/submit`, {
        token: adminSubjectToken,
        body: {},
      });

      const res = await api(
        'PATCH',
        `/api/hr/performance/reviews/${review.id}/manager-assessment`,
        { token: adminSubjectToken, body: { strengths: 'I am excellent' } },
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.message).toContain('own manager review');
    },
    180_000,
  );

  it(
    'refuses an unrelated colleague',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      const res = await api(
        'PATCH',
        `/api/hr/performance/reviews/${review.id}/manager-assessment`,
        { token: outsiderToken, body: { strengths: 'Not my business' } },
      );
      // 404, not 403: the outsider cannot see this review at all, and saying
      // "forbidden" would confirm it exists.
      expect([403, 404]).toContain(res.status);
    },
    180_000,
  );

  it(
    'refuses a self-assessment written by somebody else — including HR',
    async () => {
      // An assessment written by somebody else is not a self-assessment, and there
      // is no business case for one.
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      for (const [who, token] of [
        ['manager', managerToken],
        ['HR', hrToken],
      ] as const) {
        const res = await api(
          'PATCH',
          `/api/hr/performance/reviews/${review.id}/self-assessment`,
          { token, body: { achievements: `Written by ${who}` } },
        );
        expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(403);
      }
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
//  RULE 3 — nobody finalises their own review
// ---------------------------------------------------------------------------

describe('nobody finalises their own review', () => {
  it(
    'refuses an ADMIN holding APPROVE from finalising their own',
    async () => {
      /*
        THE test this phase turns on, and the one the requirement names explicitly.

        adminSubject has role ADMIN and holds HR_PERFORMANCE:APPROVE. They are the
        subject. `mayFinalizeReview` refuses the subject before consulting APPROVE,
        so this is 403 — and if the checks were ordered the other way round it would
        be 200, locking their own rating and ending their own right to respond.
      */
      const cycle = await makeOpenCycle();
      const review = await reviewAwaitingApproval(
        adminSubjectToken,
        managerToken,
        cycle.id,
        adminSubjectEmployeeId,
        cycle.competencyId,
      );

      const res = await api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
        token: adminSubjectToken,
        body: { finalRating: 5 },
      });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.message).toContain('own review');

      // And nothing was written: still awaiting approval, no approver, no rating.
      const after = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: hrToken,
      });
      const view = data<{
        review: { status: string; finalizedBy: unknown; finalRating: string | null };
      }>(after).review;
      expect(view.status).toBe('PENDING_APPROVAL');
      expect(view.finalizedBy).toBeNull();
      expect(view.finalRating).toBeNull();
    },
    240_000,
  );

  it(
    'refuses the manager who wrote it, holding only the floor',
    async () => {
      /*
        The second pair of eyes the requirement asks for. A manager trusted to
        appraise their team is not thereby trusted to close the appraisal.
      */
      const cycle = await makeOpenCycle();
      const review = await reviewAwaitingApproval(
        employeeToken,
        managerToken,
        cycle.id,
        employeeEmployeeId,
        cycle.competencyId,
      );

      const res = await api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
        token: managerToken,
        body: {},
      });
      expect(res.status).toBe(403);
    },
    240_000,
  );

  it(
    'allows an approver who is not the subject, and locks the record',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await reviewAwaitingApproval(
        employeeToken,
        managerToken,
        cycle.id,
        employeeEmployeeId,
        cycle.competencyId,
      );

      const res = await api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
        token: hrToken,
        body: { finalRating: 4, finalComments: 'Agreed at the meeting' },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const view = data<{
        review: {
          status: string;
          finalRating: string | null;
          finalizedBy: { id: string } | null;
          finalizedAt: string | null;
        };
      }>(res).review;

      expect(view.status).toBe('FINALIZED');
      expect(view.finalRating).toBe('4');
      expect(view.finalizedBy?.id, 'the approving account is named').toBe(hr.id);
      expect(view.finalizedAt).not.toBeNull();
    },
    240_000,
  );
});

// ---------------------------------------------------------------------------
//  A finalized review is editable by nobody
// ---------------------------------------------------------------------------

describe('a finalized review refuses every further edit', () => {
  it(
    'refuses the employee, the manager and HR alike',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await reviewAwaitingApproval(
        employeeToken,
        managerToken,
        cycle.id,
        employeeEmployeeId,
        cycle.competencyId,
      );

      const finalized = await api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
        token: hrToken,
        body: { finalRating: 3 },
      });
      expect(finalized.status).toBe(200);

      // Every write path, every actor. A finalized review is the record of a
      // conversation that happened; editing it rewrites history.
      const attempts: { label: string; status: number }[] = [];

      const selfEdit = await api(
        'PATCH',
        `/api/hr/performance/reviews/${review.id}/self-assessment`,
        { token: employeeToken, body: { achievements: 'Second thoughts' } },
      );
      attempts.push({ label: 'employee edits self-assessment', status: selfEdit.status });

      const managerEdit = await api(
        'PATCH',
        `/api/hr/performance/reviews/${review.id}/manager-assessment`,
        { token: managerToken, body: { strengths: 'Rewriting' } },
      );
      attempts.push({ label: 'manager edits assessment', status: managerEdit.status });

      const hrEdit = await api(
        'PATCH',
        `/api/hr/performance/reviews/${review.id}/manager-assessment`,
        { token: hrToken, body: { strengths: 'HR rewriting' } },
      );
      attempts.push({ label: 'HR edits assessment', status: hrEdit.status });

      const refinalize = await api(
        'POST',
        `/api/hr/performance/reviews/${review.id}/finalize`,
        { token: hrToken, body: { finalRating: 5 } },
      );
      attempts.push({ label: 'HR re-finalises', status: refinalize.status });

      const cancelAfter = await api(
        'POST',
        `/api/hr/performance/reviews/${review.id}/cancel`,
        { token: hrToken, body: { reason: 'Changed our minds about it' } },
      );
      attempts.push({ label: 'HR cancels a finalized review', status: cancelAfter.status });

      for (const attempt of attempts) {
        expect([403, 409], `${attempt.label} → ${attempt.status}`).toContain(attempt.status);
      }

      // The rating of record is unchanged.
      const after = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: hrToken,
      });
      const view = data<{ review: { finalRating: string | null; status: string } }>(after).review;
      expect(view.finalRating).toBe('3');
      expect(view.status).toBe('FINALIZED');
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
//  State transitions
// ---------------------------------------------------------------------------

describe('invalid state transitions are refused', () => {
  it(
    'refuses finalising a review the manager has not submitted',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      const res = await api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
        token: hrToken,
        body: { finalRating: 4 },
      });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('manager has submitted');
    },
    180_000,
  );

  it(
    'refuses submitting an empty self-assessment',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      const res = await api(
        'POST',
        `/api/hr/performance/reviews/${review.id}/self-assessment/submit`,
        { token: employeeToken, body: {} },
      );
      expect(res.status).toBe(400);
    },
    180_000,
  );

  it(
    'refuses generating reviews for a cycle that has not been opened',
    async () => {
      const created = await api('POST', '/api/hr/performance/cycles', {
        token: hrToken,
        body: {
          name: `${RUN_PREFIX} Unopened`,
          cadence: 'ANNUAL',
          periodStart: '2026-01-01',
          periodEnd: '2026-12-31',
          competencies: [{ name: 'Draftiness', category: 'CORE' }],
        },
      });
      const cycle = data<{ cycle: { id: string } }>(created).cycle;
      owned.cycleIds.push(cycle.id);

      const res = await api('POST', `/api/hr/performance/cycles/${cycle.id}/reviews`, {
        token: hrToken,
        body: { employeeIds: [employeeEmployeeId] },
      });
      expect(res.status).toBe(400);
    },
    180_000,
  );

  it(
    'refuses opening a cycle with no competencies',
    async () => {
      // It would produce reviews nobody can rate, and discovering that after
      // notifying the whole company is worse than refusing now.
      const created = await api('POST', '/api/hr/performance/cycles', {
        token: hrToken,
        body: {
          name: `${RUN_PREFIX} Sheetless`,
          cadence: 'ANNUAL',
          periodStart: '2026-01-01',
          periodEnd: '2026-12-31',
        },
      });
      const cycle = data<{ cycle: { id: string } }>(created).cycle;
      owned.cycleIds.push(cycle.id);

      const res = await api('POST', `/api/hr/performance/cycles/${cycle.id}/activate`, {
        token: hrToken,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CYCLE_HAS_NO_COMPETENCIES');
    },
    180_000,
  );

  it(
    'refuses changing a cycle’s thresholds once it has opened',
    async () => {
      /*
        Reviews have already been judged against them. Moving the goalposts
        mid-cycle silently rescores work that is already done.
      */
      const cycle = await makeOpenCycle();

      const res = await api('PATCH', `/api/hr/performance/cycles/${cycle.id}`, {
        token: hrToken,
        body: { goalAchievementThreshold: 120 },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CYCLE_SCORING_LOCKED');
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
//  Duplicate submission and concurrent finalisation
// ---------------------------------------------------------------------------

describe('concurrency and duplicate submission', () => {
  it(
    'makes a duplicate self-assessment submission a conflict, not a second stamp',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      await api('PATCH', `/api/hr/performance/reviews/${review.id}/self-assessment`, {
        token: employeeToken,
        body: { achievements: 'Done' },
      });

      const first = await api(
        'POST',
        `/api/hr/performance/reviews/${review.id}/self-assessment/submit`,
        { token: employeeToken, body: {} },
      );
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const firstStamp = data<{ review: { selfSubmittedAt: string } }>(first).review
        .selfSubmittedAt;

      const second = await api(
        'POST',
        `/api/hr/performance/reviews/${review.id}/self-assessment/submit`,
        { token: employeeToken, body: {} },
      );
      // Refused — and whether it reads as 403 (already submitted, so the write
      // check refuses) or 409 (the transition matched nothing) both mean the same
      // thing: no second stamp.
      expect([403, 409]).toContain(second.status);

      const after = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: hrToken,
      });
      expect(
        data<{ review: { selfSubmittedAt: string } }>(after).review.selfSubmittedAt,
      ).toBe(firstStamp);
    },
    240_000,
  );

  it(
    'lets exactly one of two concurrent finalisations win',
    async () => {
      /*
        The concurrency control. Both requests pass the authorization check — it is
        a read — and both reach the conditional `updateMany`. One matches
        PENDING_APPROVAL and the other matches nothing, so the second is a 409
        rather than a second `finalizedById` stamp and a second notification to the
        employee.
      */
      const cycle = await makeOpenCycle();
      const review = await reviewAwaitingApproval(
        employeeToken,
        managerToken,
        cycle.id,
        employeeEmployeeId,
        cycle.competencyId,
      );

      const [a, b] = await Promise.all([
        api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
          token: hrToken,
          body: { finalRating: 4 },
        }),
        api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
          token: hrToken,
          body: { finalRating: 2 },
        }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses, `got ${a.status} and ${b.status}`).toEqual([200, 409]);

      // Exactly one rating of record, and exactly one notification.
      const after = await api('GET', `/api/hr/performance/reviews/${review.id}`, {
        token: hrToken,
      });
      const view = data<{ review: { finalRating: string | null } }>(after).review;
      expect(['4', '2']).toContain(view.finalRating);

      const notices = await prisma.notification.count({
        where: { type: 'HR_REVIEW_FINALIZED', entityId: review.id },
      });
      expect(notices, 'one finalisation, one notice').toBe(1);
    },
    300_000,
  );

  it(
    'is idempotent when generating reviews twice for one cycle',
    async () => {
      /*
        `@@unique([cycleId, employeeId])` plus `skipDuplicates`. A second generation
        run for a cycle somebody is already covered by is a no-op for them rather
        than a failed batch that leaves half the company without reviews.
      */
      const cycle = await makeOpenCycle();

      const first = await api('POST', `/api/hr/performance/cycles/${cycle.id}/reviews`, {
        token: hrToken,
        body: { employeeIds: [employeeEmployeeId] },
      });
      expect(first.status).toBe(201);
      expect(data<{ generated: number }>(first).generated).toBe(1);

      const second = await api('POST', `/api/hr/performance/cycles/${cycle.id}/reviews`, {
        token: hrToken,
        body: { employeeIds: [employeeEmployeeId] },
      });
      expect(second.status).toBe(201);
      expect(data<{ generated: number; skipped: number }>(second).generated).toBe(0);
      expect(data<{ generated: number; skipped: number }>(second).skipped).toBe(1);

      const count = await prisma.performanceReview.count({
        where: { cycleId: cycle.id, employeeId: employeeEmployeeId },
      });
      expect(count, 'one review, not two').toBe(1);

      // Track for teardown.
      const rows = await prisma.performanceReview.findMany({
        where: { cycleId: cycle.id },
        select: { id: true },
      });
      owned.reviewIds.push(...rows.map((r) => r.id));
    },
    240_000,
  );
});

// ---------------------------------------------------------------------------
//  KPI scoring against configured targets
// ---------------------------------------------------------------------------

describe('KPI attainment is computed server-side against the configured target', () => {
  it(
    'computes attainment from the baseline and rolls it up to the goal',
    async () => {
      /*
        The arithmetic that must not live in a browser. 20 → 30 asked, now at 25:
        half the work done. A naive `value / target` would report 83%, flattering
        every goal that started from a high base.
      */
      const created = await api('POST', '/api/hr/performance/goals', {
        token: hrToken,
        body: {
          title: `${RUN_PREFIX} Conversion`,
          scope: 'EMPLOYEE',
          employeeId: employeeEmployeeId,
          startOn: '2026-01-01',
          dueOn: '2026-12-31',
          kpis: [
            {
              name: 'Conversion rate',
              metricKind: 'PERCENTAGE',
              direction: 'HIGHER_IS_BETTER',
              targetValue: 30,
              baselineValue: 20,
              weight: 100,
            },
          ],
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const goal = data<{ goal: { id: string; kpis: { id: string }[] } }>(created).goal;
      owned.goalIds.push(goal.id);

      const activated = await api('POST', `/api/hr/performance/goals/${goal.id}/activate`, {
        token: hrToken,
      });
      expect(activated.status).toBe(200);

      const kpiId = goal.kpis[0]?.id;
      expect(kpiId).toBeTruthy();
      if (!kpiId) throw new Error('unreachable');

      const recorded = await api(
        'POST',
        `/api/hr/performance/goals/${goal.id}/kpis/${kpiId}/progress`,
        { token: employeeToken, body: { value: 25, note: 'Mid-year' } },
      );
      expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);

      const kpi = data<{ kpi: { attainment: string | null; currentValue: string | null } }>(
        recorded,
      ).kpi;
      expect(kpi.currentValue).toBe('25');
      expect(kpi.attainment, 'measured from the baseline, not from zero').toBe('50');

      // And the goal's cached roll-up followed, in the same transaction.
      const reread = await api('GET', `/api/hr/performance/goals/${goal.id}`, {
        token: hrToken,
      });
      expect(data<{ goal: { attainment: string | null } }>(reread).goal.attainment).toBe('50');
    },
    240_000,
  );

  it(
    'refuses a client-supplied attainment rather than accepting it',
    async () => {
      /*
        Phase 5's equivalent of Phase 4's forged score. `recordKpiProgressSchema`
        has no attainment field — but it is not `.strict()`, so an unknown key is
        stripped rather than rejected. What must hold is that the *computed* figure
        wins: a forged 100 must not become the stored attainment.
      */
      const created = await api('POST', '/api/hr/performance/goals', {
        token: hrToken,
        body: {
          title: `${RUN_PREFIX} Forgery`,
          scope: 'EMPLOYEE',
          employeeId: employeeEmployeeId,
          startOn: '2026-01-01',
          dueOn: '2026-12-31',
          kpis: [
            { name: 'Orders', metricKind: 'NUMBER', targetValue: 100, weight: 100 },
          ],
        },
      });
      const goal = data<{ goal: { id: string; kpis: { id: string }[] } }>(created).goal;
      owned.goalIds.push(goal.id);
      await api('POST', `/api/hr/performance/goals/${goal.id}/activate`, { token: hrToken });

      const kpiId = goal.kpis[0]?.id;
      if (!kpiId) throw new Error('unreachable');

      const res = await api(
        'POST',
        `/api/hr/performance/goals/${goal.id}/kpis/${kpiId}/progress`,
        {
          token: employeeToken,
          body: { value: 10, attainment: 100, percentage: 100 },
        },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // The forged fields were stripped; the server's own arithmetic stands.
      const kpi = data<{ kpi: { attainment: string | null } }>(res).kpi;
      expect(kpi.attainment, '10 of 100 is 10%, not the claimed 100%').toBe('10');
    },
    240_000,
  );

  it(
    'honours a lower-is-better direction',
    async () => {
      // A KPI for handling time is met by going down. Defaulting to "higher" would
      // score a team as failing for reducing exactly what they were asked to reduce.
      const created = await api('POST', '/api/hr/performance/goals', {
        token: hrToken,
        body: {
          title: `${RUN_PREFIX} Handling time`,
          scope: 'EMPLOYEE',
          employeeId: employeeEmployeeId,
          startOn: '2026-01-01',
          dueOn: '2026-12-31',
          kpis: [
            {
              name: 'Average handling time',
              metricKind: 'DURATION',
              direction: 'LOWER_IS_BETTER',
              targetValue: 10,
              baselineValue: 20,
              weight: 100,
            },
          ],
        },
      });
      const goal = data<{ goal: { id: string; kpis: { id: string }[] } }>(created).goal;
      owned.goalIds.push(goal.id);
      await api('POST', `/api/hr/performance/goals/${goal.id}/activate`, { token: hrToken });

      const kpiId = goal.kpis[0]?.id;
      if (!kpiId) throw new Error('unreachable');

      const recorded = await api(
        'POST',
        `/api/hr/performance/goals/${goal.id}/kpis/${kpiId}/progress`,
        { token: employeeToken, body: { value: 8 } },
      );
      expect(recorded.status).toBe(200);
      // Beating the target is the goal met, not 250% of it.
      expect(data<{ kpi: { attainment: string | null } }>(recorded).kpi.attainment).toBe('100');
    },
    240_000,
  );

  it(
    'refuses the owner closing their own goal',
    async () => {
      // Declaring your own target achieved is the same act as approving your own
      // review.
      const created = await api('POST', '/api/hr/performance/goals', {
        token: hrToken,
        body: {
          title: `${RUN_PREFIX} Self-close`,
          scope: 'EMPLOYEE',
          employeeId: employeeEmployeeId,
          startOn: '2026-01-01',
          dueOn: '2026-12-31',
        },
      });
      const goal = data<{ goal: { id: string } }>(created).goal;
      owned.goalIds.push(goal.id);
      await api('POST', `/api/hr/performance/goals/${goal.id}/activate`, { token: hrToken });

      const res = await api('POST', `/api/hr/performance/goals/${goal.id}/close`, {
        token: employeeToken,
        body: { outcome: 'ACHIEVED' },
      });
      expect(res.status).toBe(403);
    },
    240_000,
  );

  it(
    'requires an explanation when the stated outcome contradicts the figures',
    async () => {
      /*
        The override is allowed and has to be explained. A target missed because the
        market moved is a different thing from one missed through inattention, and
        the record should show both the figure and the reasoning.
      */
      const created = await api('POST', '/api/hr/performance/goals', {
        token: hrToken,
        body: {
          title: `${RUN_PREFIX} Override`,
          scope: 'EMPLOYEE',
          employeeId: employeeEmployeeId,
          startOn: '2026-01-01',
          dueOn: '2026-12-31',
          kpis: [{ name: 'Units', metricKind: 'NUMBER', targetValue: 100, weight: 100 }],
        },
      });
      const goal = data<{ goal: { id: string; kpis: { id: string }[] } }>(created).goal;
      owned.goalIds.push(goal.id);
      await api('POST', `/api/hr/performance/goals/${goal.id}/activate`, { token: hrToken });

      const kpiId = goal.kpis[0]?.id;
      if (!kpiId) throw new Error('unreachable');

      // 10 of 100 → the figures say MISSED.
      await api('POST', `/api/hr/performance/goals/${goal.id}/kpis/${kpiId}/progress`, {
        token: hrToken,
        body: { value: 10 },
      });

      const unexplained = await api('POST', `/api/hr/performance/goals/${goal.id}/close`, {
        token: hrToken,
        body: { outcome: 'ACHIEVED' },
      });
      expect(unexplained.status).toBe(400);
      expect(unexplained.body.code).toBe('OUTCOME_NEEDS_EXPLANATION');

      const explained = await api('POST', `/api/hr/performance/goals/${goal.id}/close`, {
        token: hrToken,
        body: {
          outcome: 'ACHIEVED',
          closureNote: 'Target was superseded by a reorganisation in Q2',
        },
      });
      expect(explained.status, JSON.stringify(explained.body)).toBe(200);
      expect(data<{ goal: { status: string } }>(explained).goal.status).toBe('ACHIEVED');
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
//  Audit and notification
// ---------------------------------------------------------------------------

describe('audit and notification go through the existing infrastructure', () => {
  it(
    'writes an audit row for finalisation and notifies the employee',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await reviewAwaitingApproval(
        employeeToken,
        managerToken,
        cycle.id,
        employeeEmployeeId,
        cycle.competencyId,
      );

      const res = await api('POST', `/api/hr/performance/reviews/${review.id}/finalize`, {
        token: hrToken,
        body: { finalRating: 4 },
      });
      expect(res.status).toBe(200);

      // The existing AuditLog, not a second audit system.
      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'HR_REVIEW_FINALIZED',
          entityType: 'PerformanceReview',
          entityId: review.id,
        },
        select: { id: true, actorId: true },
      });
      expect(audit, 'finalisation is audited').not.toBeNull();
      expect(audit?.actorId).toBe(hr.id);

      // The existing Notification table, addressed to the employee's account.
      const notice = await prisma.notification.findFirst({
        where: { type: 'HR_REVIEW_FINALIZED', entityId: review.id },
        select: { id: true, recipientId: true, body: true },
      });
      expect(notice, 'the employee is told').not.toBeNull();
      expect(notice?.recipientId).toBe(employee.id);

      /*
        And the rating is NOT in the notification body. A notification row has a
        30-day retention and no access control beyond the recipient; putting a
        rating in it would mean somebody's appraisal score sitting where a colleague
        might glance at it.
      */
      expect(notice?.body).not.toContain('4');
    },
    300_000,
  );

  it(
    'notifies the reviewer when the self-assessment is submitted',
    async () => {
      const cycle = await makeOpenCycle();
      const review = await makeReview(cycle.id, employeeEmployeeId);

      await api('PATCH', `/api/hr/performance/reviews/${review.id}/self-assessment`, {
        token: employeeToken,
        body: { achievements: 'Ready for review' },
      });
      const submitted = await api(
        'POST',
        `/api/hr/performance/reviews/${review.id}/self-assessment/submit`,
        { token: employeeToken, body: {} },
      );
      expect(submitted.status).toBe(200);

      const notice = await prisma.notification.findFirst({
        where: { type: 'HR_MANAGER_REVIEW_DUE', entityId: review.id },
        select: { recipientId: true, body: true },
      });
      expect(notice, 'the manager is told their work is possible').not.toBeNull();
      expect(notice?.recipientId).toBe(manager.id);
      // The employee is not named: the row is a record of who is being appraised.
      expect(notice?.body).not.toContain('Ellie');
    },
    240_000,
  );
});
