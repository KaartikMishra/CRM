'use server';

import { revalidatePath } from 'next/cache';
import type {
  ApplicationView,
  AssessmentView,
  BackgroundCheckView,
  CandidateDocumentView,
  CandidateView,
  InterviewView,
  JobRequisitionView,
  OfferView,
  OnboardingTaskView,
  OnboardingView,
  ProbationReviewView,
  ProbationView,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * HR Phase 3 mutations, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches the
 * bearer and calls Express. Nothing decides a business outcome — each action
 * forwards the request and relays the backend's answer verbatim, so the API remains
 * the only authority on the ATS transition map, the offer state machine, the
 * onboarding stage boundary, the employee-id allocation and the permission behind
 * every write.
 *
 * In particular, and each of these is a deliberate absence:
 *
 *   - **No action decides a stage move is legal.** The target stage is sent and the
 *     backend's transition map accepts or refuses it. A client-side copy of that map
 *     would eventually disagree, and the disagreement would be a button that
 *     silently does nothing or a commit point quietly skipped.
 *   - **No action supplies an employee id.** `createEmployeeAction` sends work
 *     contact details only; the number comes from Phase 1's atomic counter inside the
 *     creating transaction. There is no field here to pass one.
 *   - **No action creates a login or a password.** Onboarding records that an account
 *     is owed; it does not mint one. See the ACCOUNT task.
 *   - **No action sends a verification result the candidate could have influenced.**
 *     There is no candidate-facing route in this application at all.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code?: string; details?: { path: string; message: string }[] };

async function call<T>(
  path: string,
  init: RequestInit,
  revalidate?: string[],
): Promise<ActionResult<T>> {
  const result = await apiFetch<T>(path, init);

  if (!result.success) {
    return {
      ok: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  for (const target of revalidate ?? []) revalidatePath(target);
  return { ok: true, data: result.data };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/*
  Which screens a write invalidates.

  The recruitment dashboard counts jobs, applications, interviews and offers, so
  nearly every write here changes it — which is why `/hr/recruitment` appears in
  most of these lists rather than only the page the person is looking at.
*/
const JOB_PATHS = ['/hr/recruitment/jobs', '/hr/recruitment', '/hr'];
const CANDIDATE_PATHS = ['/hr/recruitment/candidates', '/hr/recruitment'];
const APPLICATION_PATHS = ['/hr/recruitment/applications', '/hr/recruitment', '/hr'];
const INTERVIEW_PATHS = ['/hr/recruitment/interviews', '/hr/recruitment'];
const OFFER_PATHS = ['/hr/recruitment/offers', '/hr/recruitment'];
const ONBOARDING_PATHS = ['/hr/onboarding', '/hr/recruitment', '/hr'];
const PROBATION_PATHS = ['/hr/probation', '/hr'];

// ---------------------------------------------------------------------------
//  Job requisitions
// ---------------------------------------------------------------------------

export async function createJobAction(
  input: unknown,
): Promise<ActionResult<{ job: JobRequisitionView }>> {
  return call<{ job: JobRequisitionView }>(
    '/api/hr/recruitment/jobs',
    json('POST', input),
    JOB_PATHS,
  );
}

export async function updateJobAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ job: JobRequisitionView }>> {
  return call<{ job: JobRequisitionView }>(
    `/api/hr/recruitment/jobs/${id}`,
    json('PATCH', input),
    [...JOB_PATHS, `/hr/recruitment/jobs/${id}`],
  );
}

/** Publishing. Needs HR_RECRUITMENT:APPROVE — the backend decides, not this. */
export async function publishJobAction(
  id: string,
): Promise<ActionResult<{ job: JobRequisitionView }>> {
  return call<{ job: JobRequisitionView }>(
    `/api/hr/recruitment/jobs/${id}/publish`,
    json('POST', {}),
    [...JOB_PATHS, `/hr/recruitment/jobs/${id}`],
  );
}

export async function pauseJobAction(
  id: string,
): Promise<ActionResult<{ job: JobRequisitionView }>> {
  return call<{ job: JobRequisitionView }>(
    `/api/hr/recruitment/jobs/${id}/pause`,
    json('POST', {}),
    [...JOB_PATHS, `/hr/recruitment/jobs/${id}`],
  );
}

export async function closeJobAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ job: JobRequisitionView }>> {
  return call<{ job: JobRequisitionView }>(
    `/api/hr/recruitment/jobs/${id}/close`,
    json('POST', { reason }),
    [...JOB_PATHS, `/hr/recruitment/jobs/${id}`],
  );
}

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

export async function createCandidateAction(
  input: unknown,
): Promise<ActionResult<{ candidate: CandidateView }>> {
  return call<{ candidate: CandidateView }>(
    '/api/hr/recruitment/candidates',
    json('POST', input),
    CANDIDATE_PATHS,
  );
}

export async function updateCandidateAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ candidate: CandidateView }>> {
  return call<{ candidate: CandidateView }>(
    `/api/hr/recruitment/candidates/${id}`,
    json('PATCH', input),
    [...CANDIDATE_PATHS, `/hr/recruitment/candidates/${id}`],
  );
}

/**
 * Recording an uploaded file against a candidate.
 *
 * Takes a `secureDocumentId` — the file is already in Cloudinary under
 * authenticated delivery, uploaded through the existing SecureDocument service.
 * **No URL crosses this boundary**: a stored link outlives every access check and
 * cannot be revoked, which is exactly how MediaAsset became publicly fetchable.
 * Links are minted per request, signed and short-lived.
 */
export async function attachCandidateDocumentAction(
  candidateId: string,
  input: unknown,
): Promise<ActionResult<{ document: CandidateDocumentView }>> {
  return call<{ document: CandidateDocumentView }>(
    `/api/hr/recruitment/candidates/${candidateId}/documents`,
    json('POST', input),
    [`/hr/recruitment/candidates/${candidateId}`],
  );
}

export async function verifyCandidateDocumentAction(
  documentId: string,
  candidateId: string,
  verificationStatus: 'VERIFIED' | 'REJECTED',
  notes?: string,
): Promise<ActionResult<{ document: CandidateDocumentView }>> {
  return call<{ document: CandidateDocumentView }>(
    `/api/hr/recruitment/documents/${documentId}/verify`,
    json('POST', { verificationStatus, ...(notes ? { notes } : {}) }),
    [`/hr/recruitment/candidates/${candidateId}`],
  );
}

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

export async function createApplicationAction(
  input: unknown,
): Promise<ActionResult<{ application: ApplicationView }>> {
  return call<{ application: ApplicationView }>(
    '/api/hr/recruitment/applications',
    json('POST', input),
    APPLICATION_PATHS,
  );
}

export async function screenApplicationAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ application: ApplicationView }>> {
  return call<{ application: ApplicationView }>(
    `/api/hr/recruitment/applications/${id}/screen`,
    json('POST', input),
    [...APPLICATION_PATHS, `/hr/recruitment/applications/${id}`],
  );
}

/**
 * Moving an application through the pipeline.
 *
 * The target stage is sent as given and the backend's transition map decides. This
 * action deliberately contains **no** stage logic: no "is this forward", no "is this
 * skippable", no list of legal moves. The UI offers only what `availableStages` —
 * computed by the same map server-side — told it, and the API refuses anything else.
 *
 * That is why there is no drag-and-drop board here. A drag gesture implies any
 * column is reachable from any other, and the three commit points in this pipeline
 * are precisely the moves that must not be reachable by a slip of the mouse.
 */
export async function moveApplicationStageAction(
  id: string,
  toStage: string,
  reason?: string,
): Promise<ActionResult<{ application: ApplicationView }>> {
  return call<{ application: ApplicationView }>(
    `/api/hr/recruitment/applications/${id}/stage`,
    json('POST', { toStage, ...(reason ? { reason } : {}) }),
    [...APPLICATION_PATHS, `/hr/recruitment/applications/${id}`],
  );
}

/** Rejecting. The reason is required by this signature, by Zod and by a CHECK. */
export async function rejectApplicationAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ application: ApplicationView }>> {
  return call<{ application: ApplicationView }>(
    `/api/hr/recruitment/applications/${id}/reject`,
    json('POST', { reason }),
    [...APPLICATION_PATHS, `/hr/recruitment/applications/${id}`],
  );
}

export async function withdrawApplicationAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ application: ApplicationView }>> {
  return call<{ application: ApplicationView }>(
    `/api/hr/recruitment/applications/${id}/withdraw`,
    json('POST', { reason }),
    [...APPLICATION_PATHS, `/hr/recruitment/applications/${id}`],
  );
}

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

export async function scheduleInterviewAction(
  input: unknown,
): Promise<ActionResult<{ interview: InterviewView }>> {
  return call<{ interview: InterviewView }>(
    '/api/hr/recruitment/interviews',
    json('POST', input),
    INTERVIEW_PATHS,
  );
}

export async function rescheduleInterviewAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ interview: InterviewView }>> {
  return call<{ interview: InterviewView }>(
    `/api/hr/recruitment/interviews/${id}/reschedule`,
    json('POST', input),
    [...INTERVIEW_PATHS, `/hr/recruitment/interviews/${id}`],
  );
}

export async function completeInterviewAction(
  id: string,
): Promise<ActionResult<{ interview: InterviewView }>> {
  return call<{ interview: InterviewView }>(
    `/api/hr/recruitment/interviews/${id}/complete`,
    json('POST', {}),
    [...INTERVIEW_PATHS, `/hr/recruitment/interviews/${id}`],
  );
}

export async function closeInterviewAction(
  id: string,
  status: 'CANCELLED' | 'NO_SHOW',
  reason: string,
): Promise<ActionResult<{ interview: InterviewView }>> {
  return call<{ interview: InterviewView }>(
    `/api/hr/recruitment/interviews/${id}/close`,
    json('POST', { status, reason }),
    [...INTERVIEW_PATHS, `/hr/recruitment/interviews/${id}`],
  );
}

/**
 * Giving feedback.
 *
 * The backend refuses anybody not on the panel, and the response it returns is the
 * interview re-read *with the panel filter applied to the new state* — so submitting
 * is also what reveals the rest of the panel's views. That ordering is deliberate
 * and lives entirely server-side: the browser never held the restricted entries.
 */
export async function submitInterviewFeedbackAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ interview: InterviewView }>> {
  return call<{ interview: InterviewView }>(
    `/api/hr/recruitment/interviews/${id}/feedback`,
    json('POST', input),
    [...INTERVIEW_PATHS, `/hr/recruitment/interviews/${id}`],
  );
}

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export async function createAssessmentAction(
  input: unknown,
): Promise<ActionResult<{ assessment: AssessmentView }>> {
  return call<{ assessment: AssessmentView }>(
    '/api/hr/recruitment/assessments',
    json('POST', input),
    APPLICATION_PATHS,
  );
}

export async function recordAssessmentResultAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ assessment: AssessmentView }>> {
  return call<{ assessment: AssessmentView }>(
    `/api/hr/recruitment/assessments/${id}/result`,
    json('POST', input),
    APPLICATION_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export async function createOfferAction(
  input: unknown,
): Promise<ActionResult<{ offer: OfferView }>> {
  return call<{ offer: OfferView }>(
    '/api/hr/recruitment/offers',
    json('POST', input),
    OFFER_PATHS,
  );
}

export async function updateOfferAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ offer: OfferView }>> {
  return call<{ offer: OfferView }>(
    `/api/hr/recruitment/offers/${id}`,
    json('PATCH', input),
    [...OFFER_PATHS, `/hr/recruitment/offers/${id}`],
  );
}

export async function sendOfferAction(id: string): Promise<ActionResult<{ offer: OfferView }>> {
  return call<{ offer: OfferView }>(
    `/api/hr/recruitment/offers/${id}/send`,
    json('POST', {}),
    [...OFFER_PATHS, `/hr/recruitment/offers/${id}`],
  );
}

/**
 * Recording the candidate's answer.
 *
 * HR records it, because there is no candidate-facing route — the acceptance arrives
 * by email or phone and somebody enters it. The audit entry therefore names the
 * person who recorded it, which is the honest attribution.
 */
export async function respondToOfferAction(
  id: string,
  status: 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN',
  responseNote?: string,
): Promise<ActionResult<{ offer: OfferView }>> {
  return call<{ offer: OfferView }>(
    `/api/hr/recruitment/offers/${id}/respond`,
    json('POST', { status, ...(responseNote ? { responseNote } : {}) }),
    [...OFFER_PATHS, `/hr/recruitment/offers/${id}`, ...APPLICATION_PATHS],
  );
}

// ---------------------------------------------------------------------------
//  Background verification
// ---------------------------------------------------------------------------

export async function requestBackgroundCheckAction(
  input: unknown,
): Promise<ActionResult<{ check: BackgroundCheckView }>> {
  return call<{ check: BackgroundCheckView }>(
    '/api/hr/recruitment/background-checks',
    json('POST', input),
    APPLICATION_PATHS,
  );
}

/**
 * Recording what a check found.
 *
 * A FLAGGED or FAILED result does **not** reject the application. It blocks
 * employee creation, and a person then decides — either rejecting with a reason or
 * recording a decision to proceed. That restraint is the backend's and is not
 * reproduced here, because a UI that auto-rejected would be adding a consequence
 * the API deliberately withheld.
 */
export async function recordBackgroundCheckAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ check: BackgroundCheckView }>> {
  return call<{ check: BackgroundCheckView }>(
    `/api/hr/recruitment/background-checks/${id}/result`,
    json('POST', input),
    APPLICATION_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

export async function createOnboardingAction(
  input: unknown,
): Promise<ActionResult<{ onboarding: OnboardingView }>> {
  return call<{ onboarding: OnboardingView }>(
    '/api/hr/onboarding',
    json('POST', input),
    ONBOARDING_PATHS,
  );
}

export async function updateOnboardingAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ onboarding: OnboardingView }>> {
  return call<{ onboarding: OnboardingView }>(
    `/api/hr/onboarding/${id}`,
    json('PATCH', input),
    [...ONBOARDING_PATHS, `/hr/onboarding/${id}`],
  );
}

export async function advanceOnboardingAction(
  id: string,
  toStage: string,
  notes?: string,
): Promise<ActionResult<{ onboarding: OnboardingView }>> {
  return call<{ onboarding: OnboardingView }>(
    `/api/hr/onboarding/${id}/advance`,
    json('POST', { toStage, ...(notes ? { notes } : {}) }),
    [...ONBOARDING_PATHS, `/hr/onboarding/${id}`],
  );
}

/**
 * Creating the employment record.
 *
 * Sends work contact details and **nothing else**. No employee number — that comes
 * from Phase 1's atomic counter inside the creating transaction, which is what stops
 * two concurrent requests being handed the same one. No name, no joining date: both
 * come from the candidate and the onboarding record, so the employment record cannot
 * disagree with the offer somebody signed.
 *
 * And no credential. This does not create a login, generate a password, or send an
 * invitation — the ACCOUNT task covers linking an account created by the normal
 * route.
 */
export async function createEmployeeAction(
  onboardingId: string,
  input: unknown,
): Promise<ActionResult<{ onboarding: OnboardingView }>> {
  return call<{ onboarding: OnboardingView }>(
    `/api/hr/onboarding/${onboardingId}/employee`,
    json('POST', input),
    [...ONBOARDING_PATHS, `/hr/onboarding/${onboardingId}`, '/hr/employees'],
  );
}

export async function addOnboardingTaskAction(
  onboardingId: string,
  input: unknown,
): Promise<ActionResult<{ task: OnboardingTaskView }>> {
  return call<{ task: OnboardingTaskView }>(
    `/api/hr/onboarding/${onboardingId}/tasks`,
    json('POST', input),
    [`/hr/onboarding/${onboardingId}`],
  );
}

export async function updateOnboardingTaskAction(
  id: string,
  onboardingId: string,
  input: unknown,
): Promise<ActionResult<{ task: OnboardingTaskView }>> {
  return call<{ task: OnboardingTaskView }>(
    `/api/hr/onboarding-tasks/${id}`,
    json('PATCH', input),
    [`/hr/onboarding/${onboardingId}`],
  );
}

/**
 * Settling a task.
 *
 * A SKIPPED or BLOCKED status needs a note, required by Zod, by the service and by a
 * CHECK. Three layers for one rule because the alternative — "skipped" as the quiet
 * way to close a checklist nobody worked through — is the failure mode a joining
 * checklist actually has.
 */
export async function completeOnboardingTaskAction(
  id: string,
  onboardingId: string,
  status: string,
  notes?: string,
): Promise<ActionResult<{ task: OnboardingTaskView }>> {
  return call<{ task: OnboardingTaskView }>(
    `/api/hr/onboarding-tasks/${id}/complete`,
    json('POST', { status, ...(notes ? { notes } : {}) }),
    [`/hr/onboarding/${onboardingId}`, '/hr/onboarding'],
  );
}

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

export async function startProbationAction(
  input: unknown,
): Promise<ActionResult<{ probation: ProbationView }>> {
  return call<{ probation: ProbationView }>(
    '/api/hr/probation',
    json('POST', input),
    PROBATION_PATHS,
  );
}

export async function recordProbationReviewAction(
  reviewId: string,
  probationId: string,
  input: unknown,
): Promise<ActionResult<{ review: ProbationReviewView }>> {
  return call<{ review: ProbationReviewView }>(
    `/api/hr/probation-reviews/${reviewId}`,
    json('POST', input),
    [...PROBATION_PATHS, `/hr/probation/${probationId}`],
  );
}

/**
 * The probation decision.
 *
 * CONFIRM, EXTEND or TERMINATE, each with a reason — required by Zod, the service and
 * a CHECK, because this is the record an employment dispute turns on.
 *
 * A TERMINATE decision does **not** set `Employee.status = EXITED`. That is a Phase 1
 * operation with its own history entry and its own exit-date requirement, and doing
 * it from here would end somebody's employment with no exit date and no
 * EmployeeHistory row saying so. The HR user performs it separately, deliberately.
 */
export async function decideProbationAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ probation: ProbationView }>> {
  return call<{ probation: ProbationView }>(
    `/api/hr/probation/${id}/decide`,
    json('POST', input),
    [...PROBATION_PATHS, `/hr/probation/${id}`],
  );
}
