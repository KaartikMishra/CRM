/**
 * HTTP translation for training, and nothing else.
 *
 * No business rule, no permission decision, no try/catch — the route table states
 * who may reach what, the services decide, and the async error handler reports
 * failures. Matching every other controller in this codebase.
 *
 * The one thing that is slightly more than translation: `context` resolves the actor
 * and their scope together, once per request. Both are needed by nearly every
 * handler, and resolving them per service call would mean several permission lookups
 * and a reports query per request instead of one each.
 *
 * ### What no handler here accepts
 *
 * No score, no percentage, no pass flag, no "qualified" field, no progress claim.
 * Those are not filtered out — the shared Zod schemas have no such fields, so a
 * request carrying them is rejected at the boundary before reaching a handler. That
 * is the whole reason the contracts were written to omit them rather than to ignore
 * them.
 */

import type { Request, Response } from 'express';
import type {
  AssignTrainingInput,
  CompleteModuleInput,
  CreateTrainingAssessmentInput,
  CreateTrainingCategoryInput,
  CreateTrainingModuleInput,
  CreateTrainingProgramInput,
  CreateTrainingQuestionInput,
  GrantQualificationInput,
  LinkOnboardingTaskToTrainingInput,
  PracticalListQuery,
  QualificationListQuery,
  ReorderTrainingModulesInput,
  ReviewPracticalInput,
  ScheduleShadowingInput,
  ShadowingListQuery,
  SignOffShadowingInput,
  SubmitPracticalInput,
  SubmitTrainingAttemptInput,
  TrainingAttemptListQuery,
  TrainingEnrollmentListQuery,
  TrainingProgramListQuery,
  UpdateEnrollmentDueDateInput,
  UpdateTrainingAssessmentInput,
  UpdateTrainingCategoryInput,
  UpdateTrainingModuleInput,
  UpdateTrainingProgramInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { hrActor } from './hr.service.js';
import type { HrActor } from './hr-access.js';
import type { TrainingScope } from './training-access.js';
import * as service from './training.service.js';
import * as assessments from './assessment.service.js';
import * as catalogue from './assessment-admin.service.js';

type IdParam = { id: string };
type ModuleParam = { id: string; moduleId: string };

/** The actor and their scope, resolved together once per request. */
async function context(req: Request): Promise<{ actor: HrActor; scope: TrainingScope }> {
  const actor = await hrActor(currentUser(req));
  const scope = await service.scopeForRequest(actor);
  return { actor, scope };
}

const actorOf = (req: Request): Promise<HrActor> => hrActor(currentUser(req));

// ---------------------------------------------------------------------------
//  Categories
// ---------------------------------------------------------------------------

export async function createCategory(req: Request, res: Response): Promise<void> {
  const category = await service.createCategory(
    req,
    await actorOf(req),
    validatedBody<CreateTrainingCategoryInput>(req),
  );
  sendCreated(res, { category });
}

export async function listCategories(req: Request, res: Response): Promise<void> {
  const { isActive } = validatedQuery<{ isActive?: boolean }>(req);
  sendSuccess(res, { categories: await service.listCategories(isActive) });
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const category = await service.updateCategory(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateTrainingCategoryInput>(req),
  );
  sendSuccess(res, { category });
}

// ---------------------------------------------------------------------------
//  Programs
// ---------------------------------------------------------------------------

export async function createProgram(req: Request, res: Response): Promise<void> {
  const program = await service.createProgram(
    req,
    await actorOf(req),
    validatedBody<CreateTrainingProgramInput>(req),
  );
  sendCreated(res, { program });
}

export async function listPrograms(req: Request, res: Response): Promise<void> {
  const result = await service.listPrograms(validatedQuery<TrainingProgramListQuery>(req));
  sendSuccess(res, result);
}

export async function getProgram(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { program: await service.getProgram(validatedParams<IdParam>(req).id) });
}

export async function updateProgram(req: Request, res: Response): Promise<void> {
  const program = await service.updateProgram(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateTrainingProgramInput>(req),
  );
  sendSuccess(res, { program });
}

export async function publishProgram(req: Request, res: Response): Promise<void> {
  const program = await service.publishProgram(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { program });
}

export async function archiveProgram(req: Request, res: Response): Promise<void> {
  const program = await service.archiveProgram(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<{ reason: string }>(req).reason,
  );
  sendSuccess(res, { program });
}

// ---------------------------------------------------------------------------
//  Modules
// ---------------------------------------------------------------------------

export async function addModule(req: Request, res: Response): Promise<void> {
  const module = await service.addModule(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CreateTrainingModuleInput>(req),
  );
  sendCreated(res, { module });
}

export async function updateModule(req: Request, res: Response): Promise<void> {
  const module = await service.updateModule(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateTrainingModuleInput>(req),
  );
  sendSuccess(res, { module });
}

export async function removeModule(req: Request, res: Response): Promise<void> {
  await service.removeModule(req, await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { removed: true });
}

export async function reorderModules(req: Request, res: Response): Promise<void> {
  const modules = await service.reorderModules(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<ReorderTrainingModulesInput>(req).moduleIds,
  );
  sendSuccess(res, { modules });
}

// ---------------------------------------------------------------------------
//  Assessments and questions
// ---------------------------------------------------------------------------

export async function createAssessment(req: Request, res: Response): Promise<void> {
  const assessment = await catalogue.createAssessment(
    req,
    await actorOf(req),
    validatedBody<CreateTrainingAssessmentInput>(req),
  );
  sendCreated(res, { assessment });
}

export async function updateAssessment(req: Request, res: Response): Promise<void> {
  const assessment = await catalogue.updateAssessment(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateTrainingAssessmentInput>(req),
  );
  sendSuccess(res, { assessment });
}

/**
 * The authoring view of an assessment, **with** the answer key.
 *
 * Gated on HR_TRAINING:EDIT in the route table and re-checked in the service. This
 * is the only endpoint that returns `isCorrect` outside a settled attempt's review,
 * and it exists because somebody has to be able to check what they authored.
 */
export async function getAssessmentForAuthor(req: Request, res: Response): Promise<void> {
  const assessment = await catalogue.getAssessmentForAuthor(
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { assessment });
}

export async function addQuestion(req: Request, res: Response): Promise<void> {
  const question = await catalogue.addQuestion(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CreateTrainingQuestionInput>(req),
  );
  sendCreated(res, { question });
}

export async function removeQuestion(req: Request, res: Response): Promise<void> {
  await catalogue.removeQuestion(req, await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { removed: true });
}

// ---------------------------------------------------------------------------
//  Assignment and enrollment
// ---------------------------------------------------------------------------

export async function assignTraining(req: Request, res: Response): Promise<void> {
  const result = await service.assignTraining(
    req,
    await actorOf(req),
    validatedBody<AssignTrainingInput>(req),
  );
  sendCreated(res, result);
}

export async function listEnrollments(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await service.listEnrollments(
    scope,
    validatedQuery<TrainingEnrollmentListQuery>(req),
  );
  sendSuccess(res, result);
}

export async function getEnrollment(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const enrollment = await assessments.getEnrollment(
    actor,
    scope,
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { enrollment });
}

export async function exemptEnrollment(req: Request, res: Response): Promise<void> {
  const enrollment = await service.exemptEnrollment(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<{ reason: string }>(req).reason,
  );
  sendSuccess(res, { enrollment });
}

export async function cancelEnrollment(req: Request, res: Response): Promise<void> {
  const enrollment = await service.cancelEnrollment(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<{ reason: string }>(req).reason,
  );
  sendSuccess(res, { enrollment });
}

export async function updateEnrollmentDueDate(req: Request, res: Response): Promise<void> {
  const body = validatedBody<UpdateEnrollmentDueDateInput>(req);
  const enrollment = await service.updateEnrollmentDueDate(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    body.dueOn,
    body.reason,
  );
  sendSuccess(res, { enrollment });
}

// ---------------------------------------------------------------------------
//  The learner's own work
// ---------------------------------------------------------------------------

export async function completeModule(req: Request, res: Response): Promise<void> {
  const params = validatedParams<ModuleParam>(req);
  const enrollment = await assessments.completeModule(
    req,
    await actorOf(req),
    params.id,
    params.moduleId,
    validatedBody<CompleteModuleInput>(req),
  );
  sendSuccess(res, { enrollment });
}

/**
 * Starting an attempt. Returns the paper — with no answer key.
 *
 * The `assessmentId` comes from the body rather than the path because an attempt is
 * created against an (enrollment, assessment) pair and the path already names the
 * enrollment.
 */
export async function startAttempt(req: Request, res: Response): Promise<void> {
  const paper = await assessments.startAttempt(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<{ assessmentId: string }>(req).assessmentId,
  );
  sendCreated(res, { paper });
}

export async function submitAttempt(req: Request, res: Response): Promise<void> {
  const attempt = await assessments.submitAttempt(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<SubmitTrainingAttemptInput>(req),
  );
  sendSuccess(res, { attempt });
}

export async function getAttempt(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const attempt = await assessments.getAttempt(actor, scope, validatedParams<IdParam>(req).id);
  sendSuccess(res, { attempt });
}

export async function listAttempts(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await catalogue.listAttempts(
    scope,
    validatedQuery<TrainingAttemptListQuery>(req),
  );
  sendSuccess(res, result);
}

// ---------------------------------------------------------------------------
//  Practical exercises
// ---------------------------------------------------------------------------

export async function submitPractical(req: Request, res: Response): Promise<void> {
  const params = validatedParams<ModuleParam>(req);
  const practical = await assessments.submitPractical(
    req,
    await actorOf(req),
    params.id,
    params.moduleId,
    validatedBody<SubmitPracticalInput>(req),
  );
  sendCreated(res, { practical });
}

export async function reviewPractical(req: Request, res: Response): Promise<void> {
  const practical = await assessments.reviewPractical(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<ReviewPracticalInput>(req),
  );
  sendSuccess(res, { practical });
}

export async function assignPracticalReviewer(req: Request, res: Response): Promise<void> {
  const practical = await assessments.assignPracticalReviewer(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<{ reviewerId: string }>(req).reviewerId,
  );
  sendSuccess(res, { practical });
}

export async function listPracticals(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await catalogue.listPracticals(scope, validatedQuery<PracticalListQuery>(req));
  sendSuccess(res, result);
}

// ---------------------------------------------------------------------------
//  Shadowing
// ---------------------------------------------------------------------------

export async function scheduleShadowing(req: Request, res: Response): Promise<void> {
  const params = validatedParams<ModuleParam>(req);
  const shadowing = await assessments.scheduleShadowing(
    req,
    await actorOf(req),
    params.id,
    params.moduleId,
    validatedBody<ScheduleShadowingInput>(req),
  );
  sendCreated(res, { shadowing });
}

export async function signOffShadowing(req: Request, res: Response): Promise<void> {
  const shadowing = await assessments.signOffShadowing(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<SignOffShadowingInput>(req).feedback,
  );
  sendSuccess(res, { shadowing });
}

export async function listShadowings(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await catalogue.listShadowings(scope, validatedQuery<ShadowingListQuery>(req));
  sendSuccess(res, result);
}

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

export async function grantQualification(req: Request, res: Response): Promise<void> {
  const qualification = await assessments.grantQualification(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<GrantQualificationInput>(req),
  );
  sendCreated(res, { qualification });
}

export async function revokeQualification(req: Request, res: Response): Promise<void> {
  const qualification = await assessments.revokeQualification(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<{ reason: string }>(req).reason,
  );
  sendSuccess(res, { qualification });
}

/** What still stands between a learner and live work. Computed server-side. */
export async function getQualificationGaps(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const gaps = await assessments.getQualificationGaps(
    actor,
    scope,
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { gaps });
}

export async function listQualifications(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await catalogue.listQualifications(
    scope,
    validatedQuery<QualificationListQuery>(req),
  );
  sendSuccess(res, result);
}

// ---------------------------------------------------------------------------
//  Onboarding integration
// ---------------------------------------------------------------------------

/**
 * Linking an onboarding task to real training.
 *
 * Phase 3 created a TRAINING task category with no course behind it, deliberately.
 * This is the explicit linking step: the task keeps its identity, ordering and
 * history, and training progress then drives its status.
 */
export async function linkOnboardingTask(req: Request, res: Response): Promise<void> {
  const result = await catalogue.linkOnboardingTask(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<LinkOnboardingTaskToTrainingInput>(req),
  );
  sendSuccess(res, result);
}

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

export async function overview(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  sendSuccess(res, { overview: await catalogue.overview(actor, scope) });
}
