import type {
  PracticalSubmissionPage,
  ShadowingRecordPage,
  TrainingAttemptPage,
  TrainingAttemptView,
  TrainingCategoryView,
  TrainingEnrollmentPage,
  TrainingEnrollmentView,
  TrainingOverview,
  TrainingProgramPage,
  TrainingProgramView,
  TrainingQualificationPage,
  QualificationGap,
} from '@rs/shared';
import { apiFetch, type ApiResult } from './api-server';

/**
 * Typed server-side readers for the HR Phase 4 API.
 *
 * Every shape comes from @rs/shared, so the two tiers cannot drift: if the backend
 * changes a contract this file stops compiling. Mirrors `lib/hr-api.ts`,
 * `lib/attendance-api.ts` and `lib/recruitment-api.ts`.
 *
 * ### There is deliberately no reader for the answer key
 *
 * The backend's `/assessments/:id/author` endpoint returns `isCorrect` to an editor.
 * It is **not** wrapped here, and that absence is deliberate: this file is imported
 * by learner-facing pages, and a function that could fetch the key would be one
 * careless call away from rendering it. Authoring reads it through its own narrow
 * reader below, which the learner pages never import.
 *
 * ### Nothing here decides anything
 *
 * Not the score, not whether a module is unlocked, not whether somebody may do live
 * work. `isUnlocked`, `lockedReason`, `qualificationGaps` and every percentage arrive
 * computed from the service. A second copy in the browser would be a second answer,
 * and for the gating ones a second answer would be a learner walking past a gate.
 *
 * ### No writers
 *
 * Mutations go through server actions in `app/(app)/hr/training-actions.ts`, so the
 * session token never reaches the browser.
 */

const query = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  return search.toString();
};

// ---------------------------------------------------------------------------
//  Overview and catalogue
// ---------------------------------------------------------------------------

export async function fetchTrainingOverview(): Promise<
  ApiResult<{ overview: TrainingOverview }>
> {
  return apiFetch<{ overview: TrainingOverview }>('/api/hr/training/overview');
}

export async function fetchTrainingCategories(
  params: Record<string, string | undefined> = {},
): Promise<ApiResult<{ categories: TrainingCategoryView[] }>> {
  return apiFetch<{ categories: TrainingCategoryView[] }>(
    `/api/hr/training/categories?${query(params)}`,
  );
}

export async function fetchTrainingPrograms(
  params: Record<string, string | undefined>,
): Promise<ApiResult<TrainingProgramPage>> {
  return apiFetch<TrainingProgramPage>(`/api/hr/training/programs?${query(params)}`);
}

export async function fetchTrainingProgram(
  id: string,
): Promise<ApiResult<{ program: TrainingProgramView }>> {
  return apiFetch<{ program: TrainingProgramView }>(`/api/hr/training/programs/${id}`);
}

// ---------------------------------------------------------------------------
//  Enrollments
// ---------------------------------------------------------------------------

export async function fetchTrainingEnrollments(
  params: Record<string, string | undefined>,
): Promise<ApiResult<TrainingEnrollmentPage>> {
  return apiFetch<TrainingEnrollmentPage>(`/api/hr/training/enrollments?${query(params)}`);
}

/**
 * One enrollment, with the learner's gated module list.
 *
 * `modules[].isUnlocked` and `lockedReason` arrive from the backend's own gate — so a
 * failed assessment leaves later modules locked here because the server says so, not
 * because this page worked it out. There is no client-side equivalent.
 */
export async function fetchTrainingEnrollment(
  id: string,
): Promise<ApiResult<{ enrollment: TrainingEnrollmentView }>> {
  return apiFetch<{ enrollment: TrainingEnrollmentView }>(
    `/api/hr/training/enrollments/${id}`,
  );
}

/** What still stands between a learner and live work. The server's list. */
export async function fetchQualificationGaps(
  enrollmentId: string,
): Promise<ApiResult<{ gaps: QualificationGap[] }>> {
  return apiFetch<{ gaps: QualificationGap[] }>(
    `/api/hr/training/enrollments/${enrollmentId}/qualification-gaps`,
  );
}

// ---------------------------------------------------------------------------
//  Attempts
// ---------------------------------------------------------------------------

export async function fetchTrainingAttempts(
  params: Record<string, string | undefined>,
): Promise<ApiResult<TrainingAttemptPage>> {
  return apiFetch<TrainingAttemptPage>(`/api/hr/training/attempts?${query(params)}`);
}

/**
 * One attempt.
 *
 * `questions` is populated only for a settled attempt — an in-progress one comes back
 * with an empty array, because the review shape carries the answer key and an
 * in-progress attempt is exactly when the learner must not have it. Enforced in the
 * service; this reader just relays.
 */
export async function fetchTrainingAttempt(
  id: string,
): Promise<ApiResult<{ attempt: TrainingAttemptView }>> {
  return apiFetch<{ attempt: TrainingAttemptView }>(`/api/hr/training/attempts/${id}`);
}

// ---------------------------------------------------------------------------
//  Practical, shadowing and qualification
// ---------------------------------------------------------------------------

export async function fetchPracticals(
  params: Record<string, string | undefined>,
): Promise<ApiResult<PracticalSubmissionPage>> {
  return apiFetch<PracticalSubmissionPage>(`/api/hr/training/practicals?${query(params)}`);
}

export async function fetchShadowings(
  params: Record<string, string | undefined>,
): Promise<ApiResult<ShadowingRecordPage>> {
  return apiFetch<ShadowingRecordPage>(`/api/hr/training/shadowings?${query(params)}`);
}

export async function fetchQualifications(
  params: Record<string, string | undefined>,
): Promise<ApiResult<TrainingQualificationPage>> {
  return apiFetch<TrainingQualificationPage>(
    `/api/hr/training/qualifications?${query(params)}`,
  );
}

// ---------------------------------------------------------------------------
//  Authoring — the only reader that touches the answer key
// ---------------------------------------------------------------------------

/**
 * An assessment with its answer key, for the author.
 *
 * Isolated at the bottom of this file and named so it cannot be mistaken for a
 * learner read. The backend gates it on HR_TRAINING:EDIT twice — in the route table
 * and again in the service — so calling it from a learner page would 403 rather than
 * leak. It is wrapped here only because the authoring screen needs it, and the
 * alternative (a second api module) would hide the one function worth being careful
 * about.
 *
 * **Never call this from a page a learner can reach.**
 */
export async function fetchAssessmentForAuthor(id: string): Promise<
  ApiResult<{
    assessment: {
      id: string;
      title: string;
      instructions: string | null;
      passingScore: string;
      maxAttempts: number;
      timeLimitMinutes: number | null;
      isFinal: boolean;
      isActive: boolean;
      questionCount: number;
      totalPoints: string;
    };
    questions: {
      id: string;
      kind: string;
      prompt: string;
      points: string;
      sortOrder: number;
      explanation: string | null;
      options: { id: string; label: string; sortOrder: number; isCorrect: boolean }[];
    }[];
  }>
> {
  return apiFetch(`/api/hr/training/assessments/${id}/author`);
}
