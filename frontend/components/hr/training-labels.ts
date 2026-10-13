import type {
  AssessmentQuestionKind,
  PracticalSubmissionStatus,
  QualificationGap,
  ShadowingStatus,
  TrainingAssignmentSource,
  TrainingAttemptStatus,
  TrainingEnrollmentStatus,
  TrainingModuleKind,
  TrainingObligation,
  TrainingProgramStatus,
} from '@rs/shared';

/**
 * How HR Phase 4 values are written in the interface.
 *
 * Pure data and pure functions, exported so the DOM-less frontend suite can assert
 * them directly — the project's convention for presentation logic, and the reason
 * none of this is inlined into the components.
 *
 * **Nothing here decides anything.** Not whether a module is unlocked (the server's
 * gate), not whether a score passed (the server's grader), not whether somebody may
 * do live work (the server's `qualificationGaps`). These functions decide only how an
 * already-decided value is written down.
 */

type Tone = 'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'outline';

// ---------------------------------------------------------------------------
//  Programs
// ---------------------------------------------------------------------------

export const PROGRAM_STATUS_LABELS: Record<TrainingProgramStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Open',
  ARCHIVED: 'Archived',
};

/**
 * ACTIVE reads as "Open" and is the positive tone.
 *
 * What a trainer cares about is whether the program can be assigned, not whether a
 * publish button was pressed — the same reasoning the recruitment board applies to a
 * published requisition.
 */
export const PROGRAM_STATUS_TONES: Record<TrainingProgramStatus, Tone> = {
  DRAFT: 'outline',
  ACTIVE: 'positive',
  ARCHIVED: 'neutral',
};

export const OBLIGATION_LABELS: Record<TrainingObligation, string> = {
  MANDATORY: 'Required',
  OPTIONAL: 'Optional',
};

/** Only MANDATORY carries weight — an optional course is not news. */
export const OBLIGATION_TONES: Record<TrainingObligation, Tone> = {
  MANDATORY: 'accent',
  OPTIONAL: 'neutral',
};

export const MODULE_KIND_LABELS: Record<TrainingModuleKind, string> = {
  LESSON: 'Lesson',
  ASSESSMENT: 'Test',
  PRACTICAL: 'Practical',
  SHADOWING: 'Shadowing',
};

/**
 * How each kind is completed, in words.
 *
 * Shown beside a locked or pending module, because "complete this step" is useless
 * when the learner cannot do it themselves — a practical needs somebody else's
 * approval and shadowing a mentor's sign-off.
 */
export const MODULE_COMPLETION_HINTS: Record<TrainingModuleKind, string> = {
  LESSON: 'Mark as read when you have worked through it.',
  ASSESSMENT: 'Completed by passing the test.',
  PRACTICAL: 'Completed when your reviewer approves your submission.',
  SHADOWING: 'Completed when your mentor signs it off.',
};

// ---------------------------------------------------------------------------
//  Enrollments
// ---------------------------------------------------------------------------

export const ENROLLMENT_STATUS_LABELS: Record<TrainingEnrollmentStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Complete',
  EXEMPTED: 'Excused',
  CANCELLED: 'Withdrawn',
};

/**
 * EXEMPTED is neutral, not positive.
 *
 * Being excused is not the same as having done the training, and colouring it green
 * would let a compliance report read as complete when somebody was let off. It
 * carries a required reason precisely because it is an exception.
 */
export const ENROLLMENT_STATUS_TONES: Record<TrainingEnrollmentStatus, Tone> = {
  NOT_STARTED: 'outline',
  IN_PROGRESS: 'accent',
  COMPLETED: 'positive',
  EXEMPTED: 'neutral',
  CANCELLED: 'neutral',
};

export const ASSIGNMENT_SOURCE_LABELS: Record<TrainingAssignmentSource, string> = {
  INDIVIDUAL: 'Assigned individually',
  DEPARTMENT: 'Assigned to the department',
  DESIGNATION: 'Assigned to the role',
  ONBOARDING: 'From onboarding',
};

// ---------------------------------------------------------------------------
//  Assessments
// ---------------------------------------------------------------------------

export const QUESTION_KIND_LABELS: Record<AssessmentQuestionKind, string> = {
  SINGLE_CHOICE: 'One answer',
  MULTIPLE_CHOICE: 'Several answers',
  TRUE_FALSE: 'True or false',
};

/**
 * What the learner must do, per kind.
 *
 * "Several answers" needs the all-or-nothing rule stated plainly: a learner who
 * selects three of four correct options scores zero, and discovering that from a
 * result rather than from the instructions would feel like a trick.
 */
export const QUESTION_KIND_HINTS: Record<AssessmentQuestionKind, string> = {
  SINGLE_CHOICE: 'Choose one.',
  MULTIPLE_CHOICE: 'Choose every correct option — partial answers score nothing.',
  TRUE_FALSE: 'Choose one.',
};

export const ATTEMPT_STATUS_LABELS: Record<TrainingAttemptStatus, string> = {
  IN_PROGRESS: 'In progress',
  PASSED: 'Passed',
  FAILED: 'Not passed',
  EXPIRED: 'Ran out of time',
};

/**
 * FAILED reads as "Not passed".
 *
 * A softer phrasing for the same fact, and deliberate: this label appears on a
 * person's own learning page, often several times, and "Failed" in a list of their
 * own work reads as a judgement where "Not passed" reads as a state they can change.
 * The tone is still critical, so nothing is hidden.
 */
export const ATTEMPT_STATUS_TONES: Record<TrainingAttemptStatus, Tone> = {
  IN_PROGRESS: 'accent',
  PASSED: 'positive',
  FAILED: 'critical',
  EXPIRED: 'warning',
};

// ---------------------------------------------------------------------------
//  Practical and shadowing
// ---------------------------------------------------------------------------

export const PRACTICAL_STATUS_LABELS: Record<PracticalSubmissionStatus, string> = {
  NOT_STARTED: 'Not submitted',
  SUBMITTED: 'Awaiting review',
  APPROVED: 'Approved',
  REJECTED: 'Needs rework',
};

/**
 * REJECTED reads as "Needs rework" and is a warning, not critical.
 *
 * The learner may resubmit — it is a step in the process rather than an ending — and a
 * red "Rejected" on work somebody is expected to redo misstates what happened.
 */
export const PRACTICAL_STATUS_TONES: Record<PracticalSubmissionStatus, Tone> = {
  NOT_STARTED: 'outline',
  SUBMITTED: 'accent',
  APPROVED: 'positive',
  REJECTED: 'warning',
};

export const SHADOWING_STATUS_LABELS: Record<ShadowingStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'Under way',
  COMPLETED: 'Signed off',
  CANCELLED: 'Cancelled',
};

export const SHADOWING_STATUS_TONES: Record<ShadowingStatus, Tone> = {
  SCHEDULED: 'outline',
  IN_PROGRESS: 'accent',
  COMPLETED: 'positive',
  CANCELLED: 'neutral',
};

// ---------------------------------------------------------------------------
//  Qualification
// ---------------------------------------------------------------------------

/**
 * How each unmet prerequisite is introduced.
 *
 * The server sends a `detail` sentence per gap, which is the actionable part. This
 * prefixes it with what *kind* of thing is missing, so a list of five gaps can be
 * scanned rather than read.
 */
export const QUALIFICATION_GAP_LABELS: Record<QualificationGap['kind'], string> = {
  REQUIRED_MODULE_INCOMPLETE: 'Step incomplete',
  ASSESSMENT_NOT_PASSED: 'Test not passed',
  PRACTICAL_NOT_APPROVED: 'Practical not approved',
  SHADOWING_NOT_SIGNED_OFF: 'Shadowing not signed off',
  FINAL_ASSESSMENT_NOT_PASSED: 'Final assessment not passed',
  ALREADY_QUALIFIED: 'Already qualified',
};

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

/**
 * A calendar day, as the business reads it.
 *
 * Formats the `YYYY-MM-DD` parts directly — deliberately NOT through `new Date(...)`,
 * which interprets the day in the browser's timezone and shows the previous date to
 * anybody west of IST. The same reasoning `formatDay` applies in the Phase 3 labels.
 */
export function formatTrainingDay(value: string | null): string {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return '—';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${Number(day)} ${months[Number(month) - 1] ?? ''} ${year}`;
}

/** An instant, in company time (IST). */
export function formatTrainingMoment(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * A score, as a percentage.
 *
 * Takes the decimal string the API sends and renders it without doing arithmetic on
 * it. `0.1 + 0.2 !== 0.3`, and a score decides whether somebody may do live customer
 * work — so the browser formats what it was given and computes nothing.
 */
export function formatPercent(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  // Trailing zeroes dropped: "80" rather than "80.00", but "79.5" kept.
  return `${n % 1 === 0 ? n.toFixed(0) : String(n)}%`;
}

/** A score against its maximum. Both or neither — a bare score cannot be read. */
export function formatScoreOf(score: string | null, maxScore: string | null): string {
  if (score === null || maxScore === null) return '—';
  return `${Number(score)} / ${Number(maxScore)}`;
}

/** An estimated duration, in the units somebody would say out loud. */
export function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

/**
 * Progress through a program's required steps.
 *
 * Derived from the two counts the server sends rather than from the module rows, so a
 * filtered or partially-loaded list cannot make the bar disagree with itself.
 */
export function trainingProgress(completed: number, required: number): number {
  if (required <= 0) return 0;
  return Math.round((completed / required) * 100);
}

/**
 * How many attempts remain, in words.
 *
 * "No attempts left" rather than "0 attempts remaining": the second reads as a
 * quantity and the first as a state, and this is the sentence that tells somebody
 * they need to ask their trainer.
 */
export function describeAttempts(used: number, remaining: number, max: number): string {
  if (remaining <= 0) return `No attempts left (used ${used} of ${max})`;
  if (used === 0) return `${max} attempt${max === 1 ? '' : 's'} available`;
  return `${remaining} of ${max} attempts left`;
}

/**
 * Whether a dated item is overdue, against a day the caller supplies.
 *
 * The reference day is a parameter rather than read from the clock inside — which
 * makes it testable, and lets the caller pass the *company-time* day so a colleague
 * abroad does not see work flagged overdue a day early.
 *
 * Settled work is never overdue: it is finished, excused or withdrawn.
 */
export function isTrainingOverdue(
  dueOn: string | null,
  todayKey: string,
  status: TrainingEnrollmentStatus,
): boolean {
  if (!dueOn) return false;
  if (status === 'COMPLETED' || status === 'EXEMPTED' || status === 'CANCELLED') return false;
  return dueOn.slice(0, 10) < todayKey;
}

/**
 * Today in company time (IST, +5:30 fixed).
 *
 * The same constant offset the backend uses. India observes no daylight saving, so a
 * fixed offset is exact rather than an approximation.
 */
export function companyToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
