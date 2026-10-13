/**
 * HR Phase 5 — the appraisal workflow driven through the real rendered UI.
 *
 * ### What this adds over `performance-review.test.ts`
 *
 * That file proves the **API** enforces the rules: 30 HTTP tests against the Express
 * app, including an ADMIN holding APPROVE being refused finalisation of their own
 * review. It says nothing about what a person actually sees.
 *
 * This file renders the Next.js pages with two genuinely separate authenticated
 * sessions and asserts the **HTML**. The gap it closes is the one Phase 5's earlier
 * report got wrong: a 200 and the absence of a "Sign in" string are not evidence a
 * page rendered. Here every assertion names a string that only appears when the
 * component tree actually ran, and the manager-visibility rule is checked by looking
 * for the manager's own words in the employee's HTML.
 *
 * ### Why HTTP rather than a browser driver
 *
 * No Playwright or Puppeteer is installed, and adding one is a dependency decision
 * outside this work. Next.js server-renders these pages, so fetching them with a
 * valid session cookie returns the real component output — which is what the
 * assertions need. What this therefore does *not* cover is client-side interaction:
 * the submit buttons are exercised through their server actions' underlying API
 * rather than by clicking them. That limitation is stated in the final report.
 *
 * ### Sessions
 *
 * Two cookies, minted exactly as `frontend/auth.ts`'s `jwt.encode` does — HS256 over
 * `{name, email, role, employeeId}` with the project's issuer and audience, under the
 * `__Secure-` cookie name `next start` expects. A bare JWT without those claims is
 * rejected and every request 307s, which is precisely how the earlier false reading
 * happened.
 *
 * ### Preconditions
 *
 * Needs the Express API on :4000 and Next.js on :3000, both built from current
 * source. Both are checked in `beforeAll` and the suite fails loudly rather than
 * reporting green against a server that is not there.
 *
 * ### Fixtures
 *
 * Every row is tracked by id and deleted by id, then asserted gone. Nothing is
 * matched by name prefix.
 */

import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@rs/database';
import {
  SESSION_JWT_ALG,
  SESSION_JWT_AUDIENCE,
  SESSION_JWT_ISSUER,
} from '@rs/shared';
import { api, mintToken, startTestServer, stopTestServer } from '../../../__tests__/helpers/test-server.js';
import {
  RUN_PREFIX,
  cleanup,
  makeUser,
  residualTestRows,
  type TestUser,
} from '../../../__tests__/helpers/fixtures.js';
import { env } from '../../../config/env.js';

const WEB = 'http://localhost:3000';
const API = 'http://localhost:4000';

/** `next start` runs in production mode, which uses the __Secure- prefix. */
const COOKIE = '__Secure-royalstuffs.session-token';

let hr: TestUser;
let manager: TestUser;
let employee: TestUser;
let adminSubject: TestUser;

let hrToken: string;
let hrCookie: string;
let managerCookie: string;
let employeeCookie: string;
let adminSubjectCookie: string;

let departmentId: string;
let designationId: string;
let managerEmployeeId: string;
let employeeEmployeeId: string;
let adminSubjectEmployeeId: string;

const owned = {
  reviewIds: [] as string[],
  cycleIds: [] as string[],
  employeeIds: [] as string[],
  departmentIds: [] as string[],
  designationIds: [] as string[],
};

let seq = 0;
const code = (stem: string): string => {
  seq += 1;
  return `ZZUI${stem}${seq}`.toUpperCase().slice(0, 20);
};
const email = (stem: string): string => {
  seq += 1;
  return `${RUN_PREFIX}-ui${stem}${seq}@test.invalid`;
};

function data<T>(res: { body: { data?: unknown } }): T {
  return res.body.data as T;
}

/**
 * A session cookie the application genuinely accepts.
 *
 * Mirrors `frontend/auth.ts`'s `jwt.encode`: the same claims, the same algorithm,
 * the same issuer and audience, signed with AUTH_SECRET. Missing `name`, `email` or
 * `employeeId` produces a token `decode` rejects, and every page then 307s — which
 * looked like a passing check once and must not again.
 */
async function sessionCookie(user: {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  role: 'ADMIN' | 'USER';
}): Promise<string> {
  const token = await new SignJWT({
    name: user.name,
    email: user.email,
    role: user.role,
    employeeId: user.employeeId,
  })
    .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('28800s')
    .sign(new TextEncoder().encode(env.AUTH_SECRET));

  return `${COOKIE}=${token}`;
}

/** Fetches a rendered page and returns its status and HTML. */
async function page(
  path: string,
  cookie: string,
): Promise<{ status: number; html: string }> {
  const response = await fetch(`${WEB}${path}`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(45_000),
  });
  const html = await response.text();
  return { status: response.status, html };
}

/** A direct API call under a session cookie rather than a bearer token. */
async function apiAs(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = cookie.slice(COOKIE.length + 1);
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

// ---------------------------------------------------------------------------
//  Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await startTestServer();

  /*
    Both servers must be up and current. Failing here is the point: a suite that
    silently skipped would report green while proving nothing, which is the failure
    mode this whole file exists to avoid.
  */
  const health = await fetch(`${API}/api/health`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  expect(
    health?.ok,
    `The Express API must be running on :4000 with a current backend/dist. Build it and start it before running this suite.`,
  ).toBe(true);

  const web = await fetch(`${WEB}/login`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  expect(
    web?.ok,
    `Next.js must be running on :3000 from a current build. Run "npm run build --workspace=@rs/frontend" then "npx dotenv -e .env -- npx next start" in frontend/.`,
  ).toBe(true);

  hr = await makeUser('ADMIN');
  manager = await makeUser('USER');
  employee = await makeUser('USER');
  adminSubject = await makeUser('ADMIN');

  hrToken = await mintToken(hr.id, { role: 'ADMIN' });

  const grant = async (userId: string, module: string, actions: string[]) => {
    for (const action of actions) {
      await prisma.userModulePermission.upsert({
        where: {
          userId_module_action: { userId, module: module as never, action: action as never },
        },
        create: { userId, module: module as never, action: action as never, allowed: true },
        update: { allowed: true },
      });
    }
  };

  await grant(hr.id, 'HR_PERFORMANCE', ['VIEW', 'CREATE', 'EDIT', 'ASSIGN', 'APPROVE']);
  await grant(hr.id, 'HR_EMPLOYEE', ['VIEW', 'CREATE', 'EDIT']);
  await grant(hr.id, 'HR_ADMIN', ['VIEW', 'CREATE', 'EDIT']);

  // The manager and the employee hold the employee floor only. Their authority over
  // a review comes from rows, not permissions.
  await grant(manager.id, 'HR_EMPLOYEE', ['VIEW']);
  await grant(employee.id, 'HR_EMPLOYEE', ['VIEW']);

  // The actor that matters most: an ADMIN holding APPROVE who is also appraised.
  await grant(adminSubject.id, 'HR_PERFORMANCE', ['VIEW', 'EDIT', 'APPROVE']);
  await grant(adminSubject.id, 'HR_EMPLOYEE', ['VIEW']);

  const dept = await api('POST', '/api/hr/departments', {
    token: hrToken,
    body: { name: `${RUN_PREFIX} UI Dept`, code: code('DEPT') },
  });
  expect(dept.status, JSON.stringify(dept.body)).toBe(201);
  departmentId = data<{ department: { id: string } }>(dept).department.id;
  owned.departmentIds.push(departmentId);

  const desig = await api('POST', '/api/hr/designations', {
    token: hrToken,
    body: { name: `${RUN_PREFIX} UI Role`, code: code('DESIG'), level: 3 },
  });
  expect(desig.status, JSON.stringify(desig.body)).toBe(201);
  designationId = data<{ designation: { id: string } }>(desig).designation.id;
  owned.designationIds.push(designationId);

  const makeEmployee = async (
    overrides: Record<string, unknown>,
  ): Promise<{ id: string; employeeId: string }> => {
    const res = await api('POST', '/api/hr/employees', {
      token: hrToken,
      body: {
        workEmail: email('emp'),
        joiningDate: '2026-01-15',
        departmentId,
        designationId,
        ...overrides,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = data<{ employee: { id: string; employeeId: string } }>(res).employee;
    owned.employeeIds.push(row.id);
    return row;
  };

  const link = async (employeeRowId: string, userId: string) => {
    const res = await api('POST', `/api/hr/employees/${employeeRowId}/user`, {
      token: hrToken,
      body: { userId },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  const managerRow = await makeEmployee({ firstName: 'Uma', lastName: 'Manager' });
  managerEmployeeId = managerRow.id;
  await link(managerRow.id, manager.id);

  const employeeRow = await makeEmployee({
    firstName: 'Ulric',
    lastName: 'Employee',
    managerId: managerEmployeeId,
  });
  employeeEmployeeId = employeeRow.id;
  await link(employeeRow.id, employee.id);

  const adminRow = await makeEmployee({
    firstName: 'Ada',
    lastName: 'Adminsubject',
    managerId: managerEmployeeId,
  });
  adminSubjectEmployeeId = adminRow.id;
  await link(adminRow.id, adminSubject.id);

  // Cookies minted after the employee links exist, so each carries the right code.
  const hrRow = await prisma.user.findUniqueOrThrow({
    where: { id: hr.id },
    select: { id: true, name: true, email: true, employeeId: true },
  });
  hrCookie = await sessionCookie({ ...hrRow, role: 'ADMIN' });

  const managerUser = await prisma.user.findUniqueOrThrow({
    where: { id: manager.id },
    select: { id: true, name: true, email: true, employeeId: true },
  });
  managerCookie = await sessionCookie({ ...managerUser, role: 'USER' });

  const employeeUser = await prisma.user.findUniqueOrThrow({
    where: { id: employee.id },
    select: { id: true, name: true, email: true, employeeId: true },
  });
  employeeCookie = await sessionCookie({ ...employeeUser, role: 'USER' });

  const adminUser = await prisma.user.findUniqueOrThrow({
    where: { id: adminSubject.id },
    select: { id: true, name: true, email: true, employeeId: true },
  });
  adminSubjectCookie = await sessionCookie({ ...adminUser, role: 'ADMIN' });
}, 300_000);

afterAll(async () => {
  await prisma.performanceReview.deleteMany({ where: { id: { in: owned.reviewIds } } });
  await prisma.reviewCycle.deleteMany({ where: { id: { in: owned.cycleIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: owned.employeeIds } } });
  await prisma.designation.deleteMany({ where: { id: { in: owned.designationIds } } });
  await prisma.department.deleteMany({ where: { id: { in: owned.departmentIds } } });

  const residue = await Promise.all([
    prisma.performanceReview.count({ where: { id: { in: owned.reviewIds } } }),
    prisma.reviewCycle.count({ where: { id: { in: owned.cycleIds } } }),
    prisma.employee.count({ where: { id: { in: owned.employeeIds } } }),
  ]);
  expect(residue, 'this run left no rows behind').toEqual([0, 0, 0]);

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
}, 300_000);

// ---------------------------------------------------------------------------
//  The session encoding itself
// ---------------------------------------------------------------------------

describe('the sessions are genuinely accepted by the application', () => {
  it(
    'renders a page for a valid session and redirects an invalid one',
    async () => {
      /*
        The control for every other assertion in this file. If a bad cookie also
        produced 200, nothing below would mean anything — which is exactly the trap
        the earlier Phase 5 report fell into.
      */
      const good = await page('/hr/performance', hrCookie);
      expect(good.status, 'a valid session renders').toBe(200);

      const anonymous = await page('/hr/performance', '');
      expect(anonymous.status, 'no session redirects').toBe(307);

      // A token missing the claims `decode` requires is treated as no session.
      const bare = await new SignJWT({ role: 'ADMIN' })
        .setProtectedHeader({ alg: SESSION_JWT_ALG, typ: 'JWT' })
        .setSubject(hr.id)
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience(SESSION_JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('600s')
        .sign(new TextEncoder().encode(env.AUTH_SECRET));
      const wrongName = await page('/hr/performance', `royalstuffs.session-token=${bare}`);
      expect(wrongName.status, 'the development cookie name is not read here').toBe(307);
    },
    180_000,
  );

  it(
    'renders real component output, not a login shell',
    async () => {
      /*
        Asserting strings that exist only in the Phase 5 components. A shell, a
        redirect body or an error page contains none of them.
      */
      const { status, html } = await page('/hr/performance', hrCookie);
      expect(status).toBe(200);
      expect(html).toContain('What you owe');
      expect(html).toContain('Across the business');
      expect(html).toContain('Where to go');
      expect(html).not.toContain('Sign in');
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
//  The workflow, two sessions
// ---------------------------------------------------------------------------

describe('the review workflow through the rendered UI', () => {
  let cycleId: string;
  let competencyId: string;
  let reviewId: string;

  it(
    'HR creates and opens a cycle, then generates the review',
    async () => {
      const created = await apiAs('POST', '/api/hr/performance/cycles', hrCookie, {
        name: `${RUN_PREFIX} UI Cycle`,
        cadence: 'ANNUAL',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        competencies: [{ name: 'Collaboration', category: 'CORE', weight: 100 }],
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);

      const cycle = (created.json.data as {
        cycle: { id: string; competencies: { id: string }[] };
      }).cycle;
      cycleId = cycle.id;
      owned.cycleIds.push(cycleId);
      const first = cycle.competencies[0];
      expect(first).toBeTruthy();
      if (!first) throw new Error('unreachable');
      competencyId = first.id;

      const opened = await apiAs(
        'POST',
        `/api/hr/performance/cycles/${cycleId}/activate`,
        hrCookie,
      );
      expect(opened.status, JSON.stringify(opened.json)).toBe(200);

      const generated = await apiAs(
        'POST',
        `/api/hr/performance/cycles/${cycleId}/reviews`,
        hrCookie,
        { employeeIds: [employeeEmployeeId] },
      );
      expect(generated.status, JSON.stringify(generated.json)).toBe(201);

      const row = await prisma.performanceReview.findFirstOrThrow({
        where: { cycleId, employeeId: employeeEmployeeId },
        select: { id: true, status: true, reviewerId: true },
      });
      reviewId = row.id;
      owned.reviewIds.push(reviewId);

      // Database assertion: born NOT_STARTED, reviewer captured at generation.
      expect(row.status).toBe('NOT_STARTED');
      expect(row.reviewerId, 'the reviewer is stamped from the hierarchy').toBe(
        managerEmployeeId,
      );
    },
    240_000,
  );

  it(
    'the employee opens their own review and sees their self-assessment form',
    async () => {
      const { status, html } = await page(
        `/hr/performance/reviews/${reviewId}`,
        employeeCookie,
      );
      expect(status).toBe(200);

      // Rendered-content assertions: strings only the Phase 5 review page emits.
      expect(html, 'the page is titled for the subject').toContain('Your review');
      expect(html).toContain('Your self-assessment');
      expect(html).toContain('What you achieved');
      expect(html).toContain('Collaboration');
      // And the next-step banner, which only the subject sees.
      expect(html).toContain('Write your self-assessment to begin');
    },
    180_000,
  );

  it(
    'the employee submits their self-assessment and the state advances',
    async () => {
      const saved = await apiAs(
        'PATCH',
        `/api/hr/performance/reviews/${reviewId}/self-assessment`,
        employeeCookie,
        {
          achievements: 'ZZ-EMPLOYEE-ACHIEVEMENTS-MARKER',
          competencyRatings: [{ competencyId, rating: 4 }],
        },
      );
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);

      /*
        `{}` rather than no body at all. `submitReviewSchema` is `.strict()` over an
        object, so an absent body fails validation with 422 — which is correct
        behaviour and was my test's mistake, not the API's.
      */
      const submitted = await apiAs(
        'POST',
        `/api/hr/performance/reviews/${reviewId}/self-assessment/submit`,
        employeeCookie,
        {},
      );
      expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);

      // Database assertion.
      const row = await prisma.performanceReview.findUniqueOrThrow({
        where: { id: reviewId },
        select: { status: true, selfSubmittedAt: true, selfOverallRating: true },
      });
      expect(row.status).toBe('PENDING_MANAGER');
      expect(row.selfSubmittedAt).not.toBeNull();
      // Derived from the competency sheet, since no overall figure was given.
      expect(row.selfOverallRating?.toString()).toBe('4');

      // Rendered assertion: their own words come back on their own page.
      const { html } = await page(`/hr/performance/reviews/${reviewId}`, employeeCookie);
      expect(html).toContain('ZZ-EMPLOYEE-ACHIEVEMENTS-MARKER');
      expect(html).toContain('Submitted');
    },
    240_000,
  );

  it(
    'the employee cannot see the manager’s draft — neither narrative nor ratings',
    async () => {
      /*
        RULE 1, asserted on rendered HTML rather than on an API response.

        The manager writes a distinctive marker and does NOT submit. The employee's
        page must not contain it anywhere — not in the narrative, not in a rating
        comment, not in a hydration payload. Searching the whole document is the
        point: a component that withheld it visually while shipping it in the RSC
        payload would still be a leak.
      */
      const draft = await apiAs(
        'PATCH',
        `/api/hr/performance/reviews/${reviewId}/manager-assessment`,
        managerCookie,
        {
          strengths: 'ZZ-MANAGER-DRAFT-MARKER',
          improvementAreas: 'ZZ-MANAGER-IMPROVEMENT-MARKER',
          competencyRatings: [{ competencyId, rating: 2, comments: 'ZZ-MANAGER-RATING-NOTE' }],
        },
      );
      expect(draft.status, JSON.stringify(draft.json)).toBe(200);

      // Database assertion: the draft exists and is unsubmitted.
      const assessment = await prisma.managerAssessment.findUniqueOrThrow({
        where: { reviewId },
        select: { strengths: true, submittedAt: true },
      });
      expect(assessment.strengths).toBe('ZZ-MANAGER-DRAFT-MARKER');
      expect(assessment.submittedAt, 'still a draft').toBeNull();

      const rating = await prisma.competencyRating.findFirstOrThrow({
        where: { reviewId, source: 'MANAGER' },
        select: { rating: true, comments: true },
      });
      expect(rating.rating).toBe(2);

      // THE assertion. Nothing of the manager's draft in the employee's HTML.
      const asEmployee = await page(
        `/hr/performance/reviews/${reviewId}`,
        employeeCookie,
      );
      expect(asEmployee.status).toBe(200);
      expect(asEmployee.html).not.toContain('ZZ-MANAGER-DRAFT-MARKER');
      expect(asEmployee.html).not.toContain('ZZ-MANAGER-IMPROVEMENT-MARKER');
      expect(asEmployee.html).not.toContain('ZZ-MANAGER-RATING-NOTE');

      // And the waiting state is shown instead of an empty panel.
      expect(asEmployee.html).toContain('has not shared their review yet');

      // The manager's own page does show their draft — otherwise the absence above
      // would prove only that the page failed to render anything.
      const asManager = await page(
        `/hr/performance/reviews/${reviewId}`,
        managerCookie,
      );
      expect(asManager.status).toBe(200);
      expect(asManager.html).toContain('ZZ-MANAGER-DRAFT-MARKER');
      expect(asManager.html).toContain('Draft');
    },
    300_000,
  );

  it(
    'the manager submits and only then can the employee read it',
    async () => {
      const submitted = await apiAs(
        'POST',
        `/api/hr/performance/reviews/${reviewId}/manager-assessment/submit`,
        managerCookie,
        {},
      );
      expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);

      // Database assertion.
      const row = await prisma.performanceReview.findUniqueOrThrow({
        where: { id: reviewId },
        select: { status: true, managerSubmittedAt: true, managerOverallRating: true },
      });
      expect(row.status).toBe('PENDING_APPROVAL');
      expect(row.managerSubmittedAt).not.toBeNull();
      expect(row.managerOverallRating?.toString()).toBe('2');

      // Rendered assertion: now the employee sees it, including the rating comment.
      const { status, html } = await page(
        `/hr/performance/reviews/${reviewId}`,
        employeeCookie,
      );
      expect(status).toBe(200);
      expect(html).toContain('ZZ-MANAGER-DRAFT-MARKER');
      expect(html).toContain('ZZ-MANAGER-IMPROVEMENT-MARKER');
      expect(html).toContain('ZZ-MANAGER-RATING-NOTE');

      // And the comparison names the disagreement: employee 4, manager 2.
      expect(html).toContain('Ratings side by side');
      expect(html).toContain('You rated this 2 levels higher');
    },
    300_000,
  );

  it(
    'the employee sees no finalise control and is told why',
    async () => {
      const { html } = await page(`/hr/performance/reviews/${reviewId}`, employeeCookie);
      expect(html).not.toContain('Finalise review');
      expect(html).toContain('Nobody approves their own review');
    },
    180_000,
  );

  it(
    'the manager who wrote it sees no finalise control either',
    async () => {
      // The second pair of eyes. A manager holds the floor, not APPROVE.
      const { html } = await page(`/hr/performance/reviews/${reviewId}`, managerCookie);
      expect(html).not.toContain('Finalise review');
    },
    180_000,
  );

  it(
    'HR sees the finalise control and finalising locks the record',
    async () => {
      const before = await page(`/hr/performance/reviews/${reviewId}`, hrCookie);
      expect(before.status).toBe(200);
      expect(before.html, 'the approver is offered the control').toContain(
        'Finalise review',
      );

      const finalized = await apiAs(
        'POST',
        `/api/hr/performance/reviews/${reviewId}/finalize`,
        hrCookie,
        { finalRating: 3, finalComments: 'ZZ-FINAL-COMMENT-MARKER' },
      );
      expect(finalized.status, JSON.stringify(finalized.json)).toBe(200);

      // Database assertions: locked, with a named approver.
      const row = await prisma.performanceReview.findUniqueOrThrow({
        where: { id: reviewId },
        select: {
          status: true,
          finalRating: true,
          finalizedById: true,
          finalizedAt: true,
          finalComments: true,
        },
      });
      expect(row.status).toBe('FINALIZED');
      expect(row.finalRating?.toString()).toBe('3');
      expect(row.finalizedById).toBe(hr.id);
      expect(row.finalizedAt).not.toBeNull();
      expect(row.finalComments).toBe('ZZ-FINAL-COMMENT-MARKER');

      // Rendered assertion: the employee sees it locked, with the outcome.
      const after = await page(`/hr/performance/reviews/${reviewId}`, employeeCookie);
      expect(after.html).toContain('Finalised and locked');
      expect(after.html).toContain('nobody can change this');
      expect(after.html).toContain('ZZ-FINAL-COMMENT-MARKER');
      expect(after.html).toContain('This review is complete and can no longer be changed');
    },
    300_000,
  );

  it(
    'a finalised review is inert in the UI and refused by the API',
    async () => {
      // No write control anywhere, for anybody.
      for (const [who, cookie] of [
        ['employee', employeeCookie],
        ['manager', managerCookie],
        ['HR', hrCookie],
      ] as const) {
        const { html } = await page(`/hr/performance/reviews/${reviewId}`, cookie);
        expect(html, `${who} sees no submit`).not.toContain('Submit for approval');
        expect(html, `${who} sees no finalise`).not.toContain('Finalise review');
        expect(html, `${who} sees no withdraw`).not.toContain('Withdraw this review');
      }

      // And every direct API write is refused — the UI hiding them is the courtesy,
      // this is the control.
      const attempts = [
        ['employee edits self', 'PATCH', `/api/hr/performance/reviews/${reviewId}/self-assessment`, employeeCookie, { achievements: 'ZZ-TAMPER' }],
        ['manager edits', 'PATCH', `/api/hr/performance/reviews/${reviewId}/manager-assessment`, managerCookie, { strengths: 'ZZ-TAMPER' }],
        ['HR edits', 'PATCH', `/api/hr/performance/reviews/${reviewId}/manager-assessment`, hrCookie, { strengths: 'ZZ-TAMPER' }],
        ['HR re-finalises', 'POST', `/api/hr/performance/reviews/${reviewId}/finalize`, hrCookie, { finalRating: 5 }],
        ['HR cancels', 'POST', `/api/hr/performance/reviews/${reviewId}/cancel`, hrCookie, { reason: 'changed our minds' }],
      ] as const;

      for (const [label, method, path, cookie, body] of attempts) {
        const res = await apiAs(method, path, cookie, body);
        expect([403, 409], `${label} → ${res.status}`).toContain(res.status);
      }

      // Database assertion: nothing moved.
      const row = await prisma.performanceReview.findUniqueOrThrow({
        where: { id: reviewId },
        select: { status: true, finalRating: true, finalComments: true },
      });
      expect(row.status).toBe('FINALIZED');
      expect(row.finalRating?.toString()).toBe('3');
      expect(row.finalComments).toBe('ZZ-FINAL-COMMENT-MARKER');

      const selfAssessment = await prisma.selfAssessment.findUniqueOrThrow({
        where: { reviewId },
        select: { achievements: true },
      });
      expect(selfAssessment.achievements, 'untampered').toBe(
        'ZZ-EMPLOYEE-ACHIEVEMENTS-MARKER',
      );
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
//  The ADMIN-subject case, through the UI
// ---------------------------------------------------------------------------

describe('an ADMIN holding APPROVE cannot finalise their own review', () => {
  it(
    'sees no control on their own review and is refused by the API',
    async () => {
      /*
        The requirement's explicit case, now asserted on rendered HTML as well as
        over HTTP. `adminSubject` has role ADMIN and holds HR_PERFORMANCE:APPROVE,
        and is the subject of this review.
      */
      const cycle = await apiAs('POST', '/api/hr/performance/cycles', hrCookie, {
        name: `${RUN_PREFIX} UI Admin Cycle`,
        cadence: 'ANNUAL',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        competencies: [{ name: 'Judgement', category: 'CORE', weight: 100 }],
      });
      expect(cycle.status).toBe(201);
      const cycleRow = (cycle.json.data as {
        cycle: { id: string; competencies: { id: string }[] };
      }).cycle;
      owned.cycleIds.push(cycleRow.id);
      const comp = cycleRow.competencies[0];
      if (!comp) throw new Error('unreachable');

      await apiAs('POST', `/api/hr/performance/cycles/${cycleRow.id}/activate`, hrCookie);
      await apiAs('POST', `/api/hr/performance/cycles/${cycleRow.id}/reviews`, hrCookie, {
        employeeIds: [adminSubjectEmployeeId],
      });

      const row = await prisma.performanceReview.findFirstOrThrow({
        where: { cycleId: cycleRow.id, employeeId: adminSubjectEmployeeId },
        select: { id: true },
      });
      owned.reviewIds.push(row.id);

      // Carry it to PENDING_APPROVAL: the subject writes theirs, the manager writes
      // and submits.
      await apiAs(
        'PATCH',
        `/api/hr/performance/reviews/${row.id}/self-assessment`,
        adminSubjectCookie,
        { achievements: 'Mine', competencyRatings: [{ competencyId: comp.id, rating: 5 }] },
      );
      await apiAs(
        'POST',
        `/api/hr/performance/reviews/${row.id}/self-assessment/submit`,
        adminSubjectCookie,
        {},
      );
      await apiAs(
        'PATCH',
        `/api/hr/performance/reviews/${row.id}/manager-assessment`,
        managerCookie,
        { strengths: 'Solid', competencyRatings: [{ competencyId: comp.id, rating: 4 }] },
      );
      await apiAs(
        'POST',
        `/api/hr/performance/reviews/${row.id}/manager-assessment/submit`,
        managerCookie,
        {},
      );

      const awaiting = await prisma.performanceReview.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true },
      });
      expect(awaiting.status).toBe('PENDING_APPROVAL');

      // RENDERED: no finalise control on their own review, and the reason is shown.
      const own = await page(`/hr/performance/reviews/${row.id}`, adminSubjectCookie);
      expect(own.status).toBe(200);
      expect(own.html, 'their own review renders').toContain('Your review');
      expect(own.html, 'no finalise control for the subject').not.toContain(
        'Finalise review',
      );
      expect(own.html).toContain('Nobody approves their own review');

      // HTTP: refused even though they hold APPROVE.
      const attempt = await apiAs(
        'POST',
        `/api/hr/performance/reviews/${row.id}/finalize`,
        adminSubjectCookie,
        { finalRating: 5 },
      );
      expect(attempt.status, JSON.stringify(attempt.json)).toBe(403);
      expect(String(attempt.json.message)).toContain('own review');

      // DATABASE: nothing written.
      const unchanged = await prisma.performanceReview.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true, finalizedById: true, finalRating: true },
      });
      expect(unchanged.status).toBe('PENDING_APPROVAL');
      expect(unchanged.finalizedById).toBeNull();
      expect(unchanged.finalRating).toBeNull();

      // And somebody else can finalise it, so the refusal is about the subject
      // rather than about the review being unfinalisable.
      const byHr = await apiAs(
        'POST',
        `/api/hr/performance/reviews/${row.id}/finalize`,
        hrCookie,
        { finalRating: 4 },
      );
      expect(byHr.status, JSON.stringify(byHr.json)).toBe(200);
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
//  Cross-session scope, rendered
// ---------------------------------------------------------------------------

describe('scope boundaries hold in the rendered UI', () => {
  it(
    'the employee’s My Review page shows only their own review',
    async () => {
      const { status, html } = await page('/hr/performance/my-review', employeeCookie);
      expect(status).toBe(200);
      expect(html).toContain('My review');
      expect(html).toContain('Your goals');
      // The manager's and the ADMIN subject's names must not appear.
      expect(html).not.toContain('Ada Adminsubject');
    },
    180_000,
  );

  it(
    'the employee cannot render a colleague’s review',
    async () => {
      const other = await prisma.performanceReview.findFirstOrThrow({
        where: { employeeId: adminSubjectEmployeeId },
        select: { id: true },
      });

      const { status, html } = await page(
        `/hr/performance/reviews/${other.id}`,
        employeeCookie,
      );
      /*
        The page renders its error state rather than 403ing, because `fetchPerformanceReview`
        returns the API's 404 and the page shows it. What matters is that none of the
        colleague's content appears.
      */
      expect(status).toBe(200);
      expect(html).not.toContain('Ada Adminsubject');
      expect(html).toContain('Back to reviews');
    },
    180_000,
  );

  it(
    'an employee with no performance grant sees no company figures',
    async () => {
      const { status, html } = await page('/hr/performance', employeeCookie);
      expect(status).toBe(200);
      // Their own section renders…
      expect(html).toContain('What you owe');
      // …and the administrative block does not.
      expect(html).not.toContain('Across the business');
    },
    180_000,
  );
});
