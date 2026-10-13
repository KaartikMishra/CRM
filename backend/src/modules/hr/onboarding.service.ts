/**
 * Onboarding and probation.
 *
 * ### The function this whole file is built around
 *
 * `createEmployeeFromOnboarding`. It is the only place in Phase 3 that writes
 * `Employee`, and it does so through Phase 1's `allocateEmployeeId` — the atomic
 * counter — inside the creating transaction. Three properties hold it together:
 *
 *   1. **One hire, one employment record.** `attachEmployeeToOnboarding` updates
 *      conditionally on `employeeId` still being null. Two concurrent requests
 *      cannot both win, so the business cannot end up with the same person twice
 *      under two employee numbers.
 *   2. **No second identity.** Nothing here invents an employee-id scheme, and the
 *      candidate record survives rather than being transformed.
 *   3. **No credential.** It creates no login — see the limitation note below.
 *
 * ### The account limitation, stated plainly
 *
 * Onboarding does **not** create a CRM login. This codebase has no secure
 * invitation flow: no token table, no expiry, no first-password journey. Building
 * one here would mean inventing a credential-delivery mechanism with no threat
 * model, and the obvious shortcuts — a generated password in an email, a default
 * password, a password the HR user chooses on somebody's behalf — are all worse
 * than not doing it.
 *
 * So the ACCOUNT stage surfaces the *existing* employee↔user link operation as a
 * task somebody completes deliberately once an account exists by the normal route.
 * Reported as a limitation rather than papered over.
 *
 * ### Probation is not performance management
 *
 * Four scheduled reviews and one decision. No goals, no competencies, no
 * calibration — those are Phase 4, and guessing at a framework now would mean
 * migrating away from the guess later.
 */

import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import {
  ADVERSE_BACKGROUND_CHECK_STATUSES,
  ONBOARDING_STAGES,
  PRE_EMPLOYEE_ONBOARDING_STAGES,
  PROBATION_REVIEW_OFFSET_DAYS,
  PROBATION_REVIEW_TYPES,
  type AdvanceOnboardingStageInput,
  type CompleteOnboardingTaskInput,
  type CreateEmployeeFromOnboardingInput,
  type CreateOnboardingInput,
  type CreateOnboardingTaskInput,
  type DecideProbationInput,
  type OnboardingListQuery,
  type OnboardingStage,
  type OnboardingSummary,
  type OnboardingTaskView,
  type OnboardingView,
  type ProbationListQuery,
  type ProbationReviewView,
  type ProbationSummary,
  type ProbationView,
  type RecordProbationReviewInput,
  type StartProbationInput,
  type UpdateOnboardingInput,
  type UpdateOnboardingTaskInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { HrActor } from './hr-access.js';
import {
  type RecruitmentScope,
  mayCompleteOnboardingTask,
  mayDecideProbation,
  mayDecideRecruitment,
  mayEditRecruitment,
  visibleApplicationFilter,
} from './recruitment-access.js';
import * as notifications from './recruitment.notify.js';
import * as repo from './recruitment.repository.js';
import * as hrRepo from './hr.repository.js';
import * as hrNotifications from './hr.notify.js';
import {
  TX_OPTIONS,
  dayKey,
  iso,
  loadVisibleApplication,
  notFound,
  toEmployeeRef,
  assertDepartmentExists,
  assertDesignationExists,
  assertEmployeeEmployed,
} from './recruitment.service.js';

// ---------------------------------------------------------------------------
//  Presentation
// ---------------------------------------------------------------------------

function presentTask(row: repo.OnboardingTaskRecord): OnboardingTaskView {
  return {
    id: row.id,
    onboardingRecordId: row.onboardingRecordId,
    title: row.title,
    category: row.category,
    detail: row.detail,
    assignee: row.assignee ? toEmployeeRef(row.assignee) : null,
    dueOn: dayKey(row.dueOn),
    status: row.status,
    completedAt: iso(row.completedAt),
    completedBy: row.completedBy,
    notes: row.notes,
    sortOrder: row.sortOrder,
    trainingEnrollmentId: row.trainingEnrollmentId,
  };
}

function presentOnboardingRow(
  row: repo.OnboardingRowRecord,
  settledCount: number,
): OnboardingSummary {
  return {
    id: row.id,
    applicationId: row.applicationId,
    candidate: {
      id: row.application.candidate.id,
      displayName: `${row.application.candidate.firstName} ${row.application.candidate.lastName}`.trim(),
      email: row.application.candidate.email,
    },
    job: row.application.jobRequisition,
    stage: row.stage,
    joiningDate: dayKey(row.joiningDate) ?? '',
    actualJoiningDate: dayKey(row.actualJoiningDate),
    employee: row.employee ? toEmployeeRef(row.employee) : null,
    department: row.department,
    designation: row.designation,
    manager: row.manager ? toEmployeeRef(row.manager) : null,
    taskCount: row._count.tasks,
    completedTaskCount: settledCount,
    completedAt: iso(row.completedAt),
  };
}

/**
 * Which stages this onboarding may advance to.
 *
 * Forward one step only, plus the pre-employee boundary. Unlike the ATS pipeline,
 * onboarding is genuinely sequential: there is no sensible reading of "go back to
 * DOCUMENTS" once the employment record exists, because the thing that changed is
 * not reversible.
 */
function availableOnboardingStages(
  stage: OnboardingStage,
  hasEmployee: boolean,
): OnboardingStage[] {
  const index = ONBOARDING_STAGES.indexOf(stage);
  const next = ONBOARDING_STAGES[index + 1];
  if (next === undefined) return [];

  /*
    EMPLOYEE_CREATED is not advanced *to* — it is reached by creating the employment
    record, which is its own endpoint. Offering it as a stage move would let somebody
    mark the hinge passed without an Employee behind it, and the CHECK pair would
    then refuse every later advance with a confusing error.
  */
  if (next === 'EMPLOYEE_CREATED') return [];
  if (!hasEmployee && !(PRE_EMPLOYEE_ONBOARDING_STAGES as readonly string[]).includes(next)) {
    return [];
  }

  return [next];
}

function presentOnboarding(
  row: repo.OnboardingDetailRecord,
  settledCount: number,
  canCreateEmployee: boolean,
): OnboardingView {
  return {
    ...presentOnboardingRow(row as unknown as repo.OnboardingRowRecord, settledCount),
    notes: row.notes,
    tasks: row.tasks.map(presentTask),
    availableStages: availableOnboardingStages(row.stage, row.employeeId !== null),
    canCreateEmployee,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentReview(row: repo.ProbationReviewRecord): ProbationReviewView {
  return {
    id: row.id,
    probationRecordId: row.probationRecordId,
    reviewType: row.reviewType,
    scheduledOn: dayKey(row.scheduledOn) ?? '',
    status: row.status,
    reviewer: row.reviewer ? toEmployeeRef(row.reviewer) : null,
    rating: row.rating,
    comments: row.comments,
    recommendation: row.recommendation,
    completedAt: iso(row.completedAt),
  };
}

function presentProbationRow(
  row: repo.ProbationRowRecord,
  completedCount: number,
): ProbationSummary {
  return {
    id: row.id,
    employee: toEmployeeRef(row.employee),
    startDate: dayKey(row.startDate) ?? '',
    endDate: dayKey(row.endDate) ?? '',
    status: row.status,
    manager: row.manager ? toEmployeeRef(row.manager) : null,
    decision: row.decision,
    reviewCount: row._count.reviews,
    completedReviewCount: completedCount,
  };
}

function presentProbation(
  row: repo.ProbationDetailRecord,
  completedCount: number,
): ProbationView {
  return {
    ...presentProbationRow(row as unknown as repo.ProbationRowRecord, completedCount),
    originalEndDate: dayKey(row.originalEndDate),
    decisionReason: row.decisionReason,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    reviews: row.reviews.map(presentReview),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
//  The default checklist
// ---------------------------------------------------------------------------

/**
 * The tasks every onboarding starts with.
 *
 * Seeded rather than left empty, because an empty checklist is a checklist nobody
 * fills in. These are the things the business does for every joiner, and a recruiter
 * adds the role-specific ones.
 *
 * **No asset, course or policy record is created by any of these.** ASSETS, TRAINING
 * and POLICY are categories — a task says a laptop is owed, and a future Asset
 * module finds that work by category. Inventing an asset register here would mean
 * migrating away from a fake one later.
 */
const DEFAULT_TASKS: readonly {
  title: string;
  category: 'DOCUMENTS' | 'IT' | 'HR' | 'MANAGER' | 'TRAINING' | 'POLICY' | 'DEPARTMENT';
  detail: string;
}[] = [
  {
    title: 'Collect and verify joining documents',
    category: 'DOCUMENTS',
    detail: 'Identity, address, education and previous employment proofs.',
  },
  {
    title: 'Issue workstation and equipment',
    category: 'IT',
    detail:
      'Recorded here as a task. There is no asset register in this phase, so the serial numbers live with whoever issues it.',
  },
  {
    title: 'Create and link the CRM account',
    category: 'HR',
    detail:
      'Onboarding does not create logins. Create the account by the normal route, then link it to the employee record.',
  },
  {
    title: 'Acknowledge company policies',
    category: 'POLICY',
    detail: 'Code of conduct, leave policy, information security.',
  },
  {
    title: 'Introduce to the department',
    category: 'DEPARTMENT',
    detail: 'Team introductions and a walk through what the department does.',
  },
  {
    title: 'Confirm reporting manager and first-week plan',
    category: 'MANAGER',
    detail: 'Agree what the first week looks like and who to ask for what.',
  },
  {
    title: 'Complete induction training',
    category: 'TRAINING',
    detail:
      'Recorded as a task. There is no course catalogue in this phase — the trainer tracks the content.',
  },
];

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

/**
 * Starting an onboarding from an accepted offer.
 *
 * The application must be at OFFER_ACCEPTED. That is the guard making "nobody is
 * onboarded who did not accept an offer" structural: without it, somebody could be
 * walked through a checklist and given an employment record having never been
 * offered the job.
 *
 * `applicationId` is unique on the table, so a second onboarding for one application
 * is refused by the database rather than by this check — which is what matters under
 * concurrency.
 */
export async function createOnboarding(
  req: Request,
  actor: HrActor,
  input: CreateOnboardingInput,
): Promise<OnboardingView> {
  const application = await repo.findApplicationState(input.applicationId);
  if (!application) {
    throw AppError.badRequest('APPLICATION_NOT_FOUND', 'That application could not be found.');
  }
  if (application.currentStage !== 'OFFER_ACCEPTED' && application.currentStage !== 'ONBOARDING') {
    throw AppError.badRequest(
      'OFFER_NOT_ACCEPTED',
      'Onboarding starts once an offer has been accepted.',
    );
  }

  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.designationId) await assertDesignationExists(input.designationId);
  if (input.managerId) await assertEmployeeEmployed(input.managerId, 'manager');

  const id = await prisma.$transaction(async (tx) => {
    const created = await repo.createOnboarding(tx, {
      applicationId: input.applicationId,
      joiningDate: input.joiningDate,
      departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null,
      managerId: input.managerId ?? null,
      notes: input.notes ?? null,
      stage: 'OFFER_ACCEPTED',
      createdById: actor.id,
    });

    await repo.createOnboardingTasks(
      tx,
      DEFAULT_TASKS.map((task, index) => ({
        onboardingRecordId: created.id,
        title: task.title,
        category: task.category,
        detail: task.detail,
        sortOrder: index,
        status: 'PENDING',
      })),
    );

    // The application follows into ONBOARDING, so the pipeline and the checklist
    // agree about where this hire is.
    await repo.transitionApplication(tx, {
      id: input.applicationId,
      fromStage: 'OFFER_ACCEPTED',
      fromStatuses: ['ACTIVE'],
      data: { currentStage: 'ONBOARDING' },
    });

    return created.id;
  }, TX_OPTIONS).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      throw AppError.conflict(
        'ONBOARDING_EXISTS',
        'This application is already being onboarded.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'HR_ONBOARDING_STARTED',
    entityType: 'OnboardingRecord',
    entityId: id,
    actorId: actor.id,
    newValue: {
      applicationId: input.applicationId,
      joiningDate: input.joiningDate.toISOString().slice(0, 10),
    },
  });

  return getOnboarding(actor, { kind: 'all' }, id);
}

export async function listOnboardings(
  scope: RecruitmentScope,
  query: OnboardingListQuery,
): Promise<{ items: OnboardingSummary[]; nextCursor: string | null }> {
  const where: Prisma.OnboardingRecordWhereInput = {
    application: visibleApplicationFilter(scope) as Prisma.ApplicationWhereInput,
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.from || query.to
      ? {
          joiningDate: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
    ...(query.search
      ? {
          application: {
            ...(visibleApplicationFilter(scope) as Prisma.ApplicationWhereInput),
            candidate: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          },
        }
      : {}),
  };

  const rows = await repo.listOnboardings({
    where,
    take: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);
  const settled = await repo.countSettledTasks(page.map((r) => r.id));

  return {
    items: page.map((row) => presentOnboardingRow(row, settled.get(row.id) ?? 0)),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getOnboarding(
  actor: HrActor,
  scope: RecruitmentScope,
  id: string,
): Promise<OnboardingView> {
  const row = await repo.findOnboarding(id);
  if (!row) throw notFound();
  await loadVisibleApplication(row.applicationId, scope);

  const settled = await repo.countSettledTasks([id]);
  const blocker = await employeeCreationBlocker(row);

  return presentOnboarding(row, settled.get(id) ?? 0, blocker === null);
}

/**
 * Why the employment record cannot be created yet, or null if it can.
 *
 * Returning the reason rather than a boolean is what lets the UI explain itself —
 * "two documents are still unverified" is actionable, "cannot create employee" is
 * not.
 */
async function employeeCreationBlocker(
  row: repo.OnboardingDetailRecord,
): Promise<string | null> {
  if (row.employeeId !== null) return 'An employment record already exists for this onboarding.';

  /*
    An adverse verification blocks the employment record, and a person has to resolve
    it — either by rejecting the application with a reason, or by recording a decision
    to proceed. Deliberately NOT an automatic rejection: a database row must not end
    somebody's prospects without somebody deciding.
  */
  const adverse = await prisma.backgroundCheck.count({
    where: {
      applicationId: row.applicationId,
      status: { in: [...ADVERSE_BACKGROUND_CHECK_STATUSES] },
    },
  });
  if (adverse > 0) {
    return 'A background check is flagged. Resolve it before creating the employment record.';
  }

  return null;
}

export async function updateOnboarding(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateOnboardingInput,
): Promise<OnboardingView> {
  const before = await repo.findOnboardingState(id);
  if (!before) throw notFound();

  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.designationId) await assertDesignationExists(input.designationId);
  if (input.managerId) await assertEmployeeEmployed(input.managerId, 'manager');

  await prisma.$transaction(
    (tx) => repo.updateOnboarding(tx, id, input as Prisma.OnboardingRecordUncheckedUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_ONBOARDING_UPDATED',
    entityType: 'OnboardingRecord',
    entityId: id,
    actorId: actor.id,
    newValue: { changed: Object.keys(input) },
  });

  return getOnboarding(actor, { kind: 'all' }, id);
}

/**
 * Advancing the checklist one stage.
 *
 * Forward one step, and never across the pre-employee boundary without the
 * employment record — the CHECK pair enforces the second half, and this gives the
 * caller a sentence instead of a constraint violation.
 */
export async function advanceOnboarding(
  req: Request,
  actor: HrActor,
  id: string,
  input: AdvanceOnboardingStageInput,
): Promise<OnboardingView> {
  const before = await repo.findOnboardingState(id);
  if (!before) throw notFound();

  const allowed = availableOnboardingStages(
    before.stage as OnboardingStage,
    before.employeeId !== null,
  );

  if (!allowed.includes(input.toStage)) {
    // Two different problems, two different messages. "You need the employment
    // record first" is actionable; "that is not the next stage" is a different fix.
    if (
      before.employeeId === null &&
      !(PRE_EMPLOYEE_ONBOARDING_STAGES as readonly string[]).includes(input.toStage)
    ) {
      throw AppError.badRequest(
        'EMPLOYEE_NOT_CREATED',
        'Create the employment record before advancing past verification.',
      );
    }
    throw AppError.badRequest(
      'STAGE_NOT_NEXT',
      `Onboarding at ${before.stage} cannot advance to ${input.toStage}.`,
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionOnboarding(tx, {
      id,
      fromStage: before.stage,
      data: {
        stage: input.toStage,
        ...(input.toStage === 'COMPLETED' ? { completedAt: now } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'ONBOARDING_MOVED',
      'Somebody else advanced this onboarding. Reload and try again.',
    );
  }

  await recordAudit(req, {
    action: 'HR_ONBOARDING_STAGE_ADVANCED',
    entityType: 'OnboardingRecord',
    entityId: id,
    actorId: actor.id,
    oldValue: { stage: before.stage },
    newValue: { stage: input.toStage },
  });

  return getOnboarding(actor, { kind: 'all' }, id);
}

/**
 * **Creating the employment record.** The most consequential function in Phase 3.
 *
 * Everything about its shape is about not doing this twice:
 *
 *   - `allocateEmployeeId` runs *inside* the transaction, so two concurrent calls
 *     cannot be handed the same number.
 *   - `attachEmployeeToOnboarding` updates conditionally on `employeeId` still being
 *     null. The loser gets 0 and this function throws, which rolls the transaction
 *     back — so the loser's allocated number and its Employee row are never
 *     committed. A check-then-act would let both through.
 *   - The onboarding's unique `employeeId` is the backstop if both of those somehow
 *     failed.
 *
 * Name and joining date come from the candidate and the onboarding record rather
 * than from the caller, so the employment record cannot disagree with the offer
 * somebody signed.
 *
 * It creates **no login**. See the note at the top of this file.
 */
export async function createEmployeeFromOnboarding(
  req: Request,
  actor: HrActor,
  id: string,
  input: CreateEmployeeFromOnboardingInput,
): Promise<OnboardingView> {
  if (!mayDecideRecruitment(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Creating an employment record needs recruitment approval rights.',
    );
  }

  const onboarding = await repo.findOnboarding(id);
  if (!onboarding) throw notFound();

  const blocker = await employeeCreationBlocker(onboarding);
  if (blocker !== null) {
    throw AppError.badRequest('EMPLOYEE_NOT_CREATABLE', blocker);
  }

  // Checked before the transaction for a useful message, and again by the unique
  // index so a race cannot slip past — the same shape `createEmployee` uses.
  const emailTaken = await hrRepo.findEmployeeByWorkEmail(input.workEmail);
  if (emailTaken) {
    throw AppError.conflict(
      'WORK_EMAIL_TAKEN',
      'An employee with that work email already exists.',
    );
  }

  const state = await repo.findOnboardingState(id);
  if (!state) throw notFound();

  const employeeId = await prisma.$transaction(async (tx) => {
    const allocated = await hrRepo.allocateEmployeeId(tx);

    const created = await hrRepo.createEmployee(tx, {
      employeeId: allocated,
      firstName: onboarding.application.candidate.firstName,
      lastName: onboarding.application.candidate.lastName,
      workEmail: input.workEmail,
      phone: input.phone ?? null,
      departmentId: state.departmentId,
      designationId: state.designationId,
      managerId: state.managerId,
      location: input.location ?? null,
      joiningDate: state.joiningDate,
      status: 'ACTIVE',
      // No userId: onboarding creates no login. The ACCOUNT task covers linking one.
    });

    /*
      The conditional attach. If another request got here first this returns 0, we
      throw, and the whole transaction — including the employee row and the allocated
      number above — is rolled back.
    */
    const attached = await repo.attachEmployeeToOnboarding(tx, {
      id,
      employeeId: created.id,
      stage: 'EMPLOYEE_CREATED',
    });
    if (attached === 0) {
      throw AppError.conflict(
        'EMPLOYEE_ALREADY_CREATED',
        'An employment record has already been created for this onboarding.',
      );
    }

    // The Phase 1 history timeline, written in the same transaction: history that
    // could commit without the employee, or the reverse, would be a timeline that lies.
    await hrRepo.addHistory(tx, [
      {
        employeeId: created.id,
        eventType: 'JOINED',
        toValue: allocated,
        performedById: actor.id,
        effectiveAt: state.joiningDate,
      },
    ]);

    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_EMPLOYEE_CREATED_FROM_ONBOARDING',
    entityType: 'Employee',
    entityId: employeeId,
    actorId: actor.id,
    newValue: { onboardingId: id, applicationId: state.applicationId },
  });

  // The manager gains a report — reusing Phase 1's notification rather than a second
  // one that says the same thing.
  if (state.managerId) {
    const managerUserId = await repo.findUserIdForEmployee(state.managerId);
    if (managerUserId) {
      await hrNotifications.notifyHrEmployeeAssignedToManager(managerUserId, employeeId);
    }
  }

  return getOnboarding(actor, { kind: 'all' }, id);
}

// ---------------------------------------------------------------------------
//  Onboarding tasks
// ---------------------------------------------------------------------------

export async function addOnboardingTask(
  req: Request,
  actor: HrActor,
  onboardingId: string,
  input: CreateOnboardingTaskInput,
): Promise<OnboardingTaskView> {
  const onboarding = await repo.findOnboardingState(onboardingId);
  if (!onboarding) throw notFound();
  if (input.assigneeId) await assertEmployeeEmployed(input.assigneeId, 'assignee');

  const row = await prisma.$transaction(
    (tx) =>
      repo.createOnboardingTask(tx, {
        onboardingRecordId: onboardingId,
        title: input.title,
        category: input.category,
        detail: input.detail ?? null,
        assigneeId: input.assigneeId ?? null,
        dueOn: input.dueOn ?? null,
        sortOrder: input.sortOrder ?? 100,
        status: 'PENDING',
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_ONBOARDING_TASK_CREATED',
    entityType: 'OnboardingTask',
    entityId: row.id,
    actorId: actor.id,
    newValue: { onboardingId, category: input.category },
  });

  if (input.assigneeId) {
    const userId = await repo.findUserIdForEmployee(input.assigneeId);
    if (userId) {
      await notifications.notifyOnboardingTaskAssigned(userId, row.id, onboardingId);
    }
  }

  return presentTask(row);
}

export async function updateOnboardingTask(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateOnboardingTaskInput,
): Promise<OnboardingTaskView> {
  const before = await repo.findOnboardingTaskState(id);
  if (!before) throw notFound();
  if (input.assigneeId) await assertEmployeeEmployed(input.assigneeId, 'assignee');

  const row = await prisma.$transaction(
    (tx) => repo.updateOnboardingTask(tx, id, input as Prisma.OnboardingTaskUncheckedUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_ONBOARDING_TASK_UPDATED',
    entityType: 'OnboardingTask',
    entityId: id,
    actorId: actor.id,
    newValue: { changed: Object.keys(input) },
  });

  if (input.assigneeId && input.assigneeId !== before.assigneeId) {
    const userId = await repo.findUserIdForEmployee(input.assigneeId);
    if (userId) {
      await notifications.notifyOnboardingTaskAssigned(userId, id, before.onboardingRecordId);
    }
  }

  return presentTask(row);
}

/**
 * Settling a task.
 *
 * The assignee may do this, or anybody who may edit recruitment — an unassigned task
 * still has to be closeable, or a checklist could never finish. A skipped task says
 * why, because deciding not to do something is a decision somebody is accountable
 * for; otherwise "skipped" becomes the quiet way to close a checklist nobody worked.
 */
export async function completeOnboardingTask(
  req: Request,
  actor: HrActor,
  id: string,
  input: CompleteOnboardingTaskInput,
): Promise<OnboardingTaskView> {
  const before = await repo.findOnboardingTaskState(id);
  if (!before) throw notFound();

  if (!mayCompleteOnboardingTask(actor, { assigneeId: before.assigneeId })) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Only the assignee or an HR user can close this task.',
    );
  }

  const settling = input.status === 'COMPLETED' || input.status === 'SKIPPED';

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.settleOnboardingTask(tx, {
      id,
      // Re-opening a settled task is not offered: the record says it was done, and
      // un-doing that would erase who closed it. A new task is the honest correction.
      fromStatuses: ['PENDING', 'IN_PROGRESS', 'BLOCKED'],
      data: {
        status: input.status,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        // Both move together with the status, paired with the
        // onboarding_task_completion_complete CHECK.
        ...(settling ? { completedAt: now, completedById: actor.id } : {}),
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'TASK_ALREADY_SETTLED',
      'This task has already been closed.',
    );
  }

  await recordAudit(req, {
    action: 'HR_ONBOARDING_TASK_SETTLED',
    entityType: 'OnboardingTask',
    entityId: id,
    actorId: actor.id,
    newValue: { status: input.status },
  });

  // Read back through the repository's own select rather than an inline copy: the
  // copy that used to live here drifted the moment the shared select gained a column.
  const row = await repo.findOnboardingTaskRecord(id);
  if (!row) throw notFound();
  return presentTask(row);
}

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

/**
 * Starting a probation, with its four reviews scheduled.
 *
 * All four are written in the same statement as the probation: a probation with two
 * of its four reviews is worse than a failed start, because the missing ones are
 * invisible until the date passes and nobody is reminded.
 *
 * Dates come from `PROBATION_REVIEW_OFFSET_DAYS` in shared, so the frontend showing
 * the schedule and the backend writing it cannot disagree.
 */
export async function startProbation(
  req: Request,
  actor: HrActor,
  input: StartProbationInput,
): Promise<ProbationView> {
  if (!mayEditRecruitment(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Starting a probation needs HR rights.');
  }

  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId },
    select: { id: true, status: true, managerId: true },
  });
  if (!employee) {
    throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'That employee could not be found.');
  }
  if (employee.status === 'EXITED') {
    throw AppError.badRequest(
      'EMPLOYEE_NOT_EMPLOYED',
      'That person has left, so they cannot be put on probation.',
    );
  }

  const existing = await repo.findProbationByEmployee(input.employeeId);
  if (existing) {
    throw AppError.conflict(
      'PROBATION_EXISTS',
      'This employee already has a probation record.',
    );
  }

  const managerId = input.managerId ?? employee.managerId;
  if (managerId) await assertEmployeeEmployed(managerId, 'reviewing manager');

  const id = await prisma.$transaction(async (tx) => {
    const created = await repo.createProbation(tx, {
      employeeId: input.employeeId,
      startDate: input.startDate,
      endDate: input.endDate,
      managerId: managerId ?? null,
      status: 'ACTIVE',
      reviews: {
        create: PROBATION_REVIEW_TYPES.map((reviewType) => ({
          reviewType,
          scheduledOn: addDays(input.startDate, PROBATION_REVIEW_OFFSET_DAYS[reviewType]),
          status: 'SCHEDULED' as const,
        })),
      },
    });
    return created.id;
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_PROBATION_STARTED',
    entityType: 'ProbationRecord',
    entityId: id,
    actorId: actor.id,
    newValue: {
      employeeId: input.employeeId,
      startDate: input.startDate.toISOString().slice(0, 10),
      endDate: input.endDate.toISOString().slice(0, 10),
    },
  });

  return getProbation(actor, id);
}

/** A calendar-day offset. UTC arithmetic, consistent with every HR date column. */
function addDays(from: Date, days: number): Date {
  const out = new Date(from.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export async function listProbations(
  actor: HrActor,
  query: ProbationListQuery,
): Promise<{ items: ProbationSummary[]; nextCursor: string | null }> {
  /*
    Probation is scoped on the employee model rather than through recruitment: it is
    a fact about somebody's employment, so an HR reader sees all and a manager sees
    the probations they are reviewing. A recruitment-involvement scope would be
    wrong here — a recruiter has no business in somebody's probation.
  */
  const canSeeAll = actor.can('HR_EMPLOYEE', 'VIEW') || actor.can('HR_RECRUITMENT', 'VIEW');

  const where: Prisma.ProbationRecordWhereInput = {
    ...(canSeeAll
      ? {}
      : actor.employeeId
        ? { OR: [{ managerId: actor.employeeId }, { employeeId: actor.employeeId }] }
        : { id: '__no_probation_matches_this__' }),
    ...(query.status ? { status: query.status } : {}),
    ...(query.employeeId ? { employeeId: query.employeeId } : {}),
    ...(query.managerId ? { managerId: query.managerId } : {}),
    ...(query.endingBefore ? { endDate: { lte: query.endingBefore } } : {}),
  };

  const rows = await repo.listProbations({
    where,
    take: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);
  const completed = await repo.countCompletedReviews(page.map((r) => r.id));

  return {
    items: page.map((row) => presentProbationRow(row, completed.get(row.id) ?? 0)),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getProbation(actor: HrActor, id: string): Promise<ProbationView> {
  const row = await repo.findProbation(id);
  if (!row) throw notFound();

  const canSeeAll = actor.can('HR_EMPLOYEE', 'VIEW') || actor.can('HR_RECRUITMENT', 'VIEW');
  const own = actor.employeeId !== null && row.employeeId === actor.employeeId;
  const reviewing = actor.employeeId !== null && row.managerId === actor.employeeId;

  // A not-found rather than a forbidden: confirming a probation record exists is
  // itself a disclosure about somebody's employment.
  if (!canSeeAll && !own && !reviewing) throw notFound();

  const completed = await repo.countCompletedReviews([id]);
  return presentProbation(row, completed.get(id) ?? 0);
}

/**
 * Recording a review.
 *
 * Needs a comment, not just a rating: a number somebody is expected to act on with
 * no explanation is not a review, and this record is what a later confirmation or
 * termination rests on.
 */
export async function recordProbationReview(
  req: Request,
  actor: HrActor,
  id: string,
  input: RecordProbationReviewInput,
): Promise<ProbationReviewView> {
  const before = await repo.findProbationReviewState(id);
  if (!before) throw notFound();

  const probation = await repo.findProbationState(before.probationRecordId);
  if (!probation) throw notFound();

  const permitted =
    mayEditRecruitment(actor) ||
    (actor.employeeId !== null && probation.managerId === actor.employeeId);
  if (!permitted) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Only the reviewing manager or HR can record this review.',
    );
  }

  /*
    A review has to name its reviewer, and a reviewer is an *employee*.

    The probation_review_completion CHECK requires `reviewerId` alongside the
    COMPLETED status, so this is not a policy choice that could be relaxed here — a
    completed review with no reviewer is a row the database refuses. It is also the
    right rule: "somebody assessed this person's first three months" is worth nothing
    if it cannot say who, and that is exactly the record a later confirmation or
    termination rests on.

    The practical consequence, worth stating because it surprises people: an HR
    administrator whose login has no Employee record cannot record a review even
    holding every recruitment grant. They are not being denied authority — there is
    simply nobody to attribute the assessment to. Linking their account to their HR
    record resolves it, which is the existing Phase 1 operation.
  */
  if (actor.employeeId === null) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'A review has to name the person who gave it. Link your account to your employee record first.',
    );
  }

  // Nobody reviews themselves. The same principle `decidesOwnAction` encodes for
  // approvals: a self-assessment recorded as a manager's review is not a review.
  if (probation.employeeId === actor.employeeId) {
    throw new AppError('FORBIDDEN', 403, 'Nobody records their own probation review.');
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.settleProbationReview(tx, {
      id,
      fromStatuses: ['SCHEDULED', 'MISSED'],
      data: {
        status: 'COMPLETED',
        rating: input.rating ?? null,
        comments: input.comments,
        recommendation: input.recommendation ?? null,
        // Reviewer and moment move with the status, paired with the
        // probation_review_completion CHECK.
        completedAt: now,
        reviewerId: actor.employeeId,
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'REVIEW_ALREADY_RECORDED',
      'This review has already been recorded.',
    );
  }

  await recordAudit(req, {
    action: 'HR_PROBATION_REVIEW_RECORDED',
    entityType: 'ProbationReview',
    entityId: id,
    actorId: actor.id,
    // The type and rating. Not the comments — a written assessment of somebody's
    // performance does not belong in the audit table.
    newValue: { reviewType: before.reviewType, rating: input.rating ?? null },
  });

  const row = await repo.findProbationReview(id);
  if (!row) throw notFound();
  return presentReview(row);
}

/**
 * The probation decision.
 *
 * The most consequential decision in this module, and the guards reflect it:
 *
 *   - Never the employee themselves, whatever else they hold. Confirming your own
 *     probation is the clearest case of deciding your own action.
 *   - The reviewing manager or an HR_RECRUITMENT approver.
 *   - A reason is required by this schema, by the service and by a CHECK. "We
 *     terminated" with no grounds is indefensible, and this is the record an
 *     employment dispute turns on.
 *   - An extension keeps the original end date, so the term somebody was originally
 *     given is not lost to an UPDATE.
 *
 * The write is conditional on an undecided status, so two managers cannot both
 * decide and have the second overwrite the first's name.
 */
export async function decideProbation(
  req: Request,
  actor: HrActor,
  id: string,
  input: DecideProbationInput,
): Promise<ProbationView> {
  const probation = await repo.findProbationState(id);
  if (!probation) throw notFound();

  if (!mayDecideProbation(actor, { employeeId: probation.employeeId, managerId: probation.managerId })) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Only the reviewing manager or an HR approver can decide this probation, and nobody decides their own.',
    );
  }

  if (input.decision === 'EXTEND' && input.newEndDate !== undefined) {
    if (input.newEndDate <= probation.endDate) {
      throw AppError.badRequest(
        'EXTENSION_NOT_LATER',
        'An extension has to push the end date later than it is now.',
      );
    }
  }

  const nextStatus =
    input.decision === 'CONFIRM'
      ? 'CONFIRMED'
      : input.decision === 'TERMINATE'
        ? 'TERMINATED'
        : 'EXTENDED';

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionProbation(tx, {
      id,
      // Only an undecided probation can be decided. An extended one can be decided
      // again — that is the point of extending it.
      fromStatuses: ['ACTIVE', 'EXTENDED'],
      data: {
        status: nextStatus,
        decision: input.decision,
        decisionReason: input.reason,
        decidedById: actor.id,
        decidedAt: now,
        ...(input.decision === 'EXTEND' && input.newEndDate
          ? {
              // The original is kept, so the term first given survives. Paired with
              // the probation_extension_keeps_original CHECK.
              originalEndDate: probation.endDate,
              endDate: input.newEndDate,
            }
          : {}),
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'PROBATION_ALREADY_DECIDED',
      'This probation has already been decided.',
    );
  }

  await recordAudit(req, {
    action: 'HR_PROBATION_DECIDED',
    entityType: 'ProbationRecord',
    entityId: id,
    actorId: actor.id,
    newValue: { decision: input.decision, reason: input.reason },
  });

  /*
    A termination decision does NOT itself end the employment. Setting
    Employee.status to EXITED is a Phase 1 operation with its own history entry and
    its own exit-date requirement, and doing it as a side effect here would mean a
    probation decision quietly ending somebody's employment with no exit date and no
    EmployeeHistory row saying so. The HR user performs that separately.
  */

  return getProbation(actor, id);
}
