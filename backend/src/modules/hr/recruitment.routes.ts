/**
 * The route table for HR Phase 3 — Recruitment / ATS, Onboarding & Probation.
 *
 * Every route carries a `requirePermission`. `requireAuth` is applied by the parent
 * HR router. **No new permission vocabulary is introduced**: HR_RECRUITMENT and the
 * four actions all exist from Phase 0.5, and USER holds nothing on the namespace by
 * default — so a plain employee reaches this only once an administrator grants it
 * through the existing overrides screen.
 *
 * ### Why one namespace with four actions rather than several namespaces
 *
 * Recruitment is one job done by one team, unlike Phase 1 where maintaining people
 * and restructuring the company are genuinely different jobs. What recruitment needs
 * instead is a sharp *vertical* split, because the same team contains people who may
 * read a pipeline and people who may commit the business to a hire:
 *
 *   VIEW      the board, a candidate, an application, verification results, pay
 *   CREATE    raising a requisition, adding a candidate, logging an application
 *   EDIT      amending any of those, moving an application through assessment,
 *             running onboarding, starting a probation
 *   APPROVE   the commitments: publishing a role, selecting a candidate, issuing,
 *             sending and answering an offer, recording a verification result,
 *             creating the employment record, deciding a probation
 *
 * APPROVE is doing real work here. It is the difference between somebody who runs a
 * hiring process and somebody who can bind the business to an employment
 * relationship, and those are not the same person in most organisations.
 *
 * ### The routes with no permission of their own, and why they are still safe
 *
 * `POST /interviews/:id/feedback` is gated on EDIT, but the service refuses anybody
 * not actually on the panel. That is deliberate: being on a panel is a fact about
 * rows, not a permission, so it cannot be expressed here. A route table cannot know
 * who attended a conversation.
 *
 * The same applies to task completion — the assignee may close their own task — and
 * to probation reviews, which the reviewing manager records. In all three the route
 * states the floor and the service applies the specific rule.
 *
 * ### What has no route, deliberately
 *
 * **No DELETE on anything.** A withdrawn application, a declined offer and a
 * terminated probation are all records of what happened. An endpoint that erased
 * them would make the hiring history optional, and this is precisely the history
 * somebody appeals against months later.
 *
 * **No candidate-facing route of any kind.** No application portal, no status check,
 * no document upload by the candidate. That absence is what guarantees screening
 * notes, interview concerns and flagged verification results cannot reach their
 * subject — a guarantee no amount of field-level filtering could match.
 *
 * **No EXPORT route.** The action exists, but a recruitment-pipeline export is a
 * file full of people's job-hunting activity, and it needs a retention decision
 * nobody has made yet.
 *
 * Literal paths are declared before any parameterised one throughout, so
 * `/recruitment/jobs` is never read as an id.
 */

import { Router } from 'express';
import {
  advanceOnboardingStageSchema,
  applicationListQuerySchema,
  applicationParamSchema,
  assessmentParamSchema,
  backgroundCheckParamSchema,
  candidateDocumentParamSchema,
  candidateListQuerySchema,
  candidateParamSchema,
  closeInterviewSchema,
  closeJobRequisitionSchema,
  completeOnboardingTaskSchema,
  createApplicationSchema,
  createAssessmentSchema,
  createBackgroundCheckSchema,
  createCandidateDocumentSchema,
  createCandidateSchema,
  createEmployeeFromOnboardingSchema,
  createJobRequisitionSchema,
  createOfferSchema,
  createOnboardingSchema,
  createOnboardingTaskSchema,
  decideProbationSchema,
  interviewListQuerySchema,
  interviewParamSchema,
  jobParamSchema,
  jobRequisitionListQuerySchema,
  moveApplicationStageSchema,
  offerListQuerySchema,
  offerParamSchema,
  onboardingListQuerySchema,
  onboardingParamSchema,
  onboardingTaskParamSchema,
  probationListQuerySchema,
  probationParamSchema,
  probationReviewParamSchema,
  recordAssessmentResultSchema,
  recordBackgroundCheckSchema,
  recordProbationReviewSchema,
  rejectApplicationSchema,
  rescheduleInterviewSchema,
  respondToOfferSchema,
  scheduleInterviewSchema,
  screenApplicationSchema,
  startProbationSchema,
  submitInterviewFeedbackSchema,
  updateCandidateSchema,
  updateJobRequisitionSchema,
  updateOfferSchema,
  updateOnboardingSchema,
  updateOnboardingTaskSchema,
  verifyCandidateDocumentSchema,
  withdrawApplicationSchema,
} from '@rs/shared';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './recruitment.controller.js';

export const recruitmentRoutes = Router();

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

/*
  VIEW on the list, but the *scope* is resolved per request: a hiring manager without
  the module sees the vacancies they own, and nothing else. That is why the service
  takes a scope rather than this route taking a narrower permission — involvement is
  a fact about rows and a route table cannot express it.
*/
recruitmentRoutes.get(
  '/recruitment/jobs',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ query: jobRequisitionListQuerySchema }),
  controller.listJobs,
);

recruitmentRoutes.post(
  '/recruitment/jobs',
  requirePermission('HR_RECRUITMENT', 'CREATE'),
  validate({ body: createJobRequisitionSchema }),
  controller.createJob,
);

recruitmentRoutes.get(
  '/recruitment/jobs/:id',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: jobParamSchema }),
  controller.getJob,
);

recruitmentRoutes.patch(
  '/recruitment/jobs/:id',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: jobParamSchema, body: updateJobRequisitionSchema }),
  controller.updateJob,
);

/*
  Publishing, closing — APPROVE, because each commits the business. Publishing starts
  accepting applications from real people; closing ends a hiring effort. Neither is
  an amendment to a job description.
*/
recruitmentRoutes.post(
  '/recruitment/jobs/:id/publish',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: jobParamSchema }),
  controller.publishJob,
);

recruitmentRoutes.post(
  '/recruitment/jobs/:id/pause',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: jobParamSchema }),
  controller.pauseJob,
);

recruitmentRoutes.post(
  '/recruitment/jobs/:id/close',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: jobParamSchema, body: closeJobRequisitionSchema }),
  controller.closeJob,
);

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

/*
  The candidate directory needs the module itself, not involvement. An interviewer who
  may read one application has no business browsing everybody the business has ever
  considered — so this is VIEW only, and the scope filter reaches candidates through
  applications rather than listing them directly.
*/
recruitmentRoutes.get(
  '/recruitment/candidates',
  requirePermission('HR_RECRUITMENT', 'VIEW'),
  validate({ query: candidateListQuerySchema }),
  controller.listCandidates,
);

recruitmentRoutes.post(
  '/recruitment/candidates',
  requirePermission('HR_RECRUITMENT', 'CREATE'),
  validate({ body: createCandidateSchema }),
  controller.createCandidate,
);

recruitmentRoutes.get(
  '/recruitment/candidates/:id',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: candidateParamSchema }),
  controller.getCandidate,
);

recruitmentRoutes.patch(
  '/recruitment/candidates/:id',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: candidateParamSchema, body: updateCandidateSchema }),
  controller.updateCandidate,
);

recruitmentRoutes.post(
  '/recruitment/candidates/:id/documents',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: candidateParamSchema, body: createCandidateDocumentSchema }),
  controller.attachCandidateDocument,
);

/* Verifying a document against its original is somebody with authority confirming a
   claim — the same reasoning Phase 1 applied to employee documents. */
recruitmentRoutes.post(
  '/recruitment/documents/:id/verify',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: candidateDocumentParamSchema, body: verifyCandidateDocumentSchema }),
  controller.verifyCandidateDocument,
);

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

recruitmentRoutes.get(
  '/recruitment/applications',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ query: applicationListQuerySchema }),
  controller.listApplications,
);

recruitmentRoutes.post(
  '/recruitment/applications',
  requirePermission('HR_RECRUITMENT', 'CREATE'),
  validate({ body: createApplicationSchema }),
  controller.createApplication,
);

recruitmentRoutes.get(
  '/recruitment/applications/:id',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: applicationParamSchema }),
  controller.getApplication,
);

recruitmentRoutes.post(
  '/recruitment/applications/:id/screen',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: applicationParamSchema, body: screenApplicationSchema }),
  controller.screenApplication,
);

/*
  EDIT moves an application through the assessment stages. Reaching SELECTED needs
  APPROVE as well, and the service checks that — it cannot be expressed here, because
  which stage a move targets is in the body rather than the path.
*/
recruitmentRoutes.post(
  '/recruitment/applications/:id/stage',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: applicationParamSchema, body: moveApplicationStageSchema }),
  controller.moveApplicationStage,
);

recruitmentRoutes.post(
  '/recruitment/applications/:id/reject',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: applicationParamSchema, body: rejectApplicationSchema }),
  controller.rejectApplication,
);

/* A withdrawal is the candidate's decision, recorded. EDIT rather than APPROVE: the
   business is not deciding anything, only writing down what it was told. */
recruitmentRoutes.post(
  '/recruitment/applications/:id/withdraw',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: applicationParamSchema, body: withdrawApplicationSchema }),
  controller.withdrawApplication,
);

recruitmentRoutes.get(
  '/recruitment/applications/:id/background-checks',
  requirePermission('HR_RECRUITMENT', 'VIEW'),
  validate({ params: applicationParamSchema }),
  controller.listBackgroundChecks,
);

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

/*
  An interviewer needs to reach their own interviews without holding the recruitment
  module, which is why HR_EMPLOYEE:VIEW is accepted here too — the scope then narrows
  it to the applications they are actually booked against.
*/
recruitmentRoutes.get(
  '/recruitment/interviews',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ query: interviewListQuerySchema }),
  controller.listInterviews,
);

recruitmentRoutes.post(
  '/recruitment/interviews',
  requirePermission('HR_RECRUITMENT', 'CREATE'),
  validate({ body: scheduleInterviewSchema }),
  controller.scheduleInterview,
);

recruitmentRoutes.get(
  '/recruitment/interviews/:id',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: interviewParamSchema }),
  controller.getInterview,
);

recruitmentRoutes.post(
  '/recruitment/interviews/:id/reschedule',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: interviewParamSchema, body: rescheduleInterviewSchema }),
  controller.rescheduleInterview,
);

recruitmentRoutes.post(
  '/recruitment/interviews/:id/complete',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: interviewParamSchema }),
  controller.completeInterview,
);

recruitmentRoutes.post(
  '/recruitment/interviews/:id/close',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: interviewParamSchema, body: closeInterviewSchema }),
  controller.closeInterview,
);

/*
  Feedback. HR_EMPLOYEE:VIEW is enough to *reach* this, because an interviewer may
  hold no recruitment grant at all — and the service then refuses anybody not on the
  panel. Being on a panel is a fact about rows, which no route table can check.
*/
recruitmentRoutes.post(
  '/recruitment/interviews/:id/feedback',
  requireAnyPermission(['HR_RECRUITMENT', 'EDIT'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: interviewParamSchema, body: submitInterviewFeedbackSchema }),
  controller.submitInterviewFeedback,
);

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

recruitmentRoutes.post(
  '/recruitment/assessments',
  requirePermission('HR_RECRUITMENT', 'CREATE'),
  validate({ body: createAssessmentSchema }),
  controller.createAssessment,
);

recruitmentRoutes.post(
  '/recruitment/assessments/:id/result',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: assessmentParamSchema, body: recordAssessmentResultSchema }),
  controller.recordAssessmentResult,
);

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

/*
  Every write on an offer needs APPROVE. An offer is the business committing to employ
  somebody, and there is no step of it — drafting, sending, recording the answer —
  that is merely clerical.
*/
recruitmentRoutes.get(
  '/recruitment/offers',
  requirePermission('HR_RECRUITMENT', 'VIEW'),
  validate({ query: offerListQuerySchema }),
  controller.listOffers,
);

recruitmentRoutes.post(
  '/recruitment/offers',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ body: createOfferSchema }),
  controller.createOffer,
);

recruitmentRoutes.get(
  '/recruitment/offers/:id',
  requirePermission('HR_RECRUITMENT', 'VIEW'),
  validate({ params: offerParamSchema }),
  controller.getOffer,
);

recruitmentRoutes.patch(
  '/recruitment/offers/:id',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: offerParamSchema, body: updateOfferSchema }),
  controller.updateOffer,
);

recruitmentRoutes.post(
  '/recruitment/offers/:id/send',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: offerParamSchema }),
  controller.sendOffer,
);

recruitmentRoutes.post(
  '/recruitment/offers/:id/respond',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: offerParamSchema, body: respondToOfferSchema }),
  controller.respondToOffer,
);

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

recruitmentRoutes.post(
  '/recruitment/background-checks',
  requirePermission('HR_RECRUITMENT', 'CREATE'),
  validate({ body: createBackgroundCheckSchema }),
  controller.requestBackgroundCheck,
);

/*
  Recording a result needs APPROVE. An adverse verification is one of the most
  consequential strings in this system — it can end somebody's prospects — and writing
  it should be a deliberate act by somebody accountable for the hiring decision.
*/
recruitmentRoutes.post(
  '/recruitment/background-checks/:id/result',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: backgroundCheckParamSchema, body: recordBackgroundCheckSchema }),
  controller.recordBackgroundCheck,
);

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

recruitmentRoutes.get(
  '/onboarding',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ query: onboardingListQuerySchema }),
  controller.listOnboardings,
);

recruitmentRoutes.post(
  '/onboarding',
  requirePermission('HR_RECRUITMENT', 'CREATE'),
  validate({ body: createOnboardingSchema }),
  controller.createOnboarding,
);

recruitmentRoutes.get(
  '/onboarding/:id',
  requireAnyPermission(['HR_RECRUITMENT', 'VIEW'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: onboardingParamSchema }),
  controller.getOnboarding,
);

recruitmentRoutes.patch(
  '/onboarding/:id',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: onboardingParamSchema, body: updateOnboardingSchema }),
  controller.updateOnboarding,
);

recruitmentRoutes.post(
  '/onboarding/:id/advance',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: onboardingParamSchema, body: advanceOnboardingStageSchema }),
  controller.advanceOnboarding,
);

/*
  **Creating the employment record.** APPROVE, and the highest-consequence write in
  the module: it brings a person into the business's employment. The service holds the
  concurrency guard that stops one hire producing two employee records.
*/
recruitmentRoutes.post(
  '/onboarding/:id/employee',
  requirePermission('HR_RECRUITMENT', 'APPROVE'),
  validate({ params: onboardingParamSchema, body: createEmployeeFromOnboardingSchema }),
  controller.createEmployeeFromOnboarding,
);

recruitmentRoutes.post(
  '/onboarding/:id/tasks',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: onboardingParamSchema, body: createOnboardingTaskSchema }),
  controller.addOnboardingTask,
);

recruitmentRoutes.patch(
  '/onboarding-tasks/:id',
  requirePermission('HR_RECRUITMENT', 'EDIT'),
  validate({ params: onboardingTaskParamSchema, body: updateOnboardingTaskSchema }),
  controller.updateOnboardingTask,
);

/*
  Closing a task. HR_EMPLOYEE:VIEW is enough to reach it, because the assignee may be
  an IT or facilities colleague with no recruitment grant — and the service refuses
  anybody who is neither the assignee nor an HR editor.
*/
recruitmentRoutes.post(
  '/onboarding-tasks/:id/complete',
  requireAnyPermission(['HR_RECRUITMENT', 'EDIT'], ['HR_EMPLOYEE', 'VIEW']),
  validate({ params: onboardingTaskParamSchema, body: completeOnboardingTaskSchema }),
  controller.completeOnboardingTask,
);

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

/*
  Probation sits on HR_EMPLOYEE rather than HR_RECRUITMENT for reading, because it is
  a fact about somebody's *employment* rather than about hiring them: a recruiter has
  no business in a confirmed employee's probation, and the reviewing manager — who may
  hold no recruitment grant — certainly does.
*/
recruitmentRoutes.get(
  '/probation',
  requireAnyPermission(['HR_EMPLOYEE', 'VIEW'], ['HR_RECRUITMENT', 'VIEW']),
  validate({ query: probationListQuerySchema }),
  controller.listProbations,
);

recruitmentRoutes.post(
  '/probation',
  requireAnyPermission(['HR_EMPLOYEE', 'EDIT'], ['HR_RECRUITMENT', 'EDIT']),
  validate({ body: startProbationSchema }),
  controller.startProbation,
);

recruitmentRoutes.get(
  '/probation/:id',
  requireAnyPermission(['HR_EMPLOYEE', 'VIEW'], ['HR_RECRUITMENT', 'VIEW']),
  validate({ params: probationParamSchema }),
  controller.getProbation,
);

/*
  Recording a review and deciding. Both reachable with HR_EMPLOYEE:VIEW, because the
  reviewing manager holds no HR grant in the common case — and the service then
  enforces the specific rules: only the manager or HR, and **never the employee
  themselves**, whatever else they hold.
*/
recruitmentRoutes.post(
  '/probation-reviews/:id',
  requireAnyPermission(
    ['HR_EMPLOYEE', 'VIEW'],
    ['HR_EMPLOYEE', 'EDIT'],
    ['HR_RECRUITMENT', 'EDIT'],
  ),
  validate({ params: probationReviewParamSchema, body: recordProbationReviewSchema }),
  controller.recordProbationReview,
);

recruitmentRoutes.post(
  '/probation/:id/decide',
  requireAnyPermission(
    ['HR_EMPLOYEE', 'VIEW'],
    ['HR_EMPLOYEE', 'APPROVE'],
    ['HR_RECRUITMENT', 'APPROVE'],
  ),
  validate({ params: probationParamSchema, body: decideProbationSchema }),
  controller.decideProbation,
);
