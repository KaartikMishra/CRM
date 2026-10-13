import type {
  CycleReportView,
  DevelopmentPlanPage,
  DevelopmentPlanView,
  GoalPage,
  GoalView,
  KpiProgressEntry,
  PerformanceHistoryView,
  PerformanceOverview,
  PerformanceReviewPage,
  PerformanceReviewView,
  ReviewCyclePage,
  ReviewCycleView,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the HR Phase 5 API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the backend
 * changes a contract this file stops compiling. Mirrors `lib/hr-api.ts`,
 * `lib/attendance-api.ts`, `lib/recruitment-api.ts` and `lib/training-api.ts`.
 *
 * ### Nothing here decides anything
 *
 * Not a KPI's attainment, not a goal's outcome, not whether a review may be
 * finalised, not what a particular reader may see. `attainment`, `viewerCan`,
 * `finalRating` and the visibility of each assessment all arrive already decided by
 * the service. A second copy in the browser would be a second answer — and for the
 * gating ones a second answer would be somebody reading an appraisal they are not
 * entitled to, or a page offering a control the API will refuse.
 *
 * ### There is deliberately no reader that assembles a review itself
 *
 * `fetchPerformanceReview` returns the backend's `PerformanceReviewView`, in which
 * `managerAssessment` is **already null** for an employee whose manager has not
 * submitted. This file does not fetch the assessments separately and stitch them
 * together, because doing so would move Rule 1 into the browser — and the one place
 * that rule must not live is the tier that cannot be trusted.
 *
 * ### No writers
 *
 * Mutations go through server actions in `app/(app)/hr/performance-actions.ts`, so
 * the session token never reaches the browser.
 */

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  return search.toString();
};

// ---------------------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------------------

export async function fetchPerformanceOverview(): Promise<
  ApiResult<{ overview: PerformanceOverview }>
> {
  return apiFetch<{ overview: PerformanceOverview }>('/api/hr/performance/overview');
}

// ---------------------------------------------------------------------------
//  Cycles
// ---------------------------------------------------------------------------

export async function fetchReviewCycles(
  params: Record<string, string | undefined>,
): Promise<ApiResult<ReviewCyclePage>> {
  return apiFetch<ReviewCyclePage>(`/api/hr/performance/cycles?${query(params)}`);
}

export async function fetchReviewCycle(
  id: string,
): Promise<ApiResult<{ cycle: ReviewCycleView }>> {
  return apiFetch<{ cycle: ReviewCycleView }>(`/api/hr/performance/cycles/${id}`);
}

/**
 * A cycle's report.
 *
 * Gated on HR_PERFORMANCE:VIEW in the route table, not on the employee floor: a
 * report is company-wide aggregate data that an individual employee has no
 * entitlement to, even about a cycle they are in. A page calling this for somebody
 * without the grant gets a 403, which the caller must render as a permission state
 * rather than as an error.
 */
export async function fetchCycleReport(
  id: string,
): Promise<ApiResult<{ report: CycleReportView }>> {
  return apiFetch<{ report: CycleReportView }>(`/api/hr/performance/cycles/${id}/report`);
}

// ---------------------------------------------------------------------------
//  Goals and KPIs
// ---------------------------------------------------------------------------

export async function fetchGoals(
  params: Record<string, string | undefined>,
): Promise<ApiResult<GoalPage>> {
  return apiFetch<GoalPage>(`/api/hr/performance/goals?${query(params)}`);
}

/**
 * One goal with its indicators.
 *
 * `kpis[].attainment` and the goal's own roll-up arrive computed from the target,
 * the baseline and the direction. Nothing in the frontend recomputes them — the
 * arithmetic is in `performance.calc.ts` and is cached on the row inside the same
 * transaction as the progress that changed it.
 */
export async function fetchGoal(id: string): Promise<ApiResult<{ goal: GoalView }>> {
  return apiFetch<{ goal: GoalView }>(`/api/hr/performance/goals/${id}`);
}

/** One indicator's recorded movements. Append-only on the server. */
export async function fetchKpiProgress(
  goalId: string,
  kpiId: string,
): Promise<ApiResult<{ progress: KpiProgressEntry[] }>> {
  return apiFetch<{ progress: KpiProgressEntry[] }>(
    `/api/hr/performance/goals/${goalId}/kpis/${kpiId}/progress`,
  );
}

// ---------------------------------------------------------------------------
//  Reviews
// ---------------------------------------------------------------------------

export async function fetchPerformanceReviews(
  params: Record<string, string | undefined>,
): Promise<ApiResult<PerformanceReviewPage>> {
  return apiFetch<PerformanceReviewPage>(`/api/hr/performance/reviews?${query(params)}`);
}

/**
 * One review, as this reader may see it.
 *
 * **`managerAssessment` is null for an employee whose manager has not submitted**,
 * and so are that manager's per-competency ratings. The service decides it; this
 * reader relays it. There is no parameter here that could ask for more, and no
 * second endpoint this file wraps that would return it.
 *
 * `viewerCan` says what controls to render. Sent rather than inferred because the
 * rules are not derivable from the status alone — whether somebody may write the
 * manager review depends on who they are relative to this employee.
 */
export async function fetchPerformanceReview(
  id: string,
): Promise<ApiResult<{ review: PerformanceReviewView }>> {
  return apiFetch<{ review: PerformanceReviewView }>(`/api/hr/performance/reviews/${id}`);
}

// ---------------------------------------------------------------------------
//  Development plans
// ---------------------------------------------------------------------------

export async function fetchDevelopmentPlans(
  params: Record<string, string | undefined>,
): Promise<ApiResult<DevelopmentPlanPage>> {
  return apiFetch<DevelopmentPlanPage>(`/api/hr/performance/plans?${query(params)}`);
}

export async function fetchDevelopmentPlan(
  id: string,
): Promise<ApiResult<{ plan: DevelopmentPlanView }>> {
  return apiFetch<{ plan: DevelopmentPlanView }>(`/api/hr/performance/plans/${id}`);
}

// ---------------------------------------------------------------------------
//  History
// ---------------------------------------------------------------------------

/**
 * One person's appraisal history.
 *
 * Finalized reviews only, scoped server-side: an employee reads their own, a manager
 * their reports', HR everybody's. A 404 means out of scope rather than absent —
 * telling somebody "you may not read employee X's history" would confirm X exists.
 */
export async function fetchPerformanceHistory(
  employeeId: string,
  params: Record<string, string | undefined> = {},
): Promise<ApiResult<{ history: PerformanceHistoryView }>> {
  return apiFetch<{ history: PerformanceHistoryView }>(
    `/api/hr/performance/employees/${employeeId}/history?${query(params)}`,
  );
}
