/**
 * The route table for HR Phase 4 — Training & Learning Management.
 *
 * Every route carries a `requirePermission` or `requireAnyPermission`. `requireAuth`
 * is applied by the parent HR router. **No new permission vocabulary is introduced**:
 * HR_TRAINING and the five actions all come from the existing vocabulary, and USER
 * holds nothing on the namespace by default.
 *
 * ### How the actions divide
 *
 *   VIEW     the catalogue, anybody's progress, anybody's results, the dashboard
 *   CREATE   raising a program or a category
 *   EDIT     amending a program, its modules, its assessments and questions
 *   ASSIGN   putting other people into training, and setting due dates
 *   APPROVE  publishing, archiving, excusing, and granting live-work qualification
 *
 * ASSIGN is separate from CREATE because a bulk department assignment can put several
 * hundred people into a course with a deadline — a scheduling decision about other
 * people's time, not an authoring one. APPROVE is separate again because clearing
 * somebody for live customer work is not the same as writing the course they took.
 *
 * ### The learner routes, and why they look permissive
 *
 * `/enrollments/:id/modules/:moduleId/complete`, `/attempts`, `/attempts/:id/submit`
 * and `/practicals` are reachable with **HR_EMPLOYEE:VIEW** — a grant every employee
 * who can see the directory already holds.
 *
 * That is deliberate and is the only workable shape: every employee is a learner, so
 * requiring HR_TRAINING would mean granting the training module to the entire company
 * and the grant would stop meaning anything.
 *
 * The narrowing happens in the service, where it has the row: `mayActAsLearner`
 * permits **only the learner themselves** — not their manager, not an administrator
 * holding every grant in the system. A route table cannot express "is this your own
 * enrollment", so it states the floor and the service decides.
 *
 * ### What has no route, deliberately
 *
 * **No endpoint that accepts a score, a pass flag or a qualification claim.** Not
 * filtered — absent. The shared schemas have no such fields, so a request carrying
 * them is rejected at the boundary.
 *
 * **No DELETE on a program, an enrollment, an attempt or a qualification.** A
 * completed course, a failed attempt and a revoked clearance are all records of what
 * happened. Programs archive; enrollments are cancelled with a reason; a
 * qualification is revoked rather than erased. An endpoint that deleted them would
 * make the training history optional, and this is precisely the history somebody
 * appeals against.
 *
 * **No bulk answer-key export.** The authoring view returns one assessment's key to
 * an editor; there is no route that would hand over every answer in the catalogue.
 *
 * Literal paths are declared before any parameterised one throughout.
 */

import { Router } from 'express';
import {
  archiveTrainingProgramSchema,
  assignTrainingSchema,
  cancelEnrollmentSchema,
  completeModuleSchema,
  createTrainingAssessmentSchema,
  createTrainingCategorySchema,
  createTrainingModuleSchema,
  createTrainingProgramSchema,
  createTrainingQuestionSchema,
  enrollmentModuleParamSchema,
  exemptEnrollmentSchema,
  grantQualificationSchema,
  linkOnboardingTaskToTrainingSchema,
  onboardingTaskTrainingParamSchema,
  practicalListQuerySchema,
  practicalParamSchema,
  qualificationListQuerySchema,
  qualificationParamSchema,
  reorderTrainingModulesSchema,
  reviewPracticalSchema,
  revokeQualificationSchema,
  scheduleShadowingSchema,
  shadowingListQuerySchema,
  shadowingParamSchema,
  signOffShadowingSchema,
  submitPracticalSchema,
  submitTrainingAttemptSchema,
  trainingAssessmentParamSchema,
  trainingAttemptListQuerySchema,
  trainingAttemptParamSchema,
  trainingCategoryListQuerySchema,
  trainingCategoryParamSchema,
  trainingEnrollmentListQuerySchema,
  trainingEnrollmentParamSchema,
  trainingModuleParamSchema,
  trainingProgramListQuerySchema,
  trainingProgramParamSchema,
  trainingQuestionParamSchema,
  updateEnrollmentDueDateSchema,
  updateTrainingAssessmentSchema,
  updateTrainingCategorySchema,
  updateTrainingModuleSchema,
  updateTrainingProgramSchema,
} from '@rs/shared';
import { z } from 'zod';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './training.controller.js';

export const trainingRoutes = Router();

/**
 * The floor for a learner acting on their own records.
 *
 * HR_EMPLOYEE:VIEW is what every employee who can see the directory holds. The
 * service then refuses anybody but the learner — see the file note.
 */
const LEARNER_FLOOR = [
  ['HR_TRAINING', 'VIEW'],
  ['HR_EMPLOYEE', 'VIEW'],
] as const;

/** Starting an attempt names its assessment in the body. */
const startAttemptSchema = z.object({
  assessmentId: z.string().cuid('Not a valid identifier'),
});

const assignReviewerSchema = z.object({
  reviewerId: z.string().cuid('Not a valid identifier'),
});

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

/**
 * The dashboard.
 *
 * Either namespace: the counts span the catalogue and the learner population, and a
 * manager with no training grant still needs their team's figures. Every count is
 * scoped in the service.
 */
trainingRoutes.get(
  '/training/overview',
  requireAnyPermission(...LEARNER_FLOOR),
  controller.overview,
);

// ---------------------------------------------------------------------------
//  Categories
// ---------------------------------------------------------------------------

/* The catalogue's groupings. Readable by anybody who can reach the catalogue. */
trainingRoutes.get(
  '/training/categories',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ query: trainingCategoryListQuerySchema }),
  controller.listCategories,
);

trainingRoutes.post(
  '/training/categories',
  requirePermission('HR_TRAINING', 'CREATE'),
  validate({ body: createTrainingCategorySchema }),
  controller.createCategory,
);

trainingRoutes.patch(
  '/training/categories/:id',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingCategoryParamSchema, body: updateTrainingCategorySchema }),
  controller.updateCategory,
);

// ---------------------------------------------------------------------------
//  Programs
// ---------------------------------------------------------------------------

/*
  The catalogue is readable by any employee who can reach HR at all. Knowing a
  "Customer psychology" course exists discloses nothing, and hiding it from learners
  would mean they could not see what they are being asked to do. Progress and results
  are scoped separately and strictly.
*/
trainingRoutes.get(
  '/training/programs',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ query: trainingProgramListQuerySchema }),
  controller.listPrograms,
);

trainingRoutes.post(
  '/training/programs',
  requirePermission('HR_TRAINING', 'CREATE'),
  validate({ body: createTrainingProgramSchema }),
  controller.createProgram,
);

trainingRoutes.get(
  '/training/programs/:id',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: trainingProgramParamSchema }),
  controller.getProgram,
);

trainingRoutes.patch(
  '/training/programs/:id',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingProgramParamSchema, body: updateTrainingProgramSchema }),
  controller.updateProgram,
);

/*
  Publishing and archiving — APPROVE, because each commits something. Publishing
  makes a program assignable to real people with real deadlines; archiving ends its
  availability. Neither is an amendment to a course description.
*/
trainingRoutes.post(
  '/training/programs/:id/publish',
  requirePermission('HR_TRAINING', 'APPROVE'),
  validate({ params: trainingProgramParamSchema }),
  controller.publishProgram,
);

trainingRoutes.post(
  '/training/programs/:id/archive',
  requirePermission('HR_TRAINING', 'APPROVE'),
  validate({ params: trainingProgramParamSchema, body: archiveTrainingProgramSchema }),
  controller.archiveProgram,
);

// ---------------------------------------------------------------------------
//  Modules
// ---------------------------------------------------------------------------

trainingRoutes.post(
  '/training/programs/:id/modules',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingProgramParamSchema, body: createTrainingModuleSchema }),
  controller.addModule,
);

/* Declared before `/training/modules/:id` so it is never read as an id. */
trainingRoutes.post(
  '/training/programs/:id/modules/reorder',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingProgramParamSchema, body: reorderTrainingModulesSchema }),
  controller.reorderModules,
);

trainingRoutes.patch(
  '/training/modules/:id',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingModuleParamSchema, body: updateTrainingModuleSchema }),
  controller.updateModule,
);

trainingRoutes.delete(
  '/training/modules/:id',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingModuleParamSchema }),
  controller.removeModule,
);

// ---------------------------------------------------------------------------
//  Assessments and questions
// ---------------------------------------------------------------------------

trainingRoutes.post(
  '/training/assessments',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ body: createTrainingAssessmentSchema }),
  controller.createAssessment,
);

/**
 * The authoring view — **the only route that returns the answer key**.
 *
 * EDIT, not VIEW, and re-checked in the service. Two checks because this is precisely
 * the response a learner must never receive: a route-only check would be one new
 * handler away from being bypassed.
 */
trainingRoutes.get(
  '/training/assessments/:id/author',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingAssessmentParamSchema }),
  controller.getAssessmentForAuthor,
);

trainingRoutes.patch(
  '/training/assessments/:id',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingAssessmentParamSchema, body: updateTrainingAssessmentSchema }),
  controller.updateAssessment,
);

trainingRoutes.post(
  '/training/assessments/:id/questions',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingAssessmentParamSchema, body: createTrainingQuestionSchema }),
  controller.addQuestion,
);

trainingRoutes.delete(
  '/training/questions/:id',
  requirePermission('HR_TRAINING', 'EDIT'),
  validate({ params: trainingQuestionParamSchema }),
  controller.removeQuestion,
);

// ---------------------------------------------------------------------------
//  Assignment and enrollment
// ---------------------------------------------------------------------------

/*
  ASSIGN, because this puts other people into training with deadlines. A department
  assignment expands its membership once, here, and stamps each enrollment — so an
  employee who later moves team keeps what they were asked to do.
*/
trainingRoutes.post(
  '/training/assignments',
  requirePermission('HR_TRAINING', 'ASSIGN'),
  validate({ body: assignTrainingSchema }),
  controller.assignTraining,
);

/*
  The enrollment list. Reachable on the learner floor and scoped in the service: a
  learner sees their own, a manager their reports', a training reader everybody's.
*/
trainingRoutes.get(
  '/training/enrollments',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ query: trainingEnrollmentListQuerySchema }),
  controller.listEnrollments,
);

trainingRoutes.get(
  '/training/enrollments/:id',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: trainingEnrollmentParamSchema }),
  controller.getEnrollment,
);

trainingRoutes.post(
  '/training/enrollments/:id/exempt',
  requirePermission('HR_TRAINING', 'APPROVE'),
  validate({ params: trainingEnrollmentParamSchema, body: exemptEnrollmentSchema }),
  controller.exemptEnrollment,
);

trainingRoutes.post(
  '/training/enrollments/:id/cancel',
  requirePermission('HR_TRAINING', 'ASSIGN'),
  validate({ params: trainingEnrollmentParamSchema, body: cancelEnrollmentSchema }),
  controller.cancelEnrollment,
);

trainingRoutes.patch(
  '/training/enrollments/:id/due-date',
  requirePermission('HR_TRAINING', 'ASSIGN'),
  validate({ params: trainingEnrollmentParamSchema, body: updateEnrollmentDueDateSchema }),
  controller.updateEnrollmentDueDate,
);

// ---------------------------------------------------------------------------
//  The learner's own work
// ---------------------------------------------------------------------------

/**
 * Marking a lesson done.
 *
 * On the learner floor, and the service refuses anybody but the learner — including
 * an administrator holding every grant. It also refuses a module that is not a
 * LESSON, which is what stops somebody self-certifying their own practical by
 * calling this endpoint on it.
 */
trainingRoutes.post(
  '/training/enrollments/:id/modules/:moduleId/complete',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: enrollmentModuleParamSchema, body: completeModuleSchema }),
  controller.completeModule,
);

/**
 * Starting an attempt — returns the paper, with no answer key.
 *
 * Only the learner, enforced in the service. The paper is built from the select that
 * omits `isCorrect`, so there is no code path from here to the key.
 */
trainingRoutes.post(
  '/training/enrollments/:id/attempts',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: trainingEnrollmentParamSchema, body: startAttemptSchema }),
  controller.startAttempt,
);

/**
 * Submitting an attempt.
 *
 * The body carries selected option ids and nothing else — no score, no pass flag.
 * Grading happens server-side against the options' own correctness, and the
 * threshold comes from the program or the assessment.
 */
trainingRoutes.post(
  '/training/attempts/:id/submit',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: trainingAttemptParamSchema, body: submitTrainingAttemptSchema }),
  controller.submitAttempt,
);

/* Reading an attempt. The learner's own always; others by scope. */
trainingRoutes.get(
  '/training/attempts',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ query: trainingAttemptListQuerySchema }),
  controller.listAttempts,
);

trainingRoutes.get(
  '/training/attempts/:id',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: trainingAttemptParamSchema }),
  controller.getAttempt,
);

// ---------------------------------------------------------------------------
//  Practical exercises
// ---------------------------------------------------------------------------

/* Submitting. The learner only, enforced in the service. */
trainingRoutes.post(
  '/training/enrollments/:id/modules/:moduleId/practical',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: enrollmentModuleParamSchema, body: submitPracticalSchema }),
  controller.submitPractical,
);

/*
  The review queue. On the learner floor because a reviewer usually holds no training
  grant — being assigned is a fact about rows. Scoped in the service.
*/
trainingRoutes.get(
  '/training/practicals',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ query: practicalListQuerySchema }),
  controller.listPracticals,
);

/**
 * Reviewing a practical.
 *
 * On the learner floor, because the assigned reviewer is frequently an ordinary
 * colleague. The service refuses **the learner themselves first**, before any
 * permission check — an independent review is the entire value of this gate, and
 * there is no grant that lets somebody approve their own work.
 */
trainingRoutes.post(
  '/training/practicals/:id/review',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: practicalParamSchema, body: reviewPracticalSchema }),
  controller.reviewPractical,
);

trainingRoutes.patch(
  '/training/practicals/:id/reviewer',
  requireAnyPermission(['HR_TRAINING', 'ASSIGN'], ['HR_TRAINING', 'EDIT']),
  validate({ params: practicalParamSchema, body: assignReviewerSchema }),
  controller.assignPracticalReviewer,
);

// ---------------------------------------------------------------------------
//  Shadowing
// ---------------------------------------------------------------------------

trainingRoutes.post(
  '/training/enrollments/:id/modules/:moduleId/shadowing',
  requireAnyPermission(['HR_TRAINING', 'ASSIGN'], ['HR_TRAINING', 'EDIT']),
  validate({ params: enrollmentModuleParamSchema, body: scheduleShadowingSchema }),
  controller.scheduleShadowing,
);

trainingRoutes.get(
  '/training/shadowings',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ query: shadowingListQuerySchema }),
  controller.listShadowings,
);

/* Signing off. Same shape as the practical review: never the learner. */
trainingRoutes.post(
  '/training/shadowings/:id/sign-off',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: shadowingParamSchema, body: signOffShadowingSchema }),
  controller.signOffShadowing,
);

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

/* The gaps — what still stands between a learner and live work. Computed server-side. */
trainingRoutes.get(
  '/training/enrollments/:id/qualification-gaps',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ params: trainingEnrollmentParamSchema }),
  controller.getQualificationGaps,
);

/**
 * Granting live-work qualification.
 *
 * APPROVE, and the service refuses a self-grant whatever else the actor holds.
 * Eligibility is recomputed immediately before the write from the program's
 * requirement flags against actual progress — there is no field in the body that
 * could claim it.
 */
trainingRoutes.post(
  '/training/enrollments/:id/qualify',
  requirePermission('HR_TRAINING', 'APPROVE'),
  validate({ params: trainingEnrollmentParamSchema, body: grantQualificationSchema }),
  controller.grantQualification,
);

trainingRoutes.get(
  '/training/qualifications',
  requireAnyPermission(...LEARNER_FLOOR),
  validate({ query: qualificationListQuerySchema }),
  controller.listQualifications,
);

trainingRoutes.post(
  '/training/qualifications/:id/revoke',
  requirePermission('HR_TRAINING', 'APPROVE'),
  validate({ params: qualificationParamSchema, body: revokeQualificationSchema }),
  controller.revokeQualification,
);

// ---------------------------------------------------------------------------
//  Onboarding integration
// ---------------------------------------------------------------------------

/**
 * Linking an onboarding task to real training.
 *
 * Either namespace: an HR coordinator running onboarding holds HR_RECRUITMENT, and a
 * training administrator holds HR_TRAINING:ASSIGN. Both legitimately do this, so
 * requiring one would block the other.
 *
 * Idempotent: a retry on the same target returns success, and naming a program reuses
 * a live enrollment rather than creating a second.
 */
trainingRoutes.post(
  '/training/onboarding-tasks/:id/link',
  requireAnyPermission(['HR_TRAINING', 'ASSIGN'], ['HR_RECRUITMENT', 'EDIT']),
  validate({
    params: onboardingTaskTrainingParamSchema,
    body: linkOnboardingTaskToTrainingSchema,
  }),
  controller.linkOnboardingTask,
);
