/**
 * HR Phase 4 — the onboarding ↔ training link, over real HTTP against the real database.
 *
 * ### Why this file exists separately from the calc tests
 *
 * `training-calc.test.ts` covers the pure arithmetic: grading, thresholds, gate
 * satisfaction, gap derivation. All of it passes with the module completely
 * unreachable, which is exactly what happened earlier in this phase — forty-five
 * green unit tests while `hrActor` resolved no `HR_TRAINING` capability at all, so
 * every service check returned false even for an administrator holding the grant by
 * role default. Only an HTTP request could surface that.
 *
 * So this file is deliberately **integration**, not unit. Every assertion goes
 * through the router, the permission middleware, the access policy, the service and
 * Prisma, against Neon.
 *
 * ### What it pins
 *
 *   1. The first link creates an enrollment for the onboarding's own employee and
 *      attaches it to the task.
 *   2. Repeating the same operation is idempotent — no second enrollment, no error.
 *   3. An enrollment belonging to somebody else cannot be attached.
 *   4. Linking before the employment record exists is refused, because there is
 *      nobody to enrol.
 *   5. Training progress drives the task's status.
 *
 * ### Fixture ownership
 *
 * Every row this file creates is tracked by id and deleted by id in `afterAll`,
 * then asserted gone. Nothing is matched by name prefix: the Phase 3 teardown bug
 * came from exactly that — a `startsWith('ZZT')` predicate that matched the
 * department code rather than the requisition reference, leaving 142 orphans behind
 * across runs. Ids cannot drift.
 *
 * `TrainingEnrollment.programId` is `onDelete: Restrict`, so enrollments are deleted
 * before their program. The order below is not incidental.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@rs/database';
import {
  api,
  mintToken,
  startTestServer,
  stopTestServer,
} from '../../../__tests__/helpers/test-server.js';
import { RUN_PREFIX, cleanup, makeUser, residualTestRows, type TestUser } from '../../../__tests__/helpers/fixtures.js';

type Body = Record<string, unknown>;

/** Full HR rights, as an HR lead running an onboarding would hold. */
let admin: TestUser;
let adminToken: string;

let departmentId: string;
let designationId: string;

/** Everything this run created, deleted by id in afterAll. */
const owned = {
  programIds: [] as string[],
  enrollmentIds: [] as string[],
  employeeIds: [] as string[],
  onboardingIds: [] as string[],
  applicationIds: [] as string[],
  candidateIds: [] as string[],
  jobIds: [] as string[],
  offerIds: [] as string[],
  departmentIds: [] as string[],
  designationIds: [] as string[],
};

let codeSeq = 0;
const testCode = (stem: string): string => {
  codeSeq += 1;
  return `ZZT4${stem}${codeSeq}`.toUpperCase().slice(0, 20);
};

let emailSeq = 0;
const testEmail = (stem = 'cand'): string => {
  emailSeq += 1;
  return `${RUN_PREFIX}-p4${stem}${emailSeq}@test.invalid`;
};

function data<T>(res: { body: { data?: unknown } }): T {
  return res.body.data as T;
}

async function grant(userId: string, module: string, actions: string[]): Promise<void> {
  for (const action of actions) {
    await prisma.userModulePermission.upsert({
      where: {
        userId_module_action: {
          userId,
          module: module as never,
          action: action as never,
        },
      },
      create: { userId, module: module as never, action: action as never, allowed: true },
      update: { allowed: true },
    });
  }
}

// ---------------------------------------------------------------------------
//  Fixtures
// ---------------------------------------------------------------------------

/**
 * A published program with one lesson, through the real endpoints.
 *
 * Created without `seedRequiredJourney` on purpose: thirteen steps would make every
 * progress assertion below depend on the template, and the point of the template
 * being a seed is that nothing downstream reads it. One lesson is the smallest
 * program that can be completed, which is what these tests need.
 */
async function makeProgram(): Promise<{ id: string; moduleId: string }> {
  const created = await api('POST', '/api/hr/training/programs', {
    token: adminToken,
    body: {
      title: `${RUN_PREFIX} Onboarding Induction`,
      requiresPractical: false,
      requiresShadowing: false,
      requiresFinalAssessment: false,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const program = data<{ program: { id: string } }>(created).program;
  owned.programIds.push(program.id);

  const moduleRes = await api('POST', `/api/hr/training/programs/${program.id}/modules`, {
    token: adminToken,
    body: { title: 'Company introduction', kind: 'LESSON', isRequired: true },
  });
  expect(moduleRes.status, JSON.stringify(moduleRes.body)).toBe(201);
  const moduleId = data<{ module: { id: string } }>(moduleRes).module.id;

  const published = await api('POST', `/api/hr/training/programs/${program.id}/publish`, {
    token: adminToken,
  });
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  return { id: program.id, moduleId };
}

/** A standalone employee, for the cross-employee refusal. */
async function makeEmployee(): Promise<{ id: string }> {
  const res = await api('POST', '/api/hr/employees', {
    token: adminToken,
    body: {
      firstName: 'Other',
      lastName: 'Learner',
      workEmail: testEmail('emp'),
      joiningDate: '2026-01-15',
      departmentId,
      designationId,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const employee = data<{ employee: { id: string } }>(res).employee;
  owned.employeeIds.push(employee.id);
  return employee;
}

/**
 * An onboarding record, from a requisition through an accepted offer.
 *
 * The long way round because there is no shortcut: the service refuses onboarding
 * before an offer is accepted, and that refusal is Phase 3 behaviour worth leaving
 * intact rather than bypassing with a direct insert.
 */
async function makeOnboarding(): Promise<{ id: string }> {
  const job = await api('POST', '/api/hr/recruitment/jobs', {
    token: adminToken,
    body: { title: `${RUN_PREFIX} P4 Role`, departmentId, designationId },
  });
  expect(job.status, JSON.stringify(job.body)).toBe(201);
  const jobId = data<{ job: { id: string } }>(job).job.id;
  owned.jobIds.push(jobId);

  const publishedJob = await api('POST', `/api/hr/recruitment/jobs/${jobId}/publish`, {
    token: adminToken,
  });
  expect(publishedJob.status, JSON.stringify(publishedJob.body)).toBe(200);

  const candidate = await api('POST', '/api/hr/recruitment/candidates', {
    token: adminToken,
    body: { firstName: 'Nu', lastName: 'Joiner', email: testEmail('cand') },
  });
  expect(candidate.status, JSON.stringify(candidate.body)).toBe(201);
  const candidateId = data<{ candidate: { id: string } }>(candidate).candidate.id;
  owned.candidateIds.push(candidateId);

  const application = await api('POST', '/api/hr/recruitment/applications', {
    token: adminToken,
    body: { jobRequisitionId: jobId, candidateId },
  });
  expect(application.status, JSON.stringify(application.body)).toBe(201);
  const applicationId = data<{ application: { id: string } }>(application).application.id;
  owned.applicationIds.push(applicationId);

  for (const toStage of ['SCREENING', 'SHORTLISTED', 'FINAL_INTERVIEW', 'SELECTED']) {
    const moved = await api(
      'POST',
      `/api/hr/recruitment/applications/${applicationId}/stage`,
      { token: adminToken, body: { toStage } },
    );
    expect(moved.status, `${toStage}: ${JSON.stringify(moved.body)}`).toBe(200);
  }

  const offer = await api('POST', '/api/hr/recruitment/offers', {
    token: adminToken,
    body: {
      applicationId,
      position: 'P4 Role',
      departmentId,
      designationId,
      proposedJoiningDate: '2026-06-01',
    },
  });
  expect(offer.status, JSON.stringify(offer.body)).toBe(201);
  const offerId = data<{ offer: { id: string } }>(offer).offer.id;
  owned.offerIds.push(offerId);

  const toOffer = await api('POST', `/api/hr/recruitment/applications/${applicationId}/stage`, {
    token: adminToken,
    body: { toStage: 'OFFER' },
  });
  expect(toOffer.status, JSON.stringify(toOffer.body)).toBe(200);

  const sent = await api('POST', `/api/hr/recruitment/offers/${offerId}/send`, {
    token: adminToken,
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);

  const accepted = await api('POST', `/api/hr/recruitment/offers/${offerId}/respond`, {
    token: adminToken,
    body: { status: 'ACCEPTED' },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

  const onboarding = await api('POST', '/api/hr/onboarding', {
    token: adminToken,
    body: { applicationId, joiningDate: '2026-06-01', departmentId, designationId },
  });
  expect(onboarding.status, JSON.stringify(onboarding.body)).toBe(201);
  const id = data<{ onboarding: { id: string } }>(onboarding).onboarding.id;
  owned.onboardingIds.push(id);
  return { id };
}

type OnboardingView = {
  id: string;
  stage: string;
  employee: { id: string; employeeId: string } | null;
  tasks: { id: string; category: string; status: string; trainingEnrollmentId: string | null }[];
};

async function readOnboarding(id: string): Promise<OnboardingView> {
  const res = await api('GET', `/api/hr/onboarding/${id}`, { token: adminToken });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return data<{ onboarding: OnboardingView }>(res).onboarding;
}

/** The TRAINING task on a seeded checklist. There is exactly one. */
function trainingTaskOf(view: OnboardingView): OnboardingView['tasks'][number] {
  const tasks = view.tasks.filter((task) => task.category === 'TRAINING');
  expect(tasks.length, 'exactly one TRAINING task on the seeded checklist').toBe(1);
  const task = tasks[0];
  if (!task) throw new Error('unreachable: length asserted above');
  return task;
}

/** Advance to EMPLOYEE_CREATED, which is what creating the employment record does. */
async function createEmployment(onboardingId: string): Promise<{ employeeId: string }> {
  for (const toStage of ['DOCUMENTS', 'VERIFICATION']) {
    const moved = await api('POST', `/api/hr/onboarding/${onboardingId}/advance`, {
      token: adminToken,
      body: { toStage },
    });
    expect(moved.status, `${toStage}: ${JSON.stringify(moved.body)}`).toBe(200);
  }

  /*
    EMPLOYEE_CREATED is reached by creating the record, never by a stage move — the
    advance endpoint does not offer it. That asymmetry is Phase 3's, and the reason
    this helper exists rather than a third `toStage` in the loop above.
  */
  const created = await api('POST', `/api/hr/onboarding/${onboardingId}/employee`, {
    token: adminToken,
    body: { workEmail: testEmail('hired') },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const view = await readOnboarding(onboardingId);
  expect(view.employee, 'the employment record exists after EMPLOYEE_CREATED').not.toBeNull();
  const employeeId = view.employee?.id;
  if (!employeeId) throw new Error('unreachable: asserted above');
  owned.employeeIds.push(employeeId);
  return { employeeId };
}

// ---------------------------------------------------------------------------
//  Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await startTestServer();

  admin = await makeUser('ADMIN');
  adminToken = await mintToken(admin.id, { role: 'ADMIN' });

  /*
    Granted explicitly rather than relied on by role.

    An ADMIN holds HR_TRAINING by role default, but the whole reason this suite
    exists is that a grant held by default was invisible to `hrActor`. Writing the
    override makes the test independent of ROLE_DEFAULTS, so a change there fails on
    its own merits rather than silently removing this file's coverage.
  */
  await grant(admin.id, 'HR_TRAINING', ['VIEW', 'CREATE', 'EDIT', 'ASSIGN', 'APPROVE']);
  await grant(admin.id, 'HR_RECRUITMENT', ['VIEW', 'CREATE', 'EDIT', 'APPROVE']);
  await grant(admin.id, 'HR_EMPLOYEE', ['VIEW', 'CREATE', 'EDIT']);
  await grant(admin.id, 'HR_ADMIN', ['VIEW', 'CREATE', 'EDIT']);

  const dept = await api('POST', '/api/hr/departments', {
    token: adminToken,
    body: { name: `${RUN_PREFIX} P4 Dept`, code: testCode('DEPT') },
  });
  expect(dept.status, JSON.stringify(dept.body)).toBe(201);
  departmentId = data<{ department: { id: string } }>(dept).department.id;
  owned.departmentIds.push(departmentId);

  const desig = await api('POST', '/api/hr/designations', {
    token: adminToken,
    body: { name: `${RUN_PREFIX} P4 Role`, code: testCode('DESIG'), level: 3 },
  });
  expect(desig.status, JSON.stringify(desig.body)).toBe(201);
  designationId = data<{ designation: { id: string } }>(desig).designation.id;
  owned.designationIds.push(designationId);
}, 120_000);

afterAll(async () => {
  /*
    Deleted by id, in dependency order, and then asserted gone.

    Enrollments before programs because `TrainingEnrollment.programId` is
    `onDelete: Restrict` — a program with a live enrollment cannot be removed, which
    is correct behaviour and the reason this order is not incidental. Everything
    under an enrollment (progress, attempts, practicals, shadowings, qualification)
    cascades, so it is not listed.

    Nothing here matches on a name or code prefix. That is deliberate: the Phase 3
    teardown leak came from a prefix predicate that matched the wrong column.
  */
  await prisma.trainingEnrollment.deleteMany({ where: { id: { in: owned.enrollmentIds } } });
  await prisma.trainingProgram.deleteMany({ where: { id: { in: owned.programIds } } });

  await prisma.onboardingRecord.deleteMany({ where: { id: { in: owned.onboardingIds } } });
  await prisma.offer.deleteMany({ where: { id: { in: owned.offerIds } } });
  await prisma.application.deleteMany({ where: { id: { in: owned.applicationIds } } });
  await prisma.candidate.deleteMany({ where: { id: { in: owned.candidateIds } } });
  await prisma.jobRequisition.deleteMany({ where: { id: { in: owned.jobIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: owned.employeeIds } } });
  await prisma.designation.deleteMany({ where: { id: { in: owned.designationIds } } });
  await prisma.department.deleteMany({ where: { id: { in: owned.departmentIds } } });

  // Proof rather than hope: every tracked row is gone.
  const residue = await Promise.all([
    prisma.trainingEnrollment.count({ where: { id: { in: owned.enrollmentIds } } }),
    prisma.trainingProgram.count({ where: { id: { in: owned.programIds } } }),
    prisma.onboardingRecord.count({ where: { id: { in: owned.onboardingIds } } }),
    prisma.employee.count({ where: { id: { in: owned.employeeIds } } }),
  ]);
  expect(residue, 'this run left no training or onboarding rows behind').toEqual([0, 0, 0, 0]);

  await cleanup();
  expect(await residualTestRows()).toBe(0);
  await stopTestServer();
}, 120_000);

// ---------------------------------------------------------------------------
//  The link
// ---------------------------------------------------------------------------

describe('linking an onboarding TRAINING task to real training', () => {
  it(
    'refuses to create an enrollment before the employment record exists',
    async () => {
      /*
        Phase 3 creates the checklist at the start of onboarding, long before the
        Employee row. Naming a program at that point has nobody to enrol — so the
        service refuses rather than creating an orphan and reconciling it later.
      */
      const onboarding = await makeOnboarding();
      const program = await makeProgram();
      const view = await readOnboarding(onboarding.id);
      const task = trainingTaskOf(view);

      expect(view.employee, 'no employment record yet at this stage').toBeNull();
      expect(task.trainingEnrollmentId, 'and so the task starts unlinked').toBeNull();

      const res = await api('POST', `/api/hr/training/onboarding-tasks/${task.id}/link`, {
        token: adminToken,
        body: { programId: program.id },
      });

      // A business rule, not a validation failure: 400 rather than 422.
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.message).toBeTruthy();

      // And nothing was written.
      const after = await readOnboarding(onboarding.id);
      expect(trainingTaskOf(after).trainingEnrollmentId).toBeNull();
    },
    120_000,
  );

  it(
    'creates and attaches an enrollment for the onboarding\'s own employee',
    async () => {
      const onboarding = await makeOnboarding();
      const program = await makeProgram();
      const { employeeId } = await createEmployment(onboarding.id);

      const task = trainingTaskOf(await readOnboarding(onboarding.id));
      expect(task.trainingEnrollmentId, 'unlinked before the link').toBeNull();

      const res = await api('POST', `/api/hr/training/onboarding-tasks/${task.id}/link`, {
        token: adminToken,
        body: { programId: program.id },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const result = data<{
        taskId: string;
        enrollmentId: string;
        created: boolean;
        alreadyLinked: boolean;
      }>(res);
      owned.enrollmentIds.push(result.enrollmentId);

      expect(result.taskId).toBe(task.id);
      expect(result.created, 'the first link creates the enrollment').toBe(true);
      expect(result.alreadyLinked).toBe(false);

      // The task now carries it, read back through the onboarding endpoint.
      const linked = trainingTaskOf(await readOnboarding(onboarding.id));
      expect(linked.trainingEnrollmentId).toBe(result.enrollmentId);

      // And the enrollment is for this onboarding's employee, not somebody else.
      const enrollment = await api('GET', `/api/hr/training/enrollments/${result.enrollmentId}`, {
        token: adminToken,
      });
      expect(enrollment.status, JSON.stringify(enrollment.body)).toBe(200);
      const view = data<{
        enrollment: {
          employee: { id: string };
          program: { id: string };
          assignedVia: string;
        };
      }>(enrollment).enrollment;

      expect(view.employee.id).toBe(employeeId);
      expect(view.program.id).toBe(program.id);
      // How it came about is recorded, so an employee who later moves department
      // keeps the course they were given for joining.
      expect(view.assignedVia).toBe('ONBOARDING');
    },
    120_000,
  );

  it(
    'is idempotent — a repeat returns the same enrollment and creates no second one',
    async () => {
      const onboarding = await makeOnboarding();
      const program = await makeProgram();
      await createEmployment(onboarding.id);
      const task = trainingTaskOf(await readOnboarding(onboarding.id));

      const first = await api('POST', `/api/hr/training/onboarding-tasks/${task.id}/link`, {
        token: adminToken,
        body: { programId: program.id },
      });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const firstId = data<{ enrollmentId: string }>(first).enrollmentId;
      owned.enrollmentIds.push(firstId);

      /*
        The retry. Shaped as a real retry rather than a different request: a browser
        double-click, or a client retrying after a timeout, sends exactly this.
        Answering 409 would make a harmless repeat look like a conflict somebody has
        to resolve.
      */
      const again = await api('POST', `/api/hr/training/onboarding-tasks/${task.id}/link`, {
        token: adminToken,
        body: { programId: program.id },
      });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      const repeat = data<{ enrollmentId: string; created: boolean; alreadyLinked: boolean }>(
        again,
      );

      expect(repeat.enrollmentId).toBe(firstId);
      expect(repeat.created, 'nothing was created the second time').toBe(false);
      expect(repeat.alreadyLinked).toBe(true);

      // Counted in the database, not inferred from the response: exactly one.
      const count = await prisma.trainingEnrollment.count({
        where: { programId: program.id },
      });
      expect(count, 'one enrollment, not two').toBe(1);
    },
    120_000,
  );

  it(
    'refuses an enrollment belonging to a different employee',
    async () => {
      /*
        The containment property. Without it, a task on one person's onboarding
        could be satisfied by somebody else's training — and the checklist would
        then report training complete for a person who has done none.
      */
      const onboarding = await makeOnboarding();
      const program = await makeProgram();
      await createEmployment(onboarding.id);

      const stranger = await makeEmployee();
      const assigned = await api('POST', '/api/hr/training/assignments', {
        token: adminToken,
        body: { programId: program.id, employeeIds: [stranger.id] },
      });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
      const strangerEnrollmentId = data<{ enrollmentIds: string[] }>(assigned).enrollmentIds[0];
      expect(strangerEnrollmentId).toBeTruthy();
      if (!strangerEnrollmentId) throw new Error('unreachable: asserted above');
      owned.enrollmentIds.push(strangerEnrollmentId);

      const task = trainingTaskOf(await readOnboarding(onboarding.id));
      const res = await api('POST', `/api/hr/training/onboarding-tasks/${task.id}/link`, {
        token: adminToken,
        body: { enrollmentId: strangerEnrollmentId },
      });

      expect(res.status, JSON.stringify(res.body)).toBe(400);

      // The task is still unlinked — the refusal wrote nothing.
      const after = trainingTaskOf(await readOnboarding(onboarding.id));
      expect(after.trainingEnrollmentId).toBeNull();
    },
    120_000,
  );

  it(
    'drives the task to completion when the training is finished',
    async () => {
      /*
        The payoff for linking at all: the task stops being a box somebody ticks and
        becomes a report on actual training. Completing the program's one required
        lesson should settle the task without anybody touching it.
      */
      const onboarding = await makeOnboarding();
      const program = await makeProgram();
      const { employeeId } = await createEmployment(onboarding.id);

      const task = trainingTaskOf(await readOnboarding(onboarding.id));
      const linked = await api('POST', `/api/hr/training/onboarding-tasks/${task.id}/link`, {
        token: adminToken,
        body: { programId: program.id },
      });
      expect(linked.status, JSON.stringify(linked.body)).toBe(200);
      const enrollmentId = data<{ enrollmentId: string }>(linked).enrollmentId;
      owned.enrollmentIds.push(enrollmentId);

      /*
        Completed as the learner, which needs their account linked to the employment
        record: `completeModule` refuses anybody but the learner, including an
        administrator holding every grant. That refusal is the feature — nobody
        self-certifies on somebody else's behalf — so the test satisfies it rather
        than working around it.
      */
      const learner = await makeUser('USER');
      await grant(learner.id, 'HR_EMPLOYEE', ['VIEW']);
      const link = await api('POST', `/api/hr/employees/${employeeId}/user`, {
        token: adminToken,
        body: { userId: learner.id },
      });
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      const learnerToken = await mintToken(learner.id, { role: 'USER' });

      const enrollment = await api('GET', `/api/hr/training/enrollments/${enrollmentId}`, {
        token: learnerToken,
      });
      expect(enrollment.status, JSON.stringify(enrollment.body)).toBe(200);
      const modules = data<{
        enrollment: { modules: { moduleId: string; isUnlocked: boolean; kind: string }[] };
      }>(enrollment).enrollment.modules;

      const first = modules[0];
      expect(first, 'the program has its one lesson').toBeTruthy();
      if (!first) throw new Error('unreachable: asserted above');
      // The first step of a program is always reachable — nothing precedes it.
      expect(first.isUnlocked).toBe(true);

      const completed = await api(
        'POST',
        `/api/hr/training/enrollments/${enrollmentId}/modules/${first.moduleId}/complete`,
        { token: learnerToken, body: {} },
      );
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);

      const after = data<{ enrollment: { status: string; completedModuleCount: number } }>(
        completed,
      ).enrollment;
      expect(after.completedModuleCount).toBe(1);
      expect(after.status, 'the only required step is done').toBe('COMPLETED');

      // And the onboarding task followed, without anybody ticking it.
      const settled = trainingTaskOf(await readOnboarding(onboarding.id));
      expect(settled.trainingEnrollmentId).toBe(enrollmentId);
      expect(settled.status, 'training completion settled the checklist task').toBe('COMPLETED');
    },
    180_000,
  );
});
