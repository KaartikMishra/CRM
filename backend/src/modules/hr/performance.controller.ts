/**
 * HTTP translation for performance management, and nothing else.
 *
 * No business rule, no permission decision, no try/catch — the route table states
 * who may reach what, the services decide, and the async error handler reports
 * failures. Matching every other controller in this codebase.
 *
 * ### What no handler here accepts
 *
 * No attainment, no computed percentage, no `finalizedAt`, no `submittedAt`, no
 * status field on any create. Those are not filtered out by these handlers — the
 * shared Zod schemas have no such fields, so a request carrying one is rejected at
 * the boundary with 422 before a handler runs. That is the whole reason the
 * contracts were written to omit them rather than to ignore them.
 *
 * `finalRating` is the single exception, accepted only by `finalizeReview`, because
 * finalisation is the one act that sets the figure of record.
 */

import type { Request, Response } from 'express';
import type {
  CancelReviewInput,
  CloseDevelopmentPlanInput,
  CloseGoalInput,
  CompleteDevelopmentActionInput,
  CreateCompetencyInput,
  CreateDevelopmentActionInput,
  CreateDevelopmentPlanInput,
  CreateGoalInput,
  CreateKpiInput,
  CreateReviewCycleInput,
  DevelopmentPlanListQuery,
  FinalizeReviewInput,
  GenerateReviewsInput,
  GoalListQuery,
  PerformanceHistoryQuery,
  PerformanceReviewListQuery,
  RateCompetencyInput,
  RecordKpiProgressInput,
  ReviewCycleListQuery,
  SaveManagerAssessmentInput,
  SaveSelfAssessmentInput,
  UpdateCompetencyInput,
  UpdateDevelopmentPlanInput,
  UpdateGoalInput,
  UpdateKpiInput,
  UpdateReviewCycleInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { hrActor } from './hr.service.js';
import type { HrActor } from './hr-access.js';
import * as service from './performance.service.js';
import * as reviews from './performance-review.service.js';

type IdParam = { id: string };
type KpiParam = { id: string; kpiId: string };

const actorOf = (req: Request): Promise<HrActor> => hrActor(currentUser(req));

// ---------------------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------------------

export async function getOverview(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { overview: await reviews.getOverview(await actorOf(req)) });
}

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

export async function createCycle(req: Request, res: Response): Promise<void> {
  const cycle = await service.createCycle(
    req,
    await actorOf(req),
    validatedBody<CreateReviewCycleInput>(req),
  );
  sendCreated(res, { cycle });
}

export async function listCycles(req: Request, res: Response): Promise<void> {
  const page = await service.listCycles(
    await actorOf(req),
    validatedQuery<ReviewCycleListQuery>(req),
  );
  sendSuccess(res, page);
}

export async function getCycle(req: Request, res: Response): Promise<void> {
  const cycle = await service.getCycle(await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { cycle });
}

export async function updateCycle(req: Request, res: Response): Promise<void> {
  const cycle = await service.updateCycle(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateReviewCycleInput>(req),
  );
  sendSuccess(res, { cycle });
}

export async function activateCycle(req: Request, res: Response): Promise<void> {
  const cycle = await service.activateCycle(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { cycle });
}

export async function closeCycle(req: Request, res: Response): Promise<void> {
  const { reason } = validatedBody<{ reason: string }>(req);
  const cycle = await service.closeCycle(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    reason,
  );
  sendSuccess(res, { cycle });
}

export async function archiveCycle(req: Request, res: Response): Promise<void> {
  const cycle = await service.archiveCycle(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { cycle });
}

export async function getCycleReport(req: Request, res: Response): Promise<void> {
  const report = await reviews.getCycleReport(
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { report });
}

// ---------------------------------------------------------------------------
//  Competencies
// ---------------------------------------------------------------------------

export async function addCompetency(req: Request, res: Response): Promise<void> {
  const competency = await service.addCompetency(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CreateCompetencyInput>(req),
  );
  sendCreated(res, { competency });
}

export async function updateCompetency(req: Request, res: Response): Promise<void> {
  const competency = await service.updateCompetency(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateCompetencyInput>(req),
  );
  sendSuccess(res, { competency });
}

export async function removeCompetency(req: Request, res: Response): Promise<void> {
  const result = await service.removeCompetency(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, result);
}

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

export async function createGoal(req: Request, res: Response): Promise<void> {
  const goal = await service.createGoal(
    req,
    await actorOf(req),
    validatedBody<CreateGoalInput>(req),
  );
  sendCreated(res, { goal });
}

export async function listGoals(req: Request, res: Response): Promise<void> {
  const page = await service.listGoals(await actorOf(req), validatedQuery<GoalListQuery>(req));
  sendSuccess(res, page);
}

export async function getGoal(req: Request, res: Response): Promise<void> {
  const goal = await service.getGoal(await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { goal });
}

export async function updateGoal(req: Request, res: Response): Promise<void> {
  const goal = await service.updateGoal(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateGoalInput>(req),
  );
  sendSuccess(res, { goal });
}

export async function activateGoal(req: Request, res: Response): Promise<void> {
  const goal = await service.activateGoal(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { goal });
}

export async function closeGoal(req: Request, res: Response): Promise<void> {
  const goal = await service.closeGoal(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CloseGoalInput>(req),
  );
  sendSuccess(res, { goal });
}

// ---------------------------------------------------------------------------
//  KPIs
// ---------------------------------------------------------------------------

export async function addKpi(req: Request, res: Response): Promise<void> {
  const kpi = await service.addKpi(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CreateKpiInput>(req),
  );
  sendCreated(res, { kpi });
}

export async function updateKpi(req: Request, res: Response): Promise<void> {
  const kpi = await service.updateKpi(
    req,
    await actorOf(req),
    validatedParams<KpiParam>(req).kpiId,
    validatedBody<UpdateKpiInput>(req),
  );
  sendSuccess(res, { kpi });
}

export async function removeKpi(req: Request, res: Response): Promise<void> {
  const result = await service.removeKpi(
    req,
    await actorOf(req),
    validatedParams<KpiParam>(req).kpiId,
  );
  sendSuccess(res, result);
}

export async function recordProgress(req: Request, res: Response): Promise<void> {
  const kpi = await service.recordProgress(
    req,
    await actorOf(req),
    validatedParams<KpiParam>(req).kpiId,
    validatedBody<RecordKpiProgressInput>(req),
  );
  sendSuccess(res, { kpi });
}

export async function listProgress(req: Request, res: Response): Promise<void> {
  const progress = await service.listProgress(
    await actorOf(req),
    validatedParams<KpiParam>(req).kpiId,
  );
  sendSuccess(res, { progress });
}

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

export async function generateReviews(req: Request, res: Response): Promise<void> {
  const result = await reviews.generateReviews(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<GenerateReviewsInput>(req),
  );
  sendCreated(res, result);
}

export async function listReviews(req: Request, res: Response): Promise<void> {
  const page = await reviews.listReviews(
    await actorOf(req),
    validatedQuery<PerformanceReviewListQuery>(req),
  );
  sendSuccess(res, page);
}

export async function getReview(req: Request, res: Response): Promise<void> {
  const review = await reviews.getReview(await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { review });
}

export async function saveSelfAssessment(req: Request, res: Response): Promise<void> {
  const review = await reviews.saveSelfAssessment(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<SaveSelfAssessmentInput>(req),
  );
  sendSuccess(res, { review });
}

export async function submitSelfAssessment(req: Request, res: Response): Promise<void> {
  const review = await reviews.submitSelfAssessment(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { review });
}

export async function saveManagerAssessment(req: Request, res: Response): Promise<void> {
  const review = await reviews.saveManagerAssessment(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<SaveManagerAssessmentInput>(req),
  );
  sendSuccess(res, { review });
}

export async function submitManagerAssessment(req: Request, res: Response): Promise<void> {
  const review = await reviews.submitManagerAssessment(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { review });
}

export async function finalizeReview(req: Request, res: Response): Promise<void> {
  const review = await reviews.finalizeReview(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<FinalizeReviewInput>(req),
  );
  sendSuccess(res, { review });
}

export async function cancelReview(req: Request, res: Response): Promise<void> {
  const review = await reviews.cancelReview(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CancelReviewInput>(req),
  );
  sendSuccess(res, { review });
}

export async function rateCompetency(req: Request, res: Response): Promise<void> {
  const review = await reviews.rateCompetency(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<RateCompetencyInput>(req),
  );
  sendSuccess(res, { review });
}

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

export async function createPlan(req: Request, res: Response): Promise<void> {
  const plan = await reviews.createPlan(
    req,
    await actorOf(req),
    validatedBody<CreateDevelopmentPlanInput>(req),
  );
  sendCreated(res, { plan });
}

export async function listPlans(req: Request, res: Response): Promise<void> {
  const page = await reviews.listPlans(
    await actorOf(req),
    validatedQuery<DevelopmentPlanListQuery>(req),
  );
  sendSuccess(res, page);
}

export async function getPlan(req: Request, res: Response): Promise<void> {
  const plan = await reviews.getPlan(await actorOf(req), validatedParams<IdParam>(req).id);
  sendSuccess(res, { plan });
}

export async function updatePlan(req: Request, res: Response): Promise<void> {
  const plan = await reviews.updatePlan(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateDevelopmentPlanInput>(req),
  );
  sendSuccess(res, { plan });
}

export async function closePlan(req: Request, res: Response): Promise<void> {
  const plan = await reviews.closePlan(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CloseDevelopmentPlanInput>(req),
  );
  sendSuccess(res, { plan });
}

export async function addAction(req: Request, res: Response): Promise<void> {
  const action = await reviews.addAction(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedBody<CreateDevelopmentActionInput>(req),
  );
  sendCreated(res, { action });
}

export async function completeAction(req: Request, res: Response): Promise<void> {
  const { isCompleted } = validatedBody<CompleteDevelopmentActionInput>(req);
  const action = await reviews.completeAction(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    isCompleted,
  );
  sendSuccess(res, { action });
}

export async function removeAction(req: Request, res: Response): Promise<void> {
  const result = await reviews.removeAction(
    req,
    await actorOf(req),
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, result);
}

// ---------------------------------------------------------------------------
//  History
// ---------------------------------------------------------------------------

export async function getHistory(req: Request, res: Response): Promise<void> {
  const history = await reviews.getHistory(
    await actorOf(req),
    validatedParams<IdParam>(req).id,
    validatedQuery<PerformanceHistoryQuery>(req),
  );
  sendSuccess(res, { history });
}
