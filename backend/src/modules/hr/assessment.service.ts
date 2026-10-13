/**
 * Assessments, progress, practical review, shadowing and qualification.
 *
 * The security-critical half of training. Four properties this file exists to hold,
 * and each is enforced here rather than in a route table or a component:
 *
 * ### 1. The answer key never reaches the learner before submission
 *
 * `startAttempt` builds the paper from `listPaperQuestions`, which omits
 * `isCorrect`. The grader uses `listGradableQuestions`, which reads it — inside the
 * submission transaction, mapped straight to a result and never serialised. Two
 * repository constants rather than one with a flag, because a boolean deciding
 * whether to include the key is one wrong argument from leaking it.
 *
 * ### 2. The score is computed here, never accepted
 *
 * `submitAttempt` takes only which options the learner selected. There is no field
 * for a score, a percentage or a pass flag — a client-supplied score would be a
 * client-supplied clearance to do live customer work.
 *
 * ### 3. Only the learner sits their own test
 *
 * `mayActAsLearner` has no override. Not their manager, not an administrator holding
 * every grant in the system: somebody else sitting a test on your behalf makes the
 * result a fiction, and the record would then say you passed something you never
 * took.
 *
 * ### 4. Nobody signs off their own practical or shadowing
 *
 * Checked before any permission, because an independent review is the entire value
 * of those gates. A self-approval is not a review.
 */

import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  type CompleteModuleInput,
  type EnrollmentModuleView,
  type GrantQualificationInput,
  type PracticalSubmissionView,
  type QualificationGap,
  type QuestionPaperView,
  type ReviewPracticalInput,
  type ScheduleShadowingInput,
  type ShadowingRecordView,
  type SubmitPracticalInput,
  type SubmitTrainingAttemptInput,
  type TrainingAttemptSummary,
  type TrainingAttemptView,
  type TrainingEnrollmentView,
  type TrainingProgramSummary,
  type TrainingQualificationView,
} from '@rs/shared';
import { databaseNow, prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { recordAudit } from '../../services/audit.service.js';
import type { HrActor } from './hr-access.js';
import {
  type TrainingScope,
  mayActAsLearner,
  mayGrantQualification,
  mayReviewPractical,
  mayRevokeQualification,
  maySignOffShadowing,
  mayViewAttemptDetail,
  mayViewLearner,
} from './training-access.js';
import {
  type GateableModule,
  effectiveMaxAttempts,
  effectiveThreshold,
  gateModules,
  gradeAttempt,
  hasExpired,
  isModuleSatisfied,
  qualificationGaps,
  retakeDecision,
} from './training.calc.js';
import * as notifications from './training.notify.js';
import * as repo from './training.repository.js';
import {
  TX_OPTIONS,
  companyDayKey,
  isUniqueViolation,
  loadVisibleEnrollment,
  notFound,
  presentEnrollmentRow,
  toEmployeeRef,
} from './training.service.js';

const iso = (v: Date | null): string | null => (v === null ? null : v.toISOString());
const dayKey = (v: Date | null): string | null =>
  v === null ? null : v.toISOString().slice(0, 10);
const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

// ---------------------------------------------------------------------------
//  Assembling a learner's state
// ---------------------------------------------------------------------------

/**
 * Everything needed to gate one enrollment, read once.
 *
 * Assembled in a handful of reads rather than per module, and shared by the detail
 * view, the gate and the qualification check — so all three see the same state. Three
 * separate assemblies would be three chances to disagree about whether somebody is
 * eligible.
 */
async function assembleGateState(
  enrollmentId: string,
  programId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<{
  modules: GateableModule[];
  moduleRows: repo.ModuleRecord[];
  progress: Map<string, { startedAt: Date | null; completedAt: Date | null }>;
  practicals: repo.PracticalRecord[];
  shadowings: repo.ShadowingRecord[];
  attemptsByAssessment: Map<
    string,
    { id: string; attemptNumber: number; status: string; percentage: Prisma.Decimal | null }[]
  >;
  finalAssessmentId: string | null;
  finalPassed: boolean;
}> {
  const [moduleRows, progressRows, practicals, shadowings, attempts, final] = await Promise.all([
    repo.listProgramModules(programId, tx),
    repo.findModuleProgress(enrollmentId, tx),
    repo.listEnrollmentPracticals(enrollmentId, tx),
    repo.listEnrollmentShadowings(enrollmentId, tx),
    repo.listEnrollmentAttempts(enrollmentId, tx),
    repo.findProgramFinalAssessment(programId, tx),
  ]);

  const progress = new Map(
    progressRows.map((p) => [p.moduleId, { startedAt: p.startedAt, completedAt: p.completedAt }]),
  );

  const attemptsByAssessment = new Map<
    string,
    { id: string; attemptNumber: number; status: string; percentage: Prisma.Decimal | null }[]
  >();
  for (const a of attempts) {
    const list = attemptsByAssessment.get(a.assessmentId) ?? [];
    list.push({
      id: a.id,
      attemptNumber: a.attemptNumber,
      status: a.status,
      percentage: a.percentage,
    });
    attemptsByAssessment.set(a.assessmentId, list);
  }

  const practicalByModule = new Map(practicals.map((p) => [p.moduleId, p]));
  const shadowingByModule = new Map(shadowings.map((s) => [s.moduleId, s]));

  const modules: GateableModule[] = moduleRows.map((m) => {
    const assessmentId = m.assessment?.id ?? null;
    const moduleAttempts = assessmentId
      ? (attemptsByAssessment.get(assessmentId) ?? [])
      : [];

    return {
      moduleId: m.id,
      title: m.title,
      kind: m.kind,
      sortOrder: m.sortOrder,
      isRequired: m.isRequired,
      isCompleted: progress.get(m.id)?.completedAt != null,
      hasAssessment: assessmentId !== null,
      // Passed, not merely sat. This is the rule that makes a failure block.
      hasPassedAssessment: moduleAttempts.some((a) => a.status === 'PASSED'),
      practicalApproved: practicalByModule.get(m.id)?.status === 'APPROVED',
      shadowingSignedOff: shadowingByModule.get(m.id)?.signedOffAt != null,
    };
  });

  const finalPassed =
    final !== null &&
    (attemptsByAssessment.get(final.id) ?? []).some((a) => a.status === 'PASSED');

  return {
    modules,
    moduleRows,
    progress,
    practicals,
    shadowings,
    attemptsByAssessment,
    finalAssessmentId: final?.id ?? null,
    finalPassed,
  };
}

/**
 * One enrollment in full, as the learner or a permitted reader sees it.
 *
 * `isUnlocked` and `qualificationGaps` are both computed here from the assembled
 * state — the frontend reads them rather than deciding, because the backend is the
 * only authority on whether somebody may proceed or do live work.
 */
export async function getEnrollment(
  actor: HrActor,
  scope: TrainingScope,
  id: string,
): Promise<TrainingEnrollmentView> {
  const state = await loadVisibleEnrollment(id, scope);

  const row = await repo.findEnrollment(id);
  if (!row) throw notFound();

  const policy = await repo.findProgramPolicy(state.programId);
  if (!policy) throw notFound();

  const gate = await assembleGateState(id, state.programId);
  const gated = new Map(gateModules(gate.modules).map((g) => [g.moduleId, g]));

  const qualification = await repo.findQualificationByEnrollment(id);
  const gaps = qualificationGaps({
    modules: gate.modules,
    requiresPractical: policy.requiresPractical,
    requiresShadowing: policy.requiresShadowing,
    requiresFinalAssessment: policy.requiresFinalAssessment,
    finalAssessmentPassed: gate.finalPassed,
    hasFinalAssessment: gate.finalAssessmentId !== null,
    alreadyQualified: qualification !== null && qualification.revokedAt === null,
  });

  const practicalByModule = new Map(gate.practicals.map((p) => [p.moduleId, p]));
  const shadowingByModule = new Map(gate.shadowings.map((s) => [s.moduleId, s]));

  const modules: EnrollmentModuleView[] = await Promise.all(
    gate.moduleRows.map(async (m) => {
      const assessmentId = m.assessment?.id ?? null;
      const progress = gate.progress.get(m.id);
      const g = gated.get(m.id);

      let assessment: EnrollmentModuleView['assessment'] = null;
      if (assessmentId !== null) {
        const row = await repo.findAssessment(assessmentId);
        const attempts = gate.attemptsByAssessment.get(assessmentId) ?? [];
        const settled = attempts.filter((a) => a.status !== 'IN_PROGRESS');
        const open = attempts.find((a) => a.status === 'IN_PROGRESS');
        const threshold = effectiveThreshold(row?.passingScore ?? null, policy.passingScore);
        const max = effectiveMaxAttempts(row?.maxAttempts ?? null, policy.maxAttempts);
        const best = settled
          .map((a) => a.percentage)
          .filter((p): p is Prisma.Decimal => p !== null)
          .sort((a, b) => b.comparedTo(a))[0];

        assessment = {
          id: assessmentId,
          title: row?.title ?? '',
          passingScore: threshold.toString(),
          maxAttempts: max,
          attemptsUsed: settled.length,
          attemptsRemaining: Math.max(0, max - settled.length),
          bestPercentage: best ? best.toString() : null,
          hasPassed: attempts.some((a) => a.status === 'PASSED'),
          openAttemptId: open?.id ?? null,
        };
      }

      const practical = practicalByModule.get(m.id);
      const shadowing = shadowingByModule.get(m.id);

      return {
        moduleId: m.id,
        title: m.title,
        kind: m.kind,
        sortOrder: m.sortOrder,
        isRequired: m.isRequired,
        instructions: m.instructions,
        content: m.content,
        referenceUrl: m.referenceUrl,
        secureDocumentId: m.secureDocumentId,
        estimatedMinutes: m.estimatedMinutes,
        startedAt: iso(progress?.startedAt ?? null),
        completedAt: iso(progress?.completedAt ?? null),
        isCompleted: isModuleSatisfied(
          gate.modules.find((gm) => gm.moduleId === m.id) as GateableModule,
        ),
        isUnlocked: g?.isUnlocked ?? false,
        lockedReason: g?.lockedReason ?? null,
        assessment,
        practicalId: practical?.id ?? null,
        practicalStatus: practical?.status ?? null,
        shadowingId: shadowing?.id ?? null,
        shadowingStatus: shadowing?.status ?? null,
      };
    }),
  );

  const now = await databaseNow();
  const requiredCount = gate.modules.filter((m) => m.isRequired).length;
  const completedCount = gate.modules.filter((m) => m.isRequired && isModuleSatisfied(m)).length;

  const summary = presentEnrollmentRow(row, {
    todayKey: companyDayKey(now),
    completedModules: completedCount,
    requiredModules: requiredCount,
  });

  const full = await prisma.trainingEnrollment.findUnique({
    where: { id },
    select: {
      exemptedAt: true,
      exemptionReason: true,
      cancelledAt: true,
      cancellationReason: true,
      createdAt: true,
      updatedAt: true,
      assignedBy: { select: { id: true, name: true } },
      exemptedBy: { select: { id: true, name: true } },
    },
  });

  const qualificationView = qualification
    ? await getQualification(qualification.id)
    : null;

  return {
    ...summary,
    // The full program rather than the summary's reference — the learner's page
    // needs the pass mark and the requirement flags.
    program: await programSummary(state.programId),
    assignedBy: full?.assignedBy ?? { id: '', name: '' },
    exemptedBy: full?.exemptedBy ?? null,
    exemptedAt: iso(full?.exemptedAt ?? null),
    exemptionReason: full?.exemptionReason ?? null,
    cancelledAt: iso(full?.cancelledAt ?? null),
    cancellationReason: full?.cancellationReason ?? null,
    modules,
    attempts: (await repo.listEnrollmentAttempts(id)).map((a) =>
      presentAttemptSummary(a, policy.passingScore),
    ),
    practicals: gate.practicals.map(presentPractical),
    shadowings: gate.shadowings.map(presentShadowing),
    qualification: qualificationView,
    qualificationGaps: gaps,
    createdAt: full?.createdAt.toISOString() ?? '',
    updatedAt: full?.updatedAt.toISOString() ?? '',
  };
}

/** The program as the enrollment view embeds it. */
async function programSummary(programId: string): Promise<TrainingProgramSummary> {
  const row = await repo.findProgram(programId);
  if (!row) throw notFound();
  const counts = await repo.countEnrollmentsByProgram([programId]);
  const c = counts.get(programId) ?? { live: 0, completed: 0 };
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    category: row.category,
    status: row.status,
    obligation: row.obligation,
    targetDepartment: row.targetDepartment,
    targetDesignation: row.targetDesignation,
    estimatedMinutes: row.estimatedMinutes,
    passingScore: row.passingScore.toString(),
    maxAttempts: row.maxAttempts,
    moduleCount: row._count.modules,
    enrolledCount: c.live,
    completedCount: c.completed,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentAttemptSummary(
  row: repo.AttemptRowRecord,
  programPassingScore: Prisma.Decimal,
): TrainingAttemptSummary {
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
      programPassingScore,
    ).toString(),
  };
}

function presentPractical(row: repo.PracticalRecord): PracticalSubmissionView {
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

function presentShadowing(row: repo.ShadowingRecord): ShadowingRecordView {
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
//  Module progress
// ---------------------------------------------------------------------------

/**
 * Marking a lesson complete.
 *
 * Three refusals, each load-bearing:
 *
 *   1. Only the learner. `mayActAsLearner` has no override.
 *   2. Only a LESSON. An ASSESSMENT completes by passing, a PRACTICAL by approval, a
 *      SHADOWING by sign-off — so without this check a learner could self-certify
 *      their own practical by calling the lesson endpoint on it.
 *   3. Only an unlocked module. A learner who failed the knowledge test cannot mark
 *      department training done and walk past the gate.
 */
export async function completeModule(
  req: Request,
  actor: HrActor,
  enrollmentId: string,
  moduleId: string,
  input: CompleteModuleInput,
): Promise<TrainingEnrollmentView> {
  const enrollment = await repo.findEnrollmentState(enrollmentId);
  if (!enrollment) throw notFound();

  if (!mayActAsLearner(actor, enrollment)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Only the learner can record their own progress.',
    );
  }

  if (enrollment.status === 'EXEMPTED' || enrollment.status === 'CANCELLED') {
    throw AppError.badRequest(
      'ENROLLMENT_NOT_LIVE',
      'This training is no longer active for you.',
    );
  }

  const module = await repo.findModule(moduleId);
  if (!module || module.programId !== enrollment.programId) throw notFound();

  if (module.kind !== 'LESSON') {
    throw AppError.badRequest(
      'MODULE_NOT_A_LESSON',
      module.kind === 'ASSESSMENT'
        ? 'This step is completed by passing its test.'
        : module.kind === 'PRACTICAL'
          ? 'This step is completed when your submission is approved.'
          : 'This step is completed when your mentor signs it off.',
    );
  }

  const gate = await assembleGateState(enrollmentId, enrollment.programId);
  const gated = gateModules(gate.modules).find((g) => g.moduleId === moduleId);
  if (gated && !gated.isUnlocked) {
    throw AppError.badRequest(
      'MODULE_LOCKED',
      gated.lockedReason ?? 'An earlier step has to be completed first.',
    );
  }

  await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);

    await repo.upsertModuleProgress(tx, {
      enrollmentId,
      moduleId,
      create: {
        startedAt: now,
        completedAt: now,
        timeSpentMinutes: input.timeSpentMinutes ?? null,
      },
      update: {
        completedAt: now,
        ...(input.timeSpentMinutes === undefined
          ? {}
          : { timeSpentMinutes: input.timeSpentMinutes }),
      },
    });

    // First activity moves the enrollment off NOT_STARTED. Conditional so a
    // concurrent module completion cannot overwrite an earlier `startedAt`.
    if (enrollment.status === 'NOT_STARTED') {
      await repo.transitionEnrollment(tx, {
        id: enrollmentId,
        fromStatuses: ['NOT_STARTED'],
        data: { status: 'IN_PROGRESS', startedAt: now },
      });
    }
  }, TX_OPTIONS);

  await maybeCompleteEnrollment(req, actor, enrollmentId, enrollment.programId);

  return getEnrollment(actor, { kind: 'all' }, enrollmentId);
}

/**
 * Completes the enrollment when every required module is satisfied.
 *
 * Called after anything that could satisfy the last gate — a lesson, a passed
 * attempt, an approval, a sign-off. Conditional on the enrollment still being live,
 * so two concurrent completions cannot both stamp `completedAt`.
 *
 * **Completion is not qualification.** Finishing the modules makes somebody eligible;
 * clearing them for live work is a separate decision by a separate person with
 * APPROVE. That split is the whole reason `TrainingQualification` is its own record.
 */
async function maybeCompleteEnrollment(
  req: Request,
  actor: HrActor,
  enrollmentId: string,
  programId: string,
): Promise<void> {
  const gate = await assembleGateState(enrollmentId, programId);
  const outstanding = gate.modules.filter((m) => m.isRequired && !isModuleSatisfied(m));
  if (outstanding.length > 0) return;

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.transitionEnrollment(tx, {
      id: enrollmentId,
      fromStatuses: ['NOT_STARTED', 'IN_PROGRESS'],
      data: { status: 'COMPLETED', completedAt: now },
    });
  }, TX_OPTIONS);

  if (changed === 0) return;

  await recordAudit(req, {
    action: 'HR_TRAINING_ENROLLMENT_COMPLETED',
    entityType: 'TrainingEnrollment',
    entityId: enrollmentId,
    actorId: actor.id,
  });

  /*
    Onboarding integration. A linked task follows the training it stands for — but
    only an unsettled one, so a task somebody deliberately skipped keeps its own
    history. The task's identity, ordering and notes are untouched.
  */
  const tasks = await repo.findTasksForEnrollment(enrollmentId);
  for (const task of tasks) {
    await prisma.$transaction(async (tx) => {
      const now = await databaseNow(tx);
      await repo.settleLinkedTask(tx, { id: task.id, completedById: actor.id, now });
    }, TX_OPTIONS);
  }
}

// ---------------------------------------------------------------------------
//  Attempts
// ---------------------------------------------------------------------------

/**
 * Starting an attempt, and issuing the paper.
 *
 * The paper comes from `listPaperQuestions` — **no `isCorrect`, no explanation**.
 * That omission is the control which keeps the answer key off the wire.
 *
 * `attemptNumber` is computed inside the transaction and the
 * (enrollment, assessment, attemptNumber) unique is what makes the limit real: two
 * simultaneous starts compute the same next number and only one insert survives. A
 * service-level count alone would let both through.
 */
export async function startAttempt(
  req: Request,
  actor: HrActor,
  enrollmentId: string,
  assessmentId: string,
): Promise<QuestionPaperView> {
  const enrollment = await repo.findEnrollmentState(enrollmentId);
  if (!enrollment) throw notFound();

  // No override: only the learner sits their own test.
  if (!mayActAsLearner(actor, enrollment)) {
    throw new AppError('FORBIDDEN', 403, 'Only the learner can sit their own assessment.');
  }

  if (enrollment.status === 'EXEMPTED' || enrollment.status === 'CANCELLED') {
    throw AppError.badRequest('ENROLLMENT_NOT_LIVE', 'This training is no longer active for you.');
  }

  const assessment = await repo.findAssessment(assessmentId);
  if (!assessment || assessment.programId !== enrollment.programId) throw notFound();
  if (!assessment.isActive) {
    throw AppError.badRequest('ASSESSMENT_INACTIVE', 'That assessment is not currently open.');
  }

  const policy = await repo.findProgramPolicy(enrollment.programId);
  if (!policy) throw notFound();

  // The module gate: an assessment behind an unsatisfied earlier step is unreachable.
  if (assessment.moduleId) {
    const gate = await assembleGateState(enrollmentId, enrollment.programId);
    const gated = gateModules(gate.modules).find((g) => g.moduleId === assessment.moduleId);
    if (gated && !gated.isUnlocked) {
      throw AppError.badRequest(
        'MODULE_LOCKED',
        gated.lockedReason ?? 'An earlier step has to be completed first.',
      );
    }
  }

  const paperQuestions = await repo.listPaperQuestions(assessmentId);
  if (paperQuestions.length === 0) {
    /*
      A paperless test must not be sittable: the grader would compute 0/0 and the
      calculator fails it, which would look like the learner's fault.
    */
    throw AppError.badRequest(
      'ASSESSMENT_EMPTY',
      'That assessment has no questions yet — ask your trainer.',
    );
  }

  const existing = await repo.listAttemptsFor(enrollmentId, assessmentId);
  const settled = existing.filter((a) => a.status !== 'IN_PROGRESS');
  const open = existing.find((a) => a.status === 'IN_PROGRESS');

  const threshold = effectiveThreshold(assessment.passingScore, policy.passingScore);
  const max = effectiveMaxAttempts(assessment.maxAttempts, policy.maxAttempts);

  /*
    An open attempt is resumed rather than replaced, unless it has lapsed. Replacing
    it would let a learner restart a timed paper indefinitely; refusing outright
    would strand anybody whose browser crashed.
  */
  if (open) {
    const now = await databaseNow();
    const openRow = await repo.findAttempt(open.id);

    if (openRow && !hasExpired(openRow.expiresAt, now)) {
      // Still live: hand back the same paper rather than issuing a new one.
      return buildPaper(
        openRow.id,
        assessment,
        openRow.attemptNumber,
        openRow.startedAt,
        openRow.expiresAt,
        threshold,
        paperQuestions,
      );
    }

    // Lapsed. Settled as EXPIRED so it consumes its slot — otherwise walking away
    // from a timed paper would be a free retry — then fall through to a new attempt.
    if (openRow) {
      await prisma.$transaction(
        (tx) => repo.settleAttempt(tx, { id: openRow.id, data: { status: 'EXPIRED' } }),
        TX_OPTIONS,
      );
    }
  }

  const decision = retakeDecision({
    used: settled.length,
    max,
    hasPassed: existing.some((a) => a.status === 'PASSED'),
    hasOpenAttempt: false,
  });
  if (!decision.canRetake) {
    throw AppError.conflict('NO_ATTEMPTS_REMAINING', decision.reason ?? 'No attempts remain.');
  }

  const created = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    // Recomputed inside the transaction, so the unique index arbitrates a race.
    const all = await repo.listAttemptsFor(enrollmentId, assessmentId, tx);
    const nextNumber = all.length + 1;

    const expiresAt =
      assessment.timeLimitMinutes === null
        ? null
        : new Date(now.getTime() + assessment.timeLimitMinutes * 60_000);

    return repo.createAttempt(tx, {
      enrollmentId,
      assessmentId,
      attemptNumber: nextNumber,
      status: 'IN_PROGRESS',
      startedAt: now,
      expiresAt,
    });
  }, TX_OPTIONS).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'ATTEMPT_RACE',
        'Another attempt was just started. Reload and continue it.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'HR_TRAINING_ATTEMPT_STARTED',
    entityType: 'TrainingAttempt',
    entityId: created.id,
    actorId: actor.id,
    // No score, obviously — and no question list either.
    newValue: { assessmentId, attemptNumber: created.attemptNumber },
  });

  return buildPaper(
    created.id,
    assessment,
    created.attemptNumber,
    created.startedAt,
    created.expiresAt,
    threshold,
    paperQuestions,
  );
}

/** The paper, assembled from the key-free select. */
function buildPaper(
  attemptId: string,
  assessment: repo.AssessmentRecord,
  attemptNumber: number,
  startedAt: Date,
  expiresAt: Date | null,
  threshold: Prisma.Decimal,
  questions: repo.PaperQuestionRecord[],
): QuestionPaperView {
  const totalPoints = questions.reduce(
    (sum, q) => sum.plus(q.points),
    new Prisma.Decimal(0),
  );

  return {
    attemptId,
    assessmentId: assessment.id,
    title: assessment.title,
    instructions: assessment.instructions,
    attemptNumber,
    passingScore: threshold.toString(),
    totalPoints: totalPoints.toDecimalPlaces(2).toString(),
    startedAt: startedAt.toISOString(),
    expiresAt: iso(expiresAt),
    questions: questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      points: q.points.toString(),
      sortOrder: q.sortOrder,
      options: q.options.map((o) => ({ id: o.id, label: o.label, sortOrder: o.sortOrder })),
    })),
  };
}

/**
 * Submitting an attempt.
 *
 * ### Everything about the result is computed here
 *
 * The input carries only selected option ids. The grader reads `isCorrect` from the
 * options, sums the points, computes the percentage in Decimal and compares it with
 * the **effective threshold** — the assessment's own or the program's. No part of
 * that comes from the client.
 *
 * ### Option ownership is validated before grading
 *
 * An option id belonging to another question, or another assessment, is rejected
 * outright rather than ignored. Silently dropping it would let a learner probe the
 * structure of other papers by watching which ids are accepted.
 *
 * ### The write is conditional on IN_PROGRESS
 *
 * Two concurrent submissions both grade, but only one writes — and the loser is told
 * rather than overwriting a result. Without it, the second could replace a pass with
 * a fail.
 */
export async function submitAttempt(
  req: Request,
  actor: HrActor,
  attemptId: string,
  input: SubmitTrainingAttemptInput,
): Promise<TrainingAttemptView> {
  const attempt = await repo.findAttemptState(attemptId);
  if (!attempt) throw notFound();

  if (!mayActAsLearner(actor, { employeeId: attempt.enrollment.employeeId })) {
    throw new AppError('FORBIDDEN', 403, 'Only the learner can submit their own attempt.');
  }

  if (attempt.status !== 'IN_PROGRESS') {
    throw AppError.conflict(
      'ATTEMPT_ALREADY_SETTLED',
      'This attempt has already been submitted.',
    );
  }

  const assessment = await repo.findAssessment(attempt.assessmentId);
  if (!assessment) throw notFound();
  const policy = await repo.findProgramPolicy(attempt.enrollment.programId);
  if (!policy) throw notFound();

  const now = await databaseNow();
  if (hasExpired(attempt.expiresAt, now)) {
    /*
      Out of time. Settled as EXPIRED so it consumes its attempt slot — otherwise
      abandoning a paper would be a free retry — and the learner is told plainly.
    */
    await prisma.$transaction(
      (tx) => repo.settleAttempt(tx, { id: attemptId, data: { status: 'EXPIRED' } }),
      TX_OPTIONS,
    );
    throw AppError.conflict(
      'ATTEMPT_EXPIRED',
      'The time limit for this attempt has passed. It counts as an attempt used.',
    );
  }

  const gradable = await repo.listGradableQuestions(attempt.assessmentId);

  // Ownership validation, before any grading.
  const questionIds = new Set(gradable.map((q) => q.id));
  const optionOwner = new Map<string, string>();
  for (const q of gradable) for (const o of q.options) optionOwner.set(o.id, q.id);

  for (const answer of input.answers) {
    if (!questionIds.has(answer.questionId)) {
      throw AppError.badRequest(
        'QUESTION_NOT_IN_ASSESSMENT',
        'An answer refers to a question that is not on this paper.',
      );
    }
    for (const optionId of answer.selectedOptionIds) {
      if (optionOwner.get(optionId) !== answer.questionId) {
        throw AppError.badRequest(
          'OPTION_NOT_IN_QUESTION',
          'An answer refers to an option that does not belong to its question.',
        );
      }
    }
  }

  const threshold = effectiveThreshold(assessment.passingScore, policy.passingScore);
  const graded = gradeAttempt(
    gradable.map((q) => ({
      id: q.id,
      kind: q.kind,
      points: q.points,
      options: q.options,
    })),
    input.answers,
    threshold,
  );

  const changed = await prisma.$transaction(async (tx) => {
    const submittedAt = await databaseNow(tx);

    const count = await repo.settleAttempt(tx, {
      id: attemptId,
      data: {
        status: graded.passed ? 'PASSED' : 'FAILED',
        submittedAt,
        score: graded.score,
        maxScore: graded.maxScore,
        percentage: graded.percentage,
        passed: graded.passed,
      },
    });

    if (count > 0) {
      await repo.createAnswers(
        tx,
        graded.answers.map((a) => ({
          attemptId,
          questionId: a.questionId,
          isCorrect: a.isCorrect,
          pointsAwarded: a.pointsAwarded,
          selectedOptionIds: a.selectedOptionIds,
        })),
      );

      /*
        A passed assessment completes its module. A failed one does NOT — which is
        the rule that leaves the next stage locked, and the reason this is inside the
        `passed` branch rather than unconditional.
      */
      if (graded.passed && assessment.moduleId) {
        await repo.upsertModuleProgress(tx, {
          enrollmentId: attempt.enrollmentId,
          moduleId: assessment.moduleId,
          create: { startedAt: submittedAt, completedAt: submittedAt },
          update: { completedAt: submittedAt },
        });
      }
    }

    return count;
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'ATTEMPT_ALREADY_SETTLED',
      'This attempt was submitted by another request.',
    );
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_ATTEMPT_SUBMITTED',
    entityType: 'TrainingAttempt',
    entityId: attemptId,
    actorId: actor.id,
    /*
      The outcome and the threshold it was judged against — enough to defend the
      decision later. Deliberately not the answers: a list of somebody's wrong
      answers in the audit table would be readable by a wider population than the
      learner's own manager.
    */
    newValue: {
      passed: graded.passed,
      percentage: graded.percentage.toString(),
      threshold: threshold.toString(),
      attemptNumber: attempt.attemptNumber,
    },
  });

  if (graded.passed) {
    await maybeCompleteEnrollment(req, actor, attempt.enrollmentId, attempt.enrollment.programId);
  }

  return getAttempt(actor, { kind: 'all' }, attemptId);
}

/**
 * One attempt, with review.
 *
 * `questions` is populated **only for a settled attempt** — an in-progress one
 * returns an empty array, because the review shape carries the answer key and an
 * in-progress attempt is exactly when the learner must not have it.
 */
export async function getAttempt(
  actor: HrActor,
  scope: TrainingScope,
  id: string,
): Promise<TrainingAttemptView> {
  const state = await repo.findAttemptState(id);
  if (!state) throw notFound();

  const permitted = mayViewAttemptDetail(scope, {
    employeeId: state.enrollment.employeeId,
    managerId: state.enrollment.employee.managerId,
  });
  // The learner always sees their own, whatever the scope says.
  const isOwn = actor.employeeId !== null && actor.employeeId === state.enrollment.employeeId;
  if (!permitted && !isOwn) throw notFound();

  const row = await repo.findAttempt(id);
  if (!row) throw notFound();

  const policy = await repo.findProgramPolicy(state.enrollment.programId);
  if (!policy) throw notFound();

  const enrollment = await repo.findEnrollment(state.enrollmentId);
  if (!enrollment) throw notFound();

  const summary = presentAttemptSummary(row, policy.passingScore);

  let questions: TrainingAttemptView['questions'] = [];
  if (row.status !== 'IN_PROGRESS') {
    const reviewQuestions = await repo.listReviewQuestions(state.assessmentId);
    const answers = await repo.listAttemptAnswers(id);
    const byQuestion = new Map(answers.map((a) => [a.questionId, a]));

    questions = reviewQuestions.map((q) => {
      const answer = byQuestion.get(q.id);
      const selected = new Set((answer?.selectedOptions ?? []).map((s) => s.optionId));
      return {
        id: q.id,
        kind: q.kind,
        prompt: q.prompt,
        points: q.points.toString(),
        pointsAwarded: (answer?.pointsAwarded ?? new Prisma.Decimal(0)).toString(),
        isCorrect: answer?.isCorrect ?? false,
        explanation: q.explanation,
        options: q.options.map((o) => ({
          id: o.id,
          label: o.label,
          sortOrder: o.sortOrder,
          isCorrect: o.isCorrect,
          wasSelected: selected.has(o.id),
        })),
      };
    });
  }

  const all = await repo.listAttemptsFor(state.enrollmentId, state.assessmentId);
  const assessment = await repo.findAssessment(state.assessmentId);
  const decision = retakeDecision({
    used: all.filter((a) => a.status !== 'IN_PROGRESS').length,
    max: effectiveMaxAttempts(assessment?.maxAttempts ?? null, policy.maxAttempts),
    hasPassed: all.some((a) => a.status === 'PASSED'),
    hasOpenAttempt: all.some((a) => a.status === 'IN_PROGRESS'),
  });

  return {
    ...summary,
    employee: toEmployeeRef(enrollment.employee),
    enrollmentId: state.enrollmentId,
    expiresAt: iso(row.expiresAt),
    questions,
    canRetake: decision.canRetake,
    retakeBlockedReason: decision.reason,
  };
}

// ---------------------------------------------------------------------------
//  Practical exercises
// ---------------------------------------------------------------------------

export async function submitPractical(
  req: Request,
  actor: HrActor,
  enrollmentId: string,
  moduleId: string,
  input: SubmitPracticalInput,
): Promise<PracticalSubmissionView> {
  const enrollment = await repo.findEnrollmentState(enrollmentId);
  if (!enrollment) throw notFound();

  if (!mayActAsLearner(actor, enrollment)) {
    throw new AppError('FORBIDDEN', 403, 'Only the learner can submit their own practical.');
  }

  const module = await repo.findModule(moduleId);
  if (!module || module.programId !== enrollment.programId) throw notFound();
  if (module.kind !== 'PRACTICAL') {
    throw AppError.badRequest('MODULE_NOT_PRACTICAL', 'That step is not a practical exercise.');
  }

  const gate = await assembleGateState(enrollmentId, enrollment.programId);
  const gated = gateModules(gate.modules).find((g) => g.moduleId === moduleId);
  if (gated && !gated.isUnlocked) {
    throw AppError.badRequest(
      'MODULE_LOCKED',
      gated.lockedReason ?? 'An earlier step has to be completed first.',
    );
  }

  const existing = gate.practicals.find((p) => p.moduleId === moduleId);
  if (existing?.status === 'APPROVED') {
    throw AppError.conflict(
      'PRACTICAL_ALREADY_APPROVED',
      'This practical has already been approved.',
    );
  }

  const row = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.upsertPractical(tx, {
      enrollmentId,
      moduleId,
      create: {
        status: 'SUBMITTED',
        submissionNotes: input.submissionNotes,
        secureDocumentId: input.secureDocumentId ?? null,
        submittedAt: now,
      },
      update: {
        status: 'SUBMITTED',
        submissionNotes: input.submissionNotes,
        secureDocumentId: input.secureDocumentId ?? null,
        submittedAt: now,
        // A resubmission clears the previous decision: the CHECK pairs the review
        // fields with the status, and a SUBMITTED row must carry none of them.
        reviewedAt: null,
        reviewedById: null,
        reviewNotes: null,
      },
    });
  }, TX_OPTIONS);

  await recordAudit(req, {
    action: 'HR_TRAINING_PRACTICAL_SUBMITTED',
    entityType: 'PracticalSubmission',
    entityId: row.id,
    actorId: actor.id,
    newValue: { enrollmentId, moduleId },
  });

  if (row.reviewerId) {
    const userId = await repo.findUserIdForEmployee(row.reviewerId);
    if (userId) await notifications.notifyPracticalReviewDue(userId, row.id);
  }

  return presentPractical(row);
}

/**
 * Reviewing a practical.
 *
 * `mayReviewPractical` refuses the learner **first**, before any permission check.
 * An independent review is the entire value of this gate, and a self-approval is not
 * a review — so there is no grant, including every grant in the system, that lets
 * somebody approve their own work.
 */
export async function reviewPractical(
  req: Request,
  actor: HrActor,
  id: string,
  input: ReviewPracticalInput,
): Promise<PracticalSubmissionView> {
  const row = await repo.findPractical(id);
  if (!row) throw notFound();

  const permitted = mayReviewPractical(actor, {
    learnerEmployeeId: row.enrollment.employeeId,
    reviewerId: row.reviewerId,
  });
  if (!permitted) {
    throw new AppError(
      'FORBIDDEN',
      403,
      actor.employeeId === row.enrollment.employeeId
        ? 'Nobody reviews their own practical exercise.'
        : 'Only the assigned reviewer or an HR trainer can review this.',
    );
  }

  if (actor.employeeId === null) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'A review has to name its reviewer. Link your account to your employee record first.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.reviewPractical(tx, {
      id,
      data: {
        status: input.decision,
        reviewedAt: now,
        reviewedById: actor.employeeId,
        reviewNotes: input.reviewNotes ?? null,
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'PRACTICAL_NOT_SUBMITTED',
      'This practical is not awaiting a review.',
    );
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_PRACTICAL_REVIEWED',
    entityType: 'PracticalSubmission',
    entityId: id,
    actorId: actor.id,
    newValue: { decision: input.decision },
  });

  if (input.decision === 'APPROVED') {
    const enrollment = await repo.findEnrollmentState(row.enrollmentId);
    if (enrollment) {
      // The approval satisfies the module, so it may have been the last gate.
      await prisma.$transaction(async (tx) => {
        const now = await databaseNow(tx);
        await repo.upsertModuleProgress(tx, {
          enrollmentId: row.enrollmentId,
          moduleId: row.moduleId,
          create: { startedAt: now, completedAt: now },
          update: { completedAt: now },
        });
      }, TX_OPTIONS);
      await maybeCompleteEnrollment(req, actor, row.enrollmentId, enrollment.programId);
    }
  }

  const updated = await repo.findPractical(id);
  if (!updated) throw notFound();
  return presentPractical(updated);
}

export async function assignPracticalReviewer(
  req: Request,
  actor: HrActor,
  id: string,
  reviewerId: string,
): Promise<PracticalSubmissionView> {
  const row = await repo.findPractical(id);
  if (!row) throw notFound();

  if (!actor.can('HR_TRAINING', 'ASSIGN') && !actor.can('HR_TRAINING', 'EDIT')) {
    throw new AppError('FORBIDDEN', 403, 'Assigning a reviewer needs HR_TRAINING:ASSIGN.');
  }

  /*
    The learner cannot be their own reviewer, refused here as well as at review time.
    Catching it at assignment is kinder: the alternative is a reviewer who discovers
    they cannot act only when they try.
  */
  if (reviewerId === row.enrollment.employeeId) {
    throw AppError.badRequest(
      'REVIEWER_IS_LEARNER',
      'The learner cannot review their own practical exercise.',
    );
  }

  const reviewer = await repo.findEmployeeForTraining(reviewerId);
  if (!reviewer) {
    throw AppError.badRequest('REVIEWER_NOT_FOUND', 'That reviewer could not be found.');
  }
  if (reviewer.status === 'EXITED') {
    throw AppError.badRequest(
      'REVIEWER_NOT_EMPLOYED',
      'That person has left, so they cannot be assigned as reviewer.',
    );
  }

  const updated = await prisma.$transaction(
    (tx) => repo.updatePractical(tx, id, { reviewerId }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_PRACTICAL_REVIEWER_ASSIGNED',
    entityType: 'PracticalSubmission',
    entityId: id,
    actorId: actor.id,
    newValue: { reviewerId },
  });

  if (updated.status === 'SUBMITTED') {
    const userId = await repo.findUserIdForEmployee(reviewerId);
    if (userId) await notifications.notifyPracticalReviewDue(userId, id);
  }

  return presentPractical(updated);
}

// ---------------------------------------------------------------------------
//  Shadowing
// ---------------------------------------------------------------------------

export async function scheduleShadowing(
  req: Request,
  actor: HrActor,
  enrollmentId: string,
  moduleId: string,
  input: ScheduleShadowingInput,
): Promise<ShadowingRecordView> {
  if (!actor.can('HR_TRAINING', 'ASSIGN') && !actor.can('HR_TRAINING', 'EDIT')) {
    throw new AppError('FORBIDDEN', 403, 'Scheduling shadowing needs HR_TRAINING:ASSIGN.');
  }

  const enrollment = await repo.findEnrollmentState(enrollmentId);
  if (!enrollment) throw notFound();

  const module = await repo.findModule(moduleId);
  if (!module || module.programId !== enrollment.programId) throw notFound();
  if (module.kind !== 'SHADOWING') {
    throw AppError.badRequest('MODULE_NOT_SHADOWING', 'That step is not a shadowing period.');
  }

  if (input.mentorId) {
    if (input.mentorId === enrollment.employeeId) {
      throw AppError.badRequest(
        'MENTOR_IS_LEARNER',
        'Somebody cannot shadow themselves.',
      );
    }
    const mentor = await repo.findEmployeeForTraining(input.mentorId);
    if (!mentor) throw AppError.badRequest('MENTOR_NOT_FOUND', 'That mentor could not be found.');
    if (mentor.status === 'EXITED') {
      throw AppError.badRequest(
        'MENTOR_NOT_EMPLOYED',
        'That person has left, so they cannot mentor.',
      );
    }
  }

  const row = await prisma.$transaction(
    (tx) =>
      repo.upsertShadowing(tx, {
        enrollmentId,
        moduleId,
        create: {
          status: 'SCHEDULED',
          mentorId: input.mentorId ?? null,
          scheduledFrom: input.scheduledFrom ?? null,
          scheduledTo: input.scheduledTo ?? null,
          checklist: input.checklist ?? null,
        },
        update: {
          mentorId: input.mentorId ?? null,
          scheduledFrom: input.scheduledFrom ?? null,
          scheduledTo: input.scheduledTo ?? null,
          ...(input.checklist === undefined ? {} : { checklist: input.checklist }),
        },
      }),
    TX_OPTIONS,
  );

  await recordAudit(req, {
    action: 'HR_TRAINING_SHADOWING_SCHEDULED',
    entityType: 'ShadowingRecord',
    entityId: row.id,
    actorId: actor.id,
    newValue: { enrollmentId, moduleId, mentorId: input.mentorId ?? null },
  });

  if (input.mentorId) {
    const userId = await repo.findUserIdForEmployee(input.mentorId);
    if (userId) await notifications.notifyShadowingSignOffDue(userId, row.id);
  }

  return presentShadowing(row);
}

/**
 * Signing off a shadowing period.
 *
 * `maySignOffShadowing` refuses the learner first, for the same reason as the
 * practical: a sign-off they gave themselves is not an independent observation.
 */
export async function signOffShadowing(
  req: Request,
  actor: HrActor,
  id: string,
  feedback: string,
): Promise<ShadowingRecordView> {
  const row = await repo.findShadowing(id);
  if (!row) throw notFound();

  const permitted = maySignOffShadowing(actor, {
    learnerEmployeeId: row.enrollment.employeeId,
    mentorId: row.mentorId,
  });
  if (!permitted) {
    throw new AppError(
      'FORBIDDEN',
      403,
      actor.employeeId === row.enrollment.employeeId
        ? 'Nobody signs off their own shadowing.'
        : 'Only the assigned mentor or an HR trainer can sign this off.',
    );
  }

  if (actor.employeeId === null) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'A sign-off has to name who gave it. Link your account to your employee record first.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.signOffShadowing(tx, {
      id,
      data: {
        status: 'COMPLETED',
        feedback,
        signedOffAt: now,
        signedOffById: actor.employeeId,
      },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'SHADOWING_ALREADY_SIGNED_OFF',
      'This shadowing period has already been signed off.',
    );
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_SHADOWING_SIGNED_OFF',
    entityType: 'ShadowingRecord',
    entityId: id,
    actorId: actor.id,
  });

  const enrollment = await repo.findEnrollmentState(row.enrollmentId);
  if (enrollment) {
    await prisma.$transaction(async (tx) => {
      const now = await databaseNow(tx);
      await repo.upsertModuleProgress(tx, {
        enrollmentId: row.enrollmentId,
        moduleId: row.moduleId,
        create: { startedAt: now, completedAt: now },
        update: { completedAt: now },
      });
    }, TX_OPTIONS);
    await maybeCompleteEnrollment(req, actor, row.enrollmentId, enrollment.programId);
  }

  const updated = await repo.findShadowing(id);
  if (!updated) throw notFound();
  return presentShadowing(updated);
}

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

/**
 * Granting live-work qualification.
 *
 * ### Eligibility is recomputed here, immediately before the write
 *
 * Not read from a cached flag, not taken from the request. `qualificationGaps` runs
 * against freshly assembled state inside the same operation — the gap between "we
 * checked" and "we granted" is exactly where a stale read would clear somebody
 * wrongly.
 *
 * ### Never the learner
 *
 * `mayGrantQualification` refuses a self-grant whatever else the actor holds.
 * Declaring yourself ready for live customer work is the clearest case of deciding
 * your own action.
 *
 * ### This does not touch employment
 *
 * No `Employee.status`, no probation, no EmployeeHistory. Training qualification is
 * a separate business state, which is why it is its own record.
 */
export async function grantQualification(
  req: Request,
  actor: HrActor,
  enrollmentId: string,
  input: GrantQualificationInput,
): Promise<TrainingQualificationView> {
  const enrollment = await repo.findEnrollmentState(enrollmentId);
  if (!enrollment) throw notFound();

  if (!mayGrantQualification(actor, enrollment)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      actor.employeeId === enrollment.employeeId
        ? 'Nobody grants their own live-work qualification.'
        : 'Granting qualification needs HR_TRAINING:APPROVE.',
    );
  }

  const policy = await repo.findProgramPolicy(enrollment.programId);
  if (!policy) throw notFound();

  const gate = await assembleGateState(enrollmentId, enrollment.programId);
  const existing = await repo.findQualificationByEnrollment(enrollmentId);

  const gaps = qualificationGaps({
    modules: gate.modules,
    requiresPractical: policy.requiresPractical,
    requiresShadowing: policy.requiresShadowing,
    requiresFinalAssessment: policy.requiresFinalAssessment,
    finalAssessmentPassed: gate.finalPassed,
    hasFinalAssessment: gate.finalAssessmentId !== null,
    alreadyQualified: existing !== null && existing.revokedAt === null,
  });

  if (gaps.length > 0) {
    throw AppError.badRequest(
      'QUALIFICATION_NOT_ELIGIBLE',
      // Every gap, not just the first: a reviewer wants the whole list.
      `Not eligible yet — ${gaps.map((g) => g.detail).join(' ')}`,
    );
  }

  // The final score, where a final assessment was required.
  let finalScore: Prisma.Decimal | null = null;
  if (gate.finalAssessmentId) {
    const attempts = gate.attemptsByAssessment.get(gate.finalAssessmentId) ?? [];
    const passed = attempts.filter((a) => a.status === 'PASSED');
    finalScore =
      passed
        .map((a) => a.percentage)
        .filter((p): p is Prisma.Decimal => p !== null)
        .sort((a, b) => b.comparedTo(a))[0] ?? null;
  }

  const id = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);

    let certificateCode: string | null = null;
    if (input.issueCertificate === true) {
      const year = now.getUTCFullYear();
      const next = await repo.allocateTrainingCode(tx, `CERT-${year}`);
      certificateCode = `CERT-${year}-${String(next).padStart(5, '0')}`;
    }

    const created = await repo.createQualification(tx, {
      enrollmentId,
      qualifiedAt: now,
      grantedById: actor.id,
      finalScore,
      notes: input.notes ?? null,
      certificateCode,
      certificateIssuedAt: certificateCode === null ? null : now,
    });
    return created.id;
  }, TX_OPTIONS).catch((error: unknown) => {
    // The unique enrollmentId caught a concurrent grant.
    if (isUniqueViolation(error)) {
      throw AppError.conflict(
        'ALREADY_QUALIFIED',
        'This learner was qualified by another request.',
      );
    }
    throw error;
  });

  await recordAudit(req, {
    action: 'HR_TRAINING_QUALIFICATION_GRANTED',
    entityType: 'TrainingQualification',
    entityId: id,
    actorId: actor.id,
    newValue: {
      enrollmentId,
      programId: enrollment.programId,
      finalScore: finalScore ? finalScore.toString() : null,
    },
  });

  const recipients: string[] = [];
  const learnerUserId = await repo.findUserIdForEmployee(enrollment.employeeId);
  if (learnerUserId) recipients.push(learnerUserId);
  if (enrollment.employee.managerId) {
    const managerUserId = await repo.findUserIdForEmployee(enrollment.employee.managerId);
    if (managerUserId) recipients.push(managerUserId);
  }
  await notifications.notifyQualified(recipients, id);

  return getQualification(id);
}

export async function revokeQualification(
  req: Request,
  actor: HrActor,
  id: string,
  reason: string,
): Promise<TrainingQualificationView> {
  const row = await repo.findQualification(id);
  if (!row) throw notFound();

  const enrollment = await repo.findEnrollmentState(row.enrollmentId);
  if (!enrollment) throw notFound();

  if (!mayRevokeQualification(actor, enrollment)) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'Revoking qualification needs HR_TRAINING:APPROVE, and nobody revokes their own.',
    );
  }

  const changed = await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    return repo.revokeQualification(tx, {
      id,
      data: { revokedAt: now, revokedById: actor.id, revocationReason: reason },
    });
  }, TX_OPTIONS);

  if (changed === 0) {
    throw AppError.conflict(
      'ALREADY_REVOKED',
      'This qualification has already been revoked.',
    );
  }

  await recordAudit(req, {
    action: 'HR_TRAINING_QUALIFICATION_REVOKED',
    entityType: 'TrainingQualification',
    entityId: id,
    actorId: actor.id,
    newValue: { reason },
  });

  return getQualification(id);
}

export async function getQualification(id: string): Promise<TrainingQualificationView> {
  const row = await repo.findQualification(id);
  if (!row) throw notFound();

  return {
    id: row.id,
    enrollmentId: row.enrollmentId,
    employee: toEmployeeRef(row.enrollment.employee),
    program: row.enrollment.program,
    qualifiedAt: row.qualifiedAt.toISOString(),
    grantedBy: row.grantedBy,
    finalScore: dec(row.finalScore),
    notes: row.notes,
    certificateCode: row.certificateCode,
    certificateIssuedAt: iso(row.certificateIssuedAt),
    revokedBy: row.revokedBy,
    revokedAt: iso(row.revokedAt),
    revocationReason: row.revocationReason,
    isActive: row.revokedAt === null,
  };
}

/** The gaps for one enrollment, for the qualification screen. */
export async function getQualificationGaps(
  actor: HrActor,
  scope: TrainingScope,
  enrollmentId: string,
): Promise<QualificationGap[]> {
  const enrollment = await loadVisibleEnrollment(enrollmentId, scope);

  const policy = await repo.findProgramPolicy(enrollment.programId);
  if (!policy) throw notFound();

  const gate = await assembleGateState(enrollmentId, enrollment.programId);
  const existing = await repo.findQualificationByEnrollment(enrollmentId);

  return qualificationGaps({
    modules: gate.modules,
    requiresPractical: policy.requiresPractical,
    requiresShadowing: policy.requiresShadowing,
    requiresFinalAssessment: policy.requiresFinalAssessment,
    finalAssessmentPassed: gate.finalPassed,
    hasFinalAssessment: gate.finalAssessmentId !== null,
    alreadyQualified: existing !== null && existing.revokedAt === null,
  });
}
