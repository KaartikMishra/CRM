import type {
  ApplicationPage,
  ApplicationView,
  BackgroundCheckView,
  CandidatePage,
  CandidateView,
  InterviewPage,
  InterviewView,
  JobRequisitionPage,
  JobRequisitionView,
  OfferPage,
  OfferView,
  OnboardingPage,
  OnboardingView,
  ProbationPage,
  ProbationView,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the HR Phase 3 API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the backend
 * changes a contract this file stops compiling. Mirrors `lib/hr-api.ts` and
 * `lib/attendance-api.ts`.
 *
 * ### Nothing here decides anything
 *
 * No permission check, no stage-transition rule, no confidentiality filter. All
 * three happen server-side, and that is the point:
 *
 *   - `availableStages` on an application arrives from the backend's own
 *     transition map, so the UI offers exactly the moves the API will accept.
 *   - Screening notes, verification results and compensation arrive already
 *     stripped when the reader is not entitled to them. The browser never holds
 *     data it then has to remember not to render.
 *   - Interview feedback arrives already filtered by the panel rule.
 *
 * A second copy of any of those in the browser would be a second answer, and for
 * the confidentiality ones a second answer is a leak.
 *
 * ### No writers
 *
 * Mutations go through server actions in `app/(app)/hr/recruitment-actions.ts`, so
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
//  Job requisitions
// ---------------------------------------------------------------------------

export async function fetchJobs(
  params: Record<string, string | undefined>,
): Promise<ApiResult<JobRequisitionPage>> {
  return apiFetch<JobRequisitionPage>(`/api/hr/recruitment/jobs?${query(params)}`);
}

export async function fetchJob(
  id: string,
): Promise<ApiResult<{ job: JobRequisitionView }>> {
  return apiFetch<{ job: JobRequisitionView }>(`/api/hr/recruitment/jobs/${id}`);
}

// ---------------------------------------------------------------------------
//  Candidates
// ---------------------------------------------------------------------------

export async function fetchCandidates(
  params: Record<string, string | undefined>,
): Promise<ApiResult<CandidatePage>> {
  return apiFetch<CandidatePage>(`/api/hr/recruitment/candidates?${query(params)}`);
}

export async function fetchCandidate(
  id: string,
): Promise<ApiResult<{ candidate: CandidateView }>> {
  return apiFetch<{ candidate: CandidateView }>(`/api/hr/recruitment/candidates/${id}`);
}

// ---------------------------------------------------------------------------
//  Applications
// ---------------------------------------------------------------------------

export async function fetchApplications(
  params: Record<string, string | undefined>,
): Promise<ApiResult<ApplicationPage>> {
  return apiFetch<ApplicationPage>(`/api/hr/recruitment/applications?${query(params)}`);
}

export async function fetchApplication(
  id: string,
): Promise<ApiResult<{ application: ApplicationView }>> {
  return apiFetch<{ application: ApplicationView }>(
    `/api/hr/recruitment/applications/${id}`,
  );
}

/**
 * Verification results for one application.
 *
 * A separate call rather than part of the application, because the permission is
 * different: the application detail arrives with `backgroundChecks: []` for a
 * reader who may not see them, and this endpoint 403s for the same reader. Two
 * layers saying the same thing, deliberately — the empty array means a page can
 * render without the section, and the 403 means a hand-crafted request gains
 * nothing.
 */
export async function fetchBackgroundChecks(
  applicationId: string,
): Promise<ApiResult<{ checks: BackgroundCheckView[] }>> {
  return apiFetch<{ checks: BackgroundCheckView[] }>(
    `/api/hr/recruitment/applications/${applicationId}/background-checks`,
  );
}

// ---------------------------------------------------------------------------
//  Interviews
// ---------------------------------------------------------------------------

export async function fetchInterviews(
  params: Record<string, string | undefined>,
): Promise<ApiResult<InterviewPage>> {
  return apiFetch<InterviewPage>(`/api/hr/recruitment/interviews?${query(params)}`);
}

/**
 * One interview.
 *
 * `feedback` arrives filtered by the backend's panel rule: an interviewer gets
 * their own entry always, and the rest only once they have submitted. There is
 * deliberately no client-side equivalent — a filter in the browser would mean the
 * restricted entries had already been sent.
 */
export async function fetchInterview(
  id: string,
): Promise<ApiResult<{ interview: InterviewView }>> {
  return apiFetch<{ interview: InterviewView }>(`/api/hr/recruitment/interviews/${id}`);
}

// ---------------------------------------------------------------------------
//  Offers
// ---------------------------------------------------------------------------

export async function fetchOffers(
  params: Record<string, string | undefined>,
): Promise<ApiResult<OfferPage>> {
  return apiFetch<OfferPage>(`/api/hr/recruitment/offers?${query(params)}`);
}

export async function fetchOffer(id: string): Promise<ApiResult<{ offer: OfferView }>> {
  return apiFetch<{ offer: OfferView }>(`/api/hr/recruitment/offers/${id}`);
}

// ---------------------------------------------------------------------------
//  Onboarding
// ---------------------------------------------------------------------------

export async function fetchOnboardings(
  params: Record<string, string | undefined>,
): Promise<ApiResult<OnboardingPage>> {
  return apiFetch<OnboardingPage>(`/api/hr/onboarding?${query(params)}`);
}

/**
 * One onboarding, its checklist and whether the employment record can be created.
 *
 * `canCreateEmployee` is the backend's answer, not a guess: it accounts for the
 * record already existing and for an adverse background check. The UI shows the
 * button from it rather than inferring from the stage, because a button the API
 * would refuse is worse than no button.
 */
export async function fetchOnboarding(
  id: string,
): Promise<ApiResult<{ onboarding: OnboardingView }>> {
  return apiFetch<{ onboarding: OnboardingView }>(`/api/hr/onboarding/${id}`);
}

// ---------------------------------------------------------------------------
//  Probation
// ---------------------------------------------------------------------------

export async function fetchProbations(
  params: Record<string, string | undefined>,
): Promise<ApiResult<ProbationPage>> {
  return apiFetch<ProbationPage>(`/api/hr/probation?${query(params)}`);
}

export async function fetchProbation(
  id: string,
): Promise<ApiResult<{ probation: ProbationView }>> {
  return apiFetch<{ probation: ProbationView }>(`/api/hr/probation/${id}`);
}
