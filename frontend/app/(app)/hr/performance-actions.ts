'use server';

import { revalidatePath } from 'next/cache';
import type {
  CompetencyDefinitionView,
  DevelopmentActionView,
  DevelopmentPlanView,
  GoalView,
  KpiView,
  PerformanceReviewView,
  ReviewCycleView,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * HR Phase 5 mutations, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches the
 * bearer and calls Express. Nothing decides a business outcome — each action
 * forwards the request and relays the backend's answer verbatim, so the API remains
 * the only authority on attainment, review state, visibility and approval.
 *
 * ### The absences that matter
 *
 *   - **`recordProgressAction` sends a measurement and nothing else.** No
 *     attainment, no percentage. `recordKpiProgressSchema` has no such field, and
 *     the server computes the figure from the value, the target, the baseline and
 *     the direction. A client-supplied attainment would be a client-supplied
 *     performance result.
 *   - **No action finalises on somebody's own behalf.** `finalizeReviewAction`
 *     exists, but the backend refuses an approver who is the review's subject
 *     *before* consulting APPROVE — so an ADMIN holding every grant calling this on
 *     their own review gets 403. There is no "self-approve" action here to tempt
 *     anybody, and no parameter that could stand in for one.
 *   - **No action writes a self-assessment for another employee.** The subject comes
 *     from the review, never from the payload: `saveSelfAssessmentSchema` has no
 *     `employeeId`, so writing into a colleague's review cannot be expressed.
 *   - **No action edits a finalised review.** Every write path checks
 *     `isReviewSettled` first, so these all return 403 or 409 on a FINALIZED row.
 *     The UI hides the controls as a courtesy; the API is what enforces it.
 *   - **No action sets a status, a timestamp or a `finalRating` outside
 *     finalisation.** The schemas have no fields for them.
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
  body: JSON.stringify(body),
});

const DASHBOARD = ['/hr/performance'];
const CYCLE_PATHS = ['/hr/performance', '/hr/performance/cycles'];
const GOAL_PATHS = ['/hr/performance', '/hr/performance/goals'];
const REVIEW_PATHS = [
  '/hr/performance',
  '/hr/performance/reviews',
  '/hr/performance/my-review',
];
const PLAN_PATHS = ['/hr/performance', '/hr/performance/plans'];

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

/**
 * Creating a cycle.
 *
 * Born DRAFT — there is no status field here. The competency sheet goes with it,
 * because a cycle with nothing to rate against cannot be reviewed and a
 * half-configured one is worse than none.
 */
export async function createCycleAction(
  input: unknown,
): Promise<ActionResult<{ cycle: ReviewCycleView }>> {
  return call<{ cycle: ReviewCycleView }>(
    '/api/hr/performance/cycles',
    json('POST', input),
    CYCLE_PATHS,
  );
}

export async function updateCycleAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ cycle: ReviewCycleView }>> {
  return call<{ cycle: ReviewCycleView }>(
    `/api/hr/performance/cycles/${id}`,
    json('PATCH', input),
    [...CYCLE_PATHS, `/hr/performance/cycles/${id}`],
  );
}

/**
 * Opening a cycle.
 *
 * Needs HR_PERFORMANCE:APPROVE — the backend decides, not this. Opening makes every
 * employee in scope owe a self-assessment with a deadline, which is why it is a
 * named act rather than a PATCH on a status field.
 */
export async function activateCycleAction(
  id: string,
): Promise<ActionResult<{ cycle: ReviewCycleView }>> {
  return call<{ cycle: ReviewCycleView }>(
    `/api/hr/performance/cycles/${id}/activate`,
    json('POST', {}),
    [...CYCLE_PATHS, `/hr/performance/cycles/${id}`],
  );
}

export async function closeCycleAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ cycle: ReviewCycleView }>> {
  return call<{ cycle: ReviewCycleView }>(
    `/api/hr/performance/cycles/${id}/close`,
    json('POST', { reason }),
    [...CYCLE_PATHS, `/hr/performance/cycles/${id}`],
  );
}

export async function archiveCycleAction(
  id: string,
): Promise<ActionResult<{ cycle: ReviewCycleView }>> {
  return call<{ cycle: ReviewCycleView }>(
    `/api/hr/performance/cycles/${id}/archive`,
    json('POST', {}),
    [...CYCLE_PATHS, `/hr/performance/cycles/${id}`],
  );
}

/**
 * Generating a cycle's reviews.
 *
 * The eligible set is resolved **server-side** from the cycle's target department
 * and who is active at that moment — this sends either a list of employee ids or
 * `allInScope`, never a precomputed roster. Idempotent: a second run skips anybody
 * already covered rather than duplicating them.
 */
export async function generateReviewsAction(
  cycleId: string,
  input: unknown,
): Promise<ActionResult<{ generated: number; skipped: number; eligible: number }>> {
  return call<{ generated: number; skipped: number; eligible: number }>(
    `/api/hr/performance/cycles/${cycleId}/reviews`,
    json('POST', input),
    [...CYCLE_PATHS, ...REVIEW_PATHS, `/hr/performance/cycles/${cycleId}`],
  );
}

// ---------------------------------------------------------------------------
//  Competencies
// ---------------------------------------------------------------------------

/**
 * Adding a competency.
 *
 * DRAFT cycles only, enforced server-side: a sheet that grew mid-cycle would mean
 * two employees in one round rated against different sets of attributes.
 */
export async function addCompetencyAction(
  cycleId: string,
  input: unknown,
): Promise<ActionResult<{ competency: CompetencyDefinitionView }>> {
  return call<{ competency: CompetencyDefinitionView }>(
    `/api/hr/performance/cycles/${cycleId}/competencies`,
    json('POST', input),
    [`/hr/performance/cycles/${cycleId}`],
  );
}

export async function updateCompetencyAction(
  id: string,
  cycleId: string,
  input: unknown,
): Promise<ActionResult<{ competency: CompetencyDefinitionView }>> {
  return call<{ competency: CompetencyDefinitionView }>(
    `/api/hr/performance/competencies/${id}`,
    json('PATCH', input),
    [`/hr/performance/cycles/${cycleId}`],
  );
}

export async function removeCompetencyAction(
  id: string,
  cycleId: string,
): Promise<ActionResult<{ removed: boolean }>> {
  return call<{ removed: boolean }>(
    `/api/hr/performance/competencies/${id}`,
    { method: 'DELETE' },
    [`/hr/performance/cycles/${cycleId}`],
  );
}

// ---------------------------------------------------------------------------
//  Goals
// ---------------------------------------------------------------------------

/**
 * Setting a goal.
 *
 * Needs HR_PERFORMANCE:ASSIGN — setting a goal places an obligation with a deadline
 * on somebody. Born DRAFT; agreeing it is a separate act, so an imposed goal and an
 * agreed one are distinguishable.
 */
export async function createGoalAction(
  input: unknown,
): Promise<ActionResult<{ goal: GoalView }>> {
  return call<{ goal: GoalView }>(
    '/api/hr/performance/goals',
    json('POST', input),
    GOAL_PATHS,
  );
}

export async function updateGoalAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ goal: GoalView }>> {
  return call<{ goal: GoalView }>(`/api/hr/performance/goals/${id}`, json('PATCH', input), [
    ...GOAL_PATHS,
    `/hr/performance/goals/${id}`,
  ]);
}

export async function activateGoalAction(
  id: string,
): Promise<ActionResult<{ goal: GoalView }>> {
  return call<{ goal: GoalView }>(
    `/api/hr/performance/goals/${id}/activate`,
    json('POST', {}),
    [...GOAL_PATHS, `/hr/performance/goals/${id}`],
  );
}

/**
 * Closing a goal with its outcome.
 *
 * The outcome is the closing manager's judgement; the attainment is the server's
 * arithmetic. Where the two disagree the backend requires a note — so an override is
 * possible and has to be explained, and the API refuses one that is not.
 *
 * Never the goal's owner: the backend refuses the subject before any permission
 * check.
 */
export async function closeGoalAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ goal: GoalView }>> {
  return call<{ goal: GoalView }>(
    `/api/hr/performance/goals/${id}/close`,
    json('POST', input),
    [...GOAL_PATHS, `/hr/performance/goals/${id}`],
  );
}

// ---------------------------------------------------------------------------
//  KPIs
// ---------------------------------------------------------------------------

export async function addKpiAction(
  goalId: string,
  input: unknown,
): Promise<ActionResult<{ kpi: KpiView }>> {
  return call<{ kpi: KpiView }>(
    `/api/hr/performance/goals/${goalId}/kpis`,
    json('POST', input),
    [`/hr/performance/goals/${goalId}`],
  );
}

export async function updateKpiAction(
  goalId: string,
  kpiId: string,
  input: unknown,
): Promise<ActionResult<{ kpi: KpiView }>> {
  return call<{ kpi: KpiView }>(
    `/api/hr/performance/goals/${goalId}/kpis/${kpiId}`,
    json('PATCH', input),
    [`/hr/performance/goals/${goalId}`],
  );
}

export async function removeKpiAction(
  goalId: string,
  kpiId: string,
): Promise<ActionResult<{ removed: boolean }>> {
  return call<{ removed: boolean }>(
    `/api/hr/performance/goals/${goalId}/kpis/${kpiId}`,
    { method: 'DELETE' },
    [`/hr/performance/goals/${goalId}`],
  );
}

/**
 * Recording progress on a KPI.
 *
 * **Sends a measurement and nothing else.** No attainment, no percentage — the
 * schema has no field for either, and the server computes the figure from the value,
 * the target, the baseline and the direction before caching it on the row inside the
 * same transaction. This is Phase 5's equivalent of Phase 4's forged-score rule.
 *
 * The goal's owner may call this for their own goal: they are the one who knows the
 * number. They cannot change the target, which is the part that matters.
 */
export async function recordProgressAction(
  goalId: string,
  kpiId: string,
  input: unknown,
): Promise<ActionResult<{ kpi: KpiView }>> {
  return call<{ kpi: KpiView }>(
    `/api/hr/performance/goals/${goalId}/kpis/${kpiId}/progress`,
    json('POST', input),
    [...GOAL_PATHS, `/hr/performance/goals/${goalId}`],
  );
}

// ---------------------------------------------------------------------------
//  Self-assessment
// ---------------------------------------------------------------------------

/**
 * Saving a self-assessment draft.
 *
 * **No `employeeId`.** The subject comes from the review and the actor must be that
 * subject — the backend refuses anybody else, including an administrator holding
 * every grant. A field here would be the obvious way to write into a colleague's
 * review.
 *
 * Saveable in pieces, because somebody writing an honest appraisal does it over more
 * than one sitting. Completeness is checked at submission.
 */
export async function saveSelfAssessmentAction(
  reviewId: string,
  input: unknown,
): Promise<ActionResult<{ review: PerformanceReviewView }>> {
  return call<{ review: PerformanceReviewView }>(
    `/api/hr/performance/reviews/${reviewId}/self-assessment`,
    json('PATCH', input),
    [...REVIEW_PATHS, `/hr/performance/reviews/${reviewId}`],
  );
}

/**
 * Submitting a self-assessment.
 *
 * The body carries at most a note. `submitReviewSchema` is `.strict()`, so a request
 * carrying `finalRating` or `status` is refused with 422 rather than silently
 * stripped — answering 200 to an attempted forgery would tell the sender their claim
 * was accepted.
 *
 * The timestamp is the server's. A duplicate submission is a conflict, not a second
 * stamp.
 */
export async function submitSelfAssessmentAction(
  reviewId: string,
  note?: string,
): Promise<ActionResult<{ review: PerformanceReviewView }>> {
  return call<{ review: PerformanceReviewView }>(
    `/api/hr/performance/reviews/${reviewId}/self-assessment/submit`,
    json('POST', note === undefined ? {} : { note }),
    [...REVIEW_PATHS, `/hr/performance/reviews/${reviewId}`],
  );
}

// ---------------------------------------------------------------------------
//  Manager assessment
// ---------------------------------------------------------------------------

/**
 * Saving a manager assessment draft.
 *
 * The backend refuses **the subject first**, before any permission check — so an HR
 * colleague being appraised, who holds EDIT, cannot write their own manager review.
 *
 * The draft is not visible to the employee until submitted. That is the server's
 * decision: `managerAssessment` comes back null for them, and the ratings with it.
 */
export async function saveManagerAssessmentAction(
  reviewId: string,
  input: unknown,
): Promise<ActionResult<{ review: PerformanceReviewView }>> {
  return call<{ review: PerformanceReviewView }>(
    `/api/hr/performance/reviews/${reviewId}/manager-assessment`,
    json('PATCH', input),
    [...REVIEW_PATHS, `/hr/performance/reviews/${reviewId}`],
  );
}

export async function submitManagerAssessmentAction(
  reviewId: string,
  note?: string,
): Promise<ActionResult<{ review: PerformanceReviewView }>> {
  return call<{ review: PerformanceReviewView }>(
    `/api/hr/performance/reviews/${reviewId}/manager-assessment/submit`,
    json('POST', note === undefined ? {} : { note }),
    [...REVIEW_PATHS, `/hr/performance/reviews/${reviewId}`],
  );
}

// ---------------------------------------------------------------------------
//  Finalisation
// ---------------------------------------------------------------------------

/**
 * Finalising a review.
 *
 * ### The backend refuses a self-finalisation, and that is the guarantee
 *
 * `mayFinalizeReview` refuses the subject **before** consulting
 * HR_PERFORMANCE:APPROVE. An ADMIN holding every grant calling this on their own
 * review gets 403 — verified by HTTP integration test, not merely by the UI hiding
 * the button.
 *
 * The UI hides it too, from `review.viewerCan.finalize`, which the server computes.
 * Both, deliberately: the hidden button is a courtesy and the 403 is the control.
 *
 * `finalRating` is accepted here and nowhere else, because this is the one act that
 * sets the figure of record. Omitted, the backend falls back to the manager's
 * rating.
 */
export async function finalizeReviewAction(
  reviewId: string,
  input: unknown,
): Promise<ActionResult<{ review: PerformanceReviewView }>> {
  return call<{ review: PerformanceReviewView }>(
    `/api/hr/performance/reviews/${reviewId}/finalize`,
    json('POST', input),
    [...REVIEW_PATHS, `/hr/performance/reviews/${reviewId}`],
  );
}

export async function cancelReviewAction(
  reviewId: string,
  reason: string,
): Promise<ActionResult<{ review: PerformanceReviewView }>> {
  return call<{ review: PerformanceReviewView }>(
    `/api/hr/performance/reviews/${reviewId}/cancel`,
    json('POST', { reason }),
    [...REVIEW_PATHS, `/hr/performance/reviews/${reviewId}`],
  );
}

/**
 * Recording an HR competency rating.
 *
 * The backend refuses `source: 'SELF'` and `'MANAGER'` through this route — those
 * belong to the people whose assessments they are, and a general rating endpoint
 * accepting SELF would be the obvious way around the self-assessment rule.
 */
export async function rateCompetencyAction(
  reviewId: string,
  input: unknown,
): Promise<ActionResult<{ review: PerformanceReviewView }>> {
  return call<{ review: PerformanceReviewView }>(
    `/api/hr/performance/reviews/${reviewId}/ratings`,
    json('POST', input),
    [`/hr/performance/reviews/${reviewId}`],
  );
}

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

/**
 * Creating a development plan.
 *
 * The backend refuses the subject authoring a plan about themselves — an improvement
 * plan is a document the business is accountable for, and one the subject wrote
 * would be neither a commitment by the business nor a record of one.
 *
 * An IMPROVEMENT plan needs a review date; the backend and a CHECK both require it.
 */
export async function createPlanAction(
  input: unknown,
): Promise<ActionResult<{ plan: DevelopmentPlanView }>> {
  return call<{ plan: DevelopmentPlanView }>(
    '/api/hr/performance/plans',
    json('POST', input),
    PLAN_PATHS,
  );
}

export async function updatePlanAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ plan: DevelopmentPlanView }>> {
  return call<{ plan: DevelopmentPlanView }>(
    `/api/hr/performance/plans/${id}`,
    json('PATCH', input),
    [...PLAN_PATHS, `/hr/performance/plans/${id}`],
  );
}

export async function closePlanAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ plan: DevelopmentPlanView }>> {
  return call<{ plan: DevelopmentPlanView }>(
    `/api/hr/performance/plans/${id}/close`,
    json('POST', input),
    [...PLAN_PATHS, `/hr/performance/plans/${id}`],
  );
}

export async function addPlanActionAction(
  planId: string,
  input: unknown,
): Promise<ActionResult<{ action: DevelopmentActionView }>> {
  return call<{ action: DevelopmentActionView }>(
    `/api/hr/performance/plans/${planId}/actions`,
    json('POST', input),
    [`/hr/performance/plans/${planId}`],
  );
}

/**
 * Ticking an action off, or un-ticking it.
 *
 * The subject **is** allowed here, unlike every other write on a plan: doing the
 * things a plan asks for is their work, and requiring a manager to record each one
 * would make the plan a tracking burden rather than a support. They still cannot
 * add, remove or reword actions — those return 403.
 */
export async function completePlanActionAction(
  actionId: string,
  planId: string,
  isCompleted: boolean,
): Promise<ActionResult<{ action: DevelopmentActionView }>> {
  return call<{ action: DevelopmentActionView }>(
    `/api/hr/performance/actions/${actionId}`,
    json('PATCH', { isCompleted }),
    [`/hr/performance/plans/${planId}`, ...DASHBOARD],
  );
}

export async function removePlanActionAction(
  actionId: string,
  planId: string,
): Promise<ActionResult<{ removed: boolean }>> {
  return call<{ removed: boolean }>(
    `/api/hr/performance/actions/${actionId}`,
    { method: 'DELETE' },
    [`/hr/performance/plans/${planId}`],
  );
}
