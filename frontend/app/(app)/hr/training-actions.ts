'use server';

import { revalidatePath } from 'next/cache';
import type {
  PracticalSubmissionView,
  QuestionPaperView,
  ShadowingRecordView,
  TrainingAttemptView,
  TrainingCategoryView,
  TrainingEnrollmentSummary,
  TrainingEnrollmentView,
  TrainingModuleView,
  TrainingProgramView,
  TrainingQualificationView,
} from '@rs/shared';
import { apiFetch } from '@/lib/api-server';

/**
 * HR Phase 4 mutations, as server actions.
 *
 * The session token never leaves the server: the form posts here, this attaches the
 * bearer and calls Express. Nothing decides a business outcome — each action forwards
 * the request and relays the backend's answer verbatim, so the API remains the only
 * authority on scoring, stage gating, attempt limits and live-work eligibility.
 *
 * ### The absences that matter
 *
 *   - **`submitAttemptAction` sends only selected option ids.** No score, no
 *     percentage, no pass flag. The submission schema is `.strict()`, so a request
 *     carrying one is refused with 422 rather than silently stripped — a forged
 *     result fails loudly.
 *   - **No action marks a module complete on somebody else's behalf.** The backend's
 *     `mayActAsLearner` has no override, so an administrator calling these gets 403.
 *     There is no "complete for learner" action here to tempt anybody.
 *   - **No action grants qualification by asserting it.** `qualifyAction` sends a
 *     note and nothing else; eligibility is recomputed server-side from the
 *     program's requirement flags immediately before the write.
 *   - **No action reads or sends an answer key.**
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

  The training dashboard counts programs, enrollments, overdue work and pending
  reviews, so nearly every write changes it — which is why `/hr/training` appears in
  most of these lists rather than only the page somebody is looking at.
*/
const CATALOGUE_PATHS = ['/hr/training/programs', '/hr/training'];
const LEARNING_PATHS = ['/hr/training/my-learning', '/hr/training'];
const ASSIGNMENT_PATHS = ['/hr/training/assignments', '/hr/training'];
const REVIEW_PATHS = ['/hr/training/reviews', '/hr/training'];

// ---------------------------------------------------------------------------
//  Categories
// ---------------------------------------------------------------------------

export async function createCategoryAction(
  input: unknown,
): Promise<ActionResult<{ category: TrainingCategoryView }>> {
  return call<{ category: TrainingCategoryView }>(
    '/api/hr/training/categories',
    json('POST', input),
    CATALOGUE_PATHS,
  );
}

export async function updateCategoryAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ category: TrainingCategoryView }>> {
  return call<{ category: TrainingCategoryView }>(
    `/api/hr/training/categories/${id}`,
    json('PATCH', input),
    CATALOGUE_PATHS,
  );
}

// ---------------------------------------------------------------------------
//  Programs
// ---------------------------------------------------------------------------

/**
 * Creating a program.
 *
 * `seedRequiredJourney: true` materialises the business's thirteen-step sequence as
 * ordinary module rows. They are plain data afterwards — reorderable, removable — and
 * no service reads the template again.
 */
export async function createProgramAction(
  input: unknown,
): Promise<ActionResult<{ program: TrainingProgramView }>> {
  return call<{ program: TrainingProgramView }>(
    '/api/hr/training/programs',
    json('POST', input),
    CATALOGUE_PATHS,
  );
}

export async function updateProgramAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ program: TrainingProgramView }>> {
  return call<{ program: TrainingProgramView }>(
    `/api/hr/training/programs/${id}`,
    json('PATCH', input),
    [...CATALOGUE_PATHS, `/hr/training/programs/${id}`],
  );
}

/** Publishing. Needs HR_TRAINING:APPROVE — the backend decides, not this. */
export async function publishProgramAction(
  id: string,
): Promise<ActionResult<{ program: TrainingProgramView }>> {
  return call<{ program: TrainingProgramView }>(
    `/api/hr/training/programs/${id}/publish`,
    json('POST', {}),
    [...CATALOGUE_PATHS, `/hr/training/programs/${id}`],
  );
}

export async function archiveProgramAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ program: TrainingProgramView }>> {
  return call<{ program: TrainingProgramView }>(
    `/api/hr/training/programs/${id}/archive`,
    json('POST', { reason }),
    [...CATALOGUE_PATHS, `/hr/training/programs/${id}`],
  );
}

// ---------------------------------------------------------------------------
//  Modules
// ---------------------------------------------------------------------------

export async function addModuleAction(
  programId: string,
  input: unknown,
): Promise<ActionResult<{ module: TrainingModuleView }>> {
  return call<{ module: TrainingModuleView }>(
    `/api/hr/training/programs/${programId}/modules`,
    json('POST', input),
    [`/hr/training/programs/${programId}`],
  );
}

export async function updateModuleAction(
  id: string,
  programId: string,
  input: unknown,
): Promise<ActionResult<{ module: TrainingModuleView }>> {
  return call<{ module: TrainingModuleView }>(
    `/api/hr/training/modules/${id}`,
    json('PATCH', input),
    [`/hr/training/programs/${programId}`],
  );
}

export async function removeModuleAction(
  id: string,
  programId: string,
): Promise<ActionResult<{ removed: boolean }>> {
  return call<{ removed: boolean }>(`/api/hr/training/modules/${id}`, { method: 'DELETE' }, [
    `/hr/training/programs/${programId}`,
  ]);
}

/**
 * Reordering the sequence.
 *
 * Sends the whole ordered list rather than a single move, because the backend writes
 * consecutive positions in one transaction — a "move item up" API would have to
 * reconcile two rows against a unique index and could fail halfway.
 */
export async function reorderModulesAction(
  programId: string,
  moduleIds: string[],
): Promise<ActionResult<{ modules: TrainingModuleView[] }>> {
  return call<{ modules: TrainingModuleView[] }>(
    `/api/hr/training/programs/${programId}/modules/reorder`,
    json('POST', { moduleIds }),
    [`/hr/training/programs/${programId}`],
  );
}

// ---------------------------------------------------------------------------
//  Assessments and questions
// ---------------------------------------------------------------------------

export async function createAssessmentAction(
  input: unknown,
  programId: string,
): Promise<ActionResult<{ assessment: unknown }>> {
  return call<{ assessment: unknown }>('/api/hr/training/assessments', json('POST', input), [
    `/hr/training/programs/${programId}`,
  ]);
}

export async function updateAssessmentAction(
  id: string,
  programId: string,
  input: unknown,
): Promise<ActionResult<{ assessment: unknown }>> {
  return call<{ assessment: unknown }>(
    `/api/hr/training/assessments/${id}`,
    json('PATCH', input),
    [`/hr/training/programs/${programId}`, `/hr/training/assessments/${id}`],
  );
}

/**
 * Adding a question and its options together.
 *
 * Together because a question with no options is unanswerable and a half-built paper
 * is worse than none. The per-kind rules — exactly one correct on single choice, not
 * every option correct on multiple — are enforced by Zod and again by the service.
 */
export async function addQuestionAction(
  assessmentId: string,
  input: unknown,
): Promise<ActionResult<{ question: { id: string } }>> {
  return call<{ question: { id: string } }>(
    `/api/hr/training/assessments/${assessmentId}/questions`,
    json('POST', input),
    [`/hr/training/assessments/${assessmentId}`],
  );
}

export async function removeQuestionAction(
  id: string,
  assessmentId: string,
): Promise<ActionResult<{ removed: boolean }>> {
  return call<{ removed: boolean }>(
    `/api/hr/training/questions/${id}`,
    { method: 'DELETE' },
    [`/hr/training/assessments/${assessmentId}`],
  );
}

// ---------------------------------------------------------------------------
//  Assignment and enrollment
// ---------------------------------------------------------------------------

/**
 * Assigning a program.
 *
 * Exactly one of employees, a department or a designation. The eligible set is
 * expanded once, server-side, and each enrollment records how it came about — so an
 * employee who later moves department keeps the course they were given.
 *
 * Already-enrolled people are skipped rather than failing the batch, which the result
 * reports as `skipped`.
 */
export async function assignTrainingAction(
  input: unknown,
): Promise<ActionResult<{ assigned: number; skipped: number; enrollmentIds: string[] }>> {
  return call<{ assigned: number; skipped: number; enrollmentIds: string[] }>(
    '/api/hr/training/assignments',
    json('POST', input),
    [...ASSIGNMENT_PATHS, ...LEARNING_PATHS],
  );
}

export async function exemptEnrollmentAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ enrollment: TrainingEnrollmentSummary }>> {
  return call<{ enrollment: TrainingEnrollmentSummary }>(
    `/api/hr/training/enrollments/${id}/exempt`,
    json('POST', { reason }),
    [...ASSIGNMENT_PATHS, `/hr/training/enrollments/${id}`],
  );
}

export async function cancelEnrollmentAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ enrollment: TrainingEnrollmentSummary }>> {
  return call<{ enrollment: TrainingEnrollmentSummary }>(
    `/api/hr/training/enrollments/${id}/cancel`,
    json('POST', { reason }),
    [...ASSIGNMENT_PATHS, `/hr/training/enrollments/${id}`],
  );
}

export async function updateDueDateAction(
  id: string,
  dueOn: string | null,
  reason: string,
): Promise<ActionResult<{ enrollment: TrainingEnrollmentSummary }>> {
  return call<{ enrollment: TrainingEnrollmentSummary }>(
    `/api/hr/training/enrollments/${id}/due-date`,
    json('PATCH', { dueOn, reason }),
    [...ASSIGNMENT_PATHS, `/hr/training/enrollments/${id}`],
  );
}

// ---------------------------------------------------------------------------
//  The learner's own work
// ---------------------------------------------------------------------------

/**
 * Marking a lesson done.
 *
 * Only the learner can call this successfully — the backend refuses anybody else,
 * including an administrator holding every grant. It also refuses a module that is
 * not a LESSON, which is what stops somebody self-certifying a practical through
 * this route.
 */
export async function completeModuleAction(
  enrollmentId: string,
  moduleId: string,
  timeSpentMinutes?: number,
): Promise<ActionResult<{ enrollment: TrainingEnrollmentView }>> {
  return call<{ enrollment: TrainingEnrollmentView }>(
    `/api/hr/training/enrollments/${enrollmentId}/modules/${moduleId}/complete`,
    json('POST', timeSpentMinutes === undefined ? {} : { timeSpentMinutes }),
    [...LEARNING_PATHS, `/hr/training/learn/${enrollmentId}`],
  );
}

/**
 * Starting an attempt.
 *
 * Returns the paper — questions and options, and **no `isCorrect` anywhere**. The
 * backend builds it from a select that omits the column, so there is no code path
 * from here to the answer key.
 *
 * An open, unexpired attempt is resumed rather than replaced, so a browser crash does
 * not cost somebody a retry.
 */
export async function startAttemptAction(
  enrollmentId: string,
  assessmentId: string,
): Promise<ActionResult<{ paper: QuestionPaperView }>> {
  return call<{ paper: QuestionPaperView }>(
    `/api/hr/training/enrollments/${enrollmentId}/attempts`,
    json('POST', { assessmentId }),
    [`/hr/training/learn/${enrollmentId}`],
  );
}

/**
 * Submitting an attempt.
 *
 * The body carries **only** which options were selected. Scoring, the effective
 * threshold and the pass decision are all server-side, and the schema is `.strict()`
 * so a request carrying `score` or `passed` is refused with 422 rather than silently
 * stripped — a forged result fails loudly instead of being quietly ignored.
 */
export async function submitAttemptAction(
  attemptId: string,
  enrollmentId: string,
  answers: { questionId: string; selectedOptionIds: string[] }[],
): Promise<ActionResult<{ attempt: TrainingAttemptView }>> {
  return call<{ attempt: TrainingAttemptView }>(
    `/api/hr/training/attempts/${attemptId}/submit`,
    json('POST', { answers }),
    [...LEARNING_PATHS, `/hr/training/learn/${enrollmentId}`],
  );
}

// ---------------------------------------------------------------------------
//  Practical and shadowing
// ---------------------------------------------------------------------------

export async function submitPracticalAction(
  enrollmentId: string,
  moduleId: string,
  input: unknown,
): Promise<ActionResult<{ practical: PracticalSubmissionView }>> {
  return call<{ practical: PracticalSubmissionView }>(
    `/api/hr/training/enrollments/${enrollmentId}/modules/${moduleId}/practical`,
    json('POST', input),
    [...LEARNING_PATHS, `/hr/training/learn/${enrollmentId}`, ...REVIEW_PATHS],
  );
}

/**
 * Reviewing a practical.
 *
 * The backend refuses **the learner themselves first**, before any permission check —
 * an independent review is the entire value of this gate, and no grant lets somebody
 * approve their own work. A rejection must say what to fix.
 */
export async function reviewPracticalAction(
  id: string,
  input: unknown,
): Promise<ActionResult<{ practical: PracticalSubmissionView }>> {
  return call<{ practical: PracticalSubmissionView }>(
    `/api/hr/training/practicals/${id}/review`,
    json('POST', input),
    [...REVIEW_PATHS, ...LEARNING_PATHS],
  );
}

export async function assignReviewerAction(
  id: string,
  reviewerId: string,
): Promise<ActionResult<{ practical: PracticalSubmissionView }>> {
  return call<{ practical: PracticalSubmissionView }>(
    `/api/hr/training/practicals/${id}/reviewer`,
    json('PATCH', { reviewerId }),
    REVIEW_PATHS,
  );
}

export async function scheduleShadowingAction(
  enrollmentId: string,
  moduleId: string,
  input: unknown,
): Promise<ActionResult<{ shadowing: ShadowingRecordView }>> {
  return call<{ shadowing: ShadowingRecordView }>(
    `/api/hr/training/enrollments/${enrollmentId}/modules/${moduleId}/shadowing`,
    json('POST', input),
    [...REVIEW_PATHS, `/hr/training/learn/${enrollmentId}`],
  );
}

/** Signing off. Same rule as the practical: never the learner. Feedback required. */
export async function signOffShadowingAction(
  id: string,
  feedback: string,
): Promise<ActionResult<{ shadowing: ShadowingRecordView }>> {
  return call<{ shadowing: ShadowingRecordView }>(
    `/api/hr/training/shadowings/${id}/sign-off`,
    json('POST', { feedback }),
    [...REVIEW_PATHS, ...LEARNING_PATHS],
  );
}

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

/**
 * Granting live-work qualification.
 *
 * Sends a note and whether to issue a certificate. **Nothing that could claim
 * eligibility** — the backend recomputes the gaps from the program's requirement
 * flags against actual progress immediately before writing, and refuses with the
 * whole list of what is missing.
 *
 * It also refuses a self-grant whatever the actor holds, and touches neither
 * `Employee.status` nor probation: training qualification is a separate business
 * state.
 */
export async function qualifyAction(
  enrollmentId: string,
  input: unknown,
): Promise<ActionResult<{ qualification: TrainingQualificationView }>> {
  return call<{ qualification: TrainingQualificationView }>(
    `/api/hr/training/enrollments/${enrollmentId}/qualify`,
    json('POST', input),
    ['/hr/training/qualification', `/hr/training/enrollments/${enrollmentId}`, '/hr/training'],
  );
}

export async function revokeQualificationAction(
  id: string,
  reason: string,
): Promise<ActionResult<{ qualification: TrainingQualificationView }>> {
  return call<{ qualification: TrainingQualificationView }>(
    `/api/hr/training/qualifications/${id}/revoke`,
    json('POST', { reason }),
    ['/hr/training/qualification', '/hr/training'],
  );
}

// ---------------------------------------------------------------------------
//  Onboarding integration
// ---------------------------------------------------------------------------

/**
 * Linking an onboarding TRAINING task to real training.
 *
 * Phase 3 created the task category with no course behind it, deliberately. This is
 * the explicit linking step: the task keeps its own identity, ordering and history,
 * and training progress then drives its status.
 *
 * Idempotent on the backend — a retry against the same target returns success, and
 * naming a program reuses a live enrollment rather than creating a second.
 */
export async function linkOnboardingTrainingAction(
  taskId: string,
  onboardingId: string,
  input: unknown,
): Promise<
  ActionResult<{
    taskId: string;
    enrollmentId: string;
    created: boolean;
    alreadyLinked: boolean;
  }>
> {
  return call(
    `/api/hr/training/onboarding-tasks/${taskId}/link`,
    json('POST', input),
    [`/hr/onboarding/${onboardingId}`, ...LEARNING_PATHS],
  );
}
