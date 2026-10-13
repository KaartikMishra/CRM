/**
 * HTTP translation for recruitment, onboarding and probation, and nothing else.
 *
 * No business rule, no permission decision, no try/catch — the route table states
 * who may call what, the services decide, and the async error handler reports
 * failures. Matching every other controller in this codebase.
 *
 * The one thing that is slightly more than translation: `context` resolves the
 * actor and their scope together, once per request. Both are needed by nearly every
 * handler, and resolving them per service call would mean several permission
 * lookups and an involvement query per request instead of one each.
 */

import type { Request, Response } from 'express';
import type {
  AdvanceOnboardingStageInput,
  ApplicationListQuery,
  CandidateListQuery,
  CompleteOnboardingTaskInput,
  CreateApplicationInput,
  CreateAssessmentInput,
  CreateBackgroundCheckInput,
  CreateCandidateDocumentInput,
  CreateCandidateInput,
  CreateEmployeeFromOnboardingInput,
  CreateJobRequisitionInput,
  CreateOfferInput,
  CreateOnboardingInput,
  CreateOnboardingTaskInput,
  DecideProbationInput,
  InterviewListQuery,
  JobRequisitionListQuery,
  MoveApplicationStageInput,
  OfferListQuery,
  OnboardingListQuery,
  ProbationListQuery,
  RecordAssessmentResultInput,
  RecordBackgroundCheckInput,
  RecordProbationReviewInput,
  RespondToOfferInput,
  ScheduleInterviewInput,
  ScreenApplicationInput,
  StartProbationInput,
  SubmitInterviewFeedbackInput,
  UpdateCandidateInput,
  UpdateJobRequisitionInput,
  UpdateOfferInput,
  UpdateOnboardingInput,
  UpdateOnboardingTaskInput,
} from '@rs/shared';
import { sendCreated, sendSuccess } from '../../utils/apiResponse.js';
import { validatedBody, validatedParams, validatedQuery } from '../../utils/requestContext.js';
import { currentUser } from '../../middleware/requireAuth.js';
import { hrActor } from './hr.service.js';
import type { HrActor } from './hr-access.js';
import type { RecruitmentScope } from './recruitment-access.js';
import * as service from './recruitment.service.js';
import * as interviews from './interview.service.js';
import * as onboarding from './onboarding.service.js';

type IdParam = { id: string };

/** The actor and their scope, resolved together once per request. */
async function context(req: Request): Promise<{ actor: HrActor; scope: RecruitmentScope }> {
  const actor = await hrActor(currentUser(req));
  const scope = await service.scopeForRequest(actor);
  return { actor, scope };
}

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

export async function createJob(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const job = await service.createJobRequisition(
    req,
    actor,
    validatedBody<CreateJobRequisitionInput>(req),
  );
  sendCreated(res, { job });
}

export async function listJobs(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const result = await service.listJobRequisitions(
    actor,
    scope,
    validatedQuery<JobRequisitionListQuery>(req),
  );
  sendSuccess(res, result);
}

export async function getJob(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const job = await service.getJobRequisition(actor, scope, validatedParams<IdParam>(req).id);
  sendSuccess(res, { job });
}

export async function updateJob(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const job = await service.updateJobRequisition(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateJobRequisitionInput>(req),
  );
  sendSuccess(res, { job });
}

export async function publishJob(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const job = await service.publishJobRequisition(req, actor, validatedParams<IdParam>(req).id);
  sendSuccess(res, { job });
}

export async function pauseJob(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const job = await service.pauseJobRequisition(req, actor, validatedParams<IdParam>(req).id);
  sendSuccess(res, { job });
}

export async function closeJob(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const job = await service.closeJobRequisition(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<{ reason: string }>(req).reason,
  );
  sendSuccess(res, { job });
}

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

export async function createCandidate(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const candidate = await service.createCandidate(
    req,
    actor,
    validatedBody<CreateCandidateInput>(req),
  );
  sendCreated(res, { candidate });
}

export async function listCandidates(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await service.listCandidates(scope, validatedQuery<CandidateListQuery>(req));
  sendSuccess(res, result);
}

export async function getCandidate(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const candidate = await service.getCandidate(actor, scope, validatedParams<IdParam>(req).id);
  sendSuccess(res, { candidate });
}

export async function updateCandidate(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const candidate = await service.updateCandidate(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateCandidateInput>(req),
  );
  sendSuccess(res, { candidate });
}

export async function attachCandidateDocument(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const document = await interviews.attachCandidateDocument(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<CreateCandidateDocumentInput>(req),
  );
  sendCreated(res, { document });
}

export async function verifyCandidateDocument(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const document = await interviews.verifyCandidateDocument(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<{ verificationStatus: 'VERIFIED' | 'REJECTED'; notes?: string }>(req),
  );
  sendSuccess(res, { document });
}

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

export async function createApplication(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const application = await service.createApplication(
    req,
    actor,
    validatedBody<CreateApplicationInput>(req),
  );
  sendCreated(res, { application });
}

export async function listApplications(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await service.listApplications(scope, validatedQuery<ApplicationListQuery>(req));
  sendSuccess(res, result);
}

export async function getApplication(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const application = await service.getApplication(actor, scope, validatedParams<IdParam>(req).id);
  sendSuccess(res, { application });
}

export async function screenApplication(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const application = await service.screenApplication(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<ScreenApplicationInput>(req),
  );
  sendSuccess(res, { application });
}

export async function moveApplicationStage(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const application = await service.moveApplicationStage(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<MoveApplicationStageInput>(req),
  );
  sendSuccess(res, { application });
}

export async function rejectApplication(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const application = await service.rejectApplication(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<{ reason: string }>(req).reason,
  );
  sendSuccess(res, { application });
}

export async function withdrawApplication(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const application = await service.withdrawApplication(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<{ reason: string }>(req).reason,
  );
  sendSuccess(res, { application });
}

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

export async function scheduleInterview(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const interview = await interviews.scheduleInterview(
    req,
    actor,
    validatedBody<ScheduleInterviewInput>(req),
  );
  sendCreated(res, { interview });
}

export async function listInterviews(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const result = await interviews.listInterviews(
    actor,
    scope,
    validatedQuery<InterviewListQuery>(req),
  );
  sendSuccess(res, result);
}

export async function getInterview(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const interview = await interviews.getInterview(actor, scope, validatedParams<IdParam>(req).id);
  sendSuccess(res, { interview });
}

export async function rescheduleInterview(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const interview = await interviews.rescheduleInterview(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<{
      scheduledAt: Date;
      durationMinutes?: number;
      location?: string | null;
      meetingUrl?: string | null;
      reason: string;
    }>(req),
  );
  sendSuccess(res, { interview });
}

export async function completeInterview(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const interview = await interviews.completeInterview(
    req,
    actor,
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { interview });
}

export async function closeInterview(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const interview = await interviews.closeInterview(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<{ status: 'CANCELLED' | 'NO_SHOW'; reason: string }>(req),
  );
  sendSuccess(res, { interview });
}

export async function submitInterviewFeedback(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const interview = await interviews.submitInterviewFeedback(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<SubmitInterviewFeedbackInput>(req),
  );
  sendSuccess(res, { interview });
}

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export async function createAssessment(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const assessment = await interviews.createAssessment(
    req,
    actor,
    validatedBody<CreateAssessmentInput>(req),
  );
  sendCreated(res, { assessment });
}

export async function recordAssessmentResult(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const assessment = await interviews.recordAssessmentResult(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<RecordAssessmentResultInput>(req),
  );
  sendSuccess(res, { assessment });
}

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export async function createOffer(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const offer = await interviews.createOffer(req, actor, validatedBody<CreateOfferInput>(req));
  sendCreated(res, { offer });
}

export async function listOffers(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const result = await interviews.listOffers(actor, scope, validatedQuery<OfferListQuery>(req));
  sendSuccess(res, result);
}

export async function getOffer(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const offer = await interviews.getOffer(actor, scope, validatedParams<IdParam>(req).id);
  sendSuccess(res, { offer });
}

export async function updateOffer(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const offer = await interviews.updateOffer(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateOfferInput>(req),
  );
  sendSuccess(res, { offer });
}

export async function sendOffer(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const offer = await interviews.sendOffer(req, actor, validatedParams<IdParam>(req).id);
  sendSuccess(res, { offer });
}

export async function respondToOffer(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const offer = await interviews.respondToOffer(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<RespondToOfferInput>(req),
  );
  sendSuccess(res, { offer });
}

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

export async function requestBackgroundCheck(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const check = await interviews.requestBackgroundCheck(
    req,
    actor,
    validatedBody<CreateBackgroundCheckInput>(req),
  );
  sendCreated(res, { check });
}

export async function recordBackgroundCheck(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const check = await interviews.recordBackgroundCheckResult(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<RecordBackgroundCheckInput>(req),
  );
  sendSuccess(res, { check });
}

export async function listBackgroundChecks(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const checks = await interviews.listBackgroundChecks(
    actor,
    scope,
    validatedParams<IdParam>(req).id,
  );
  sendSuccess(res, { checks });
}

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

export async function createOnboarding(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const record = await onboarding.createOnboarding(
    req,
    actor,
    validatedBody<CreateOnboardingInput>(req),
  );
  sendCreated(res, { onboarding: record });
}

export async function listOnboardings(req: Request, res: Response): Promise<void> {
  const { scope } = await context(req);
  const result = await onboarding.listOnboardings(scope, validatedQuery<OnboardingListQuery>(req));
  sendSuccess(res, result);
}

export async function getOnboarding(req: Request, res: Response): Promise<void> {
  const { actor, scope } = await context(req);
  const record = await onboarding.getOnboarding(actor, scope, validatedParams<IdParam>(req).id);
  sendSuccess(res, { onboarding: record });
}

export async function updateOnboarding(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const record = await onboarding.updateOnboarding(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateOnboardingInput>(req),
  );
  sendSuccess(res, { onboarding: record });
}

export async function advanceOnboarding(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const record = await onboarding.advanceOnboarding(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<AdvanceOnboardingStageInput>(req),
  );
  sendSuccess(res, { onboarding: record });
}

export async function createEmployeeFromOnboarding(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const record = await onboarding.createEmployeeFromOnboarding(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<CreateEmployeeFromOnboardingInput>(req),
  );
  sendCreated(res, { onboarding: record });
}

export async function addOnboardingTask(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const task = await onboarding.addOnboardingTask(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<CreateOnboardingTaskInput>(req),
  );
  sendCreated(res, { task });
}

export async function updateOnboardingTask(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const task = await onboarding.updateOnboardingTask(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<UpdateOnboardingTaskInput>(req),
  );
  sendSuccess(res, { task });
}

export async function completeOnboardingTask(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const task = await onboarding.completeOnboardingTask(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<CompleteOnboardingTaskInput>(req),
  );
  sendSuccess(res, { task });
}

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

export async function startProbation(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const probation = await onboarding.startProbation(
    req,
    actor,
    validatedBody<StartProbationInput>(req),
  );
  sendCreated(res, { probation });
}

export async function listProbations(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const result = await onboarding.listProbations(actor, validatedQuery<ProbationListQuery>(req));
  sendSuccess(res, result);
}

export async function getProbation(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const probation = await onboarding.getProbation(actor, validatedParams<IdParam>(req).id);
  sendSuccess(res, { probation });
}

export async function recordProbationReview(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const review = await onboarding.recordProbationReview(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<RecordProbationReviewInput>(req),
  );
  sendSuccess(res, { review });
}

export async function decideProbation(req: Request, res: Response): Promise<void> {
  const actor = await hrActor(currentUser(req));
  const probation = await onboarding.decideProbation(
    req,
    actor,
    validatedParams<IdParam>(req).id,
    validatedBody<DecideProbationInput>(req),
  );
  sendSuccess(res, { probation });
}
