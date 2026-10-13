/**
 * Assessment authoring, the scoped lists, the overview, and the onboarding link.
 *
 * Split from `assessment.service.ts`, which carries the learner's path — sitting a
 * paper, being reviewed, being qualified. This file is the other side: building the
 * papers, reading the queues, and joining training to onboarding.
 *
 * ### The one endpoint that returns the answer key
 *
 * `getAssessmentForAuthor` is the only place outside a settled attempt's review that
 * serialises `isCorrect`. It is gated on HR_TRAINING:EDIT here *and* in the route
 * table, and it exists because somebody has to be able to check what they authored.
 * Everything a learner can reach uses the key-free select.
 *
 * ### The lists are scoped, not filtered afterwards
 *
 * Every query ANDs `visibleLearnerFilter` into its `where`. Filtering a page after
 * the fact would make a page of 25 arrive with 3 rows and the cursor skip the rest —
 * so a manager's queue would silently appear to end early.
 */

import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  type CreateTrainingAssessmentInput,
  type CreateTrainingQuestionInput,
  type LinkOnboardingTaskToTrainingInput,
  type PracticalListQuery,
  type PracticalSubmissionView,
  type QualificationListQuery,
  type ShadowingListQuery,
  type ShadowingRecordView,
  type TrainingAssessmentView,
  type TrainingAttemptListQuery,
  type TrainingAttemptSummary,
  type TrainingOverview,
  type TrainingQualificationView,
  type UpdateTrainingAssessmentInput,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { HrActor } from './hr-access.js';
import {
  type TrainingScope,
  mayEditPrograms,
  visibleLearnerFilter,
} from './training-access.js';
import { effectiveMaxAttempts, effectiveThreshold } from './training.calc.js';
import * as notifications from './training.notify.js';
import * as repo from './training.repository.js';
import {
  TX_OPTIONS,
  companyDayKey,
  isUniqueViolation,
  notFound,
  toEmployeeRef,
} from './training.service.js';
import { getQualification } from './assessment.service.js';

const iso = (v: Date | null): string | null => (v === null ? null : v.toISOString());
const dayKey = (v: Date | null): string | null =>
  v === null ? null : v.toISOString().slice(0, 10);
const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

// ---------------------------------------------------------------------------
//  Assessment authoring
// ---------------------------------------------------------------------------

/**
 * Creating an assessment.
 *
 * Attaching it to a module is what lets that module complete by being passed. The
 * module must belong to the same program and be of kind ASSESSMENT — otherwise a
 * test could be hung off a lesson, and passing it would satisfy nothing.
 *
 * Only one final assessment per program, enforced by a partial unique index. The
 * service checks first so the caller gets a sentence rather than a constraint error.
 */
export async function createAssessment(
  req: Request,
  actor: HrActor,
  input: CreateTrainingAssessmentInput,
): Promise<TrainingAssessmentView> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Creating an assessment needs HR_TRAINING:EDIT.');
  }

  const policy = await repo.findProgramPolicy(input.programId);
  if (!policy) {
    throw AppError.badRequest('PROGRAM_NOT_FOUND', 'That program could not be found.');
  }
  if (policy.status === 'ARCHIVED') {
    throw AppError.badRequest('PROGRAM_ARCHIVED', 'An archived program cannot be changed.');
  }

  if (input.moduleId) {
    const module = await repo.findModule(input.moduleId);
    if (!module || module.programId !== input.programId) {
      throw AppError.badRequest(
        'MODULE_NOT_IN_PROGRAM',
        'That module does not belong to this program.',
      );
    }
    if (module.kind !== 'ASSESSMENT') {
      throw AppError.badRequest(
        'MODULE_NOT_ASSESSMENT',
        'A test can only be attached to an assessment step — otherwise passing it would satisfy nothing.',
      );
    }
    if (module.assessment) {
      throw AppError.conflict(
        'MODULE_HAS_ASSESSMENT',
        'That step already has a test attached.',
      );
    }
  }

  if (input.isFinal === true) {
    const existing = await repo.findProgramFinalAssessment(input.programId);
    if (existing) {
      throw AppError.conflict(
        'FINAL_ASSESSMENT_EXISTS',
        'This program already has a final assessment.',
      );
    }
  }

  const row = await prisma.$transaction(
    (tx) =>
      repo.createAssessment(tx, {
        programId: input.programId,
        moduleId: input.moduleId ?? null,
        title: input.title,
        instructions: input.instructions ?? null,
        // Null means inherit the program's, which is why it is not defaulted here.
        passingScore: input.passingScore ?? null,
        maxAttempts: input.maxAttempts ?? null,
        timeLimitMinutes: input.timeLimitMinutes ?? null,
        isFinal: input.isFinal ?? false,
        shuffleQuestions: input.shuffleQuestions ?? false,
        createdById: actor.id,
      }),
    TX_OPTIONS,
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'FINAL_ASSESSMENT_EXISTS',
        'This program already has a final assessment.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'HR_TRAINING_ASSESSMENT_CREATED',
    entityType: 'TrainingAssessment',
    entityId: row.id,
    actorId: actor.id,
    newValue: {
      programId: input.programId,
      isFinal: row.isFinal,
      // The threshold change matters: it alters what "passed" means.
      passingScore: row.passingScore ? row.passingScore.toString() : 'inherited',
    },
  });

  return presentAssessment(row, policy.passingScore, policy.maxAttempts);
}

export async function updateAssessment(
  req: Request,
  actor: HrActor,
  id: string,
  input: UpdateTrainingAssessmentInput,
): Promise<TrainingAssessmentView> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Changing an assessment needs HR_TRAINING:EDIT.');
  }

  const before = await repo.findAssessment(id);
  if (!before) throw notFound();

  const policy = await repo.findProgramPolicy(before.programId);
  if (!policy) throw notFound();

  const row = await prisma.$transaction(
    (tx) => repo.updateAssessment(tx, id, input as Prisma.TrainingAssessmentUncheckedUpdateInput),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_ASSESSMENT_UPDATED',
    entityType: 'TrainingAssessment',
    entityId: id,
    actorId: actor.id,
    /*
      Both ends of a threshold change, because it is the field that decides whether
      somebody passed — and changing it after people have sat the paper changes the
      meaning of their recorded results.
    */
    oldValue: {
      passingScore: before.passingScore ? before.passingScore.toString() : 'inherited',
      maxAttempts: before.maxAttempts ?? 'inherited',
    },
    newValue: { changed: Object.keys(input) },
  });

  return presentAssessment(row, policy.passingScore, policy.maxAttempts);
}

function presentAssessment(
  row: repo.AssessmentRecord,
  programPassingScore: Prisma.Decimal,
  programMaxAttempts: number,
): TrainingAssessmentView {
  return {
    id: row.id,
    programId: row.programId,
    moduleId: row.moduleId,
    title: row.title,
    // The effective threshold, resolved here so the browser never has to.
    passingScore: effectiveThreshold(row.passingScore, programPassingScore).toString(),
    maxAttempts: effectiveMaxAttempts(row.maxAttempts, programMaxAttempts),
    timeLimitMinutes: row.timeLimitMinutes,
    isFinal: row.isFinal,
    isActive: row.isActive,
    questionCount: row._count.questions,
    totalPoints: '0.00',
    instructions: row.instructions,
    shuffleQuestions: row.shuffleQuestions,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The authoring view, **with** the answer key.
 *
 * The only endpoint besides a settled attempt's review that returns `isCorrect`.
 * Gated on HR_TRAINING:EDIT here and in the route table — two checks because this is
 * precisely the response a learner must never receive, and a route-only check would
 * be one refactor away from being bypassed by a new handler.
 */
export async function getAssessmentForAuthor(
  actor: HrActor,
  id: string,
): Promise<{
  assessment: TrainingAssessmentView;
  questions: {
    id: string;
    kind: string;
    prompt: string;
    points: string;
    sortOrder: number;
    explanation: string | null;
    options: { id: string; label: string; sortOrder: number; isCorrect: boolean }[];
  }[];
}> {
  if (!mayEditPrograms(actor)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Reading an assessment’s answers needs HR_TRAINING:EDIT.',
    );
  }

  const row = await repo.findAssessment(id);
  if (!row) throw notFound();

  const policy = await repo.findProgramPolicy(row.programId);
  if (!policy) throw notFound();

  const questions = await repo.listReviewQuestions(id);
  const totalPoints = questions.reduce(
    (sum, q) => sum.plus(q.points),
    new Prisma.Decimal(0),
  );

  return {
    assessment: {
      ...presentAssessment(row, policy.passingScore, policy.maxAttempts),
      totalPoints: totalPoints.toDecimalPlaces(2).toString(),
    },
    questions: questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      points: q.points.toString(),
      sortOrder: q.sortOrder,
      explanation: q.explanation,
      options: q.options.map((o) => ({
        id: o.id,
        label: o.label,
        sortOrder: o.sortOrder,
        isCorrect: o.isCorrect,
      })),
    })),
  };
}

/**
 * Adding a question and its options together.
 *
 * Together rather than separately, because a question with no options is
 * unanswerable and a half-built paper is worse than none.
 *
 * The per-kind rules (exactly one correct on single choice, not every option correct
 * on multiple) are enforced by the Zod refines *and* re-checked here: Zod guards the
 * HTTP boundary, and this guards any future internal caller. They cannot be CHECK
 * constraints because each spans sibling rows.
 */
export async function addQuestion(
  req: Request,
  actor: HrActor,
  assessmentId: string,
  input: CreateTrainingQuestionInput,
): Promise<{ id: string }> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Adding a question needs HR_TRAINING:EDIT.');
  }

  const assessment = await repo.findAssessment(assessmentId);
  if (!assessment) throw notFound();

  const correct = input.options.filter((o) => o.isCorrect === true).length;
  if (correct === 0) {
    throw AppError.badRequest('NO_CORRECT_OPTION', 'Mark at least one option correct.');
  }
  if (input.kind === 'SINGLE_CHOICE' && correct !== 1) {
    throw AppError.badRequest(
      'SINGLE_CHOICE_NEEDS_ONE',
      'A single-choice question has exactly one correct option.',
    );
  }
  if (input.kind === 'TRUE_FALSE' && (input.options.length !== 2 || correct !== 1)) {
    throw AppError.badRequest(
      'TRUE_FALSE_SHAPE',
      'A true/false question has exactly two options and one correct answer.',
    );
  }
  if (input.kind === 'MULTIPLE_CHOICE' && correct === input.options.length) {
    throw AppError.badRequest(
      'ALL_OPTIONS_CORRECT',
      'If every option is correct the question tests nothing.',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const sortOrder = input.sortOrder ?? (await repo.nextQuestionSortOrder(tx, assessmentId));

    return repo.createQuestion(tx, {
      assessmentId,
      kind: input.kind,
      prompt: input.prompt,
      explanation: input.explanation ?? null,
      ...(input.points === undefined ? {} : { points: input.points }),
      sortOrder,
      options: {
        create: input.options.map((o, index) => ({
          label: o.label,
          isCorrect: o.isCorrect ?? false,
          sortOrder: index,
        })),
      },
    });
  }, TX_OPTIONS).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'QUESTION_POSITION_TAKEN',
        'Another question already occupies that position.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'HR_TRAINING_QUESTION_ADDED',
    entityType: 'TrainingQuestion',
    entityId: created.id,
    actorId: actor.id,
    /*
      The kind and the weighting — deliberately NOT the prompt, the options or which
      one is correct. An audit row is readable by a wider population than
      HR_TRAINING, and writing the answer key into it would defeat every other
      precaution in this module.
    */
    newValue: { assessmentId, kind: input.kind, points: input.points ?? 1 },
  });

  return created;
}

export async function removeQuestion(
  req: Request,
  actor: HrActor,
  id: string,
): Promise<void> {
  if (!mayEditPrograms(actor)) {
    throw new AppError('FORBIDDEN', 403, 'Removing a question needs HR_TRAINING:EDIT.');
  }

  const before = await repo.findQuestionState(id);
  if (!before) throw notFound();

  /*
    A question with answers against it cannot be removed. Deleting it would cascade
    away the answers of everybody who sat the paper, silently changing their recorded
    scores — a learner who passed 8/10 would become 8/9 and nobody would know why.
  */
  const answered = await prisma.trainingAnswer.count({ where: { questionId: id } });
  if (answered > 0) {
    throw AppError.badRequest(
      'QUESTION_ANSWERED',
      'People have already answered this question. Deactivate the assessment and create a new one instead.',
    );
  }

  await prisma.$transaction((tx) => repo.deleteQuestion(tx, id), TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_TRAINING_QUESTION_REMOVED',
    entityType: 'TrainingQuestion',
    entityId: id,
    actorId: actor.id,
    oldValue: { assessmentId: before.assessmentId },
  });
}

// ---------------------------------------------------------------------------
//  Scoped lists
// ---------------------------------------------------------------------------

export async function listAttempts(
  scope: TrainingScope,
  query: TrainingAttemptListQuery,
): Promise<{ items: TrainingAttemptSummary[]; nextCursor: string | null }> {
  const where: Prisma.TrainingAttemptWhereInput = {
    // Scoped through the enrollment — where the learner lives.
    enrollment: visibleLearnerFilter(scope) as Prisma.TrainingEnrollmentWhereInput,
    ...(query.enrollmentId ? { enrollmentId: query.enrollmentId } : {}),
    ...(query.assessmentId ? { assessmentId: query.assessmentId } : {}),
    ...(query.employeeId ? { enrollment: { employeeId: query.employeeId } } : {}),
    ...(query.passedOnly ? { status: 'PASSED' } : {}),
  };

  const rows = await repo.listAttempts({ where, take: query.limit + 1, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  // The program's threshold per attempt, so the summary can state what each was
  // judged against rather than guessing.
  const items = await Promise.all(
    page.map(async (row) => {
      const state = await repo.findAttemptState(row.id);
      const policy = state
        ? await repo.findProgramPolicy(state.enrollment.programId)
        : null;
      const programThreshold = policy?.passingScore ?? new Prisma.Decimal(0);
      return {
        id: row.id,
        assessmentId: row.assessmentId,
        assessmentTitle: row.assessment.title,
        attemptNumber: row.attemptNumber,
        status: row.status,
        startedAt: row.startedAt.toISOString(),
        submittedAt: iso(row.submittedAt),
        score: dec(row.score),
        maxScore: dec(row.maxScore),
        percentage: dec(row.percentage),
        passed: row.passed,
        passingScore: effectiveThreshold(
          row.assessment.passingScore,
          programThreshold,
        ).toString(),
      };
    }),
  );

  return {
    items,
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function listPracticals(
  scope: TrainingScope,
  query: PracticalListQuery,
): Promise<{ items: PracticalSubmissionView[]; nextCursor: string | null }> {
  const where: Prisma.PracticalSubmissionWhereInput = {
    enrollment: visibleLearnerFilter(scope) as Prisma.TrainingEnrollmentWhereInput,
    ...(query.status ? { status: query.status } : {}),
    ...(query.reviewerId ? { reviewerId: query.reviewerId } : {}),
    ...(query.employeeId ? { enrollment: { employeeId: query.employeeId } } : {}),
    // The reviewer's queue: submitted and awaiting a decision.
    ...(query.pendingOnly ? { status: 'SUBMITTED' } : {}),
  };

  const rows = await repo.listPracticals({ where, take: query.limit + 1, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    items: page.map(presentPracticalRow),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * A reviewer's own queue, reachable without a training grant.
 *
 * A reviewer or mentor usually holds no HR_TRAINING permission — being assigned is a
 * fact about rows, not a permission. So this is scoped by *assignment* rather than by
 * `visibleLearnerFilter`: they see what they were asked to review and nothing else.
 */
export async function listMyReviewQueue(
  actor: HrActor,
): Promise<{ practicals: PracticalSubmissionView[]; shadowings: ShadowingRecordView[] }> {
  if (actor.employeeId === null) return { practicals: [], shadowings: [] };

  const [practicals, shadowings] = await Promise.all([
    repo.listPracticals({
      where: { reviewerId: actor.employeeId, status: 'SUBMITTED' },
      take: 100,
    }),
    repo.listShadowings({
      where: { mentorId: actor.employeeId, signedOffAt: null, status: { not: 'CANCELLED' } },
      take: 100,
    }),
  ]);

  return {
    practicals: practicals.map(presentPracticalRow),
    shadowings: shadowings.map(presentShadowingRow),
  };
}

export async function listShadowings(
  scope: TrainingScope,
  query: ShadowingListQuery,
): Promise<{ items: ShadowingRecordView[]; nextCursor: string | null }> {
  const where: Prisma.ShadowingRecordWhereInput = {
    enrollment: visibleLearnerFilter(scope) as Prisma.TrainingEnrollmentWhereInput,
    ...(query.status ? { status: query.status } : {}),
    ...(query.mentorId ? { mentorId: query.mentorId } : {}),
    ...(query.employeeId ? { enrollment: { employeeId: query.employeeId } } : {}),
    ...(query.pendingOnly ? { signedOffAt: null, status: { not: 'CANCELLED' } } : {}),
  };

  const rows = await repo.listShadowings({ where, take: query.limit + 1, cursor: query.cursor });
  const page = rows.slice(0, query.limit);

  return {
    items: page.map(presentShadowingRow),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function listQualifications(
  scope: TrainingScope,
  query: QualificationListQuery,
): Promise<{ items: TrainingQualificationView[]; nextCursor: string | null }> {
  const where: Prisma.TrainingQualificationWhereInput = {
    enrollment: visibleLearnerFilter(scope) as Prisma.TrainingEnrollmentWhereInput,
    ...(query.programId ? { enrollment: { programId: query.programId } } : {}),
    ...(query.employeeId ? { enrollment: { employeeId: query.employeeId } } : {}),
    ...(query.revoked === undefined
      ? {}
      : query.revoked
        ? { revokedAt: { not: null } }
        : { revokedAt: null }),
  };

  const rows = await repo.listQualifications({
    where,
    take: query.limit + 1,
    cursor: query.cursor,
  });
  const page = rows.slice(0, query.limit);

  return {
    items: await Promise.all(page.map((row) => getQualification(row.id))),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

function presentPracticalRow(row: repo.PracticalRecord): PracticalSubmissionView {
  return {
    id: row.id,
    enrollmentId: row.enrollmentId,
    moduleId: row.moduleId,
    moduleTitle: row.module.title,
    employee: toEmployeeRef(row.enrollment.employee),
    instructions: row.module.instructions,
    status: row.status,
    submissionNotes: row.submissionNotes,
    secureDocumentId: row.secureDocumentId,
    submittedAt: iso(row.submittedAt),
    reviewer: row.reviewer ? toEmployeeRef(row.reviewer) : null,
    reviewedBy: row.reviewedBy ? toEmployeeRef(row.reviewedBy) : null,
    reviewedAt: iso(row.reviewedAt),
    reviewNotes: row.reviewNotes,
  };
}

function presentShadowingRow(row: repo.ShadowingRecord): ShadowingRecordView {
  return {
    id: row.id,
    enrollmentId: row.enrollmentId,
    moduleId: row.moduleId,
    moduleTitle: row.module.title,
    employee: toEmployeeRef(row.enrollment.employee),
    mentor: row.mentor ? toEmployeeRef(row.mentor) : null,
    status: row.status,
    scheduledFrom: dayKey(row.scheduledFrom),
    scheduledTo: dayKey(row.scheduledTo),
    checklist: row.checklist,
    feedback: row.feedback,
    signedOffBy: row.signedOffBy ? toEmployeeRef(row.signedOffBy) : null,
    signedOffAt: iso(row.signedOffAt),
  };
}

// ---------------------------------------------------------------------------
//  Onboarding integration
// ---------------------------------------------------------------------------

/**
 * Linking an onboarding task to real training.
 *
 * ### Idempotent by design
 *
 * A retry is the normal case here — the link request is the kind of thing a flaky
 * connection makes twice. So:
 *
 *   - a task already linked to the *same* enrollment returns success unchanged;
 *   - a task already linked to a *different* one is refused, because silently
 *     relinking would orphan whatever progress the first enrollment carried;
 *   - naming a program reuses an existing live enrollment rather than creating a
 *     second, which is what stops a retry producing duplicate enrollments.
 *
 * ### Only after the employment record exists
 *
 * The onboarding's `employeeId` is null before the EMPLOYEE_CREATED stage, and
 * training is assigned to an *employee*. Refused with a sentence rather than
 * creating an enrollment against nobody.
 */
export async function linkOnboardingTask(
  req: Request,
  actor: HrActor,
  taskId: string,
  input: LinkOnboardingTaskToTrainingInput,
): Promise<{ taskId: string; enrollmentId: string; created: boolean; alreadyLinked: boolean }> {
  if (!actor.can('HR_TRAINING', 'ASSIGN') && !actor.can('HR_RECRUITMENT', 'EDIT')) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Linking training to onboarding needs HR_TRAINING:ASSIGN or HR_RECRUITMENT:EDIT.',
    );
  }

  const task = await repo.findOnboardingTaskForTraining(taskId);
  if (!task) throw notFound();

  if (task.category !== 'TRAINING') {
    throw AppError.badRequest(
      'TASK_NOT_TRAINING',
      'Only a training task can be linked to a training program.',
    );
  }

  const employeeId = task.onboardingRecord.employeeId;
  if (employeeId === null) {
    throw AppError.badRequest(
      'EMPLOYEE_NOT_CREATED',
      'Create the employment record before assigning training — training belongs to an employee.',
    );
  }

  // Already linked: idempotent for the same target, refused for a different one.
  if (task.trainingEnrollmentId !== null) {
    if (input.enrollmentId === task.trainingEnrollmentId) {
      return {
        taskId,
        enrollmentId: task.trainingEnrollmentId,
        created: false,
        alreadyLinked: true,
      };
    }
    if (input.programId) {
      const existing = await repo.findEnrollmentState(task.trainingEnrollmentId);
      if (existing && existing.programId === input.programId) {
        return {
          taskId,
          enrollmentId: task.trainingEnrollmentId,
          created: false,
          alreadyLinked: true,
        };
      }
    }
    throw AppError.conflict(
      'TASK_ALREADY_LINKED',
      'This task is already linked to different training. Unlinking would orphan that progress.',
    );
  }

  let enrollmentId: string;
  let created = false;

  if (input.enrollmentId) {
    const enrollment = await repo.findEnrollmentState(input.enrollmentId);
    if (!enrollment) {
      throw AppError.badRequest('ENROLLMENT_NOT_FOUND', 'That enrollment could not be found.');
    }
    /*
      The enrollment must belong to the person being onboarded. Without this check a
      task could be linked to a colleague's training and the onboarding would
      complete when *they* finished.
    */
    if (enrollment.employeeId !== employeeId) {
      throw AppError.badRequest(
        'ENROLLMENT_WRONG_EMPLOYEE',
        'That enrollment belongs to a different employee.',
      );
    }
    enrollmentId = enrollment.id;
  } else {
    const programId = input.programId as string;
    const policy = await repo.findProgramPolicy(programId);
    if (!policy) {
      throw AppError.badRequest('PROGRAM_NOT_FOUND', 'That program could not be found.');
    }
    if (policy.status !== 'ACTIVE') {
      throw AppError.badRequest(
        'PROGRAM_NOT_ASSIGNABLE',
        'Only a published program can be assigned.',
      );
    }

    // Reuse before create — the duplicate guard for a retried request.
    const live = await repo.findLiveEnrollment(employeeId, programId);
    if (live) {
      enrollmentId = live.id;
    } else {
      const now = await databaseNow();
      const dueOn =
        policy.dueWithinDays === null
          ? null
          : new Date(now.getTime() + policy.dueWithinDays * 86_400_000);

      try {
        const row = await prisma.$transaction(
          (tx) =>
            repo.createEnrollment(tx, {
              employeeId,
              programId,
              status: 'NOT_STARTED',
              obligation: 'MANDATORY',
              assignedById: actor.id,
              // Stamped so the record says why this person is enrolled.
              assignedVia: 'ONBOARDING',
              dueOn,
            }),
          TX_OPTIONS,
        );
        enrollmentId = row.id;
        created = true;
      } catch (error) {
        // A concurrent link created it first. Reuse rather than fail: the outcome
        // the caller wanted has happened.
        if (isUniqueViolation(error)) {
          const raced = await repo.findLiveEnrollment(employeeId, programId);
          if (!raced) throw error;
          enrollmentId = raced.id;
        } else {
          throw error;
        }
      }
    }
  }

  await prisma.$transaction(
    (tx) => repo.linkOnboardingTask(tx, { id: taskId, trainingEnrollmentId: enrollmentId }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_ONBOARDING_LINKED',
    entityType: 'OnboardingTask',
    entityId: taskId,
    actorId: actor.id,
    newValue: { enrollmentId, createdEnrollment: created },
  });

  if (created) {
    const userId = await repo.findUserIdForEmployee(employeeId);
    if (userId) await notifications.notifyTrainingAssigned(userId, enrollmentId, true);
  }

  return { taskId, enrollmentId, created, alreadyLinked: false };
}

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

/**
 * The training landing figures.
 *
 * Every count is scoped to what the reader may see, so a manager's dashboard counts
 * their reports and an HR reader's counts everybody. Grouped queries rather than one
 * per tile — eleven separate counts would be eleven round trips on every page load.
 */
export async function overview(
  actor: HrActor,
  scope: TrainingScope,
): Promise<TrainingOverview> {
  const learnerFilter = visibleLearnerFilter(scope) as Prisma.TrainingEnrollmentWhereInput;
  const now = await databaseNow();
  const todayKey = companyDayKey(now);
  const monthStart = new Date(`${todayKey.slice(0, 7)}-01T00:00:00.000Z`);

  const [
    activePrograms,
    byStatus,
    overdue,
    completedThisMonth,
    pendingPracticals,
    pendingShadowings,
    attemptsByStatus,
    mandatoryIncomplete,
  ] = await Promise.all([
    prisma.trainingProgram.count({ where: { status: 'ACTIVE' } }),
    prisma.trainingEnrollment.groupBy({
      by: ['status'],
      where: learnerFilter,
      _count: { _all: true },
    }),
    prisma.trainingEnrollment.count({
      where: {
        ...learnerFilter,
        status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
        dueOn: { lt: new Date(`${todayKey}T00:00:00.000Z`) },
      },
    }),
    prisma.trainingEnrollment.count({
      where: { ...learnerFilter, status: 'COMPLETED', completedAt: { gte: monthStart } },
    }),
    prisma.practicalSubmission.count({
      where: { enrollment: learnerFilter, status: 'SUBMITTED' },
    }),
    prisma.shadowingRecord.count({
      where: { enrollment: learnerFilter, signedOffAt: null, status: { not: 'CANCELLED' } },
    }),
    prisma.trainingAttempt.groupBy({
      by: ['status'],
      where: { enrollment: learnerFilter },
      _count: { _all: true },
    }),
    prisma.trainingEnrollment.count({
      where: {
        ...learnerFilter,
        obligation: 'MANDATORY',
        status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
      },
    }),
  ]);

  const statusCount = (status: string): number =>
    byStatus.find((r) => r.status === status)?._count._all ?? 0;
  const attemptCount = (status: string): number =>
    attemptsByStatus.find((r) => r.status === status)?._count._all ?? 0;

  /*
    "Awaiting qualification" needs the gate, which is per-enrollment — so it is
    counted as completed enrollments with no live qualification rather than by
    re-running the gate for everybody. A completed enrollment has by definition
    satisfied every required module; what may still be missing is somebody's decision
    to grant.
  */
  const awaitingQualification = await prisma.trainingEnrollment.count({
    where: {
      ...learnerFilter,
      status: 'COMPLETED',
      OR: [{ qualification: null }, { qualification: { revokedAt: { not: null } } }],
    },
  });

  return {
    activePrograms,
    liveEnrollments: statusCount('NOT_STARTED') + statusCount('IN_PROGRESS'),
    inProgress: statusCount('IN_PROGRESS'),
    overdue,
    completedThisMonth,
    awaitingQualification,
    pendingPracticalReviews: pendingPracticals,
    pendingShadowingSignOffs: pendingShadowings,
    passedAttempts: attemptCount('PASSED'),
    failedAttempts: attemptCount('FAILED') + attemptCount('EXPIRED'),
    mandatoryIncomplete,
  };
}
